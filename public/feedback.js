/* 앱 페이지 위에 표시되는 임시 알림 */
(function (root) {
    'use strict';

    const visibleDuration = 4000;
    const entranceDuration = 300;
    const exitDuration = 375;
    const entranceEasing = 'cubic-bezier(.215, .61, .355, 1)';
    const exitEasing = 'cubic-bezier(.19, 1, .22, 1)';
    let currentToast = null;

    function getContainer() {
        const existing = document.getElementById('app-toast-container');
        if (existing) return existing;
        const container = document.createElement('div');
        container.id = 'app-toast-container';
        const target = document.querySelector('.app-page-content') ?? document.body;
        target.append(container);
        return container;
    }

    function showToast(message, classes = '') {
        if (currentToast?.message === message) return;
        currentToast?.dismiss();

        const container = getContainer();
        const toast = document.createElement('div');
        toast.className = `ui-toast ${classes}`.trim();
        toast.setAttribute('role', 'status');
        if (message instanceof Node) toast.append(message);
        else toast.textContent = message;
        container.append(toast);

        const entrance = toast.animate([{ top: '35px', opacity: 0 }, { top: '0px', opacity: 1 }],
            { duration: entranceDuration, easing: entranceEasing });
        const instance = { message, dismiss };
        currentToast = instance;
        let remaining = visibleDuration;
        let timer;
        let expiresAt;
        let drag;
        let pan;
        let closing = false;

        function scheduleDismissal() {
            expiresAt = performance.now() + remaining;
            timer = setTimeout(dismiss, remaining);
        }

        function dismiss(swipeDestination) {
            if (closing) return;
            closing = true;
            clearTimeout(timer);
            toast.classList.add('is-closing');
            const { opacity, marginTop, transform } = getComputedStyle(toast);
            pan?.cancel();
            if (swipeDestination !== undefined) {
                toast.animate([{ transform }, { transform: `translateX(${swipeDestination}px)` }],
                    { duration: 50, fill: 'forwards' });
            }
            const exit = toast.animate([{ opacity, marginTop }, { opacity: 0, marginTop: '-40px' }],
                { duration: exitDuration, easing: exitEasing, fill: 'forwards' });
            exit.finished.then(() => {
                if (currentToast === instance) currentToast = null;
                toast.remove();
                if (!container.childElementCount) container.remove();
            });
        }

        toast.addEventListener('pointerdown', event => {
            if (closing || !event.isPrimary || event.button !== 0) return;
            toast.setPointerCapture(event.pointerId);
            clearTimeout(timer);
            remaining = Math.max(0, expiresAt - performance.now());
            drag = { start: event.clientX, x: event.clientX, time: event.timeStamp, velocity: 0,
                limit: toast.offsetWidth * 0.8 };
            toast.classList.add('is-dragging');
        });

        toast.addEventListener('pointermove', event => {
            if (!drag || closing || !toast.hasPointerCapture(event.pointerId)) return;
            drag.velocity = Math.abs(event.clientX - drag.x) / Math.max(1, event.timeStamp - drag.time);
            drag.x = event.clientX;
            drag.time = event.timeStamp;
            if (!pan) {
                entrance.finish();
                pan = toast.animate([
                    { transform: `translateX(-${drag.limit}px)`, opacity: 0 },
                    { transform: 'translateX(0px)', opacity: 1 },
                    { transform: `translateX(${drag.limit}px)`, opacity: 0 },
                ], { duration: 2, fill: 'both' });
                pan.pause();
            }
            pan.currentTime = 1 + Math.max(-1, Math.min(1, (drag.x - drag.start) / drag.limit));
        });

        function endDrag(event) {
            if (!drag || closing || !event.isPrimary) return;
            const { x, start, limit, velocity } = drag;
            const distance = x - start;
            drag = null;
            toast.classList.remove('is-dragging');
            if (event.type === 'pointerup' && (Math.abs(distance) > limit || velocity > 1)) {
                dismiss(Math.sign(distance) * limit);
                return;
            }
            if (pan) {
                const { opacity, transform } = getComputedStyle(toast);
                pan.cancel();
                pan = null;
                toast.animate([{ opacity, transform }, { opacity: 1, transform: 'none' }],
                    { duration: 200, easing: 'ease' });
            }
            scheduleDismissal();
        }
        toast.addEventListener('pointerup', endDrag);
        toast.addEventListener('pointercancel', endDrag);
        toast.addEventListener('lostpointercapture', endDrag);

        scheduleDismissal();
    }

    root.showToast = showToast;
    root.AppFeedback = {
        dismissToast() {
            currentToast?.dismiss();
            currentToast = null;
        },
    };
})(window);
