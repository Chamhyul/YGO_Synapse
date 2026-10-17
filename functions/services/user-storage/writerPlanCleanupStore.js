'use strict';
const { createRecordStore, decodeRecord } = require('./recordStore');
const { createStorageAccess } = require('./storageAccess');
const { encodeKey, decodeKey, decodeValue } = require('./codec');
const { fingerprint } = require('../userMigrationRehearsal');
const fail = () => Object.assign(new Error('복구 참조와 계획 정리 기록을 확인해 주세요.'), { code: 'WRITER_PLAN_CLEANUP_CONFLICT' });
const idCheck = id => { if (!/^[a-f0-9]{32}$/.test(id || '')) throw fail(); };
const roles = new Set(['baseline', 'destination', 'destinationAudit', 'sourceAudit', 'targetAudit']);
function owned(context, id) {
  return context && Object.keys(context).sort().join(',') === 'backend,epoch,layout,role,transferId'
    && ['legacy', 'rtdb'].includes(context.backend) && Number.isSafeInteger(context.epoch) && context.epoch >= 1
    && roles.has(context.role) && /^[a-f0-9]{64}$/.test(context.layout || '') && /^[a-f0-9]{32}$/.test(context.transferId || '')
    && id !== context.transferId && (!['baseline', 'destination'].includes(context.role)
      || id === fingerprint({ transferId: context.transferId, role: context.role }).slice(0, 32));
}
function createPlanCleanupStore({ database, runId, timeoutMs, onAmbiguousWrite }) {
  idCheck(runId); const base = `profileWriterPlans/${encodeKey(runId)}`, access = createStorageAccess({ database, timeoutMs, onAmbiguousWrite });
  const records = path => createRecordStore({ database, path: `${base}/${path}`, timeoutMs, onAmbiguousWrite });
  const retired = records('retiredScopes'), jobs = records('cleanupJobs');
  function marker(value, id) {
    if (!value || Object.keys(value).sort().join(',') !== 'cleaned,context,format,jobId' || value.format !== 1
        || typeof value.cleaned !== 'boolean' || !owned(value.context, id)) throw fail(); idCheck(value.jobId); return value;
  }
  async function assertAlive(id) {
    idCheck(id); const record = await retired.read(id);
    if (record.exists) { marker(record.value, id); throw Object.assign(fail(), { code: 'WRITER_PLAN_RETIRED' }); }
    if (record.revision) throw fail();
  }
  async function* pageRecords(path) {
    let after;
    while (true) {
      let query = database.ref(`${base}/${path}`).orderByKey().limitToFirst(25); if (after) query = query.startAfter(after);
      const snapshot = await access.guarded(query.get(), false), rows = [];
      snapshot.forEach(child => { rows.push({ id: decodeKey(child.key), value: decodeRecord(child.val(), { path: `${base}/${path}/${child.key}`, payloadCodec: { decode: decodeValue } }) }); after = child.key; });
      for (const row of rows) { idCheck(row.id); if (!row.value.exists) { if (row.value.revision) throw fail(); continue; } yield { id: row.id, value: row.value.value }; }
      if (rows.length < 25) break;
    }
  }
  async function candidates({ beforeEpoch, currentEpoch, protectedIds, limit = 32 }) {
    if (!Number.isSafeInteger(beforeEpoch) || beforeEpoch < 1 || beforeEpoch > currentEpoch
        || !Number.isSafeInteger(limit) || limit < 1 || limit > 32 || !(protectedIds instanceof Set)) throw fail();
    const items = []; let scanned = 0, retained = 0;
    for await (const { id, value } of pageRecords('collections')) {
      scanned++; const context = value.context;
      if (!owned(context, id) || context.epoch >= beforeEpoch || context.epoch >= currentEpoch || protectedIds.has(id)) { retained++; continue; }
      const dead = await retired.read(id); if (!dead.exists && dead.revision) throw fail(); if (dead.exists && marker(dead.value, id).cleaned) { retained++; continue; }
      items.push({ id, context }); if (items.length === limit) return { items, scanned, retained, hasMore: true };
    }
    // 삭제 도중 수집 기록이 사라져도 영구 퇴역 표식으로 같은 범위를 재개한다.
    for await (const { id, value } of pageRecords('retiredScopes')) {
      const dead = marker(value, id); if (dead.cleaned || items.some(item => item.id === id)) continue;
      scanned++; if (dead.context.epoch >= beforeEpoch || dead.context.epoch >= currentEpoch || protectedIds.has(id)) { retained++; continue; }
      items.push({ id, context: dead.context }); if (items.length === limit) return { items, scanned, retained, hasMore: true };
    }
    return { items, scanned, retained, hasMore: false };
  }
  function checkJob(value, id) {
    if (!value || Object.keys(value).sort().join(',') !== 'backend,beforeEpoch,cursor,epoch,format,hasMore,id,items,limit,previousPhase,retained,scanned,status'
        || value.format !== 1 || value.id !== id || !['prepared', 'completed'].includes(value.status)
        || !Array.isArray(value.items) || value.items.length > 32 || new Set(value.items.map(item => item.id)).size !== value.items.length
        || !Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > 32 || value.items.length > value.limit
        || !Number.isSafeInteger(value.cursor) || value.cursor < 0 || value.cursor > value.items.length
        || value.status === 'completed' && value.cursor !== value.items.length
        || !Number.isSafeInteger(value.epoch) || value.epoch < 1 || !Number.isSafeInteger(value.beforeEpoch) || value.beforeEpoch < 1 || value.beforeEpoch > value.epoch
        || !Number.isSafeInteger(value.scanned) || value.scanned < value.items.length || !Number.isSafeInteger(value.retained) || value.retained < 0 || value.retained > value.scanned || typeof value.hasMore !== 'boolean'
        || !['legacy', 'rtdb'].includes(value.backend) || !['accepting', 'draining'].includes(value.previousPhase)
        || value.items.some(item => Object.keys(item).sort().join(',') !== 'context,id' || !owned(item.context, item.id) || item.context.epoch >= value.beforeEpoch || item.context.epoch >= value.epoch)) throw fail();
    return value;
  }
  async function job(id) { idCheck(id); const record = await jobs.read(id); if (!record.exists) { if (record.revision) throw fail(); return null; } return checkJob(record.value, id); }
  async function prepare(id, value) {
    idCheck(id); checkJob(value, id); const found = await job(id); if (found) return found;
    try { await jobs.compareAndSet(id, 0, value); } catch (error) { if (error.code !== 'USER_STORAGE_CONFLICT') throw error; }
    return job(id);
  }
  async function advance(id, cursor, complete = false) {
    await jobs.update(id, value => { const current = checkJob(value, id); if (cursor < current.cursor || cursor > current.items.length || complete && cursor !== current.items.length) throw fail();
      return { value: { ...current, cursor, status: complete ? 'completed' : current.status } }; });
    return job(id);
  }
  async function removeScope(item, jobId, guard, onCheckpoint = async () => {}) {
    idCheck(item.id); idCheck(jobId); if (!owned(item.context, item.id)) throw fail(); await guard(item);
    const collection = await records('collections').read(item.id), prior = await retired.read(item.id);
    if (collection.exists ? fingerprint(collection.value.context) !== fingerprint(item.context)
      : !prior.exists || fingerprint(marker(prior.value, item.id).context) !== fingerprint(item.context)) throw fail();
    await retired.update(item.id, value => {
      if (value !== undefined && fingerprint(marker(value, item.id).context) !== fingerprint(item.context)) throw fail();
      return { value: value || { format: 1, context: item.context, jobId, cleaned: false } };
    });
    await onCheckpoint('planScopeRetired', item.id);
    // 업무 영수증·변경 이력·사용자 원본·다른 범위의 자료는 삭제하지 않는다.
    const paths = ['chunks', 'values', 'heads', 'pages', 'collectionHeads', 'collectionPages'].map(root => `${base}/${root}/${item.id}`);
    paths.push(`${base}/manifests/${encodeKey(item.id)}`, `${base}/collections/${encodeKey(item.id)}`);
    for (const path of paths) { await guard(item); await access.remove(path); await onCheckpoint('planScopeRemoved', item.id); }
    await guard(item); await retired.update(item.id, value => ({ value: { ...marker(value, item.id), cleaned: true } }));
  }
  return { assertAlive, candidates, job, prepare, advance, removeScope };
}
module.exports = { createPlanCleanupStore, owned };
