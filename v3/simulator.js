/**
 * simulator.js — 合成通道模擬器
 * ==============================
 * 把發送端產生的完美畫面，加上「相機拍螢幕」會遇到的各種失真，
 * 再交給接收端解碼。這樣不必架實體裝置就能量出各種失真強度下的錯誤率，
 * 也讓每一項失真都能單獨開關、單獨掃描強度。
 *
 * 套用順序刻意模仿真實的成像流程：
 *   幾何（透視 + 桶狀畸變）→ 鏡頭模糊 → 場景光照（漸層 + 反光）
 *   → 相機色彩處理（白平衡 / gamma / 飽和度）→ 感光雜訊 → JPEG 壓縮
 *
 * 幾何變換用「反向映射」：對每個輸出像素回推它在原圖的位置再取樣，
 * 這樣不會出現正向映射常見的空洞。
 *
 * 這個檔案是純 JS，瀏覽器與 Node（補一個 ImageData shim）都能跑。
 * 只有 JPEG 壓縮那一項需要 canvas，所以獨立成 applyJpeg()，Node 端會跳過。
 */

import { mulberry32 } from '../fountain.js';

/** 預設參數，也是「中等失真」的定義（第五節驗收標準用的就是這一組） */
export const MEDIUM_DISTORTION = {
  margin: 0.10,        // 畫面四周留白比例（模擬沒有拍滿）
  rotate: 8,           // 旋轉角度（度）
  tiltX: 0.06,         // 水平方向的透視傾斜
  tiltY: 0.04,         // 垂直方向的透視傾斜
  barrel: 0.06,        // 桶狀畸變係數
  blur: 0.8,           // 高斯模糊 σ（像素）
  gradient: 0.22,      // 由上到下的亮度衰減比例
  glare: 0.25,         // 反光白斑強度
  glareSize: 0.18,     // 反光半徑（相對於畫面寬度）
  wb: [1.06, 1.0, 0.92], // 白平衡增益（R/G/B）
  gamma: 1.15,
  saturation: 0.82,    // 飽和度衰減
  noise: 6,            // 感光雜訊振幅
  jpegQuality: 0.75,
  seed: 12345,
};

/**
 * 完全不失真（基準線）。
 * margin 刻意設為 0：只要留白比例讓位移變成非整數像素，
 * 幾何重取樣就會做雙線性內插，把格子邊界抹糊，基準線反而比中等失真還差。
 * 渲染時本來就已經含 3 格白邊，這裡不需要再加。
 */
export const NO_DISTORTION = {
  margin: 0, rotate: 0, tiltX: 0, tiltY: 0, barrel: 0, blur: 0,
  gradient: 0, glare: 0, glareSize: 0.2, wb: [1, 1, 1], gamma: 1,
  saturation: 1, noise: 0, jpegQuality: 1, seed: 1,
};

/* =========================================================================
 * 幾何
 * ========================================================================= */

/** 3×3 矩陣相乘 */
function matMul(a, b) {
  const o = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += a[r * 3 + k] * b[k * 3 + c];
      o[r * 3 + c] = s;
    }
  }
  return o;
}

/** 3×3 反矩陣 */
function matInv(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  const inv = [
    A, -(b * i - c * h), b * f - c * e,
    B, a * i - c * g, -(a * f - c * d),
    C, -(a * h - b * g), a * e - b * d,
  ];
  return inv.map((v) => v / det);
}

/**
 * 依參數組出「原圖 → 失真影像」的正向變換矩陣（以中心為原點的正規化座標）。
 */
function buildTransform(o) {
  const th = (o.rotate || 0) * Math.PI / 180;
  const rot = [Math.cos(th), -Math.sin(th), 0, Math.sin(th), Math.cos(th), 0, 0, 0, 1];
  // 透視傾斜：最後一列不是 (0,0,1) 就會產生近大遠小的效果
  const persp = [1, 0, 0, 0, 1, 0, o.tiltX || 0, o.tiltY || 0, 1];
  return matMul(persp, rot);
}

/* =========================================================================
 * 主函式
 * ========================================================================= */

/**
 * 對一張 ImageData 套用整組失真。
 * @param {ImageData} src
 * @param {object} opts
 * @param {ImageData} [mixWith] 若提供，會與這張圖依 mixRatio 混合（模擬畫面撕裂）
 * @param {number} [mixRatio=0] 上方多少比例來自 mixWith
 * @returns {ImageData}
 */
export function distort(src, opts, mixWith = null, mixRatio = 0) {
  const o = { ...MEDIUM_DISTORTION, ...opts };
  const rand = mulberry32(o.seed >>> 0);

  const margin = o.margin ?? 0.1;
  const W = Math.round(src.width * (1 + margin * 2));
  const H = Math.round(src.height * (1 + margin * 2));
  const out = new ImageData(W, H);
  const od = out.data;

  const fwd = buildTransform(o);
  const inv = matInv(fwd) || [1, 0, 0, 0, 1, 0, 0, 0, 1];

  const halfW = W / 2, halfH = H / 2;
  // 原圖在輸出畫面中的縮放：留白之後原圖只佔中間那塊
  const scale = 1 / (1 + margin * 2);

  const sw = src.width, sh = src.height, sd = src.data;

  /** 雙線性取樣 */
  const sample = (img, x, y, dst) => {
    const d = img.data, w = img.width, h = img.height;
    if (x < 0 || y < 0 || x > w - 1 || y > h - 1) {
      // 畫面外當成中灰的背景（桌面/牆壁）
      dst[0] = 110; dst[1] = 110; dst[2] = 110;
      return;
    }
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
    const fx = x - x0, fy = y - y0;
    const p00 = (y0 * w + x0) * 4, p10 = (y0 * w + x1) * 4;
    const p01 = (y1 * w + x0) * 4, p11 = (y1 * w + x1) * 4;
    for (let c = 0; c < 3; c++) {
      const top = d[p00 + c] * (1 - fx) + d[p10 + c] * fx;
      const bot = d[p01 + c] * (1 - fx) + d[p11 + c] * fx;
      dst[c] = top * (1 - fy) + bot * fy;
    }
  };

  const px = [0, 0, 0];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // 正規化到 [-1,1]
      let nx = (x - halfW) / halfW;
      let ny = (y - halfH) / halfH;

      // --- 反向桶狀畸變 ---
      // 正向是 r' = r(1 + k·r²)，這裡要反過來。用一次牛頓迭代逼近就夠準了。
      const k = o.barrel || 0;
      if (k !== 0) {
        const r2 = nx * nx + ny * ny;
        const f = 1 + k * r2;
        nx /= f; ny /= f;
      }

      // --- 反向透視 ---
      const w2 = inv[6] * nx + inv[7] * ny + inv[8];
      const ux = (inv[0] * nx + inv[1] * ny + inv[2]) / w2;
      const uy = (inv[3] * nx + inv[4] * ny + inv[5]) / w2;

      // 換回原圖像素座標
      const sx = (ux / scale + 1) / 2 * sw;
      const sy = (uy / scale + 1) / 2 * sh;

      // --- 撕裂：上半取另一幀 ---
      const useMix = mixWith && (y / H) < mixRatio;
      sample(useMix ? mixWith : src, sx, sy, px);

      const p = (y * W + x) * 4;
      od[p] = px[0]; od[p + 1] = px[1]; od[p + 2] = px[2]; od[p + 3] = 255;
    }
  }

  // --- 鏡頭模糊 ---
  if (o.blur > 0) gaussianBlur(out, o.blur);

  // --- 光照、色彩、雜訊 ---
  const glareX = W * (0.3 + rand() * 0.4);
  const glareY = H * (0.2 + rand() * 0.4);
  const glareR = W * (o.glareSize ?? 0.18);
  const wb = o.wb || [1, 1, 1];
  const invGamma = 1 / (o.gamma || 1);
  const sat = o.saturation ?? 1;

  for (let y = 0; y < H; y++) {
    // 由上到下的亮度漸層（螢幕本身的可視角 + 環境光造成）
    const grad = 1 - (o.gradient || 0) * (y / H);
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 4;
      let r = od[p], g = od[p + 1], b = od[p + 2];

      r *= grad; g *= grad; b *= grad;

      // 局部反光白斑：高斯形狀的加法性亮斑
      if (o.glare > 0) {
        const dx = x - glareX, dy = y - glareY;
        const d2 = (dx * dx + dy * dy) / (glareR * glareR);
        if (d2 < 9) {
          const v = o.glare * 255 * Math.exp(-d2);
          r += v; g += v; b += v;
        }
      }

      // 飽和度衰減：往亮度靠攏
      if (sat !== 1) {
        const lum = r * 0.299 + g * 0.587 + b * 0.114;
        r = lum + (r - lum) * sat;
        g = lum + (g - lum) * sat;
        b = lum + (b - lum) * sat;
      }

      // 白平衡
      r *= wb[0]; g *= wb[1]; b *= wb[2];

      // gamma
      if (invGamma !== 1) {
        r = 255 * Math.pow(Math.max(0, r) / 255, invGamma);
        g = 255 * Math.pow(Math.max(0, g) / 255, invGamma);
        b = 255 * Math.pow(Math.max(0, b) / 255, invGamma);
      }

      // 感光雜訊
      if (o.noise > 0) {
        const n = o.noise;
        r += (rand() - 0.5) * 2 * n;
        g += (rand() - 0.5) * 2 * n;
        b += (rand() - 0.5) * 2 * n;
      }

      od[p] = r < 0 ? 0 : r > 255 ? 255 : r;
      od[p + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
      od[p + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
    }
  }

  return out;
}

/**
 * 可分離高斯模糊（先橫再直，複雜度從 O(r²) 降到 O(r)）。
 * @param {ImageData} img 就地修改
 * @param {number} sigma
 */
export function gaussianBlur(img, sigma) {
  if (sigma <= 0) return;
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const size = radius * 2 + 1;
  const kernel = new Float32Array(size);
  let sum = 0;
  for (let i = 0; i < size; i++) {
    const d = i - radius;
    kernel[i] = Math.exp(-(d * d) / (2 * sigma * sigma));
    sum += kernel[i];
  }
  for (let i = 0; i < size; i++) kernel[i] /= sum;

  const { width: W, height: H, data } = img;
  const tmp = new Float32Array(W * H * 3);

  // 橫向
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < size; i++) {
        const sx = Math.min(W - 1, Math.max(0, x + i - radius));
        const p = (y * W + sx) * 4;
        const k = kernel[i];
        r += data[p] * k; g += data[p + 1] * k; b += data[p + 2] * k;
      }
      const t = (y * W + x) * 3;
      tmp[t] = r; tmp[t + 1] = g; tmp[t + 2] = b;
    }
  }
  // 縱向
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < size; i++) {
        const sy = Math.min(H - 1, Math.max(0, y + i - radius));
        const t = (sy * W + x) * 3;
        const k = kernel[i];
        r += tmp[t] * k; g += tmp[t + 1] * k; b += tmp[t + 2] * k;
      }
      const p = (y * W + x) * 4;
      data[p] = r; data[p + 1] = g; data[p + 2] = b;
    }
  }
}

/**
 * JPEG 壓縮（只有瀏覽器能做，Node 端會直接回傳原圖）。
 * 用 canvas 的 toBlob 走一趟真正的 JPEG 編解碼，
 * 這樣色度次取樣與區塊效應都是真的，不是模擬出來的。
 * @param {ImageData} img
 * @param {number} quality 0..1
 * @returns {Promise<ImageData>}
 */
export async function applyJpeg(img, quality) {
  if (quality >= 1 || typeof document === 'undefined') return img;
  const cv = document.createElement('canvas');
  cv.width = img.width; cv.height = img.height;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.putImageData(img, 0, 0);
  const blob = await new Promise((r) => cv.toBlob(r, 'image/jpeg', quality));
  if (!blob) return img;
  const bmp = await createImageBitmap(blob);
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return ctx.getImageData(0, 0, img.width, img.height);
}
