/**
 * ecc.js — GF(256) 上的 Reed-Solomon 編解碼（支援抹除 erasure）
 * ==============================================================
 *
 * 為什麼自己實作：npm 上找不到「仍在維護、能在瀏覽器跑、而且支援抹除解碼」
 * 的 RS 函式庫。
 *   - reed-solomon@4.0.0  已於 2017 標記 deprecated
 *   - @ronomon/reed-solomon  是 Node 原生外掛，瀏覽器不能用，
 *     而且它做的是 Cauchy 式的抹除編碼，不是我們要的 BCH 觀點 RS
 *   - reedsolomon@1.0.0（2015）、rs-wasm（2020）都已停止維護
 * 所以這裡自己實作，並在 test.node.mjs 裡附完整單元測試。
 *
 * 為什麼「抹除」對這個系統特別重要：
 *   RS 能修正 nsym 個校驗符號所提供的能力，但代價不同 ——
 *       未知位置的錯誤（error）：每個要花 2 個校驗符號
 *       已知位置的錯誤（erasure）：每個只要花 1 個
 *   接收端在分類格子顏色時，會算出一個信心度；信心度低的格子雖然猜了一個顏色，
 *   但我們「知道它很可能是錯的」。把這些位置標記成 erasure 交給 RS，
 *   等於讓錯誤更正能力直接翻倍。這是彩色矩陣碼能壓到很小格子的關鍵。
 *
 * 演算法是標準組合：
 *   編碼   多項式除法求餘式
 *   解碼   症狀（syndrome）→ Berlekamp-Massey 求錯誤位置多項式
 *          → Chien search 找根 → Forney 演算法求錯誤值
 *
 * 本檔沒有任何相依，瀏覽器與 Node 皆可直接使用。
 */

/* =========================================================================
 * GF(256) 有限體
 * =========================================================================
 * 使用本原多項式 0x11d（x^8 + x^4 + x^3 + x^2 + 1），與 QR / DVD / 多數 RS
 * 應用一致；生成元取 2。
 *
 * 乘法用「取對數 → 相加 → 取指數」的查表法：
 *   a·b = exp(log a + log b)
 * exp 表刻意做成 512 長度並重複一次，這樣 log a + log b（最大 254+254=508）
 * 可以直接查表，不必先做模 255，省下每次乘法的一個除法。
 */
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

(function initTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;   // 超過 8 bits 就模掉本原多項式
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

/** GF(256) 乘法 */
export function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/** GF(256) 除法 */
export function gfDiv(a, b) {
  if (b === 0) throw new Error('GF(256) 除以零');
  if (a === 0) return 0;
  return GF_EXP[(GF_LOG[a] + 255 - GF_LOG[b]) % 255];
}

/** GF(256) 次方 a^n（n 可為負） */
export function gfPow(a, n) {
  if (a === 0) return 0;
  return GF_EXP[(((GF_LOG[a] * n) % 255) + 255) % 255];
}

/** GF(256) 乘法反元素 */
export function gfInverse(a) {
  if (a === 0) throw new Error('0 沒有乘法反元素');
  return GF_EXP[255 - GF_LOG[a]];
}

/* =========================================================================
 * GF(256) 上的多項式運算
 * =========================================================================
 * 一律採「最高次項在前」的表示法：[a2, a1, a0] 代表 a2·x² + a1·x + a0。
 */

/** 多項式乘上一個純量 */
function polyScale(p, s) {
  const out = new Uint8Array(p.length);
  for (let i = 0; i < p.length; i++) out[i] = gfMul(p[i], s);
  return out;
}

/** 多項式相加（GF(2^k) 上加法就是 XOR，所以加法與減法相同） */
function polyAdd(p, q) {
  const out = new Uint8Array(Math.max(p.length, q.length));
  for (let i = 0; i < p.length; i++) out[i + out.length - p.length] ^= p[i];
  for (let i = 0; i < q.length; i++) out[i + out.length - q.length] ^= q[i];
  return out;
}

/** 多項式相乘 */
function polyMul(p, q) {
  const out = new Uint8Array(p.length + q.length - 1);
  // 先把 q 的每一項取對數，避免內層迴圈重複查表
  for (let j = 0; j < q.length; j++) {
    if (q[j] === 0) continue;
    const lq = GF_LOG[q[j]];
    for (let i = 0; i < p.length; i++) {
      if (p[i] === 0) continue;
      out[i + j] ^= GF_EXP[GF_LOG[p[i]] + lq];
    }
  }
  return out;
}

/** 用 Horner 法求多項式在 x 的值 */
function polyEval(p, x) {
  let y = p[0];
  for (let i = 1; i < p.length; i++) y = gfMul(y, x) ^ p[i];
  return y;
}

/* =========================================================================
 * Reed-Solomon 編碼
 * ========================================================================= */

// 生成多項式對同一個 nsym 都一樣，算一次就快取
const generatorCache = new Map();

/**
 * 產生 RS 的生成多項式 g(x) = (x-α⁰)(x-α¹)…(x-α^(nsym-1))
 * @param {number} nsym 校驗符號數
 * @returns {Uint8Array}
 */
export function rsGeneratorPoly(nsym) {
  const hit = generatorCache.get(nsym);
  if (hit) return hit;
  let g = new Uint8Array([1]);
  for (let i = 0; i < nsym; i++) {
    g = polyMul(g, new Uint8Array([1, GF_EXP[i]]));
  }
  generatorCache.set(nsym, g);
  return g;
}

/**
 * 編碼：在訊息後面附加 nsym 個校驗符號。
 * 做法就是求 msg·x^nsym 除以 g(x) 的餘式。
 * @param {Uint8Array} msg 訊息（長度 + nsym 必須 ≤ 255）
 * @param {number} nsym 校驗符號數
 * @returns {Uint8Array} 長度為 msg.length + nsym 的碼字
 */
export function rsEncode(msg, nsym) {
  if (msg.length + nsym > 255) {
    throw new Error(`RS 碼字長度不能超過 255（訊息 ${msg.length} + 校驗 ${nsym}）`);
  }
  const gen = rsGeneratorPoly(nsym);
  const out = new Uint8Array(msg.length + nsym);
  out.set(msg);

  // 合成除法：逐項把當前最高次係數消掉
  for (let i = 0; i < msg.length; i++) {
    const coef = out[i];
    if (coef === 0) continue;
    const lc = GF_LOG[coef];
    // gen[0] 恆為 1，所以從 j=1 開始即可
    for (let j = 1; j < gen.length; j++) {
      out[i + j] ^= GF_EXP[GF_LOG[gen[j]] + lc];
    }
  }
  out.set(msg);   // 前段被除法過程改寫過，這裡復原成原始訊息
  return out;
}

/* =========================================================================
 * Reed-Solomon 解碼
 * ========================================================================= */

/**
 * 計算症狀多項式。若碼字完全正確，所有症狀都會是 0。
 * 回傳陣列刻意在最前面補一個 0，讓後續多項式運算的次數對齊。
 */
function rsCalcSyndromes(msg, nsym) {
  const synd = new Uint8Array(nsym + 1);
  for (let i = 0; i < nsym; i++) synd[i + 1] = polyEval(msg, GF_EXP[i]);
  return synd;
}

/**
 * 由已知的錯誤位置建立「錯誤位置多項式」。
 * @param {number[]} positions 以碼字尾端為 0 的座標
 */
function rsFindErrataLocator(positions) {
  let errLoc = new Uint8Array([1]);
  for (const p of positions) {
    errLoc = polyMul(errLoc, polyAdd(new Uint8Array([1]), new Uint8Array([GF_EXP[p], 0])));
  }
  return errLoc;
}

/** 由症狀與錯誤位置多項式求錯誤評估多項式 Ω(x) = Σ(x)·Λ(x) mod x^(nsym+1) */
function rsFindErrorEvaluator(synd, errLoc, nsym) {
  const mul = polyMul(synd, errLoc);
  return mul.slice(mul.length - (nsym + 1));
}

/**
 * Forney 症狀：把「已知的抹除位置」先折進症狀裡，
 * 之後 Berlekamp-Massey 就只需要去找剩下的「未知位置錯誤」。
 *
 * 這是抹除解碼能讓更正能力翻倍的關鍵一步：抹除的位置我們本來就知道，
 * 不需要浪費校驗能力去「尋找」它們，只需要算出要修正多少。
 *
 * @param {Uint8Array} synd 原始症狀（第 0 項是補的 0）
 * @param {number[]} pos 抹除位置
 * @param {number} nmess 碼字長度
 */
function rsForneySyndromes(synd, pos, nmess) {
  const fsynd = Array.from(synd.slice(1));
  for (let i = 0; i < pos.length; i++) {
    const x = gfPow(2, nmess - 1 - pos[i]);
    for (let j = 0; j < fsynd.length - 1; j++) {
      fsynd[j] = gfMul(fsynd[j], x) ^ fsynd[j + 1];
    }
  }
  return Uint8Array.from(fsynd);
}

/**
 * Berlekamp-Massey：從症狀反推出錯誤位置多項式 Λ(x)。
 * 這是整個解碼流程裡唯一「找出未知錯誤位置」的步驟。
 *
 * @param {Uint8Array} synd 症狀（若有抹除，這裡要傳 Forney 症狀）
 * @param {number} nsym 校驗符號數
 * @param {number} [eraseCount=0] 已知抹除個數
 * @returns {Uint8Array|null} 超出更正能力時回傳 null
 */
function rsFindErrorLocator(synd, nsym, eraseCount = 0) {
  let errLoc = [1];
  let oldLoc = [1];

  const syndShift = synd.length > nsym ? synd.length - nsym : 0;

  // 每個抹除已經佔掉一個校驗符號，所以只需再迭代 nsym - eraseCount 次
  for (let i = 0; i < nsym - eraseCount; i++) {
    const K = i + syndShift;

    // 差異值 delta
    let delta = synd[K];
    for (let j = 1; j < errLoc.length; j++) {
      delta ^= gfMul(errLoc[errLoc.length - 1 - j], synd[K - j]);
    }

    oldLoc = [...oldLoc, 0];    // 乘上 x

    if (delta !== 0) {
      if (oldLoc.length > errLoc.length) {
        const newLoc = Array.from(polyScale(Uint8Array.from(oldLoc), delta));
        oldLoc = Array.from(polyScale(Uint8Array.from(errLoc), gfInverse(delta)));
        errLoc = newLoc;
      }
      errLoc = Array.from(polyAdd(
        Uint8Array.from(errLoc),
        polyScale(Uint8Array.from(oldLoc), delta),
      ));
    }
  }

  while (errLoc.length && errLoc[0] === 0) errLoc.shift();

  const errs = errLoc.length - 1;
  // 超出更正能力：2×未知錯誤 + 抹除 > nsym
  if ((errs - eraseCount) * 2 + eraseCount > nsym) return null;
  return Uint8Array.from(errLoc);
}

/**
 * Chien search：把每個可能的位置代進 Λ(x)，找出它的根。
 * @param {Uint8Array} errLoc 已反轉為「低次在前」的錯誤位置多項式
 * @returns {number[]|null} 錯誤位置（以碼字開頭為 0 的座標）
 */
function rsFindErrors(errLoc, nmess) {
  const errs = errLoc.length - 1;
  const positions = [];
  for (let i = 0; i < nmess; i++) {
    if (polyEval(errLoc, gfPow(2, i)) === 0) positions.push(nmess - 1 - i);
  }
  // 找到的根數量必須剛好等於多項式次數，否則代表資料損毀太嚴重、結果不可信
  if (positions.length !== errs) return null;
  return positions;
}

/**
 * Forney 演算法：已知錯誤位置後，算出每個位置該修正的數值。
 * @param {Uint8Array} msg 收到的碼字
 * @param {Uint8Array} synd 原始症狀
 * @param {number[]} positions 所有要修正的位置（抹除 + 找出來的錯誤）
 */
function rsCorrectErrata(msg, synd, positions) {
  const nmess = msg.length;
  // 換成多項式係數座標（最高次在前）
  const coefPos = positions.map((p) => nmess - 1 - p);
  const errLoc = rsFindErrataLocator(coefPos);

  // Ω(x)：注意這裡的兩次反轉，是為了配合「最高次在前」的表示法
  const reversedSynd = Uint8Array.from(synd).reverse();
  const errEval = Uint8Array.from(
    rsFindErrorEvaluator(reversedSynd, errLoc, errLoc.length - 1),
  ).reverse();

  // X[i]：每個錯誤位置對應的 α 次方
  const X = coefPos.map((p) => gfPow(2, p - 255));

  const E = new Uint8Array(nmess);
  for (let i = 0; i < X.length; i++) {
    const XiInv = gfInverse(X[i]);

    // Λ'(X_i⁻¹) 的形式微分，用「除掉自己那一項」的連乘來算
    let errLocPrime = 1;
    for (let j = 0; j < X.length; j++) {
      if (j === i) continue;
      errLocPrime = gfMul(errLocPrime, 1 ^ gfMul(XiInv, X[j]));
    }
    if (errLocPrime === 0) return null;   // 位置重複，無法求解

    let y = polyEval(Uint8Array.from(errEval).reverse(), XiInv);
    y = gfMul(gfPow(X[i], 1), y);
    E[positions[i]] = gfDiv(y, errLocPrime);
  }

  const out = Uint8Array.from(msg);
  for (let i = 0; i < nmess; i++) out[i] ^= E[i];
  return out;
}

/**
 * 完整解碼。
 *
 * @param {Uint8Array} codeword 收到的碼字（長度 = 訊息長度 + nsym）
 * @param {number} nsym 校驗符號數
 * @param {number[]} [erasePos=[]] 已知可能出錯的位置（信心度低的格子）
 * @returns {{msg:Uint8Array, corrected:number}|null} 解不開時回傳 null
 *
 * 更正能力：2 × 未知錯誤數 + 抹除數 ≤ nsym
 */
export function rsDecode(codeword, nsym, erasePos = []) {
  if (codeword.length > 255 || codeword.length <= nsym) return null;
  if (erasePos.length > nsym) return null;   // 抹除太多，理論上就不可能解開

  const msg = Uint8Array.from(codeword);
  for (const p of erasePos) {
    if (p < 0 || p >= msg.length) return null;
    msg[p] = 0;   // 不可信的值歸零，避免干擾症狀計算
  }

  const synd = rsCalcSyndromes(msg, nsym);
  if (synd.every((v) => v === 0)) {
    // 症狀全為零 → 碼字本來就正確（抹除的位置剛好原本就是 0）
    return { msg: msg.slice(0, msg.length - nsym), corrected: 0 };
  }

  // 有抹除時先折成 Forney 症狀，讓 BM 只需尋找剩下的未知錯誤
  const fsynd = rsForneySyndromes(synd, erasePos, msg.length);
  const errLoc = rsFindErrorLocator(fsynd, nsym, erasePos.length);
  if (!errLoc) return null;

  const errPos = rsFindErrors(Uint8Array.from(errLoc).reverse(), msg.length);
  if (!errPos) return null;

  const allPos = [...erasePos, ...errPos];
  const corrected = rsCorrectErrata(msg, synd, allPos);
  if (!corrected) return null;

  // 驗算：修正後症狀必須全為零。
  // 錯誤超出更正能力時，前面的步驟可能「修出一個看似合法但其實錯誤」的碼字，
  // 這一關就是要擋掉那種情況 —— 寧可回報失敗，也不能把壞資料當好資料交出去。
  const checkSynd = rsCalcSyndromes(corrected, nsym);
  if (!checkSynd.every((v) => v === 0)) return null;

  return { msg: corrected.slice(0, corrected.length - nsym), corrected: allPos.length };
}

/* =========================================================================
 * 分塊編解碼工具
 * =========================================================================
 * RS 碼字最長 255 bytes，實際資料一定更長，所以要切成多塊。
 */

/**
 * 把一段資料切塊並各自 RS 編碼。
 * @param {Uint8Array} data
 * @param {number} k 每塊的訊息長度
 * @param {number} nsym 每塊的校驗符號數
 * @returns {Uint8Array[]} 每塊長度都是 k + nsym
 */
export function rsEncodeChunks(data, k, nsym) {
  const chunks = [];
  for (let off = 0; off < data.length; off += k) {
    const slice = data.subarray(off, Math.min(off + k, data.length));
    // 最後一塊不足就補零（呼叫端知道原始長度，會自行裁切）
    const msg = slice.length === k ? slice : (() => {
      const m = new Uint8Array(k);
      m.set(slice);
      return m;
    })();
    chunks.push(rsEncode(msg, nsym));
  }
  return chunks;
}

/**
 * 交錯排列：把多個碼字打散，讓相鄰位置屬於不同碼字。
 *
 * 為什麼一定要做：螢幕上的一片反光、或撕裂造成的一整條壞掉，會讓「空間上相鄰」
 * 的格子連續出錯。如果一個碼字的 255 個符號剛好連續排在一起，那片反光就會
 * 集中打爆同一個碼字，超出它的更正能力；但打散之後，同樣數量的錯誤會平均分給
 * 所有碼字，每個碼字只分到少少幾個，全部都能修好。
 *
 * @param {Uint8Array[]} chunks 等長的碼字
 * @returns {Uint8Array}
 */
export function interleave(chunks) {
  if (chunks.length === 0) return new Uint8Array(0);
  const len = chunks[0].length;
  const n = chunks.length;
  const out = new Uint8Array(len * n);
  for (let i = 0; i < len; i++) {
    for (let j = 0; j < n; j++) out[i * n + j] = chunks[j][i];
  }
  return out;
}

/**
 * 還原交錯排列。
 * @param {Uint8Array} data
 * @param {number} n 碼字數量
 * @returns {Uint8Array[]}
 */
export function deinterleave(data, n) {
  const len = data.length / n;
  const chunks = Array.from({ length: n }, () => new Uint8Array(len));
  for (let i = 0; i < len; i++) {
    for (let j = 0; j < n; j++) chunks[j][i] = data[i * n + j];
  }
  return chunks;
}

/**
 * 把交錯後的抹除位置換算回「各碼字內的位置」。
 * @param {number[]} positions 交錯後的位置
 * @param {number} n 碼字數量
 * @returns {number[][]} 每個碼字各自的抹除位置
 */
export function deinterleaveErasures(positions, n) {
  const out = Array.from({ length: n }, () => []);
  for (const p of positions) {
    out[p % n].push((p / n) | 0);
  }
  return out;
}
