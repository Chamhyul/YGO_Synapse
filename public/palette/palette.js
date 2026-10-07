const controls = Object.fromEntries(['theme', 'width', 'device'].map(id => [id, document.getElementById(id)]));
const frames = ['light', 'dark'].map(theme => ({ theme, frame: document.getElementById(`${theme}-frame`), pane: document.querySelector(`[data-palette-pane="${theme}"]`) }));
const categories = new Set([...document.querySelectorAll('[data-category]')].map(button => button.dataset.category));
let category = categories.has(location.hash.slice(1)) ? location.hash.slice(1) : 'tokens';
let revision = Date.now();
for (const { frame } of frames) frame.addEventListener('load', () => {
  frame.contentWindow?.postMessage({ type: 'palette-config', category, device: controls.device.value }, location.origin);
});
function update(reload = false) {
  const grid = document.querySelector('[data-palette-frames]');
  grid.toggleAttribute('data-single', controls.theme.value !== 'both');
  const count = controls.theme.value === 'both' ? 2 : 1;
  grid.style.maxWidth = controls.width.value === 'auto' ? 'none' : `${(Number(controls.width.value) + 2) * count + (count - 1) * 18}px`;
  for (const { theme, frame, pane } of frames) {
    pane.hidden = controls.theme.value !== 'both' && controls.theme.value !== theme;
    frame.style.width = controls.width.value === 'auto' ? '100%' : `${controls.width.value}px`;
    if (reload || !frame.getAttribute('src')) frame.src = `/palette/specimen.html?${new URLSearchParams({ theme, category, device: controls.device.value, revision })}`;
    else frame.contentWindow?.postMessage({ type: 'palette-config', category, device: controls.device.value }, location.origin);
  }
  document.querySelectorAll('[data-category]').forEach(button => {
    if (button.dataset.category === category) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
}
document.querySelector('[data-palette-controls]').addEventListener('submit', event => event.preventDefault());
Object.values(controls).forEach(control => control.addEventListener('change', () => update()));
document.querySelectorAll('[data-category]').forEach(button => button.addEventListener('click', () => {
  category = button.dataset.category;
  history.replaceState(null, '', `#${category}`);
  update();
}));
document.getElementById('reload').addEventListener('click', () => { revision = Date.now(); update(true); });
window.addEventListener('message', event => {
  if (event.origin !== location.origin) return;
  const entry = frames.find(item => item.frame.contentWindow === event.source);
  if (!entry || event.data?.type !== 'palette-size') return;
  const { height, width, mobile, warnings } = event.data;
  if (Number.isFinite(height)) entry.frame.style.height = `${Math.max(300, Math.min(40000, height))}px`;
  document.getElementById(`${entry.theme}-status`).textContent = `${width}px · ${mobile ? '모바일 판정' : '데스크톱 판정'}`;
  entry.warnings = warnings || [];
  const allWarnings = [...new Set(frames.flatMap(item => item.warnings || []))];
  document.getElementById('status').textContent = allWarnings.length
    ? `확인 필요: ${allWarnings.join(' / ')}. 폰트 로드 상태에 따라 글자·아이콘이 달라질 수 있습니다.`
    : '합성 예제만 사용합니다. 앱 로그인·저장·검색 API는 실행하지 않습니다.';
});
update(true);
