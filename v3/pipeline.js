/**
 * pipeline.js — 把格式、渲染、偵測串成「一幀進、一幀出」的完整流程
 * ================================================================
 * 模擬器、測試與實際的發送／接收端都共用這裡的兩個函式，
 * 確保三邊跑的是同一條路徑。
 */

import {
  makeLayout, frameCapacity, sectorPlan, encodeSector, decodeSector,
  whitenSeed,
} from './format.js';
import { buildFrameGrid, gridToImageData } from './render.js';
import { detectFrame } from './detect.js';

/**
 * 把每個分區的酬載編成一幀影像。
 *
 * @param {object} cfg { cols, rows, level, cellPx, sectorsX, sectorsY, redundancy }
 * @param {object} header { sessionId, frameSeq }
 * @param {Uint8Array[]} payloads 每個分區一份，長度須等於 capacity.payloadPerSector
 * @returns {{img:ImageData, grid:Uint8Array, layout:object, capacity:object}}
 */
export function encodeFrame(cfg, header, payloads) {
  const layout = makeLayout(cfg.cols, cfg.rows, cfg.sectorsX, cfg.sectorsY);
  const capacity = frameCapacity(layout, cfg.level, cfg.redundancy);

  const full = {
    sessionId: header.sessionId,
    frameSeq: header.frameSeq,
    paletteLevel: cfg.level,
    cols: cfg.cols, rows: cfg.rows,
    sectorsX: cfg.sectorsX, sectorsY: cfg.sectorsY,
  };

  const symbols = layout.sectors.map((s, i) => {
    const plan = sectorPlan(s.cells.length, cfg.level, cfg.redundancy);
    if (!plan) return new Uint8Array(s.cells.length);
    const pl = payloads[i] || new Uint8Array(capacity.payloadPerSector);
    return encodeSector(pl, plan, s.cells.length, cfg.level,
                        whitenSeed(full.sessionId, full.frameSeq, i));
  });

  const grid = buildFrameGrid(layout, full, symbols, cfg.level);
  const img = gridToImageData(grid, cfg.cols, cfg.rows, cfg.level, cfg.cellPx);
  return { img, grid, layout, capacity };
}

/**
 * 從一張影像還原出各分區的酬載。
 *
 * @param {ImageData} img
 * @param {number} redundancy 必須與編碼端相同
 * @param {object} [opts] { confidenceThreshold, hint }
 *        hint 是「已知的網格尺寸」。搜尋網格尺寸的代價很高（每組候選都要
 *        重建一次幾何校正取樣器），實測第一幀約 4.9 秒；給了提示之後降到 120 ms。
 *        接收端只要成功解出第一幀，之後就一直帶著提示，即可即時處理。
 * @returns {{ok:boolean, reason?:string, header?:object, layout?:object,
 *            sectors?:Array, stats?:object, detection?:object}}
 */
export function decodeFrame(img, redundancy, opts = {}) {
  const det = detectFrame(img, makeLayout, opts);
  if (!det.ok) return { ok: false, reason: det.reason, detection: det };

  const { header, layout, symbols, lowConf } = det;
  const level = header.paletteLevel;

  // --- 撕裂偵測 ---
  // 四個角的奇偶標記應該一致。不一致代表這張影格橫跨了兩幀
  // （捲簾快門），此時仍然逐分區嘗試解碼 —— CRC 通過的分區依然可用。
  const pb = det.parityBits.filter((b) => b >= 0);
  const torn = pb.length > 1 && !pb.every((b) => b === pb[0]);

  const sectors = [];
  let okCount = 0, totalErasures = 0, totalCorrected = 0;

  for (let i = 0; i < layout.sectors.length; i++) {
    const s = layout.sectors[i];
    const plan = sectorPlan(s.cells.length, level, redundancy);
    if (!plan) { sectors.push(null); continue; }

    const sub = new Uint8Array(s.cells.length);
    const low = [];
    for (let j = 0; j < s.cells.length; j++) {
      sub[j] = symbols[s.cells[j]];
      if (lowConf[s.cells[j]]) low.push(j);
    }
    totalErasures += low.length;

    const r = decodeSector(sub, low, plan, level,
                           whitenSeed(header.sessionId, header.frameSeq, i));
    if (r) { okCount++; totalCorrected += r.corrected; }
    sectors.push(r ? r.payload : null);
  }

  return {
    ok: true,
    header, layout, sectors, torn,
    stats: {
      sectorTotal: layout.sectors.length,
      sectorOk: okCount,
      sectorFailRate: 1 - okCount / layout.sectors.length,
      erasures: totalErasures,
      erasureRate: totalErasures / Math.max(1, det.symbols.length),
      corrected: totalCorrected,
    },
    detection: det,
  };
}
