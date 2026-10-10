const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('public/script.js', 'utf8');
function fixture(index) {
    class Node {
        constructor() { this.children = []; this.textContent = ''; this.classList = { toggle() {} }; }
        append(...children) { this.children.push(...children); }
        replaceChildren(...children) { this.children = children; }
    }
    const nodes = Object.fromEntries(['.document-view__content', '[data-notice-position]', '[data-notice-prev]', '[data-notice-next]', '[data-notice-more]'].map(key => [key, new Node()]));
    const panel = { querySelector: selector => nodes[selector] };
    const context = vm.createContext({ document: { createElement: () => new Node() }, notices: [
        { id: '2026.10.09T10:00', date: '2026.10.09', title: '첫 공지', content: '첫 본문' },
        { id: '2026.10.09T11:00', date: '2026.10.09', title: '둘째 공지', content: '둘째 본문' }
    ], currentNoticeIndex: index, sanitizeNoticeHtml: value => value, panel });
    vm.runInContext(source.slice(source.indexOf('function renderCurrentNotice('), source.indexOf('const compactDocument =')), context);
    vm.runInContext('renderCurrentNotice(panel)', context);
    return nodes;
}
test('같은 날짜의 공지도 선택한 1건의 본문과 순번만 표시한다', () => {
    const nodes = fixture(1), body = nodes['.document-view__content'];
    assert.equal(body.children[0].textContent, '둘째 공지');
    assert.equal(body.children[2].innerHTML, '둘째 본문');
    assert.equal(nodes['[data-notice-position]'].textContent, '2 / 2');
    assert.equal(nodes['[data-notice-more]'].hidden, false);
});
test('첫 공지·마지막 공지의 이동 경계와 빈 목록 상태를 구별한다', () => {
    const first = fixture(0), last = fixture(1), empty = fixture(-1);
    assert.equal(first['[data-notice-prev]'].disabled, true);
    assert.equal(first['[data-notice-next]'].disabled, false);
    assert.equal(last['[data-notice-next]'].disabled, true);
    assert.equal(empty['[data-notice-more]'].hidden, true);
    assert.equal(empty['[data-notice-position]'].textContent, '0 / 0');
    assert.equal(empty['[data-notice-prev]'].disabled, true);
    assert.equal(empty['[data-notice-next]'].disabled, true);
});

test('모바일 목록 열기와 본문 닫기는 목록 완료 콜백을 기다리지 않고 함께 시작한다', () => {
    const calls = [], list = {}, detail = {};
    const context = vm.createContext({
        document: { documentElement: { classList: { contains: () => true } }, getElementById: id => id === 'notice-list-modal' ? list : detail },
        getAppModal: () => ({ open: () => calls.push('목록 열기') }),
        M: { Modal: { getInstance: () => ({ isOpen: true, close: () => calls.push('본문 닫기') }) } },
        updateMobileNoticeList() {}
    });
    const start = source.indexOf('function openNoticeListMode('), end = source.indexOf('function sanitizeNoticeHtml(', start);
    vm.runInContext(source.slice(start, end), context);
    vm.runInContext('openNoticeListMode()', context);
    assert.deepEqual(calls, ['목록 열기', '본문 닫기']);
});

test('공지 선택은 본문을 갱신하고 목록 상태만 닫으며 임시 복제본 전환을 호출하지 않는다', () => {
    const start = source.indexOf("const panel = document.getElementById('notice-modal');", source.indexOf('function renderDocumentNoticeList('));
    const end = source.indexOf('\n            }', start);
    const calls = [], panel = { dataset: {documentMode:'list'}, querySelector: () => ({focus:()=>calls.push('초점')}) };
    const context = vm.createContext({ document:{getElementById:()=>panel}, container:{children:[]}, index:1,
        noti:{date:'2026.10.09'}, currentNoticeIndex:0, compactDocument:{matches:true},
        markNoticeAsRead(){}, renderDocumentNoticeList(){}, renderCurrentNotice:()=>calls.push('본문 갱신'),
        syncDocumentListAccess:()=>calls.push('접근 상태 갱신') });
    vm.runInContext(source.slice(start,end), context);
    assert.equal(panel.dataset.documentMode,undefined);
    assert.equal(context.currentNoticeIndex,1);
    assert.deepEqual(calls,['본문 갱신','접근 상태 갱신','초점']);
});

test('좁은 공지 목록은 본문 DOM을 유지하며 조작을 차단하고 넓어지면 해제한다', () => {
    function node(){return {hidden:false,inert:false,attrs:{},classList:{toggle(){}},contains(target){return target===this;},setAttribute(key,value){this.attrs[key]=value;},removeAttribute(key){delete this.attrs[key];}};}
    const list=node(),content=node(),footer=node(),title=node();
    const panel={dataset:{documentMode:'list'},querySelector:key=>({'.document-view__content':content,'[data-notice-navigation]':footer,'.ui-overlay__header h2':title,'.ui-overlay__header button':{focus(){}}})[key]};
    let mobile=false;
    const context=vm.createContext({document:{activeElement:null,documentElement:{classList:{contains:()=>mobile}},getElementById:id=>id==='notice-modal'?panel:list,querySelectorAll:()=>[content]},compactDocument:{matches:true}});
    const start=source.indexOf('function syncDocumentListAccess()'),end=source.indexOf('compactDocument.addEventListener',start);
    vm.runInContext(source.slice(start,end),context);
    vm.runInContext('syncDocumentListAccess()',context);
    assert.equal(content.hidden,false);assert.equal(footer.hidden,false);
    assert.equal(content.inert,true);assert.equal(footer.inert,true);assert.equal(list.inert,false);
    assert.equal(content.attrs['aria-hidden'],'true');
    context.compactDocument.matches=false;vm.runInContext('syncDocumentListAccess()',context);
    assert.equal(content.inert,false);assert.equal(footer.inert,false);assert.equal(list.inert,false);
    context.compactDocument.matches=true;delete panel.dataset.documentMode;vm.runInContext('syncDocumentListAccess()',context);
    assert.equal(list.inert,true);assert.equal(content.inert,false);
    mobile=true;vm.runInContext('syncDocumentListAccess()',context);assert.equal(list.inert,false);
});

test('미리보기 배치 노드는 단일 class 속성에 공통 본문·문서 배치 클래스를 함께 제공한다', () => {
    const html = fs.readFileSync('previews/document-specimen.html', 'utf8');
    const tag = html.match(/<div\b[^>]*data-document-layout[^>]*>/)[0];
    assert.equal((tag.match(/\bclass=/g) || []).length, 1);
    assert.match(tag, /class="ui-overlay__body document-view"/);
});

function readStateFixture(stored = []) {
    const notices = [
        { id: '2026.10.09T10:00', date: '2026.10.09', title: '첫 공지' },
        { id: '2026.10.09T11:00', date: '2026.10.09', title: '둘째 공지' }
    ];
    let raw = JSON.stringify(stored);
    const saved = [];
    const context = vm.createContext({ notices, READ_NOTICES_KEY: 'read',
        localStorage: { getItem: () => raw, setItem: (_, value) => { raw = value; } },
        document: { getElementById: () => null }, updateNotiBadge() {},
        saveUserSetting: (_, value) => saved.push(Array.from(value)) });
    vm.runInContext(source.slice(source.indexOf('function getTop8NoticeIds('), source.indexOf('function closeNotiPopup(')), context);
    return { context, saved, read: () => JSON.parse(raw) };
}

test('동일 날짜의 공지를 열어도 해당 ID 1건만 읽음 처리한다', () => {
    const f = readStateFixture();
    vm.runInContext("markNoticeAsRead('2026.10.09T11:00')", f.context);
    assert.deepEqual(f.read(), ['2026.10.09T11:00']);
    assert.equal(vm.runInContext('isNoticeNew(notices[0])', f.context), true);
    assert.equal(vm.runInContext('isNoticeNew(notices[1])', f.context), false);
    assert.deepEqual(f.saved, [['2026.10.09T11:00']]);
});

test('구형 날짜-제목과 하이픈 ID 읽음을 보존하고 다음 저장 때 ID로 정리한다', () => {
    for (const key of ['2026.10.09-첫 공지', '2026-10-09T10:00']) {
        const f = readStateFixture([key]);
        assert.equal(vm.runInContext('isNoticeNew(notices[0])', f.context), false);
        vm.runInContext("markNoticeAsRead('2026.10.09T11:00')", f.context);
        assert.deepEqual(f.read(), ['2026.10.09T10:00', '2026.10.09T11:00']);
    }
});

test('이미 읽은 공지와 알 수 없는 ID는 저장하지 않는다', () => {
    const f = readStateFixture(['2026.10.09-첫 공지']);
    vm.runInContext("markNoticeAsRead('2026.10.09T10:00');markNoticeAsRead('unknown')", f.context);
    assert.equal(f.saved.length, 0);
    assert.deepEqual(f.read(), ['2026.10.09-첫 공지']);
});
