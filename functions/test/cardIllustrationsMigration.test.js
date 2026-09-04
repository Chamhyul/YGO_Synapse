const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(mocks) {
  const filename = path.join(__dirname, '..', 'services/cardIllustrationsMigrationService.js');
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, console, Date,
    require(name) { return mocks[name]; },
  }, { filename });
  return module.exports;
}

test('전체 언어를 순차 재크롤링하고 실제 ciid 배열을 보존한다', async () => {
  let active = 0;
  let maxActive = 0;
  const locales = ['ko', 'ja', 'ae', 'cn', 'en', 'de', 'fr', 'it', 'es', 'pt'];
  const localeIndexes = Object.fromEntries(locales.map((locale, index) => [locale, index]));
  const service = load({
    '../config/firebase': {
      db: { collection: () => ({ doc: () => ({}) }) }, FieldPath: {}, FieldValue: {},
    },
    'firebase-admin/functions': { getFunctions: () => ({}) },
    '../scrapers/cardScraper': {
      LOCALE_TO_INDEX: localeIndexes,
      crawlCardInPack: async (cid, locale) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        const index = localeIndexes[locale];
        const slot = new Array(10).fill(null);
        slot[index] = [`name-${locale}`, [1, 9, 15], { [`NO-${locale}`]: ['pack'] }, '', ''];
        active--;
        return { mergedInfoSlot: slot };
      },
    },
    './cardWriteService': { stageCardWrite() {} },
    './cardIndexDispatchService': { requestCardIndexWork() {} },
  });

  const result = await service.recrawlCardIllustrations({ id: '4041' });
  assert.equal(service.BATCH_SIZE, 2);
  assert.equal(maxActive, 1);
  assert.equal(Object.keys(result.info).length, 10);
  assert.deepEqual(Array.from(result.info[0][1]), [1, 9, 15]);
  assert.equal(result.numbers.length, 10);
  assert.deepEqual(Array.from(result.failedLocales), []);
});
