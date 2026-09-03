const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const initial = () => ({ langs: Object.fromEntries(Array.from({ length: 11 }, (_, i) =>
  [String(i), [i === 0 ? '기존' : i === 10 ? '기존 표시' : '']])) });
const rarity = key => [{ locale: 'ko', key, display: key }];
const errorWithCode = code => Object.assign(new Error(`Storage ${code}`), { code });

function fixture(options = {}) {
  let body = options.missing ? null : JSON.stringify(initial());
  let generation = options.missing ? 0 : 1;
  let saves = 0;
  const caches = [], conditions = [];
  const bucket = { file(name, version) { return {
    name,
    async getMetadata() {
      if (options.readError) throw errorWithCode(options.readError);
      if (body === null) throw errorWithCode(404);
      return [{ generation: String(generation) }];
    },
    async download() {
      if (options.downloadError) throw errorWithCode(options.downloadError);
      if (Number(version.generation) !== generation) throw errorWithCode(404);
      return [Buffer.from(options.invalidBody ?? body)];
    },
    async save(next, opts) {
      saves++;
      conditions.push(opts.preconditionOpts?.ifGenerationMatch);
      if (options.writeError) throw errorWithCode(options.writeError);
      if (Number(opts.preconditionOpts?.ifGenerationMatch) !== generation) throw errorWithCode(412);
      body = next;
      generation++;
    }
  }; } };
  const mocks = {
    './cardIndexDispatchService': {},
    '../config/firebase': { getBucket: () => bucket },
    './cardQueryService': {},
    '../utils/common': { updateRarityMemoryCache: data => caches.push(data) },
    './cardWriteService': {},
    '../scrapers/cardScraper': {}
  };
  const filename = path.join(__dirname, '../services/cardService.js');
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, console, Buffer,
    require(name) {
      if (!Object.hasOwn(mocks, name)) throw new Error(`격리되지 않은 의존성: ${name}`);
      return mocks[name];
    }
  }, { filename });
  return {
    update: module.exports.updateRarityMapping,
    caches, conditions,
    get saves() { return saves; },
    get body() { return body; }
  };
}

test('레어도 동시 추가는 충돌 후 재병합하여 기존 항목과 두 변경 모두 보존한다', async () => {
  const f = fixture();
  await Promise.all([f.update(rarity('추가 A')), f.update(rarity('추가 B'))]);
  assert.deepEqual(JSON.parse(f.body).langs['0'], ['기존', '추가 A', '추가 B']);
  assert.equal(f.saves, 3);
  assert.deepEqual(f.conditions, ['1', '1', '2']);
  assert.equal(f.caches.length, 2);
});

test('레어도 파일 부재는 generation 0 조건으로 최초 생성한다', async () => {
  const f = fixture({ missing: true });
  await f.update(rarity('최초'));
  assert.deepEqual(f.conditions, [0]);
  assert.deepEqual(JSON.parse(f.body).langs['0'], ['최초']);
});

test('같은 레어도의 재처리는 중복 추가나 파일 재저장을 하지 않는다', async () => {
  const f = fixture();
  await f.update(rarity('추가'));
  const result = await f.update(rarity('추가'));
  assert.equal(result.changed, false);
  assert.equal(f.saves, 1);
  assert.equal(f.caches.length, 1);
});

for (const options of [{ readError: 403 }, { downloadError: 503 }, { invalidBody: '{' }, { invalidBody: '{"langs":null}' }]) {
  test(`레어도 읽기·형식 오류는 기존 파일과 캐시를 보존한다: ${JSON.stringify(options)}`, async () => {
    const f = fixture(options);
    const previous = f.body;
    await assert.rejects(f.update(rarity('추가')));
    assert.equal(f.body, previous);
    assert.equal(f.saves, 0);
    assert.equal(f.caches.length, 0);
  });
}

test('지속적인 레어도 충돌은 최초 시도와 재시도 3회 뒤 실패하고 캐시를 보존한다', async () => {
  const f = fixture({ writeError: 412 });
  const previous = f.body;
  await assert.rejects(f.update(rarity('추가')), { code: 412 });
  assert.equal(f.saves, 4);
  assert.equal(f.body, previous);
  assert.equal(f.caches.length, 0);
});

test('레어도 저장 권한 오류는 재시도하거나 캐시를 갱신하지 않는다', async () => {
  const f = fixture({ writeError: 403 });
  await assert.rejects(f.update(rarity('추가')), { code: 403 });
  assert.equal(f.saves, 1);
  assert.equal(f.caches.length, 0);
});
