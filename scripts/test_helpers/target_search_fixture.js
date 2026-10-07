const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../../public/script.js'), 'utf8');

class Element {
    constructor(tagName, ownerDocument = null) {
        this.tagName = tagName.toUpperCase();
        this.ownerDocument = ownerDocument;
        this.children = [];
        this.attributes = {};
        this.className = '';
        this.ownText = '';
        this.isConnected = true;
        this.classList = {
            contains: name => this.className.split(' ').includes(name),
            add: name => { if (!this.className.split(' ').includes(name)) this.className += ` ${name}`; },
        };
    }
    set textContent(value) { this.ownText = String(value); this.children = []; }
    get textContent() { return this.ownText + this.children.map(child => child.textContent).join(''); }
    set innerHTML(value) {
        if (this.ownerDocument?.activeElement && this.contains(this.ownerDocument.activeElement)) this.ownerDocument.activeElement = this.ownerDocument.body;
        this.children = []; this.ownText = value;
    }
    appendChild(child) {
        if (child.tagName === '#FRAGMENT') this.append(...child.children);
        else this.children.push(child);
        return child;
    }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    prepend(child) { this.children.unshift(child); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    focus(options) { this.ownerDocument.activeElement = this; this.focusOptions = options; }
    querySelectorAll(selector) {
        const [tag, ...classes] = selector.split('.');
        const result = [];
        const visit = node => {
            for (const child of node.children) {
                if ((!tag || child.tagName === tag.toUpperCase()) &&
                    classes.every(name => child.className.split(' ').includes(name))) result.push(child);
                visit(child);
            }
        };
        visit(this);
        return result;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function fixture() {
    const document = { activeElement: null };
    const area = new Element('div', document);
    document.body = new Element('body', document);
    document.createElement = tag => new Element(tag, document);
    document.createDocumentFragment = () => new Element('#fragment', document);
    document.getElementById = () => area;
    document.querySelectorAll = () => [];
    const context = vm.createContext({
        document,
        searchSequence: 0, lastSearchState: null, region: 'ko',
        getRegionLocIdx: () => context.region === 'ko' ? 0 : 4,
        getRegionLangKeys: () => [context.region, context.region === 'ko' ? 0 : 4],
        DECODE_ATTR: { 0: { 0: '빛' }, 4: { 0: 'LIGHT' } },
        DECODE_SPECIES: { 0: { 0: '드래곤족' }, 4: { 0: 'Dragon' } },
        DECODE_ETC: { 0: { 0: '일반', 5: '엑시즈', 6: '펜듈럼', 13: '링크', 15: '일반 마법', 21: '일반 함정' },
            4: { 0: 'Normal', 5: 'Xyz', 6: 'Pendulum', 13: 'Link' } },
        DECODE_KIND: ['몬스터', '마법', '함정'],
        findCidByNameOrNo: () => '100', getInventoryRowsByCidOrName: () => [],
        ClientCache: { registerCid() {} },
        SearchIllustrations: { mount() {} }, M: { Tooltip: { init() {} } },
        renderOwnedCardsToContainer() {}, updateSearchHash() {}, console,
    });
    const load = (from, to) => vm.runInContext(source.slice(source.indexOf(from), source.indexOf(to)), context);
    load('function extractLangData(', 'function getCardMetaType(');
    load('function updateMemoryDecodedElements(', 'function getInventoryRowsByCidOrName(');
    load('async function renderTargetByCid(', 'function renderOwnedCardsToContainer(');
    return {
        area, context, document,
        render: meta => context.renderTargetSearchResult('기본 이름', [], null, area, '100', Promise.resolve(meta)),
        stats: () => area.querySelector('.search-card__table--monster').querySelectorAll('tr')[1].children.map(cell =>
            cell.querySelector('.search-card__label-desktop')?.textContent ?? cell.textContent),
    };
}

module.exports = { fixture, source };
