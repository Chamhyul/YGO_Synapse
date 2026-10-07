/* 방문 통계와 오류는 관리자 서버 세션으로 각각 조회한다. */
(() => {
    const content = document.getElementById('admin-content');
    const chart = document.getElementById('admin-traffic-chart');
    const rows = document.getElementById('admin-traffic-rows');
    if (!content || content.hidden || !chart || !rows) return;
    const buttons = [...document.querySelectorAll('[data-trend-days]')];
    const refresh = document.getElementById('admin-traffic-refresh');
    const status = document.getElementById('admin-traffic-status');
    const source = document.getElementById('admin-traffic-source');
    const range = document.getElementById('trend-range');
    const metrics = ['activeUsers', 'sessions', 'screenPageViews'];
    const units = ['명', '회', '회'];
    let data = null, days = 7;
    function render() {
        buttons.forEach(button => {
            const active = Number(button.dataset.trendDays) === days;
            button.setAttribute('aria-pressed', String(active));
            button.classList.toggle('color-theme', active);
            button.classList.toggle('color-type000', !active);
        });
        if (!data) return;
        const selected = data.daily.slice(-days);
        const maximum = Math.max(2, ...selected.map(entry => entry.value));
        const step = 10 ** Math.floor(Math.log10(maximum));
        const upper = Math.ceil(maximum / (2 * step)) * (2 * step);
        const x = index => 52 + index * 630 / (days - 1);
        const y = value => 168 - value * 140 / upper;
        const grid = [0, upper / 2, upper].map(value => `<line class="admin-home-chart-grid" x1="52" y1="${y(value)}" x2="682" y2="${y(value)}"/><text class="admin-home-chart-label" x="42" y="${y(value) + 4}" text-anchor="end">${value.toLocaleString('ko-KR')}</text>`).join('');
        const points = selected.map((entry, index) => `${x(index)},${y(entry.value)}`).join(' ');
        const marks = selected.map((entry, index) => `<circle class="admin-home-chart-point" cx="${x(index)}" cy="${y(entry.value)}" r="3"><title>${entry.date}: ${entry.value.toLocaleString('ko-KR')}명</title></circle>`).join('');
        const indices = days === 7 ? [0, 3, 6] : [0, 7, 14, 21, 29];
        const labels = indices.map(index => `<text class="admin-home-chart-label" x="${x(index)}" y="200" text-anchor="${index === 0 ? 'start' : index === days - 1 ? 'end' : 'middle'}">${selected[index].date.slice(5).replace('-', '/')}</text>`).join('');
        chart.innerHTML = `<title id="chart-title">최근 ${days}일 활성 방문자</title><desc id="chart-description">${selected[0].date}부터 ${selected.at(-1).date}까지의 GA4 수집 결과입니다. 오늘 수치는 집계 중이며 정확한 값은 아래 데이터 표에서 확인하세요.</desc>${grid}<polyline class="admin-home-chart-line" points="${points}"/>${marks}${labels}`;
        rows.innerHTML = selected.map(entry => `<tr><th scope="row">${entry.date}</th><td>${entry.value.toLocaleString('ko-KR')}명</td></tr>`).join('');
        range.textContent = `기간: ${selected[0].date}–${selected.at(-1).date} · 오늘 집계 중`;
    }
    async function loadTraffic() {
        if (content.hidden || refresh.disabled) return;
        refresh.disabled = true; buttons.forEach(button => { button.disabled = true; });
        chart.setAttribute('aria-busy', 'true'); data = null;
        chart.innerHTML = ''; rows.innerHTML = ''; source.textContent = '';
        range.textContent = '조회 중'; status.textContent = '방문 통계를 조회하고 있습니다.';
        metrics.forEach(metric => {
            document.getElementById('admin-traffic-' + metric).textContent = '—';
            document.getElementById('admin-previous-' + metric).textContent = '어제 —';
        });
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 20000);
        try {
            const response = await fetch('/admin/api/traffic', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
            if (content.hidden) return;
            if (response.status === 401 || response.status === 403) { content.hidden = true; window.location.reload(); return; }
            if (!response.ok) throw Error();
            const result = await response.json();
            if (content.hidden) return;
            const validCount = n => Number.isSafeInteger(n) && n >= 0;
            if (!result.success || !Array.isArray(result.daily) || result.daily.length !== 30
                || !result.daily.every(entry => /^\d{4}-\d{2}-\d{2}$/.test(entry.date) && validCount(entry.value))
                || !metrics.every(metric => validCount(result.current?.[metric]) && validCount(result.previous?.[metric]))) throw Error();
            data = result;
            const queriedAt = new Intl.DateTimeFormat('ko-KR', {timeZone:'Asia/Seoul',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(data.queriedAt));
            metrics.forEach((metric, i) => {
                document.getElementById('admin-traffic-' + metric).textContent = data.current[metric].toLocaleString('ko-KR');
                document.getElementById('admin-previous-' + metric).textContent = `어제 ${data.previous[metric].toLocaleString('ko-KR')}${units[i]}`;
            });
            source.textContent = `GA4 · ${data.hostname} 일반 페이지 · 조회 ${queriedAt} (한국 시간) · 최대 1분간 결과 재사용`;
            status.textContent = data.limited ? 'GA4의 데이터 제한 또는 표본 추출이 적용된 결과입니다. 오늘 수치는 집계 중입니다.'
                : 'GA4 수집 결과입니다. 수집되지 않은 날짜는 0으로 표시하며 집계 지연이 있을 수 있습니다.';
            render();
        } catch {
            if (content.hidden) return;
            data = null; chart.innerHTML = ''; rows.innerHTML = ''; source.textContent = '';
            metrics.forEach(metric => { document.getElementById('admin-traffic-' + metric).textContent = '—'; document.getElementById('admin-previous-' + metric).textContent = '어제 —'; });
            range.textContent = '조회 실패'; status.textContent = '방문 통계를 불러오지 못했습니다. 잠시 후 방문 통계 새로고침을 눌러 주세요.';
        } finally {
            clearTimeout(timeout); refresh.disabled = false; buttons.forEach(button => { button.disabled = !data; }); chart.setAttribute('aria-busy', 'false');
        }
    }
    buttons.forEach(button => button.addEventListener('click', () => { days = Number(button.dataset.trendDays); render(); }));
    refresh.addEventListener('click', loadTraffic);
    loadTraffic();
})();

(() => {
    const content = document.getElementById('admin-content');
    const list = document.getElementById('admin-errors-list');
    if (!content || !list || content.hidden) return;
    const status = document.getElementById('admin-errors-status');
    const count = document.getElementById('admin-error-count');
    const groups = document.getElementById('admin-error-groups');
    const source = document.getElementById('admin-errors-source');
    const refresh = document.getElementById('admin-errors-refresh');
    const formatTime = value => value ? new Intl.DateTimeFormat('ko-KR', {
        timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
    }).format(new Date(value)) : '시각 확인 불가';
    function element(tag, className, text) {
        const node = document.createElement(tag);
        node.className = className; node.textContent = text;
        return node;
    }
    async function loadErrors() {
        if (content.hidden || refresh.disabled) return;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 20000);
        refresh.disabled = true; list.setAttribute('aria-busy', 'true');
        count.textContent = groups.textContent = '—';
        list.replaceChildren(); source.textContent = '';
        status.textContent = '오류 데이터를 조회하고 있습니다.';
        try {
            const response = await fetch('/admin/api/errors', {
                credentials: 'same-origin', cache: 'no-store', signal: controller.signal
            });
            if (content.hidden) return;
            if (response.status === 401 || response.status === 403) {
                content.hidden = true; window.location.reload(); return;
            }
            if (!response.ok) throw new Error('조회 실패');
            const data = await response.json();
            if (content.hidden) return;
            if (!data.success || !Number.isSafeInteger(data.occurrenceCount) || !Number.isSafeInteger(data.groupCount)
                || !Array.isArray(data.topErrors)) throw new Error('응답 확인 실패');
            count.textContent = (data.partial ? '≥ ' : '') + data.occurrenceCount.toLocaleString('ko-KR');
            groups.textContent = (data.partial ? '≥ ' : '') + data.groupCount.toLocaleString('ko-KR');
            status.textContent = data.partial ? '조회 범위를 초과해 일부 결과만 표시합니다. 건수는 확인된 항목의 합계입니다.'
                : data.groupCount === 0 ? '최근 24시간에 수집된 Cloud Run 오류가 없습니다.' : '최근 24시간에 수집된 주요 오류입니다.';
            const items = data.topErrors.map((error, index) => {
                const row = document.createElement('li');
                const detail = document.createElement('div');
                detail.append(element('h3', '', error.description), element('p', 'color-text-001',
                    `${error.feature} · 최근 발생 ${formatTime(error.lastSeen)} (한국 시간)`));
                row.append(element('span', 'admin-home-error-rank color-text-001', String(index + 1).padStart(2, '0')),
                    detail, element('span', 'ui-chip color-tint-theme shape-capsule', `${error.count.toLocaleString('ko-KR')}건`));
                return row;
            });
            list.replaceChildren(...items);
            source.textContent = `Cloud Run · Error Reporting · ${formatTime(data.periodStart)}부터 · 조회 ${formatTime(data.queriedAt)} (한국 시간) · 최대 1분간 결과 재사용`;
        } catch {
            if (content.hidden) return;
            count.textContent = groups.textContent = '—'; list.replaceChildren(); source.textContent = '';
            status.textContent = '오류 데이터를 불러오지 못했습니다. 잠시 후 오류 새로고침을 눌러 주세요.';
        } finally {
            clearTimeout(timeout); refresh.disabled = false; list.setAttribute('aria-busy', 'false');
        }
    }
    refresh.addEventListener('click', loadErrors);
    loadErrors();
})();
