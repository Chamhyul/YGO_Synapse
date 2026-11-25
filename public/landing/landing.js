'use strict';
// 제품 인증·API·저장 처리는 불러오지 않고 소개 페이지 안의 상태만 다룬다.
const themeButton = document.querySelector('#theme-theme-toggle-btn');
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
let overridden = false;
function setTheme(dark) {
  document.documentElement.classList.toggle('dark-mode', dark);
  themeButton.setAttribute('aria-pressed', String(dark));
  themeButton.setAttribute('aria-label', dark ? '라이트 모드로 전환' : '다크 모드로 전환');
  themeButton.querySelector('.material-icons').textContent = dark ? 'light_mode' : 'dark_mode';
}
themeButton.addEventListener('click', () => { overridden = true; setTheme(!document.documentElement.classList.contains('dark-mode')); });
systemTheme.addEventListener('change', event => { if (!overridden) setTheme(event.matches); });
setTheme(systemTheme.matches);

const destinations = { add: ['등록', '#add/general'], move: ['이동', '#move'], discard: ['제거', '#discard'] };
const radios = [...document.querySelectorAll('#preview-manage-top-segment input')];
const panels = [...document.querySelectorAll('[data-manage-panel]')];
const openMode = document.querySelector('.landing-open-mode');
radios.forEach(radio => {
  radio.setAttribute('aria-controls', `preview-${radio.value}-panel`);
  radio.addEventListener('change', () => {
    panels.forEach(panel => { panel.hidden = panel.dataset.managePanel !== radio.value; });
    const [label, hash] = destinations[radio.value];
    openMode.href = `https://ygo-synapse.web.app/${hash}`;
    openMode.firstChild.textContent = `${label} 화면 열기 `;
  });
});

const searchForm = document.querySelector('#landing-search-form');
const desktopInput = document.querySelector('#search-card-search');
const mobileInput = document.querySelector('#mobile-search-mobile-card-search');
const mobileWidth = window.matchMedia('(max-width: 600px)');
const searchInputs = [desktopInput, mobileInput];
const searchButtons = [document.querySelector('#search-search-btn'), document.querySelector('#mobile-search-mobile-search-btn')];
const mobileClear = document.querySelector('#mobile-search-mobile-search-clear-btn');
searchInputs.forEach(input => {
  input.placeholder = '카드 검색';
  input.addEventListener('input', () => {
    searchInputs.forEach(other => { if (other !== input) other.value = input.value; });
    mobileClear.hidden = !input.value;
  });
});
searchButtons.forEach(button => { button.type = 'submit'; button.setAttribute('aria-label', '서비스에서 카드 검색 (새 탭)'); });
mobileClear.addEventListener('click', () => { searchInputs.forEach(input => { input.value = ''; }); mobileClear.hidden = true; mobileInput.focus(); });
function syncSearchLabel() {
  document.querySelector('.landing-search > label').htmlFor = (mobileWidth.matches ? mobileInput : desktopInput).id;
}
mobileWidth.addEventListener('change', syncSearchLabel);
syncSearchLabel();
searchForm.addEventListener('submit', event => {
  event.preventDefault();
  const input = mobileWidth.matches ? mobileInput : desktopInput;
  const query = input.value.trim();
  if (!query) { input.focus(); return; }
  const url = new URL('https://ygo-synapse.web.app/');
  url.hash = `search?${new URLSearchParams({ q: query })}`;
  window.open(url.href, '_blank', 'noopener,noreferrer');
});
