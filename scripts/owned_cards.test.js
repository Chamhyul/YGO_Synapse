const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { groupRows } = require('../public/owned-cards');

const source = fs.readFileSync(path.join(__dirname, '../public/owned-cards.js'), 'utf8');

function fixture({ reduced = false, animate = true, observeResize = false, computedStyle = true, collapsedHeight = 36, expandedHeight = 148 } = {}) {
    const animations = [], observers = [];
    const document = { activeElement: null, defaultView: { matchMedia: () => ({ matches: reduced }) }, selection: { isCollapsed: true } };
    document.getSelection = () => document.selection;
    if (computedStyle) document.defaultView.getComputedStyle = element => element._animation?.currentStyles
        || { opacity: '1', transform: 'none', clipPath: 'none' };
    if (observeResize) document.defaultView.ResizeObserver = class {
        constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
        observe(target) { this.target = target; }
        disconnect() { this.disconnected = true; }
        notify() { if (!this.disconnected) this.callback([{ target: this.target }]); }
    };
    class Element {
        constructor(tag) {
            this.tagName = tag.toUpperCase();
            this.nodeType = 1;
            this.ownerDocument = document;
            this.children = [];
            this.parentNode = null;
            this.dataset = {};
            this.attributes = new Map();
            this.classes = new Set();
            this.listeners = new Map();
            this.ownText = '';
            this.hidden = false;
            this.inert = false;
            this.scrollLeft = 0;
            this.style = {};
            this.collapsedHeight = collapsedHeight;
            this.expandedHeight = expandedHeight;
            this.width = 400;
            this.classList = {
                contains: cls => this.classes.has(cls),
                toggle: (cls, force = !this.classes.has(cls)) => {
                    if (force) this.classes.add(cls); else this.classes.delete(cls);
                    return force;
                },
            };
        }
        get className() { return [...this.classes].join(' '); }
        set className(value) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); }
        get id() { return this.attributes.get('id') || ''; }
        set id(value) { this.setAttribute('id', value); }
        setAttribute(name, value) { this.attributes.set(name, String(value)); }
        getAttribute(name) { return this.attributes.get(name) ?? null; }
        removeAttribute(name) { this.attributes.delete(name); }
        set textContent(value) { this.replaceChildren(); this.ownText = String(value); }
        get textContent() { return this.ownText + this.children.map(child => child.textContent).join(''); }
        set innerHTML(value) { throw new Error(`보유 정보는 HTML 문자열 삽입을 사용하지 않아야 합니다: ${value}`); }
        get isConnected() { return document.body?.contains(this) || false; }
        get parentElement() { return this.parentNode; }
        contains(node) { return node === this || this.children.some(child => child.contains(node)); }
        appendChild(node) { node.remove(); node.parentNode = this; this.children.push(node); return node; }
        append(...nodes) { nodes.forEach(node => this.appendChild(node)); }
        replaceChildren(...nodes) { [...this.children].forEach(child => child.remove()); this.ownText = ''; this.append(...nodes); }
        insertBefore(node, before) {
            if (!before) return this.appendChild(node);
            assert.equal(before.parentNode, this);
            if (node === before) return node;
            node.remove();
            this.children.splice(this.children.indexOf(before), 0, node);
            node.parentNode = this;
            return node;
        }
        remove() {
            if (this.isConnected && this.contains(document.activeElement)) document.activeElement = document.body;
            if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
            this.parentNode = null;
        }
        matches(selector) {
            return selector.split(',').some(part => {
                part = part.trim();
                if (part === '[id]') return !!this.id;
                if (part === '[contenteditable]:not([contenteditable="false"])') {
                    return this.attributes.has('contenteditable') && this.getAttribute('contenteditable') !== 'false';
                }
                const attribute = part.match(/^(\w+)?\[([\w-]+)(?:="([^"]*)")?\]$/);
                if (attribute) return (!attribute[1] || this.tagName === attribute[1].toUpperCase())
                    && this.attributes.has(attribute[2]) && (attribute[3] === undefined || this.getAttribute(attribute[2]) === attribute[3]);
                const [tag, ...classes] = part.split('.');
                return (!tag || this.tagName === tag.toUpperCase()) && classes.every(cls => this.classes.has(cls));
            });
        }
        querySelectorAll(selector) {
            return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
        }
        querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
        closest(selector) {
            for (let current = this; current; current = current.parentElement) {
                if (current.matches(selector)) return current;
            }
            return null;
        }
        addEventListener(type, callback) { this.listeners.set(type, callback); }
        dispatch(type, init = {}) {
            const event = {
                type, target: this, currentTarget: null,
                button: 0, detail: 1, defaultPrevented: false,
                bubbles: type === 'click', propagationStopped: false,
                preventDefault() { this.defaultPrevented = true; },
                stopPropagation() { this.propagationStopped = true; },
                ...init,
            };
            for (let current = this; current; current = current.parentElement) {
                event.currentTarget = current;
                current.listeners.get(type)?.(event);
                if (!event.bubbles || event.propagationStopped) break;
            }
            return event;
        }
        click(init = {}) { return this.dispatch('click', init); }
        focus(options) { document.activeElement = this; this.focusOptions = options; }
        getBoundingClientRect() {
            if (this.hidden) return { width: this.width, height: 0 };
            if (Number.isFinite(this._animation?.currentHeight)) return { width: this.width, height: this._animation.currentHeight };
            if (this.classList.contains('owned-card__content')) {
                const detail = this.querySelector('.owned-card__detail');
                return { width: this.width, height: detail && !detail.hidden && !detail.classList.contains('is-leaving') ? this.expandedHeight : this.collapsedHeight };
            }
            return { width: this.width, height: 140 };
        }
    }
    if (animate) Element.prototype.animate = function (keyframes, options) {
        const element = this;
        const animation = {
            element,
            keyframes: JSON.parse(JSON.stringify(keyframes)),
            options: JSON.parse(JSON.stringify(options)),
            currentHeight: parseFloat(keyframes[0].height),
            currentStyles: JSON.parse(JSON.stringify(keyframes[0])),
            cancelled: false,
            finished: false,
            onfinish: null,
            cancel() {
                this.cancelled = true;
                if (element._animation === this) element._animation = null;
            },
            finish() {
                this.finished = true;
                if (element._animation === this) element._animation = null;
                this.onfinish?.();
            },
        };
        this._animation = animation;
        animations.push(animation);
        return animation;
    };
    document.createElement = tag => new Element(tag);
    document.body = new Element('body');
    document.activeElement = document.body;
    const container = document.body.appendChild(new Element('section'));
    const context = vm.createContext({});
    vm.runInContext(source, context);
    const calls = { illustrations: [] };
    const options = {
        contextKey: 'account-a/card-1',
        loadIllustration: (card, illustration) => {
            calls.illustrations.push({ card, illustration });
            return Promise.resolve({ status: 'unavailable' });
        },
    };
    return {
        document, container, animations, observers, calls, api: context.OwnedCards,
        render: (rows, changes = {}, target = container) => context.OwnedCards.render(rows, target, { ...options, ...changes }),
        flush() {
            for (const animation of animations) {
                if (!animation.cancelled && !animation.finished) animation.finish();
            }
        },
    };
}

const row = (number, quantity = 1, location = '상자 A', rarity = 'UR', illustration = '기본', name = '샘플') =>
    [name, number, rarity, quantity, location, illustration, 'sample-cid'];
const rows = () => [row('SAMPLE-A'), row('SAMPLE-B'), row('SAMPLE-C')];

function assertPanelState(panel, { hidden, inactive, leaving = false }) {
    assert.equal(panel.hidden, hidden);
    assert.equal(panel.inert, inactive);
    assert.equal(panel.getAttribute('aria-hidden'), String(inactive));
    assert.equal(panel.classList.contains('is-leaving'), leaving);
}

test('동일 번호의 다른 이름을 합치고 위치·레어도·일러스트별 수량과 원본 데이터를 보존한다', () => {
    const input = [
        row('SAMPLE-A', 2, '상자 A', 'UR', '일러스트 10', '한국 이름'),
        row('SAMPLE-A', 3, '상자 A', 'UR', '일러스트 10', 'English Name'),
        row('SAMPLE-B', 7, '상자 B'),
        row('SAMPLE-A', '4', '상자 B', 'N', '기본'),
        row('SAMPLE-A', 1, '상자 A', 'N', '일러스트 2'),
        row('SAMPLE-A', 2, null, 'UR', ''),
        row('SAMPLE-A', 3, undefined, 'N', null),
        row('SAMPLE-A', 1, '  ', 'UR', '기본'),
    ];
    input[6][4] = undefined;
    const before = structuredClone(input);
    const grouped = groupRows(input, (a, b) => ['UR', 'N'].indexOf(a) - ['UR', 'N'].indexOf(b));
    assert.deepEqual(grouped.map(card => card.number), ['SAMPLE-A', 'SAMPLE-B']);
    const card = grouped[0];
    assert.equal(card.total, 16);
    assert.equal(card.name, '한국 이름');
    assert.equal(card.cid, 'sample-cid');
    assert.deepEqual(card.locations, ['상자 A', '상자 B', '']);
    assert.deepEqual(card.rarities, ['UR', 'N']);
    assert.deepEqual(card.illustrations.map(group => group.illustration), ['기본', '일러스트 2', '일러스트 10']);
    const detailRows = card.illustrations.flatMap(group => group.locations);
    assert.equal(detailRows.reduce((sum, item) => sum + item.total, 0), 16);
    assert.equal(detailRows.reduce((sum, item) => sum + [...item.quantities.values()].reduce((a, b) => a + b, 0), 0), 16);
    assert.equal(card.illustrations[2].locations[0].quantities.get('UR'), 5);
    assert.deepEqual(input, before);
});

test('요약 내부에 일러스트별·위치별 상세를 배치하고 실제 보유 레어도 칩의 합계가 요약과 일치한다', () => {
    const f = fixture();
    const described = [];
    const view = f.render([
        row('SAMPLE-A', 2, '상자 A', 'UR'), row('SAMPLE-A', 3, '상자 A', 'UR', '기본', '다른 이름'),
        row('SAMPLE-A', 4, '상자 B', 'N'), row('SAMPLE-A', 1, '상자 A', 'N', '일러스트 2'),
    ], { describeRarity: (key, card) => {
        described.push({ key, card });
        return { label: key === 'UR' ? '울트라 레어' : '노멀' };
    } });
    const entry = view.entries.get('SAMPLE-A');
    assert.equal(entry.quantity.textContent, '10장');
    assert.equal(entry.detail.parentNode, entry.locations.parentNode, '상세는 요약 위치 목록과 같은 콘텐츠 영역 안에 배치');
    assert.equal(entry.detail.parentNode, entry.button.parentNode, '같은 콘텐츠 영역의 우측 펼침 버튼은 유지');
    assert.equal(entry.item.contains(entry.detail), true, '상세는 요약과 같은 카드 표면 안에 배치');
    assert.equal(entry.item.querySelector('table'), null);
    assert.deepEqual(entry.locations.querySelectorAll('.ui-chip').map(chip => chip.textContent), ['상자 A', '상자 B']);
    const groups = entry.detail.querySelectorAll('.owned-card__illustration-group');
    assert.equal(groups.length, 2);
    assert.ok(groups.every(group => group.tagName === 'LI'));
    assert.deepEqual(groups.map(group => group.querySelectorAll('.owned-card__location-row').length), [2, 1]);
    const locationRows = groups.flatMap(group => group.querySelectorAll('.owned-card__location-row'));
    assert.deepEqual(locationRows.map(item => item.querySelector('.owned-card__location-chip').textContent), ['상자 A', '상자 B', '상자 A']);
    const chips = entry.detail.querySelectorAll('.owned-card__rarity-chip');
    assert.deepEqual(chips.map(chip => chip.textContent), ['울트라 레어 • 5장', '노멀 • 4장', '노멀 • 1장']);
    assert.equal(chips.reduce((sum, chip) => sum + Number(chip.textContent.match(/• (\d+)장$/)[1]), 0), 10);
    assert.ok(chips.every(chip => chip.classList.contains('ui-chip') && chip.classList.contains('color-tint-theme')));
    assert.ok(locationRows.every(item => {
        const chip = item.querySelector('.owned-card__location-chip');
        return chip.classList.contains('ui-chip') && chip.classList.contains('color-type003');
    }), '상세 위치 칩은 승인된 회색 배경·글자 색상 조합을 직접 사용');
    assert.ok(entry.locations.querySelectorAll('.ui-chip').every(chip => chip.classList.contains('color-tint-theme')), '접힌 요약 위치 칩의 독립된 기존 색상 조합은 보존');
    assert.ok(described.every(({ card }) => card.number === 'SAMPLE-A' && card.cid === 'sample-cid'));
    assert.equal(f.calls.illustrations.length, 0, '닫힌 상세는 일러스트를 요청하지 않음');
});

test('번호·위치·일러스트·번역 레어도의 HTML은 DOM 삽입 대신 텍스트로 표시한다', () => {
    const f = fixture();
    const value = '<img src=x onerror="bad()">';
    const view = f.render([row(value, 2, value, value, value)], {
        describeRarity: key => ({ label: key }),
    });
    const entry = view.entries.get(value);
    assert.equal(entry.item.querySelector('h3').textContent, value);
    assert.equal(entry.locations.querySelector('.ui-chip').textContent, value);
    assert.equal(entry.detail.querySelector('.owned-card__location-chip').textContent, value);
    assert.equal(entry.detail.querySelector('.owned-card__rarity-chip').textContent, `${value} • 2장`);
    assert.ok(f.container.querySelectorAll('img').every(image => image.classList.contains('owned-card__image')));
    assert.equal(entry.detail.querySelector('.tooltipped'), null);
});

test('닫힘/닫힘·열림/닫힘·닫힘/열림·열림/열림의 접합이 각 경계에서 결정되고 홀짝은 고정된다', () => {
    const f = fixture();
    const view = f.render(rows());
    const entries = [...view.entries.values()];
    const state = () => entries.map(entry => [entry.item.classList.contains('is-joined-before'), entry.item.classList.contains('is-joined-after')]);
    assert.deepEqual(state(), [[false, true], [true, true], [true, false]]);
    entries[1].button.click();
    assert.deepEqual(state(), [[false, false], [false, false], [false, false]]);
    entries[0].button.click();
    assert.deepEqual(state(), [[false, false], [false, false], [false, false]]);
    entries[1].button.click();
    assert.deepEqual(state(), [[false, false], [false, true], [true, false]]);
    entries[0].button.click();
    assert.deepEqual(state(), [[false, true], [true, true], [true, false]]);
    assert.deepEqual(entries.map(entry => entry.item.classList.contains('color-surface-001')), [true, false, true]);
    assert.deepEqual(entries.map(entry => entry.item.classList.contains('color-surface-002')), [false, true, false]);
});

test('같은 카드 재렌더는 펼침·동일 버튼·키보드 초점을 유지하며 상세 문구와 합계를 갱신한다', () => {
    const f = fixture();
    let view = f.render(rows());
    const entry = view.entries.get('SAMPLE-B');
    entry.button.click();
    entry.button.focus();
    view = f.render([row('SAMPLE-A'), row('SAMPLE-B', 8, '새 위치'), row('SAMPLE-C')], {
        describeRarity: () => ({ label: 'Ultra Rare' }),
    });
    assert.equal(view.entries.get('SAMPLE-B'), entry);
    assert.equal(f.document.activeElement, entry.button);
    assert.equal(entry.button.getAttribute('aria-expanded'), 'true');
    assert.equal(entry.quantity.textContent, '8장');
    assert.equal(entry.locations.querySelector('.ui-chip').textContent, '새 위치');
    assert.equal(entry.detail.querySelector('.owned-card__rarity-chip').textContent, 'Ultra Rare • 8장');
    assert.equal(entry.locations.hidden, true, '열린 상태에서 갱신해도 요약 위치 칩은 숨김');
    assert.equal(entry.detail.hidden, false);
    assert.equal(entry.detail.inert, false);
});

test('계정·카드 contextKey가 바뀌면 같은 번호라도 펼침 상태를 초기화하고 이전 카드를 제거한다', () => {
    const f = fixture();
    let view = f.render([row('SAMPLE-A')]);
    const old = view.entries.get('SAMPLE-A');
    old.button.click();
    view = f.render([row('SAMPLE-A')], { contextKey: 'account-b/card-1' });
    const next = view.entries.get('SAMPLE-A');
    assert.notEqual(next.button, old.button);
    assert.notEqual(next.detail.id, old.detail.id);
    assert.equal(next.button.getAttribute('aria-expanded'), 'false');
    assert.equal(next.detail.hidden, true);
    assert.equal(next.detail.inert, true);
    assert.equal(next.locations.hidden, false);
    assert.equal(old.item.isConnected, false);
});

test('구두점 제거 시 같은 문자열이 되는 번호와 동시에 존재하는 화면에서도 상세 ID가 충돌하지 않는다', () => {
    const f = fixture();
    const other = f.document.body.appendChild(f.document.createElement('section'));
    f.render([row('SAMPLE-A'), row('SAMPLEA'), row('SAMPLE_A')]);
    f.render([row('SAMPLE-A'), row('SAMPLEA')], {}, other);
    const details = f.document.body.querySelectorAll('.owned-card__detail');
    assert.equal(details.length, 5);
    assert.equal(new Set(details.map(detail => detail.id)).size, 5);
    for (const item of f.document.body.querySelectorAll('.owned-card')) {
        assert.equal(item.querySelector('button').getAttribute('aria-controls'), item.querySelector('.owned-card__detail').id);
    }
});

test('요약에서 상세로 펼칠 때 실제 요약 높이에서 출발하며 끝나면 고정 높이를 남기지 않는다', () => {
    const f = fixture({ collapsedHeight: 44, expandedHeight: 176 });
    const entry = f.render([row('SAMPLE-A')]).entries.get('SAMPLE-A');
    assert.equal(entry.content.getBoundingClientRect().height, 44);
    entry.button.click();
    const animation = entry.heightAnimation;
    assert.equal(animation.element, entry.content);
    assert.deepEqual(animation.keyframes, [{ height: '44px' }, { height: '176px' }]);
    assert.deepEqual(animation.options, { duration: 200, easing: 'ease' });
    assertPanelState(entry.locations, { hidden: false, inactive: true, leaving: true });
    assertPanelState(entry.detail, { hidden: false, inactive: false });
    assert.equal(entry.panelAnimations.length, 2);
    const panels = [...entry.panelAnimations];
    assert.equal(entry.content.getBoundingClientRect().height, 44, '첫 프레임은 0이 아닌 기존 요약 높이');
    animation.finish();
    assert.equal(entry.heightAnimation, null);
    assert.equal(entry.panelAnimations.length, 0);
    assert.ok(panels.every(panel => panel.cancelled));
    assertPanelState(entry.locations, { hidden: true, inactive: true });
    assertPanelState(entry.detail, { hidden: false, inactive: false });
    assert.equal(entry.content.getBoundingClientRect().height, 176);
    assert.equal(entry.content.getAttribute('style'), null);
    assert.deepEqual(entry.content.style, {});
    entry.content.expandedHeight = 230;
    assert.equal(entry.content.getBoundingClientRect().height, 230, '완료 뒤 내용 높이가 변해도 고정 높이로 자르지 않음');
});

test('빠른 닫기·재열기는 현재 표시 높이에서 반전하고 취소된 완료 콜백은 최종 상태를 바꾸지 않는다', () => {
    const f = fixture({ collapsedHeight: 36, expandedHeight: 180 });
    const entry = f.render([row('SAMPLE-A')]).entries.get('SAMPLE-A');
    assert.equal(entry.detail.hidden, true);
    assert.equal(entry.detail.inert, true);
    assert.equal(entry.detail.getAttribute('aria-hidden'), 'true');
    assert.equal(entry.locations.hidden, false);
    entry.button.click();
    const opening = entry.heightAnimation;
    opening.currentHeight = 96;
    assert.equal(entry.label.textContent, '닫기');
    assertPanelState(entry.locations, { hidden: false, inactive: true, leaving: true });
    assert.equal(entry.detail.hidden, false);
    assert.equal(entry.detail.inert, false);
    const child = entry.detail.appendChild(f.document.createElement('button'));
    child.focus();
    entry.button.click();
    const closing = entry.heightAnimation;
    assert.equal(opening.cancelled, true);
    assert.deepEqual(closing.keyframes, [{ height: '96px' }, { height: '36px' }]);
    assert.equal(f.document.activeElement, entry.button, '닫히는 상세 내부 초점은 제어 버튼으로 복귀');
    assert.equal(entry.detail.inert, true);
    assert.equal(entry.detail.getAttribute('aria-hidden'), 'true');
    assertPanelState(entry.detail, { hidden: false, inactive: true, leaving: true });
    assertPanelState(entry.locations, { hidden: false, inactive: false });
    const staleFinish = closing.onfinish;
    closing.currentHeight = 62;
    entry.button.click();
    const reopened = entry.heightAnimation;
    assert.equal(closing.cancelled, true);
    assert.deepEqual(reopened.keyframes, [{ height: '62px' }, { height: '180px' }]);
    staleFinish?.();
    assert.equal(entry.heightAnimation, reopened, '취소된 이전 완료 콜백이 새 애니메이션 참조를 지우지 않음');
    assert.equal(entry.detail.hidden, false);
    assert.equal(entry.detail.inert, false);
    assert.equal(entry.detail.getAttribute('aria-hidden'), 'false');
    assert.equal(entry.button.getAttribute('aria-expanded'), 'true');
    assertPanelState(entry.locations, { hidden: false, inactive: true, leaving: true });
    f.flush();
    assert.equal(entry.heightAnimation, null);
    entry.button.click();
    f.flush();
    assert.equal(entry.detail.hidden, true);
    assert.equal(entry.label.textContent, '펼치기');
    assert.equal(entry.locations.hidden, false);
});

test('동작 줄이기에서는 닫힘을 즉시 적용하고 빈 상태·삭제 후 남은 단일 카드의 모서리를 복원한다', () => {
    const f = fixture({ reduced: true });
    let view = f.render([row('SAMPLE-A'), row('SAMPLE-B')]);
    const entry = view.entries.get('SAMPLE-A');
    entry.button.click();
    entry.button.click();
    assert.equal(entry.detail.hidden, true);
    assert.equal(entry.locations.hidden, false);
    assert.equal(f.animations.length, 0);
    assert.equal(entry.heightAnimation, null);
    view = f.render([row('SAMPLE-A')]);
    assert.equal(entry.item.classList.contains('is-joined-before'), false);
    assert.equal(entry.item.classList.contains('is-joined-after'), false);
    assert.equal(view.entries.size, 1);
    view = f.render([]);
    assert.equal(view.list.hidden, true);
    assert.equal(view.empty.hidden, false);
    assert.equal(view.empty.textContent, '보유한 카드가 없습니다.');
    assert.ok(view.empty.classList.contains('color-text-002'));
    assert.equal(view.entries.size, 0);
});

test('같은 카드 목록의 순서 변경은 원래 버튼 초점과 펼침을 유지하고 표시 순서 기준으로 홀짝을 다시 계산한다', () => {
    const f = fixture();
    let view = f.render(rows());
    const entry = view.entries.get('SAMPLE-C');
    entry.button.click();
    entry.button.focus();
    view = f.render([row('SAMPLE-C'), row('SAMPLE-B'), row('SAMPLE-A')]);
    assert.equal(view.list.children[0], entry.item);
    assert.equal(f.document.activeElement, entry.button);
    assert.equal(entry.button.getAttribute('aria-expanded'), 'true');
    assert.equal(entry.detail.hidden, false);
    assert.deepEqual(view.list.children.map(item => item.dataset.number), ['SAMPLE-C', 'SAMPLE-B', 'SAMPLE-A']);
    assert.deepEqual(view.list.children.map(item => item.classList.contains('color-surface-001')), [true, false, true]);
});

test('화면 종료 dispose는 높이 애니메이션을 취소하면서 나가는 DOM을 보존하고 재진입 상태는 초기화한다', () => {
    const f = fixture({ observeResize: true });
    const view = f.render([row('SAMPLE-A')]);
    const entry = view.entries.get('SAMPLE-A');
    entry.button.click();
    const animation = entry.heightAnimation;
    const panels = [...entry.panelAnimations];
    const staleFinish = animation.onfinish;
    const observer = entry.heightObserver;
    const children = [...f.container.children];
    f.api.dispose(f.container);
    assert.equal(observer.disconnected, true);
    assert.equal(entry.heightObserver, null);
    assert.equal(animation.cancelled, true);
    assert.ok(panels.every(panel => panel.cancelled));
    assert.equal(entry.panelAnimations.length, 0);
    assert.equal(entry.heightAnimation, null);
    assert.deepEqual(f.container.children, children);
    assert.ok(entry.item.isConnected);
    staleFinish?.();
    assert.equal(entry.detail.hidden, false, '나가는 열린 DOM은 그대로 유지');
    assert.equal(entry.locations.hidden, true);
    const next = f.render([row('SAMPLE-A')]);
    assert.notEqual(next, view);
    assert.notEqual(next.entries.get('SAMPLE-A').button, entry.button);
    assert.equal(next.entries.get('SAMPLE-A').button.getAttribute('aria-expanded'), 'false');
    f.api.dispose(f.container);
    f.api.dispose(f.container);
});

test('외부 코드가 컨테이너를 비운 뒤에도 분리된 옛 목록을 재사용하지 않고 보유 UI를 복구한다', () => {
    const f = fixture();
    const before = f.render([row('SAMPLE-A')]);
    const entry = before.entries.get('SAMPLE-A');
    entry.button.click();
    f.container.replaceChildren();
    const unknown = row('SAMPLE-A', 2);
    unknown[4] = undefined;
    const after = f.render([row('SAMPLE-A', 5, null), unknown]);
    const next = after.entries.get('SAMPLE-A');
    assert.notEqual(before, after);
    assert.equal(after.list.parentNode, f.container);
    assert.equal(next.quantity.textContent, '7장');
    assert.equal(next.locations.querySelectorAll('.ui-chip').length, 1);
    assert.equal(next.locations.querySelector('.ui-chip').textContent, '위치 미지정');
    assert.equal(next.button.getAttribute('aria-expanded'), 'false');
});

const settleImages = () => new Promise(resolve => setImmediate(resolve));
const imageUrl = image => image.src || image.getAttribute('src') || '';

function pendingIllustrations() {
    const pending = [];
    const loadIllustration = (card, illustration) => new Promise((resolve, reject) => {
        pending.push({ card, illustration, resolve, reject });
    });
    return { pending, loadIllustration };
}

test('최초 펼침에 일러스트별 이미지를 요청하고 닫기·재열기에는 다시 요청하지 않는다', async () => {
    const f = fixture();
    const { pending, loadIllustration } = pendingIllustrations();
    const entry = f.render([
        row('SAMPLE-A', 2, '상자 A', 'UR', '1'),
        row('SAMPLE-A', 3, '상자 B', 'N', '1'),
        row('SAMPLE-A', 1, '상자 C', 'N', '3'),
    ], { loadIllustration }).entries.get('SAMPLE-A');
    assert.equal(pending.length, 0);
    entry.button.click();
    await settleImages();
    assert.deepEqual(pending.map(item => item.illustration), ['1', '3']);
    assert.ok(pending.every(({ card }) => card.number === 'SAMPLE-A' && card.name === '샘플' && card.cid === 'sample-cid'));
    const images = entry.detail.querySelectorAll('.owned-card__image');
    const statuses = entry.detail.querySelectorAll('.owned-card__image-status');
    assert.equal(images.length, 2);
    assert.ok(images.every(image => image.hidden && !imageUrl(image)));
    assert.ok(statuses.every(status => !status.hidden && status.textContent === '이미지 불러오는 중'));
    pending.forEach((item, i) => item.resolve({ status: 'loaded', url: `/illustrations/sample-${i}.webp` }));
    await settleImages();
    assert.deepEqual(images.map(imageUrl), ['/illustrations/sample-0.webp', '/illustrations/sample-1.webp']);
    assert.ok(images.every(image => !image.hidden));
    assert.ok(statuses.every(status => status.hidden));
    entry.button.click();
    f.flush();
    entry.button.click();
    assert.equal(pending.length, 2, '상세를 다시 열 때 기존 이미지를 유지');
});

test('이미지 조회 실패·빈 응답·요청 거부는 깨진 이미지 대신 같은 빈 상태를 표시한다', async () => {
    const f = fixture();
    const { pending, loadIllustration } = pendingIllustrations();
    const entry = f.render([
        row('SAMPLE-A', 1, '상자 A', 'UR', '1'),
        row('SAMPLE-A', 1, '상자 A', 'UR', '2'),
        row('SAMPLE-A', 1, '상자 A', 'UR', '3'),
    ], { loadIllustration }).entries.get('SAMPLE-A');
    entry.button.click();
    await settleImages();
    pending[0].resolve({ status: 'error', url: null });
    pending[1].resolve(undefined);
    pending[2].reject(new Error('synthetic illustration failure'));
    await settleImages();
    const images = entry.detail.querySelectorAll('.owned-card__image');
    const statuses = entry.detail.querySelectorAll('.owned-card__image-status');
    assert.ok(images.every(image => image.hidden && !imageUrl(image)));
    assert.ok(statuses.every(status => !status.hidden && status.textContent === '이미지 없음'));
});

test('조회 함수가 없고 레어도·위치가 비어 있어도 상세의 합계와 읽을 수 있는 대체 문구를 유지한다', async () => {
    const f = fixture();
    const entry = f.render([row('SAMPLE-A', 3, null, '')], { loadIllustration: undefined }).entries.get('SAMPLE-A');
    entry.button.click();
    await settleImages();
    assert.equal(entry.detail.querySelector('.owned-card__location-chip').textContent, '위치 미지정');
    assert.equal(entry.detail.querySelector('.owned-card__rarity-chip').textContent, '레어도 미지정 • 3장');
    assert.equal(entry.quantity.textContent, '3장');
    assert.equal(entry.detail.querySelector('.owned-card__image-status').textContent, '이미지 없음');
    assert.equal(entry.detail.querySelector('.owned-card__image').hidden, true);
});

test('펼친 카드를 갱신하면 새 이미지 요청만 반영하고 늦게 도착한 이전 결과는 폐기한다', async () => {
    const f = fixture();
    const { pending, loadIllustration } = pendingIllustrations();
    let view = f.render([row('SAMPLE-A')], { loadIllustration });
    const entry = view.entries.get('SAMPLE-A');
    entry.button.click();
    const oldImage = entry.detail.querySelector('.owned-card__image');
    await settleImages();
    view = f.render([row('SAMPLE-A', 2, '새 위치', 'N', '2')], { loadIllustration });
    const current = view.entries.get('SAMPLE-A');
    const nextImage = current.detail.querySelector('.owned-card__image');
    assert.equal(current, entry);
    assert.equal(current.open, true);
    assert.notEqual(nextImage, oldImage);
    await settleImages();
    assert.equal(pending.length, 2);
    pending[1].resolve({ status: 'loaded', url: '/illustrations/current.webp' });
    await settleImages();
    pending[0].resolve({ status: 'loaded', url: '/illustrations/stale.webp' });
    await settleImages();
    assert.equal(imageUrl(nextImage), '/illustrations/current.webp');
    assert.equal(imageUrl(oldImage), '', '분리된 이전 이미지에도 지연 응답을 적용하지 않음');
    assert.equal(oldImage.isConnected, false);
});

test('삭제·계정 전환·화면 종료 이후의 지연 이미지 응답은 이전 DOM을 변경하지 않는다', async () => {
    for (const exit of ['remove', 'context', 'dispose']) {
        const f = fixture();
        const { pending, loadIllustration } = pendingIllustrations();
        const entry = f.render([row('SAMPLE-A')], { loadIllustration }).entries.get('SAMPLE-A');
        entry.button.click();
        const image = entry.detail.querySelector('.owned-card__image');
        const status = entry.detail.querySelector('.owned-card__image-status');
        const initialText = status.textContent;
        await settleImages();
        if (exit === 'remove') f.render([], { loadIllustration });
        if (exit === 'context') f.render([row('SAMPLE-A')], { loadIllustration, contextKey: 'account-b/card-1' });
        if (exit === 'dispose') f.api.dispose(f.container);
        pending[0].resolve({ status: 'loaded', url: '/illustrations/stale.webp' });
        await settleImages();
        assert.equal(imageUrl(image), '', exit);
        assert.equal(image.hidden, true, exit);
        assert.equal(status.textContent, initialText, exit);
    }
});

test('URL 조회 성공 뒤 실제 이미지 로드가 실패하면 빈 상태로 전환한다', async () => {
    const f = fixture();
    const entry = f.render([row('SAMPLE-A')], {
        loadIllustration: () => Promise.resolve({ status: 'loaded', url: '/illustrations/unavailable.webp' }),
    }).entries.get('SAMPLE-A');
    entry.button.click();
    await settleImages();
    const image = entry.detail.querySelector('.owned-card__image');
    const status = entry.detail.querySelector('.owned-card__image-status');
    assert.equal(image.hidden, false);
    assert.equal(status.hidden, true);
    image.dispatch('error');
    assert.equal(image.hidden, true);
    assert.equal(status.hidden, false);
    assert.equal(status.textContent, '이미지 없음');
    assert.equal(entry.detail.querySelector('.owned-card__artwork').getAttribute('aria-busy'), 'false');
});

test('표시 언어 갱신은 열린 상세와 닫힌 요약의 표시 상태를 유지하면서 레어도 명칭만 바꾼다', () => {
    const f = fixture();
    const input = [row('SAMPLE-A', 2, '상자 A', 'SE'), row('SAMPLE-B', 3, '상자 B', 'SE')];
    let view = f.render(input, { describeRarity: () => ({ label: 'Secret Rare' }) });
    const open = view.entries.get('SAMPLE-A');
    const closed = view.entries.get('SAMPLE-B');
    open.button.click();
    open.button.focus();
    view = f.render(input, { describeRarity: () => ({ label: '시크릿 레어' }) });
    assert.equal(view.entries.get('SAMPLE-A'), open);
    assert.equal(view.entries.get('SAMPLE-B'), closed);
    assert.equal(f.document.activeElement, open.button);
    assert.equal(open.locations.hidden, true);
    assert.equal(open.detail.hidden, false);
    assert.equal(open.button.getAttribute('aria-expanded'), 'true');
    assert.equal(closed.locations.hidden, false);
    assert.equal(closed.detail.hidden, true);
    assert.equal(closed.button.getAttribute('aria-expanded'), 'false');
    assert.equal(open.detail.querySelector('.owned-card__rarity-chip').textContent, '시크릿 레어 • 2장');
    assert.equal(closed.detail.querySelector('.owned-card__rarity-chip').textContent, '시크릿 레어 • 3장');
    open.button.click();
    f.flush();
    assert.equal(open.locations.hidden, false);
    assert.equal(open.locations.querySelector('.ui-chip').textContent, '상자 A');
    assert.equal(open.detail.hidden, true);
});

test('animate 미지원 또는 동작 줄이기는 내용 전환 없이 최종 표시·접근성 상태를 즉시 적용한다', () => {
    for (const config of [{ animate: false }, { reduced: true }]) {
        const f = fixture(config);
        const entry = f.render([row('SAMPLE-A')]).entries.get('SAMPLE-A');
        entry.button.click();
        assert.equal(entry.locations.hidden, true);
        assert.equal(entry.detail.hidden, false);
        assert.equal(entry.detail.inert, false);
        assert.equal(entry.button.getAttribute('aria-expanded'), 'true');
        assert.equal(entry.heightAnimation, null);
        assert.equal(entry.panelAnimations.length, 0);
        entry.button.click();
        assert.equal(entry.locations.hidden, false);
        assert.equal(entry.detail.hidden, true);
        assert.equal(entry.detail.inert, true);
        assert.equal(entry.button.getAttribute('aria-expanded'), 'false');
        assert.equal(entry.heightAnimation, null);
        assert.equal(entry.panelAnimations.length, 0);
        assert.equal(f.animations.length, 0);
        assert.deepEqual(entry.content.style, {});
    }
});

test('요약과 상세 높이가 같아도 위치 칩과 상세 내용은 동시에 접히고 펼쳐진다', () => {
    const f = fixture({ collapsedHeight: 72, expandedHeight: 72 });
    const entry = f.render([row('SAMPLE-A')]).entries.get('SAMPLE-A');
    for (const open of [true, false]) {
        entry.button.click();
        assert.equal(entry.open, open);
        assert.deepEqual(entry.heightAnimation.keyframes, [{ height: '72px' }, { height: '72px' }]);
        const outgoing = open ? entry.locations : entry.detail;
        const incoming = open ? entry.detail : entry.locations;
        assertPanelState(outgoing, { hidden: false, inactive: true, leaving: true });
        assertPanelState(incoming, { hidden: false, inactive: false });
        const panels = entry.panelAnimations;
        assert.equal(panels.length, 2);
        for (const panel of panels) {
            assert.equal(panel.options.duration, 200);
            assert.equal(panel.options.easing, 'ease');
            const hidden = panel.keyframes[panel.element === incoming ? 0 : 1];
            const visible = panel.keyframes[panel.element === incoming ? 1 : 0];
            assert.equal(Number(hidden.opacity), 0);
            assert.equal(Number(visible.opacity), 1);
            assert.match(hidden.transform, /-4px/);
            assert.match(hidden.clipPath, /100%/);
            assert.notEqual(hidden.clipPath, visible.clipPath);
        }
        f.flush();
        assertPanelState(outgoing, { hidden: true, inactive: true });
        assertPanelState(incoming, { hidden: false, inactive: false });
        assert.equal(entry.heightAnimation, null);
        assert.equal(entry.panelAnimations.length, 0);
    }
});

test('빠른 방향 반전은 높이와 함께 두 패널의 현재 투명도·위치·접힘 범위를 이어받는다', () => {
    const f = fixture();
    const entry = f.render([row('SAMPLE-A')]).entries.get('SAMPLE-A');
    entry.button.click();
    const previous = [...entry.panelAnimations];
    const current = new Map(previous.map((animation, index) => {
        animation.currentStyles = { opacity: String(0.3 + index * 0.4), transform: `matrix(1, 0, 0, 1, 0, ${-3 + index})`, clipPath: `inset(0px 0px ${70 - index * 40}% 0px)` };
        return [animation.element, animation.currentStyles];
    }));
    entry.heightAnimation.currentHeight = 83;
    entry.button.click();
    assert.ok(previous.every(animation => animation.cancelled));
    assert.deepEqual(entry.heightAnimation.keyframes[0], { height: '83px' });
    for (const animation of entry.panelAnimations) {
        assert.deepEqual(animation.keyframes[0], current.get(animation.element));
    }
    f.flush();
    assertPanelState(entry.locations, { hidden: false, inactive: false });
    assertPanelState(entry.detail, { hidden: true, inactive: true });
});

test('현재 패널 스타일 조회가 없더라도 빠른 반전과 최종 표시 상태는 유지한다', () => {
    const f = fixture({ computedStyle: false });
    const entry = f.render([row('SAMPLE-A')]).entries.get('SAMPLE-A');
    entry.button.click();
    entry.heightAnimation.currentHeight = 80;
    entry.button.click();
    assert.equal(entry.panelAnimations.length, 2);
    assert.deepEqual(entry.heightAnimation.keyframes[0], { height: '80px' });
    f.flush();
    assertPanelState(entry.locations, { hidden: false, inactive: false });
    assertPanelState(entry.detail, { hidden: true, inactive: true });
});

test('갱신·삭제·계정 전환·외부 목록 교체는 진행 중 높이 전환과 폭 감시를 해제한다', () => {
    for (const operation of ['refresh', 'remove', 'context', 'external']) {
        const f = fixture({ observeResize: true });
        const entry = f.render([row('SAMPLE-A')]).entries.get('SAMPLE-A');
        entry.button.click();
        const animation = entry.heightAnimation;
        const panels = [...entry.panelAnimations];
        const observer = entry.heightObserver;
        const staleFinish = animation.onfinish;
        if (operation === 'refresh') f.render([row('SAMPLE-A', 5)], { describeRarity: () => ({ label: '번역 갱신' }) });
        if (operation === 'remove') f.render([]);
        if (operation === 'context') f.render([row('SAMPLE-A')], { contextKey: 'account-b/card-1' });
        if (operation === 'external') { f.container.replaceChildren(); f.render([row('SAMPLE-A')]); }
        assert.equal(animation.cancelled, true, operation);
        assert.ok(panels.every(panel => panel.cancelled), operation);
        assert.equal(entry.panelAnimations.length, 0, operation);
        assert.equal(entry.heightAnimation, null, operation);
        assert.equal(observer.disconnected, true, operation);
        assert.equal(entry.heightObserver, null, operation);
        staleFinish?.();
        assert.equal(entry.heightAnimation, null, operation);
        if (operation === 'refresh') {
            assert.equal(entry.detail.hidden, false);
            assert.equal(entry.locations.hidden, true);
            assert.equal(entry.detail.querySelector('.owned-card__rarity-chip').textContent, '번역 갱신 • 5장');
        }
    }
});

test('높이 전환 중 콘텐츠 폭이 바뀌면 이전 폭에서 측정한 목표 높이를 해제한다', () => {
    const f = fixture({ observeResize: true });
    const entry = f.render([row('SAMPLE-A')]).entries.get('SAMPLE-A');
    entry.button.click();
    const animation = entry.heightAnimation;
    const panels = [...entry.panelAnimations];
    const observer = entry.heightObserver;
    assert.equal(observer.target, entry.content);
    animation.currentHeight = 90;
    observer.notify();
    assert.equal(entry.heightAnimation, animation, '전환에 따른 높이 변화 자체는 폭 변경으로 취급하지 않음');
    entry.content.width = 280;
    entry.content.expandedHeight = 236;
    observer.notify();
    assert.equal(animation.cancelled, true);
    assert.ok(panels.every(panel => panel.cancelled));
    assert.equal(entry.panelAnimations.length, 0);
    assert.equal(observer.disconnected, true);
    assert.equal(entry.heightAnimation, null);
    assert.equal(entry.heightObserver, null);
    assert.equal(entry.content.getBoundingClientRect().height, 236);
    assert.equal(entry.detail.hidden, false);
    assert.equal(entry.locations.hidden, true);
});

test('카드 번호·수량·요약 위치 칩·빈 카드 면을 클릭하면 해당 카드 상세가 한 번 열리고 닫힌다', () => {
    for (const targetName of ['number', 'quantity', 'location', 'surface']) {
        const f = fixture();
        const entry = f.render([row('SAMPLE-A'), row('SAMPLE-B')]).entries.get('SAMPLE-A');
        const targets = {
            number: entry.item.querySelector('h3'),
            quantity: entry.quantity,
            location: entry.locations.querySelector('.ui-chip'),
            surface: entry.item,
        };
        targets[targetName].click();
        assert.equal(entry.open, true, targetName);
        assertPanelState(entry.locations, { hidden: false, inactive: true, leaving: true });
        assert.equal(entry.detail.hidden, false, targetName);
        assert.equal(f.animations.length, 3, `${targetName}: 버블링 중 중복 전환 금지`);
        assert.equal(f.container.querySelectorAll('.owned-card__detail').filter(detail => !detail.hidden).length, 1);
        f.flush();
        entry.item.click();
        assert.equal(entry.open, false, targetName);
        assertPanelState(entry.detail, { hidden: false, inactive: true, leaving: true });
        assert.equal(entry.locations.hidden, false, targetName);
        assert.equal(f.animations.length, 6, targetName);
        f.flush();
        assert.equal(entry.detail.hidden, true, targetName);
    }
});

test('열린 상세의 이미지·보관 위치·레어도 칩·상세 여백은 눌러도 닫히지 않는다', async () => {
    for (const selector of ['.owned-card__image', '.owned-card__location-chip', '.owned-card__rarity-chip', 'detail']) {
        const f = fixture();
        const entry = f.render([row('SAMPLE-A')], {
            loadIllustration: () => Promise.resolve({ status: 'loaded', url: '/illustrations/sample.webp' }),
        }).entries.get('SAMPLE-A');
        entry.item.click();
        await settleImages();
        const target = selector === 'detail' ? entry.detail : entry.detail.querySelector(selector);
        assert.equal(target.hidden, false, selector);
        f.flush();
        target.click();
        assert.equal(entry.open, true, selector);
        assert.equal(entry.detail.hidden, false, selector);
        assert.equal(entry.locations.hidden, true, selector);
        assert.equal(f.animations.length, 3, selector);
    }
});

test('기존 펼침 버튼·문구·화살표의 버블링과 키보드 활성화 클릭은 중복 없이 한 번만 전환한다', () => {
    for (const targetName of ['button', 'label', 'icon', 'keyboard']) {
        const f = fixture();
        const entry = f.render([row('SAMPLE-A')]).entries.get('SAMPLE-A');
        const target = targetName === 'label' ? entry.label
            : targetName === 'icon' ? entry.button.querySelector('i') : entry.button;
        if (targetName === 'keyboard') entry.button.focus();
        target.click(targetName === 'keyboard' ? { detail: 0 } : {});
        assert.equal(entry.open, true, targetName);
        assert.equal(f.animations.length, 3, targetName);
        f.flush();
        target.click(targetName === 'keyboard' ? { detail: 0 } : {});
        assert.equal(entry.open, false, targetName);
        assert.equal(f.animations.length, 6, targetName);
        assert.equal(entry.item.getAttribute('role'), null);
        assert.equal(entry.item.getAttribute('tabindex'), null);
        assert.equal(entry.item.querySelectorAll('button').length, 1, '키보드 조작 지점은 기존 버튼 한 개');
        if (targetName === 'keyboard') assert.equal(f.document.activeElement, entry.button);
    }
});

test('상세 안의 별도 링크·입력·버튼·편집 요소를 조작할 때는 카드 펼침 상태를 바꾸지 않는다', () => {
    const controls = [
        ['a', { href: '/help' }], ['button', {}], ['input', {}], ['select', {}], ['textarea', {}],
        ['div', { contenteditable: 'true' }], ['div', { contenteditable: '' }],
        ['div', { role: 'button' }], ['span', { role: 'link' }],
    ];
    for (const [tag, attributes] of controls) {
        const f = fixture();
        const entry = f.render([row('SAMPLE-A')]).entries.get('SAMPLE-A');
        entry.item.click();
        const control = f.document.createElement(tag);
        Object.entries(attributes).forEach(([key, value]) => control.setAttribute(key, value));
        entry.detail.appendChild(control);
        let count = 0;
        control.addEventListener('click', () => count++);
        const target = ['input', 'select', 'textarea'].includes(tag) ? control : control.appendChild(f.document.createElement('span'));
        target.click();
        assert.equal(count, 1, `${tag}: 개별 조작 이벤트 보존`);
        assert.equal(entry.open, true, `${tag}: 내부 조작으로 상세를 닫지 않음`);
        assert.equal(f.animations.length, 3, tag);
    }
    for (const [tag, attributes] of [['a', {}], ['div', { contenteditable: 'false' }]]) {
        const f = fixture();
        const entry = f.render([row('SAMPLE-A')]).entries.get('SAMPLE-A');
        const passive = entry.item.appendChild(f.document.createElement(tag));
        Object.entries(attributes).forEach(([key, value]) => passive.setAttribute(key, value));
        passive.click();
        assert.equal(entry.open, true, `${tag}: 실제 조작 역할이 없는 요소는 카드 클릭에 포함`);
    }
});

test('카드 안 텍스트 선택은 상세를 전환하지 않고 외부 선택이나 접힌 선택점은 정상 클릭을 허용한다', () => {
    for (const selectionType of ['inside', 'anchor-inside', 'focus-inside', 'outside', 'collapsed']) {
        const f = fixture();
        const entry = f.render([row('SAMPLE-A')]).entries.get('SAMPLE-A');
        const inside = entry.item.querySelector('h3');
        const outside = f.document.body.appendChild(f.document.createElement('p'));
        f.document.selection = {
            isCollapsed: selectionType === 'collapsed',
            anchorNode: ['inside', 'anchor-inside', 'collapsed'].includes(selectionType) ? inside : outside,
            focusNode: ['inside', 'focus-inside', 'collapsed'].includes(selectionType) ? inside : outside,
        };
        inside.click();
        assert.equal(entry.open, ['outside', 'collapsed'].includes(selectionType), selectionType);
    }
});

test('기본 동작이 취소된 클릭·주 버튼 이외 클릭·카드 바깥 클릭은 상세를 전환하지 않는다', () => {
    const f = fixture();
    const entry = f.render([row('SAMPLE-A')]).entries.get('SAMPLE-A');
    entry.item.click({ defaultPrevented: true });
    entry.item.click({ button: 1 });
    entry.item.click({ button: 2 });
    f.container.click();
    const child = entry.item.appendChild(f.document.createElement('span'));
    child.addEventListener('click', event => event.preventDefault());
    const event = child.click();
    assert.equal(event.defaultPrevented, true);
    assert.equal(entry.open, false);
    assert.equal(f.animations.length, 0);
    entry.item.click();
    assert.equal(entry.open, true, '정상 기본 클릭은 계속 동작');
});
