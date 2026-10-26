(function (root) {
    'use strict';
    let active;
    function cancel() {
        if (!active) return;
        active.cancelled = true;
        clearTimeout(active.timer);
        active = undefined;
    }
    // 응답의 pending은 후속 작업 접수 상태다. 제한된 읽기 확인으로 완료를 회수한다.
    // 계정·요청이 바뀌면 기존 응답을 버리고, 실제 장애에서는 수동 재시도를 남긴다.
    function start({ isCurrent, check, refresh, onStatus }) {
        cancel();
        const clock = () => root.performance?.now?.() ?? Date.now();
        const started = clock(), pendingAt = [250, 1000, 2000, 4000, 6000, 12000, 24000];
        const task = { cancelled: false }, delays = [3000, 6000, 12000];
        active = task;
        const current = () => active === task && !task.cancelled && isCurrent();
        let requests = 0, errors = 0;
        const schedule = (pending = false) => {
            if (!current()) return;
            const elapsed = Math.max(0, clock() - started);
            // 정상 pending은 요청 속도와 관계없이 경과 시간의 다음 지점으로 예약한다.
            // 지나간 지점은 건너뛰며 겹친 요청·완료 직전의 연속 호출을 만들지 않는다.
            const next = pending ? pendingAt.find(at => at > elapsed) : undefined;
            const delay = requests === 0 ? 0 : pending
                ? next === undefined ? undefined : Math.max(250, next - elapsed)
                : delays[errors++];
            if (requests >= 8 || delay === undefined) { active = undefined; onStatus('pending'); return; }
            task.timer = setTimeout(run, delay);
        };
        const run = async () => {
            if (!current()) return;
            requests++;
            let pending = false;
            try {
                const result = await check();
                if (!current()) return;
                if (result?.success === true && result.membershipClaims?.status === 'synced'
                    && await refresh(result) && current()) {
                    active = undefined;
                    onStatus('ready');
                    return;
                }
                pending = result?.success === true && result.membershipClaims?.status === 'pending';
            } catch (_) { /* 실패를 성공으로 바꾸지 않고 제한 횟수 안에서만 확인한다. */ }
            schedule(pending);
        };
        onStatus('checking');
        schedule();
    }
    root.YgoMembershipClaimsSync = { start, cancel };
})(globalThis);
