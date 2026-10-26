'use strict';
const { encodeKey } = require('./user-storage/codec');
const { fingerprint } = require('./userMigrationRehearsal');
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const fail = () => Object.assign(new Error('멤버십 영수증의 확정 기록과 보관 본문을 대조해야 합니다.'), { code: 'WRITER_NATIVE_RECEIPT_CONFLICT' });
const compact = hex => Buffer.from(hex, 'hex').toString('base64url');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const idCheck = id => { if (!/^[a-f0-9]{32}$/.test(id || '')) throw fail(); };
function isReference(raw) { return !!raw && (own(raw, 'v') || own(raw, 'h') || own(raw, 'd')); }
function checkReference(raw, expectedDigest) {
  if (!raw || raw.v !== 1 || Object.keys(raw).sort().join(',') !== 'd,h,v'
      || !digest(expectedDigest) || raw.d !== compact(expectedDigest)
      || typeof raw.h !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(raw.h)
      || Buffer.from(raw.h, 'base64url').toString('base64url') !== raw.h) throw fail();
}
function reference(raw) { return { v: 1, d: compact(raw.digest), h: compact(fingerprint(raw)) }; }

// 본문을 불변 주소에 먼저 저장하고 이력/원문 대조 뒤 부모 CAS로 참조만 남긴다.
// 실행 중/취소/투영은 제외한다. 영구 참조가 늦은 commit의 재적용도 막는다.
function createMembershipReceiptArchive({ database, access, history, location, uidFor, decodeReceipt, checkCommand }) {
  const archiveRef = (key, id) => { idCheck(id); return database.ref(`membershipWriterReceiptArchive/${encodeKey(uidFor(key))}/${id}`); };
  async function resolve(key, id, expectedDigest, raw) {
    if (!isReference(raw)) return raw;
    idCheck(id); checkReference(raw, expectedDigest);
    const saved = (await access.guarded(archiveRef(key, id).get(), false)).val();
    if (!saved || saved.format !== 1 || Object.keys(saved).sort().join(',') !== 'format,receipt'
        || compact(fingerprint(saved.receipt)) !== raw.h) throw fail();
    decodeReceipt(saved.receipt, id, expectedDigest);
    return saved.receipt;
  }
  async function archiveConfirmed(operations, { apply = true } = {}) {
    if (!history?.get || !Array.isArray(operations) || operations.length > 128 || typeof apply !== 'boolean') throw fail();
    const grouped = new Map(), ids = new Set();
    for (const candidate of operations) {
      // 구형 CLI/역전환은 완료 작업을 journal/history에서 반환한다. 투영 ID는 옮기지 않는다.
      if (candidate?.backend !== 'rtdb' || candidate.status !== 'completed' || candidate.details?.kind !== 'membership') continue;
      idCheck(candidate.id); if (ids.has(candidate.id)) throw fail(); ids.add(candidate.id);
      const saved = await history.get('operations', candidate.id);
      if (!saved || fingerprint(saved) !== fingerprint(candidate) || !Number.isSafeInteger(saved.capturedSequence) || saved.capturedSequence < 1) throw fail();
      const cmd = checkCommand(saved), key = cmd.nonce.key, uid = uidFor(key);
      if (!digest(saved.digest) || saved.receipt?.id !== saved.id || saved.receipt.digest !== saved.digest) throw fail();
      const group = grouped.get(uid) || { key, operations: [] }; group.operations.push(saved); grouped.set(uid, group);
    }
    const result = { eligible: ids.size, moved: 0, alreadyArchived: 0, missing: 0, beforeBytes: 0, afterBytes: 0 };
    for (const { key, operations: batch } of grouped.values()) {
      const loc = location(key), parent = (await access.guarded(loc.parent.get(), false)).val() || {}, selected = [];
      result.beforeBytes += Buffer.byteLength(JSON.stringify(parent));
      for (const op of batch) {
        const raw = parent.membershipWriterReceipts?.[op.id];
        if (!raw) { result.missing++; continue; }
        const body = await resolve(key, op.id, op.digest, raw);
        if (body.kind !== 'write' || fingerprint(decodeReceipt(body, op.id, op.digest)) !== fingerprint(op.receipt)) throw fail();
        if (isReference(raw)) { result.alreadyArchived++; continue; }
        const marker = reference(body); selected.push({ id: op.id, body, marker });
      }
      if (!apply) {
        for (const item of selected) parent.membershipWriterReceipts[item.id] = item.marker;
        result.afterBytes += Buffer.byteLength(JSON.stringify(parent)); continue;
      }
      // 서로 다른 불변 주소만 최대4개 병렬 처리하며 실패 때도 모두 회수한다.
      let next = 0, error;
      await Promise.all(Array.from({ length: Math.min(4, selected.length) }, async () => {
        while (!error && next < selected.length) {
          const item = selected[next++];
          try {
            const ref = archiveRef(key, item.id), envelope = { format: 1, receipt: item.body };
            const written = await access.guarded(ref.transaction(raw => raw == null ? envelope : undefined, undefined, false), true);
            const stored = written.committed ? written.snapshot.val() : (await access.guarded(ref.get(), false)).val();
            if (fingerprint(stored) !== fingerprint(envelope)) throw fail();
            // ACK 뒤에도 독립 fresh read로 불변 본문을 대조한다.
            const readback = await resolve(key, item.id, item.body.digest, item.marker);
            if (fingerprint(readback) !== fingerprint(item.body)) throw fail();
          } catch (caught) { error ||= caught; }
        }
      }));
      if (error) throw error;
      if (!selected.length) { result.afterBytes += Buffer.byteLength(JSON.stringify(parent)); continue; }
      let callbackError, listener, updated;
      try {
      await access.guarded(new Promise((resolve, reject) => { listener = () => resolve(); loc.parent.on('value', listener, reject); }), false);
      updated = await access.guarded(loc.parent.transaction(raw => {
        callbackError = undefined;
        try {
          access.ensureUsable();
          for (const item of selected) {
            const current = raw?.membershipWriterReceipts?.[item.id];
            if (!current || fingerprint(current) !== fingerprint(item.body) && fingerprint(current) !== fingerprint(item.marker)) throw fail();
          }
          for (const item of selected) raw.membershipWriterReceipts[item.id] = item.marker;
          return raw;
        } catch (caught) { callbackError = caught; return undefined; }
      }, undefined, false), true);
      } finally { if (listener) loc.parent.off('value', listener); }
      if (callbackError) throw callbackError;
      if (!updated.committed) throw fail();
      const committed = updated.snapshot.val();
      for (const item of selected) if (fingerprint(committed.membershipWriterReceipts?.[item.id]) !== fingerprint(item.marker)) throw fail();
      result.moved += selected.length; result.afterBytes += Buffer.byteLength(JSON.stringify(committed));
    }
    return result;
  }
  return { resolve, archiveConfirmed };
}
module.exports = { createMembershipReceiptArchive, isReference, checkReference };
