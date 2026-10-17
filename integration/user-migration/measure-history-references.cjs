'use strict';
// 비교 대상은 같은 합성 원문이다. 작업마다 본문을 바꿔 작업 사이의 우연한 공유를 제외한다.
const { randomBytes } = require('node:crypto');
const { open } = require('./connection.cjs');
const { metered, received } = require('./measure-retention.cjs');
const { createWriterHistoryStore } = require('../../functions/services/user-storage/writerHistoryStore');
const { createRecordStore } = require('../../functions/services/user-storage/recordStore');
const { encodeKey } = require('../../functions/services/user-storage/codec');
const { fingerprint } = require('../../functions/services/userMigrationRehearsal');
const bytes = value => Buffer.byteLength(JSON.stringify(value));
function operation(n, bodyBytes) {
  const id = n.toString(16).padStart(32, '0'), entry = { key: 'fs/users/synthetic', exists: true, token: 'before',
    value: { text: 'x'.repeat(bodyBytes), sequence: n } };
  return { id, digest: fingerprint(entry), backend: 'legacy', epoch: 1, status: 'completed', capturedSequence: n + 1,
    resources: [entry.key], changes: [entry], result: null,
    receipt: { id, digest: fingerprint(entry), changes: [{ ...entry, token: 'after' }], result: null } };
}
async function scenario(mode, bodyBytes, count) {
  const runId = randomBytes(16).toString('hex'), connection = open(runId), meter = metered(connection.targetDatabase);
  try {
    const root = `profileWriterHistory/${encodeKey(runId)}`, history = createWriterHistoryStore({ database: meter.database, runId });
    const legacy = createRecordStore({ database: meter.database, path: `${root}/operations` });
    const rx = received(), started = performance.now(), latencies = [];
    for (let n = 0; n < count; n++) {
      const op = operation(n, bodyBytes), before = performance.now();
      if (mode === 'inline-format1') await legacy.compareAndSet(op.id, 0, { format: 1, kind: 'operations', value: op, digest: fingerprint(op) });
      else await history.put('operations', op.id, op);
      latencies.push(performance.now() - before);
    }
    latencies.sort((a, b) => a - b);
    const archive = { milliseconds: performance.now() - started, containerRxBytes: received() - rx, ...meter.stats,
      p95Ms: latencies[Math.ceil(count * 0.95) - 1] };
    const tree = (await connection.targetDatabase.ref(root).get()).val();
    const storedBytes = bytes(tree), bodyCount = Object.keys(tree.bodies || {}).length;
    meter.reset(); const listingRx = received(), listingStart = performance.now(); let cursor, seen = 0;
    do {
      const page = mode === 'inline-format1' ? await history.page('operations', { cursor, limit: 7 })
        : await history.summaryPage('operations', { cursor, limit: 7 });
      seen += page.items.length; cursor = page.cursor || undefined;
    } while (cursor);
    if (seen !== count) throw Error('synthetic listing mismatch');
    const listing = { milliseconds: performance.now() - listingStart, containerRxBytes: received() - listingRx, ...meter.stats };
    // 상세/복구에 필요한 읽기는 별도로 측정하고 요약 전송량에 합산하지 않는다.
    meter.reset(); await history.get('operations', operation(0, bodyBytes).id);
    return { mode, bodyBytes, count, storedBytes, bodyCount, archive, listing, detailRead: { ...meter.stats } };
  } finally { await connection.close(); }
}
async function main() {
  const results = [];
  for (const bodyBytes of [1024, 10240, 65536]) {
    const legacy = await scenario('inline-format1', bodyBytes, 32), shared = await scenario('references-format2', bodyBytes, 32);
    results.push({ bodyBytes, legacy, shared,
      storedReductionPercent: (1 - shared.storedBytes / legacy.storedBytes) * 100,
      listingPayloadReductionPercent: (1 - shared.listing.getPayloadBytes / legacy.listing.getPayloadBytes) * 100 });
  }
  process.stdout.write(JSON.stringify({ format: 1, environment: 'isolated-demo-emulator', sampleConcurrency: 1,
    limitations: ['각 작업마다 서로 다른 본문을 사용하며 요청/확정 본문만 동일하다.',
      '새 저장량에는 본문 참조·요약 색인을 포함한다. 기존 원문의 물리 삭제/자동 이관은 하지 않는다.',
      '구형 비교 쓰기는 직접 CAS이므로 신규 보관의 승인/재조회와 지연·쓰기량을 동일 조건으로 비교하지 않는다.',
      '본문 공유 저장량과 목록 payload의 합성 비교이며 운영 청구/동시 부하/전체 서비스 비용을 입증하지 않는다.',
      '상세 조회/복구의 본문 읽기는 별도로 보고한다. SDK get/listener를 과금량으로 합산하지 않는다.'], results }, null, 2) + '\n');
}
if (require.main === module) main().catch(() => { process.stderr.write('격리된 본문 참조 측정 설정과 상태를 확인해 주세요.\n'); process.exitCode = 1; });
module.exports = { operation };
