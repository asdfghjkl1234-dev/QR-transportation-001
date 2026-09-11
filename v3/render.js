/**
 * render.js — 把一幀的格子內容畫出來
 * ===================================
 * 輸入是「每一格要用調色盤的哪個顏色」，輸出是 ImageData。
 * 這裡不碰資料編碼，只負責版面元素的圖樣與實際上色。
 *
 * 兩個關鍵要求：
 *   1. 每格必須是整數個實體像素。非整數會讓格子邊界落在半個像素上，
 *      相機拍到的就是一條漸層而不是硬邊，分類時直接糊掉。
 *   2. 關閉所有平滑處理。任何插值都會在格子交界處產生「兩色的混合色」，
 *      而那個混合色很可能剛好落在第三個顏色附近，製造出憑空的錯誤。
 */

import {
  ROLE, FINDER, HEADER_BYTES, HEADER_COPIES, PALETTES,
  finderPattern, encodeHeader,
  colorCount, shapeCount, complementIndex, SHAPE_SPOTS, SHAPE_SIZE,
} from './format.js';

/**
 * 取得某個調色盤裡「黑」與「白」的索引。
 * 定位標記、時序軌、標頭這些結構性元素一律只用黑白 ——
 * 它們必須在還沒建立顏色參考之前就能被辨識出來。
 */
export function monoIndices(level) {
  return colorCount(level) === 8 ? { black: 0, white: 7 } : { black: 0, white: 1 };
}

/**
 * 建立一整幀的顏色索引網格。
 *
 * @param {object} layout makeLayout() 的結果
 * @param {object} header 標頭欄位
 * @param {Uint8Array[]} sectorSymbols 每個分區各自的符號陣列（長度 = 該分區格數）
 * @param {number} level 調色盤等級
 * @returns {Uint8Array} 長度 cols*rows，每個元素是調色盤索引
 */
export function buildFrameGrid(layout, header, sectorSymbols, level) {
  const { cols, rows, role } = layout;
  const { black, white } = monoIndices(level);
  const grid = new Uint8Array(cols * rows).fill(white);
  const at = (x, y) => y * cols + x;

  // --- 定位標記 ---
  for (const f of layout.finders) {
    const pat = finderPattern();
    for (let dy = 0; dy < FINDER; dy++) {
      for (let dx = 0; dx < FINDER; dx++) {
        grid[at(f.x + dx, f.y + dy)] = pat(dx, dy) ? white : black;
      }
    }
  }

  // --- 分隔線：全白（定位標記的乾淨外圍）---
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (role[at(x, y)] === ROLE.SEPARATOR) grid[at(x, y)] = white;
    }
  }

  // --- 方向標記：只有右下角那一格是黑的 ---
  for (const m of layout.orientMarks) {
    grid[at(m.x, m.y)] = m.dark ? black : white;
  }

  // --- 時序軌：黑白交替。用座標和的奇偶決定，接收端才能預測應有的圖樣 ---
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (role[at(x, y)] !== ROLE.TIMING) continue;
      grid[at(x, y)] = ((x + y) & 1) ? white : black;
    }
  }

  // --- 色票參考條：整組調色盤依序循環 ---
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (role[at(x, y)] !== ROLE.COLORBAR) continue;
      grid[at(x, y)] = x % colorCount(level);
    }
  }

  // --- 標頭：黑白，整份重複 HEADER_COPIES 次 ---
  const hdr = encodeHeader(header);
  const totalBits = HEADER_BYTES * 8 * HEADER_COPIES;
  for (let i = 0; i < layout.headerCells.length; i++) {
    const c = layout.headerCells[i];
    if (i < totalBits) {
      const bitIdx = i % (HEADER_BYTES * 8);
      const bit = (hdr[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1;
      grid[at(c.x, c.y)] = bit ? white : black;
    } else {
      // 多出來的格子畫成交替圖樣，避免一大片同色影響相機曝光
      grid[at(c.x, c.y)] = ((c.x + c.y) & 1) ? white : black;
    }
  }

  // --- 撕裂偵測標記：四角各放一格，內容是幀序號的奇偶 ---
  // 相機的捲簾快門可能在一張影格裡拍到「上半是第 N 幀、下半是第 N+1 幀」。
  // 四個角的奇偶不一致就代表發生了撕裂。
  const parityBit = header.frameSeq & 1;
  for (const p of layout.parity) {
    grid[at(p.x, p.y)] = parityBit ? white : black;
  }

  // --- 資料區 ---
  for (let s = 0; s < layout.sectors.length; s++) {
    const sector = layout.sectors[s];
    const syms = sectorSymbols[s];
    if (!syms) continue;
    for (let i = 0; i < sector.cells.length; i++) {
      // 有形狀層時，符號值是「顏色 × 形狀數 + 形狀」的複合值；
      // 控制格（定位標記、時序軌、標頭…）存的一律是純顏色索引，
      // 兩者靠 role 區分（畫圖時只有 ROLE.DATA 會畫缺口）。
      grid[sector.cells[i]] = syms[i] % (colorCount(level) * shapeCount(level));
    }
  }

  return grid;
}

/**
 * 整幀四周要保留的白邊寬度（格）。
 *
 * 這不是可有可無的裝飾。定位標記是靠「掃描線上 1:1:3:1:1 的黑白跑道長度」
 * 找出來的，其中第一段就是標記最外圈那一格黑。如果畫面邊緣外面剛好是深色
 * （桌面、暗色的牆、或是模擬器裡的灰底），那一段黑就會和背景連成一片，
 * 長度暴增，比例檢查直接失敗 —— 症狀是「一個標記都找不到」。
 * 留一圈白邊就能把標記和外界隔開。QR 規格要求 4 格，這裡取 3 格已足夠。
 */
export const QUIET_CELLS = 3;

/**
 * 把顏色索引網格畫成 ImageData（四周含白邊）。
 * @param {Uint8Array} grid
 * @param {number} cols
 * @param {number} rows
 * @param {number} level
 * @param {number} cellPx 每格幾個實體像素（必須是整數）
 * @param {number} [quiet=QUIET_CELLS] 白邊寬度（格）
 * @returns {ImageData}
 */
export function gridToImageData(grid, cols, rows, level, cellPx, quiet = QUIET_CELLS, role = null) {
  const palette = PALETTES[level];
  const nShape = shapeCount(level);
  const W = (cols + quiet * 2) * cellPx;
  const H = (rows + quiet * 2) * cellPx;
  const img = new ImageData(W, H);
  const d = img.data;
  d.fill(255);   // 先整片白，白邊就出來了

  const off = quiet * cellPx;
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const i = cy * cols + cx;
      const isData = nShape > 1 && role && role[i] === ROLE.DATA;
      const colorIdx = isData ? Math.floor(grid[i] / nShape) : grid[i];
      const [r, g, b] = palette[colorIdx];
      const px0 = off + cx * cellPx, py0 = off + cy * cellPx;
      for (let dy = 0; dy < cellPx; dy++) {
        let p = ((py0 + dy) * W + px0) * 4;
        for (let dx = 0; dx < cellPx; dx++) {
          d[p] = r; d[p + 1] = g; d[p + 2] = b; d[p + 3] = 255;
          p += 4;
        }
      }
      if (!isData) continue;

      // --- 形狀層：在四個角落之一畫一個反色缺口 ---
      const [nr, ng, nb] = palette[complementIndex(level, colorIdx)];
      const spot = SHAPE_SPOTS[grid[i] % nShape];
      const side = Math.max(1, Math.round(cellPx * SHAPE_SIZE));
      const sx = px0 + Math.round(cellPx * spot[0] - side / 2);
      const sy = py0 + Math.round(cellPx * spot[1] - side / 2);
      for (let dy = 0; dy < side; dy++) {
        let p = ((sy + dy) * W + sx) * 4;
        for (let dx = 0; dx < side; dx++) {
          d[p] = nr; d[p + 1] = ng; d[p + 2] = nb; d[p + 3] = 255;
          p += 4;
        }
      }
    }
  }
  return img;
}

/**
 * 直接畫到 canvas（發送端用）。
 * @param {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} ctx
 */
export function drawGrid(ctx, grid, cols, rows, level, cellPx, quiet = QUIET_CELLS, role = null) {
  const palette = PALETTES[level];
  const nColor = colorCount(level), nShape = shapeCount(level);
  ctx.imageSmoothingEnabled = false;   // 任何插值都會在格子交界產生假的中間色

  // 白邊
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, (cols + quiet * 2) * cellPx, (rows + quiet * 2) * cellPx);

  const off = quiet * cellPx;
  const isData = (i) => nShape > 1 && role && role[i] === ROLE.DATA;
  const colorOf = (i) => (isData(i) ? Math.floor(grid[i] / nShape) : grid[i]);

  // 同色的格子一起畫，可以少掉大量的 fillStyle 切換
  for (let idx = 0; idx < nColor; idx++) {
    const [r, g, b] = palette[idx];
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const i = cy * cols + cx;
        if (colorOf(i) !== idx) continue;
        ctx.fillRect(off + cx * cellPx, off + cy * cellPx, cellPx, cellPx);
      }
    }
  }

  // --- 形狀層：缺口按反色分組畫 ---
  if (nShape > 1 && role) {
    const side = Math.max(1, Math.round(cellPx * SHAPE_SIZE));
    for (let idx = 0; idx < nColor; idx++) {
      const [r, g, b] = palette[complementIndex(level, idx)];
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      for (let cy = 0; cy < rows; cy++) {
        for (let cx = 0; cx < cols; cx++) {
          const i = cy * cols + cx;
          if (!isData(i) || colorOf(i) !== idx) continue;
          const spot = SHAPE_SPOTS[grid[i] % nShape];
          ctx.fillRect(off + cx * cellPx + Math.round(cellPx * spot[0] - side / 2),
                       off + cy * cellPx + Math.round(cellPx * spot[1] - side / 2), side, side);
        }
      }
    }
  }
}
