'use strict';
const { randomBytes } = require('node:crypto');
const { isDeepStrictEqual: same } = require('node:util');
const { encodeKey } = require('./user-storage/codec');
const { createStorageAccess } = require('./user-storage/storageAccess');
const { fingerprint } = require('./userMigrationRehearsal');
const { measure } = require('./inventoryRequestTiming');
const MAX_BYTES = 8 * 1024 * 1024;
const valid = value => Number.isSafeInteger(value) && value >= 0;
const failure = () => Object.assign(new Error('인벤토리 조회 복사본을 사용할 수 없습니다.'), { code: 'INVENTORY_READ_SNAPSHOT_INVALID' });
const newer = (a, b) => a?.epoch > b.epoch || a?.epoch === b.epoch && a?.revision > b.revision;

// 원본/권한/영수증이 아닌 파생 자료다. 이 저장의 승인 유실은 canonical
// writer 연결을 uncertain으로 만들지 않으며 독자는 항상 현재 원본과 대조한다.
function createInventoryReadSnapshots({ database, runId, getWriter, verifyBlob, timeoutMs = 10000, maxBytes = MAX_BYTES }) {
  if (!/^[a-f0-9]{32}$/.test(runId) || typeof getWriter !== 'function' || typeof verifyBlob !== 'function'
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES) throw failure();
  const access = createStorageAccess({ database, timeoutMs });
  const requests = createStorageAccess({ database, timeoutMs: Math.min(timeoutMs, 1000) });
  const base = `inventoryReadSnapshots/${encodeKey(runId)}`;
  const requestBase = `inventoryReadSnapshotRequests/${encodeKey(runId)}`;
  const target = (root, uid) => `${root}/${encodeKey(uid)}`;
  function scope(uid, head, allowDeleted = false) {
    const writer = getWriter();
    if (!writer || writer.backend !== 'rtdb' || writer.phase !== 'accepting' || !valid(writer.epoch) || writer.epoch < 1
        || !head.exists && !(allowDeleted && head.revision > 0) || !valid(head.revision) || head.revision < 1
        || !valid(head.generation) || head.generation > head.revision) return;
    return { userKey: encodeKey(uid), runId, epoch: writer.epoch, revision: head.revision,
      generation: head.generation, exists: head.exists, manifest: fingerprint(head.value) };
  }
  function unpack(uid, head, raw) {
    const source = scope(uid, head);
    if (!source || !raw || raw.format !== 1 || !same(raw.source, source)
        || typeof raw.payload !== 'string' || Buffer.byteLength(raw.payload) > maxBytes) return;
    const payload = JSON.parse(raw.payload), manifest = head.value;
    if (!same(payload.header, manifest.header) || !Array.isArray(payload.cards)
        || payload.cards.length !== (manifest.cards?.count ?? 0)) throw failure();
    const blobs = Object.create(null);
    const refs = Object.entries(manifest.cards || {}).filter(([hash]) => hash.startsWith('h'));
    if (refs.length !== payload.cards.length) throw failure();
    for (const [hash, ref] of refs) {
      const value = payload.cards[ref.o];
      verifyBlob(value, ref.v);
      blobs[hash] = value;
    }
    // 주소·번호·위치·집계는 호출자의 hydrateInventory가 원본과 같은 검사를 수행한다.
    return blobs;
  }
  return {
    load: uid => measure('inventory.read_view', () => access.read(target(base, uid))),
    unpack,
    async request(uid, head, known) {
      const source = scope(uid, head);
      if (!source || head.value?.type !== 'inventory-parts' || !head.value.apiSummary) return;
      if (known?.format === 1 && known.oversize === true && same(known.source, source)) return;
      const value = { format: 1, source, nonce: randomBytes(16).toString('hex') };
      return measure('inventory.view_request', () => requests.guarded(database.ref(target(requestBase, uid)).transaction(current => {
        if (current?.format === 1 && newer(current.source, source)) return;
        return value;
      }, undefined, false), false));
    },
    async save(uid, captured) {
      const source = scope(uid, captured.head, true);
      if (!source) return { status: 'skipped' };
      const cards = [];
      for (const [hash, ref] of Object.entries(captured.head.value.cards || {}).filter(([key]) => key.startsWith('h'))) {
        const value = captured.blobs[hash]; verifyBlob(value, ref.v); cards[ref.o] = value;
      }
      const payload = captured.head.exists ? JSON.stringify({ header: captured.head.value.header, cards }) : null;
      // 문자열 escape와 메타정보를 포함한 실제 전송 JSON 크기를 제한한다.
      const oversized = !!payload && Buffer.byteLength(JSON.stringify({ format: 1, source, payload })) > maxBytes;
      const value = { format: 1, source, payload: oversized ? null : payload, ...(oversized ? { oversize: true } : {}) };
      // 늦은 이전 이벤트는 더 새 revision/epoch의 복사본을 덮지 못한다.
      const saved = await access.guarded(database.ref(target(base, uid)).transaction(current => {
        if (current?.format === 1 && newer(current.source, source)) return;
        if (same(current, value)) return;
        return value;
      }, undefined, false), false);
      return { status: oversized ? 'oversize' : saved.committed ? 'stored' : 'unchanged' };
    },
  };
}
module.exports = { createInventoryReadSnapshots, MAX_BYTES };
