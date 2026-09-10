/**
 * detect.js — 從一張影像還原出每一格的顏色符號
 * =============================================
 * 這是接收端最難的部分。輸入是相機（或模擬器）拍到的 ImageData，
 * 輸出是「每一格是哪個符號，以及有多少信心」。
 *
 * 流程：
 *   1. 灰階化 + 找出四個定位標記（掃描線上 1:1:3:1:1 的黑白比例）
 *   2. 判斷方向（右下角的標記中心多一個白點）
 *   3. 四點單應性矩陣，把格子座標映射到影像座標
 *   4. 用時序軌逐格修正，吃掉鏡頭桶狀畸變與螢幕彎曲
 *   5. 讀標頭（黑白、三重重複、多數決）
 *   6. 從上下兩條色票條建立「這台相機看到的參考色」，依垂直位置插值
 *   7. 每格取中央區域平均色 → 轉 CIELAB → 找最近的參考色
 *      信心度 = 最近距離 / 次近距離，太接近就標記為抹除
 *
 * 刻意不使用 OpenCV.js：它壓縮後仍有數 MB，而我們需要的只有
 * 「找四個特定圖樣 + 一個 4 點單應性」，自己寫大約兩百行就夠，
 * 而且能針對自家的定位標記做最佳化。
 */

import {
  ROLE, FINDER, HEADER_BYTES, HEADER_COPIES, PALETTES,
  srgbToLab, deltaE, headerMajorityVote, decodeHeader, bitsPerCell,
} from './format.js';
import { monoIndices } from './render.js';

/* =========================================================================
 * 1. 灰階
 * ========================================================================= */

/**
 * @param {ImageData} img
 * @returns {Uint8ClampedArray} 每像素一個亮度值
 */
export function toGray(img) {
  const { width: W, height: H, data } = img;
  const g = new Uint8ClampedArray(W * H);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) {
    // BT.601 亮度權重
    g[i] = (data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114) | 0;
  }
  return g;
}

/* =========================================================================
 * 2. 定位標記偵測
 * =========================================================================
 * 我們的定位標記沿著中心線的黑白跑道長度比例是 1:1:3:1:1
 * （外框黑 1、白 1、中央黑 3、白 1、外框黑 1），和 QR 的定位圖樣一樣。
 * 這個比例在任意旋轉與透視下都近似成立，所以先用水平掃描線找候選，
 * 再用垂直方向驗證。
 */

/** 檢查五段跑道長度是否符合 1:1:3:1:1 */
function checkRatio(runs) {
  const total = runs[0] + runs[1] + runs[2] + runs[3] + runs[4];
  if (total < 7) return false;
  const unit = total / 7;
  const tol = unit * 0.6;   // 容忍度給大一點，模糊與透視都會讓邊界飄移
  return Math.abs(runs[0] - unit) < tol
      && Math.abs(runs[1] - unit) < tol
      && Math.abs(runs[2] - unit * 3) < tol * 2
      && Math.abs(runs[3] - unit) < tol
      && Math.abs(runs[4] - unit) < tol;
}

/**
 * 沿著一條線做跑道長度檢查，回傳所有符合 1:1:3:1:1 的位置。
 *
 * 做法是先把整條線拆成「黑白交替的跑道」，再用一個 5 段的滑動視窗檢查比例。
 * 這比邊掃邊維護狀態機簡單得多，也避開了「必須從黑色開始」這個限制 ——
 * 那個限制會讓通過下方定位標記的掃描線（起點通常是白色）整條被跳過，
 * 結果就是只找得到上面兩個標記。
 *
 * @param {(i:number) => number} get 取得第 i 個取樣點的亮度
 * @param {number} len 線的長度
 * @param {number} threshold 黑白分界
 * @returns {{center:number, size:number}[]}
 */
function scanLine(get, len, threshold) {
  if (len < 7) return [];

  // 先拆成黑白交替的跑道
  const runs = [];
  let dark = get(0) < threshold;
  let start = 0;
  for (let i = 1; i < len; i++) {
    const d = get(i) < threshold;
    if (d !== dark) {
      runs.push({ dark, start, len: i - start });
      dark = d; start = i;
    }
  }
  runs.push({ dark, start, len: len - start });

  // 5 段滑動視窗
  const out = [];
  for (let i = 0; i + 4 < runs.length; i++) {
    if (!runs[i].dark) continue;   // 必須是 黑白黑白黑
    const l = [runs[i].len, runs[i + 1].len, runs[i + 2].len, runs[i + 3].len, runs[i + 4].len];
    if (!checkRatio(l)) continue;
    const total = l[0] + l[1] + l[2] + l[3] + l[4];
    out.push({ center: runs[i].start + total / 2, size: total / 7 });
  }
  return out;
}

/**
 * 找出畫面中所有定位標記的中心。
 * @param {Uint8ClampedArray} gray
 * @param {number} W
 * @param {number} H
 * @returns {{x:number, y:number, size:number}[]}
 */
export function findFinders(gray, W, H) {
  // 用全域平均當門檻。畫面裡黑白各佔一半左右，平均值是不錯的分界；
  // 局部光照不均由後面的「每格相對於色票條」來處理，這裡只要找得到標記就好。
  let sum = 0;
  for (let i = 0; i < gray.length; i++) sum += gray[i];
  const threshold = sum / gray.length;

  const candidates = [];
  // 水平掃描（隔行掃以節省時間，標記至少 7 個格子高，不會漏掉）
  const step = Math.max(1, Math.floor(H / 400));
  for (let y = 0; y < H; y += step) {
    const row = y * W;
    for (const c of scanLine((i) => gray[row + i], W, threshold)) {
      // 垂直方向驗證
      const cx = Math.round(c.center);
      if (cx < 0 || cx >= W) continue;
      const vsCenters = scanLine((i) => gray[i * W + cx], H, threshold);
      const match = vsCenters.find((v) => Math.abs(v.center - y) < c.size * 2.5);
      if (!match) continue;
      candidates.push({ x: c.center, y: match.center, size: (c.size + match.size) / 2 });
    }
  }

  // 群聚：同一個標記會被很多條掃描線找到
  const clusters = [];
  for (const c of candidates) {
    const hit = clusters.find((k) => Math.hypot(k.x - c.x, k.y - c.y) < c.size * 3);
    if (hit) {
      hit.x = (hit.x * hit.n + c.x) / (hit.n + 1);
      hit.y = (hit.y * hit.n + c.y) / (hit.n + 1);
      hit.size = (hit.size * hit.n + c.size) / (hit.n + 1);
      hit.n++;
    } else {
      clusters.push({ x: c.x, y: c.y, size: c.size, n: 1 });
    }
  }

  // 至少要被兩條掃描線同時找到，濾掉雜訊造成的偶然命中
  return clusters.filter((k) => k.n >= 2).sort((a, b) => b.n - a.n);
}

/**
 * 從候選中挑出真正的四個角。
 *
 * 標頭區是黑白格子，偶爾會湊巧形成 1:1:3:1:1 的比例而被誤判成定位標記，
 * 所以不能單純取「命中次數最多的四個」。
 * 真正的定位標記一定落在整張圖的四個極端位置，因此改用
 * (x+y) 與 (x−y) 的極值來挑 —— 在 ±15° 的旋轉範圍內都成立。
 *
 * @param {{x:number,y:number,size:number,n:number}[]} clusters
 * @returns {object[]|null} [TL, TR, BL, BR] 的粗略位置（實際方向仍由變體標記判斷）
 */
export function pickCorners(clusters) {
  if (clusters.length < 4) return null;
  const pool = clusters.slice(0, 40);   // 只在命中次數較高的候選裡挑

  const pick = (score, want) => pool.reduce((best, c) =>
    ((want === 'min') ? score(c) < score(best) : score(c) > score(best)) ? c : best, pool[0]);

  const four = [
    pick((c) => c.x + c.y, 'min'),   // 左上
    pick((c) => c.x - c.y, 'max'),   // 右上
    pick((c) => c.x - c.y, 'min'),   // 左下
    pick((c) => c.x + c.y, 'max'),   // 右下
  ];
  if (new Set(four).size !== 4) return null;   // 退化：候選沒有分佈成四個角
  return four;
}

/* =========================================================================
 * 3. 單應性矩陣
 * ========================================================================= */

/** 解 n×n 線性方程組（部分主元高斯消去） */
function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;   // 奇異矩陣（四點共線之類）
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / row[i][i] ?? 0).map((_, i) => M[i][n] / M[i][i]);
}

/**
 * 由四組對應點求單應性矩陣（3×3，h22 固定為 1）。
 * @param {number[][]} src 格子座標系的四點
 * @param {number[][]} dst 影像座標系的四點
 * @returns {number[]|null} 長度 9 的矩陣
 */
export function computeHomography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const h = solveLinear(A, b);
  if (!h || h.some((v) => !isFinite(v))) return null;
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

/** 用單應性矩陣把一個點映射過去 */
export function applyH(h, x, y) {
  const w = h[6] * x + h[7] * y + h[8];
  return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
}

/* =========================================================================
 * 3b. 用時序軌修正幾何
 * =========================================================================
 * 四點單應性可以完美處理旋轉與透視（那正是它的數學定義），但它處理不了
 * **鏡頭的桶狀畸變**：那是一個徑向的非線性位移，四個角再怎麼對齊，
 * 畫面中段還是會偏掉。實測在 k=0.06 的桶狀畸變下，中段誤差約 0.7 格 ——
 * 足以讓整個標頭讀錯。
 *
 * 時序軌就是為此存在的。它是一整排黑白交替的格子，每一個交界都是一個
 * 「已知格子座標的地標」。沿著軌道找出實際的交界位置，就能量出
 * 「格子座標 → 影像座標」在這條邊上的真實對應關係，把畸變吃掉。
 *
 * 四條邊都做完之後，內部用 Coons patch（由四條邊界曲線內插出整個面）
 * 求任意格子的位置。
 */

/**
 * 沿著一條時序軌找出所有黑白交界，回傳「格子座標 → 沿軌參數」的對應。
 *
 * @param {ImageData} img
 * @param {number[]} h 初始單應性
 * @param {number[]} gStart 軌道起點（格子座標）
 * @param {number[]} gEnd 軌道終點（格子座標）
 * @param {number} nCells 這條軌道有幾格
 * @returns {number[]|null} 長度 nCells+1 的參數表；失敗回傳 null
 */
function traceTrackWithBow(img, mapFn, gStart, gEnd, nCells, bow, normal) {
  const OVER = 8;                       // 每格取樣幾個點
  const M = nCells * OVER;
  const lum = new Float32Array(M + 1);

  for (let i = 0; i <= M; i++) {
    const t = i / M;
    // 弓形位移：兩端為 0、中間最大的拋物線，正好對應桶狀畸變讓直線鼓起來的形狀
    const off = bow * 4 * t * (1 - t);
    const gx = gStart[0] + (gEnd[0] - gStart[0]) * t + normal[0] * off;
    const gy = gStart[1] + (gEnd[1] - gStart[1]) * t + normal[1] * off;
    const [px, py] = mapFn(gx, gy);
    const c = sampleCell(img, px, py, 0.8);
    lum[i] = (c[0] + c[1] + c[2]) / 3;
  }

  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i <= M; i++) { if (lum[i] < lo) lo = lum[i]; if (lum[i] > hi) hi = lum[i]; }
  const contrast = hi - lo;
  if (contrast < 25) return null;
  const mid = (lo + hi) / 2;

  const crossings = [];
  for (let i = 0; i < M; i++) {
    const p = lum[i] - mid, q = lum[i + 1] - mid;
    if ((p < 0) === (q < 0)) continue;
    crossings.push((i + p / (p - q)) / M);
  }

  // 時序軌每格換一次色，理論上應有 nCells-1 個交界
  const expect = nCells - 1;
  const score = contrast - 25 * Math.abs(crossings.length - expect);
  if (crossings.length < nCells * 0.6 || crossings.length > nCells * 1.5) {
    return { anchorT: null, score, crossings: crossings.length };
  }

  const anchorT = new Array(nCells + 1).fill(null);
  const measured = new Array(nCells + 1).fill(false);
  for (const t of crossings) {
    const k = Math.round(t * nCells);
    if (k < 0 || k > nCells) continue;
    if (anchorT[k] === null || Math.abs(t - k / nCells) < Math.abs(anchorT[k] - k / nCells)) {
      anchorT[k] = t;
      measured[k] = true;
    }
  }
  anchorT[0] = 0; anchorT[nCells] = 1;

  let last = 0;
  for (let k = 1; k <= nCells; k++) {
    if (anchorT[k] !== null) {
      if (k - last > 1) {
        const t0 = anchorT[last], t1 = anchorT[k];
        for (let j = last + 1; j < k; j++) anchorT[j] = t0 + (t1 - t0) * (j - last) / (k - last);
      }
      last = k;
    }
  }
  for (let k = 1; k <= nCells; k++) {
    if (anchorT[k] === null || anchorT[k] <= anchorT[k - 1]) {
      return { anchorT: null, score, crossings: crossings.length };
    }
  }
  return { anchorT, measured, score, crossings: crossings.length };
}

/**
 * 沿一條線單純數黑白交界的數量，不帶任何預期值。
 * 用來反推真實的網格尺寸。
 * @returns {number} 交界數
 */
function countCrossingsAtBow(img, mapFn, gStart, gEnd, samples, bow, normal) {
  const lum = new Float32Array(samples + 1);
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const off = bow * 4 * t * (1 - t);
    const [px, py] = mapFn(gStart[0] + (gEnd[0] - gStart[0]) * t + normal[0] * off,
                           gStart[1] + (gEnd[1] - gStart[1]) * t + normal[1] * off);
    const c = sampleCell(img, px, py, 0.8);
    lum[i] = (c[0] + c[1] + c[2]) / 3;
  }
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i <= samples; i++) { if (lum[i] < lo) lo = lum[i]; if (lum[i] > hi) hi = lum[i]; }
  if (hi - lo < 25) return -1;
  const mid = (lo + hi) / 2;
  let n = 0;
  for (let i = 0; i < samples; i++) {
    if (((lum[i] - mid) < 0) !== ((lum[i + 1] - mid) < 0)) n++;
  }
  return n;
}

/**
 * 數一條時序軌上的黑白交界數量，用來反推真實的網格尺寸。
 *
 * 關鍵在於必須連同「弓形」一起搜尋：桶狀畸變會讓軌道鼓離預測的直線，
 * 照直線取樣會掃過旁邊的資料格，交界被抹平，數出來的數量嚴重偏低
 * （實測真值 82 個，照直線只數到 18 個）。
 *
 * 判準用「交界數最多」而不是「最接近某個預期值」—— 後者會把答案偷偷
 * 帶向假設的尺寸，那正是我們要量測的東西。線偏離軌道時交界會被平均掉而變少，
 * 所以最大值就對應著最貼合軌道的那條路徑。
 *
 * @returns {number} 交界數，失敗時回傳 -1
 */
function countCrossings(img, mapFn, gStart, gEnd, samples) {
  const dx = gEnd[0] - gStart[0], dy = gEnd[1] - gStart[1];
  const len = Math.hypot(dx, dy) || 1;
  const normal = [-dy / len, dx / len];
  let best = -1;
  for (let bow = -2.5; bow <= 2.5001; bow += 0.25) {
    const n = countCrossingsAtBow(img, mapFn, gStart, gEnd, samples, bow, normal);
    if (n > best) best = n;
  }
  return best;
}

/**
 * 追蹤一條時序軌。
 *
 * 難點在於：單應性是用四個角配出來的，桶狀畸變會讓中段的軌道「鼓」離
 * 預測的直線最多快一整格。照著預測的直線取樣，中段就會取到隔壁的資料格，
 * 得到一串亂七八糟的顏色，交界數量完全對不上，於是整條軌道被判定不可信。
 *
 * 解法：把軌道的實際形狀用「一個弓形參數」描述（兩端固定、中間偏移的拋物線，
 * 正好就是桶狀畸變造成的形狀），然後掃描這個參數，取對比度最高、
 * 交界數量最接近預期的那一個。
 */
function traceTrack(img, mapFn, gStart, gEnd, nCells) {
  // 軌道的法線方向（用來做垂直於軌道的位移）
  const dx = gEnd[0] - gStart[0], dy = gEnd[1] - gStart[1];
  const len = Math.hypot(dx, dy) || 1;
  const normal = [-dy / len, dx / len];

  // 粗掃再細掃：直接用 0.25 的間距掃 -2..2 要試 17 次，
  // 而這個函式在搜尋網格尺寸時會被呼叫上百次。
  // 先以 0.5 為間距粗掃，再在最佳值附近以 0.125 細掃，次數少一半、精度更好。
  let best = null;
  const tryBow = (bow) => {
    const r = traceTrackWithBow(img, mapFn, gStart, gEnd, nCells, bow, normal);
    if (r && (!best || r.score > best.score)) best = { ...r, bow };
  };
  for (let bow = -2; bow <= 2.0001; bow += 0.5) tryBow(bow);
  if (best) {
    const c = best.bow;
    for (const d of [-0.375, -0.25, -0.125, 0.125, 0.25, 0.375]) tryBow(c + d);
  }
  if (!best || !best.anchorT) return null;
  return { anchorT: best.anchorT, measured: best.measured, bow: best.bow, normal, gStart, gEnd, nCells };
}

/**
 * 把追蹤結果換算成「格子座標 ↔ 影像座標」的對應點。
 *
 * anchorT[k] 是「第 k 個格子邊界」實際出現在軌道上的參數位置。
 * 沿著（含弓形修正的）取樣路徑走到那個參數，再用粗略單應性換算，
 * 得到的就是那個邊界在影像上的實測位置 ——
 * 這裡的單應性只是用來「沿著影像走一條路」，量到的位置本身是真實的。
 *
 * @returns {{g:number[], p:number[]}[]}
 */
function trackCorrespondences(track, mapFn) {
  if (!track) return [];
  const { anchorT, measured, bow, normal, gStart, gEnd, nCells } = track;
  const out = [];
  for (let k = 0; k <= nCells; k++) {
    // 只用「真的量到交界」的錨點。內插補出來的錨點沒有帶來新資訊，
    // 卻會在最小平方法裡佔一份權重，把擬合往錯誤的方向拉。
    if (k !== 0 && k !== nCells && !measured[k]) continue;
    const t = anchorT[k];
    const off = bow * 4 * t * (1 - t);
    const px = mapFn(
      gStart[0] + (gEnd[0] - gStart[0]) * t + normal[0] * off,
      gStart[1] + (gEnd[1] - gStart[1]) * t + normal[1] * off);
    // 對應的格子座標：第 k 個邊界
    const u = k / nCells;
    out.push({
      g: [gStart[0] + (gEnd[0] - gStart[0]) * u, gStart[1] + (gEnd[1] - gStart[1]) * u],
      p: px,
    });
  }
  return out;
}

/* =========================================================================
 * 3c. 單應性 + 徑向畸變的整體擬合
 * =========================================================================
 * 前面的做法（四角單應性 + 沿邊修正）在桶狀畸變下仍有近兩格的殘差，
 * 因為它本質上只是在邊界上打補丁，內部靠內插，而畸變是整個平面的效應。
 *
 * 這裡改成擬合一個有物理意義的模型：
 *     影像座標 = 徑向畸變( 單應性( 格子座標 ) )
 * 未知數是單應性的 8 個參數加上一個徑向係數 k。
 *
 * 解法：k 只有一個維度，直接掃描它；對每個候選 k 先把所有實測點「去畸變」，
 * 再用最小平方法線性求解單應性，取殘差最小的 k。
 * 對應點來自四條時序軌上的每一個格子邊界（約兩百個）加上四個定位標記中心，
 * 數量遠超過 8 個未知數，因此擬合非常穩定。
 */

/** 用最小平方法從 n≥4 組對應點求單應性 */
function fitHomographyLS(src, dst) {
  const n = src.length;
  if (n < 4) return null;
  // 建立正規方程組 (AᵀA) h = Aᵀb，A 是 2n×8
  const AtA = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const Atb = new Array(8).fill(0);

  const addRow = (row, rhs) => {
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) AtA[i][j] += row[i] * row[j];
      Atb[i] += row[i] * rhs;
    }
  };
  for (let i = 0; i < n; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    addRow([x, y, 1, 0, 0, 0, -u * x, -u * y], u);
    addRow([0, 0, 0, x, y, 1, -v * x, -v * y], v);
  }
  const h = solveLinear(AtA, Atb);
  if (!h || h.some((q) => !isFinite(q))) return null;
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

/**
 * 擬合「單應性 + 徑向畸變」模型。
 * @param {{g:number[], p:number[]}[]} corr 對應點
 * @param {number} W 影像寬
 * @param {number} H 影像高
 * @returns {{map:(gx:number,gy:number)=>number[], refined:boolean, k:number, rms:number}|null}
 */
/**
 * 對固定的一組對應點掃描徑向係數 k，每個 k 用最小平方法解單應性，取殘差最小者。
 * @returns {{k:number, h:number[], err:number}|null}
 */
function fitOnce(corr, cx, cy, norm) {
  const src = corr.map((c) => c.g);
  let best = null;
  for (let k = -0.20; k <= 0.2001; k += 0.004) {
    // 把實測影像點去畸變（正向是 r→r(1+k·r²)，這裡取一階反解）
    const dst = corr.map((c) => {
      const dx = (c.p[0] - cx) / norm, dy = (c.p[1] - cy) / norm;
      const f = 1 + k * (dx * dx + dy * dy);
      return [cx + (dx / f) * norm, cy + (dy / f) * norm];
    });
    const h = fitHomographyLS(src, dst);
    if (!h) continue;
    let err = 0;
    for (let i = 0; i < src.length; i++) {
      const q = applyH(h, src[i][0], src[i][1]);
      err += (q[0] - dst[i][0]) ** 2 + (q[1] - dst[i][1]) ** 2;
    }
    if (!best || err < best.err) best = { k, h, err };
  }
  return best;
}

export function fitRadialHomography(corr, W, H) {
  if (corr.length < 12) return null;
  const cx = W / 2, cy = H / 2;
  const norm = Math.max(cx, cy);

  let best = fitOnce(corr, cx, cy, norm);
  if (!best) return null;

  if (!best) return null;

  // 離群點剔除後再擬合一次。
  // 交界偵測偶爾會把某一格的邊界配錯（模糊讓極短的跑道消失時最常見），
  // 那種點的殘差會遠大於其他點，留著會把整個擬合帶偏。
  {
    const { k, h } = best;
    const res = corr.map((c, i) => {
      const dx = (c.p[0] - cx) / norm, dy = (c.p[1] - cy) / norm;
      const f = 1 + k * (dx * dx + dy * dy);
      const ux = cx + (dx / f) * norm, uy = cy + (dy / f) * norm;
      const q = applyH(h, c.g[0], c.g[1]);
      return { i, e: Math.hypot(q[0] - ux, q[1] - uy) };
    }).sort((p1, p2) => p1.e - p2.e);

    const keep = res.slice(0, Math.max(12, Math.floor(res.length * 0.9))).map((r) => corr[r.i]);
    if (keep.length >= 12 && keep.length < corr.length) {
      const refit = fitOnce(keep, cx, cy, norm);
      if (refit && refit.err / keep.length < best.err / corr.length) {
        best = refit;
      }
    }
  }

  const { k, h } = best;
  return {
    refined: true,
    k,
    rms: Math.sqrt(best.err / corr.length),
    map(gx, gy) {
      const [x, y] = applyH(h, gx, gy);
      const dx = (x - cx) / norm, dy = (y - cy) / norm;
      const f = 1 + k * (dx * dx + dy * dy);
      return [cx + dx * f * norm, cy + dy * f * norm];
    },
  };
}



/**
 * 建立一個「格子座標 → 影像座標」的取樣器。
 * 先嘗試用四條時序軌做 Coons patch 校正；任何一條軌道不可信就退回純單應性。
 *
 * @returns {{map:(gx:number,gy:number)=>number[], refined:boolean}}
 */
export function buildSampler(img, h, layout) {
  const { timingTop, timingBottom, timingLeft, timingRight } = layout;
  const nx = timingRight - timingLeft;
  const ny = timingBottom - timingTop;

  const plain = { map: (gx, gy) => applyH(h, gx, gy), refined: false, k: 0, rms: 0 };
  if (nx < 8 || ny < 8) return plain;

  // 迭代精修：
  //   第一輪用四角單應性沿著軌道走，此時中段可能偏掉快一格，量到的位置有誤差；
  //   擬合出模型之後再走一次，路徑已經貼合軌道，量到的位置就準得多；
  //   如此重複直到殘差不再下降。實測兩到三輪就收斂。
  let mapper = plain.map;
  let best = plain;

  for (let iter = 0; iter < 3; iter++) {
    const tracks = [
      traceTrack(img, mapper, [timingLeft, timingTop + 0.5], [timingRight, timingTop + 0.5], nx),
      traceTrack(img, mapper, [timingLeft, timingBottom + 0.5], [timingRight, timingBottom + 0.5], nx),
      traceTrack(img, mapper, [timingLeft + 0.5, timingTop], [timingLeft + 0.5, timingBottom], ny),
      traceTrack(img, mapper, [timingRight + 0.5, timingTop], [timingRight + 0.5, timingBottom], ny),
    ];
    // 至少要有三條軌道可信，否則對應點分佈太偏，擬合不穩
    if (tracks.filter(Boolean).length < 3) break;

    const corr = [];
    for (const t of tracks) corr.push(...trackCorrespondences(t, mapper));
    // 四個定位標記中心是最可靠的對應點（單應性在那裡本來就是精確的）
    for (const f of layout.finders) {
      corr.push({ g: [f.x + 3.5, f.y + 3.5], p: applyH(h, f.x + 3.5, f.y + 3.5) });
    }

    const fitted = fitRadialHomography(corr, img.width, img.height);
    if (!fitted) break;
    if (best.refined && fitted.rms >= best.rms * 0.98) { best = fitted.rms < best.rms ? fitted : best; break; }
    best = fitted;
    mapper = fitted.map;
  }

  return best;
}

/* =========================================================================
 * 4. 取樣與分類
 * ========================================================================= */

/**
 * 取某個格子中央區域的平均顏色。
 * 刻意只取中間 1/3：格子邊緣在模糊之後會混到隔壁格的顏色，
 * 那正是分類錯誤的主要來源。
 * @returns {number[]} [r, g, b]
 */
function sampleCell(img, px, py, radius) {
  const { width: W, height: H, data } = img;
  const r = Math.max(0.5, radius);
  const x0 = Math.max(0, Math.round(px - r)), x1 = Math.min(W - 1, Math.round(px + r));
  const y0 = Math.max(0, Math.round(py - r)), y1 = Math.min(H - 1, Math.round(py + r));
  if (x1 < x0 || y1 < y0) return [0, 0, 0];
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (let y = y0; y <= y1; y++) {
    let p = (y * W + x0) * 4;
    for (let x = x0; x <= x1; x++) {
      sr += data[p]; sg += data[p + 1]; sb += data[p + 2];
      n++; p += 4;
    }
  }
  return [sr / n, sg / n, sb / n];
}

/**
 * 把一格的顏色分類成調色盤索引。
 * @param {number[]} lab 這格的 Lab 值
 * @param {number[][]} refLabs 參考色的 Lab 值
 * @returns {{symbol:number, ratio:number}} ratio = 最近距離 / 次近距離
 */
function classify(lab, refLabs) {
  let best = 0, d1 = Infinity, d2 = Infinity;
  for (let i = 0; i < refLabs.length; i++) {
    const d = deltaE(lab, refLabs[i]);
    if (d < d1) { d2 = d1; d1 = d; best = i; }
    else if (d < d2) { d2 = d; }
  }
  // ratio 越接近 1 代表「最像的」和「第二像的」難分難解，這格就不可信
  return { symbol: best, ratio: d2 > 0 ? d1 / d2 : 1 };
}

/* =========================================================================
 * 5. 主流程
 * ========================================================================= */

/**
 * 從影像解出整幀的符號。
 *
 * @param {ImageData} img
 * @param {(cols:number, rows:number, sx:number, sy:number) => object} layoutFactory
 *        由標頭得知網格尺寸後，用來建立對應的 layout
 * @param {{confidenceThreshold?:number}} [opts]
 * @returns {{ok:boolean, reason?:string, header?:object, layout?:object,
 *            symbols?:Uint8Array, lowConf?:Uint8Array, parityBits?:number[],
 *            finders?:object[], corners?:number[][]}}
 */
export function detectFrame(img, layoutFactory, opts = {}) {
  // 信心度門檻：ratio = 最近距離 / 次近距離，超過此值就標記為抹除。
  //
  // 直覺會以為「多標一點抹除比較保險」，實測正好相反：每個抹除都要吃掉
  // RS 一個校驗符號的能力，標到本來就正確的格子等於白白浪費。
  // C8 在中等失真下實測：門檻 0.72 標了 0.7% 的格子，分區成功率 92%；
  // 門檻 0.82 只標 0.3%，分區成功率反而升到 100%。
  // 格子錯誤率在兩者之間完全相同（0.38%）—— 門檻只影響「標記」，不影響判讀。
  const threshold = opts.confidenceThreshold ?? 0.82;
  const hint = opts.hint || null;
  // 工作量預算：限制「建立幾何校正取樣器」的總次數。
  //
  // 解碼失敗時的成本比成功時高得多：成功會在找到正確尺寸的那一刻就回傳，
  // 失敗則會把所有方位 × 所有候選尺寸都跑完，每一組都要重建一次取樣器。
  // 對即時接收端來說，「花五秒確認這一幀解不開」是最糟的結果 ——
  // 那五秒內會漏掉幾十幀本來可能解得開的畫面。
  // 寧可早點放棄這一幀，把時間留給下一幀。
  const budget = { left: opts.budget ?? 150 };
  const gray = toGray(img);
  const W = img.width, H = img.height;

  // --- 找定位標記 ---
  const finders = findFinders(gray, W, H);
  const top4 = pickCorners(finders);
  if (!top4) {
    return { ok: false, reason: `定位標記候選不足（共 ${finders.length} 個）`, finders };
  }

  // --- 決定四個角分別是哪一個方位 ---
  //
  // 原本想用「方向標記」直接算出右下角，但那需要知道幀的兩個軸方向，
  // 而軸方向又要先知道角落的指派 —— 是個雞生蛋的循環。
  // 改成直接把 4 種旋轉 × 2 種鏡像（共 8 種）都試一遍，
  // 用「標頭 CRC 是否通過」來決定哪一種正確。
  //
  // 這樣做既簡單又可靠：標頭本來就要驗 CRC，而錯誤的方位會把標頭讀成
  // 畫面上完全不同的區域（例如 180° 會讀到下方的空白帶），CRC 必定不過。
  const cxAvg = top4.reduce((a2, f) => a2 + f.x, 0) / 4;
  const cyAvg = top4.reduce((a2, f) => a2 + f.y, 0) / 4;
  const ordered = [...top4].sort(
    (p1, p2) => Math.atan2(p1.y - cyAvg, p1.x - cxAvg) - Math.atan2(p2.y - cyAvg, p2.x - cxAvg),
  );

  const candidates = [];
  for (let k = 0; k < 4; k++) {
    const c = [0, 1, 2, 3].map((i) => ordered[(k + i) % 4]);
    candidates.push({ TL: c[0], TR: c[1], BR: c[2], BL: c[3] });   // 一個方向
    candidates.push({ TL: c[0], BL: c[1], BR: c[2], TR: c[3] });   // 反向（鏡像）
  }

  // 先用方向標記把 8 種可能刷成 1～2 種。
  // 到了這一步已經有粗略的單應性可用，而方向標記就在定位標記旁邊
  // （距離約 4.5 格），那裡的單應性誤差最小，所以判斷相當可靠。
  // 這一刷很重要：後面要對網格尺寸做較大範圍的搜尋，
  // 8 種方位都跑一遍的話成本會直接乘以 8。
  const scored = candidates.map((cand) => ({ cand, score: scoreOrientation(img, cand) }));
  scored.sort((p, q) => q.score - p.score);

  // 取前兩名（分數相同時留個保險），逐一嘗試完整解碼
  for (const { cand } of scored.slice(0, 2)) {
    const result = tryDecodeWith(img, gray, cand, layoutFactory, threshold, hint, budget);
    if (result.ok) return { ...result, finders };
  }
  // 前兩名都失敗才退回全部試一遍
  for (const { cand } of scored.slice(2)) {
    if (budget.left <= 0) break;
    const result = tryDecodeWith(img, gray, cand, layoutFactory, threshold, hint, budget);
    if (result.ok) return { ...result, finders };
  }
  return {
    ok: false,
    reason: budget.left <= 0 ? '超出工作量預算（畫面品質太差）' : '標頭解不開（方向判斷或幾何校正失敗）',
    finders,
  };
}

/**
 * 用方向標記替一組角落指派打分數。
 *
 * 分隔線的四個交叉點上各有一格方向標記，只有右下角那一格是黑的。
 * 指派正確時，取樣到的四格應該剛好「三亮一暗，且暗的那個在右下」。
 *
 * @returns {number} 分數，越高越可能是正確的指派
 */
function scoreOrientation(img, cand) {
  // 用標記本身的大小推估網格尺寸（粗略即可，方向標記離角落很近，誤差影響不大）
  const size = (cand.TL.size + cand.BR.size) / 2 || 1;
  const cols = Math.max(40, Math.round(Math.hypot(cand.TR.x - cand.TL.x, cand.TR.y - cand.TL.y) / size) + 7);
  const rows = Math.max(40, Math.round(Math.hypot(cand.BL.x - cand.TL.x, cand.BL.y - cand.TL.y) / size) + 7);

  const h = computeHomography(
    [[3.5, 3.5], [cols - 3.5, 3.5], [3.5, rows - 3.5], [cols - 3.5, rows - 3.5]],
    [[cand.TL.x, cand.TL.y], [cand.TR.x, cand.TR.y],
     [cand.BL.x, cand.BL.y], [cand.BR.x, cand.BR.y]],
  );
  if (!h) return -Infinity;

  // 方向標記的格子座標（與 makeLayout 一致）
  const marks = [[7, 7], [cols - 8, 7], [7, rows - 8], [cols - 8, rows - 8]];
  const lum = marks.map(([mx, my]) => {
    const [px, py] = applyH(h, mx + 0.5, my + 0.5);
    const c = sampleCell(img, px, py, Math.max(0.6, size * 0.3));
    return (c[0] + c[1] + c[2]) / 3;
  });

  const darkest = lum.indexOf(Math.min(...lum));
  const others = lum.filter((_, i) => i !== darkest);
  const gap = Math.min(...others) - lum[darkest];   // 最暗的和其他三個差多少

  // 最暗的必須是右下角（索引 3）
  return darkest === 3 ? gap : -gap;
}

/**
 * 用一組角落指派試著解出整幀。
 */
function tryDecodeWith(img, gray, corner, layoutFactory, threshold, hint = null, budget = { left: 1e9 }) {
  // 定位標記的中心在格子座標系裡的位置：距離邊緣 3.5 格
  // （標記是 7×7，左上角在 (0,0)，中心就在 (3.5, 3.5)）
  const guessSize = (corner.TL.size + corner.BR.size) / 2;

  // 先用「標記中心」建立粗略的單應性。此時還不知道網格尺寸，
  // 所以先用標記本身的格子大小反推一個估計值。
  const spanX = Math.hypot(corner.TR.x - corner.TL.x, corner.TR.y - corner.TL.y);
  const spanY = Math.hypot(corner.BL.x - corner.TL.x, corner.BL.y - corner.TL.y);
  const estCols = Math.round(spanX / guessSize) + 7;
  const estRows = Math.round(spanY / guessSize) + 7;
  if (estCols < 40 || estRows < 40 || estCols > 1000 || estRows > 1000) {
    return { ok: false, reason: `推估網格尺寸不合理（${estCols}×${estRows}）` };
  }

  // 依估計尺寸建立單應性，先把標頭讀出來（標頭位置只跟 cols 有關）
  const makeH = (cols, rows) => computeHomography(
    [[3.5, 3.5], [cols - 3.5, 3.5], [3.5, rows - 3.5], [cols - 3.5, rows - 3.5]],
    [[corner.TL.x, corner.TL.y], [corner.TR.x, corner.TR.y],
     [corner.BL.x, corner.BL.y], [corner.BR.x, corner.BR.y]],
  );

  // 桶狀畸變會讓定位標記本身的「格子大小」被高估（標記在畫面邊緣，
  // 徑向拉伸最嚴重），推估出來的欄列數因此偏少 ——
  // 實測 100×64 的畫面在 k=0.06 的畸變下被估成 94×63。
  //
  // 與其把搜尋範圍拉大（13×13 = 169 種組合，實測一幀要 5 秒，
  // 接收端根本跑不動），不如直接「量」出來：
  // 沿著時序軌數黑白交界的數量，那就是實際的格數。
  // 用估計值取樣時只覆蓋了軌道的一部分，換算回去即可得到真實欄數。
  // 尺寸搜尋的代價很高（每組候選都要重建一次幾何校正取樣器），
  // 所以如果呼叫端給了提示（接收端在第一幀成功之後就會一直給），
  // 就把提示排在最前面 —— 命中時整個搜尋直接跳過。
  const deltas = [];
  if (hint && hint.cols && hint.rows) {
    deltas.push([hint.cols - estCols, hint.rows - estRows, -1]);
  }
  // 搜尋順序很重要，因為每一組候選都要重建一次幾何校正取樣器。
  //
  // 這裡的偏差是有方向性的：桶狀畸變把定位標記往外推，也把它的「格子大小」
  // 撐大，於是「跨距 ÷ 格子大小」算出來的欄列數必定偏少，不會偏多
  // （實測 100×64 被估成 94×63，兩個方向都是低估）。
  // 所以先掃非負的偏移，而且由小到大 —— 正確答案通常在前二三十組之內。
  for (let dc = 0; dc <= 10; dc++) {
    for (let dr = 0; dr <= 10; dr++) deltas.push([dc, dr, dc + dr]);
  }
  for (let dc = -4; dc <= 10; dc++) {
    for (let dr = -4; dr <= 10; dr++) {
      if (dc >= 0 && dr >= 0) continue;
      deltas.push([dc, dr, 100 + Math.abs(dc) + Math.abs(dr)]);
    }
  }
  deltas.sort((p, q) => p[2] - q[2]);

  // 兩階段：先用快速標頭讀取掃一遍（絕大多數情況這裡就中了），
  // 全部失敗才用完整的位移搜尋再掃一遍。
  for (const quick of [true, false]) {
   for (const [dc, dr] of deltas) {
    {
      const cols = estCols + dc, rows = estRows + dr;
      const h = makeH(cols, rows);
      if (!h) continue;

      if (budget.left <= 0) return { ok: false, reason: '超出工作量預算' };
      let layout;
      try { layout = layoutFactory(cols, rows, 4, 3); } catch { continue; }
      budget.left--;

      // 先用時序軌校正幾何，再讀標頭。
      // 順序很重要：桶狀畸變會讓畫面中段偏掉快一格，
      // 沒校正就直接讀標頭的話，在有鏡頭畸變時必定失敗。
      const sampler = buildSampler(img, h, layout);

      const header = readHeader(img, sampler, layout, quick);
      if (!header) continue;

      if (header.cols !== cols || header.rows !== rows) continue;   // 自我一致性檢查

      // 標頭通過 CRC 且尺寸自洽 → 這組角落與尺寸是對的
      const real = layoutFactory(header.cols, header.rows, header.sectorsX, header.sectorsY);
      const hh = makeH(header.cols, header.rows);
      const realSampler = buildSampler(img, hh, real);
      const sampled = sampleAllCells(img, realSampler, real, header.paletteLevel, threshold);
      return {
        ok: true, header, layout: real, ...sampled,
        homography: hh, sampler: realSampler, refined: realSampler.refined, corners: corner,
      };
    }
   }
  }
  return { ok: false, reason: '找不到自洽的網格尺寸' };
}

/**
 * 讀出標頭（黑白格子、三重重複、多數決）。
 *
 * 標頭位於時序軌之外，那裡的幾何校正只能靠單應性外推，殘留誤差最大。
 * 因此這裡再加一層保險：把取樣位置上下左右微幅平移幾次，
 * 只要有任何一組讓 CRC 通過就採用。成本很低（幾百次取樣），
 * 但能救回不少「其他部分都對、只有標頭差半格」的畫面。
 */
function readHeader(img, sampler, layout, quick = false) {
  // 快速模式只試正中心。搜尋網格尺寸時會呼叫幾百次，
  // 每次都試 11 種位移的話成本直接乘以 11（實測一幀從 0.5 秒變成 5 秒）。
  // 所以先全部用快速模式掃一遍，全都失敗才回頭用完整模式再掃一次。
  if (quick) return readHeaderAt(img, sampler, layout, 0, 0);

  const offsets = [
    [0, 0], [0, -0.5], [0, 0.5], [0, -1], [0, 1],
    [-0.5, 0], [0.5, 0], [-0.5, -0.5], [0.5, 0.5], [0, -1.5], [0, 1.5],
  ];
  for (const [ox, oy] of offsets) {
    const h = readHeaderAt(img, sampler, layout, ox, oy);
    if (h) return h;
  }
  return null;
}

/** 以指定的取樣位移讀一次標頭 */
function readHeaderAt(img, sampler, layout, ox, oy) {
  const cells = layout.headerCells;
  const need = HEADER_BYTES * 8 * HEADER_COPIES;
  if (cells.length < need) return null;

  const lums = [];
  for (let i = 0; i < need; i++) {
    const c = cells[i];
    const [px, py] = sampler.map(c.x + 0.5 + ox, c.y + 0.5 + oy);
    const rgb = sampleCell(img, px, py, cellRadius(sampler, c.x, c.y));
    lums.push((rgb[0] + rgb[1] + rgb[2]) / 3);
  }
  // 二值化門檻：取「最暗的 10%」與「最亮的 10%」各自的平均，再取中點。
  // 不用中位數是因為標頭的 0/1 比例不見得平均（實測全黑格超過一半，
  // 中位數會直接落在 0 上）；不用單純的 min/max 是因為那對雜訊與反光太敏感。
  const sorted = [...lums].sort((p, q) => p - q);
  const dec = Math.max(1, Math.floor(sorted.length / 10));
  let lowSum = 0, highSum = 0;
  for (let i = 0; i < dec; i++) {
    lowSum += sorted[i];
    highSum += sorted[sorted.length - 1 - i];
  }
  const mid = (lowSum / dec + highSum / dec) / 2;

  const bits = new Uint8Array(need);
  for (let i = 0; i < need; i++) bits[i] = lums[i] > mid ? 1 : 0;

  return decodeHeader(headerMajorityVote(bits));
}

/** 估算某格在影像上的半徑（取 1/3 格寬，避開邊緣） */
function cellRadius(sampler, x, y) {
  const [x0, y0] = sampler.map(x, y);
  const [x1, y1] = sampler.map(x + 1, y);
  const [x2, y2] = sampler.map(x, y + 1);
  const w = Math.hypot(x1 - x0, y1 - y0);
  const hgt = Math.hypot(x2 - x0, y2 - y0);
  return Math.max(0.5, Math.min(w, hgt) / 3);
}

/**
 * 取樣所有格子並分類。
 */
function sampleAllCells(img, sampler, layout, level, threshold) {
  const { cols, rows, role } = layout;
  const palette = PALETTES[level];
  const N = cols * rows;

  // --- 先從色票條建立參考色 ---
  // 上下各一條，之後依格子的垂直位置在兩條之間插值，吃掉由上到下的亮度漸層。
  const refTop = new Array(level).fill(null).map(() => ({ r: 0, g: 0, b: 0, n: 0 }));
  const refBottom = new Array(level).fill(null).map(() => ({ r: 0, g: 0, b: 0, n: 0 }));

  const collectBar = (barY, acc) => {
    for (let x = 0; x < cols; x++) {
      if (role[barY * cols + x] !== ROLE.COLORBAR) continue;
      const idx = x % level;
      const [px, py] = sampler.map(x + 0.5, barY + 0.5);
      const c = sampleCell(img, px, py, cellRadius(sampler, x, barY));
      acc[idx].r += c[0]; acc[idx].g += c[1]; acc[idx].b += c[2]; acc[idx].n++;
    }
  };
  collectBar(layout.barTop, refTop);
  collectBar(layout.barBottom, refBottom);

  const avg = (a, fallback) => a.n > 0
    ? [a.r / a.n, a.g / a.n, a.b / a.n]
    : fallback;
  const topRGB = refTop.map((a, i) => avg(a, palette[i]));
  const botRGB = refBottom.map((a, i) => avg(a, palette[i]));
  const topLab = topRGB.map(srgbToLab);
  const botLab = botRGB.map(srgbToLab);

  // --- 逐格取樣分類 ---
  const symbols = new Uint8Array(N);
  const lowConf = new Uint8Array(N);
  const ratios = new Float32Array(N);

  const y0 = layout.barTop, y1 = layout.barBottom;
  let refLabs = topLab;
  let lastRow = -1;

  for (let cy = 0; cy < rows; cy++) {
    // 這一列的參考色：在上下兩條之間線性插值
    const t = Math.max(0, Math.min(1, (cy - y0) / Math.max(1, y1 - y0)));
    if (cy !== lastRow) {
      refLabs = topLab.map((lt, i) => [
        lt[0] * (1 - t) + botLab[i][0] * t,
        lt[1] * (1 - t) + botLab[i][1] * t,
        lt[2] * (1 - t) + botLab[i][2] * t,
      ]);
      lastRow = cy;
    }

    for (let cx = 0; cx < cols; cx++) {
      const i = cy * cols + cx;
      const r = role[i];
      // 只有資料格與奇偶標記需要分類，其他結構元素跳過以省時間
      if (r !== ROLE.DATA && r !== ROLE.PARITY) continue;
      const [px, py] = sampler.map(cx + 0.5, cy + 0.5);
      const rgb = sampleCell(img, px, py, cellRadius(sampler, cx, cy));
      const { symbol, ratio } = classify(srgbToLab(rgb), refLabs);
      symbols[i] = symbol;
      ratios[i] = ratio;
      if (ratio > threshold) lowConf[i] = 1;
    }
  }

  // --- 撕裂偵測：四個角的奇偶標記應該一致 ---
  const { black, white } = monoIndices(level);
  const parityBits = layout.parity.map((p) => {
    const s = symbols[p.y * cols + p.x];
    return s === white ? 1 : (s === black ? 0 : -1);
  });

  return { symbols, lowConf, ratios, parityBits, refTopRGB: topRGB, refBottomRGB: botRGB };
}
