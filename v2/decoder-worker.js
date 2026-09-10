/**
 * decoder-worker.js — 接收端的 QR 解碼工作執行緒
 * ==============================================
 * 用途：在不支援 BarcodeDetector 的瀏覽器上，用 zxing-wasm 解碼。
 *
 * 為什麼一定要放在 worker：
 *   掃描一張 1920×1080 的畫面要幾十到上百毫秒。放在主執行緒上，
 *   相機預覽會卡成幻燈片，而且 requestVideoFrameCallback 會開始漏幀。
 *   主執行緒只負責「把影格轉成 ImageBitmap 丟過來」，其餘都在這裡做。
 *
 * 接收端會開 2～4 個這種 worker 組成工作池；全部忙碌時主執行緒直接丟棄影格，
 * 不排隊 —— 排隊只會讓延遲越積越大，而噴泉碼本來就不在乎丟掉哪一幀。
 *
 * 函式庫：zxing-wasm 3.1.3（ESM build）。
 * 選它的原因是 readBarcodes 支援 maxNumberOfSymbols，一次可以解出畫面中
 * 的多個碼 —— 這正是 v2「一幀多碼」需要的。jsQR 一次只找一個碼，不適用。
 */

import { readBarcodes, prepareZXingModule } from './vendor/zxing-wasm-3.1.3/reader/index.js';

// 預設會去 jsDelivr 抓 wasm；這裡改指到本地檔案，確保離線也能用
prepareZXingModule({
  overrides: {
    locateFile: (path, prefix) =>
      path.endsWith('.wasm')
        ? new URL('./vendor/zxing-wasm-3.1.3/reader/zxing_reader.wasm', import.meta.url).href
        : prefix + path,
  },
});

/** 重複使用的畫布，避免每一幀都重新配置 */
let canvas = null, ctx = null;

/**
 * ImageBitmap → ImageData
 * @param {ImageBitmap} bitmap
 * @returns {ImageData}
 */
function toImageData(bitmap) {
  if (!canvas || canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
    canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  }
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
}

/**
 * 自適應二值化（Bradley 局部平均法），RGB 模式專用。
 *
 * 為什麼不能用固定門檻：三個顏色通道經過相機的白平衡與色偏之後，
 * 「白」在 R 通道可能是 230、在 B 通道只有 180，固定門檻會整片判錯。
 * 局部平均只看每個像素周圍一小塊的平均值，自動吸收掉整體亮度與色偏。
 *
 * 用積分圖（summed-area table）計算，讓每個像素的區域平均都是 O(1)。
 *
 * @param {Uint8ClampedArray} src 單通道灰階值
 * @param {number} w
 * @param {number} h
 * @param {number} [window=25] 取樣視窗邊長
 * @param {number} [bias=0.86] 門檻 = 區域平均 × bias，稍微偏暗以保住細線
 * @returns {ImageData} 二值化後的 RGBA 影像
 */
function adaptiveBinarize(src, w, h, window = 25, bias = 0.86) {
  // 積分圖：integral[y][x] = 左上角到此為止所有像素的總和
  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += src[y * w + x];
      integral[(y + 1) * (w + 1) + (x + 1)] = integral[y * (w + 1) + (x + 1)] + rowSum;
    }
  }

  const out = new ImageData(w, h);
  const d = out.data;
  const r = window >> 1;
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
      const area = (y1 - y0 + 1) * (x1 - x0 + 1);
      const sum = integral[(y1 + 1) * (w + 1) + (x1 + 1)]
                - integral[y0 * (w + 1) + (x1 + 1)]
                - integral[(y1 + 1) * (w + 1) + x0]
                + integral[y0 * (w + 1) + x0];
      const v = src[y * w + x] * area > sum * bias ? 255 : 0;
      const p = (y * w + x) * 4;
      d[p] = v; d[p + 1] = v; d[p + 2] = v; d[p + 3] = 255;
    }
  }
  return out;
}

/**
 * 把一張 RGBA 影像拆出單一顏色通道的灰階值。
 * @param {ImageData} img
 * @param {number} channel 0=R, 1=G, 2=B
 * @returns {Uint8ClampedArray}
 */
function extractChannel(img, channel) {
  const { width: w, height: h, data } = img;
  const out = new Uint8ClampedArray(w * h);
  for (let i = 0, p = channel; i < out.length; i++, p += 4) out[i] = data[p];
  return out;
}

/** 把 zxing 的結果整理成主執行緒要的最小格式 */
function pack(results, channel) {
  return results
    .filter((r) => r.text)
    .map((r) => ({
      text: r.text,
      channel,
      position: r.position
        ? {
            tl: [r.position.topLeft.x, r.position.topLeft.y],
            tr: [r.position.topRight.x, r.position.topRight.y],
            br: [r.position.bottomRight.x, r.position.bottomRight.y],
            bl: [r.position.bottomLeft.x, r.position.bottomLeft.y],
          }
        : null,
    }));
}

self.onmessage = async (e) => {
  const { bitmap, maxSymbols, rgb, jobId } = e.data;
  const t0 = performance.now();
  let codes = [];

  try {
    const img = toImageData(bitmap);
    bitmap.close();

    const opts = {
      formats: ['QRCode'],
      maxNumberOfSymbols: maxSymbols,
      tryHarder: false,     // 關掉可省一半時間；螢幕上的碼本來就很乾淨
      tryRotate: false,     // 使用者不會把手機轉 90 度來掃
      tryInvert: false,     // 一律黑碼白底
    };

    if (!rgb) {
      codes = pack(await readBarcodes(img, opts), 0);
    } else {
      // RGB 模式：三個通道各自二值化後分別解碼
      const w = img.width, h = img.height;
      for (let ch = 0; ch < 3; ch++) {
        const bin = adaptiveBinarize(extractChannel(img, ch), w, h);
        codes.push(...pack(await readBarcodes(bin, opts), ch));
      }
    }
  } catch (err) {
    self.postMessage({ type: 'result', jobId, codes: [], error: String(err && err.message || err) });
    return;
  }

  self.postMessage({ type: 'result', jobId, codes, ms: performance.now() - t0 });
};

// 模組載入完成（wasm 會在第一次 readBarcodes 時才真正下載並初始化）
self.postMessage({ type: 'ready' });
