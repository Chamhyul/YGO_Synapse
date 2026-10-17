'use strict';
const { createHash } = require('node:crypto');
const { encodeValue, decodeValue } = require('./user-storage/codec');
const fail = code => Object.assign(new Error('이전 리허설의 상태를 대조해야 합니다.'), { code });
const canonical = value => value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const fingerprint = value => createHash('sha256').update(JSON.stringify(canonical(encodeValue(value)))).digest('hex');
const clone = value => decodeValue(encodeValue(value));
const index = entries => {
  if (!Array.isArray(entries)) throw fail('MIGRATION_INVALID_SNAPSHOT');
  const result = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry.key !== 'string' || !entry.key || result.has(entry.key)
        || typeof entry.exists !== 'boolean' || typeof entry.token !== 'string'
        || (entry.exists && entry.value === undefined)) throw fail('MIGRATION_INVALID_SNAPSHOT');
    fingerprint(entry.exists ? entry.value : null); result.set(entry.key, entry);
  }
  return result;
};
const content = entry => fingerprint(entry?.exists ? { exists: true, value: entry.value } : { exists: false });

// 운영 연결이나 HTTP 경로를 만들지 않는다. 명시적으로 주입한 source/target만 사용한다.
// journal은 원본과 항목별 영수증을 보존한다. 출력용 보고서에는 수량/상태만 포함한다.
function createUserMigrationRehearsal({ source, target, journal, onCheckpoint = async () => {} } = {}) {
  if (![source, target].every(store => store && typeof store.snapshot === 'function'
      && typeof store.write === 'function') || !journal || typeof journal.read !== 'function'
      || typeof journal.compareAndSet !== 'function') throw fail('MIGRATION_INVALID_DEPENDENCIES');
  const idCheck = id => { if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) throw fail('MIGRATION_INVALID_RUN'); };
  async function state(id) { idCheck(id); return journal.read(id); }
  async function save(id, current, value) { return journal.compareAndSet(id, current.revision, value); }
  function drained(options) { if (options?.writersDrained !== true) throw fail('MIGRATION_WRITERS_NOT_DRAINED'); }
  async function ensureSource(plan) {
    const actual = index(await source.snapshot()), expected = index(plan.source);
    if (actual.size !== expected.size || [...expected].some(([key, entry]) => {
      const current = actual.get(key); return !current || current.token !== entry.token || content(current) !== content(entry);
    })) throw fail('MIGRATION_SOURCE_CHANGED');
  }
  async function compare(id) {
    const run = await state(id); if (!run.exists) throw fail('MIGRATION_RUN_NOT_FOUND');
    const expected = index(run.value.source), actual = index(await target.snapshot());
    const mismatch = new Set([...expected.keys(), ...actual.keys()].filter(key => content(expected.get(key)) !== content(actual.get(key))));
    return { phase: run.value.phase, sourceRecords: [...expected.values()].filter(item => item.exists).length,
      targetRecords: [...actual.values()].filter(item => item.exists).length, mismatches: mismatch.size };
  }
  return {
    compare,
    async copy(id, options) {
      idCheck(id);
      let run = await state(id);
      if (!run.exists) {
        const snapshot = await source.snapshot(); index(snapshot);
        run = await save(id, run, { phase: 'copying', source: clone(snapshot), copied: {} });
      }
      if (run.value.phase !== 'copying' && run.value.phase !== 'copied') throw fail('MIGRATION_PHASE_CONFLICT');
      await ensureSource(run.value);
      for (const entry of run.value.source) {
        const digest = content(entry);
        if (!run.value.copied[entry.key]) {
          // target.write는 생성/대조/승인 영수증을 책임지며 미확정 성공을 반환하지 않는다.
          const receipt = await target.write(entry, { runId: id, expected: null });
          run = await save(id, run, { ...run.value, copied: { ...run.value.copied, [entry.key]: { digest, receipt } } });
          await onCheckpoint('copy', entry.key);
        }
      }
      await ensureSource(run.value);
      const result = await compare(id); if (result.mismatches) throw fail('MIGRATION_COMPARE_FAILED');
      run = await save(id, run, { ...run.value, phase: 'copied' });
      return { ...result, phase: run.value.phase };
    },
    async activate(id, options) {
      drained(options); const run = await state(id);
      if (!run.exists || !['copied', 'active'].includes(run.value.phase)) throw fail('MIGRATION_PHASE_CONFLICT');
      await ensureSource(run.value);
      const result = await compare(id); if (result.mismatches) throw fail('MIGRATION_COMPARE_FAILED');
      await save(id, run, { ...run.value, phase: 'active' });
      return { ...result, phase: 'active' };
    },
    async rollback(id, options) {
      drained(options); let run = await state(id);
      if (!run.exists || !['active', 'rollingBack', 'rolledBack'].includes(run.value.phase)) throw fail('MIGRATION_PHASE_CONFLICT');
      if (run.value.phase === 'active') {
        await ensureSource(run.value);
        const latest = await target.snapshot(); index(latest);
        const original = index(run.value.source), current = index(latest);
        const all = [...new Set([...original.keys(), ...current.keys()])].map(key => ({
          key, baseline: original.get(key) || { key, exists: false, token: '0' },
          latest: current.get(key) || { key, exists: false, token: '0' },
        }));
        run = await save(id, run, { ...run.value, phase: 'rollingBack', rollback: all, restored: {} });
      }
      const targetNow = index(await target.snapshot()), targetPlan = index(run.value.rollback.map(item => item.latest));
      if ([...new Set([...targetNow.keys(), ...targetPlan.keys()])].some(key => content(targetNow.get(key)) !== content(targetPlan.get(key))
          || (targetNow.get(key)?.token || '0') !== (targetPlan.get(key)?.token || '0'))) throw fail('MIGRATION_TARGET_CHANGED');
      // 진행 중 재개도 전체 원본을 먼저 대조한다. 계획 밖 신규 원본은 삭제/덮어쓰지 않는다.
      const sourceNow = index(await source.snapshot()), known = new Set(run.value.rollback.map(item => item.key));
      if ([...sourceNow].some(([key, item]) => item.exists && !known.has(key))) throw fail('MIGRATION_SOURCE_CHANGED');
      for (const item of run.value.rollback) {
        const actual = sourceNow.get(item.key) || { key: item.key, exists: false, token: '0' };
        const restored = run.value.restored[item.key];
        const baselineMatches = actual.token === item.baseline.token && content(actual) === content(item.baseline);
        const appliedMatches = restored && actual.token === restored.token && content(actual) === content(item.latest);
        // 응답 유실은 source adapter의 이 run 영수증으로만 인정한다. 값 일치만으로 승인하지 않는다.
        if (!baselineMatches && !appliedMatches && !(content(actual) === content(item.latest)
            && await source.hasReceipt?.(item.key, id, content(item.latest), actual.token))) {
          throw fail('MIGRATION_SOURCE_CHANGED');
        }
      }
      for (const item of run.value.rollback) {
        if (run.value.restored[item.key]) continue;
        const receipt = await source.write(item.latest, { runId: id, expected: item.baseline });
        run = await save(id, run, { ...run.value, restored: { ...run.value.restored, [item.key]: receipt } });
        await onCheckpoint('rollback', item.key);
      }
      const restored = index(await source.snapshot());
      if ([...known].some(key => content(restored.get(key)) !== content(targetPlan.get(key)))) throw fail('MIGRATION_COMPARE_FAILED');
      run = await save(id, run, { ...run.value, phase: 'rolledBack' });
      return { phase: 'rolledBack', records: known.size, mismatches: 0 };
    },
  };
}
module.exports = { createUserMigrationRehearsal, fingerprint, content };
