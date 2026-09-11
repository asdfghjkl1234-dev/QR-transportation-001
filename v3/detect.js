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
  colorCount, shapeCount, SHAPE_SPOTS, SHAPE_SIZE, SHAPE_COLOR_RADIUS,
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

/**
 * 整數倍數縮圖（盒狀平均）。
 *
 * 定位標記的偵測成本和像素數成正比，而 1080p／1440p 的畫面在全解析度下
 * 實測要 68 ms —— 那是整個解碼流程裡第二重的一塊，而它其實不需要這麼精細：
 * 標記中心只要粗略對，後面的時序軌擬合會把幾何修到亞像素級。
 * 縮一半就少四分之三的工作量。
 *
 * 用盒狀平均而不是最近鄰，因為最近鄰會讓 1:1:3:1:1 的跑道長度在
 * 奇偶位置上跳動，反而害了比例判斷。
 *
 * @returns {{gray:Uint8ClampedArray, W:number, H:number, factor:number}}
 */
export function downscaleGray(gray, W, H, maxDim = 1100) {
  const factor = Math.max(1, Math.floor(Math.max(W, H) / maxDim) + (Math.max(W, H) > maxDim ? 0 : 0));
  if (factor <= 1 || Math.max(W, H) <= maxDim) return { gray, W, H, factor: 1 };
  const w = Math.floor(W / factor), h = Math.floor(H / factor);
  const out = new Uint8ClampedArray(w * h);
  const area = factor * factor;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      const sy = y * factor, sx = x * factor;
      for (let dy = 0; dy < factor; dy++) {
        const row = (sy + dy) * W + sx;
        for (let dx = 0; dx < factor; dx++) sum += gray[row + dx];
      }
      out[y * w + x] = (sum / area) | 0;
    }
  }
  return { gray: out, W: w, H: h, factor };
}

/* =========================================================================
 * 1b. 自適應二值化
 * =========================================================================
 * 定位標記是靠「黑白跑道長度的比例」找出來的，所以「哪裡算黑、哪裡算白」
 * 這個判斷必須夠準。
 *
 * 一開始用全域平均當門檻，在大畫面上整個失準：
 * C4 的調色盤是 黑(0)／白(255)／洋紅(105)／綠(150)，全域平均會落在 155 附近，
 * 於是連「綠」都被判成黑；再加上由上到下的亮度漸層與局部反光，
 * 同一個門檻在畫面不同位置代表的意義完全不同。
 * 症狀很隱晦：小畫面正常，一放大到 1920×1080 的實際尺寸，
 * 四個定位標記就只找得到三個。
 *
 * 改用 Bradley 局部平均法：每個像素只跟自己周圍一塊的平均值比較，
 * 亮度漸層、反光、調色盤造成的整體偏移全部自動吸收。
 * 用積分圖計算，每個像素的區域平均都是 O(1)。
 */

/**
 * @param {Uint8ClampedArray} gray
 * @param {number} W
 * @param {number} H
 * @param {number} [win] 取樣視窗邊長，預設約畫面寬的 1/12
 * @param {number} [bias=0.90] 門檻 = 區域平均 × bias
 * @returns {Uint8Array} 1 = 暗，0 = 亮
 */
export function adaptiveBinarize(gray, W, H, win, bias = 0.90) {
  const window = win || Math.max(16, Math.round(W / 12));
  const integral = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let rowSum = 0;
    for (let x = 0; x < W; x++) {
      rowSum += gray[y * W + x];
      integral[(y + 1) * (W + 1) + (x + 1)] = integral[y * (W + 1) + (x + 1)] + rowSum;
    }
  }

  const out = new Uint8Array(W * H);
  const r = window >> 1;
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(H - 1, y + r);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(W - 1, x + r);
      const area = (y1 - y0 + 1) * (x1 - x0 + 1);
      const sum = integral[(y1 + 1) * (W + 1) + (x1 + 1)]
                - integral[y0 * (W + 1) + (x1 + 1)]
                - integral[(y1 + 1) * (W + 1) + x0]
                + integral[y0 * (W + 1) + x0];
      out[y * W + x] = gray[y * W + x] * area < sum * bias ? 1 : 0;
    }
  }
  return out;
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
function scanLine(get, len) {
  if (len < 7) return [];

  // 先拆成黑白交替的跑道（get 直接回傳 1=暗 / 0=亮）
  const runs = [];
  let dark = get(0) === 1;
  let start = 0;
  for (let i = 1; i < len; i++) {
    const d = get(i) === 1;
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
  const bin = adaptiveBinarize(gray, W, H);

  const candidates = [];
  // 隔列掃描以節省時間；間距要隨畫面大小調整，太稀疏會錯過標記
  const step = Math.max(1, Math.floor(H / 500));
  for (let y = 0; y < H; y += step) {
    const row = y * W;
    for (const c of scanLine((i) => bin[row + i], W)) {
      // 垂直方向驗證：同一個位置在垂直掃描上也要看到 1:1:3:1:1
      const cx = Math.round(c.center);
      if (cx < 0 || cx >= W) continue;
      const vsCenters = scanLine((i) => bin[i * W + cx], H);
      const match = vsCenters.find((v) => Math.abs(v.center - y) < c.size * 3);
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
 * 在全解析度影像上精修一個定位標記的中心。
 *
 * 為什麼需要這一步：標記偵測是在縮圖上做的（省四分之三的時間），
 * 但縮圖同時把中心位置的精度也砍成一半。實測 234×129 的 C8 畫面
 * （格子只有 7 px）因此從「格子錯誤 0.05%、分區 100%」退到
 * 「0.81%、分區 92%」—— 掉到驗收標準以下。
 *
 * 四個角的位置是整個幾何校正的起點，起點差半格，時序軌就可能追錯，
 * 而精修的成本只有「四個小視窗」，幾乎免費。
 *
 * 做法和偵測時一致：在視窗內用局部門檻二值化，沿水平與垂直方向
 * 各掃幾條線找 1:1:3:1:1，取所有命中的平均。
 *
 * @returns {{x:number,y:number,size:number,n:number}} 精修後的標記（失敗時原樣回傳）
 */
function refineFinderCenter(gray, W, H, cand) {
  const half = Math.max(6, Math.ceil(cand.size * 4.5));
  const cx = Math.round(cand.x), cy = Math.round(cand.y);
  const x0 = Math.max(0, cx - half), x1 = Math.min(W - 1, cx + half);
  const y0 = Math.max(0, cy - half), y1 = Math.min(H - 1, cy + half);
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  if (w < 7 || h < 7) return cand;

  // 局部門檻：標記本身就是純黑白，視窗裡的最暗與最亮取中點即可
  let lo = 255, hi = 0;
  for (let y = y0; y <= y1; y++) {
    const row = y * W;
    for (let x = x0; x <= x1; x++) {
      const v = gray[row + x];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (hi - lo < 30) return cand;          // 對比太低，別亂修
  const thr = (lo + hi) / 2;

  const xs = [], ys = [], sizes = [];
  const span = Math.max(1, Math.round(cand.size));   // 掃描線取中心附近 ±1 格
  for (let dy = -span; dy <= span; dy++) {
    const y = cy + dy;
    if (y < y0 || y > y1) continue;
    const row = y * W;
    for (const c of scanLine((i) => (gray[row + x0 + i] < thr ? 1 : 0), w)) {
      if (Math.abs(x0 + c.center - cand.x) > cand.size * 2) continue;
      xs.push(x0 + c.center); sizes.push(c.size);
    }
  }
  for (let dx = -span; dx <= span; dx++) {
    const x = cx + dx;
    if (x < x0 || x > x1) continue;
    for (const c of scanLine((i) => (gray[(y0 + i) * W + x] < thr ? 1 : 0), h)) {
      if (Math.abs(y0 + c.center - cand.y) > cand.size * 2) continue;
      ys.push(y0 + c.center); sizes.push(c.size);
    }
  }
  if (!xs.length || !ys.length) return cand;

  const mean = (a) => a.reduce((p, q) => p + q, 0) / a.length;
  return { x: mean(xs), y: mean(ys), size: mean(sizes), n: cand.n };
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

  // 先濾掉「格子大小」明顯不合群的候選。
  //
  // 這一步是必要的：畫面一大，資料區裡湊巧形成 1:1:3:1:1 的位置就變多，
  // 其中偶爾會出現極小的假標記（實測 150×90 的畫面出現一個 size=1.4 的候選，
  // 真正的標記都在 6～7 之間）。假標記如果剛好落在 (x+y) 的極值上，
  // 就會被當成右下角取走，四點單應性整個歪掉 —— 症狀是幾何殘差從 0.5px
  // 跳到 3.9px，而且只在大畫面才出現，小畫面剛好沒有這種假標記。
  //
  // 同一張圖裡所有標記的格子大小應該相近（桶狀畸變頂多差個兩三成），
  // 所以用中位數當基準，保留 0.5～2 倍的候選，寬鬆但足以踢掉離譜的。
  //
  // 中位數要「加權」，權重取 n（被幾條掃描線同時確認）。
  // 純中位數在高雜訊下會反過來害事：雜訊會生出一堆 size≈1.4 的假標記，
  // 數量一旦超過真標記，中位數就被拉到 1.4，真標記反而被當成離群值踢掉
  // （實測 noise=22 就會發生，四個角全軍覆沒）。
  // 但真假標記的 n 差距極大 —— 真的 17～19，假的 2～3 ——
  // 因為一個模組大小 s 的標記高度有 7s 像素，本來就會被很多條掃描線掃到。
  // 用 n 當權重，真標記自然主導中位數。
  const byS = [...clusters].sort((a, b) => a.size - b.size);
  const totalW = byS.reduce((t, c) => t + c.n, 0);
  let acc = 0, medSize = byS[byS.length >> 1].size;
  for (const c of byS) {
    acc += c.n;
    if (acc >= totalW / 2) { medSize = c.size; break; }
  }
  const consistent = clusters.filter((c) => c.size >= medSize * 0.5 && c.size <= medSize * 2);
  const source = consistent.length >= 4 ? consistent : clusters;

  const pool = source.slice(0, 40);   // 只在命中次數較高的候選裡挑

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

  // 交界「間距是否整齊」也要算進分數裡。
  //
  // 原本的分數只看「對比 + 交界數接近預期」，那不足以區分
  // 「真的走在時序軌上」和「走偏到旁邊的資料格」——
  // 資料格同樣有黑有白（對比一樣是滿的），交界數又剛好可能碰上預期值。
  // 加了形狀層之後這個漏洞被放大：缺口讓資料格的交界變密，
  // 走偏的路徑更容易湊到預期的交界數。實測完全無失真的畫面裡，
  // 八幀就有一幀的幾何殘差爆到 7.1px（正常是 0.2px）、整幀報廢，
  // 而同一份資料在沒有形狀層時完全正常。
  //
  // 真正的時序軌是嚴格一格一換，所以相鄰交界的間距幾乎都等於一格；
  // 桶狀畸變只會讓間距沿著軌道「緩慢」變化，不會忽大忽小。
  // 走偏的路徑則是隨機的，間距散得很開。用「間距落在中位數 ±40% 內的比例」
  // 當規律性指標，既不需要知道真實尺寸，也不會懲罰畸變造成的緩慢變化。
  let regularity = 1;
  if (crossings.length >= 8) {
    const gaps = [];
    for (let i = 1; i < crossings.length; i++) gaps.push(crossings[i] - crossings[i - 1]);
    const med = [...gaps].sort((p, q) => p - q)[gaps.length >> 1] || 1;
    let good = 0;
    for (const g of gaps) if (g >= med * 0.6 && g <= med * 1.4) good++;
    regularity = good / gaps.length;
  }

  const score = contrast - 25 * Math.abs(crossings.length - expect) - 400 * (1 - regularity);
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
  const bowMax = Math.max(2.5, samples / 8 / 35);
  let best = -1;
  for (let bow = -bowMax; bow <= bowMax + 1e-6; bow += bowMax / 10) {
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

  // 搜尋範圍必須隨軌道長度成長。
  // 弓形的量測單位是「格」，而桶狀畸變讓直線鼓起來的幅度大致正比於軌道長度：
  // 100 格的軌道大約鼓 2 格，234 格的軌道就會鼓到 5 格以上。
  // 原本寫死 ±2 的時候，小網格沒問題，一換到 1920×1080 的實際尺寸
  // （234 格寬）就整個追不到軌道，症狀是「所有設定都解不開」。
  const bowMax = Math.max(2, nCells / 35);
  const coarse = bowMax / 4;

  // 粗掃再細掃，比一次掃完省一半次數而且精度更好
  let best = null;
  const tryBow = (bow) => {
    const r = traceTrackWithBow(img, mapFn, gStart, gEnd, nCells, bow, normal);
    if (r && (!best || r.score > best.score)) best = { ...r, bow };
  };
  for (let bow = -bowMax; bow <= bowMax + 1e-6; bow += coarse) tryBow(bow);
  if (best) {
    const c = best.bow, fine = coarse / 4;
    for (const d of [-3, -2, -1, 1, 2, 3]) tryBow(c + d * fine);
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
  // 這個函式是整個解碼流程最貴的一塊（2304×1296 的畫面實測 98 ms／幀，
  // 佔全程的一半），所以寫法刻意攤平：
  //
  //   1. 對應點先拆成平坦的 Float64Array，k 的每一步都不再配置任何物件。
  //      原本每個 k 都用 corr.map() 生一組新陣列 —— 101 個 k × 200 個點
  //      等於每幀丟掉兩萬個暫時陣列，光 GC 就很可觀。
  //   2. 正規方程組只算上三角（AᵀA 是對稱的），並且利用兩條列各有三個零
  //      的結構：每條列只有 5 個非零項，一個對應點只要 30 次乘法，
  //      而不是攤平前的 128 次。
  //
  // 也試過把均勻掃描換成「粗掃 + 黃金分割」（約 30 次擬合，快一倍），
  // 但那會讓結果變差：迭代之間是耦合的（這一輪的取樣器決定下一輪追到的軌道），
  // 殘差對 k 的曲線又不是乾淨的單谷，黃金分割收到的是另一個解 ——
  // 實測 234×129 的 C8 畫面殘差 0.54→0.76 px、格子錯誤 0.06%→0.98%。
  // 少算一點反而更準，是不能接受的交換，所以保留均勻掃描，只把每一步變便宜。
  const n = corr.length;
  const gx = new Float64Array(n), gy = new Float64Array(n);
  const dxn = new Float64Array(n), dyn = new Float64Array(n), r2 = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    gx[i] = corr[i].g[0]; gy[i] = corr[i].g[1];
    const dx = (corr[i].p[0] - cx) / norm, dy = (corr[i].p[1] - cy) / norm;
    dxn[i] = dx; dyn[i] = dy; r2[i] = dx * dx + dy * dy;
  }

  // AᵀA 的上三角（8×8）與 Aᵀb
  const M = new Float64Array(64);
  const Atb = new Float64Array(8);
  const ux = new Float64Array(n), uy = new Float64Array(n);

  /** 累加一條只有 5 個非零項的列：idx[] 是欄號，val[] 是值 */
  const idx1 = [0, 1, 2, 6, 7], idx2 = [3, 4, 5, 6, 7];
  const v = new Float64Array(5);
  const addSparse = (idxs, rhs) => {
    for (let a = 0; a < 5; a++) {
      const ia = idxs[a], va = v[a];
      Atb[ia] += va * rhs;
      for (let b = a; b < 5; b++) M[ia * 8 + idxs[b]] += va * v[b];
    }
  };

  let best = null;
  for (let k = -0.20; k <= 0.2001; k += 0.004) {
    // 把實測影像點去畸變（正向是 r→r(1+k·r²)，這裡取一階反解）
    for (let i = 0; i < n; i++) {
      const f = 1 + k * r2[i];
      ux[i] = cx + (dxn[i] / f) * norm;
      uy[i] = cy + (dyn[i] / f) * norm;
    }

    M.fill(0); Atb.fill(0);
    for (let i = 0; i < n; i++) {
      const x = gx[i], y = gy[i], u = ux[i], w2 = uy[i];
      v[0] = x; v[1] = y; v[2] = 1; v[3] = -u * x; v[4] = -u * y;
      addSparse(idx1, u);
      v[0] = x; v[1] = y; v[2] = 1; v[3] = -w2 * x; v[4] = -w2 * y;
      addSparse(idx2, w2);
    }
    // 補回下三角（solveLinear 需要完整矩陣）
    const A = Array.from({ length: 8 }, (_, i) => {
      const row = new Array(8);
      for (let j = 0; j < 8; j++) row[j] = j >= i ? M[i * 8 + j] : M[j * 8 + i];
      return row;
    });
    const h8 = solveLinear(A, Array.from(Atb));
    if (!h8 || h8.some((q) => !isFinite(q))) continue;
    const h = [h8[0], h8[1], h8[2], h8[3], h8[4], h8[5], h8[6], h8[7], 1];

    let err = 0;
    for (let i = 0; i < n; i++) {
      const q = applyH(h, gx[i], gy[i]);
      const ex = q[0] - ux[i], ey = q[1] - uy[i];
      err += ex * ex + ey * ey;
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
  // 在縮圖上找，找到之後把座標與尺寸乘回去。
  // 標記中心的誤差會被後面的時序軌擬合吃掉，而成本省了四分之三。
  const small = downscaleGray(gray, W, H);
  const rawFinders = findFinders(small.gray, small.W, small.H);
  const finders = small.factor === 1 ? rawFinders : rawFinders.map((c) => ({
    x: (c.x + 0.5) * small.factor - 0.5,
    y: (c.y + 0.5) * small.factor - 0.5,
    size: c.size * small.factor,
    n: c.n,
  }));
  let top4 = pickCorners(finders);
  if (!top4) {
    return { ok: false, reason: `定位標記候選不足（共 ${finders.length} 個）`, finders };
  }
  // 只精修真正要用的那四個（精修全部候選是白花時間）
  if (small.factor > 1) top4 = top4.map((c) => refineFinderCenter(gray, W, H, c));

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

  /**
   * 試一組網格尺寸：建幾何校正取樣器 → 讀標頭 → 自洽檢查 → 取樣全部格子。
   * @returns {object|null} 成功的完整結果，或 null（這組不對）
   */
  const attempt = (cols, rows, quick) => {
    const h = makeH(cols, rows);
    if (!h) return null;

    let layout;
    try { layout = layoutFactory(cols, rows, 4, 3); } catch { return null; }
    budget.left--;

    // 先用時序軌校正幾何，再讀標頭。
    // 順序很重要：桶狀畸變會讓畫面中段偏掉快一格，
    // 沒校正就直接讀標頭的話，在有鏡頭畸變時必定失敗。
    const sampler = buildSampler(img, h, layout);

    const header = readHeader(img, sampler, layout, quick);
    if (!header) return null;
    if (header.cols !== cols || header.rows !== rows) return null;   // 自我一致性檢查

    // 標頭通過 CRC 且尺寸自洽 → 這組角落與尺寸是對的
    const real = layoutFactory(header.cols, header.rows, header.sectorsX, header.sectorsY);

    // 取樣器可以直接重用。
    //
    // 上面已經檢查過 header.cols/rows 等於這組候選的 cols/rows，
    // 所以單應性完全相同；而幾何校正只用到定位標記、時序軌與色票條的位置，
    // 這些都只取決於 cols/rows，跟分區怎麼切無關。
    // 原本這裡又建了一次取樣器，那是整個解碼流程最貴的一步
    // （2304×1296 實測 130 ms），白做一遍等於把解碼時間加倍。
    const sampled = sampleAllCells(img, sampler, real, header.paletteLevel, threshold);
    return {
      ok: true, header, layout: real, ...sampled,
      homography: h, sampler, refined: sampler.refined, corners: corner,
    };
  };

  // 有提示時，先把提示的尺寸「用盡」再說 —— 快速模式和完整位移搜尋都試。
  //
  // 之前是把提示插在候選清單最前面，然後整份清單先跑一遍快速模式、
  // 再跑一遍完整模式。問題是快速模式那一遍就把工作量預算用光了，
  // 提示的完整模式永遠輪不到。症狀很好認：幾何殘差明明只有 0.69px
  // （完全正常），卻回報「畫面品質太差」——
  // 其實只差那 11 種取樣位移裡的某一種就能讓標頭 CRC 通過。
  // 提示的完整搜尋只要 11 次讀標頭，成本遠低於掃完整份候選清單。
  if (hint && hint.cols && hint.rows) {
    const r = attempt(hint.cols, hint.rows, false);
    if (r) return r;
  }

  // 兩階段：先用快速標頭讀取掃一遍（絕大多數情況這裡就中了），
  // 全部失敗才用完整的位移搜尋再掃一遍。
  for (const quick of [true, false]) {
    for (const [dc, dr] of deltas) {
      const cols = estCols + dc, rows = estRows + dr;
      if (hint && cols === hint.cols && rows === hint.rows) continue;   // 上面試過了
      if (budget.left <= 0) return { ok: false, reason: '超出工作量預算' };
      const r = attempt(cols, rows, quick);
      if (r) return r;
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
  const midOf = (arr) => {
    const sorted = [...arr].sort((p, q) => p - q);
    const dec = Math.max(1, Math.floor(sorted.length / 10));
    let lowSum = 0, highSum = 0;
    for (let i = 0; i < dec; i++) {
      lowSum += sorted[i];
      highSum += sorted[sorted.length - 1 - i];
    }
    const low = lowSum / dec, high = highSum / dec;
    return { mid: (low + high) / 2, spread: high - low };
  };

  // 二值化門檻要「就地取材」，不能整條標頭共用一個。
  //
  // 反光是局部的：亮斑底下的黑格實測會亮到 176，而畫面另一端的白格只有 195。
  // 單一門檻不管切在哪裡都會錯一大片（實測 glare=0.5 錯 69/384 位元，
  // 連三重多數決都救不回來）。試過改用 Otsu，結果更糟 ——
  // 黑格本身就被反光切成「暗黑」與「亮黑」兩群，Otsu 會去切那一刀。
  // 也試過滑動視窗，但反光半徑約 26 格，視窗要夠寬才包得到黑白兩色，
  // 一寬就又跨出了反光範圍，兩頭不討好。
  //
  // 正解是用「同一個地方的已知黑與白」當基準 —— 上色票條就緊貼在標頭上方，
  // 它把整個調色盤沿著 x 週期性重複排一遍，所以任何一段連續 8 格裡
  // 必定同時有黑和白（C4 是 4 色、C8 是 8 色，都不超過 8）。
  // 取該段的最暗與最亮當成該欄的黑白基準，兩者的中點就是門檻。
  // 反光同時打在色票條和標頭上，基準自然跟著抬高，門檻就跟著走。
  const { barTop, timingLeft, timingRight } = layout;
  const x0 = timingLeft + 1, x1 = timingRight - 1;
  const barLum = new Float64Array(x1 - x0 + 1);
  for (let x = x0; x <= x1; x++) {
    const [px, py] = sampler.map(x + 0.5, barTop + 0.5 + oy);
    const rgb = sampleCell(img, px, py, cellRadius(sampler, x, barTop));
    barLum[x - x0] = (rgb[0] + rgb[1] + rgb[2]) / 3;
  }
  // 每一欄的黑白基準：以該欄為中心取 ±8 格的最小值與最大值
  const REF_WIN = 8;
  const colMid = new Float64Array(barLum.length);
  for (let i = 0; i < barLum.length; i++) {
    let lo = Infinity, hi = -Infinity;
    for (let j = Math.max(0, i - REF_WIN); j <= Math.min(barLum.length - 1, i + REF_WIN); j++) {
      if (barLum[j] < lo) lo = barLum[j];
      if (barLum[j] > hi) hi = barLum[j];
    }
    colMid[i] = (lo + hi) / 2;
  }

  // 色票條本身要是被遮住或糊掉（動態範圍太小就是徵兆），就退回全域門檻
  const globalMid = midOf(lums);
  let barLo = Infinity, barHi = -Infinity;
  for (const v of barLum) { if (v < barLo) barLo = v; if (v > barHi) barHi = v; }
  const barUsable = barHi - barLo >= globalMid.spread * 0.4;

  const bits = new Uint8Array(need);
  for (let i = 0; i < need; i++) {
    const c = cells[i];
    const mid = barUsable
      ? colMid[Math.max(0, Math.min(colMid.length - 1, c.x - x0))]
      : globalMid.mid;
    bits[i] = lums[i] > mid ? 1 : 0;
  }

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


/* =========================================================================
 * 4b. 形狀層（實驗性）
 * =========================================================================
 * 每個資料格除了顏色，還在四個角落之一畫了一個「反色缺口」，位置帶 2 bits。
 *
 * 這一層對幾何精度的要求高了一個等級。顏色是取格子中心 ±1/3 格的平均，
 * 就算取樣點偏了 0.2 格也還是落在同一格裡；但缺口只有 0.24 格寬、
 * 中心離格心 0.28 格，取樣點偏 0.2 格就可能整個錯到隔壁的角落。
 *
 * 實測（100×64、中等失真）第一版直接照名目位置取樣的結果很能說明問題：
 *   10px 格 → 形狀錯誤 2.0%
 *   12px 格 → 4.0%
 *   16px 格 → 7.6%
 * 格子越大反而越糟，而且混淆矩陣清楚顯示是「整批往同一個方向偏」
 * （16px 時大量的「上排誤判成下排」，且集中在畫面下半）。
 * 那不是解析度不足，是幾何模型在畫面內部還有殘差 ——
 * 時序軌只圍住邊界，擬合出來的徑向係數在不同影像尺寸下實測從 0.064 漂到 0.032，
 * 邊界殘差雖然只有 0.9px，內部卻可以偏掉 0.2～0.3 格。
 * 顏色層完全看不出來（它容得下），形狀層直接被打爆。
 *
 * 對策和標頭那邊一樣：既然偏移在局部是一致的，就把它量出來再扣掉。
 * 逐分區掃一小組候選偏移，取「缺口與其他三角的對比總和」最大的那一個，
 * 然後用該偏移判讀整個分區。用對比當目標函式的好處是不需要知道正確答案。
 */
function decodeShapeLayer(img, sampler, layout, level, threshold, st) {
  const { cols } = layout;
  const nShape = shapeCount(level);
  const { symbols, lowConf, ratios, colorOf, colorRatio, shapeTodo, topLab, botLab } = st;
  const y0 = st.barTop, y1 = st.barBottom;

  const refAt = (cy) => {
    const t = Math.max(0, Math.min(1, (cy - y0) / Math.max(1, y1 - y0)));
    return topLab.map((lt, i) => [
      lt[0] * (1 - t) + botLab[i][0] * t,
      lt[1] * (1 - t) + botLab[i][1] * t,
      lt[2] * (1 - t) + botLab[i][2] * t,
    ]);
  };
  // 每一列的參考色算一次就好
  const refCache = new Map();
  const refRow = (cy) => {
    let r = refCache.get(cy);
    if (!r) { r = refAt(cy); refCache.set(cy, r); }
    return r;
  };

  /** 讀一格的缺口：回傳最佳角落、最佳與次佳的對比 */
  const readCell = (i, ox, oy) => {
    const cx = i % cols, cy = (i / cols) | 0;
    const base = refRow(cy)[colorOf[i]];
    const side = cellSide(sampler, cx, cy);
    const rad = Math.max(0.5, side * SHAPE_SIZE * 0.4);
    let bestD = -1, bestIdx = 0, secondD = -1;
    for (let sp = 0; sp < nShape; sp++) {
      const [fx, fy] = SHAPE_SPOTS[sp];
      const [qx, qy] = sampler.map(cx + fx + ox, cy + fy + oy);
      const d = deltaE(srgbToLab(sampleCell(img, qx, qy, rad)), base);
      if (d > bestD) { secondD = bestD; bestD = d; bestIdx = sp; }
      else if (d > secondD) secondD = d;
    }
    return { bestIdx, bestD, secondD };
  };

  // --- 估取樣偏移 ---
  //
  // 兩段式：先用全幀的抽樣估一個整體偏移，再逐分區在它附近小範圍微調。
  //
  // 為什麼不直接逐分區大範圍搜尋：對比這個目標函式偶爾有假的極大值，
  // 某個分區跑掉就整區報廢（實測輕微失真、12px 格時有一個分區偏到
  // 讓格子錯誤 0.24% → 2.38%、分區成功率掉到 92%）。
  // 幾何殘差在整張畫面上是連續變化的，鄰近分區的偏移不會差很多，
  // 所以用全幀的估計當錨點，可以把每個分區的搜尋範圍收得很窄。
  const sectorOf = new Int32Array(cols * layout.rows).fill(-1);
  for (let s = 0; s < layout.sectors.length; s++) {
    for (const c of layout.sectors[s].cells) sectorOf[c] = s;
  }
  const bySector = layout.sectors.map(() => []);
  for (const i of shapeTodo) {
    const s = sectorOf[i];
    if (s >= 0) bySector[s].push(i);
  }

  /**
   * 對一組格子評分「這個取樣偏移對不對」。
   *
   * 分數用「1 − 次佳/最佳」而不是「最佳 − 次佳」的絕對差，這點很關鍵：
   * 絕對差會被一個假的極大值騙走 —— 偏移一旦大到把取樣點推出格子邊界，
   * 取到的就是隔壁格子的顏色，而隔壁通常和本格差很多，
   * 於是「最佳距離」暴增、分數看起來超好，但判讀全錯。
   * 改成比值就沒這個問題：每格的貢獻被限制在 0～1 之間，
   * 靠「缺口比其他三角明顯多少」而不是「絕對差多大」來評分。
   */
  const scoreOver = (probe, ox, oy) => {
    let score = 0;
    for (const i of probe) {
      const r = readCell(i, ox, oy);
      if (r.bestD > 1e-6) score += 1 - r.secondD / r.bestD;
    }
    return score;
  };

  /** 在給定中心附近用逐步縮小的網格找最佳偏移 */
  const searchOffset = (probe, cx0, cy0, range, steps) => {
    let bestOx = cx0, bestOy = cy0, bestScore = scoreOver(probe, cx0, cy0);
    let step = range;
    for (let pass = 0; pass < steps; pass++) {
      let moved = false;
      for (const dx of [-1, 0, 1]) {
        for (const dy of [-1, 0, 1]) {
          if (dx === 0 && dy === 0) continue;
          const ox = bestOx + dx * step, oy = bestOy + dy * step;
          // 缺口跨 0.10～0.34 格，偏移超過 ±0.12 就會把取樣點壓到格子邊界外
          if (Math.abs(ox) > 0.12 || Math.abs(oy) > 0.12) continue;
          const sc = scoreOver(probe, ox, oy);
          if (sc > bestScore) { bestScore = sc; bestOx = ox; bestOy = oy; moved = true; }
        }
      }
      if (!moved) step /= 2;
    }
    return [bestOx, bestOy];
  };

  // 全幀抽樣（每 31 格取 1，抽樣夠散就夠準）
  const globalProbe = [];
  for (let k = 0; k < shapeTodo.length; k += 31) globalProbe.push(shapeTodo[k]);
  let gx = 0, gy = 0;
  if (globalProbe.length >= 8) {
    // 先粗掃一圈 ±0.16 找大致方向，再往下夾
    let bestScore = -Infinity;
    for (const ox of [-0.10, -0.05, 0, 0.05, 0.10]) {
      for (const oy of [-0.10, -0.05, 0, 0.05, 0.10]) {
        const sc = scoreOver(globalProbe, ox, oy);
        if (sc > bestScore) { bestScore = sc; gx = ox; gy = oy; }
      }
    }
    [gx, gy] = searchOffset(globalProbe, gx, gy, 0.04, 3);
  }

  // --- 在一張與分區無關的粗網格上估偏移，再逐格內插 ---
  //
  // 幾何殘差在畫面上是連續變化的，而且形狀主要來自徑向畸變的擬合誤差 ——
  // 那是個以畫面中心為中心的碗形，不是平面。所以：
  //   1. 把畫面切成 TILES_X × TILES_Y 塊（和分區切法無關），每塊各估一個偏移；
  //   2. 逐格在四個最近的塊之間做雙線性內插。
  //
  // 為什麼不逐分區估：分區只有 4×3，而且「一個分區一個偏移」會在分區邊界
  // 產生跳變；更糟的是單一分區的對比目標函式偶爾會爬到假的極大值，
  // 整區就此報廢（實測有一個分區偏到讓該區形狀錯誤 74%，其他區都在 5% 以下）。
  // 改成粗網格 + 內插之後，每一塊的估計都被鄰居的內插「稀釋」，
  // 而且塊數變多，單一塊爬錯的影響小得多。
  const TILES_X = 6, TILES_Y = 4;
  const tileCells = Array.from({ length: TILES_X * TILES_Y }, () => []);
  const tileW = cols / TILES_X, tileH = layout.rows / TILES_Y;
  for (const i of shapeTodo) {
    const tx = Math.min(TILES_X - 1, Math.floor((i % cols) / tileW));
    const ty = Math.min(TILES_Y - 1, Math.floor(((i / cols) | 0) / tileH));
    tileCells[ty * TILES_X + tx].push(i);
  }

  const tileOx = new Float64Array(TILES_X * TILES_Y).fill(gx);
  const tileOy = new Float64Array(TILES_X * TILES_Y).fill(gy);
  for (let t = 0; t < tileCells.length; t++) {
    const cells = tileCells[t];
    if (cells.length < 40) continue;
    const probe = [];
    for (let k = 0; k < cells.length; k += 9) probe.push(cells[k]);
    const [ox, oy] = searchOffset(probe, gx, gy, 0.04, 3);
    tileOx[t] = ox; tileOy[t] = oy;
  }

  /** 在塊中心之間做雙線性內插，取得某格該用的偏移 */
  const offsetAt = (cx, cy) => {
    const fx = Math.max(0, Math.min(TILES_X - 1, cx / tileW - 0.5));
    const fy = Math.max(0, Math.min(TILES_Y - 1, cy / tileH - 0.5));
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = Math.min(TILES_X - 1, x0 + 1), y1 = Math.min(TILES_Y - 1, y0 + 1);
    const ax = fx - x0, ay = fy - y0;
    const mix = (arr) =>
      (arr[y0 * TILES_X + x0] * (1 - ax) + arr[y0 * TILES_X + x1] * ax) * (1 - ay)
      + (arr[y1 * TILES_X + x0] * (1 - ax) + arr[y1 * TILES_X + x1] * ax) * ay;
    return [mix(tileOx), mix(tileOy)];
  };

  for (const i of shapeTodo) {
    const cx = i % cols, cy = (i / cols) | 0;
    const [ox, oy] = offsetAt(cx + 0.5, cy + 0.5);
    const r = readCell(i, ox, oy);
    symbols[i] = colorOf[i] * nShape + r.bestIdx;
    // 顏色與形狀兩邊都要有信心才算可信；取較差的那一邊
    const shapeRatio = r.bestD > 1e-6 ? r.secondD / r.bestD : 1;
    const worst = Math.max(colorRatio[i], shapeRatio);
    ratios[i] = worst;
    if (worst > threshold) lowConf[i] = 1;
  }
}

/** 估算某格在影像上的邊長（取寬高的較小者） */
function cellSide(sampler, x, y) {
  const [x0, y0] = sampler.map(x, y);
  const [x1, y1] = sampler.map(x + 1, y);
  const [x2, y2] = sampler.map(x, y + 1);
  return Math.min(Math.hypot(x1 - x0, y1 - y0), Math.hypot(x2 - x0, y2 - y0));
}

/**
 * 取樣所有格子並分類。
 */
function sampleAllCells(img, sampler, layout, level, threshold) {
  const { cols, rows, role } = layout;
  const palette = PALETTES[level];
  const nColor = colorCount(level), nShape = shapeCount(level);
  const N = cols * rows;

  // --- 先從色票條建立參考色 ---
  // 上下各一條，之後依格子的垂直位置在兩條之間插值，吃掉由上到下的亮度漸層。
  const refTop = new Array(nColor).fill(null).map(() => ({ r: 0, g: 0, b: 0, n: 0 }));
  const refBottom = new Array(nColor).fill(null).map(() => ({ r: 0, g: 0, b: 0, n: 0 }));

  const collectBar = (barY, acc) => {
    for (let x = 0; x < cols; x++) {
      if (role[barY * cols + x] !== ROLE.COLORBAR) continue;
      const idx = x % nColor;
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
  // 形狀層要跑第二回：先記下每格的顏色與顏色信心度
  const colorOf = nShape > 1 ? new Uint8Array(N) : null;
  const colorRatio = nShape > 1 ? new Float32Array(N) : null;
  const shapeTodo = [];

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
      const withShape = nShape > 1 && r === ROLE.DATA;
      const [px, py] = sampler.map(cx + 0.5, cy + 0.5);
      // 有形狀層時，顏色只能取中心一小塊，否則會把缺口一起平均進來
      const rad = withShape
        ? Math.max(0.5, cellSide(sampler, cx, cy) * SHAPE_COLOR_RADIUS)
        : cellRadius(sampler, cx, cy);
      const rgb = sampleCell(img, px, py, rad);
      const { symbol: colorIdx, ratio } = classify(srgbToLab(rgb), refLabs);

      if (!withShape) {
        symbols[i] = colorIdx;
        ratios[i] = ratio;
        if (ratio > threshold) lowConf[i] = 1;
        continue;
      }

      // 有形狀層時，缺口的判讀留到第二回（需要先估出該分區的取樣偏移）
      if (withShape) {
        colorOf[i] = colorIdx;
        colorRatio[i] = ratio;
        shapeTodo.push(i);
        continue;
      }

      symbols[i] = colorIdx;
      ratios[i] = ratio;
      if (ratio > threshold) lowConf[i] = 1;
    }
  }

  // --- 第二回：形狀層 ---
  if (nShape > 1 && shapeTodo.length) {
    decodeShapeLayer(img, sampler, layout, level, threshold,
                     { symbols, lowConf, ratios, colorOf, colorRatio, shapeTodo,
                       topLab, botLab, barTop: layout.barTop, barBottom: layout.barBottom });
  }

  // --- 撕裂偵測：四個角的奇偶標記應該一致 ---
  const { black, white } = monoIndices(level);
  const parityBits = layout.parity.map((p) => {
    const s = symbols[p.y * cols + p.x];
    return s === white ? 1 : (s === black ? 0 : -1);
  });

  return { symbols, lowConf, ratios, parityBits, refTopRGB: topRGB, refBottomRGB: botRGB };
}
