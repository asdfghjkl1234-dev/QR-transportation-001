/**
 * encoder-worker.js — v3 發送端的編碼工作執行緒
 * ==============================================
 * 一幀要做的事：從噴泉碼編碼器取 12 個封包 → 每個做 RS 編碼與交錯 →
 * 白化 → 轉成格子符號 → 畫成整幀影像。
 * 這在主執行緒做會直接吃掉整個幀預算（實測一幀約 15～40 ms），
 * 所以搬到 worker，並預先做好 30 幀放進緩衝區。
 *
 * 輸出是 ImageBitmap，尺寸就是「1 格 = cellPx 個實體像素」的最終尺寸 ——
 * 主執行緒只要 drawImage 貼上去即可，不需要任何縮放。
 */

import {
  makeLayout, frameCapacity, sectorPlan, encodeSector, whitenSeed,
} from './format.js';
import { buildFrameGrid, QUIET_CELLS } from './render.js';
import { PALETTES } from './format.js';
import { LTEncoder2 } from '../v2/fountain2.js';
import { sha256Hex } from '../fountain.js';

let encoder = null;      // 噴泉碼編碼器
let layout = null;
let capacity = null;
let cfg = null;
let sessionId = 0;
let frameSeq = 0;
let metadataPayload = null;
let sinceMetadata = 0;

/** 每隔多少幀，在其中一個分區放入 metadata */
const METADATA_EVERY_FRAMES = 15;

/**
 * 直接把顏色索引網格畫成 ImageBitmap。
 * 這裡不用 gridToImageData 再貼上去，而是直接寫 ImageData 的位元組，
 * 因為一幀有數萬格、每格數十像素，少一次複製就少一次數 MB 的搬運。
 */
function gridToBitmap(grid, cols, rows, level, cellPx) {
  const palette = PALETTES[level];
  const quiet = QUIET_CELLS;
  const W = (cols + quiet * 2) * cellPx;
  const H = (rows + quiet * 2) * cellPx;

  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d', { alpha: false });
  const img = ctx.createImageData(W, H);
  const d = img.data;
  d.fill(255);   // 白邊

  const off = quiet * cellPx;
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const [r, g, b] = palette[grid[cy * cols + cx]];
      const px0 = off + cx * cellPx, py0 = off + cy * cellPx;
      for (let dy = 0; dy < cellPx; dy++) {
        let p = ((py0 + dy) * W + px0) * 4;
        for (let dx = 0; dx < cellPx; dx++) {
          d[p] = r; d[p + 1] = g; d[p + 2] = b;
          p += 4;
        }
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return { bitmap: canvas.transferToImageBitmap(), W, H };
}

/** 產生一幀 */
function produceFrame() {
  const seq = frameSeq++;

  // 每 15 幀讓第 0 個分區改放 metadata。
  // 為什麼不另外做一種「metadata 幀」：那會浪費整整一幀。
  // 只借用一個分區的話，同一幀的其他 11 個分區照常送資料。
  const useMetadata = metadataPayload && (sinceMetadata >= METADATA_EVERY_FRAMES || seq === 0);
  if (useMetadata) sinceMetadata = 0; else sinceMetadata++;

  const symbols = [];
  let dataSectors = 0;
  for (let i = 0; i < layout.sectors.length; i++) {
    const s = layout.sectors[i];
    const plan = sectorPlan(s.cells.length, cfg.level, cfg.redundancy);
    if (!plan) { symbols.push(new Uint8Array(s.cells.length)); continue; }

    let payload;
    if (useMetadata && i === 0) {
      payload = new Uint8Array(capacity.payloadPerSector);
      payload.set(metadataPayload.subarray(0, payload.length));
    } else {
      // 每個分區承載一個噴泉碼編碼區塊
      payload = encoder.nextPacket().bytes;
      dataSectors++;
      if (payload.length < capacity.payloadPerSector) {
        const padded = new Uint8Array(capacity.payloadPerSector);
        padded.set(payload);
        payload = padded;
      }
    }
    symbols.push(encodeSector(payload, plan, s.cells.length, cfg.level,
                              whitenSeed(sessionId, seq, i)));
  }

  const grid = buildFrameGrid(layout, {
    sessionId, frameSeq: seq, paletteLevel: cfg.level,
    cols: cfg.cols, rows: cfg.rows, sectorsX: cfg.sectorsX, sectorsY: cfg.sectorsY,
  }, symbols, cfg.level);

  const { bitmap, W, H } = gridToBitmap(grid, cfg.cols, cfg.rows, cfg.level, cfg.cellPx);
  return { bitmap, frameSeq: seq, dataSectors, W, H };
}

self.onmessage = (e) => {
  const msg = e.data;

  if (msg.type === 'init') {
    cfg = msg.cfg;
    sessionId = msg.sessionId & 0xffff;
    frameSeq = 0;
    sinceMetadata = 0;

    layout = makeLayout(cfg.cols, cfg.rows, cfg.sectorsX, cfg.sectorsY);
    capacity = frameCapacity(layout, cfg.level, cfg.redundancy);

    // 噴泉碼的區塊大小 = 一個分區能載的位元組數 − v2 封包標頭（15 bytes）
    const blockSize = capacity.payloadPerSector - 15;
    if (blockSize < 8) {
      self.postMessage({ type: 'error', message: `分區太小（每分區僅 ${capacity.payloadPerSector} B）` });
      return;
    }

    encoder = new LTEncoder2(msg.data, blockSize, {
      sessionId,
      systematic: cfg.systematic !== false,
    });
    // v3 的 metadata 直接放在分區裡，不走 v2 的封包內建機制
    metadataPayload = new TextEncoder().encode(JSON.stringify({
      name: msg.meta.name,
      type: msg.meta.type,
      size: msg.data.length,
      blockSize,
      sha256: sha256Hex(msg.data),
    }));

    self.postMessage({
      type: 'ready',
      K: encoder.K,
      blockSize,
      payloadPerSector: capacity.payloadPerSector,
      sectorCount: capacity.sectorCount,
      bytesPerFrame: (capacity.sectorCount - 0) * blockSize,
      dataCells: capacity.dataCells,
      frameW: (cfg.cols + QUIET_CELLS * 2) * cfg.cellPx,
      frameH: (cfg.rows + QUIET_CELLS * 2) * cfg.cellPx,
    });
    return;
  }

  if (msg.type === 'produce') {
    const frames = [];
    const transfer = [];
    for (let i = 0; i < msg.count; i++) {
      const f = produceFrame();
      frames.push(f);
      transfer.push(f.bitmap);
    }
    self.postMessage({ type: 'frames', frames }, transfer);
    return;
  }
};
