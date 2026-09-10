/**
 * decoder-worker.js — v3 接收端的解碼工作執行緒
 * ==============================================
 * 一整幀的解碼包含：找定位標記 → 幾何校正（含徑向畸變擬合與迭代精修）
 * → 讀標頭 → 建立顏色參考 → 逐格分類 → 去白化去交錯 → 分區 RS 解碼。
 * 實測在已知網格尺寸時約 120～250 ms，未知時第一幀要數秒。
 * 這種等級的工作絕對不能放在主執行緒上，否則相機預覽會整個凍住。
 *
 * 接收端會開 2～4 個這種 worker 組成工作池；全部忙碌時主執行緒直接丟棄影格。
 * 排隊只會讓延遲越積越大，而噴泉碼本來就不在乎丟掉哪一幀。
 */

import { decodeFrame } from './pipeline.js';
import { makeLayout } from './format.js';

/** 重複使用的畫布，避免每幀重新配置數 MB */
let canvas = null, ctx = null;

function toImageData(bitmap) {
  if (!canvas || canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
    canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  }
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
}

/**
 * 算出每個分區在影像上的四個角，供主執行緒畫框。
 * 直接回傳座標而不是回傳整個 sampler，是因為函式無法跨執行緒傳遞。
 */
function sectorQuads(layout, sampler) {
  const { cols } = layout;
  return layout.sectors.map((s) => {
    // 從分區的格子索引反推它的矩形範圍
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const c of s.cells) {
      const x = c % cols, y = (c / cols) | 0;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    return [
      sampler.map(minX, minY), sampler.map(maxX + 1, minY),
      sampler.map(maxX + 1, maxY + 1), sampler.map(minX, maxY + 1),
    ];
  });
}

self.onmessage = async (e) => {
  const { bitmap, redundancy, hint, threshold, jobId, budget } = e.data;
  const t0 = performance.now();

  let img;
  try {
    img = toImageData(bitmap);
    bitmap.close();
  } catch (err) {
    self.postMessage({ type: 'result', jobId, ok: false, reason: '影格轉換失敗' });
    return;
  }

  let res;
  try {
    res = decodeFrame(img, redundancy, { hint, confidenceThreshold: threshold, budget });
  } catch (err) {
    self.postMessage({ type: 'result', jobId, ok: false, reason: String(err && err.message || err) });
    return;
  }

  const ms = performance.now() - t0;

  if (!res.ok) {
    // 即使解不開也回傳找到的定位標記，讓主執行緒可以畫出「有看到碼」的提示
    const f = res.detection && res.detection.finders;
    self.postMessage({
      type: 'result', jobId, ok: false, ms, reason: res.reason,
      finders: f ? f.slice(0, 4).map((p) => [p.x, p.y]) : null,
    });
    return;
  }

  // 分區酬載要複製成獨立的 buffer 才能轉移
  const sectors = res.sectors.map((p) => (p ? p.slice().buffer : null));
  const quads = sectorQuads(res.layout, res.detection.sampler);

  self.postMessage({
    type: 'result', jobId, ok: true, ms,
    header: res.header,
    sectors,
    sectorOkFlags: res.sectors.map((p) => !!p),
    quads,
    torn: res.torn,
    stats: res.stats,
    rms: res.detection.sampler.rms ?? 0,
    // 低信心格的比例（抹除率），以及分區的四角，供 UI 顯示
    erasureRate: res.stats.erasureRate,
  }, sectors.filter(Boolean));
};

self.postMessage({ type: 'ready' });
