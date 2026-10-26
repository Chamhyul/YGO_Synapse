'use strict';

const { fingerprint } = require('./userMigrationRehearsal');
const { checkSessionCommand } = require('./adminSessionWriterAdapters');
const fail = () => Object.assign(new Error('관리자 세션 복구 대상을 다시 대조해 주세요.'), { code: 'WRITER_SESSION_RECOVERY_CONFLICT' });
const idCheck = id => { if (!/^[a-f0-9]{32}$/.test(id || '')) throw fail(); };

// 원문·UID·cookie·작업 ID를 반환하지 않는다. 미리보기는 읽기만 하며,
// 네이티브 영구 취소/영수증 및 기존 외부 요청 복구 계약을 그대로 사용한다.
function createAdminSessionRecovery({ read, operationFor, externalFor, stores,
  recover, fenceUncommitted, recoverExternal, endExternal, validateCommittedReceipt }) {
  async function observe(writer, options) {
    const { operation, parentRequest, recoveryRequest } = options;
    [operation, parentRequest, recoveryRequest].forEach(idCheck);
    if (new Set([operation, parentRequest, recoveryRequest]).size !== 3) throw fail();
    const state = await read();
    if (!state || state.backend !== writer.backend || state.epoch !== writer.epoch || state.transfer || state.planMaintenance) throw fail();
    const op = await operationFor(operation), parent = await externalFor(parentRequest);
    if (!op || !parent || op.backend !== writer.backend || op.epoch !== writer.epoch
        || parent.backend !== writer.backend || parent.epoch !== writer.epoch
        || !['executing', 'completed', 'cancelled'].includes(op.status)
        || !['running', 'uncertain', 'recovered', 'completed'].includes(parent.status)) throw fail();
    if (parent.status === 'completed' && op.status !== 'completed') throw fail();
    const entry = checkSessionCommand(op);
    if (!Array.isArray(op.resources) || !Array.isArray(parent.resources)
        || !parent.resources.includes(`sessionRequest/${parentRequest}`)
        || op.resources.some(key => !parent.resources.includes(key))
        || op.parentExternal !== undefined && op.parentExternal !== parentRequest) throw fail();
    // 구형 기록은 parentExternal 필드가 없어도 원래 명령 digest에 결합된
    // 상위 요청을 재계산해 증명한다. 자원/시간의 유사성으로 추정하지 않는다.
    if (fingerprint({ writer: { backend: op.backend, epoch: op.epoch }, changes: op.changes,
      result: op.result, resources: op.resources, details: op.details, parentExternal: parentRequest }) !== op.digest) throw fail();
    const child = await externalFor(recoveryRequest);
    if (parent.status === 'recovered') {
      if (parent.recoveryId !== recoveryRequest || !child || child.recoveryOf !== parentRequest
          || child.backend !== writer.backend || child.epoch !== writer.epoch
          || fingerprint(child.resources) !== fingerprint(parent.resources)
          || !['running', 'uncertain', 'completed'].includes(child.status)) throw fail();
    } else if (child) throw fail();
    // 다른 작업도 이 상위 요청의 잠금을 쓰면 한 작업만 확정해 종료하지 않는다.
    for (const item of Object.values(state.operations)) {
      if (item.id !== operation && ['prepared', 'executing'].includes(item.status)
          && item.resources.some(key => parent.resources.includes(key))) throw fail();
    }
    for (const item of Object.values(state.external || {})) {
      if (![parentRequest, recoveryRequest].includes(item.id) && ['running', 'uncertain'].includes(item.status)
          && item.resources.some(key => parent.resources.includes(key))) throw fail();
    }
    const native = await stores[op.backend].receipt(op) || null;
    if (native) {
      if (native.id !== op.id || native.digest !== op.digest) throw fail();
      if (native.outcome === 'cancelled') { if (Object.keys(native).length !== 3) throw fail(); }
      else validateCommittedReceipt(op, native);
    } else if (op.status !== 'executing') throw fail();
    const current = await stores[op.backend].read(entry.key);
    if (!native && current.token !== entry.token) throw fail();
    if (op.status === 'completed' && fingerprint(op.receipt) !== fingerprint(native)
        || op.status === 'cancelled' && native?.outcome !== 'cancelled') throw fail();
    const after = await read();
    if (!after || after.backend !== state.backend || after.epoch !== state.epoch || after.phase !== state.phase
        || fingerprint(await operationFor(operation)) !== fingerprint(op)
        || fingerprint(await externalFor(parentRequest)) !== fingerprint(parent)
        || fingerprint(await externalFor(recoveryRequest)) !== fingerprint(child)) throw fail();
    const previewDigest = fingerprint({ writer, phase: state.phase, op, parent, child, native, current });
    return { op, parent, child, native, preview: { backend: state.backend, epoch: state.epoch, phase: state.phase,
      operationState: op.status, parentState: parent.status, recoveryState: parent.status === 'completed' ? 'completed' : child?.status || 'absent',
      receiptState: native ? native.outcome === 'cancelled' ? 'cancelled' : 'committed' : 'absent',
      action: parent.status === 'completed' ? 'already-settled' : op.status === 'executing' ? native ? 'recover' : 'fence' : 'finish-parent',
      readyForApply: state.phase === 'draining', previewDigest } };
  }
  return {
    async preview(writer, options) { return (await observe(writer, options)).preview; },
    async apply(writer, options) {
      if (options.writersDrained !== true || !/^[a-f0-9]{64}$/.test(options.expectedPreview || '')) throw fail();
      const observed = await observe(writer, options);
      if (!observed.preview.readyForApply || observed.preview.previewDigest !== options.expectedPreview) throw fail();
      if (observed.parent.status === 'completed') return observed.preview;
      if (observed.op.status === 'executing') {
        if (observed.native) { try { await recover(options.operation); } catch (e) { if (e.code !== 'WRITER_CANCELLED') throw e; } }
        else await fenceUncommitted(options.operation);
      }
      const settled = await operationFor(options.operation);
      if (!['completed', 'cancelled'].includes(settled?.status)) throw fail();
      if (observed.child?.status !== 'completed') {
        const next = await recoverExternal(options.parentRequest, options.recoveryRequest,
          observed.parent.resources, { writersDrained: true, settledOperation: { id: settled.id, digest: settled.digest } });
        if (next !== options.recoveryRequest) throw fail();
        await endExternal(next);
      }
      return (await observe(writer, options)).preview;
    },
  };
}
module.exports = { createAdminSessionRecovery };
