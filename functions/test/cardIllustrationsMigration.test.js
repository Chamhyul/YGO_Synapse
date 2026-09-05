const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(fetchImpl = async () => { throw new Error('unexpected fetch'); }) {
  const filename = path.join(__dirname, '..', 'services/cardIllustrationsMigrationService.js');
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, console, Date, URL, encodeURIComponent,
    fetch: fetchImpl,
    AbortSignal: { timeout: () => ({}) },
    require(name) {
      if (name === '../config/firebase') {
        return { db: { collection: () => ({ doc: () => ({}) }) }, FieldPath: {} };
      }
      if (name === 'firebase-admin/functions') return { getFunctions: () => ({}) };
      throw new Error(`Unexpected module: ${name}`);
    },
  }, { filename });
  return module.exports;
}

test('thumbnail 내 실제 ciid를 중복 없이 숫자 순으로 추출한다', () => {
  const service = load();
  const html = `
    <div id="thumbnail">
      <img id="thumbnail_card_image_1" src="/get_image.action?cid=4041&amp;ciid=1">
      <img id="thumbnail_card_image_9" src="/get_image.action?cid=4041&amp;ciid=9">
      <img id="thumbnail_card_image_15" src="/get_image.action?cid=4041&amp;ciid=15">
    </div>
    <img id="thumbnail_card_image_99" src="?ciid=99">
  `;
  assert.deepEqual(Array.from(service.extractIllustrationIds(html)), [1, 9, 15]);
  assert.equal(service.extractIllustrationIds('<div id="other"></div>'), null);
});

test('언어 페이지를 순차 조회하고 기존 언어 정보에서 ciid만 교체한다', async () => {
  let active = 0;
  let maxActive = 0;
  const requestedLocales = [];
  const service = load(async url => {
    active++;
    maxActive = Math.max(maxActive, active);
    const locale = new URL(url).searchParams.get('request_locale');
    requestedLocales.push(locale);
    await Promise.resolve();
    active--;
    return {
      ok: true,
      status: 200,
      text: async () => '<div id="cardname">card</div><div id="thumbnail"><img id="thumbnail_card_image_1" src="?ciid=1"><img id="thumbnail_card_image_15" src="?ciid=15"></div>',
    };
  });
  const info = {};
  service.LOCALES.forEach((locale, index) => {
    info[index] = [`name-${locale}`, [99], { [`NO-${locale}`]: ['pack'] }, '', ''];
  });

  const result = await service.recrawlCardIllustrations({ id: '4041', data: () => ({ info }) });

  assert.equal(service.BATCH_SIZE, 1);
  assert.equal(maxActive, 1);
  assert.deepEqual(requestedLocales, Array.from(service.LOCALES));
  assert.equal(Object.keys(result.info).length, 10);
  assert.deepEqual(Array.from(result.info[0][1]), [1, 15]);
  assert.equal(result.info[0][0], 'name-ko');
  assert.deepEqual(result.info[0][2], info[0][2]);
  assert.deepEqual(Array.from(result.failedLocales), []);
});

test('미출시 언어는 기존 데이터를 덮어쓰지 않는다', async () => {
  const service = load(async url => {
    const locale = new URL(url).searchParams.get('request_locale');
    if (locale === 'ja') {
      return { ok: true, status: 200, text: async () => '<div id="cardname">card</div><div id="thumbnail"><img src="?ciid=2"></div>' };
    }
    return { ok: false, status: 404, text: async () => '' };
  });
  const result = await service.recrawlCardIllustrations({
    id: '4041',
    data: () => ({ info: { 0: ['한국어', [1], {}, '', ''], 1: ['日本語', [1], {}, '', ''] } }),
  });

  assert.deepEqual(Object.keys(result.info), ['1']);
  assert.deepEqual(Array.from(result.info[1][1]), [2]);
});
