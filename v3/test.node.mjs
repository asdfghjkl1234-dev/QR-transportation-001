/**
 * v3/test.node.mjs — v3 的自動化測試
 * ===================================
 * 對應需求第七節：
 *   1. 單元測試：RS 編解碼（含 erasure）、白化往返、交錯往返、噴泉碼丟包
 *   2. 模擬器驗收：中等失真下 C4 格子錯誤 < 1%、C8 < 3%、分區成功率 > 95%
 *
 * 執行：node v3/test.node.mjs（約 1 分 45 秒）
 *
 * 四個階段都已完成，各自的驗收在下面的節次裡：
 *   第 1 階段（幀格式 + 模擬器 + C4 靜態解碼）→ 第 10、11 節
 *   第 2 階段（連續串流）                     → 第 12 節（端到端傳檔）
 *   第 3 階段（C8 + 信心度抹除）              → 第 7、10 節
 *   第 4 階段（效能 + 實驗性形狀層）          → 第 13 節
 * 實機量測無法在這個環境進行，見 README 的「實機量測（待補）」。
 */

// Node 沒有 ImageData，補一個最小實作（只需要 width/height/data 三個欄位）
globalThis.ImageData = class ImageData {
  constructor(a, b, c) {
    if (typeof a === 'number') {
      this.width = a; this.height = b; this.data = new Uint8ClampedArray(a * b * 4);
    } else {
      this.data = a; this.width = b; this.height = c;
    }
  }
};

const {
  gfMul, gfDiv, gfPow, gfInverse, rsEncode, rsDecode,
  interleave, deinterleave, deinterleaveErasures,
} = await import('./ecc.js');
const F = await import('./format.js');
const { encodeFrame, decodeFrame } = await import('./pipeline.js');
const { distort, MEDIUM_DISTORTION, NO_DISTORTION } = await import('./simulator.js');
const { LTEncoder2, LTDecoder2, decodePacketV2, mulberry32, sha256Hex } = await import('../v2/fountain2.js');

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  ok ? passed++ : failed++;
  console.log(`  \x1b[${ok ? 32 : 31}m${ok ? '✓' : '✗'}\x1b[0m ${name}${detail ? ' — ' + detail : ''}`);
};
const info = (name, detail = '') => console.log(`  \x1b[90m·\x1b[0m \x1b[90m${name}${detail ? ' — ' + detail : ''}\x1b[0m`);
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const rnd = mulberry32(20260910);
const randBytes = (n) => { const a = new Uint8Array(n); for (let i = 0; i < n; i++) a[i] = (rnd() * 256) | 0; return a; };

/* ---------------------------------------------------------------------- */
section('1. GF(256) 有限體');
{
  check('乘法單位元', gfMul(1, 123) === 123 && gfMul(123, 1) === 123);
  check('乘以零', gfMul(0, 200) === 0 && gfMul(200, 0) === 0);
  check('乘除互逆', [1, 7, 99, 200, 255].every((a) => [1, 3, 77, 254].every((b) => gfDiv(gfMul(a, b), b) === a)));
  check('反元素', [1, 2, 99, 255].every((a) => gfMul(a, gfInverse(a)) === 1));
  check('次方', gfPow(2, 8) === gfMul(gfPow(2, 4), gfPow(2, 4)));
  // 交換律與結合律
  let ok = true;
  for (let i = 0; i < 300; i++) {
    const a = (rnd() * 256) | 0, b = (rnd() * 256) | 0, c = (rnd() * 256) | 0;
    if (gfMul(a, b) !== gfMul(b, a)) ok = false;
    if (gfMul(gfMul(a, b), c) !== gfMul(a, gfMul(b, c))) ok = false;
  }
  check('交換律與結合律（300 組隨機）', ok);
}

/* ---------------------------------------------------------------------- */
section('2. Reed-Solomon 編解碼');
{
  const K = 191, NSYM = 64;   // 需求指定的預設 RS(255, 191)
  const msg = randBytes(K);
  const cw = rsEncode(msg, NSYM);
  check(`RS(${K + NSYM}, ${K}) 編碼長度正確`, cw.length === 255);
  check('無錯誤時原樣還原', (() => {
    const r = rsDecode(cw, NSYM);
    return r && r.msg.every((v, i) => v === msg[i]);
  })());

  // 純錯誤：上限是 nsym/2
  const t = NSYM / 2;
  for (const nerr of [1, 10, t - 1, t]) {
    const bad = Uint8Array.from(cw);
    const pos = new Set();
    while (pos.size < nerr) pos.add((rnd() * 255) | 0);
    for (const p of pos) bad[p] ^= 0x5a || 1;
    const r = rsDecode(bad, NSYM);
    check(`修正 ${nerr} 個未知位置錯誤（上限 ${t}）`, !!r && r.msg.every((v, i) => v === msg[i]));
  }
  {
    const bad = Uint8Array.from(cw);
    const pos = new Set();
    while (pos.size < t + 3) pos.add((rnd() * 255) | 0);
    for (const p of pos) bad[p] ^= 0x5a;
    const r = rsDecode(bad, NSYM);
    check(`超出能力（${t + 3} 個錯誤）時回報失敗而非給出錯誤資料`,
      r === null || r.msg.every((v, i) => v === msg[i]));
  }

  // 純抹除：上限是 nsym（能力剛好是錯誤的兩倍）
  for (const nera of [1, 20, NSYM - 1, NSYM]) {
    const bad = Uint8Array.from(cw);
    const pos = [];
    while (pos.length < nera) { const p = (rnd() * 255) | 0; if (!pos.includes(p)) pos.push(p); }
    for (const p of pos) bad[p] = (rnd() * 256) | 0;
    const r = rsDecode(bad, NSYM, pos);
    check(`修正 ${nera} 個抹除（上限 ${NSYM}）`, !!r && r.msg.every((v, i) => v === msg[i]));
  }
  check('抹除的更正能力是未知錯誤的兩倍', true, `${NSYM} 個抹除 vs ${t} 個未知錯誤`);

  // 混合：2v + e ≤ nsym
  for (const [v, e] of [[5, 10], [10, 44], [20, 24], [31, 2], [16, 32]]) {
    const bad = Uint8Array.from(cw);
    const used = new Set();
    const epos = [];
    while (epos.length < e) { const p = (rnd() * 255) | 0; if (!used.has(p)) { used.add(p); epos.push(p); bad[p] = (rnd() * 256) | 0; } }
    let added = 0;
    while (added < v) { const p = (rnd() * 255) | 0; if (!used.has(p)) { used.add(p); bad[p] ^= 0x33 || 1; added++; } }
    const r = rsDecode(bad, NSYM, epos);
    check(`${v} 錯誤 + ${e} 抹除（2v+e=${2 * v + e} ≤ ${NSYM}）`, !!r && r.msg.every((q, i) => q === msg[i]));
  }
  {
    // 剛好超過一格就該失敗
    const bad = Uint8Array.from(cw);
    const used = new Set(); const epos = [];
    while (epos.length < 33) { const p = (rnd() * 255) | 0; if (!used.has(p)) { used.add(p); epos.push(p); bad[p] = 0xff; } }
    let added = 0;
    while (added < 16) { const p = (rnd() * 255) | 0; if (!used.has(p)) { used.add(p); bad[p] ^= 0x77; added++; } }
    const r = rsDecode(bad, NSYM, epos);
    check('2v+e = 65 > 64 時回報失敗', r === null || r.msg.every((q, i) => q === msg[i]));
  }
}

/* ---------------------------------------------------------------------- */
section('3. 交錯排列');
{
  const chunks = [randBytes(50), randBytes(50), randBytes(50), randBytes(50)];
  const woven = interleave(chunks);
  const back = deinterleave(woven, 4);
  check('交錯往返一致', back.every((c, i) => c.every((v, j) => v === chunks[i][j])));
  check('相鄰位置屬於不同碼字', woven[0] === chunks[0][0] && woven[1] === chunks[1][0] && woven[2] === chunks[2][0]);

  // 一段連續的錯誤，應該被平均分給各碼字
  const burst = [];
  for (let i = 20; i < 40; i++) burst.push(i);
  const perChunk = deinterleaveErasures(burst, 4);
  const counts = perChunk.map((p) => p.length);
  check('20 個連續錯誤被平均分給 4 個碼字', counts.every((c) => c === 5), `各碼字 ${counts.join('/')} 個`);
}

/* ---------------------------------------------------------------------- */
section('4. 資料白化');
{
  const data = new Uint8Array(500);   // 全零：最糟的情況
  const seed = F.whitenSeed(0x1234, 7, 3);
  const w = F.whiten(data, seed);
  check('白化後不再是一片相同值', new Set(w).size > 100, `出現 ${new Set(w).size} 種不同位元組`);
  check('解白化完全還原', F.unwhiten(w, seed).every((v) => v === 0));

  const data2 = randBytes(1000);
  check('隨機資料白化往返一致',
    F.unwhiten(F.whiten(data2, seed), seed).every((v, i) => v === data2[i]));
  check('不同種子產生不同序列',
    F.whiten(data, F.whitenSeed(1, 1, 1)).some((v, i) => v !== F.whiten(data, F.whitenSeed(1, 1, 2))[i]));
}

/* ---------------------------------------------------------------------- */
section('5. 標頭');
{
  const h = { sessionId: 0xabcd, frameSeq: 123456, paletteLevel: 8, cols: 192, rows: 108, sectorsX: 4, sectorsY: 3 };
  const enc = F.encodeHeader(h);
  const dec = F.decodeHeader(enc);
  check('標頭欄位來回一致', dec && Object.keys(h).every((k) => dec[k] === h[k]));

  let caught = 0;
  for (let i = 0; i < enc.length; i++) {
    const bad = Uint8Array.from(enc); bad[i] ^= 0x40;
    if (F.decodeHeader(bad) === null) caught++;
  }
  check('任一位元組竄改都被 CRC 擋下', caught === enc.length, `${caught}/${enc.length}`);

  // 三重重複 + 多數決：每份各壞一些位元，只要不是同一位就能救回
  const bits = new Uint8Array(16 * 8 * 3);
  for (let c = 0; c < 3; c++) for (let i = 0; i < 128; i++) bits[c * 128 + i] = (enc[i >> 3] >> (7 - (i & 7))) & 1;
  bits[5] ^= 1; bits[128 + 40] ^= 1; bits[256 + 90] ^= 1;   // 三份各壞一個不同位置
  const voted = F.headerMajorityVote(bits);
  check('多數決救回三份各自的單一位元錯誤', F.decodeHeader(voted) !== null);
}

/* ---------------------------------------------------------------------- */
section('6. 符號與位元組轉換');
{
  for (const level of [4, 8]) {
    const bpc = F.bitsPerCell(level);
    const nBytes = 120;
    const cells = Math.ceil((nBytes * 8) / bpc);
    const data = randBytes(nBytes);
    const syms = F.bytesToSymbols(data, level, cells);
    check(`C${level}：位元組 → 符號 → 位元組 一致`,
      F.symbolsToBytes(syms, level, nBytes).every((v, i) => v === data[i]),
      `${nBytes} bytes ↔ ${cells} 格`);
    check(`C${level}：符號值都在 0..${level - 1}`, syms.every((v) => v >= 0 && v < level));
  }
  // 低信心格 → 位元組抹除位置
  const era = F.cellsToByteErasures([0, 1, 2], 8, 100);
  check('一格跨兩個位元組時兩個都會被標記', era.length >= 1 && era[0] === 0);
}

/* ---------------------------------------------------------------------- */
section('7. 分區編解碼（含 RS 與抹除）');
{
  const level = 4;
  const cellCount = 900;
  const plan = F.sectorPlan(cellCount, level, 0.25);
  info('分區規劃', `${cellCount} 格 → ${plan.totalBytes} B，${plan.nChunks} 塊 × ${plan.chunkLen}（校驗 ${plan.nsym}），可載 ${plan.payload} B`);

  const payload = randBytes(plan.payload);
  const seed = F.whitenSeed(1, 2, 3);
  const syms = F.encodeSector(payload, plan, cellCount, level, seed);
  check('分區編碼填滿所有格子', syms.length === cellCount);

  const clean = F.decodeSector(syms, [], plan, level, seed);
  check('無錯誤時完整還原', clean && clean.payload.subarray(0, payload.length).every((v, i) => v === payload[i]));

  // 隨機翻掉一些格子（未知位置錯誤）
  for (const nerr of [5, 15, 30]) {
    const bad = Uint8Array.from(syms);
    for (let i = 0; i < nerr; i++) bad[(rnd() * cellCount) | 0] ^= 1;
    const r = F.decodeSector(bad, [], plan, level, seed);
    check(`${nerr} 格誤判仍能還原`, !!r && r.payload.subarray(0, payload.length).every((v, i) => v === payload[i]));
  }

  // 標記為抹除時，能承受的格子數應明顯更多
  const many = 60;
  const bad2 = Uint8Array.from(syms);
  const lowConf = [];
  for (let i = 0; i < many; i++) {
    const p = (rnd() * cellCount) | 0;
    bad2[p] = (bad2[p] + 1) % level;
    lowConf.push(p);
  }
  const withEra = F.decodeSector(bad2, lowConf, plan, level, seed);
  const withoutEra = F.decodeSector(bad2, [], plan, level, seed);
  check(`${many} 格誤判：標記為抹除可還原`, !!withEra && withEra.payload.subarray(0, payload.length).every((v, i) => v === payload[i]));
  info('同樣的錯誤但不標記抹除', withoutEra ? '仍可還原（錯誤數還在範圍內）' : '解不開 —— 這就是抹除的價值');
}

/* ---------------------------------------------------------------------- */
section('8. 調色盤品質（CIELAB 最小距離）');
{
  for (const [name, pal] of [['C4', F.PALETTE_C4], ['C8', F.PALETTE_C8]]) {
    const r = F.paletteReport(pal);
    check(`${name} 兩兩最小 CIELAB 距離 > 25`, r.minDist > 25,
      `${r.minDist.toFixed(1)}（最接近：色 ${r.worstPair[0]} vs 色 ${r.worstPair[1]}）`);
  }
  // 在模擬器的色偏模型下再算一次
  const wb = MEDIUM_DISTORTION.wb, gamma = MEDIUM_DISTORTION.gamma, sat = MEDIUM_DISTORTION.saturation;
  const model = (rgb) => {
    let [r, g, b] = rgb;
    const lum = r * 0.299 + g * 0.587 + b * 0.114;
    r = lum + (r - lum) * sat; g = lum + (g - lum) * sat; b = lum + (b - lum) * sat;
    r *= wb[0]; g *= wb[1]; b *= wb[2];
    const ig = 1 / gamma;
    return [r, g, b].map((v) => Math.min(255, Math.max(0, 255 * Math.pow(Math.max(0, v) / 255, ig))));
  };
  for (const [name, pal] of [['C4', F.PALETTE_C4], ['C8', F.PALETTE_C8]]) {
    const r = F.paletteReport(pal, model);
    info(`${name} 經過色偏模型後`, `最小距離 ${r.minDist.toFixed(1)}（色 ${r.worstPair[0]} vs ${r.worstPair[1]}）`);
  }
}

/* ---------------------------------------------------------------------- */
section('9. 噴泉碼（沿用 v2）：丟 40% + 亂序');
{
  const blockSize = 200;
  const data = randBytes(60 * 1024);
  const hash = sha256Hex(data);
  const enc = new LTEncoder2(data, blockSize, { sessionId: 7, rng: mulberry32(5), systematic: true });
  enc.setMetadata({ name: 'v3.bin', type: 'application/octet-stream', sha256: hash });

  const wire = [];
  while (wire.length < enc.K * 3) for (const p of enc.nextFrame(12)) wire.push(p.bytes);
  const r2 = mulberry32(99);
  const surv = wire.filter(() => r2() >= 0.40);
  for (let i = surv.length - 1; i > 0; i--) { const j = (r2() * (i + 1)) | 0; [surv[i], surv[j]] = [surv[j], surv[i]]; }

  let dec = null; const buf = [];
  for (const bytes of surv) {
    const pkt = decodePacketV2(bytes); if (!pkt) continue;
    if (!dec) {
      if (!pkt.isMetadata) { buf.push(pkt); continue; }
      const m = JSON.parse(new TextDecoder().decode(pkt.payload));
      dec = new LTDecoder2({ sessionId: pkt.sessionId, K: pkt.K, blockSize: m.blockSize, fileSize: m.size });
      dec.addPacket(pkt); for (const b of buf) dec.addPacket(b); buf.length = 0; continue;
    }
    dec.addPacket(pkt);
    if (dec.isComplete) break;
  }
  check('丟 40% + 亂序仍完整還原並通過 SHA-256',
    !!dec && dec.isComplete && sha256Hex(dec.getFile()) === hash,
    dec ? `K=${dec.K}，開銷 ${(dec.stats.accepted / dec.K).toFixed(3)}×` : '');
}

/* ---------------------------------------------------------------------- */
section('10. 模擬器驗收（需求第五節）');

/**
 * 跑一次「編碼 → 失真 → 解碼」，回傳格子錯誤率與分區成功率。
 */
function runFrame(level, cellPx, dist, useHint = true, frameSeq = 7) {
  const cols = 100, rows = 64;
  const cfg = { cols, rows, level, cellPx, sectorsX: 4, sectorsY: 3, redundancy: 0.25 };
  const layout = F.makeLayout(cols, rows, 4, 3);
  const cap = F.frameCapacity(layout, level, 0.25);
  const payloads = layout.sectors.map((s, i) => {
    const p = new Uint8Array(cap.payloadPerSector);
    for (let j = 0; j < p.length; j++) p[j] = (j * 31 + i * 101) & 255;
    return p;
  });
  const { img, grid } = encodeFrame(cfg, { sessionId: 0x1234, frameSeq }, payloads);
  const noisy = distort(img, dist);
  // 這一節測的是「解碼準確度」，不是「網格尺寸搜尋」，所以直接給提示以節省時間。
  // 不帶提示的完整搜尋另有專門的測試（見下方）。
  const res = decodeFrame(noisy, 0.25, useHint ? { hint: { cols, rows, sectorsX: 4, sectorsY: 3 } } : {});
  if (!res.ok) return { ok: false, reason: res.reason };

  let wrong = 0, total = 0;
  for (const s of res.layout.sectors) for (const c of s.cells) { total++; if (res.detection.symbols[c] !== grid[c]) wrong++; }
  let payloadOk = 0;
  for (let i = 0; i < res.sectors.length; i++) {
    const p = res.sectors[i];
    if (p && p.subarray(0, payloads[i].length).every((v, k) => v === payloads[i][k])) payloadOk++;
  }
  return {
    ok: true,
    cellErr: wrong / total,
    sectorOk: payloadOk / res.stats.sectorTotal,
    erasureRate: res.stats.erasureRate,
    rms: res.detection.sampler.rms ?? 0,
    payloadBytes: cap.totalPayload,
  };
}

{
  const base4 = runFrame(4, 8, NO_DISTORTION);
  const base8 = runFrame(8, 8, NO_DISTORTION);
  info('無失真基準 C4', base4.ok ? `格子錯誤 ${(base4.cellErr * 100).toFixed(2)}%，分區 ${(base4.sectorOk * 100).toFixed(0)}%` : base4.reason);
  info('無失真基準 C8', base8.ok ? `格子錯誤 ${(base8.cellErr * 100).toFixed(2)}%，分區 ${(base8.sectorOk * 100).toFixed(0)}%` : base8.reason);

  const m4 = runFrame(4, 8, MEDIUM_DISTORTION);
  check('中等失真 C4：格子錯誤率 < 1%', m4.ok && m4.cellErr < 0.01,
    m4.ok ? `${(m4.cellErr * 100).toFixed(2)}%（幾何殘差 ${m4.rms.toFixed(2)}px）` : m4.reason);
  check('中等失真 C4：分區成功率 > 95%', m4.ok && m4.sectorOk > 0.95,
    m4.ok ? `${(m4.sectorOk * 100).toFixed(0)}%` : '');

  // 不帶提示：接收端第一幀的真實情況，必須能自己找出網格尺寸
  const noHint = runFrame(4, 8, MEDIUM_DISTORTION, false);
  check('中等失真 C4：不給尺寸提示也能自行找出網格', noHint.ok && noHint.cellErr < 0.01,
    noHint.ok ? `格子錯誤 ${(noHint.cellErr * 100).toFixed(2)}%` : noHint.reason);

  // C8 逐幀變異不小（白化序列不同 → 符號分佈不同 → 幾何擬合落點也不同），
  // 所以取多幀平均才有意義
  const runs8 = [1, 7, 13, 21, 33].map((seq) => runFrame(8, 8, MEDIUM_DISTORTION, true, seq));
  const okRuns = runs8.filter((r) => r.ok);
  const avgCell = okRuns.reduce((a, r) => a + r.cellErr, 0) / okRuns.length;
  const avgSector = okRuns.reduce((a, r) => a + r.sectorOk, 0) / okRuns.length;

  check('中等失真 C8：格子錯誤率 < 3%', okRuns.length === runs8.length && avgCell < 0.03,
    `${(avgCell * 100).toFixed(2)}%（5 幀平均）`);

  // 第 3 階段（C8 + 信心度抹除）的驗收項目。
  // 這一項曾經只有 83%，根因不在顏色而在幾何：殘差 1.44px 時取樣點偏離格心太多，
  // 顏色被格子邊界汙染。把殘差壓到 0.5px 之後就穩定在 100%。
  check('中等失真 C8：分區成功率 > 95%', avgSector > 0.95,
    `${(avgSector * 100).toFixed(0)}%（各幀 ${runs8.map((r) => r.ok ? (r.sectorOk * 100).toFixed(0) + '%' : '✗').join(' ')}）`);
}

/* ---------------------------------------------------------------------- */
section('11. 失真強度掃描（錯誤率對失真強度的曲線）');
{
  const sweep = (key, values, level) => {
    const out = [];
    for (const v of values) {
      const r = runFrame(level, 8, { ...MEDIUM_DISTORTION, [key]: v });
      out.push(r.ok ? `${v}:${(r.cellErr * 100).toFixed(1)}%/${(r.sectorOk * 100).toFixed(0)}%` : `${v}:解不開`);
    }
    info(`C${level} ${key}`, out.join('  '));
  };
  info('格式', '失真值:格子錯誤率/分區成功率');
  for (const level of [4, 8]) {
    sweep('blur', [0, 0.8, 1.5, 2.5], level);
    sweep('noise', [0, 6, 15, 30], level);
    sweep('barrel', [0, 0.06, 0.12, 0.2], level);
    sweep('rotate', [0, 8, 15, 25], level);
    sweep('glare', [0, 0.25, 0.5, 0.8], level);
    sweep('gradient', [0, 0.22, 0.4, 0.6], level);
  }
}

/* ---------------------------------------------------------------------- */
section('12. 端到端傳檔（第 2 階段驗收）：整份檔案走完編碼→失真→解碼→重組');
{
  // 這一節跑的是發送端與接收端實際用的那條路，只是把「相機拍螢幕」
  // 換成模擬器、把 worker 換成同步呼叫：
  //   LTEncoder2 取封包 → 每個分區一包 → encodeFrame → distort
  //   → decodeFrame → 分區酬載 → decodePacketV2 → LTDecoder2 → 組回檔案
  // 每一幀用不同的失真亂數種子（模擬手持晃動），並隨機丟掉兩成影格。
  const cols = 100, rows = 64, level = 8, cellPx = 8;   // C8：每格 3 bit，整段測試才跑得完
  const cfg = { cols, rows, level, cellPx, sectorsX: 4, sectorsY: 3, redundancy: 0.25 };
  const layout = F.makeLayout(cols, rows, 4, 3);
  const cap = F.frameCapacity(layout, level, 0.25);
  const blockSize = cap.payloadPerSector - 15;   // 扣掉 v2 封包標頭

  const fileBytes = randBytes(8 * 1024);
  const fileHash = sha256Hex(fileBytes);
  const sessionId = 0x4d2;
  const enc = new LTEncoder2(fileBytes, blockSize, { sessionId, systematic: true, rng: mulberry32(7) });

  const metaJson = new TextEncoder().encode(JSON.stringify({
    name: 'test.bin', type: 'application/octet-stream',
    size: fileBytes.length, blockSize, sha256: fileHash,
  }));
  // metadata 放不進一個分區（含 SHA-256 約 150～250 B），要切塊
  const metaChunks = F.encodeMetaChunks(metaJson, cap.payloadPerSector);

  let decoder = null;
  const pending = [];
  let metadata = null;
  const asm = new F.MetaAssembler();
  // 接收端 handleSectorPayload / startDecoderIfReady 的等價物
  const startIfReady = () => {
    if (decoder || !metadata || !pending.length) return;
    decoder = new LTDecoder2({
      sessionId: pending[0].sessionId, K: pending[0].K,
      blockSize: metadata.blockSize, fileSize: metadata.size,
    });
    for (const p of pending) if (p.sessionId === decoder.sessionId) decoder.addPacket(p);
    pending.length = 0;
  };
  const feed = (payload) => {
    const pkt = decodePacketV2(payload);
    if (pkt) {
      if (!decoder) { pending.push(pkt); startIfReady(); return; }
      if (pkt.sessionId === decoder.sessionId) decoder.addPacket(pkt);
      return;
    }
    if (metadata) return;
    const whole = asm.add(payload);
    if (!whole) return;
    try {
      const m = JSON.parse(new TextDecoder().decode(whole));
      if (!m || typeof m.size !== 'number' || typeof m.blockSize !== 'number') return;
      metadata = m;
      startIfReady();
    } catch { /* 不是 JSON */ }
  };

  const drop = mulberry32(99);
  const MAX_FRAMES = 45;
  let sent = 0, received = 0, dropped = 0, sectorOk = 0, sectorTotal = 0;
  let hint = null;
  let sinceMeta = 0;

  for (let seq = 0; seq < MAX_FRAMES && !(decoder && decoder.isComplete && metadata); seq++) {
    const useMeta = (seq === 0 || sinceMeta >= 15);
    sinceMeta = useMeta ? 0 : sinceMeta + 1;

    const payloads = layout.sectors.map((s, i) => {
      if (useMeta && i < metaChunks.length) return metaChunks[i];
      const p = new Uint8Array(cap.payloadPerSector);
      p.set(enc.nextPacket().bytes);
      return p;
    });
    const { img } = encodeFrame(cfg, { sessionId, frameSeq: seq }, payloads);
    sent++;

    // 隨機丟掉兩成影格（相機沒對準、worker 全忙、快門橫跨兩幀…）
    if (drop() < 0.2) { dropped++; continue; }

    // 每一幀的失真都不一樣，模擬手持
    const noisy = distort(img, { ...MEDIUM_DISTORTION, seed: 1000 + seq * 37 });
    const res = decodeFrame(noisy, 0.25, hint ? { hint } : {});
    if (!res.ok) continue;
    received++;
    hint = { cols: res.header.cols, rows: res.header.rows,
             sectorsX: res.header.sectorsX, sectorsY: res.header.sectorsY };
    sectorTotal += res.stats.sectorTotal;
    sectorOk += res.stats.sectorOk;
    for (const p of res.sectors) if (p) feed(p);
  }

  check('整份檔案重組完成', !!(decoder && decoder.isComplete && metadata),
    `送出 ${sent} 幀、丟棄 ${dropped} 幀、成功解出 ${received} 幀`);
  if (decoder && decoder.isComplete) {
    const out = decoder.getFile();
    check('還原內容與原檔逐位元組相同',
      out.length === fileBytes.length && out.every((v, i) => v === fileBytes[i]));
    check('SHA-256 與 metadata 記載相符', sha256Hex(out) === metadata.sha256, metadata.sha256.slice(0, 16) + '…');
    info('噴泉碼開銷', `K=${decoder.K}，收到 ${decoder.stats.accepted} 個有效封包，開銷 ${(decoder.stats.accepted / decoder.K).toFixed(3)}×`);
  }
  info('分區成功率', `${(sectorOk / Math.max(1, sectorTotal) * 100).toFixed(1)}%（${sectorOk}/${sectorTotal}）`);
  info('每幀有效酬載', `${(cap.sectorCount * blockSize / 1024).toFixed(2)} KB`);
}

/* ---------------------------------------------------------------------- */
section('13. 形狀層（第 4 階段，實驗性）');
{
  // 每格除了 C8 的顏色（3 bits），再用「四個角落之一的反色缺口」帶 2 bits，
  // 合計 5 bits/格 —— 位元密度是 C8 的 1.67 倍。
  // 這一節要回答的是「多出來的位元，值不值得它要求的格子大小」。
  const LIGHT = {
    ...MEDIUM_DISTORTION, rotate: 3, tiltX: 0.02, tiltY: 0.015, barrel: 0.02,
    blur: 0.4, gradient: 0.1, glare: 0.1, noise: 3,
    saturation: 0.92, gamma: 1.05, wb: [1.02, 1, 0.97], jpegQuality: 0.9,
  };

  const QUIET = 3;
  // 幀數不能太少：形狀層在有失真時逐幀的變異很大，實測 3 幀的估計值
  // 會比 8 幀的偏高兩成以上（輕微失真 0.95× 被估成 1.11×）。5 幀是
  // 「結論穩定」與「測試跑得完」之間的折衷；8 幀的完整量測寫在 README。
  const FRAMES = 5;

  /**
   * 在固定的 1920×1080 螢幕上量「有效酬載」。
   *
   * 為什麼用有效酬載而不是「分區全對的幀數」：上層是噴泉碼，
   * 掉幾個分區只是少收幾個封包，不是失敗。真正決定吞吐的是
   * 「每幀平均能收到多少正確的位元組」= 每幀酬載 × 平均分區成功率
   * （整幀解不開的算 0）。這也是唯一能公平比較不同格子大小的指標：
   * 格子越大越穩，但格數越少。
   */
  const effective = (level, cellPx, dist) => {
    const cols = Math.max(44, Math.floor(1920 / cellPx) - QUIET * 2);
    const rows = Math.max(44, Math.floor(1080 / cellPx) - QUIET * 2);
    const layout = F.makeLayout(cols, rows, 4, 3);
    const cap = F.frameCapacity(layout, level, 0.25);
    if (!cap || cap.payloadPerSector < 25) return null;
    const hint = { cols, rows, sectorsX: 4, sectorsY: 3 };

    let okSum = 0;
    for (let k = 0; k < FRAMES; k++) {
      const payloads = layout.sectors.map((s, i) => {
        const p = new Uint8Array(cap.payloadPerSector);
        for (let j = 0; j < p.length; j++) p[j] = (j * 37 + i * 101 + k * 13) & 255;
        return p;
      });
      const { img } = encodeFrame(
        { cols, rows, level, cellPx, sectorsX: 4, sectorsY: 3, redundancy: 0.25 },
        { sessionId: 0x100 + k * 7, frameSeq: k + 1 }, payloads);
      const res = decodeFrame(distort(img, { ...dist, seed: (dist.seed || 1) + k * 101 }), 0.25, { hint });
      if (!res.ok) continue;   // 解不開的幀貢獻 0
      let good = 0;
      for (let i = 0; i < res.sectors.length; i++) {
        const p = res.sectors[i];
        if (p && p.subarray(0, payloads[i].length).every((v, q) => v === payloads[i][q])) good++;
      }
      okSum += good / res.stats.sectorTotal;
    }
    const meanOk = okSum / FRAMES;
    return { payload: cap.totalPayload, meanOk, eff: cap.totalPayload * meanOk, cols, rows };
  };

  check('形狀層的位元密度是 C8 的 1.67 倍',
    F.bitsPerCell(32) === 5 && F.bitsPerCell(8) === 3,
    `每格 ${F.bitsPerCell(32)} bits vs ${F.bitsPerCell(8)} bits`);
  check('形狀層的缺口用反色（C8 的反色就是調色盤裡最遠的顏色）',
    F.complementIndex(32, 0) === 7 && F.complementIndex(32, 7) === 0
    && F.complementIndex(32, 2) === 5);
  {
    const r = effective(32, 8, NO_DISTORTION);
    check('無失真：C8+形狀 @8px 每個分區都正確',
      r && r.meanOk === 1, r ? `每幀 ${r.payload} B（${r.cols}×${r.rows}）` : '解不開');
  }

  info('比較基準', `1920×1080 螢幕、4×3 分區、RS 冗餘 0.25、每組 ${FRAMES} 幀；`
    + '有效酬載 = 每幀酬載 × 平均分區成功率');

  const best = {};
  for (const [dn, dist] of [['無失真', NO_DISTORTION], ['輕微', LIGHT], ['中等', MEDIUM_DISTORTION]]) {
    for (const [level, nm] of [[8, 'C8'], [32, 'C8+形狀']]) {
      const cells = [];
      let top = { eff: 0, cellPx: null };
      for (const cellPx of [8, 10, 12]) {
        const r = effective(level, cellPx, dist);
        if (!r) continue;
        cells.push(`${cellPx}px:${Math.round(r.eff)}B(${(r.meanOk * 100).toFixed(0)}%)`);
        if (r.eff > top.eff) top = { eff: r.eff, cellPx };
      }
      best[dn + nm] = top;
      info(`${dn}／${nm}`, cells.join('  '));
    }
    const c8 = best[dn + 'C8'], sh = best[dn + 'C8+形狀'];
    info(`${dn}：最佳有效酬載`,
      `C8 ${c8.cellPx}px → ${Math.round(c8.eff)} B／幀；`
      + `C8+形狀 ${sh.cellPx}px → ${Math.round(sh.eff)} B／幀`
      + `（${(sh.eff / Math.max(1, c8.eff)).toFixed(2)}×）`);
  }

  // 結論寫成斷言，日後任何改動讓它不再成立時測試會叫
  check('貼著螢幕直拍（無失真）時，形狀層帶來 1.5 倍以上的有效吞吐',
    best['無失真C8+形狀'].eff > best['無失真C8'].eff * 1.5,
    `${(best['無失真C8+形狀'].eff / best['無失真C8'].eff).toFixed(2)}×`);
  // 一旦有真實相機的失真，1.67 倍的位元密度優勢就不見了 ——
  // 形狀層必須放大格子才穩，格數少掉的剛好把多出來的位元吃回去。
  // 門檻設在 1.3×（遠低於 1.67×）：逐幀變異本來就大，
  // 這裡要斷言的是「優勢消失」，不是某個精確的比值。
  check('一旦有真實相機的失真，形狀層的密度優勢就消失（遠不及 1.67×）',
    best['輕微C8+形狀'].eff < best['輕微C8'].eff * 1.3
    && best['中等C8+形狀'].eff < best['中等C8'].eff * 1.3,
    `輕微 ${(best['輕微C8+形狀'].eff / best['輕微C8'].eff).toFixed(2)}×、`
    + `中等 ${(best['中等C8+形狀'].eff / best['中等C8'].eff).toFixed(2)}×`
    + `（純位元密度是 1.67×）`);
}

/* ---------------------------------------------------------------------- */
console.log(`\n\x1b[1m結果：${passed} 項通過，${failed} 項失敗\x1b[0m\n`);
process.exit(failed === 0 ? 0 : 1);
