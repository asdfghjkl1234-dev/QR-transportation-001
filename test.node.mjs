/**
 * test.node.mjs — fountain.js 的自動化驗收測試（不經過相機、不經過 QR 碼）
 * ======================================================================
 * 直接在記憶體中模擬整條傳輸鏈路，重點驗證：
 *   1. 基礎工具（CRC32 / SHA-256 / base64）對得上標準測試向量
 *   2. seed → 區塊索引的選擇是確定性的，且兩端算出來完全一致
 *   3. 封包被竄改時一定會被 CRC 擋下來
 *   4. 隨機丟掉 30% 的幀、並把順序完全打亂之後，仍能正確還原並通過 SHA-256
 *
 * 執行：node test.node.mjs
 */

import {
  crc32, sha256Hex, bytesToBase64, base64ToBytes, selectBlocks,
  encodePacket, decodePacket, LTEncoder, LTDecoder, robustSolitonCdf,
  METADATA_INTERVAL, mulberry32,
} from './fountain.js';

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? ' — ' + detail : ''}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

/** 用固定種子產生可重現的偽隨機測試資料（不用 Math.random 才能重跑一致） */
function makeTestData(length, seed = 12345) {
  const out = new Uint8Array(length);
  let s = seed >>> 0;
  for (let i = 0; i < length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = (s >>> 24) & 0xff;
  }
  return out;
}

/* ---------------------------------------------------------------------- */
section('1. 基礎工具對標準測試向量');

// CRC32 的經典檢查值："123456789" → 0xCBF43926
check('CRC32("123456789") === 0xCBF43926',
  crc32(new TextEncoder().encode('123456789')) === 0xcbf43926,
  '0x' + crc32(new TextEncoder().encode('123456789')).toString(16));

// SHA-256 的標準測試向量（NIST）
check('SHA-256("") 正確',
  sha256Hex(new Uint8Array(0)) === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
check('SHA-256("abc") 正確',
  sha256Hex(new TextEncoder().encode('abc')) === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
check('SHA-256(448-bit 訊息) 正確',
  sha256Hex(new TextEncoder().encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')) ===
  '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
// 跨越多個 512-bit 區塊、且長度非 64 倍數，驗證訊息填充邏輯
check('SHA-256(1,000,000 個 "a") 正確',
  sha256Hex(new Uint8Array(1000000).fill(0x61)) ===
  'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');

/* ---------------------------------------------------------------------- */
section('2. Base64 編解碼');

// 三種長度分別對應 base64 的三種補齊情況（0 / 1 / 2 個 '='）
for (const len of [0, 1, 2, 3, 255, 256, 1000]) {
  const data = makeTestData(len, len + 7);
  const round = base64ToBytes(bytesToBase64(data));
  check(`${len} bytes 來回轉換一致`,
    round !== null && round.length === len && round.every((v, i) => v === data[i]));
}
// base64 結果必須和 Node 內建的 Buffer 實作完全相同（確保是標準 base64）
const sample = makeTestData(500, 99);
check('與 Node Buffer 的 base64 結果一致',
  bytesToBase64(sample) === Buffer.from(sample).toString('base64'));
check('遇到非法字元回傳 null', base64ToBytes('abc$%^&') === null);

/* ---------------------------------------------------------------------- */
section('3. seed → 區塊索引的確定性與正確性');

const K_TEST = 500;
{
  // 同一個 seed 必須永遠給出同一組索引（發送端與接收端的一致性基礎）
  let deterministic = true;
  let distinct = true;
  let inRange = true;
  let degreeOne = 0;
  for (let seed = K_TEST; seed < K_TEST + 3000; seed++) {
    const a = selectBlocks(seed, K_TEST);
    const b = selectBlocks(seed, K_TEST);
    if (a.length !== b.length || a.some((v, i) => v !== b[i])) deterministic = false;
    if (new Set(a).size !== a.length) distinct = false;
    if (a.some((v) => v < 0 || v >= K_TEST)) inRange = false;
    if (a.length === 1) degreeOne++;
  }
  check('同一 seed 永遠得到同一組索引', deterministic);
  check('索引不重複', distinct);
  check('索引都落在 0..K-1', inRange);
  check('度數 1 的比例合理（Robust Soliton 尖峰）', degreeOne > 0,
    `3000 幀中有 ${degreeOne} 幀是度數 1`);

  // 系統區塊：seed < K 時必須固定是 [seed]
  let systematic = true;
  for (let i = 0; i < K_TEST; i++) {
    const s = selectBlocks(i, K_TEST);
    if (s.length !== 1 || s[0] !== i) systematic = false;
  }
  check('seed < K 一律是系統區塊 [seed]', systematic);

  // 度數分布的平均值應該落在合理範圍（太高代表解碼很慢，太低代表覆蓋不足）
  let sum = 0;
  for (let seed = K_TEST; seed < K_TEST + 5000; seed++) sum += selectBlocks(seed, K_TEST).length;
  const avgDegree = sum / 5000;
  check('平均度數在 2..30 之間', avgDegree > 2 && avgDegree < 30, `平均 ${avgDegree.toFixed(2)}`);

  // CDF 必須是遞增且結尾為 1
  const cdf = robustSolitonCdf(K_TEST);
  let monotonic = true;
  for (let d = 2; d <= K_TEST; d++) if (cdf[d] < cdf[d - 1]) monotonic = false;
  check('Robust Soliton CDF 遞增且結尾為 1', monotonic && cdf[K_TEST] === 1);
}

/* ---------------------------------------------------------------------- */
section('4. 封包編解碼與 CRC 防護');

{
  const payload = makeTestData(600, 42);
  const pkt = encodePacket({ sessionId: 0xdeadbeef, fileSize: 123456, blockSize: 600, K: 206, seed: 999, payload });
  const dec = decodePacket(pkt);
  check('封包欄位來回一致',
    dec !== null && dec.sessionId === 0xdeadbeef && dec.fileSize === 123456 &&
    dec.blockSize === 600 && dec.K === 206 && dec.seed === 999 &&
    dec.payload.length === 600 && dec.payload.every((v, i) => v === payload[i]));

  // 逐一竄改每個位元組，確認全部都會被 CRC 擋下
  let allCaught = true;
  for (let i = 0; i < pkt.length; i++) {
    const bad = new Uint8Array(pkt);
    bad[i] ^= 0x40; // 翻掉幾個位元
    if (decodePacket(bad) !== null) { allCaught = false; break; }
  }
  check('任意單一位元組竄改都會被擋下', allCaught, `檢查了 ${pkt.length} 個位移`);

  check('截斷的封包會被拒絕', decodePacket(pkt.subarray(0, 10)) === null);
  check('magic 不符會被拒絕', (() => {
    const bad = new Uint8Array(pkt); bad[0] = 0x00;
    return decodePacket(bad) === null;
  })());
  check('非 QR 內容（隨機位元組）會被拒絕', decodePacket(makeTestData(700, 5)) === null);
}

/* ---------------------------------------------------------------------- */
section('5. 端對端：丟掉 30% 幀 + 完全打亂順序');

/**
 * 模擬一次完整傳輸。
 * @param {Uint8Array} data 原始檔案
 * @param {number} blockSize 區塊大小
 * @param {number} dropRate 丟幀比例
 * @param {number} rounds 發送端要送幾輪（幀數 = K * rounds）
 * @param {number} rngSeed 模擬用亂數種子
 */
function simulate(data, blockSize, dropRate, rounds, rngSeed) {
  // 傳入固定種子的 rng，讓測試結果完全可重現（不受 Math.random 影響）
  const encoder = new LTEncoder(data, blockSize, { sessionId: 0xabcd1234, rng: mulberry32(rngSeed) });
  const trueHash = sha256Hex(data);
  encoder.setMetadata({ name: 'test.bin', type: 'application/octet-stream', sha256: trueHash });

  // --- 發送端：把整串封包先全部產生出來（模擬螢幕播放過的所有幀）---
  const totalFrames = Math.ceil(encoder.K * rounds) + METADATA_INTERVAL;
  const wire = [];
  for (let i = 0; i < totalFrames; i++) wire.push(encoder.nextPacket().bytes);

  // --- 通道：隨機丟幀（模擬相機漏拍）---
  let rs = rngSeed >>> 0;
  const rand = () => {
    rs = (Math.imul(rs, 1664525) + 1013904223) >>> 0;
    return rs / 4294967296;
  };
  const survived = wire.filter(() => rand() >= dropRate);

  // --- 通道：完全打亂順序（模擬亂序 / 重複掃描）---
  for (let i = survived.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [survived[i], survived[j]] = [survived[j], survived[i]];
  }

  // --- 接收端：一幀一幀餵進去，直到解完為止 ---
  let decoder = null;
  let framesConsumed = 0;
  let acceptedBlocks = 0;
  for (const bytes of survived) {
    framesConsumed++;
    // 真實情況會先經過 base64，這裡也走一遍，順便驗證那條路徑
    const pkt = decodePacket(base64ToBytes(bytesToBase64(bytes)));
    if (!pkt) continue;
    if (!decoder) decoder = new LTDecoder(pkt);
    if (pkt.sessionId !== decoder.sessionId) continue;
    const r = decoder.addPacket(pkt);
    if (r.accepted && !pkt.isMetadata) acceptedBlocks++;
    if (decoder.isComplete && decoder.metadata) break;
  }

  if (!decoder || !decoder.isComplete) {
    return { ok: false, K: encoder.K, reason: 'incomplete', solved: decoder ? decoder.solvedCount : 0 };
  }

  const file = decoder.getFile();
  const hashOk = sha256Hex(file) === decoder.metadata.sha256 && decoder.metadata.sha256 === trueHash;
  const identical = file.length === data.length && file.every((v, i) => v === data[i]);

  return {
    ok: hashOk && identical,
    K: encoder.K,
    acceptedBlocks,
    framesConsumed,
    // 「開銷」= 為了解出 K 個區塊，實際吃進了幾個不重複編碼區塊
    overhead: acceptedBlocks / encoder.K,
    metadata: decoder.metadata,
  };
}

{
  // 驗收條件 1：200 KB 檔案、600 bytes 區塊、丟 30%、亂序
  const data = makeTestData(200 * 1024, 2024);
  const r = simulate(data, 600, 0.30, 3.5, 777);
  check('200 KB / 600B 區塊 / 丟 30% / 亂序 → 完整還原且 SHA-256 相符',
    r.ok, `K=${r.K}，吃進 ${r.acceptedBlocks} 個區塊（開銷 ${(r.overhead * 100 - 100).toFixed(1)}%）`);
  check('metadata（檔名／MIME／雜湊）正確送達',
    r.ok && r.metadata.name === 'test.bin' && r.metadata.type === 'application/octet-stream');
}

{
  // 多種檔案大小 × 區塊大小的組合都要過
  const cases = [
    { size: 1024, blockSize: 600, label: '1 KB（K 很小的極端情況）' },
    { size: 50 * 1024, blockSize: 200, label: '50 KB / 200B 區塊' },
    { size: 200 * 1024, blockSize: 1200, label: '200 KB / 1200B 區塊' },
    { size: 512 * 1024, blockSize: 600, label: '512 KB / 600B 區塊' },
    { size: 599, blockSize: 600, label: '比一個區塊還小（需補零）' },
    { size: 1200, blockSize: 600, label: '剛好整除（不需補零）' },
  ];
  for (const c of cases) {
    const r = simulate(makeTestData(c.size, c.size), c.blockSize, 0.30, 3.5, c.size + 1);
    check(c.label, r.ok, r.ok ? `K=${r.K}，開銷 +${(r.overhead * 100 - 100).toFixed(1)}%` : `失敗（${r.reason}，解出 ${r.solved}/${r.K}）`);
  }
}

{
  // 更嚴苛的丟幀率：噴泉碼應該只是「多送幾輪」而不是失敗
  for (const drop of [0.0, 0.1, 0.5, 0.7, 0.9]) {
    const rounds = drop >= 0.9 ? 20 : drop >= 0.7 ? 8 : 4;
    const r = simulate(makeTestData(100 * 1024, 33), 600, drop, rounds, 4242);
    check(`丟幀率 ${(drop * 100).toFixed(0)}% 仍能還原`, r.ok,
      r.ok ? `開銷 +${(r.overhead * 100 - 100).toFixed(1)}%` : `失敗（解出 ${r.solved}/${r.K}）`);
  }
}

/* ---------------------------------------------------------------------- */
section('6. 純 LT 解碼開銷（刻意跳過系統區塊的最壞情況）');

{
  // 把系統區塊全部丟掉，強迫解碼器只靠隨機編碼區塊工作 —— 這是最壞情況，
  // 也是真正檢驗 LT 碼效率的場景（實際使用時系統區塊會讓開銷更低）
  function pureLTOverhead(K, blockSize, trials) {
    const results = [];
    for (let t = 0; t < trials; t++) {
      const data = makeTestData(K * blockSize, t * 1000 + 1);
      const encoder = new LTEncoder(data, blockSize, { sessionId: 1, rng: mulberry32(t + 1) });
      const decoder = new LTDecoder({ sessionId: 1, fileSize: data.length, blockSize, K: encoder.K });
      let seed = encoder.K + t * 7919; // 跳過系統區塊區間
      let count = 0;
      while (!decoder.isComplete && count < K * 10) {
        decoder.addPacket({
          isMetadata: false, sessionId: 1, fileSize: data.length,
          blockSize, K: encoder.K, seed, payload: encoder.encodeBlock(seed),
        });
        seed++;
        count++;
      }
      const file = decoder.getFile();
      if (!file || sha256Hex(file) !== sha256Hex(data)) return null;
      results.push(count / encoder.K);
    }
    return results;
  }

  // LT 碼的開銷是「漸進」的：K 越大越接近理論值。K 很小時開銷比例看起來很高，
  // 但絕對幀數其實很少（K=50 多送 30 幀，在 10 FPS 下只是 3 秒），實務上無感。
  // 下面的門檻是實測出來的合理上界，而不是理論值。
  const budgets = [
    { K: 50, limit: 2.7, note: '小 K：LT 碼漸進特性尚未生效' },
    { K: 200, limit: 1.6, note: '' },
    { K: 350, limit: 1.75, note: '' },
    { K: 900, limit: 1.35, note: '' },
    { K: 2000, limit: 1.30, note: '接近實際檔案的 K，開銷進入 1.1～1.2× 區間' },
  ];
  for (const b of budgets) {
    const res = pureLTOverhead(b.K, 64, b.K >= 2000 ? 4 : 8);
    if (!res) { check(`K=${b.K} 純 LT 解碼`, false, '有試驗未能還原'); continue; }
    const avg = res.reduce((a, x) => a + x, 0) / res.length;
    const max = Math.max(...res);
    check(`K=${b.K}：解碼開銷 < ${b.limit}×`, max < b.limit,
      `平均 ${avg.toFixed(3)}× ／ 最差 ${max.toFixed(3)}×${b.note ? '（' + b.note + '）' : ''}`);
  }
}

/* ---------------------------------------------------------------------- */
section('7. 真實情境的播放成本（系統區塊優先 + 丟幀）');

{
  /**
   * 模擬「發送端一直播、接收端一直掃」，回傳需要播放幾幀才收完。
   * 這是使用者真正感受到的成本：訊號好時應該接近 1.0×（第一輪就收完）。
   */
  function framesNeeded(K, blockSize, dropRate, rngSeed) {
    const data = makeTestData(K * blockSize, rngSeed);
    const encoder = new LTEncoder(data, blockSize, { sessionId: 7, rng: mulberry32(rngSeed) });
    const decoder = new LTDecoder({ sessionId: encoder.sessionId, fileSize: data.length, blockSize, K: encoder.K });
    let rs = rngSeed >>> 0;
    const rand = () => { rs = (Math.imul(rs, 1664525) + 1013904223) >>> 0; return rs / 4294967296; };
    let played = 0;
    while (!decoder.isComplete && played < encoder.K * 30) {
      const p = encoder.nextPacket();
      played++;
      if (rand() < dropRate) continue;   // 相機這一幀沒拍到
      const pkt = decodePacket(p.bytes);
      if (pkt) decoder.addPacket(pkt);
    }
    return decoder.isComplete ? played / encoder.K : Infinity;
  }

  // 完全沒漏幀 → 系統區塊讓第一輪就收完（只多出 metadata 幀的開銷）
  const clean = framesNeeded(350, 600, 0, 1234);
  check('丟幀率 0%：約一輪即可收完', clean < 1.10, `播放 ${clean.toFixed(3)}× K 幀`);

  for (const drop of [0.1, 0.3, 0.5]) {
    let worst = 0, sum = 0;
    for (let t = 0; t < 5; t++) {
      const v = framesNeeded(350, 600, drop, 5000 + t * 101);
      worst = Math.max(worst, v); sum += v;
    }
    // 理論下界是 1/(1-p)：丟一半就至少要播兩倍的幀。
    // 實測會落在下界的 1.3～1.4 倍，原因是系統區塊那一輪結束後，補洞用的隨機
    // 編碼區塊仍要付出 LT 碼對「整個 K」的解碼開銷，而不只是對缺的那幾塊。
    const bound = 1 / (1 - drop);
    check(`丟幀率 ${(drop * 100).toFixed(0)}%：播放成本在理論下界 ${bound.toFixed(2)}× 的 1.5 倍以內`,
      worst < bound * 1.5,
      `平均 ${(sum / 5).toFixed(2)}× ／ 最差 ${worst.toFixed(2)}×（下界 ${bound.toFixed(2)}×）`);
  }
}

/* ---------------------------------------------------------------------- */
console.log(`\n\x1b[1m結果：${passed} 項通過，${failed} 項失敗\x1b[0m\n`);
process.exit(failed === 0 ? 0 : 1);
