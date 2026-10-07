const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/script.js'), 'utf8');

function functionSource(name) {
    const start = source.indexOf(`function ${name}(`);
    const end = source.indexOf('\nfunction ', start + 1);
    assert.ok(start >= 0 && end > start, `함수 추출 실패: ${name}`);
    return source.slice(start, end);
}

// 관리 HTML 생성 결과를 작은 DOM으로 읽는다. 레이아웃·CSS 엔진을 대체하지 않으며,
// 외부 위젯/네트워크만 격리하고 행 생성·추가·삭제·재번호화는 앱 함수를 실행한다.
function fixture(view, mode, subMode = 'general') {
    const document = { activeElement: null };
    const dataKey = name => name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const decode = value => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    class Element {
        constructor(tagName = 'div') {
            this.tagName = tagName.toUpperCase();
            this.children = [];
            this.parentElement = null;
            this.attributes = new Map();
            this.dataset = {};
            this.style = {};
            this._value = '';
            this._text = '';
            this.classes = new Set();
            this.classList = {
                contains: name => this.classes.has(name),
                add: (...names) => names.forEach(name => this.classes.add(name)),
                remove: (...names) => names.forEach(name => this.classes.delete(name)),
                toggle: (name, force = !this.classes.has(name)) => {
                    if (force) this.classes.add(name); else this.classes.delete(name);
                    return force;
                },
            };
        }
        get parentNode() { return this.parentElement; }
        get className() { return [...this.classes].join(' '); }
        set className(value) { this.classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
        get id() { return this.attributes.get('id') || ''; }
        set id(value) { this.attributes.set('id', String(value)); }
        get value() { return this._value; }
        set value(value) { this._value = String(value); }
        get nextSibling() { return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1] || null; }
        get firstElementChild() { return this.children[0] || null; }
        get lastElementChild() { return this.children.at(-1) || null; }
        set textContent(value) { this._text = String(value); this.replaceChildren(); }
        get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
        set innerText(value) { this.textContent = value; }
        get innerText() { return this.textContent; }
        set innerHTML(value) { this.replaceChildren(); parseHTML(this, value); }
        setAttribute(name, value) {
            value = String(value);
            if (name === 'class') this.className = value;
            else if (name.startsWith('data-')) this.dataset[dataKey(name)] = value;
            else this.attributes.set(name, value);
            if (name === 'value') this.value = value;
        }
        getAttribute(name) {
            if (name === 'class') return this.className;
            if (name.startsWith('data-')) return this.dataset[dataKey(name)] == null ? null : String(this.dataset[dataKey(name)]);
            return this.attributes.get(name) ?? null;
        }
        removeAttribute(name) { this.attributes.delete(name); }
        hasAttribute(name) { return this.getAttribute(name) !== null; }
        appendChild(child) { child.remove(); child.parentElement = this; this.children.push(child); return child; }
        insertBefore(child, before) {
            if (!before) return this.appendChild(child);
            assert.equal(before.parentElement, this);
            child.remove();
            this.children.splice(this.children.indexOf(before), 0, child);
            child.parentElement = this;
            return child;
        }
        remove() {
            if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
            this.parentElement = null;
        }
        replaceChildren(...children) { for (const child of [...this.children]) child.remove(); children.forEach(child => this.appendChild(child)); }
        matches(selector) {
            return selector.split(',').some(part => {
                part = part.trim();
                const attrs = [...part.matchAll(/\[([\w-]+)(?:(\^?=)"([^"]*)")?\]/g)];
                part = part.replace(/\[[^\]]+\]/g, '');
                const tag = part.match(/^[a-z][\w-]*/i)?.[0];
                const id = part.match(/#([\w-]+)/)?.[1];
                return (!tag || this.tagName === tag.toUpperCase()) && (!id || this.id === id)
                    && [...part.matchAll(/\.([\w-]+)/g)].every(([, cls]) => this.classList.contains(cls))
                    && attrs.every(([, name, op, value]) => {
                        const actual = this.getAttribute(name);
                        return actual !== null && (!op || (op === '^=' ? actual.startsWith(value) : actual === value));
                    });
            });
        }
        querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
        querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
        closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
        insertAdjacentHTML(position, html) { assert.equal(position, 'beforeend'); parseHTML(this, html); }
        focus() { document.activeElement = this; }
    }
    function parseHTML(parent, html) {
        const stack = [parent];
        const tokens = String(html).match(/<!--[^]*?-->|<(?:[^>"']|"[^"]*"|'[^']*')*>|[^<]+/g) || [];
        for (const token of tokens) {
            if (token.startsWith('<!--')) continue;
            if (token.startsWith('</')) { stack.pop(); continue; }
            if (!token.startsWith('<')) { stack.at(-1)._text += decode(token); continue; }
            const tag = token.match(/^<([\w-]+)/)?.[1];
            if (!tag) continue;
            const node = new Element(tag);
            const attrs = token.slice(tag.length + 1, -1);
            for (const [, name, double, single, bare] of attrs.matchAll(/([^\s=/'">]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
                node.setAttribute(name, decode(double ?? single ?? bare ?? ''));
            }
            stack.at(-1).appendChild(node);
            if (!['input', 'br', 'hr', 'img'].includes(tag) && !token.endsWith('/>')) stack.push(node);
        }
        assert.equal(stack.length, 1, '관리 카드 HTML 닫힘 구조');
    }
    document.documentElement = new Element('html');
    if (view === 'mobile') document.documentElement.classList.add('is-mobile-device');
    document.body = document.documentElement.appendChild(new Element('body'));
    const wrapper = document.body.appendChild(new Element());
    wrapper.className = `${view}-cards-wrapper`;
    const list = wrapper.appendChild(new Element());
    list.id = `${view}-cards-list-${mode === 'add' ? subMode : mode}`;
    list.className = `${view}-cards-list`;
    document.getElementById = id => document.documentElement.querySelector(`#${id}`);
    document.createElement = tag => new Element(tag);
    const c = vm.createContext({
        document, console, UIStore: { mode }, addSubMode: subMode, currentEditingRowIndex: -1,
        IllustrationImages: { label: value => value || '' },
        getLocalizedRarity: value => value || '',
        setIllustrationValue(input, value) { input.value = value; },
        getIllustrationValue: input => input?.dataset.raw || input?.value || '',
        initCardWidgets() {}, restoreDesktopDropdownOptions() {}, lockNameInputAndSetLink() {},
    });
    const functions = [
        'escapeHTML', 'getSelectWrapperState', 'restoreSelectWrapperState', 'getDesktopCardData', 'updateManagementCardStack',
        'getMobileCardHtml', 'updateMobileCardDisplay', 'mobileAddEntry', 'reindexMobileCards', 'renderMobileCardsFromData',
        'triggerMobileCopy', 'triggerMobileDelete', 'triggerMobileMoveDelete', 'triggerMobileDiscardDelete',
        'getDesktopCardHtml', 'desktopAddEntry', 'reindexDesktopCards', 'renderDesktopCardsFromData',
        'triggerDesktopCopy', 'triggerDesktopDelete',
    ];
    vm.runInContext(functions.map(functionSource).join('\n'), c);
    return {
        c, list, document,
        add: data => c[`${view}AddEntry`](mode, subMode, data),
        rows: () => list.querySelectorAll(`.${view}-info-card`),
        reindex: () => c[view === 'mobile' ? 'reindexMobileCards' : 'reindexDesktopCards'](list),
        remove(row) {
            if (view === 'desktop') c.triggerDesktopDelete(row.querySelector('.btn-card-action.delete'));
            else c[mode === 'move' ? 'triggerMobileMoveDelete' : mode === 'discard' ? 'triggerMobileDiscardDelete' : 'triggerMobileDelete'](Number(row.dataset.index));
        },
    };
}

function data(index = 1) {
    return { name: `샘플 ${index}`, cardNo: `SAMPLE-KR00${index}`, illustration: '기본', rarity: 'UR', loc: `상자 ${index}`, to: '이동 상자', qty: String(index + 2), cardData: null };
}

function assertStack(f) {
    const rows = f.rows();
    rows.forEach((row, index) => {
        assert.equal(row.parentElement, f.list, '실제 목록의 직접 자식 유지');
        assert.equal(Number(row.dataset.index), index);
        assert.equal(row.querySelector('.card-num-badge').textContent, String(index + 1));
        assert.ok(row.classList.contains('ui-stack-card'));
        assert.ok(row.classList.contains('shape-rounded003'));
        assert.equal(row.classList.contains('color-card-odd'), index % 2 === 0, `${index}번 홀수색`);
        assert.equal(row.classList.contains('color-card-even'), index % 2 === 1, `${index}번 짝수색`);
        assert.equal(row.classList.contains('is-joined-before'), index > 0, `${index}번 위 접합`);
        assert.equal(row.classList.contains('is-joined-after'), index < rows.length - 1, `${index}번 아래 접합`);
    });
}

for (const view of ['desktop', 'mobile']) {
    for (const [mode, subMode] of [['add', 'general'], ['add', 'pack'], ['add', 'deck'], ['move', 'general'], ['discard', 'general']]) {
        test(`${view} ${mode}/${subMode}: 추가·삭제·재번호화가 접합과 교차색을 갱신하고 기존 입력을 보존한다`, () => {
            const f = fixture(view, mode, subMode);
            const first = f.add(data(1));
            assertStack(f);
            const inputs = first.querySelectorAll('input');
            const fields = first.querySelector('.mobile-card-fields');
            inputs[0].value = '편집 중인 이름';
            inputs[0].focus();
            const middle = f.add(data(2));
            const last = f.add(data(3));
            assertStack(f);
            assert.equal(f.document.activeElement, inputs[0]);
            assert.deepEqual(first.querySelectorAll('input'), inputs);
            assert.equal(inputs[0].value, '편집 중인 이름');
            assert.equal(first.querySelector('.mobile-card-fields'), fields);
            f.remove(middle);
            assert.deepEqual(f.rows(), [first, last]);
            assertStack(f);
            f.remove(first);
            assert.deepEqual(f.rows(), [last]);
            assertStack(f);
            const lastInputs = last.querySelectorAll('input');
            f.reindex();
            assert.equal(f.rows()[0], last);
            assert.deepEqual(last.querySelectorAll('input'), lastInputs);
            assert.equal(last.querySelector('[data-field="no"]').value, 'SAMPLE-KR003');
            if (view === 'desktop') {
                if (mode === 'move') {
                    assert.ok(last.querySelector('#desktop-wrap-move-from-1'));
                    assert.ok(last.querySelector('#desktop-wrap-move-to-1'));
                } else assert.ok(last.querySelector(`#desktop-wrap-${mode}-0`));
                assert.ok(last.querySelector('.btn-card-action.delete').hasAttribute('disabled'));
                f.remove(last);
                assert.deepEqual(f.rows(), [last], '데스크톱 마지막 행 삭제 방지 유지');
            } else {
                assert.equal(last.querySelector('.btn-card-action.edit').getAttribute('onclick'), 'openEditBottomSheet(0)');
                const removeName = mode === 'move' ? 'triggerMobileMoveDelete' : mode === 'discard' ? 'triggerMobileDiscardDelete' : 'triggerMobileDelete';
                assert.equal(last.querySelector('.btn-card-action.delete').getAttribute('onclick'), `${removeName}(0)`);
            }
        });
    }

    test(`${view}: 데이터 복원 후 초기 접합을 설정하고 복제로 기존 행과 값을 바꾸지 않는다`, () => {
        const f = fixture(view, 'add');
        f.c[view === 'desktop' ? 'renderDesktopCardsFromData' : 'renderMobileCardsFromData']([data(1), data(2), data(3)]);
        assertStack(f);
        const originalRows = f.rows();
        const originalInputs = originalRows.map(row => row.querySelectorAll('input'));
        if (view === 'desktop') f.c.triggerDesktopCopy(originalRows[0].querySelector('.btn-card-action.copy'));
        else f.c.triggerMobileCopy(0);
        assert.equal(f.rows().length, 4);
        assertStack(f);
        originalRows.forEach((row, index) => {
            assert.ok(f.rows().includes(row));
            assert.deepEqual(row.querySelectorAll('input'), originalInputs[index]);
            assert.equal(row.querySelector('[data-field="qty"]').value, data(index + 1).qty);
        });
        const copy = f.rows().find(row => !originalRows.includes(row));
        assert.equal(copy.querySelector('[data-field="no"]').value, 'SAMPLE-KR001');
        assert.notEqual(copy.querySelector('[data-field="name"]'), originalInputs[0][0]);
        if (view === 'desktop') assert.equal(f.rows()[1], copy, '데스크톱 복제의 바로 다음 행 삽입 유지');
    });
}
