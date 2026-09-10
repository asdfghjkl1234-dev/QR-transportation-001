/**
 * encoder-worker.js — 發送端的編碼工作執行緒
 * ===========================================
 * 為什麼要有這個 worker：
 *   產生 QR 碼（尤其是 Reed-Solomon 編碼）是純 CPU 工作，一個 v20 的碼要
 *   十幾毫秒。一幀要放 4 個碼就是 60 ms —— 直接在主執行緒做，畫面根本
 *   撐不住 12 FPS，而且會忽快忽慢。
 *
 *   所以這裡把「產生封包 → 編 QR → 合成整幀畫面」全部搬到 worker，
 *   而且預先產生一個緩衝區的畫面。主執行緒只剩下一件事：把已經做好的
 *   ImageBitmap 貼到畫布上，這樣幀率才穩得住。
 *
 * 輸出的 ImageBitmap 一律是「1 像素 = 1 個 QR 模組」的原始尺寸，
 * 由主執行緒再用整數倍放大。這樣可以保證每個模組都對齊實體像素，
 * 不會出現半個像素的模糊邊緣。
 *
 * 注意：這是 ES module 型態的 worker（new Worker(url, {type:'module'})），
 * 因為它需要 import fountain2.js；module worker 不能使用 importScripts()。
 */

import qrcode from './vendor/qrcode-generator-1.4.4.mjs';
import { LTEncoder2, blockSizeForVersion } from './fountain2.js';

/** 每個 QR 四周保留的靜區寬度（模組數）。QR 規格要求至少 4。 */
const QUIET = 4;

let encoder = null;
let config = null;
let cellModules = 0;     // 單一格子的邊長（含靜區）
let frameW = 0, frameH = 0;

/**
 * 把一個字串編成 QR，回傳模組矩陣。
 * @param {string} text 必須是 Base45 輸出（全部落在英數字元集內）
 * @returns {{modules:number, isDark:(r:number,c:number)=>boolean}}
 */
function makeQR(text) {
  const qr = qrcode(config.version, config.ecc);
  // Alphanumeric 模式：每 2 個字元 11 bits，比位元組模式省約 29% 空間
  qr.addData(text, 'Alphanumeric');
  qr.make();
  return qr;
}

/**
 * 把一組 QR 畫進黑白的 ImageData（1 像素 = 1 模組）。
 * @param {ImageData} img
 * @param {Array} qrs 依照網格順序排列
 */
function paintGrayscale(img, qrs) {
    const data = img.data;
  data.fill(255);                            // 先整片塗白，白邊就是靜區
  qrs.forEach((qr, idx) => {
    const gx = (idx % config.cols) * cellModules;
    const gy = ((idx / config.cols) | 0) * cellModules;
    const m = qr.getModuleCount();
    for (let r = 0; r < m; r++) {
      for (let c = 0; c < m; c++) {
        if (!qr.isDark(r, c)) continue;
        const px = ((gy + QUIET + r) * frameW + (gx + QUIET + c)) * 4;
        data[px] = 0; data[px + 1] = 0; data[px + 2] = 0;
      }
    }
  });
  // alpha 全部設成不透明
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
}

/**
 * RGB 模式：三個 QR 分別放進 R、G、B 通道。
 * 每個像素的 R 值取第 1 個碼的黑白、G 取第 2 個、B 取第 3 個（黑=0、白=255）。
 * 理論上一幀可以裝 3 倍資料，但這完全取決於相機能不能把三個通道分開 ——
 * 手機相機普遍會做色度次取樣，實際效果未經實機驗證，屬實驗性功能。
 * @param {ImageData} img
 * @param {Array[]} qrsByChannel 三個陣列，各自是該通道的網格
 */
function paintRGB(img, qrsByChannel) {
  const data = img.data;
  data.fill(255);
  for (let ch = 0; ch < 3; ch++) {
    const qrs = qrsByChannel[ch];
    if (!qrs) continue;
    qrs.forEach((qr, idx) => {
      const gx = (idx % config.cols) * cellModules;
      const gy = ((idx / config.cols) | 0) * cellModules;
      const m = qr.getModuleCount();
      for (let r = 0; r < m; r++) {
        for (let c = 0; c < m; c++) {
          if (!qr.isDark(r, c)) continue;
          // 只把這個通道打黑，其他兩個通道維持各自的內容
          data[((gy + QUIET + r) * frameW + (gx + QUIET + c)) * 4 + ch] = 0;
        }
      }
    });
  }
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
}

/**
 * RGB 模式的校準幀：畫成黑白棋盤格。
 * 接收端可以從這一幀量出「純白」與「純黑」在各通道分別是多少數值，
 * 進而推算色偏並對三個通道做增益校正。
 * 中央保留一個正常的灰階 QR（帶 metadata），讓接收端知道這是校準幀。
 * @param {ImageData} img
 * @param {object} centerQR
 */
function paintCalibration(img, centerQR) {
  const data = img.data;
  const block = 16;
  for (let y = 0; y < frameH; y++) {
    for (let x = 0; x < frameW; x++) {
      const dark = (((x / block) | 0) + ((y / block) | 0)) % 2 === 0;
      const px = (y * frameW + x) * 4;
      const v = dark ? 0 : 255;
      data[px] = v; data[px + 1] = v; data[px + 2] = v; data[px + 3] = 255;
    }
  }
  // 中央放一個正常的黑白 QR，四周留白當靜區
  const m = centerQR.getModuleCount();
  const ox = ((frameW - m) / 2) | 0, oy = ((frameH - m) / 2) | 0;
  for (let r = -QUIET; r < m + QUIET; r++) {
    for (let c = -QUIET; c < m + QUIET; c++) {
      const y = oy + r, x = ox + c;
      if (y < 0 || y >= frameH || x < 0 || x >= frameW) continue;
      const inside = r >= 0 && r < m && c >= 0 && c < m;
      const v = inside && centerQR.isDark(r, c) ? 0 : 255;
      const px = (y * frameW + x) * 4;
      data[px] = v; data[px + 1] = v; data[px + 2] = v;
    }
  }
}

/**
 * 產生一整幀，回傳可轉移的 ImageBitmap。
 * @param {number} frameNo
 */
function produceFrame(frameNo) {
  const canvas = new OffscreenCanvas(frameW, frameH);
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  const img = ctx.createImageData(frameW, frameH);

  const cells = config.cols * config.rows;
  let packetCount = 0;

  // RGB 模式每 30 幀插一次校準幀
  if (config.rgb && frameNo > 0 && frameNo % 30 === 0) {
    const pkt = encoder.nextPacket(0);
    packetCount = 1;
    paintCalibration(img, makeQR(pkt.text));
  } else if (config.rgb) {
    const byChannel = [[], [], []];
    for (let i = 0; i < cells; i++) {
      for (let ch = 0; ch < 3; ch++) {
        byChannel[ch].push(makeQR(encoder.nextPacket(ch).text));
        packetCount++;
      }
    }
    paintRGB(img, byChannel);
  } else {
    const qrs = [];
    for (let i = 0; i < cells; i++) {
      qrs.push(makeQR(encoder.nextPacket(0).text));
      packetCount++;
    }
    paintGrayscale(img, qrs);
  }

  ctx.putImageData(img, 0, 0);
  return { bitmap: canvas.transferToImageBitmap(), packetCount };
}

self.onmessage = (e) => {
  const msg = e.data;

  if (msg.type === 'init') {
    config = msg.config;
    // 由 QR 版本反推區塊大小：塞滿該版本英數模式的容量
    const sizing = blockSizeForVersion(qrcode, config.version, config.ecc);
    encoder = new LTEncoder2(msg.data, sizing.blockSize, {
      sessionId: msg.sessionId,
      systematic: config.systematic,
    });
    encoder.setMetadata(msg.metadata);

    // 用一個樣本碼問出這個版本實際的模組數
    const sample = makeQR('A'.repeat(Math.min(10, sizing.chars)));
    cellModules = sample.getModuleCount() + QUIET * 2;
    frameW = cellModules * config.cols;
    frameH = cellModules * config.rows;

    self.postMessage({
      type: 'ready',
      blockSize: sizing.blockSize,
      chars: sizing.chars,
      K: encoder.K,
      modules: sample.getModuleCount(),
      cellModules, frameW, frameH,
      codesPerFrame: config.cols * config.rows * (config.rgb ? 3 : 1),
    });
    return;
  }

  if (msg.type === 'produce') {
    // 一次做好 msg.count 幀，連同 ImageBitmap 一起轉移給主執行緒
    const frames = [];
    const transfer = [];
    for (let i = 0; i < msg.count; i++) {
      const f = produceFrame(msg.startFrame + i);
      frames.push({ bitmap: f.bitmap, frameNo: msg.startFrame + i, packetCount: f.packetCount });
      transfer.push(f.bitmap);
    }
    self.postMessage({ type: 'frames', frames }, transfer);
    return;
  }

  if (msg.type === 'reset') {
    encoder = null; config = null;
  }
};
