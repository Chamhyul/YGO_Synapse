'use strict';
const { createHash } = require('node:crypto');
const { membershipCsvValidateMembers } = require('./membershipCsvService');
const { validateCsvControl, validateCsvCandidate, validateCsvOperation, EMPTY_REVISION } = require('./user-storage/membershipCsvStore');
const { fingerprint } = require('./userMigrationRehearsal');
const fail = code => Object.assign(new Error('회원 목록의 저장 상태와 전환 영수증을 확인해 주세요.'), { code, status: 503 });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const legacyRevision = members => 'legacy-' + digest(members);
function checkCsvKey(key) {
  if (key === 'csv/control' || key === 'csv/legacyUsers') return { kind: key.slice(4), id: 'current' };
  const match = /^csv\/(candidate|operation)\/([a-f0-9]{32})$/.exec(key || '');
  if (!match) throw fail('CSV_WRITER_INVALID_KEY'); return { kind: match[1], id: match[2] };
}
function membersValue(members, empty = false, legacy = false) {
  if (empty && Array.isArray(members) && !members.length) return members;
  const stable = membershipCsvValidateMembers(members);
  for (const member of members) {
    const timestamp = legacy && Object.hasOwn(member, 'updatedAt');
    if (Object.keys(member).sort().join(',') !== (timestamp ? 'channelId,levelName,memberName,updatedAt' : 'channelId,levelName,memberName')
        || timestamp && (!Number.isSafeInteger(member.updatedAt) || member.updatedAt < 0)) throw fail('CSV_WRITER_MIGRATION_REQUIRED');
  }
  if (legacy) {
    const original = new Map(members.map(member => [member.channelId, member]));
    for (const member of stable) if (Object.hasOwn(original.get(member.channelId), 'updatedAt')) member.updatedAt = original.get(member.channelId).updatedAt;
  }
  if (fingerprint(stable) !== fingerprint(members)) throw fail('CSV_WRITER_MIGRATION_REQUIRED');
  return stable;
}
function candidateValue(value) {
  const { legacyList, ...body } = value || {};
  if (legacyList !== undefined && legacyList !== true) throw fail('CSV_WRITER_MIGRATION_REQUIRED');
  if (legacyList === true) {
    // 과거 fallback 명단에만 행별 갱신 시각을 보존한다. 새 CSV 후보는 기존 3필드 계약이다.
    if (Object.keys(body).sort().join(',') !== 'fingerprint,members' || !/^[a-f0-9]{64}$/.test(body.fingerprint || '')
        || digest(membersValue(body.members, false, true)) !== body.fingerprint) throw fail('CSV_WRITER_MIGRATION_REQUIRED');
  } else validateCsvCandidate(body);
  return body;
}
function operationValue(value) {
  const { legacySource, ...body } = value || {};
  if (legacySource) {
    const original = fromLegacyOperation(legacySource);
    if (body.revision !== null || !(body.status === original.status || original.status === 'pending' && body.status === 'failed')
        || fingerprint({ ...original, status: body.status }) !== fingerprint(value)) throw fail('CSV_WRITER_MIGRATION_REQUIRED');
    validateCsvOperation({ ...body, revision: EMPTY_REVISION }); return value;
  }
  if (/^legacy-[a-f0-9]{64}$/.test(body.revision || '')) { validateCsvOperation({ ...body, revision: EMPTY_REVISION }); return value; }
  return validateCsvOperation(value);
}
function fromLegacyOperation(raw) {
  if (!raw || Object.keys(raw).some(key => !['binding','actor','status','startedAt','result'].includes(key))
      || !['pending','failed','completed'].includes(raw.status) || raw.status !== 'completed' && Object.hasOwn(raw, 'result')) throw fail('CSV_WRITER_MIGRATION_REQUIRED');
  const normalized = { binding: raw.binding, actor: raw.actor, status: raw.status, startedAt: raw.startedAt, revision: null,
    ...(raw.status === 'completed' ? { completedAt: raw.result?.updatedAt, legacyResult: raw.result } : {}), legacySource: raw };
  const { legacySource, ...body } = normalized; validateCsvOperation({ ...body, revision: EMPTY_REVISION }); return normalized;
}
function controlValue(value) {
  const { baseRevision, active, operations, ...extra } = value || {};
  if (Object.keys(extra).length || !operations || baseRevision !== undefined && !/^legacy-[a-f0-9]{64}$/.test(baseRevision)) throw fail('CSV_WRITER_MIGRATION_REQUIRED');
  const { publicRevision, publicUpdatedAt, ...pointer } = active || {};
  if (publicRevision !== undefined && !/^legacy-[a-f0-9]{64}$/.test(publicRevision)) throw fail('CSV_WRITER_MIGRATION_REQUIRED');
  if (publicUpdatedAt !== undefined && (publicUpdatedAt !== null || pointer.updatedAt !== 0)) throw fail('CSV_WRITER_MIGRATION_REQUIRED');
  const normalized = Object.fromEntries(Object.entries(operations).map(([id, record]) => {
    operationValue(record); const { legacySource, ...body } = record; return [id, { ...body, revision: body.revision === null || /^legacy-/.test(body.revision) ? EMPTY_REVISION : body.revision }];
  }));
  validateCsvControl({ active: active === null ? null : pointer, operations: normalized }); return value;
}
function valueFor(key, value) {
  const { kind } = checkCsvKey(key);
  if (kind === 'control') return controlValue(value);
  if (kind === 'candidate') { candidateValue(value); return value; }
  if (kind === 'operation') return operationValue(value);
  return membersValue(value, true, true);
}
const revisionOf = state => state.active?.publicRevision || state.active?.revision || state.baseRevision || EMPTY_REVISION;
function physicalOperation(record) {
  operationValue(record);
  return record.legacySource ? { ...record.legacySource, status: record.status } : { binding: record.binding, actor: record.actor, status: record.status, startedAt: record.startedAt,
    ...(record.status === 'completed' ? { result: record.legacyResult || null } : {}) };
}
function inactive(op, control, now) {
  if (!['stage','commit'].includes(op.details.action)) return false;
  const record = control.operations[op.details.businessId];
  const at = now(); if (!Number.isSafeInteger(at) || at < 0) throw fail('CSV_WRITER_INVALID_TIME');
  return !record || record.status !== 'pending' || record.revision === null || record.startedAt + 120000 <= at;
}
function checkCsvCommand(op) {
  if (op.changes?.length !== 1 || op.details?.kind !== 'membershipCsv' || !['begin','stage','commit','fail','expire'].includes(op.details.action)
      || !/^[a-f0-9]{32}$/.test(op.details.businessId || '') || typeof op.details.controlToken !== 'string') throw fail('CSV_WRITER_INVALID_COMMAND');
  const entry = op.changes[0], { kind } = checkCsvKey(entry.key);
  if (!entry.exists || !['control','candidate','operation'].includes(kind)) throw fail('CSV_WRITER_INVALID_COMMAND'); valueFor(entry.key, entry.value); return entry;
}
function checkSnapshot(entries) {
  const map = new Map(entries.map(entry => [entry.key, entry]));
  const control = map.get('csv/control')?.value;
  const candidate = id => { const value = map.get(`csv/candidate/${id}`)?.value; if(!value)throw fail('CSV_WRITER_MIGRATION_REQUIRED'); return candidateValue(value); };
  if(control?.active) { const value=candidate(control.active.revision);
    if(value.fingerprint!==control.active.fingerprint || value.members.length!==control.active.count)throw fail('CSV_WRITER_MIGRATION_REQUIRED'); }
  const operations=[...Object.entries(control?.operations||{}),...entries.filter(entry=>entry.exists&&entry.key.startsWith('csv/operation/')).map(entry=>[checkCsvKey(entry.key).id,entry.value])];
  for(const [id,record]of operations) if(record.status==='completed') {
    const value=candidate(id),original=record.legacyResult;
    if(original) {
      const tiers=new Map();for(const member of value.members)tiers.set(member.levelName,(tiers.get(member.levelName)||0)+1);
      if(Object.keys(original).sort().join(',')!=='count,revision,tiers,updatedAt' || original.count!==value.members.length || original.revision!==id || original.updatedAt!==record.completedAt
          || !Array.isArray(original.tiers) || original.tiers.length!==tiers.size || new Set(original.tiers.map(item=>item.levelName)).size!==tiers.size
          || original.tiers.some(item=>Object.keys(item).sort().join(',')!=='count,levelName'||tiers.get(item.levelName)!==item.count))throw fail('CSV_WRITER_MIGRATION_REQUIRED');
    }
  }
  return entries;
}
module.exports = { checkCsvKey, valueFor, controlValue, candidateValue, operationValue, fromLegacyOperation, physicalOperation,
  membersValue, legacyRevision, revisionOf, digest, inactive, checkCsvCommand, checkSnapshot, fail };
