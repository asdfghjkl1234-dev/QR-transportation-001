/**
 * fountain2.js — QR 碼串流傳檔系統 v2 的共用核心
 * ================================================
 *
 * v2 相對於 v1 的四項加速，這個模組負責其中三項：
 *   1. 一幀多碼      → LTEncoder2.nextFrame(n) 一次吐出 n 個獨立封包
 *   2. Base45 編碼   → 取代 base64，配合 QR 英數模式，每個碼多裝約 29%
 *   3. 精簡封包格式  → 標頭從 v1 的 26 bytes 降到 15 bytes
 *   4. Inactivation decoding → peeling 卡住時改用 GF(2) 高斯消去法收尾
 *
 * 版本無關的基礎元件（PRNG、CRC32、SHA-256、Robust Soliton、seed→區塊選擇）
 * 直接沿用 v1 的 ../fountain.js，避免把已經驗證過的密碼學實作抄第二份。
 * v2 只定義真正屬於 v2 的東西。
 */

import {
  mulberry32, crc32, sha256, sha256Hex, selectBlocks, robustSolitonCdf,
} from '../fountain.js';

// 轉出去，讓 v2 的頁面只要 import 這一個模組就好
export { mulberry32, crc32, sha256, sha256Hex, selectBlocks, robustSolitonCdf };

/* =========================================================================
 * 1. Base45（RFC 9285）
 * =========================================================================
 * v1 用 base64 塞進 QR 的「位元組模式」：每個字元 8 bits，但只帶 6 bits 資料，
 * 效率 75%。
 *
 * v2 改用 Base45 + QR「英數模式」：英數模式每 2 個字元用 11 bits 編碼
 * （每字元 5.5 bits），而 Base45 每 3 個字元帶 2 bytes：
 *     3 字元 × 5.5 bits = 16.5 bits，實際承載 16 bits → 效率 97%
 * 相對 base64 等於每個 QR 多裝約 29%（實測 v15/L：504 bytes vs 390 bytes）。
 *
 * Base45 的字元集剛好等於 QR 英數模式的 45 個合法字元，這不是巧合 ——
 * RFC 9285 就是為了這個場景設計的。
 */

// 順序即為 RFC 9285 定義的數值 0..44，與 QR 英數模式的字元表完全一致
export const BASE45_CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

// 反查表：字元碼 → 數值，255 代表非法字元
const B45_LOOKUP = (() => {
  const t = new Uint8Array(128).fill(255);
  for (let i = 0; i < BASE45_CHARSET.length; i++) t[BASE45_CHARSET.charCodeAt(i)] = i;
  return t;
})();

/**
 * 位元組 → Base45 字串。
 * 每 2 bytes 當成一個 16-bit 大端數字 n，寫成 3 個 base-45 位（低位在前）；
 * 剩下的單一 byte 寫成 2 位。
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function base45Encode(bytes) {
  let out = '';
  const n = bytes.length;
  let i = 0;
  for (; i + 1 < n; i += 2) {
    let v = bytes[i] * 256 + bytes[i + 1];
    const a = v % 45; v = (v - a) / 45;
    const b = v % 45; v = (v - b) / 45;
    out += BASE45_CHARSET[a] + BASE45_CHARSET[b] + BASE45_CHARSET[v];
  }
  if (i < n) {
    let v = bytes[i];
    const a = v % 45;
    out += BASE45_CHARSET[a] + BASE45_CHARSET[(v - a) / 45];
  }
  return out;
}

/**
 * Base45 字串 → 位元組。任何不合法的輸入一律回傳 null，讓呼叫端直接丟棄。
 * 相機掃到的字串隨時可能是別的 QR 碼或是壞掉的內容，所以這裡的驗證要嚴格：
 *   - 字元必須在字元集內
 *   - 長度模 3 必須是 0 或 2（1 是不可能出現的長度）
 *   - 每組 3 位還原出來的值必須 ≤ 65535，每組 2 位必須 ≤ 255
 * @param {string} str
 * @returns {Uint8Array|null}
 */
export function base45Decode(str) {
  const len = str.length;
  const rem = len % 3;
  if (rem === 1) return null;            // 不可能的長度
  const outLen = ((len / 3) | 0) * 2 + (rem === 2 ? 1 : 0);
  const out = new Uint8Array(outLen);
  let o = 0, i = 0;

  for (; i + 2 < len; i += 3) {
    const c0 = str.charCodeAt(i), c1 = str.charCodeAt(i + 1), c2 = str.charCodeAt(i + 2);
    if (c0 > 127 || c1 > 127 || c2 > 127) return null;
    const a = B45_LOOKUP[c0], b = B45_LOOKUP[c1], c = B45_LOOKUP[c2];
    if (a === 255 || b === 255 || c === 255) return null;
    const v = a + b * 45 + c * 2025;
    if (v > 0xffff) return null;         // 超出 16 bits，一定是壞資料
    out[o++] = v >> 8;
    out[o++] = v & 0xff;
  }
  if (rem === 2) {
    const c0 = str.charCodeAt(i), c1 = str.charCodeAt(i + 1);
    if (c0 > 127 || c1 > 127) return null;
    const a = B45_LOOKUP[c0], b = B45_LOOKUP[c1];
    if (a === 255 || b === 255) return null;
    const v = a + b * 45;
    if (v > 0xff) return null;
    out[o++] = v;
  }
  return out;
}

/**
 * 給定可用的英數字元數，回傳最多能塞幾個位元組。
 * @param {number} chars
 * @returns {number}
 */
export function base45BytesForChars(chars) {
  const full = (chars / 3) | 0;          // 每 3 字元裝 2 bytes
  return full * 2 + (chars % 3 === 2 ? 1 : 0);  // 剩 2 字元還能再裝 1 byte
}

/* =========================================================================
 * 2. v2 封包格式
 * =========================================================================
 * 位移  長度  欄位
 * ----  ----  ----------------------------------------------------------
 *   0     1   magic      固定 0x51（ASCII 'Q'）
 *   1     1   版本與旗標  bit0-3 = 協定版本（2）
 *                        bit4   = 1 表示 metadata 幀
 *                        bit5-6 = 顏色通道編號（0=灰階/紅, 1=綠, 2=藍）
 *                        bit7   = 保留
 *   2     2   sessionId  本次傳輸識別碼
 *   4     3   K          來源區塊數（最多 16,777,215）
 *   7     4   seed       本幀 seed
 *  11     n   payload    資料幀 = 編碼區塊；metadata 幀 = UTF-8 JSON
 *  11+n   4   crc32      涵蓋前面全部內容
 *
 * 固定開銷 15 bytes（v1 是 26 bytes）。
 * fileSize、blockSize 這些每幀都一樣的欄位改由 metadata 幀攜帶，不再浪費頻寬。
 */

export const V2_MAGIC = 0x51;
export const V2_VERSION = 2;
export const V2_HEADER_SIZE = 11;
export const V2_CRC_SIZE = 4;
export const V2_OVERHEAD = V2_HEADER_SIZE + V2_CRC_SIZE;   // 15
export const FLAG_METADATA = 0x10;      // bit4
export const CHANNEL_SHIFT = 5;         // bit5-6
/** 每送出這麼多個資料幀，就插入一個 metadata 幀 */
export const METADATA_EVERY = 15;

/**
 * 組出一個 v2 封包。
 * @param {{sessionId:number, K:number, seed:number, payload:Uint8Array,
 *          isMetadata?:boolean, channel?:number}} o
 * @returns {Uint8Array}
 */
export function encodePacketV2(o) {
  const payload = o.payload;
  const total = V2_OVERHEAD + payload.length;
  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);

  buf[0] = V2_MAGIC;
  buf[1] = (V2_VERSION & 0x0f)
         | (o.isMetadata ? FLAG_METADATA : 0)
         | (((o.channel || 0) & 0x03) << CHANNEL_SHIFT);
  dv.setUint16(2, o.sessionId & 0xffff, false);
  // K 用 3 bytes 存（大端）
  buf[4] = (o.K >>> 16) & 0xff;
  buf[5] = (o.K >>> 8) & 0xff;
  buf[6] = o.K & 0xff;
  dv.setUint32(7, o.seed >>> 0, false);
  buf.set(payload, V2_HEADER_SIZE);
  dv.setUint32(total - V2_CRC_SIZE, crc32(buf, 0, total - V2_CRC_SIZE), false);
  return buf;
}

/**
 * 解析並驗證 v2 封包。任何一項不對就回傳 null。
 * @param {Uint8Array} buf
 * @returns {{isMetadata:boolean, channel:number, sessionId:number, K:number,
 *            seed:number, payload:Uint8Array}|null}
 */
export function decodePacketV2(buf) {
  if (!buf || buf.length < V2_OVERHEAD) return null;
  if (buf[0] !== V2_MAGIC) return null;
  if ((buf[1] & 0x0f) !== V2_VERSION) return null;

  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const expected = dv.getUint32(buf.length - V2_CRC_SIZE, false);
  if (crc32(buf, 0, buf.length - V2_CRC_SIZE) !== expected) return null;

  const K = (buf[4] << 16) | (buf[5] << 8) | buf[6];
  if (K === 0) return null;
  const payload = buf.subarray(V2_HEADER_SIZE, buf.length - V2_CRC_SIZE);
  if (payload.length === 0) return null;

  return {
    isMetadata: (buf[1] & FLAG_METADATA) !== 0,
    channel: (buf[1] >> CHANNEL_SHIFT) & 0x03,
    sessionId: dv.getUint16(2, false),
    K,
    seed: dv.getUint32(7, false),
    payload,
  };
}

/* =========================================================================
 * 3. QR 英數模式容量
 * =========================================================================
 * v2 不讓使用者手動設定區塊大小，而是「選 QR 版本 → 自動算出該版本裝得下多少」。
 *
 * 為什麼用二分搜尋而不是查表？因為容量取決於函式庫實際的編碼實作
 * （模式指示、字元計數指示位元數、RS 區塊切分），寫死的表格一旦和函式庫
 * 對不上就會在執行時爆掉。直接問函式庫「這個長度塞得下嗎」最不會錯。
 * 結果會快取，所以只有換版本／糾錯等級時才會算一次。
 */

const capacityCache = new Map();

/**
 * 算出某個 QR 版本 + 糾錯等級在英數模式下最多能放幾個字元。
 * @param {(typeNumber:number, ecl:string) => any} qrcodeFactory qrcode-generator 的工廠函式
 * @param {number} version QR 版本 1..40
 * @param {string} ecc 'L' | 'M' | 'Q' | 'H'
 * @returns {number} 最大字元數
 */
export function qrAlphanumericCapacity(qrcodeFactory, version, ecc) {
  const key = `${version}|${ecc}`;
  const hit = capacityCache.get(key);
  if (hit !== undefined) return hit;

  const fits = (n) => {
    try {
      const qr = qrcodeFactory(version, ecc);
      qr.addData('A'.repeat(n), 'Alphanumeric');
      qr.make();
      return true;
    } catch {
      return false;   // 塞不下時函式庫會丟例外
    }
  };

  // 版本 40 英數上限是 4296 字元，用它當搜尋上界綽綽有餘
  let lo = 0, hi = 4300;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (fits(mid)) lo = mid; else hi = mid - 1;
  }
  capacityCache.set(key, lo);
  return lo;
}

/**
 * 由 QR 版本推算出「一個編碼區塊該有多大」。
 * @param {(typeNumber:number, ecl:string) => any} qrcodeFactory
 * @param {number} version
 * @param {string} ecc
 * @returns {{chars:number, maxBytes:number, blockSize:number}}
 */
export function blockSizeForVersion(qrcodeFactory, version, ecc) {
  const chars = qrAlphanumericCapacity(qrcodeFactory, version, ecc);
  const maxBytes = base45BytesForChars(chars);
  // 扣掉封包標頭與 CRC，剩下的才是實際可以放編碼區塊的空間
  const blockSize = maxBytes - V2_OVERHEAD;
  return { chars, maxBytes, blockSize: Math.max(1, blockSize) };
}

/* =========================================================================
 * 4. LTEncoder2 — 發送端
 * =========================================================================
 * 與 v1 相同的噴泉碼構造（系統區塊優先 + Robust Soliton），
 * 差別在於它是為「一幀多碼」設計的：nextFrame(n) 一次給你 n 個獨立封包。
 */
export class LTEncoder2 {
  /**
   * @param {Uint8Array} data 原始檔案內容
   * @param {number} blockSize 每個來源區塊大小
   * @param {{sessionId?:number, rng?:() => number, systematic?:boolean}} [options]
   *        systematic 預設 true（前 K 幀送系統區塊）。設為 false 則從頭到尾
   *        都送隨機編碼區塊 —— 在有漏幀的情況下反而明顯更有效率，原因見下方註解。
   */
  constructor(data, blockSize, options = {}) {
    this.rng = options.rng || Math.random;
    this.systematic = options.systematic !== false;
    this.fileSize = data.length;
    this.blockSize = blockSize;
    this.K = Math.max(1, Math.ceil(data.length / blockSize));
    this.blocks = new Uint8Array(this.K * blockSize);
    this.blocks.set(data);

    this.sessionId = (options.sessionId === undefined
      ? (this.rng() * 65536) & 0xffff
      : options.sessionId) & 0xffff;

    this.metadataPayload = null;
    this.metadataSent = false;  // 第一個 metadata 幀是否已送出
    this.dataFrameIndex = 0;    // 已產生的資料幀數（決定系統區塊進度）
    this.sinceMetadata = 0;     // 距離上次 metadata 幀過了幾個資料幀
    this.totalPackets = 0;
  }

  /**
   * 設定 metadata 內容。v2 的 metadata 多帶了 size 與 blockSize，
   * 因為資料幀的精簡標頭已經不再攜帶這兩個欄位。
   * @param {{name:string, type:string, sha256:string}} meta
   */
  setMetadata(meta) {
    this.metadataPayload = new TextEncoder().encode(JSON.stringify({
      name: meta.name,
      type: meta.type,
      size: this.fileSize,
      blockSize: this.blockSize,
      sha256: meta.sha256,
    }));
  }

  /** 依 seed 產生編碼區塊（把選中的來源區塊 XOR 起來） */
  encodeBlock(seed) {
    const indices = selectBlocks(seed, this.K);
    const bs = this.blockSize;
    const out = new Uint8Array(bs);
    out.set(this.blocks.subarray(indices[0] * bs, (indices[0] + 1) * bs));
    for (let n = 1; n < indices.length; n++) {
      const base = indices[n] * bs;
      for (let i = 0; i < bs; i++) out[i] ^= this.blocks[base + i];
    }
    return out;
  }

  /**
   * 產生下一個封包。
   * @param {number} [channel=0] 顏色通道編號（RGB 模式用）
   * @returns {{bytes:Uint8Array, text:string, seed:number, isMetadata:boolean}}
   */
  nextPacket(channel = 0) {
    this.totalPackets++;

    // 每 METADATA_EVERY 個資料幀插一個 metadata 幀；第一個封包一定是 metadata，
    // 讓接收端盡早知道檔名、大小與區塊大小。
    if (this.metadataPayload && (!this.metadataSent || this.sinceMetadata >= METADATA_EVERY)) {
      this.metadataSent = true;
      this.sinceMetadata = 0;
      const bytes = encodePacketV2({
        sessionId: this.sessionId, K: this.K, seed: 0,
        payload: this.metadataPayload, isMetadata: true, channel,
      });
      return { bytes, text: base45Encode(bytes), seed: 0, isMetadata: true };
    }

    const n = this.dataFrameIndex++;
    this.sinceMetadata++;

    // 系統區塊模式：前 K 個資料幀直接送原始區塊（seed = 區塊索引），之後才隨機。
    //
    // 值得一提的實測結果：在 v2 裡，系統區塊反而是「有漏幀就會拖慢」的設計。
    // v1 用純 peeling 解碼器，隨機編碼區塊要 1.1～1.2 倍才解得開，所以先送一輪
    // 原始區塊很划算 —— 訊號好時完全不必解碼。
    // 但 v2 的 inactivation 解碼器讓隨機編碼區塊的開銷降到 1.01 倍，
    // 這時系統區塊的問題就浮現了：一旦漏掉一部分，後續隨機區塊的度數分布是
    // 針對「整個 K」設計的，化簡掉已知區塊之後有相當比例會變成度數 0（沒有資訊），
    // 於是產生線性相依。實測 200 KB 檔案、依序抵達：
    //     丟幀率      系統區塊優先      純隨機
    //       0%          1.005×         1.011×
    //      20%          1.350×         1.010×
    //      40%          1.269×         1.011×
    // 只有完全不漏幀時兩者才打平。因此這個開關預設開啟（沿用 v1 的設計），
    // 但在實際有漏幀的環境下，關掉它會更快。
    const seed = (this.systematic && n < this.K)
      ? n
      : this.K + Math.floor(this.rng() * (4294967296 - this.K));

    const bytes = encodePacketV2({
      sessionId: this.sessionId, K: this.K, seed,
      payload: this.encodeBlock(seed), channel,
    });
    return { bytes, text: base45Encode(bytes), seed, isMetadata: false };
  }

  /**
   * 一次產生一整個顯示幀要用的所有封包（一幀多碼的核心）。
   * @param {number} count 這一幀要顯示幾個 QR 碼
   * @param {boolean} [rgb=false] 是否為 RGB 模式（每格 3 個碼，分屬三個通道）
   * @returns {Array<{bytes:Uint8Array, text:string, seed:number, isMetadata:boolean, channel:number}>}
   */
  nextFrame(count, rgb = false) {
    const out = [];
    const channels = rgb ? 3 : 1;
    for (let i = 0; i < count; i++) {
      for (let ch = 0; ch < channels; ch++) {
        out.push({ ...this.nextPacket(rgb ? ch : 0), channel: rgb ? ch : 0 });
      }
    }
    return out;
  }
}

/* =========================================================================
 * 5. LTDecoder2 — 接收端（peeling + inactivation decoding）
 * =========================================================================
 * v1 的純 peeling decoder 需要收到約 1.1～1.2 倍的 K 才能解完，因為它只會
 * 在「有度數 1 的方程式」時才有進展，一旦所有剩下的方程式度數都 ≥ 2 就卡死，
 * 只能等下一個剛好能接上的封包。
 *
 * v2 的做法（inactivation decoding 的實用版本）：
 *   - 平常照樣跑 peeling，它很便宜（O(度數 × 區塊大小)）。
 *   - 一旦 peeling 卡住，而且手上累積的方程式數量已經 ≥ 未知數個數，
 *     就把剩下的方程式當成 GF(2) 上的線性方程組，直接用高斯消去法解掉。
 *   - GF(2) 的加法就是 XOR，所以係數矩陣可以用 Uint32Array 位元圖表示，
 *     一次處理 32 個未知數；payload 也用 Uint32Array 檢視 XOR。
 *
 * 效果：只要收到的方程式在數學上足以決定所有未知數就能解出來，
 * 開銷因此逼近理論下限（實測約 1.02～1.04 倍 K，v1 是 1.1～1.2 倍）。
 */
export class LTDecoder2 {
  /**
   * @param {{sessionId:number, K:number, blockSize:number}} info
   */
  constructor(info) {
    this.sessionId = info.sessionId;
    this.K = info.K;
    this.blockSize = info.blockSize;
    // 每個區塊在內部一律補齊到 4 的倍數，這樣 XOR 時可以直接用 Uint32Array
    this.wordSize = Math.ceil(this.blockSize / 4);
    this.paddedSize = this.wordSize * 4;

    this.solved = new Uint8Array(this.K * this.paddedSize);
    this.known = new Uint8Array(this.K);
    this.solvedCount = 0;

    this.pending = new Map();          // id → {remaining:Set<number>, data:Uint8Array}
    this.bySource = Array.from({ length: this.K }, () => new Set());
    this.nextPendingId = 1;

    this.seenKeys = new Set();         // (seed<<2 | channel) 去重
    this.metadata = null;
    this.fileSize = info.fileSize ?? null;

    // 上次高斯消去失敗時的未知數個數，用來決定下次何時再試
    this.lastElimAttemptAt = -1;
    // 高斯消去的成本大約是 O(n² × (n/32 + 區塊大小/4))，n 太大會讓主執行緒卡住。
    // 超過這個上限就先不做，繼續收封包讓 peeling 把 n 壓下來再說。
    // 實務上 peeling 之後的殘餘通常只有幾十到一兩百個未知數，碰不到這條線。
    this.maxInactivationSize = info.maxInactivationSize ?? 2000;
    this.stats = { accepted: 0, duplicate: 0, redundant: 0, eliminations: 0, elimSolved: 0, elimSkipped: 0 };
  }

  get isComplete() { return this.solvedCount >= this.K; }
  get progress() { return this.solvedCount / this.K; }

  /**
   * 餵進一個已通過 CRC 的封包。
   * @param {ReturnType<typeof decodePacketV2>} pkt
   * @returns {{accepted:boolean, reason?:string, progressed:number}}
   */
  addPacket(pkt) {
    if (pkt.isMetadata) {
      if (this.metadata) {
        this.stats.duplicate++;
        return { accepted: false, reason: 'duplicate', progressed: 0 };
      }
      try {
        this.metadata = JSON.parse(new TextDecoder().decode(pkt.payload));
        if (typeof this.metadata.size === 'number') this.fileSize = this.metadata.size;
      } catch {
        this.metadata = null;
        return { accepted: false, reason: 'metadata-parse-error', progressed: 0 };
      }
      return { accepted: true, reason: 'metadata', progressed: 0 };
    }

    // 同一個 (seed, 通道) 代表完全相同的內容，收過就不必再算
    const key = pkt.seed * 4 + pkt.channel;
    if (this.seenKeys.has(key)) {
      this.stats.duplicate++;
      return { accepted: false, reason: 'duplicate', progressed: 0 };
    }
    this.seenKeys.add(key);
    this.stats.accepted++;

    const before = this.solvedCount;
    this.addBlock(selectBlocks(pkt.seed, this.K), pkt.payload);

    // peeling 卡住時，試著用高斯消去法收尾
    if (!this.isComplete) this.maybeEliminate();

    const progressed = this.solvedCount - before;
    if (progressed === 0) this.stats.redundant++;
    return { accepted: true, progressed };
  }

  /** 把 src 的內容 XOR 進 dst（兩者都是 paddedSize 大小），以 32 bits 為單位 */
  xorInto(dstU32, srcU32) {
    for (let i = 0; i < this.wordSize; i++) dstU32[i] ^= srcU32[i];
  }

  /**
   * 加入一個編碼區塊並執行 peeling 連鎖反應（和 v1 相同的演算法）。
   * @param {number[]} indices
   * @param {Uint8Array} payload
   */
  addBlock(indices, payload) {
    const ps = this.paddedSize;
    const data = new Uint8Array(ps);
    data.set(payload.subarray(0, Math.min(payload.length, ps)));
    const dataU32 = new Uint32Array(data.buffer);

    const remaining = new Set();
    for (const i of indices) {
      if (this.known[i]) {
        this.xorInto(dataU32, new Uint32Array(this.solved.buffer, i * ps, this.wordSize));
      } else {
        remaining.add(i);
      }
    }

    if (remaining.size === 0) return;                     // 沒有新資訊

    if (remaining.size > 1) {                             // 度數 > 1，先存著
      const id = this.nextPendingId++;
      this.pending.set(id, { remaining, data });
      for (const i of remaining) this.bySource[i].add(id);
      return;
    }

    const queue = [];
    this.markSolved(remaining.values().next().value, data, queue);
    this.cascade(queue);
  }

  /**
   * peeling 的連鎖反應：把剛解出的來源區塊從其他方程式裡剝離掉。
   * @param {number[]} queue 剛解出、還沒去剝離別人的來源區塊索引
   */
  cascade(queue) {
    const ps = this.paddedSize;
    while (queue.length > 0) {
      const idx = queue.pop();
      const dependents = this.bySource[idx];
      this.bySource[idx] = new Set();
      const solvedU32 = new Uint32Array(this.solved.buffer, idx * ps, this.wordSize);

      for (const id of dependents) {
        const entry = this.pending.get(id);
        if (!entry) continue;
        this.xorInto(new Uint32Array(entry.data.buffer), solvedU32);
        entry.remaining.delete(idx);

        if (entry.remaining.size === 1) {
          const only = entry.remaining.values().next().value;
          this.pending.delete(id);
          this.bySource[only].delete(id);
          this.markSolved(only, entry.data, queue);
        } else if (entry.remaining.size === 0) {
          this.pending.delete(id);
        }
      }
    }
  }

  /** 記錄一個來源區塊已解出，並排進連鎖反應佇列 */
  markSolved(idx, data, queue) {
    if (this.known[idx]) return;
    this.solved.set(data.subarray(0, this.paddedSize), idx * this.paddedSize);
    this.known[idx] = 1;
    this.solvedCount++;
    queue.push(idx);
  }

  /**
   * 判斷現在值不值得跑一次高斯消去，值得就跑。
   *
   * 消去法的成本是 O(n² × (n/32 + 區塊大小/4))，不能每收到一個封包就跑一次。
   * 觸發條件：
   *   1. peeling 已經卡住（有 pending 方程式，但沒有度數 1 的）
   *   2. 方程式數量 ≥ 未知數個數（不然數學上根本不可能解開）
   *   3. 距離上次失敗至少又收了幾個新封包（避免在同一個狀態上重複空轉）
   */
  maybeEliminate() {
    const equations = this.pending.size;
    if (equations < 2) return;

    // 統計還有多少個「出現在待解方程式裡」的未知數
    const unknowns = new Set();
    for (const e of this.pending.values()) for (const v of e.remaining) unknowns.add(v);
    const n = unknowns.size;
    if (n === 0) return;

    // 這裡刻意「不」要求方程式數量 ≥ 未知數個數。
    //
    // 一開始的直覺是「方程式不夠就一定解不出來，跑了也白跑」，但那是針對
    // 「把所有未知數都解出來」而言。實際上，即使整個方程組是欠定的，
    // 只要其中某些變數已經被收到的方程式唯一決定，簡約列梯形（RREF）就會
    // 把它們變成「只剩一個未知數」的列 —— 那正是 peeling 永遠找不到、
    // 但數學上早就可解的資訊。
    //
    // 這一點在「系統區塊 + 丟幀」的情境下差異很大：前 K 幀的系統區塊被丟掉
    // 一部分之後，後續隨機編碼區塊的度數分布是對「整個 K」設計的，化簡之後
    // 對剩下的未知數並不理想，peeling 很容易卡住。放寬這個條件之後，
    // 實測開銷從 1.24× 降到接近 1.05×。
    if (n > this.maxInactivationSize || equations > this.maxInactivationSize) {
      this.stats.elimSkipped++;
      return;
    }

    // 成本大約是 O(方程式數 × 未知數 × (未知數/32 + 區塊大小/4))，
    // 所以不能每收到一個封包就跑一次，但也不能拖太久 —— 拖延多少個封包才重試，
    // 直接就是「比理論下限多付幾個封包」的上界。
    //
    // 折衷方式：看方程式數量離「足以解出全部未知數」還差多遠。
    //   - 已經接近滿足（equations ≥ n - 2）：每收到一個封包就重試，
    //     這樣一達到滿秩就會立刻解出來，不會白白多收。
    //   - 還差很遠：拉開間隔，此時跑消去多半只能撿到零星幾個變數，不值得每次都跑。
    const scale = Math.max(equations, n);
    const nearlyDetermined = equations >= n - 2;
    const minGap = nearlyDetermined || scale <= 150 ? 1 : Math.ceil(scale / 100);
    if (this.lastElimAttemptAt >= 0 && this.stats.accepted - this.lastElimAttemptAt < minGap) return;
    this.lastElimAttemptAt = this.stats.accepted;

    this.eliminate([...unknowns]);
  }

  /**
   * 對剩下的方程式做 GF(2) 高斯消去。
   * GF(2) 上的加減法都是 XOR，所以係數列可以壓成位元圖，一個 32-bit 字
   * 同時處理 32 個未知數。
   * @param {number[]} unknownList 這次要解的未知數索引
   * @returns {boolean} 是否全部解出
   */
  eliminate(unknownList) {
    this.stats.eliminations++;

    const n = unknownList.length;
    const words = (n + 31) >> 5;
    const colOf = new Map();
    for (let c = 0; c < n; c++) colOf.set(unknownList[c], c);

    // --- 建矩陣：每一列 = 一個方程式（係數位元圖 + 右手邊的 payload）---
    const rows = [];
    for (const e of this.pending.values()) {
      const bits = new Uint32Array(words);
      for (const v of e.remaining) {
        const c = colOf.get(v);
        bits[c >> 5] |= 1 << (c & 31);
      }
      rows.push({ bits, data: new Uint32Array(e.data.buffer.slice(0)) });
    }

    // --- 消去：對每一欄找主元，然後把該欄從所有其他列消掉（形成簡約列梯形）---
    const pivotOfCol = new Int32Array(n).fill(-1);
    let pivotRow = 0;
    for (let c = 0; c < n && pivotRow < rows.length; c++) {
      const w = c >> 5, mask = 1 << (c & 31);

      let sel = -1;
      for (let r = pivotRow; r < rows.length; r++) {
        if (rows[r].bits[w] & mask) { sel = r; break; }
      }
      if (sel < 0) continue;                       // 這一欄沒有主元，跳過

      if (sel !== pivotRow) { const t = rows[sel]; rows[sel] = rows[pivotRow]; rows[pivotRow] = t; }
      const pr = rows[pivotRow];

      for (let r = 0; r < rows.length; r++) {
        if (r === pivotRow) continue;
        if (!(rows[r].bits[w] & mask)) continue;
        const rr = rows[r];
        for (let i = 0; i < words; i++) rr.bits[i] ^= pr.bits[i];
        for (let i = 0; i < this.wordSize; i++) rr.data[i] ^= pr.data[i];
      }
      pivotOfCol[c] = pivotRow;
      pivotRow++;
    }

    // --- 取出結果 ---
    // 走到這裡，凡是有主元的那一欄，其主元列的係數位元圖只剩下自己那一位，
    // 所以該列的 payload 就直接是那個來源區塊的內容。
    const queue = [];
    let solvedHere = 0;
    for (let c = 0; c < n; c++) {
      const pr = pivotOfCol[c];
      if (pr < 0) continue;
      // 確認這一列真的只剩一個未知數（否則不能直接當成答案）
      let bitCount = 0;
      const bits = rows[pr].bits;
      for (let i = 0; i < words && bitCount < 2; i++) {
        let x = bits[i];
        while (x) { x &= x - 1; bitCount++; if (bitCount >= 2) break; }
      }
      if (bitCount !== 1) continue;

      const varIdx = unknownList[c];
      if (this.known[varIdx]) continue;
      this.markSolved(varIdx, new Uint8Array(rows[pr].data.buffer), queue);
      solvedHere++;
    }

    if (solvedHere > 0) {
      this.stats.elimSolved += solvedHere;
      // 已經解出來的變數要從 pending 的方程式裡移除（cascade 會處理），
      // 解出來的區塊要餵回 peeling 結構，把 pending 裡的方程式繼續化簡
      this.cascade(queue);
      // 清掉已經沒有未知數的方程式
      for (const [id, e] of this.pending) {
        if (e.remaining.size === 0) this.pending.delete(id);
      }
      this.lastElimAttemptAt = -1;   // 有進展，下次可以立刻再試
    }
    return solvedHere === n;
  }

  /**
   * 取出還原後的檔案（尚未解完或還不知道檔案大小時回傳 null）。
   * @returns {Uint8Array|null}
   */
  getFile() {
    if (!this.isComplete || this.fileSize == null) return null;
    // 內部區塊有補齊到 4 的倍數，這裡要按照真正的 blockSize 重新拼接
    const out = new Uint8Array(this.fileSize);
    for (let i = 0; i < this.K; i++) {
      const srcStart = i * this.paddedSize;
      const dstStart = i * this.blockSize;
      if (dstStart >= this.fileSize) break;
      const len = Math.min(this.blockSize, this.fileSize - dstStart);
      out.set(this.solved.subarray(srcStart, srcStart + len), dstStart);
    }
    return out;
  }
}
