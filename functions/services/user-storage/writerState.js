'use strict';
const fail = () => Object.assign(new Error('사용자 writer의 상태를 확인해 주세요.'), { code: 'WRITER_STATE_INVALID' });
function requirements(state) {
  return { requiresPlans: state?.transfer?.planMode === 'partitioned'
    || Object.values(state?.frozen || {}).some(value => !Array.isArray(value)), requiresHistory: state?.historyVersion !== undefined };
}
function validateState(state) {
  if (!state || state.format !== 1 || !['legacy', 'rtdb'].includes(state.backend)
      || !['accepting', 'draining'].includes(state.phase) || !Number.isSafeInteger(state.epoch) || state.epoch < 1
      || !Number.isSafeInteger(state.sequence) || state.sequence < 0 || !state.operations || !Array.isArray(state.events)
      || state.historyVersion !== undefined && (!Number.isSafeInteger(state.historyVersion) || state.historyVersion < 0)
      || state.historyCounts !== undefined && (!state.historyCounts || !['operations', 'external'].every(key => Number.isSafeInteger(state.historyCounts[key]) && state.historyCounts[key] >= 0))) throw fail();
  return state;
}
module.exports = { requirements, validateState };
