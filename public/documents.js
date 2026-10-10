/* 공지 HTML 안전 표시와 전용 열람 페이지. 인증·사용자 데이터 쓰기 없음. */
(function(root) {
'use strict';
const NOTICE_ALLOWED_TAGS = new Set([
    'a', 'b', 'blockquote', 'br', 'code', 'del', 'div', 'em', 'h1', 'h2', 'h3',
    'h4', 'h5', 'h6', 'hr', 'i', 'li', 'ol', 'p', 'pre', 's', 'span', 'strong', 'u', 'ul'
]);
const NOTICE_DROP_WITH_CONTENT_TAGS = new Set([
    'base', 'embed', 'frame', 'iframe', 'link', 'meta', 'object', 'script', 'style', 'svg', 'template'
]);

function isSafeNoticeHref(href) {
    try {
        const url = new URL(href, window.location.origin);
        return ['http:', 'https:', 'mailto:'].includes(url.protocol);
    } catch (e) {
        return false;
    }
}

// 기존 notices.json도 안전하게 표시하기 위한 클라이언트 측 방어선입니다.
function sanitizeNoticeHtml(content) {
    const template = document.createElement('template');
    template.innerHTML = String(content || '').replace(/\r?\n/g, '<br>');

    Array.from(template.content.querySelectorAll('*')).reverse().forEach(element => {
        const tag = element.tagName.toLowerCase();
        if (!NOTICE_ALLOWED_TAGS.has(tag)) {
            if (NOTICE_DROP_WITH_CONTENT_TAGS.has(tag)) element.remove();
            else element.replaceWith(...Array.from(element.childNodes));
            return;
        }

        const href = element.getAttribute('href');
        const title = element.getAttribute('title');
        const target = element.getAttribute('target');
        Array.from(element.attributes).forEach(attr => element.removeAttribute(attr.name));

        if (tag === 'a') {
            if (href && isSafeNoticeHref(href)) element.setAttribute('href', href);
            if (title) element.setAttribute('title', title);
            if (target === '_blank') {
                element.setAttribute('target', '_blank');
                element.setAttribute('rel', 'noopener noreferrer');
            }
        }
    });

    return template.innerHTML;
}


root.AppDocuments = { sanitize: sanitizeNoticeHtml };
if (!document.querySelector('[data-notice-page]')) return;
const content = document.querySelector('.document-view__content');
if (localStorage.getItem('yugioh_theme_mode') === 'dark') document.documentElement.classList.add('dark-mode');
(async () => {
    try {
        const response = await fetch('https://storage.googleapis.com/ygo-synapse.firebasestorage.app/public/notices.json', {cache:'no-cache'});
        if (!response.ok) throw new Error('문서 조회 실패');
        const data = await response.json(); const id = new URLSearchParams(location.search).get('id');
        const notice = (data.notices || []).find(n => String(n.id).replace(/^(\d{4})-(\d{2})-(\d{2})T/, '$1.$2.$3T') === id);
        if (!notice) { content.textContent = '해당 공지사항을 찾을 수 없습니다.'; return; }
        document.title = notice.title + ' | YGO Synapse';
        const title = document.createElement('h1'); title.className = 'color-text-000'; title.textContent = notice.title;
        const date = document.createElement('p'); date.className = 'color-text-002'; date.textContent = String(notice.id).slice(0,10);
        const body = document.createElement('div'); body.innerHTML = sanitizeNoticeHtml(notice.content); content.replaceChildren(title,date,body);
    } catch (error) { content.textContent = '공지사항을 불러오지 못했습니다. 잠시 후 다시 확인해 주세요.'; }
})();
})(globalThis);
