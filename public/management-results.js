/* 카드 작업 결과의 집계·공통 표시. 실제 저장·설정·창 수명주기는 호출자가 담당한다. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.AppManagementResults = api;
})(typeof window === 'object' ? window : globalThis, function () {
    'use strict';
    const reasons = {
        empty_no: '카드 번호 미입력', invalid_no: '카드 번호 오류',
        no_illustration: '일러스트 미선택', no_another: '일러스트 미선택',
        no_rarity: '레어도 미선택', no_proc: '레어도 미선택',
        no_loc: '보관 위치 미선택', no_target_loc: '이동 위치 미선택',
        invalid_qty: '수량 오류', insufficient_qty: '보유 수량 부족',
        no_inventory: '해당 보유 항목 없음', same_loc: '동일한 보관 위치',
        loading: '번호 검색 중', server_error: '서버 처리 실패',
        unconfirmed_result: '처리 결과 확인 필요'
    };
    const reasonText = reason => reasons[reason] || '처리 결과 확인 필요';

    // updatedItems는 최종 보유량이다. 작업량으로 계산하거나 성공을 추정하지 않는다.
    function reconcile(requests, response, errorMessage = '') {
        const supplied = response?.success && Array.isArray(response.operationResults)
            ? response.operationResults : [];
        const byIndex = new Map();
        const duplicate = new Set();
        for (const item of supplied) {
            if (byIndex.has(item.requestIndex)) duplicate.add(item.requestIndex);
            byIndex.set(item.requestIndex, item);
        }
        return requests.map((request, index) => {
            const result = byIndex.get(index);
            const requestedQty = Number(request.moveQty ?? request.qty);
            const confirmed = response?.success && !duplicate.has(index) && result
                && result.status === 'success' && Number.isSafeInteger(result.qty)
                && result.qty > 0 && result.qty === requestedQty;
            const failReason = confirmed ? null : !response?.success ? (response ? 'server_error' : 'unconfirmed_result')
                : result?.status === 'fail' && reasons[result.failReason]
                    ? result.failReason : 'unconfirmed_result';
            return { ...request, status: confirmed ? 'success' : 'fail',
                qty: confirmed ? result.qty : requestedQty, processedQty: confirmed ? result.qty : 0,
                failReason, errorMessage: errorMessage || (!response?.success ? response?.message || '' : '') };
        });
    }

    function summarize(items) {
        const success = new Map(), failures = new Map();
        let successCount = 0, totalQty = 0, failCount = 0;
        for (const item of items) {
            if (item.status === 'success') {
                const qty = Number(item.processedQty ?? item.moveQty ?? item.qty);
                if (!Number.isSafeInteger(qty) || qty <= 0) throw new Error('확인된 처리 수량이 필요합니다.');
                const name = String(item.name ?? item.cardName ?? '');
                const key = item.cid ? `cid:${item.cid}` : `name:${name}`;
                if (!success.has(key)) success.set(key, { name, qty: 0 });
                success.get(key).qty += qty;
                totalQty += qty;
                successCount++;
            } else {
                const reason = reasonText(item.failReason);
                failures.set(reason, (failures.get(reason) || 0) + 1);
                failCount++;
            }
        }
        const all = [...success.values()];
        return { successCount, totalQty, failCount, cardCount: success.size,
            summary: all.slice(0, 5), restQty: all.slice(5).reduce((sum, item) => sum + item.qty, 0),
            failures: [...failures].map(([reason, count]) => ({ reason, count })) };
    }
    // 표시는 복사한 값으로 구성한다. 원본 입력과 저장 식별자는 변경하지 않는다.
    function present(items, operation, { formatIllustration, formatRarity = value => value } = {}) {
        const totals = summarize(items);
        const escape = value => String(value ?? '').replace(/[&<>"']/g, char =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
        const summaryItem = (name, count, error = false) =>
            `<li class="color-surface-002 color-text-001 shape-rounded002"><span${error ? ' class="color-text-red"' : ''}>${escape(name)}</span><span class="${error ? 'color-text-red' : 'color-text-theme'}">${escape(count)}</span></li>`;
        const summaryHTML = totals.summary.map(item => summaryItem(item.name, `${item.qty}장`)).join('')
            + totals.failures.map(item => summaryItem(item.reason, `${item.count}건`, true)).join('');
        const detailHTML = items.map((item, index) => {
            const fail = item.status !== 'success', reason = fail ? item.failReason : null;
            const cell = (column, value, error = false) => `<td data-column="${column}"${error ? ' class="color-text-red"' : ''}>${escape(value)}</td>`;
            const numberError = ['empty_no', 'invalid_no', 'loading'].includes(reason);
            const illustrationError = ['no_illustration', 'no_another'].includes(reason);
            const rarityError = ['no_rarity', 'no_proc'].includes(reason);
            const locationError = ['no_loc', 'no_target_loc'].includes(reason);
            const illustration = item.illustration ?? item.another;
            const qty = fail ? item.moveQty ?? item.qty : item.processedQty ?? item.moveQty ?? item.qty;
            const quantity = Number.isFinite(Number(qty)) ? `${qty}장` : '-';
            const location = operation === 'move' ? `${item.currentLoc || '미선택'} → ${item.targetLoc || '미선택'}` : item.loc || '-';
            const illustrationText = illustrationError ? '미선택' : formatIllustration?.(illustration) || '-';
            return `<tr>${cell('sequence', item.no || index + 1)}${cell('name', item.name ?? item.cardName ?? '-')}`
                + cell('number', reason === 'empty_no' ? '미입력' : reason === 'loading' ? '검색 중' : item.cardNo || '-', numberError)
                + cell('illustration', illustrationText, illustrationError)
                + cell('rarity', rarityError ? '미선택' : formatRarity(item.rarity ?? item.proc) || '-', rarityError)
                + cell('location', operation !== 'move' && locationError ? '미선택' : location, locationError)
                + `<td data-column="quantity" class="${fail ? 'color-text-red' : 'color-text-theme'}">${escape(quantity)}${fail ? `<br>${escape(reasonText(reason))}` : ''}</td></tr>`;
        }).join('');
        return { ...totals, summaryHTML, detailHTML };
    }

    function render(modal, items, options = {}) {
        const operation = modal.dataset.resultOperation;
        const result = present(items, operation, options);
        const query = selector => modal.querySelector(selector);
        const label = { add: '등록', move: '이동', discard: '제거', import: '가져오기' }[operation];
        const unconfirmed = items.some(item => item.failReason === 'unconfirmed_result');
        const title = unconfirmed ? '결과 확인 필요' : result.failCount ? result.successCount ? '결과' : '실패!' : '완료!';
        query('[data-result-title]').textContent = `카드 ${label} ${title}`;
        const icon = query('[data-result-icon]');
        icon.className = 'material-icons ' + (unconfirmed || (result.failCount && result.successCount) ? 'color-text-001' : result.failCount ? 'color-text-red' : 'color-text-theme');
        icon.textContent = unconfirmed || (result.failCount && result.successCount) ? 'info' : result.failCount ? 'cancel' : 'check_circle';
        query('[data-result-status]').textContent = unconfirmed ? '처리 결과를 확인할 수 없습니다.' : result.successCount
            ? `총 ${result.cardCount}종 · ${result.totalQty}장 ${label}${result.failCount ? ` · ${result.failCount}건 실패` : ''}`
            : `${result.failCount}건을 처리하지 못했습니다.`;
        const notice = query('[data-result-notice]');
        const serverFailure = items.some(item => item.failReason === 'server_error');
        notice.hidden = !(unconfirmed || serverFailure || options.errorMessage || options.fullSynced);
        notice.className = serverFailure && !unconfirmed ? 'color-text-red' : 'color-text-001';
        notice.textContent = unconfirmed ? '처리 결과를 확인할 수 없습니다. 보유 현황을 확인한 뒤 다시 시도해주세요.'
            : serverFailure ? '서버 처리에 실패했습니다. 입력한 카드는 재시도할 수 있도록 유지합니다.' : options.errorMessage || '';
        if (options.fullSynced) notice.textContent += `${notice.textContent ? ' ' : ''}외부 수정이 감지되어 전체 동기화가 진행되었습니다.`;
        query('.ui-result-list').innerHTML = result.summaryHTML;
        const rest = query('[data-result-rest]');
        rest.hidden = !result.restQty;
        rest.textContent = result.restQty ? `그 외 ${result.restQty}장` : '';
        query('[data-result-detail] tbody').innerHTML = result.detailHTML;
        query('[data-result-detail] table').dataset.hasFailures = String(result.failCount > 0);
        query('th[data-column="quantity"]').textContent = result.failCount ? '수량 • 실패 사유' : '수량';
        modal.dataset.hasSuccess = String(result.successCount > 0);
        return result;
    }

    function setView(modal, view) {
        const detail = view === 'detail';
        modal.querySelector('[data-result-summary]').hidden = detail;
        modal.querySelector('[data-result-detail]').hidden = !detail;
        modal.querySelector('input[value="summary"]').checked = !detail;
        modal.querySelector('input[value="detail"]').checked = detail;
    }
    return { reconcile, summarize, reasonText, present, render, setView };
});
