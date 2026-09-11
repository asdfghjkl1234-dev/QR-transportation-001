/**
 * format.js — v3 彩色矩陣碼的幀格式
 * ==================================
 * 這個檔案只處理「格式」本身，完全不碰 canvas 或相機：
 * 輸入資料 → 算出每一格該是什麼顏色；反過來輸入每一格的顏色 → 還原資料。
 * 繪製在 render.js，影像辨識在 detect.js。
 *
 * 一幀的版面（以 cols × rows 個格子為單位）：
 *
 *   y=0..6        ┌──────┐  標頭區（黑白，重複 3 次）  ┌──────┐
 *                 │ 定位 │                             │ 定位 │
 *                 └──────┘                             └──────┘
 *   y=7           ═══════════ 上時序軌（黑白交替）═══════════
 *   y=8           ▓▒░█▓▒░█ 上色票參考條（整組調色盤循環）▓▒░█
 *   y=9..H-10     ║                                              ║
 *                 ║  資料區（切成 sx × sy 個分區，各自 RS+CRC）  ║
 *                 ║  左右兩側 x=7 與 x=W-8 是垂直時序軌          ║
 *   y=H-9         ▓▒░█▓▒░█ 下色票參考條 ▓▒░█
 *   y=H-8         ═══════════ 下時序軌 ═══════════
 *   y=H-7..H-1    ┌──────┐                             ┌──────┐
 *                 │ 定位 │                             │ 定位 │
 *                 └──────┘                             └──────┘
 *
 * 幾個設計決定的理由：
 *
 * - **四角定位標記**用同心方框，其中右下角那個中心多一個點，
 *   讓接收端不必猜就能判斷方向（手機可能上下顛倒地拍）。
 * - **時序軌**是黑白交替的格子。有了它，接收端不需要假設格子是等距的，
 *   可以逐格量出實際位置，把鏡頭桶狀畸變與螢幕彎曲一起吃掉。
 * - **色票參考條**上下各一條。相機看到的顏色會被白平衡、色溫、螢幕亮度
 *   整個扭曲，固定的參考色沒有意義；直接在畫面裡放一組「已知答案」，
 *   接收端就能量出「這個顏色經過這支相機之後長什麼樣」。
 *   上下各放一條是為了處理由上到下的亮度漸層 —— 依格子的垂直位置在兩條之間插值。
 * - **資料白化**：資料在寫進格子前先跟 PRNG 序列 XOR。不做的話，
 *   一大片 0x00 會變成一大片純黑，相機的自動曝光與白平衡會被帶偏，
 *   而且大面積同色也讓時序軌以外的定位線索消失。
 */

import { crc32, mulberry32 } from '../fountain.js';
import { rsEncode, rsDecode, interleave, deinterleave, deinterleaveErasures } from './ecc.js';

/* =========================================================================
 * 1. 調色盤
 * ========================================================================= */

/**
 * C4：2 bits/格。
 * 選黑、白、洋紅、綠的理由：這四個顏色在 CIELAB 空間裡兩兩距離都很大
 * （見 paletteReport()）。洋紅與綠是 a* 軸的兩端，黑白是 L* 軸的兩端，
 * 等於在感知色彩空間裡取了兩條互相垂直的長軸。
 */
export const PALETTE_C4 = [
  [0, 0, 0],        // 0 黑
  [255, 255, 255],  // 1 白
  [255, 0, 255],    // 2 洋紅
  [0, 255, 0],      // 3 綠
];

/**
 * C8：3 bits/格，取 RGB 立方體的 8 個角。
 * 這是「用 8 個顏色時，在 RGB 空間裡能拉開的最大距離」的自然選擇；
 * 但要注意它們在 CIELAB 裡並不等距（黃和白就相當接近），
 * 所以 C8 的錯誤率天生比 C4 高，這也是為什麼 C8 更需要抹除解碼。
 */
export const PALETTE_C8 = [
  [0, 0, 0],        // 0 黑
  [255, 0, 0],      // 1 紅
  [0, 255, 0],      // 2 綠
  [0, 0, 255],      // 3 藍
  [255, 255, 0],    // 4 黃
  [255, 0, 255],    // 5 洋紅
  [0, 255, 255],    // 6 青
  [255, 255, 255],  // 7 白
];

export const PALETTES = { 4: PALETTE_C4, 8: PALETTE_C8 };

/** 每格能帶幾個 bit */
export function bitsPerCell(level) {
  return level === 8 ? 3 : 2;
}

/* --- sRGB ↔ CIELAB ---------------------------------------------------- */

/** sRGB 分量（0..255）→ 線性光 */
function srgbToLinear(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/**
 * sRGB → CIELAB（D65 白點）。
 * 為什麼要轉到 Lab：RGB 空間裡的歐氏距離跟「人眼／相機覺得有多像」對不上，
 * 而我們要判斷的正是「相機拍到的這個顏色最接近哪個參考色」。
 * Lab 是為了感知均勻性設計的，用它做最近鄰分類明顯穩定得多。
 * @param {number[]} rgb
 * @returns {number[]} [L, a, b]
 */
export function srgbToLab(rgb) {
  const r = srgbToLinear(rgb[0]), g = srgbToLinear(rgb[1]), b = srgbToLinear(rgb[2]);
  // 線性 RGB → XYZ（sRGB D65 矩陣）
  let x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
  let y = (r * 0.2126729 + g * 0.7151522 + b * 0.0721750) / 1.00000;
  let z = (r * 0.0193339 + g * 0.1191920 + b * 0.9503041) / 1.08883;
  const f = (t) => t > 0.008856 ? Math.cbrt(t) : (7.787 * t + 16 / 116);
  x = f(x); y = f(y); z = f(z);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/** CIE76 色差（兩個 Lab 之間的歐氏距離） */
export function deltaE(lab1, lab2) {
  const dL = lab1[0] - lab2[0], da = lab1[1] - lab2[1], db = lab1[2] - lab2[2];
  return Math.sqrt(dL * dL + da * da + db * db);
}

/**
 * 調色盤品質報告：算出各顏色兩兩之間的最小 CIELAB 距離。
 *
 * 這是需求裡要求的「小工具」。最小距離就是這組調色盤的瓶頸 ——
 * 分類時最容易混淆的一對就是它。可以傳入一個失真函式，
 * 看看在色偏模型下這個瓶頸會惡化到什麼程度。
 *
 * @param {number[][]} palette
 * @param {(rgb:number[]) => number[]} [distort] 選用的色偏模型
 * @returns {{minDist:number, worstPair:number[], matrix:number[][], labs:number[][]}}
 */
export function paletteReport(palette, distort) {
  const labs = palette.map((c) => srgbToLab(distort ? distort(c) : c));
  const n = palette.length;
  const matrix = Array.from({ length: n }, () => new Array(n).fill(0));
  let minDist = Infinity, worstPair = [0, 1];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const d = deltaE(labs[i], labs[j]);
      matrix[i][j] = d;
      if (i < j && d < minDist) { minDist = d; worstPair = [i, j]; }
    }
  }
  return { minDist, worstPair, matrix, labs };
}

/* =========================================================================
 * 2. 版面
 * ========================================================================= */

export const FINDER = 7;        // 定位標記邊長（格）
export const HEADER_BYTES = 16; // 標頭內容（14 bytes）+ CRC16（2 bytes）
export const HEADER_COPIES = 3; // 標頭重複次數，接收端做多數決

/** 格子的用途代碼 */
export const ROLE = {
  DATA: 0, FINDER: 1, TIMING: 2, COLORBAR: 3, HEADER: 4, PARITY: 5,
  SEPARATOR: 6, ORIENT: 7, UNUSED: 8,
};

/**
 * 算出一幀的完整版面。
 * @param {number} cols
 * @param {number} rows
 * @param {number} sectorsX 水平分區數
 * @param {number} sectorsY 垂直分區數
 */
export function makeLayout(cols, rows, sectorsX = 4, sectorsY = 3) {
  if (cols < 40 || rows < 40) throw new Error(`網格太小（${cols}×${rows}），至少要 40×40`);

  const role = new Uint8Array(cols * rows).fill(ROLE.UNUSED);
  const at = (x, y) => y * cols + x;

  // --- 四角定位標記 ---
  const finders = [
    { x: 0, y: 0, variant: 0 },
    { x: cols - FINDER, y: 0, variant: 0 },
    { x: 0, y: rows - FINDER, variant: 0 },
    { x: cols - FINDER, y: rows - FINDER, variant: 0 },
  ];
  for (const f of finders) {
    for (let dy = 0; dy < FINDER; dy++) {
      for (let dx = 0; dx < FINDER; dx++) role[at(f.x + dx, f.y + dy)] = ROLE.FINDER;
    }
  }

  // --- 分隔白線 ---
  // 定位標記是用「掃描線上 1:1:3:1:1 的黑白比例」找出來的，這要求它外圍
  // 必須有一圈乾淨的白。若緊鄰的是資料格或時序軌（一半機率是黑），
  // 前導的黑色跑道長度就會被拉長，比例檢查直接失敗。
  // 所以在整幀內縮一圈的位置畫上全白的分隔線。
  const sepTop = 7, sepBottom = rows - 8, sepLeft = 7, sepRight = cols - 8;
  for (let x = 0; x < cols; x++) {
    role[at(x, sepTop)] = ROLE.SEPARATOR;
    role[at(x, sepBottom)] = ROLE.SEPARATOR;
  }
  for (let y = 0; y < rows; y++) {
    role[at(sepLeft, y)] = ROLE.SEPARATOR;
    role[at(sepRight, y)] = ROLE.SEPARATOR;
  }

  // --- 方向標記 ---
  // 原本的設計是「第四個定位標記中心多一個白點」，但那會直接破壞
  // 1:1:3:1:1 的比例：中央本來是連續 3 格黑，加了白點就變成 黑白黑，
  // 掃描線再也認不出它，結果右下角的標記完全偵測不到。
  //
  // 改成：四個定位標記完全相同（偵測最可靠），方向另外用一格來標示 ——
  // 在分隔線的四個交叉點各留一格，只有右下角那一格是黑的。
  // 分隔線其餘部分都是白的，所以這一格非常好認，而且完全不影響標記本身。
  const orientMarks = [
    { x: sepLeft, y: sepTop, dark: false },
    { x: sepRight, y: sepTop, dark: false },
    { x: sepLeft, y: sepBottom, dark: false },
    { x: sepRight, y: sepBottom, dark: true },   // 右下角，用來定方向
  ];
  for (const m of orientMarks) role[at(m.x, m.y)] = ROLE.ORIENT;

  // --- 時序軌 ---
  const timingTop = 8, timingBottom = rows - 9;
  const timingLeft = 8, timingRight = cols - 9;
  for (let x = timingLeft; x <= timingRight; x++) {
    role[at(x, timingTop)] = ROLE.TIMING;
    role[at(x, timingBottom)] = ROLE.TIMING;
  }
  for (let y = timingTop; y <= timingBottom; y++) {
    role[at(timingLeft, y)] = ROLE.TIMING;
    role[at(timingRight, y)] = ROLE.TIMING;
  }

  // --- 色票參考條 ---
  const barTop = 9, barBottom = rows - 10;
  for (let x = timingLeft + 1; x < timingRight; x++) {
    role[at(x, barTop)] = ROLE.COLORBAR;
    role[at(x, barBottom)] = ROLE.COLORBAR;
  }

  // --- 標頭區：緊接在上色票條下方，位於時序軌圍成的範圍「之內」---
  //
  // 一開始把標頭放在上帶（兩個定位標記之間），因為那裡空間大又「靠近定位標記」。
  // 但實測發現那是個錯誤的位置：時序軌只能校正它自己圍住的那塊範圍，
  // 標頭在框外，幾何只能靠單應性外推。在有鏡頭桶狀畸變時，
  // 整條標頭列會被「拱」起來，而且是中間拱得最多 ——
  // 那是個彎曲，不是平移，再怎麼微調取樣位置都補不回來，
  // 結果就是「其他都對、只有標頭讀不出來」。
  //
  // 把標頭移進框內之後，它和資料區享有同一套時序軌校正，問題直接消失。
  // 代價只是少掉幾列資料格。
  const dataX0 = timingLeft + 1, dataX1 = timingRight - 1;
  const headerWidth = dataX1 - dataX0 + 1;
  const headerRows = Math.ceil((HEADER_BYTES * 8 * HEADER_COPIES) / headerWidth);
  const headerY0 = barTop + 1;

  const headerCells = [];
  for (let y = headerY0; y < headerY0 + headerRows; y++) {
    for (let x = dataX0; x <= dataX1; x++) {
      role[at(x, y)] = ROLE.HEADER;
      headerCells.push({ x, y });
    }
  }

  // --- 撕裂偵測標記：資料區的四個角各一格 ---
  const dataY0 = headerY0 + headerRows;
  const dataY1 = barBottom - 1;
  const parity = [
    { x: dataX0, y: dataY0 }, { x: dataX1, y: dataY0 },
    { x: dataX0, y: dataY1 }, { x: dataX1, y: dataY1 },
  ];
  for (const p of parity) role[at(p.x, p.y)] = ROLE.PARITY;

  // --- 資料區：剩下的全部 ---
  const dataW = dataX1 - dataX0 + 1;
  const dataH = dataY1 - dataY0 + 1;
  if (dataW < sectorsX * 4 || dataH < sectorsY * 4) {
    throw new Error(`資料區 ${dataW}×${dataH} 放不下 ${sectorsX}×${sectorsY} 個分區`);
  }

  // 把資料區平均切成分區；除不盡的部分分給前面幾個分區
  const sectors = [];
  const colEdges = [dataX0];
  for (let i = 1; i <= sectorsX; i++) colEdges.push(dataX0 + Math.round(dataW * i / sectorsX));
  const rowEdges = [dataY0];
  for (let i = 1; i <= sectorsY; i++) rowEdges.push(dataY0 + Math.round(dataH * i / sectorsY));

  for (let sy = 0; sy < sectorsY; sy++) {
    for (let sx = 0; sx < sectorsX; sx++) {
      const cells = [];
      for (let y = rowEdges[sy]; y < rowEdges[sy + 1]; y++) {
        for (let x = colEdges[sx]; x < colEdges[sx + 1]; x++) {
          if (role[at(x, y)] !== ROLE.UNUSED) continue;   // 跳過標記格
          role[at(x, y)] = ROLE.DATA;
          cells.push(y * cols + x);
        }
      }
      sectors.push({ index: sy * sectorsX + sx, sx, sy, cells: Int32Array.from(cells) });
    }
  }

  return {
    cols, rows, role, sectors, sectorsX, sectorsY, finders, parity, headerCells,
    orientMarks, sepTop, sepBottom, sepLeft, sepRight, headerRows, headerY0,
    timingTop, timingBottom, timingLeft, timingRight, barTop, barBottom,
    dataX0, dataX1, dataY0, dataY1,
  };
}

/**
 * 畫出定位標記的圖樣：同心方框，外框黑、中間一圈白、中央 3×3 黑。
 *
 * 沿著中心線的黑白跑道長度剛好是 1:1:3:1:1，和 QR 的定位圖樣相同 ——
 * 這個比例在旋轉與透視下都近似不變，是它好認的原因。
 * 四個角完全一樣，方向改由分隔線上的方向標記決定。
 *
 * @returns {(dx:number, dy:number) => number} 0=黑 1=白
 */
export function finderPattern() {
  return (dx, dy) => {
    const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
    if (ring <= 1) return 0;   // 中央 3×3 黑
    if (ring === 2) return 1;  // 中間一圈白
    return 0;                  // 外框黑
  };
}

/* =========================================================================
 * 3. 標頭
 * ========================================================================= */

export const MAGIC_V3 = 0x33;
export const VERSION_V3 = 3;

/**
 * 把標頭欄位打包成 16 bytes（14 內容 + 2 CRC16）。
 * 標頭只用黑白兩色，而且整份重複 3 次讓接收端做多數決 ——
 * 因為所有其他資訊（網格尺寸、調色盤）都要靠它才能解讀，
 * 它一旦錯了整幀就報廢，所以值得付這個冗餘。
 */
export function encodeHeader(h) {
  const b = new Uint8Array(HEADER_BYTES);
  const dv = new DataView(b.buffer);
  b[0] = MAGIC_V3;
  b[1] = VERSION_V3;
  dv.setUint16(2, h.sessionId & 0xffff, false);
  // 幀序號用 3 bytes
  b[4] = (h.frameSeq >>> 16) & 0xff;
  b[5] = (h.frameSeq >>> 8) & 0xff;
  b[6] = h.frameSeq & 0xff;
  b[7] = h.paletteLevel;              // 4 或 8
  dv.setUint16(8, h.cols, false);
  dv.setUint16(10, h.rows, false);
  b[12] = h.sectorsX;
  b[13] = h.sectorsY;
  // CRC32 取低 16 bits 當 CRC16 用
  dv.setUint16(14, crc32(b, 0, 14) & 0xffff, false);
  return b;
}

/**
 * 解析標頭，CRC 不符回傳 null。
 */
export function decodeHeader(b) {
  if (!b || b.length < HEADER_BYTES) return null;
  if (b[0] !== MAGIC_V3 || b[1] !== VERSION_V3) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if ((crc32(b, 0, 14) & 0xffff) !== dv.getUint16(14, false)) return null;
  const paletteLevel = b[7];
  if (paletteLevel !== 4 && paletteLevel !== 8) return null;
  return {
    sessionId: dv.getUint16(2, false),
    frameSeq: (b[4] << 16) | (b[5] << 8) | b[6],
    paletteLevel,
    cols: dv.getUint16(8, false),
    rows: dv.getUint16(10, false),
    sectorsX: b[12],
    sectorsY: b[13],
  };
}

/**
 * 從 3 份重複的位元中做多數決還原標頭位元組。
 * @param {Uint8Array} bits 每個元素是 0 或 1，長度至少 HEADER_BYTES*8*3
 */
export function headerMajorityVote(bits) {
  const nbits = HEADER_BYTES * 8;
  const out = new Uint8Array(HEADER_BYTES);
  for (let i = 0; i < nbits; i++) {
    let ones = 0;
    for (let c = 0; c < HEADER_COPIES; c++) {
      if (bits[c * nbits + i]) ones++;
    }
    if (ones * 2 > HEADER_COPIES) out[i >> 3] |= 0x80 >> (i & 7);
  }
  return out;
}

/* =========================================================================
 * 4. 資料白化
 * =========================================================================
 * 用 PRNG 產生的序列跟資料 XOR。種子由 sessionId、幀序號、分區編號決定，
 * 所以兩端不必傳遞任何額外資訊就能各自算出同一串序列。
 *
 * 一定要在 RS 編碼「之後」才做白化：如果先白化再 RS，RS 產生的校驗符號
 * 本身沒有被白化過，一段全零資料仍然會產生規律的校驗區塊。
 */
export function whiten(bytes, seed) {
  const rand = mulberry32(seed >>> 0);
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ ((rand() * 256) | 0);
  return out;
}

/** 白化是 XOR，所以解白化就是再做一次 */
export const unwhiten = whiten;

/** 由 sessionId、幀序號、分區編號算出白化種子 */
export function whitenSeed(sessionId, frameSeq, sectorIndex) {
  return (Math.imul(sessionId + 1, 0x9e3779b1)
        ^ Math.imul(frameSeq + 1, 0x85ebca6b)
        ^ Math.imul(sectorIndex + 1, 0xc2b2ae35)) >>> 0;
}

/* =========================================================================
 * 5. 分區的 RS 規劃
 * ========================================================================= */

/**
 * 依分區的格子數算出 RS 參數與實際可載入的位元組數。
 *
 * @param {number} cellCount 這個分區有幾格
 * @param {number} level 調色盤等級（4 或 8）
 * @param {number} redundancy RS 冗餘比例（0.1～0.5），預設 0.25 對應 RS(255,191)
 * @returns {{totalBytes:number, nChunks:number, chunkLen:number, nsym:number, payload:number}}
 */
export function sectorPlan(cellCount, level, redundancy = 0.25) {
  const bpc = bitsPerCell(level);
  const totalBytes = Math.floor((cellCount * bpc) / 8);
  if (totalBytes < 16) return null;   // 太小，放不下有意義的東西

  // 碼字最長 255，所以要切成幾塊
  const nChunks = Math.max(1, Math.ceil(totalBytes / 255));
  const chunkLen = Math.floor(totalBytes / nChunks);
  if (chunkLen < 8) return null;

  let nsym = Math.round(chunkLen * redundancy);
  nsym = Math.max(2, Math.min(nsym, chunkLen - 4));   // 至少留 4 bytes 給資料
  if (nsym % 2 === 1) nsym++;                          // 取偶數，更正能力剛好是整數
  if (nsym > chunkLen - 4) nsym -= 2;

  const payload = nChunks * (chunkLen - nsym);
  if (payload < 8) return null;
  return { totalBytes, nChunks, chunkLen, nsym, payload };
}

/* =========================================================================
 * 6. 位元組 ↔ 格子符號
 * ========================================================================= */

/**
 * 位元組串 → 每格的符號值。
 * @param {Uint8Array} bytes
 * @param {number} level 4 或 8
 * @param {number} cellCount 要填滿幾格
 * @returns {Uint8Array} 每個元素是 0..level-1
 */
export function bytesToSymbols(bytes, level, cellCount) {
  const bpc = bitsPerCell(level);
  const out = new Uint8Array(cellCount);
  const mask = (1 << bpc) - 1;
  for (let i = 0; i < cellCount; i++) {
    const bitPos = i * bpc;
    let v = 0;
    for (let b = 0; b < bpc; b++) {
      const p = bitPos + b;
      const byte = p >> 3;
      const bit = byte < bytes.length ? (bytes[byte] >> (7 - (p & 7))) & 1 : 0;
      v = (v << 1) | bit;
    }
    out[i] = v & mask;
  }
  return out;
}

/**
 * 每格的符號值 → 位元組串。
 * @param {Uint8Array} symbols
 * @param {number} level
 * @param {number} byteCount
 */
export function symbolsToBytes(symbols, level, byteCount) {
  const bpc = bitsPerCell(level);
  const out = new Uint8Array(byteCount);
  for (let i = 0; i < symbols.length; i++) {
    const bitPos = i * bpc;
    for (let b = 0; b < bpc; b++) {
      const p = bitPos + b;
      const byte = p >> 3;
      if (byte >= byteCount) break;
      const bit = (symbols[i] >> (bpc - 1 - b)) & 1;
      if (bit) out[byte] |= 0x80 >> (p & 7);
    }
  }
  return out;
}

/**
 * 把「信心度低的格子」換算成「要標記為抹除的位元組位置」。
 *
 * 一格覆蓋 bpc 個 bit，可能跨在兩個位元組上，所以一格最多會標記到兩個位元組。
 * 這會讓抹除數略微膨脹，但正確性優先 —— 標多了只是浪費一點更正能力，
 * 標漏了會讓 RS 拿到它以為可信、實際是錯的資料。
 *
 * @param {number[]} lowConfCells 信心度低的格子索引（分區內編號）
 * @param {number} level
 * @param {number} byteCount
 * @returns {number[]} 排序去重後的位元組位置
 */
export function cellsToByteErasures(lowConfCells, level, byteCount) {
  const bpc = bitsPerCell(level);
  const set = new Set();
  for (const c of lowConfCells) {
    const start = c * bpc, end = start + bpc - 1;
    for (let byte = start >> 3; byte <= (end >> 3); byte++) {
      if (byte < byteCount) set.add(byte);
    }
  }
  return [...set].sort((a, b) => a - b);
}

/* =========================================================================
 * 7. 分區的編碼與解碼
 * ========================================================================= */

/**
 * 把一個噴泉碼封包編成這個分區所有格子的符號值。
 *
 * 流程：payload → 補齊 → 切塊 RS 編碼 → 交錯 → 白化 → 轉成符號
 *
 * @param {Uint8Array} payload 噴泉碼封包（長度必須等於 plan.payload）
 * @param {object} plan sectorPlan() 的結果
 * @param {number} cellCount
 * @param {number} level
 * @param {number} seed 白化種子
 * @returns {Uint8Array} 長度 cellCount 的符號陣列
 */
export function encodeSector(payload, plan, cellCount, level, seed) {
  const { nChunks, chunkLen, nsym } = plan;
  const k = chunkLen - nsym;

  const padded = new Uint8Array(nChunks * k);
  padded.set(payload.subarray(0, Math.min(payload.length, padded.length)));

  const chunks = [];
  for (let i = 0; i < nChunks; i++) {
    chunks.push(rsEncode(padded.subarray(i * k, (i + 1) * k), nsym));
  }

  const woven = interleave(chunks);          // 讓相鄰格子屬於不同碼字
  const whitened = whiten(woven, seed);      // 打散顏色分佈
  return bytesToSymbols(whitened, level, cellCount);
}

/**
 * 從一個分區的符號值還原出噴泉碼封包。
 *
 * @param {Uint8Array} symbols 這個分區每一格的符號值
 * @param {number[]} lowConfCells 信心度低的格子（分區內編號）
 * @param {object} plan
 * @param {number} level
 * @param {number} seed
 * @returns {{payload:Uint8Array, corrected:number, erasures:number}|null}
 *          任何一個 RS 區塊解不開就回傳 null（整個分區作廢）
 */
export function decodeSector(symbols, lowConfCells, plan, level, seed) {
  const { nChunks, chunkLen, nsym, totalBytes } = plan;
  const k = chunkLen - nsym;

  const whitened = symbolsToBytes(symbols, level, totalBytes);
  const woven = unwhiten(whitened, seed);
  // 只取交錯資料實際佔用的長度（totalBytes 可能比 nChunks*chunkLen 多幾個位元組）
  const usable = woven.subarray(0, nChunks * chunkLen);
  const chunks = deinterleave(usable, nChunks);

  const eraseBytes = cellsToByteErasures(lowConfCells, level, nChunks * chunkLen);
  const perChunk = deinterleaveErasures(eraseBytes, nChunks);

  const out = new Uint8Array(nChunks * k);
  let corrected = 0;
  for (let i = 0; i < nChunks; i++) {
    const r = rsDecode(chunks[i], nsym, perChunk[i]);
    if (!r) return null;                    // 這一塊救不回來 → 整個分區作廢
    out.set(r.msg, i * k);
    corrected += r.corrected;
  }
  return { payload: out, corrected, erasures: eraseBytes.length };
}

/* =========================================================================
 * 8. 幀層級的容量計算
 * ========================================================================= */

/**
 * 算出一整幀的容量與參數。
 * @param {object} layout makeLayout() 的結果
 * @param {number} level
 * @param {number} redundancy
 */
export function frameCapacity(layout, level, redundancy = 0.25) {
  const plans = layout.sectors.map((s) => sectorPlan(s.cells.length, level, redundancy));
  const valid = plans.filter(Boolean);
  const payloadPerSector = valid.length ? Math.min(...valid.map((p) => p.payload)) : 0;
  return {
    plans,
    sectorCount: valid.length,
    // 所有分區統一使用相同的 payload 大小，噴泉碼的區塊大小才能一致
    payloadPerSector,
    totalPayload: payloadPerSector * valid.length,
    dataCells: layout.sectors.reduce((a, s) => a + s.cells.length, 0),
  };
}

/* =========================================================================
 * Metadata 分塊
 * =========================================================================
 * metadata（檔名、MIME、檔案大小、區塊大小、整檔 SHA-256）是 JSON，
 * 加上 64 個十六進位字元的雜湊之後約 150～250 bytes，
 * 而一個分區只載得下幾十 bytes（實測 C8、100×64、4×3 分區時是 73 bytes）。
 *
 * 原本的做法是 subarray(0, payloadPerSector) 直接截斷，結果 JSON 永遠不完整，
 * 接收端 JSON.parse 永遠失敗 —— 症狀是每一幀都解得開、分區成功率 100%、
 * 進度卻永遠停在 0%，而且因為 metadata 缺席，連解碼器都開不起來。
 *
 * 改成把 metadata 切成數塊，一塊放一個分區（metadata 幀只用前幾個分區，
 * 其餘照常送噴泉碼封包）。每塊自帶 magic、序號、總長與 CRC16，
 * 所以就算中間掉了一塊，接收端也只是繼續等下一輪，不會拼出壞資料。
 */

/** metadata 分塊的標頭長度：magic(3) + idx(1) + count(1) + len(1) + total(2) */
const META_HEADER = 8;
/** 分塊尾端的 CRC16 長度 */
const META_CRC = 2;
/** 分塊的 magic，用來和噴泉碼封包區分（噴泉碼封包有自己的 magic 與 CRC32） */
const META_MAGIC = [0x56, 0x33, 0x4d];   // 'V3M'

/** 一個分區能放多少 metadata 位元組 */
export function metaChunkCapacity(sectorPayloadSize) {
  return sectorPayloadSize - META_HEADER - META_CRC;
}

/**
 * 把 metadata 切成數個「剛好填滿一個分區」的分塊。
 * @param {Uint8Array} bytes metadata 原始內容（通常是 UTF-8 的 JSON）
 * @param {number} sectorPayloadSize 一個分區的酬載長度
 * @returns {Uint8Array[]|null} 每個元素長度都等於 sectorPayloadSize；分區太小則回傳 null
 */
export function encodeMetaChunks(bytes, sectorPayloadSize) {
  const per = metaChunkCapacity(sectorPayloadSize);
  if (per < 8) return null;
  const count = Math.ceil(bytes.length / per);
  if (count > 255) return null;

  const out = [];
  for (let i = 0; i < count; i++) {
    const slice = bytes.subarray(i * per, Math.min(bytes.length, (i + 1) * per));
    const b = new Uint8Array(sectorPayloadSize);
    b[0] = META_MAGIC[0]; b[1] = META_MAGIC[1]; b[2] = META_MAGIC[2];
    b[3] = i; b[4] = count; b[5] = slice.length;
    b[6] = (bytes.length >> 8) & 0xff; b[7] = bytes.length & 0xff;
    b.set(slice, META_HEADER);
    const crc = crc32(b, 0, META_HEADER + slice.length) & 0xffff;
    b[META_HEADER + slice.length] = (crc >> 8) & 0xff;
    b[META_HEADER + slice.length + 1] = crc & 0xff;
    out.push(b);
  }
  return out;
}

/**
 * 解析一個分區酬載，看它是不是 metadata 分塊。
 * @returns {{idx:number, count:number, total:number, data:Uint8Array}|null}
 */
export function decodeMetaChunk(payload) {
  if (!payload || payload.length < META_HEADER + META_CRC) return null;
  if (payload[0] !== META_MAGIC[0] || payload[1] !== META_MAGIC[1] || payload[2] !== META_MAGIC[2]) return null;
  const idx = payload[3], count = payload[4], len = payload[5];
  const total = (payload[6] << 8) | payload[7];
  if (count === 0 || idx >= count) return null;
  if (META_HEADER + len + META_CRC > payload.length) return null;
  const crc = crc32(payload, 0, META_HEADER + len) & 0xffff;
  const got = (payload[META_HEADER + len] << 8) | payload[META_HEADER + len + 1];
  if (crc !== got) return null;
  return { idx, count, total, data: payload.subarray(META_HEADER, META_HEADER + len) };
}

/**
 * 收集 metadata 分塊，湊齊就拼回原始位元組。
 * 分塊會隨著每一輪 metadata 幀重複送出，所以掉了也只是多等一輪。
 */
export class MetaAssembler {
  constructor() { this.chunks = null; this.count = 0; this.total = 0; }

  /**
   * @param {Uint8Array} payload 一個分區的酬載
   * @returns {Uint8Array|null} 湊齊時回傳完整內容，否則 null
   */
  add(payload) {
    const c = decodeMetaChunk(payload);
    if (!c) return null;
    // 總長或塊數變了代表換了一份 metadata（例如使用者重新開始傳），重來
    if (!this.chunks || this.count !== c.count || this.total !== c.total) {
      this.chunks = new Array(c.count).fill(null);
      this.count = c.count; this.total = c.total;
    }
    this.chunks[c.idx] = Uint8Array.from(c.data);
    if (this.chunks.some((x) => x === null)) return null;

    const out = new Uint8Array(this.total);
    let at = 0;
    for (const part of this.chunks) {
      out.set(part.subarray(0, Math.min(part.length, this.total - at)), at);
      at += part.length;
    }
    return out;
  }
}
