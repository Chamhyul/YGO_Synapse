/* 관리자·서버 작업 기록. 인증된 쿠키 API만 사용하고 로그인/권한 조회를 추가하지 않는다. */
(() => {
    'use strict';
    const content = document.getElementById('admin-content');
    if (!content || content.hidden) return;
    const server = content.dataset.logKind === 'server';
    const get = name => document.getElementById((server ? 'server-logs-' : 'admin-logs-') + name);
    const actions = server ? {'cards.full':'카드 전체 언어 수집','cards.quick':'카드 주요 언어 수집','cards.resume':'카드 수집 후속 회차','cards.manual':'카드 수동 수집','membership.drive':'멤버십 CSV 자동 동기화','storage.history':'내부 기록 정리'} : {'notice.add':'공지 작성','notice.update':'공지 수정','notice.delete':'공지 삭제','membership.replace':'멤버십 CSV 적용','role.grant':'관리자 지정','role.revoke':'관리자 해제','role.owner':'소유자 지정'};
    const outcomes = server ? {completed:'회차 완료',skipped:'건너뜀',stopped:'중단',partial:'일부 실패',failed:'오류'} : {succeeded:'성공',rejected:'요청 거절',unconfirmed:'결과 확인 필요'};
    const date = new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
    let cursor = null, busy = false, controller = null, generation = 0;
    const seen = new Set();
    function controls() {
        get('fields').disabled = busy || content.hidden;
        get('more').disabled = busy || content.hidden;
        get('list').setAttribute('aria-busy',String(busy));
    }
    function text(tag, value, className) {
        const el = document.createElement(tag); el.textContent = value;
        if (className) el.className = className;
        return el;
    }
    function append(row, ownKey) {
        const action = server ? row.job : row.action;
        if (!Object.hasOwn(actions,action) || !Object.hasOwn(outcomes,row.outcome) || !/^[a-f0-9]{32}$/.test(row.id || '') || !Number.isFinite(Date.parse(row.occurredAt)) || seen.has(row.id)) return;
        if (server ? !['schedule','queue','manual'].includes(row.trigger) : !['admin','owner'].includes(row.actorRole) || !/^[a-f0-9]{64}$/.test(row.actorKey || '')) return;
        seen.add(row.id);
        const li = document.createElement('li'), details = document.createElement('details'), summary = document.createElement('summary');
        li.className = 'admin-log-row';
        summary.className = 'color-type004 shape-rounded003';
        const time = text('time',date.format(new Date(row.occurredAt)),'color-text-001'); time.dateTime = row.occurredAt;
        const actor = server ? {schedule:'예약 실행',queue:'후속 작업',manual:'수동 실행'}[row.trigger] : `${row.actorKey === ownKey ? '본인' : row.actorRole === 'owner' ? '소유자' : '관리자'} · ${row.actorKey.slice(0,12)}`;
        summary.append(time,text('strong',actions[action]),text('span',actor,'color-text-001'),text('span',outcomes[row.outcome],row.outcome === 'unconfirmed' ? 'color-text-000' : 'color-text-001'));
        const info = text('div','', 'admin-log-detail color-text-001');
        info.append(text('p','기록 번호: ' + row.id));
        if (server) {
            const counts = {memberCount:'회원 수',crawled:'수집 카드',skipped:'건너뛴 카드',failed:'오류 카드',newPacks:'발견한 팩',remainingPacks:'남은 팩',moved:'보관한 기록',removedEvents:'정리한 이벤트',nativeMoved:'보관한 부가 기록'};
            for (const [key,label] of Object.entries(counts)) if (Number.isSafeInteger(row[key]) && row[key]>=0) info.append(text('p',label + ': ' + row[key]));
            const reasons = {no_changes:'변경 대상 없음',no_file:'동기화할 파일 없음',older:'현재 목록보다 이전 자료',unchanged:'이미 확인한 자료',same_content:'동일한 회원 목록',disabled:'자동 동기화 비활성',locked:'다른 수집 작업 실행 중',stale:'종료된 수집 회차',requested_stop:'중단 요청',partial:'일부 항목 처리 오류'};
            if (Object.hasOwn(reasons,row.reason)) info.append(text('p',reasons[row.reason]));
            const errors = {timeout:'처리 시간 초과',network:'외부 연결 오류',configuration:'실행 설정 확인 필요',storage:'저장소 처리 오류',unknown:'분류되지 않은 오류'};
            if (Object.hasOwn(errors,row.errorKind)) info.append(text('p',errors[row.errorKind]));
            if (['failed','partial'].includes(row.outcome)) info.append(text('p','일부 변경이 반영되었을 수 있습니다. 다시 실행하기 전에 현재 처리 상태를 확인해 주세요.'));
        }
        if (!server) {
            if (/^[a-f0-9]{64}$/.test(row.targetKey || '')) info.append(text('p','대상 계정 식별키: ' + row.targetKey.slice(0,12)));
            if (/^\d{4}\.\d{2}\.\d{2}T\d{2}:\d{2}$/.test(row.noticeId || '')) info.append(text('p','공지 번호: ' + row.noticeId));
            if (row.action === 'membership.replace' && Number.isSafeInteger(row.memberCount)) info.append(text('p','적용 회원 수: ' + row.memberCount + '명'));
        }
        if (Number.isSafeInteger(row.durationMs)) info.append(text('p','처리 시간: ' + (row.durationMs / 1000).toFixed(2) + '초'));
        if (row.outcome === 'unconfirmed') info.append(text('p','같은 작업을 다시 실행하기 전에 공지·회원 목록·대상 계정의 현재 상태를 확인해 주세요.'));
        details.append(summary,info); li.append(details); get('list').append(li);
    }
    function apply(data) {
        if (!data || !Array.isArray(data.entries) || !server && !/^[a-f0-9]{64}$/.test(data.currentActorKey || '') || !Number.isFinite(Date.parse(data.queriedAt)) || data.nextCursor !== null && (typeof data.nextCursor !== 'string' || data.nextCursor.length > 8192)) throw Error();
        for (const row of data.entries) append(row,data.currentActorKey);
        cursor = data.nextCursor; get('more').hidden = !cursor;
        get('empty').hidden = seen.size !== 0 || !!cursor;
        get('status').textContent = `${seen.size}개의 작업을 확인했습니다.${cursor ? ' 더 불러오기로 조회를 이어갈 수 있습니다.' : ''}`;
        get('updated').textContent = '조회 시각 · ' + date.format(new Date(data.queriedAt)) + ' (한국 시간)';
    }
    async function load(more = false) {
        if (busy || content.hidden || more && !cursor) return;
        const ticket = ++generation;
        busy = true; controller = new AbortController(); controls();
        get('status').textContent = '작업 기록을 확인하고 있습니다.';
        get('empty').hidden = true;
        if (!more) { cursor = null; seen.clear(); get('list').replaceChildren(); get('more').hidden = true; get('updated').textContent = ''; }
        const params = new URLSearchParams({days:get('days').value,type:get('type').value,outcome:get('outcome').value});
        if (more) params.set('cursor',cursor);
        const active = controller, timer = setTimeout(() => active.abort(),25000);
        try {
            const response = await fetch((server ? '/admin/api/server-logs?' : '/admin/api/admin-logs?') + params,{credentials:'same-origin',cache:'no-store',redirect:'error',signal:active.signal});
            if (ticket !== generation || content.hidden) return;
            if (response.status === 401 || response.status === 403) { content.hidden = true; location.reload(); return; }
            const data = await response.json();
            if (ticket !== generation || content.hidden) return;
            if (!response.ok || !data.success) throw Error();
            apply(data);
        } catch (_) {
            if (ticket === generation && !content.hidden) get('status').textContent = '작업 기록을 불러오지 못했습니다. 잠시 후 다시 조회해 주세요.';
        } finally { clearTimeout(timer); if (ticket === generation) { busy = false; controller = null; controls(); } }
    }
    get('form').addEventListener('submit',event => { event.preventDefault(); load(); });
    get('form').addEventListener('change',() => { cursor = null; get('more').hidden = true; });
    get('more').addEventListener('click',() => load(true));
    new MutationObserver(() => {
        if (!content.hidden) return;
        ++generation; controller?.abort(); cursor = null; busy = false; seen.clear(); get('list').replaceChildren();
        get('status').textContent = ''; get('updated').textContent = ''; get('empty').hidden = true; get('more').hidden = true; controls();
    }).observe(content,{attributes:true,attributeFilter:['hidden']});
    const initial = document.getElementById('log-bootstrap');
    if (!initial) load();
    else {
        try {
            const state = JSON.parse(initial.textContent);
            if (state.version !== 1 || state.kind !== (server ? 'server' : 'admin') || state.unavailable) throw Error();
            // 첫 페이지/커서는 서버의 기본 조건이다. 브라우저가 복원한 선택값과 섞지 않는다.
            get('days').value='7';get('type').value='all';get('outcome').value='all';
            get('list').replaceChildren();seen.clear();apply(state.data);
        } catch {
            cursor=null;seen.clear();get('list').replaceChildren();get('more').hidden=true;get('empty').hidden=true;get('updated').textContent='';
            get('status').textContent='작업 기록을 불러오지 못했습니다. 잠시 후 다시 조회해 주세요.';
        } finally { initial.remove();controls(); }
    }
})();
