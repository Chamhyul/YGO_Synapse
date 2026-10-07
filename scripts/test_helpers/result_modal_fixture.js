// 기존 DOM 대역에 공통 결과창의 접근 지점을 연결한다. 실제 렌더러를 대체하지 않는다.
function attachResultModal(element, id) {
  const operation = id === 'migration-result-modal' ? 'import' : id.split('-')[0];
  const ids = {
    add: ['add-modal-title', 'result-icon-area', 'result-success-text', 'result-fail-text', 'result-summary-body', 'add-summary-rest', 'result-detail-body', 'result-summary-table-box', 'result-detail-box'],
    move: ['move-modal-title', 'move-icon-area', 'move-success-text', 'move-fail-text', 'move-summary-body', 'move-summary-rest', 'move-result-body', 'move-summary-table-box', 'move-result-detail-box'],
    discard: ['discard-modal-title', 'discard-result-icon-area', 'discard-success-text', 'discard-fail-text', 'discard-summary-body', 'discard-summary-rest', 'discard-result-detail-body', 'discard-summary-table-box', 'discard-result-detail-box'],
    import: ['migration-result-title', 'migration-icon-area', 'migration-success-text', 'migration-result-notice', 'migration-summary-body', 'migration-summary-rest', 'migration-detail-body', 'migration-summary-table-box', 'migration-detail-table-box']
  }[operation];
  const selectors = ['[data-result-title]', '[data-result-icon]', '[data-result-status]', '[data-result-notice]', '.ui-result-list', '[data-result-rest]', '[data-result-detail] tbody', '[data-result-summary]', '[data-result-detail]'];
  const modal = element(id);
  modal.dataset = { ...modal.dataset, resultOperation: operation };
  modal.querySelector = selector => element(ids[selectors.indexOf(selector)] || `${id}:${selector}`);
  return modal;
}
module.exports = { attachResultModal };
