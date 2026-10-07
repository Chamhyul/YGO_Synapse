import { renderExamples } from './examples.js';

const root = document.getElementById('specimens');
const params = new URLSearchParams(location.search);
const allowed = new Set(['tokens', 'combinations', 'geometry', 'examples', 'measurements']);
let category = allowed.has(params.get('category')) ? params.get('category') : 'tokens';
const el = (tag, text, attributes = {}) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
};
function group(title, description) {
  const section = el('section', undefined, { 'data-palette-group': '' });
  section.append(el('h2', title, { 'data-palette-heading': '' }));
  if (description) section.append(el('p', description, { 'data-palette-caption': '' }));
  root.append(section);
  return section;
}
function grid(section) { const node = el('div', undefined, { 'data-palette-grid': '' }); section.append(node); return node; }
function caption(node, text) { node.append(el('code', text, { 'data-palette-code': '' })); }
function tokenValue(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function renderTokens() {
  const groups = [
    ['테마', 'theme', ['000', '001', '002', '003', '004', 'card-odd', 'card-even'], '색조 174 계열 · 실행·선택·틴트·관리 카드 교차색'],
    ['표면', 'surface', ['000', '001', '002', '003', 'navi', 'white', 'black', 'search-detail'], '표면색은 실제 토큰을 읽습니다. surface-black은 공통 오버레이 배경막에 사용합니다.'],
    ['글자', 'text', ['000', '001', '002', '003', 'navi', 'table', 'white', 'black'], '글자 토큰은 Aa 견본의 글자색으로만 표시합니다. 고정 명도 토큰의 실제 적용 범위는 문서를 따릅니다.'],
    ['브랜드', 'brand', ['youtube', 'discord'], '기존 브랜드 원본색 · 라이트/다크 동일'],
    ['테두리', 'border', ['000', '001', '002', '003', 'navi'], '색상을 비교하는 선 견본입니다. 실제 선 굵기는 형태·선·그림자 분류에서 확인합니다.'],
  ];
  for (const [title, prefix, suffixes, description] of groups) {
    const list = grid(group(title, description));
    for (const suffix of suffixes) {
      const name = `--${prefix}-${suffix}`;
      const item = el('div', undefined, { 'data-palette-card': '' });
      const kind = prefix === 'text' ? 'text' : prefix === 'border' ? 'line' : 'surface';
      const swatch = el('div', kind === 'text' ? 'Aa 가나다 123' : undefined, { 'data-palette-swatch': kind, 'aria-hidden': 'true' });
      swatch.style[prefix === 'text' ? 'color' : prefix === 'border' ? 'borderTopColor' : 'backgroundColor'] = `var(${name})`;
      item.append(swatch); caption(item, name); item.append(el('p', tokenValue(name), { 'data-palette-role': '' })); list.append(item);
    }
  }
  const special = grid(group('특수 색상', '그림자색은 실제 shadow-small·shadow-modal 견본으로 확인합니다.'));
  for (const [name, className] of [['--red', 'color-text-000'], ['--red-highlighted', 'color-text-000'], ['--shadow', 'shadow-small color-surface-002'], ['--shadow-over', 'shadow-modal color-surface-001']]) {
    const item = el('div', undefined, { 'data-palette-card': '' });
    const sample = el('div', name.startsWith('--red') ? '위험 색상' : '그림자 견본', { class: className, 'data-palette-geometry-sample': '' });
    if (name.startsWith('--red')) sample.style.color = `var(${name})`;
    item.append(sample); caption(item, name); item.append(el('p', tokenValue(name), { 'data-palette-role': '' })); special.append(item);
  }
}
// 계산된 RGB를 역으로 추측하지 않고 실제 색상 클래스의 var() 연결을 읽는다.
// 같은 색상값을 가진 surface/text 토큰도 원래 역할에 맞게 구분된다.
function combinationTokens(node) {
  const declarations = new Map();
  const sheet = [...document.styleSheets].find(sheet => sheet.href && new URL(sheet.href).pathname === '/styles/components.css');
  if (!sheet) return null;
  for (const rule of sheet.cssRules) {
    if (!rule.selectorText?.startsWith('.color-') || !node.matches(rule.selectorText)) continue;
    for (const property of rule.style) {
      if (property.startsWith('--color-')) declarations.set(property, rule.style.getPropertyValue(property).trim());
    }
  }
  const resolve = (property, seen = new Set()) => {
    if (seen.has(property)) return '연결 확인 필요';
    seen.add(property);
    const value = declarations.get(property);
    if (!value) return null;
    if (value === 'transparent') return '없음';
    const variable = /^var\((--[\w-]+)\)$/.exec(value);
    if (!variable) return value;
    return variable[1].startsWith('--color-') ? resolve(variable[1], seen) : variable[1];
  };
  const textOnly = node.matches('.ui-button--text, .ui-link');
  const background = textOnly ? '없음' : resolve('--color-bg') || '없음';
  const text = resolve('--color-text') || '상속';
  return [background, text, textOnly ? '없음' : resolve('--color-highlight-bg') || background, resolve('--color-highlight-text') || text];
}
function inspect(node, container) {
  const output = el('output', '', { 'data-palette-inspection': '' }); container.append(output);
  const refresh = () => {
    const state = node.matches(':disabled, [aria-disabled="true"]') ? '비활성' : node.matches(':focus-visible') ? '키보드 포커스' : node.matches(':hover') ? '호버' : '기본';
    const tokens = combinationTokens(node);
    output.textContent = tokens
      ? `현재 상태: ${state}\n기본 배경: ${tokens[0]}\n기본 글자: ${tokens[1]}\n강조 배경: ${tokens[2]}\n강조 글자: ${tokens[3]}`
      : '색상 원본을 읽지 못했습니다. 현재 CSS 다시 읽기를 실행해 주세요.';
  };
  for (const event of ['pointerenter', 'pointerleave', 'focus', 'blur', 'transitionend']) node.addEventListener(event, () => requestAnimationFrame(refresh));
  requestAnimationFrame(refresh);
}
function renderCombinations() {
  const list = grid(group('기본·강조 색상 조합', '기본·강조에 연결된 실제 토큰명을 표시합니다. 호버·Tab으로 강조를 확인할 수 있습니다. 견본 패딩은 서비스 공통 규격이 아닙니다.'));
  const names = ['color-brand-youtube', 'color-brand-discord', 'color-theme', 'color-danger', ...['000', '001', '002', '003', '004', '005'].map(n => `color-type${n}`), 'color-tint-theme', 'color-tint-neutral', 'color-text-theme color-highlight-theme', 'color-theme-001'];
  for (const name of names) {
    const item = el('div', undefined, { 'data-palette-card': '' });
    const isLink = name === 'color-text-theme color-highlight-theme';
    const sample = el(isLink ? 'a' : 'button', isLink ? '본문 링크' : '색상 조합', { class: `${isLink ? 'ui-link' : 'ui-button shape-capsule'} ${name}`, 'data-palette-color-sample': '', ...(isLink ? { href: '#palette' } : { type: 'button' }) });
    sample.addEventListener('click', event => event.preventDefault()); item.append(sample); caption(item, name); inspect(sample, item); list.append(item);
  }
  const texts = grid(group('텍스트 버튼의 색상 조합', '채움·그림자 없이 글자색만 소비합니다. color-text-000은 강조색도 기본과 같습니다.'));
  for (const name of ['color-text-000', 'color-text-001', 'color-text-002', 'color-text-003', 'color-text-theme', 'color-text-red', 'color-text-table', 'color-text-003 color-highlight-theme', 'color-text-003 color-highlight-red', 'color-text-003 color-highlight-youtube']) {
    const item = el('div', undefined, { 'data-palette-card': '' });
    const sample = el('button', '텍스트 버튼', { class: `ui-button ui-button--text ${name}`, type: 'button' }); item.append(sample); caption(item, name); inspect(sample, item); texts.append(item);
  }
  const state = group('비활성·정적 소비자', '선택형 색상(color-text-selectable, color-navi, color-switch-theme)은 실제 사용 조합 분류에서 비교합니다.');
  const row = el('div', undefined, { 'data-palette-row': '' }); state.append(row);
  const disabled = el('button', '사용할 수 없음', { class: 'ui-button ui-control--disabled color-type001 color-disabled shape-capsule', disabled: '', 'data-palette-color-sample': '' }); row.append(disabled);
  row.append(el('span', '시크릿 레어 • 3장', { class: 'ui-chip ui-chip--compact color-tint-theme shape-capsule' }));
  row.append(el('span', '카드 이름', { class: 'ui-tag color-tint-neutral shape-rounded001' }));
  row.append(el('div', undefined, { class: 'loading-spinner-small color-theme-002', role: 'img', 'aria-label': '현황 대시보드의 초기 회전 링 색상 견본' }));
  caption(state, 'ui-control--disabled + color-disabled / ui-chip / ui-tag / loading-spinner-small + color-theme-002');
}
function renderGeometry() {
  let list = grid(group('곡률', '승인된 형태를 비교합니다. 색상과 견본의 크기는 형태 클래스의 책임이 아닙니다.'));
  for (const name of ['shape-rounded001', 'shape-rounded002', 'shape-rounded003', 'shape-rounded-lg', 'shape-capsule']) {
    const item = el('div', undefined, { 'data-palette-card': '' }); const sample = el('div', '곡률', { class: `color-surface-002 ${name}`, 'data-palette-geometry-sample': '' }); item.append(sample); caption(item, name); caption(item, `${getComputedStyle(sample).borderRadius}`); list.append(item);
    requestAnimationFrame(() => item.lastChild.textContent = `border-radius: ${getComputedStyle(sample).borderRadius}`);
  }
  list = grid(group('테두리', 'border-basic은 단독 사용 시 강조하지 않습니다. border-highlight를 조합한 견본과 비교하십시오. 카드 입력의 선만 비교하며 관리 입력 UI 전체를 재현하지 않습니다.'));
  for (const name of ['border-basic', 'border-basic border-highlight', 'border-theme', 'border-dashed', 'border-cardinput', 'border-section-000', 'border-section-001', 'border-section-danger']) {
    const item = el('div', undefined, { 'data-palette-card': '' }); const sample = el('div', '호버 · Tab', { class: `${name} shape-rounded002`, tabindex: '0', 'data-palette-geometry-sample': '' }); item.append(sample); caption(item, name); list.append(item);
  }
  const shadows = group('그림자', '넓은 전시 여백을 확보했습니다. 모바일 하단 그림자는 고정 위치를 제외한 단독 외형 견본입니다.');
  const shadowGrid = grid(shadows);
  for (const name of ['shadow-none', 'shadow-small', 'shadow-medium', 'shadow-modal', 'shadow-mobile-sheet', 'shadow-mobile-nav']) {
    const item = el('div', undefined, { 'data-palette-shadow-stage': '' }); item.append(el('div', name, { class: `color-surface-001 shape-rounded003 ${name}`, 'data-palette-geometry-sample': '' })); caption(item, name); shadowGrid.append(item);
  }
  const stackGroup = group('관리 교차색·접합·윤곽 그림자', '관리 행의 입력 구조는 제외한 승인 외형 견본입니다. 그림자는 투명한 목록 부모에 한 번만 적용합니다.');
  const stage = el('div', undefined, { 'data-palette-shadow-stage': '' }); const stack = el('div', undefined, { class: 'shadow-drop-small', 'data-palette-stack': '' });
  for (let i = 0; i < 3; i++) stack.append(el('div', `${i + 1} · 관리 카드 ${i % 2 ? '짝수' : '홀수'}`, { class: `ui-stack-card shape-rounded003 color-card-${i % 2 ? 'even' : 'odd'} ${i > 0 ? 'is-joined-before' : ''} ${i < 2 ? 'is-joined-after' : ''}` }));
  stage.append(stack); stackGroup.append(stage); caption(stackGroup, 'shadow-drop-small → ui-stack-card + shape-rounded003 + color-card-odd/even + is-joined-before/after');
}
function renderMeasurements() {
  root.append(el('p', '현재 CSS의 계산값입니다. 화면 너비에 따른 기반 글자 크기와 상속도 반영합니다. 폰트 이름은 선언값이며 실제 로드된 글꼴을 보장하지 않습니다. 이 값을 새 공통 척도로 사용하지 않습니다.', { 'data-palette-notice': '' }));
  const section = group('역할별 글자와 내부 간격', '코드의 고유 클래스를 그대로 적용합니다. 상세 출처·확정 여부는 Design.md의 현황 표를 참고하십시오.');
  const samples = [
    ['[홈]-[안내 본문]', '<div class="home-page"><p data-measure>카드를 검색하고 보유 현황을 확인합니다.</p></div>'],
    ['[홈]-[로그인 안내 제목]', '<div class="home-page"><div class="home-signin__description"><h2 class="home-signin__title" data-measure>로그인하고 카드를 관리하세요.</h2></div></div>'],
    ['[홈]-[FAQ 질문]', '<div class="ui-disclosure__summary color-text-000" data-measure>보유 카드는 어떻게 확인하나요?</div>'],
    ['[홈]-[FAQ 답변]', '<p class="ui-disclosure__body color-text-001" data-measure>카드 이름 또는 번호로 검색할 수 있습니다. 긴 설명의 줄 간격을 확인하는 예시입니다.</p>'],
    ['[단일 카드]-[카드 이름]', '<h2 class="search-card__title color-text-000" data-measure>예시 카드 이름</h2>'],
    ['[단일 카드]-[카드 설명]', '<div class="search-card__text color-surface-000 color-text-000 shape-rounded002" data-measure>카드 텍스트의 글자 크기·줄 간격·안쪽 여백을 확인합니다.</div>'],
    ['[단일 카드]-[보유 요약 번호]', '<p class="owned-card__number color-text-000" data-measure>DEMO-KR001</p>'],
    ['[단일 카드]-[분류·보유 위치 소형 칩]', '<span class="ui-chip ui-chip--compact color-tint-theme shape-capsule" data-measure>보관 위치</span>'],
    ['[홈·보유 현황]-[통계 숫자]', '<span class="ui-stat__value color-text-theme" data-measure>1,234</span>'],
    ['[환경설정]-[계정 닉네임]', '<span class="account-card__nickname color-text-000" data-measure>팔레트 사용자</span>'],
    ['[환경설정]-[멤버십 확인·로그아웃 버튼]', '<button type="button" class="ui-button color-type001 shape-capsule account-card__action-button" data-measure>멤버십 확인</button>'],
    ['[단일 카드]-[정보 외곽]', '<div class="search-card color-surface-001 shape-rounded002" data-measure><span>정보 묶음 A</span><span>정보 묶음 B</span></div>'],
    ['[홈·보유 현황]-[통계 카드]', '<div class="ui-stat color-surface-001 shape-rounded-lg" data-measure><span class="ui-stat__label color-text-001">보유 카드 종류</span><span class="ui-stat__value color-text-theme">128</span></div>'],
  ];
  for (const [title, markup] of samples) {
    const row = el('section', undefined, { 'data-palette-measure-row': '' }); row.append(el('p', title, { 'data-palette-caption': '' }));
    const stage = el('div'); stage.innerHTML = markup; row.append(stage);
    const output = el('output', '', { 'data-palette-measure-result': '' }); row.append(output); section.append(row);
    const node = stage.querySelector('[data-measure]');
    const measure = () => { const css = getComputedStyle(node); output.textContent = `글자 ${css.fontSize} / 굵기 ${css.fontWeight} / 줄높이 ${css.lineHeight}\n글꼴 ${css.fontFamily}\n패딩 ${css.padding} / 마진 ${css.margin} / 간격 ${css.gap}`; };
    measurements.push(measure);
    requestAnimationFrame(measure);
    const observer = new ResizeObserver(measure); observer.observe(node); observers.push(observer);
  }
}
let observers = [];
let measurements = [];
let disposeExamples;
function render() {
  disposeExamples?.(); disposeExamples = undefined;
  observers.forEach(observer => observer.disconnect()); observers = [];
  measurements = [];
  root.replaceChildren();
  ({ tokens: renderTokens, combinations: renderCombinations, geometry: renderGeometry, examples: () => { disposeExamples = renderExamples(root); }, measurements: renderMeasurements })[category]();
  requestAnimationFrame(reportSize);
}
let scheduled = false;
function reportSize() {
  scheduled = false;
  const warnings = [];
  for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
    if (!link.sheet) warnings.push(`스타일 미로드: ${new URL(link.href).pathname.split('/').pop()}`);
  }
  for (const face of document.fonts) if (face.status === 'error') warnings.push(`${face.family} 로드 실패`);
  // body 높이는 iframe 높이에 종속되지 않는다. 반복적인 자동 높이 증가를 방지한다.
  parent.postMessage({ type: 'palette-size', width: innerWidth, height: Math.ceil(document.body.getBoundingClientRect().height), mobile: document.documentElement.classList.contains('is-mobile-device'), warnings }, location.origin);
}
const resize = new ResizeObserver(() => { if (!scheduled) { scheduled = true; requestAnimationFrame(reportSize); } }); resize.observe(document.body);
window.addEventListener('resize', () => requestAnimationFrame(() => { measurements.forEach(measure => measure()); reportSize(); }));
window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.source !== parent || event.data?.type !== 'palette-config') return;
  const mobileChanged = document.documentElement.classList.contains('is-mobile-device') !== (event.data.device === 'mobile');
  document.documentElement.classList.toggle('is-mobile-device', event.data.device === 'mobile');
  if (allowed.has(event.data.category) && (event.data.category !== category || (mobileChanged && category === 'examples'))) { category = event.data.category; render(); }
  requestAnimationFrame(() => { measurements.forEach(measure => measure()); reportSize(); });
});
document.fonts.ready.then(reportSize);
document.fonts.addEventListener('loadingdone', reportSize);
document.fonts.addEventListener('loadingerror', reportSize);
window.addEventListener('load', reportSize, { once: true });
render();
