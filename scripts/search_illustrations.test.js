const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { entries } = require('../public/search-illustrations');

test('DB 지역 목록 전체를 합치고 불연속 CIID 및 지역을 보존한다', () => {
    const result = entries({0: ['한국 이름', [1, 3]], 1: ['일본 이름', [1, 2, 3]]}, {files: {'123_7': {}, '1234_8': {}}}, '123');
    assert.deepEqual(result.map(([id, regions]) => [id, [...regions]]), [[1, ['한국', '일본']], [2, ['일본']], [3, ['한국', '일본']], [7, []]]);
});
test('DB 저장 형식을 지원하고 count로 발매 여부를 추측하지 않는다', () => {
    assert.deepEqual(entries({ko: {ciid: [3]}, ja: {ciid: [3, 7]}, 4: ['English', 8]}, null, '123').map(([id, regions]) => [id, [...regions]]), [[3, ['한국', '일본']], [7, ['일본']]]);
});
test('인덱스 실패 시에도 DB 일러스트 목록을 유지한다', () => {
    assert.deepEqual(entries({0: ['카드', [1]]}, null, '123').map(([id]) => id), [1]);
    assert.deepEqual(entries(null, null, '123'), []);
});
test('아시아 영어권 발매 지역은 아시아로 표시한다', () => {
    assert.deepEqual(entries({ae: {ciid: [1]}}, null, '123').map(([id, regions]) => [id, [...regions]]), [[1, ['아시아']]]);
});

function galleryFixture() {
    class Element {
        constructor(tagName) {
            this.tagName = tagName; this.children = []; this.parentNode = null;
            this.attributes = {}; this.dataset = {}; this.style = {}; this.className = '';
            this.hidden = false; this.isConnected = true; this.scrollLeft = 0;
            this.offsetLeft = 0; this.offsetWidth = 64; this.clientWidth = 220; this.events = {};
        }
        setAttribute(name, value) { this.attributes[name] = String(value); if (name === 'class') this.className = value; }
        getAttribute(name) { return this.attributes[name]; }
        set textContent(value) { this.text = value; this.children = []; }
        get textContent() { return this.text || this.children.map(node => node.textContent).join(''); }
        append(...nodes) {
            for (const node of nodes) {
                if (node.parentNode) node.parentNode.children = node.parentNode.children.filter(child => child !== node);
                node.parentNode = this; this.children.push(node);
            }
        }
        prepend(node) { this.append(node); this.children.unshift(this.children.pop()); }
        replaceChildren(...nodes) { this.children = []; this.text = ''; this.append(...nodes); }
        set innerHTML(html) {
            this.replaceChildren();
            const stack = [this];
            for (const token of html.matchAll(/<\/?([\w-]+)([^>]*)>|([^<]+)/g)) {
                if (token[3]) { stack[stack.length - 1].text = (stack[stack.length - 1].text || '') + token[3]; continue; }
                if (token[0].startsWith('</')) { stack.pop(); continue; }
                const node = new Element(token[1]);
                for (const attr of token[2].matchAll(/([\w-]+)="([^"]*)"/g)) node.setAttribute(attr[1], attr[2]);
                node.hidden = /\bhidden\b/.test(token[2]);
                stack[stack.length - 1].append(node);
                if (!token[0].endsWith('/>') && token[1] !== 'img') stack.push(node);
            }
        }
        querySelectorAll(selector) {
            const matches = node => selector.startsWith('.') ? node.className.split(' ').includes(selector.slice(1)) : node.tagName === selector;
            return this.children.flatMap(node => [...(matches(node) ? [node] : []), ...node.querySelectorAll(selector)]);
        }
        querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
        addEventListener(name, handler) { this.events[name] = handler; }
        contains(node) { return node === this || this.children.some(child => child.contains(node)); }
        getBoundingClientRect() { return { height: 360 }; }
        focus() { this.focused = true; }
    }
    const document = { createElement: tag => new Element(tag) };
    const window = { matchMedia: () => ({ matches: true }), IllustrationImages: {
        loadIndex: async () => ({ files: { '100_1': {}, '100_3': {} } }),
        label: id => id === 1 ? '기본' : `일러스트 ${id}`,
        preload: async (cid, id) => ({ url: `/art/${cid}_${id}.webp` }),
    } };
    const context = vm.createContext({ document, window, fetch: () => {}, console });
    vm.runInContext(fs.readFileSync(require.resolve('../public/search-illustrations'), 'utf8'), context);
    const box = new Element('article');
    const fillDetails = () => {
        const name = new Element('header'); name.className = 'search-card__name';
        const info = new Element('div'); info.className = 'search-card__info';
        box.replaceChildren(name, info);
    };
    fillDetails();
    return { box, fillDetails, mount: info => window.SearchIllustrations.mount(box, '100', info), window };
}

test('늦은 카드 정보로 다시 마운트해도 열린 일러스트 모드와 선택 이미지를 유지한다', async () => {
    const f = galleryFixture();
    await f.mount();
    await f.box.querySelector('.search-art-toggle').onclick();
    await f.box.querySelector('.search-art-next').onclick();
    assert.equal(f.box.dataset.artworkOpen, 'true');
    assert.equal(f.box.dataset.selectedArtwork, '3');
    f.fillDetails();
    const ready = f.mount({ 0: ['카드', [1, 3]] });
    assert.equal(f.box.querySelector('.search-art-gallery').hidden, false);
    assert.equal(f.box.querySelector('.search-card-details').hidden, true);
    assert.equal(f.box.querySelector('.search-art-toggle').getAttribute('aria-pressed'), 'true');
    await ready;
    await new Promise(resolve => setImmediate(resolve));
    const selected = f.box.querySelectorAll('.search-art-thumb').find(button => button.getAttribute('aria-pressed') === 'true');
    assert.equal(selected.dataset.artworkId, '3');
    assert.equal(f.box.querySelector('.search-art-picture').querySelector('img').src, '/art/100_3.webp');
    assert.equal(f.box.querySelector('.search-art-popup').textContent, '한국');
    await f.box.querySelector('.search-art-toggle').onclick();
    assert.equal(f.box.querySelector('.search-card-details').hidden, false);
    assert.equal(f.box.querySelector('.search-art-gallery').hidden, true);
});

test('순환 이동과 발매지역 팝업은 재사용 버튼 조합을 적용한 뒤에도 동작한다', async () => {
    const f = galleryFixture();
    await f.mount({ 0: ['카드', [1]], 1: ['カード', [3]] });
    await f.box.querySelector('.search-art-prev').onclick();
    assert.equal(f.box.dataset.selectedArtwork, '3');
    const region = f.box.querySelector('.search-art-region');
    const button = region.querySelector('button');
    button.onclick();
    assert.equal(button.getAttribute('aria-expanded'), 'true');
    assert.equal(f.box.querySelector('.search-art-popup').hidden, false);
    assert.equal(f.box.querySelector('.search-art-popup').textContent, '일본');
    await f.box.querySelector('.search-art-next').onclick();
    assert.equal(f.box.dataset.selectedArtwork, '1');
    assert.equal(f.box.querySelector('.search-art-popup').hidden, true);
});
