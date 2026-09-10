/**
 * fountain.js — QR 碼串流傳檔系統的共用核心邏輯
 * =============================================
 *
 * 這個模組同時被 sender.html / receiver.html / test.html / test.node.mjs 引用，
 * 是「發送端」與「接收端」唯一的共同真理來源（single source of truth）。
 * 只要兩端跑的是同一份 fountain.js，就保證雙方對「seed → 要 XOR 哪幾塊」的
 * 認知完全一致，這正是單向噴泉碼傳輸能成立的關鍵。
 *
 * 內容分成九個區塊：
 *   1. mulberry32       — 確定性 PRNG（兩端共用）
 *   2. CRC32            — 封包完整性校驗
 *   3. SHA-256          — 整檔驗證（純 JS，不依賴 crypto.subtle，故 http 也能跑）
 *   4. Base64           — 二進位 ↔ ASCII（塞進 QR 的 Byte mode）
 *   5. Robust Soliton   — LT 碼的度數分布
 *   6. selectBlocks     — seed → 來源區塊索引集合（兩端必須完全一致）
 *   7. 封包編解碼        — 二進位 header + payload + CRC32
 *   8. LTEncoder        — 發送端：切塊、產生系統區塊與隨機編碼區塊
 *   9. LTDecoder        — 接收端：peeling decoder（belief propagation）
 *
 * 本模組為純 ES module，沒有任何外部相依，可在瀏覽器與 Node.js 直接使用。
 */

/* =========================================================================
 * 1. PRNG：mulberry32
 * =========================================================================
 * 為什麼要自己寫 PRNG？因為 Math.random() 不能指定種子，兩端無法重現同一串
 * 亂數。mulberry32 是一個 32-bit 狀態的高品質小型 PRNG，同一個 seed 在任何
 * 平台（瀏覽器 / Node）都會產生完全相同的序列，正好符合我們的需求。
 *
 * @param {number} seed 32-bit 無號整數種子
 * @returns {() => number} 每次呼叫回傳 [0, 1) 的浮點數
 */
export function mulberry32(seed) {
  // >>> 0 強制轉成 32-bit 無號整數，避免 JS 的浮點數語意混進來
  let a = seed >>> 0;
  return function () {
    // 每次先把狀態往前推進一個固定的奇數常數（黃金比例相關）
    a = (a + 0x6d2b79f5) >>> 0;
    // Math.imul 做的是 32-bit 整數乘法（一般的 * 會溢位成浮點數）
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    // 除以 2^32 得到 [0, 1)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* =========================================================================
 * 2. CRC32（IEEE 802.3，reflected 版本）
 * =========================================================================
 * 相機拍到的 QR 碼即使被 QR 本身的糾錯救回來，仍有極小機率解出錯誤位元組；
 * 一個壞掉的區塊混進 peeling decoder 會污染一大片結果，所以每個封包都附
 * CRC32，對不上就整包丟掉（反正噴泉碼不在乎丟掉哪幾幀）。
 */

// 預先算好 256 項查表，讓每個位元組只要一次查表 + 一次 XOR
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      // 0xedb88320 是 IEEE 多項式 0x04c11db7 的 bit-reversed 形式
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

/**
 * 計算一段位元組的 CRC32。
 * @param {Uint8Array} bytes
 * @param {number} [start=0] 起始位移（含）
 * @param {number} [end=bytes.length] 結束位移（不含）
 * @returns {number} 32-bit 無號整數
 */
export function crc32(bytes, start = 0, end = bytes.length) {
  let c = 0xffffffff; // 初始值全 1
  for (let i = start; i < end; i++) {
    c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0; // 最後再全部反相
}

/* =========================================================================
 * 3. SHA-256（純 JS 實作）
 * =========================================================================
 * 用來驗證「整個檔案」有沒有正確還原。
 * 刻意不用 crypto.subtle：那個 API 只在 secure context（HTTPS / localhost）
 * 才存在，但發送端很可能是在區域網路的純 http 位址上開的，用純 JS 才能保證
 * 兩端都算得出來、而且結果一致。檔案不大（幾 MB），純 JS 的速度完全夠用。
 */

// 前 64 個質數的立方根小數部分（標準 SHA-256 輪常數）
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/**
 * 計算 SHA-256 摘要。
 * @param {Uint8Array} bytes
 * @returns {Uint8Array} 32 bytes 的摘要
 */
export function sha256(bytes) {
  // 前 8 個質數的平方根小數部分（初始雜湊值）
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  const len = bytes.length;
  // 訊息填充：先補一個 0x80，再補 0 直到長度 ≡ 56 (mod 64)，最後 8 bytes 放原始位元長度
  const paddedLen = (((len + 8) >> 6) + 1) << 6;
  const msg = new Uint8Array(paddedLen);
  msg.set(bytes);
  msg[len] = 0x80;
  const bitLenHi = Math.floor((len * 8) / 4294967296);
  const bitLenLo = (len * 8) >>> 0;
  const dv = new DataView(msg.buffer);
  dv.setUint32(paddedLen - 8, bitLenHi, false); // big-endian
  dv.setUint32(paddedLen - 4, bitLenLo, false);

  const w = new Uint32Array(64); // message schedule，重複使用以免每輪配置

  // 一次處理 64 bytes（512 bits）的區塊
  for (let off = 0; off < paddedLen; off += 64) {
    // 前 16 個字直接取自訊息
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
    // 後 48 個字由前面的字擴展而來
    for (let i = 16; i < 64; i++) {
      const g0 = w[i - 15], g1 = w[i - 2];
      const s0 = ((g0 >>> 7) | (g0 << 25)) ^ ((g0 >>> 18) | (g0 << 14)) ^ (g0 >>> 3);
      const s1 = ((g1 >>> 17) | (g1 << 15)) ^ ((g1 >>> 19) | (g1 << 13)) ^ (g1 >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }

    // 64 輪壓縮
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + SHA256_K[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    // 把這一輪的結果加回累計雜湊值
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }

  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  [h0, h1, h2, h3, h4, h5, h6, h7].forEach((v, i) => odv.setUint32(i * 4, v >>> 0, false));
  return out;
}

/**
 * SHA-256 的十六進位字串版本（metadata JSON 裡存的就是這個格式）。
 * @param {Uint8Array} bytes
 * @returns {string} 64 個字元的小寫十六進位字串
 */
export function sha256Hex(bytes) {
  return Array.from(sha256(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

/* =========================================================================
 * 4. Base64
 * =========================================================================
 * QR 碼的 Byte mode 理論上可以塞任意位元組，但實務上很多解碼器（含 jsQR）
 * 會把結果當成字串處理，非 ASCII 的位元組容易在轉碼過程中被破壞。
 * 因此我們把二進位封包先轉成 base64（純 ASCII），代價是資料量變成 4/3 倍，
 * 換來的是跨瀏覽器、跨解碼器的可靠性。
 */

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
// 反向查表：字元碼 → 6-bit 值，255 代表非法字元
const B64_LOOKUP = (() => {
  const t = new Uint8Array(256).fill(255);
  for (let i = 0; i < B64_CHARS.length; i++) t[B64_CHARS.charCodeAt(i)] = i;
  return t;
})();

/**
 * Uint8Array → base64 字串（自行實作，不依賴 btoa，Node 也能用）。
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function bytesToBase64(bytes) {
  let out = '';
  let i = 0;
  // 每次處理 3 bytes（24 bits）→ 4 個 base64 字元
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64_CHARS[(n >> 18) & 63] + B64_CHARS[(n >> 12) & 63] +
           B64_CHARS[(n >> 6) & 63] + B64_CHARS[n & 63];
  }
  // 處理剩下的 1 或 2 bytes，用 '=' 補齊
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i] << 16;
    out += B64_CHARS[(n >> 18) & 63] + B64_CHARS[(n >> 12) & 63] + '==';
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64_CHARS[(n >> 18) & 63] + B64_CHARS[(n >> 12) & 63] +
           B64_CHARS[(n >> 6) & 63] + '=';
  }
  return out;
}

/**
 * base64 字串 → Uint8Array。遇到非法字元回傳 null（當成壞封包丟掉）。
 * @param {string} str
 * @returns {Uint8Array|null}
 */
export function base64ToBytes(str) {
  // 先算出有效字元數（略過 '=' 與任何空白）
  let validLen = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code === 61 /* '=' */) break;
    if (code === 32 || code === 10 || code === 13 || code === 9) continue;
    if (code > 255 || B64_LOOKUP[code] === 255) return null; // 非法字元
    validLen++;
  }
  const outLen = (validLen * 3) >> 2; // 每 4 個字元還原 3 bytes
  const out = new Uint8Array(outLen);
  let acc = 0, bits = 0, o = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code === 61) break;
    const v = code > 255 ? 255 : B64_LOOKUP[code];
    if (v === 255) continue; // 空白
    acc = (acc << 6) | v;
    bits += 6;
    // 每累積滿 8 bits 就吐出一個 byte
    if (bits >= 8) {
      bits -= 8;
      if (o < outLen) out[o++] = (acc >> bits) & 0xff;
    }
  }
  return o === outLen ? out : out.subarray(0, o);
}

/* =========================================================================
 * 5. Robust Soliton 度數分布
 * =========================================================================
 * LT 碼的靈魂。每個編碼區塊要 XOR 幾個來源區塊（度數 d），是從這個機率分布
 * 抽出來的。分布的設計目標是：
 *   - 要有足夠多的 d=1（不然 peeling decoder 根本啟動不了）
 *   - 大部分 d 要小（解碼才快）
 *   - 要有少量的大 d（才能覆蓋到那些一直沒被選到的「孤兒」區塊）
 *
 * 公式（Luby, 2002）：
 *   理想 soliton:  ρ(1) = 1/K,  ρ(d) = 1/(d(d-1))  for d = 2..K
 *   額外的尖峰:    R = c·ln(K/δ)·√K
 *                  τ(d) = R/(dK)              for d = 1 .. ⌊K/R⌋-1
 *                  τ(K/R) = R·ln(R/δ)/K
 *                  τ(d) = 0                   for d > K/R
 *   最終分布:      μ(d) = (ρ(d) + τ(d)) / Z,  Z = Σ(ρ+τ)
 */

// c 與 δ 是 Robust Soliton 的兩個調參。c 越小尖峰越靠右、平均度數越低；
// δ 是「解碼失敗機率上界」。這組值（0.03 / 0.05）在 K 數百～數千時實測表現良好。
export const RS_C = 0.03;
export const RS_DELTA = 0.05;

// cdf 的計算對同一個 K 都一樣，算一次就好，用快取避免每幀重算
const cdfCache = new Map();

/**
 * 產生 Robust Soliton 分布的累積機率表（CDF）。
 * @param {number} K 來源區塊數
 * @param {number} [c=RS_C]
 * @param {number} [delta=RS_DELTA]
 * @returns {Float64Array} 長度 K+1，index 0 不用，cdf[d] = P(度數 ≤ d)
 */
export function robustSolitonCdf(K, c = RS_C, delta = RS_DELTA) {
  const cacheKey = `${K}|${c}|${delta}`;
  const cached = cdfCache.get(cacheKey);
  if (cached) return cached;

  const pdf = new Float64Array(K + 1); // index 0 保留不用，度數從 1 開始

  // --- 理想 soliton 分布 ρ ---
  pdf[1] = 1 / K;
  for (let d = 2; d <= K; d++) pdf[d] = 1 / (d * (d - 1));

  // --- 加上 τ 的尖峰 ---
  const R = c * Math.log(K / delta) * Math.sqrt(K);
  const spike = Math.round(K / R); // 尖峰所在的度數位置
  if (spike >= 1) {
    for (let d = 1; d < spike && d <= K; d++) pdf[d] += R / (d * K);
    if (spike <= K) pdf[spike] += (R * Math.log(R / delta)) / K;
  }

  // --- 正規化並轉成 CDF ---
  let Z = 0;
  for (let d = 1; d <= K; d++) Z += pdf[d];
  const cdf = new Float64Array(K + 1);
  let acc = 0;
  for (let d = 1; d <= K; d++) {
    acc += pdf[d] / Z;
    cdf[d] = acc;
  }
  cdf[K] = 1; // 消除浮點誤差，確保最後一項剛好是 1

  cdfCache.set(cacheKey, cdf);
  return cdf;
}

/**
 * 用一個 [0,1) 的亂數在 CDF 上做二分搜尋，得到度數 d。
 * @param {Float64Array} cdf
 * @param {number} r [0,1) 的亂數
 * @returns {number} 度數，範圍 1..K
 */
export function degreeFromRandom(cdf, r) {
  let lo = 1, hi = cdf.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cdf[mid] < r) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/* =========================================================================
 * 6. seed → 來源區塊索引（發送端與接收端的共同約定）
 * =========================================================================
 * 這是整個系統最關鍵的一致性契約：只要拿到 seed 和 K，兩端就能算出完全一樣
 * 的索引集合，所以封包裡不需要（也不該）夾帶索引清單，省下大量頻寬。
 *
 * 約定：seed < K 的區間保留給「系統區塊」（systematic block），
 *       此時度數固定為 1，索引就是 seed 本身。
 *       這讓前 K 幀等同於直接依序播放原始區塊 —— 訊號好的話第一輪就收完，
 *       完全不必付出 LT 碼的解碼開銷。
 *       seed >= K 才是真正的隨機編碼區塊。
 */

/**
 * 由 seed 決定這一幀要 XOR 哪幾個來源區塊。
 * @param {number} seed 32-bit 無號整數
 * @param {number} K 來源區塊總數
 * @returns {number[]} 不重複的來源區塊索引陣列
 */
export function selectBlocks(seed, K) {
  // --- 系統區塊：seed 直接就是索引 ---
  if (seed < K) return [seed];

  // --- 隨機編碼區塊 ---
  const rand = mulberry32(seed);
  const cdf = robustSolitonCdf(K);
  let d = degreeFromRandom(cdf, rand());
  if (d > K) d = K;

  if (d === K) {
    // 度數等於全部：直接回傳所有索引
    return Array.from({ length: K }, (_, i) => i);
  }

  if (d * 2 <= K) {
    // 度數不到一半：用拒絕取樣（rejection sampling）挑 d 個不重複索引，
    // 期望重試次數很低，比起配置 K 大小的陣列做洗牌划算得多
    const picked = new Set();
    while (picked.size < d) picked.add(Math.floor(rand() * K) % K);
    return Array.from(picked);
  }

  // 度數超過一半：改成挑「要排除的 K-d 個索引」，避免拒絕取樣一直撞號
  const excluded = new Set();
  while (excluded.size < K - d) excluded.add(Math.floor(rand() * K) % K);
  const out = [];
  for (let i = 0; i < K; i++) if (!excluded.has(i)) out.push(i);
  return out;
}

/* =========================================================================
 * 7. 封包格式
 * =========================================================================
 * 位移  長度  欄位
 * ----  ----  --------------------------------------------------------
 *   0     2   magic          固定為 0x51 0x54（ASCII 的 "QT"）
 *   2     1   version        協定版本，目前為 1
 *   3     1   flags          bit0 = 1 表示這是 metadata 幀
 *   4     4   sessionId      本次傳輸的隨機識別碼，用來分辨不同次傳輸
 *   8     4   fileSize       原始檔案總位元組數
 *  12     2   blockSize      每個來源區塊的大小
 *  14     4   K              來源區塊數
 *  18     4   seed           本幀的 seed（metadata 幀為 0）
 *  22     n   payload        資料幀 = 編碼區塊；metadata 幀 = UTF-8 JSON
 *  22+n   4   crc32          涵蓋位移 0 到 22+n-1 的全部內容
 *
 * 所有多位元組欄位一律使用 big-endian。
 */

export const MAGIC_0 = 0x51;            // 'Q'
export const MAGIC_1 = 0x54;            // 'T'
export const PROTOCOL_VERSION = 1;
export const HEADER_SIZE = 22;
export const CRC_SIZE = 4;
export const FLAG_METADATA = 0x01;      // flags 的 bit0
export const METADATA_INTERVAL = 20;    // 每 20 幀插入一個 metadata 幀

/**
 * 組出一個完整封包。
 * @param {{sessionId:number, fileSize:number, blockSize:number, K:number,
 *          seed:number, payload:Uint8Array, flags?:number}} o
 * @returns {Uint8Array}
 */
export function encodePacket(o) {
  const payload = o.payload;
  const total = HEADER_SIZE + payload.length + CRC_SIZE;
  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);

  buf[0] = MAGIC_0;
  buf[1] = MAGIC_1;
  buf[2] = PROTOCOL_VERSION;
  buf[3] = o.flags || 0;
  dv.setUint32(4, o.sessionId >>> 0, false);
  dv.setUint32(8, o.fileSize >>> 0, false);
  dv.setUint16(12, o.blockSize, false);
  dv.setUint32(14, o.K >>> 0, false);
  dv.setUint32(18, o.seed >>> 0, false);
  buf.set(payload, HEADER_SIZE);
  // CRC 涵蓋 header + payload（也就是自己以外的所有位元組）
  dv.setUint32(total - CRC_SIZE, crc32(buf, 0, total - CRC_SIZE), false);
  return buf;
}

/**
 * 解析並驗證封包。任何一項檢查沒過就回傳 null，呼叫端直接丟棄即可。
 * @param {Uint8Array} buf
 * @returns {{isMetadata:boolean, sessionId:number, fileSize:number,
 *            blockSize:number, K:number, seed:number, payload:Uint8Array}|null}
 */
export function decodePacket(buf) {
  // 長度不足以容納 header + CRC
  if (!buf || buf.length < HEADER_SIZE + CRC_SIZE) return null;
  // magic 不對：多半是掃到別的 QR 碼
  if (buf[0] !== MAGIC_0 || buf[1] !== MAGIC_1) return null;
  // 版本不符：協定不相容
  if (buf[2] !== PROTOCOL_VERSION) return null;

  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const expected = dv.getUint32(buf.length - CRC_SIZE, false);
  // CRC 不符：資料在傳輸中壞掉了，丟掉就好（噴泉碼不差這一幀）
  if (crc32(buf, 0, buf.length - CRC_SIZE) !== expected) return null;

  const flags = buf[3];
  const blockSize = dv.getUint16(12, false);
  const K = dv.getUint32(14, false);
  const payload = buf.subarray(HEADER_SIZE, buf.length - CRC_SIZE);
  const isMetadata = (flags & FLAG_METADATA) !== 0;

  // 資料幀的 payload 長度必須剛好等於 blockSize，否則視為壞包
  if (!isMetadata && payload.length !== blockSize) return null;
  // 基本合理性檢查，避免壞值造成後續配置爆掉
  if (K === 0 || blockSize === 0) return null;

  return {
    isMetadata,
    sessionId: dv.getUint32(4, false),
    fileSize: dv.getUint32(8, false),
    blockSize,
    K,
    seed: dv.getUint32(18, false),
    payload,
  };
}

/* =========================================================================
 * 8. LTEncoder — 發送端
 * =========================================================================
 * 職責：把檔案切成 K 個區塊，然後源源不絕地產生封包。
 * 產生順序：
 *   第 0 幀           → metadata
 *   第 1..K 幀        → 系統區塊（seed = 0, 1, 2, ...），每 20 幀插一次 metadata
 *   之後              → 隨機編碼區塊（seed 為 >= K 的隨機值）
 * 只要一直呼叫 nextPacket()，它就會無限循環下去，永遠不會「送完」——
 * 這正是噴泉碼的特性：接收端收夠了自己會停，發送端不需要知道。
 */
export class LTEncoder {
  /**
   * @param {Uint8Array} data 原始檔案內容
   * @param {number} blockSize 每個來源區塊的大小（bytes）
   * @param {{sessionId?:number, rng?:() => number}} [options]
   *        sessionId 省略則隨機產生；
   *        rng 是產生隨機 seed 用的亂數來源，預設 Math.random。
   *        測試時可以傳入 mulberry32(固定種子) 讓整個流程完全可重現。
   */
  constructor(data, blockSize, options = {}) {
    this.rng = options.rng || Math.random;
    this.fileSize = data.length;
    this.blockSize = blockSize;
    // 最後一塊不足的部分補零（接收端會依 fileSize 把補的零切掉）
    this.K = Math.max(1, Math.ceil(data.length / blockSize));
    this.blocks = new Uint8Array(this.K * blockSize);
    this.blocks.set(data);

    this.sessionId = (options.sessionId === undefined
      ? (this.rng() * 4294967296) >>> 0
      : options.sessionId) >>> 0;
    this.metadataPayload = null; // 由 setMetadata() 設定
    this.frameIndex = 0;         // 已產生的總幀數（含 metadata 幀）
    this.dataFrameIndex = 0;     // 已產生的資料幀數（決定系統區塊進度）
  }

  /**
   * 設定 metadata 幀的內容。
   * @param {{name:string, type:string, sha256:string}} meta
   */
  setMetadata(meta) {
    this.metadataPayload = new TextEncoder().encode(JSON.stringify(meta));
  }

  /**
   * 依 seed 產生一個編碼區塊（把選中的來源區塊全部 XOR 起來）。
   * @param {number} seed
   * @returns {Uint8Array} 長度為 blockSize
   */
  encodeBlock(seed) {
    const indices = selectBlocks(seed, this.K);
    const out = new Uint8Array(this.blockSize);
    // 第一個索引直接複製，省下一輪 XOR
    out.set(this.blocks.subarray(indices[0] * this.blockSize, (indices[0] + 1) * this.blockSize));
    for (let n = 1; n < indices.length; n++) {
      const base = indices[n] * this.blockSize;
      for (let i = 0; i < this.blockSize; i++) out[i] ^= this.blocks[base + i];
    }
    return out;
  }

  /**
   * 產生下一個要顯示的封包。
   * @returns {{bytes:Uint8Array, seed:number, isMetadata:boolean, frameIndex:number}}
   */
  nextPacket() {
    const frameIndex = this.frameIndex++;
    const common = {
      sessionId: this.sessionId,
      fileSize: this.fileSize,
      blockSize: this.blockSize,
      K: this.K,
    };

    // --- 每 METADATA_INTERVAL 幀插入一次 metadata（含第 0 幀）---
    if (this.metadataPayload && frameIndex % METADATA_INTERVAL === 0) {
      return {
        bytes: encodePacket({ ...common, seed: 0, payload: this.metadataPayload, flags: FLAG_METADATA }),
        seed: 0,
        isMetadata: true,
        frameIndex,
      };
    }

    // --- 資料幀：先把 K 個系統區塊送完，之後才送隨機編碼區塊 ---
    const n = this.dataFrameIndex++;
    let seed;
    if (n < this.K) {
      seed = n; // 系統區塊：seed 就是區塊索引
    } else {
      // 隨機 seed，但必須 >= K 才不會撞進系統區塊的保留區間
      seed = this.K + Math.floor(this.rng() * (4294967296 - this.K));
    }
    return {
      bytes: encodePacket({ ...common, seed, payload: this.encodeBlock(seed) }),
      seed,
      isMetadata: false,
      frameIndex,
    };
  }
}

/* =========================================================================
 * 9. LTDecoder — 接收端（peeling decoder / belief propagation）
 * =========================================================================
 * 演算法本體其實只有一句話：
 *   「只要手上有一個度數為 1 的編碼區塊，它就等於某個來源區塊；
 *     解出來之後，把它從其他還沒解開的區塊裡 XOR 掉，那些區塊的度數就會下降，
 *     可能又冒出新的度數 1 —— 如此連鎖反應下去。」
 *
 * 資料結構：
 *   solved      已解出的來源區塊（連續存放，最後直接切一段就是檔案）
 *   known[i]    來源區塊 i 是否已解出
 *   pending     還沒解開的編碼區塊：id → { remaining:Set<索引>, data:Uint8Array }
 *   bySource[i] 反向索引：哪些 pending 區塊還參照著來源區塊 i
 *               （有了它，連鎖反應才不用每次掃過全部 pending）
 */
export class LTDecoder {
  /**
   * @param {{sessionId:number, fileSize:number, blockSize:number, K:number}} info
   */
  constructor(info) {
    this.sessionId = info.sessionId;
    this.fileSize = info.fileSize;
    this.blockSize = info.blockSize;
    this.K = info.K;

    this.solved = new Uint8Array(this.K * this.blockSize);
    this.known = new Uint8Array(this.K);
    this.solvedCount = 0;

    this.pending = new Map();
    this.bySource = Array.from({ length: this.K }, () => new Set());
    this.nextPendingId = 1;

    this.seenSeeds = new Set(); // 用來過濾重複幀（同一個 seed 只需處理一次）
    this.metadata = null;       // 收到 metadata 幀後填入

    this.stats = { accepted: 0, duplicate: 0, redundant: 0 };
  }

  /** 是否已經完整還原（所有來源區塊都解出來了） */
  get isComplete() {
    return this.solvedCount >= this.K;
  }

  /** 目前進度 0..1 */
  get progress() {
    return this.solvedCount / this.K;
  }

  /**
   * 餵進一個已經通過 CRC 驗證的封包。
   * @param {ReturnType<typeof decodePacket>} pkt
   * @returns {{accepted:boolean, reason?:string, progressed:number}}
   *          progressed = 這一包讓多少個來源區塊被解出來
   */
  addPacket(pkt) {
    // metadata 幀不參與 LT 解碼，只是把檔名／MIME／SHA-256 記下來
    if (pkt.isMetadata) {
      if (!this.metadata) {
        try {
          this.metadata = JSON.parse(new TextDecoder().decode(pkt.payload));
        } catch {
          return { accepted: false, reason: 'metadata-parse-error', progressed: 0 };
        }
      }
      return { accepted: true, reason: 'metadata', progressed: 0 };
    }

    // 同一個 seed 代表完全相同的編碼區塊，收過就不必再算一次
    if (this.seenSeeds.has(pkt.seed)) {
      this.stats.duplicate++;
      return { accepted: false, reason: 'duplicate', progressed: 0 };
    }
    this.seenSeeds.add(pkt.seed);
    this.stats.accepted++;

    const before = this.solvedCount;
    this.addBlock(selectBlocks(pkt.seed, this.K), pkt.payload);
    const progressed = this.solvedCount - before;
    if (progressed === 0) this.stats.redundant++;
    return { accepted: true, progressed };
  }

  /**
   * 把一個編碼區塊加入解碼器並執行連鎖反應。
   * @param {number[]} indices 這個編碼區塊涵蓋的來源區塊索引
   * @param {Uint8Array} payload 編碼後的內容（長度 = blockSize）
   */
  addBlock(indices, payload) {
    const bs = this.blockSize;
    const data = new Uint8Array(payload); // 複製一份，之後會就地修改

    // --- 化簡：把已知的來源區塊先 XOR 掉 ---
    const remaining = new Set();
    for (const i of indices) {
      if (this.known[i]) {
        const base = i * bs;
        for (let j = 0; j < bs; j++) data[j] ^= this.solved[base + j];
      } else {
        remaining.add(i);
      }
    }

    // 全部都是已知的 → 這包沒帶來新資訊
    if (remaining.size === 0) return;

    // --- 化簡後度數大於 1：先存起來等未來被剝離 ---
    if (remaining.size > 1) {
      const id = this.nextPendingId++;
      this.pending.set(id, { remaining, data });
      for (const i of remaining) this.bySource[i].add(id);
      return;
    }

    // --- 度數為 1：可以直接解出一個來源區塊，啟動連鎖反應 ---
    // queue 裡放「剛解出來、還沒去剝離別人」的來源區塊索引
    const queue = [];
    this.markSolved(remaining.values().next().value, data, queue);

    while (queue.length > 0) {
      const solvedIdx = queue.pop();
      const dependents = this.bySource[solvedIdx];
      this.bySource[solvedIdx] = new Set(); // 這個來源已解出，不必再追蹤
      const base = solvedIdx * bs;

      for (const id of dependents) {
        const entry = this.pending.get(id);
        if (!entry) continue; // 已在別的路徑上被處理掉
        // 把剛解出的來源區塊從這個編碼區塊裡 XOR 掉，度數 -1
        for (let j = 0; j < bs; j++) entry.data[j] ^= this.solved[base + j];
        entry.remaining.delete(solvedIdx);

        if (entry.remaining.size === 1) {
          // 度數降到 1 → 又解出一個來源區塊，加進 queue 繼續連鎖
          const idx = entry.remaining.values().next().value;
          this.pending.delete(id);
          this.bySource[idx].delete(id);
          this.markSolved(idx, entry.data, queue);
        } else if (entry.remaining.size === 0) {
          // 度數降到 0 → 這包已經沒有資訊量，清掉
          this.pending.delete(id);
        }
      }
    }
  }

  /**
   * 記錄一個來源區塊已解出，並排進連鎖反應佇列。
   * @param {number} idx
   * @param {Uint8Array} data
   * @param {number[]} queue
   */
  markSolved(idx, data, queue) {
    if (this.known[idx]) return; // 重複解出，忽略
    this.solved.set(data, idx * this.blockSize);
    this.known[idx] = 1;
    this.solvedCount++;
    queue.push(idx);
  }

  /**
   * 取出還原後的檔案內容（尚未解完時回傳 null）。
   * @returns {Uint8Array|null}
   */
  getFile() {
    if (!this.isComplete) return null;
    // 把最後一塊補的零切掉，還原成原始長度
    return this.solved.subarray(0, this.fileSize);
  }
}
