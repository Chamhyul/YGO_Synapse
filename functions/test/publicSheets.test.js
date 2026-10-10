// Google・인증·저장에 접속하지 않는다. 공개 조회 HTTP와 CSV를 합성 응답으로 검사한다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../integrations/googleSheets.js'), 'utf8');
const id = 'a'.repeat(30);
const metadata = '<script>items.push({name: "Other", pageUrl: "https:\\/\\/untrusted.invalid", gid: "0",initialSheet: false});items.push({name: "MyCard", pageUrl: "https:\\/\\/untrusted.invalid", gid: "7",initialSheet: true});</script>';
const csv = '\uFEFF"카드 이름","카드 번호","레어도","수량","보관 위치","일러스트"\r\n"카드, \"\"특수\"\"\n이름","TEST-KR001","SE","004","12","02nd"\r\n"다른 카드","TEST-KR002","","0","텍스트 위치","1"';
const response = (body, type = 'text/csv', status = 200, extra = {}) => new Response(body, { status, headers: { 'Content-Type': type, ...extra } });
function fixture(responses) {
  const calls = [], deadlines = [], module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, URL, TextDecoder, Uint8Array,
    AbortSignal: { timeout(ms) { deadlines.push(ms); return AbortSignal.timeout(ms); } },
    fetch: async (url, options) => {
      calls.push({ url: new URL(url), options });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      assert.ok(next, '예상하지 않은 추가 요청 또는 인증 대체 경로');
      return next;
    },
    require() { assert.fail('인증 SDK 등 외부 의존성을 로드하면 안 됩니다.'); }
  });
  return { ...module.exports, calls, deadlines };
}
const good = () => [response(metadata, 'text/html'), response(csv)];
test('공개 CSV의 한글·쉼표·인용부호·개행·숫자 문자열을 그대로 보존한다', async () => {
  const f = fixture(good()), rows = await f.sheetsReadPublicMyCardRows(id);
  assert.deepEqual(JSON.parse(JSON.stringify(rows[1])), ['카드, "특수"\n이름', 'TEST-KR001', 'SE', '004', '12', '02nd']);
  assert.equal(rows[2][4], '텍스트 위치');
  assert.equal(f.calls[0].url.pathname, `/spreadsheets/d/${id}/htmlview`);
  assert.equal(f.calls[1].url.searchParams.get('gid'), '7');
  assert.equal(f.calls[1].url.searchParams.get('format'), 'csv');
  assert.deepEqual(f.deadlines, [20000]);
  for (const { url, options } of f.calls) {
    assert.equal(url.hostname, 'docs.google.com');
    assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'manual');
    assert.deepEqual(Object.keys(options.headers), ['Accept']);
    assert.equal(options.signal, f.calls[0].options.signal);
  }
});
test('ID는 문자열·허용 문자·25~200자만 받고 임의 URL과 배열을 거부한다', async () => {
  const f = fixture([]);
  for (const value of ['short', 'https://example.invalid/' + id, id + '/edit', 'a'.repeat(201), [id], null, 123]) {
    await assert.rejects(f.sheetsReadPublicMyCardRows(value), { code: 'INVALID_IMPORT' });
  }
  assert.equal(f.calls.length, 0);
});
test('비공개·존재하지 않음·로그인 이동·로그인 HTML 응답은 익명 접근 거부로 처리한다', async () => {
  const cases = [
    [response('', 'text/html', 403)], [response('', 'text/html', 404)],
    [response('', 'text/html', 302, { Location: 'https://accounts.google.com/' })],
    [response('<html>로그인 필요</html>', 'text/html')],
    [response(metadata, 'text/html'), response('<!doctype html>로그인', 'text/html')]
  ];
  for (const replies of cases) await assert.rejects(fixture(replies).sheetsReadPublicMyCardRows(id), { code: 'PUBLIC_SHEET_NO_ACCESS' });
});
test('공개 메타데이터에 MyCard가 없거나 중복되면 임의 첫 번째 탭으로 대체하지 않는다', async () => {
  for (const html of [metadata.replace('MyCard', 'Sheet2'), metadata + metadata]) {
    const f = fixture([response(html, 'text/html')]);
    await assert.rejects(f.sheetsReadPublicMyCardRows(id), { code: 'INVALID_IMPORT' });
    assert.equal(f.calls.length, 1);
  }
});
test('다운로드 이동은 지정한 HTTPS Google 호스트만 최대3회 허용한다', async () => {
  const allowed = 'https://doc-0g-4g-sheets.googleusercontent.com/download';
  const f = fixture([response(metadata, 'text/html'), response('', 'text/csv', 307, { Location: allowed }), response(csv)]);
  assert.equal((await f.sheetsReadPublicMyCardRows(id)).length, 3);
  assert.equal(f.calls[2].url.href, allowed);
  assert.equal(f.calls[2].options.credentials, 'omit');
  for (const url of ['https://evil.invalid/', 'https://doc-x-sheets.googleusercontent.com.evil.invalid/',
    'http://docs.google.com/', 'https://user:pass@docs.google.com/', 'https://docs.google.com:444/', 'https://accounts.google.com/']) {
    const blocked = fixture([response(metadata, 'text/html'), response('', 'text/csv', 302, { Location: url })]);
    await assert.rejects(blocked.sheetsReadPublicMyCardRows(id), { code: 'PUBLIC_SHEET_NO_ACCESS' });
    assert.equal(blocked.calls.length, 2);
  }
  const cycle = fixture([response(metadata, 'text/html'), ...Array.from({ length: 4 }, () => response('', 'text/csv', 307, { Location: allowed }))]);
  await assert.rejects(cycle.sheetsReadPublicMyCardRows(id), { code: 'PUBLIC_SHEET_NO_ACCESS' });
  assert.equal(cycle.calls.length, 5);
});
test('다운로드 차단은 실패하며 키·다른 탭·인증된 API로 대체하지 않는다', async () => {
  const f = fixture([response(metadata, 'text/html'), response('', 'text/csv', 403)]);
  await assert.rejects(f.sheetsReadPublicMyCardRows(id), { code: 'PUBLIC_SHEET_NO_ACCESS' });
  assert.equal(f.calls.length, 2);
});
test('네트워크·시간초과·429·5xx·지원하지 않는 응답은 일시 실패이며 원문 오류를 숨긴다', async () => {
  for (const failure of [new Error('더미 비밀정보'), Object.assign(new Error('더미 비밀정보'), {name:'TimeoutError'}),
    response('', 'text/html', 429), response('', 'text/html', 503), response('{}', 'application/json')]) {
    await assert.rejects(fixture([failure]).sheetsReadPublicMyCardRows(id), error => error.code === 'PUBLIC_SHEET_UNAVAILABLE'
      && !error.message.includes('더미 비밀정보'));
  }
});
test('선언 길이와 실제 스트림 모두8MiB 제한, 잘못된 UTF-8·CSV와50,000행 초과를 거부한다', async () => {
  for (const reply of [response('', 'text/csv', 200, { 'Content-Length': String(8 * 1024 * 1024 + 1) }),
    response(new Uint8Array(8 * 1024 * 1024 + 1)), response(new Uint8Array([0xff])),
    response('"닫히지 않은 셀'), response('"셀"invalid'), response('a\nb\n'.repeat(25001))]) {
    await assert.rejects(fixture([response(metadata, 'text/html'), reply]).sheetsReadPublicMyCardRows(id), { code: 'INVALID_IMPORT' });
  }
});
test('기존 MyCard!A1:Z 계약에 따라 AA 이후 열은 제외한다', async () => {
  const columns = Array.from({ length: 28 }, (_, i) => String(i));
  const f = fixture([response(metadata, 'text/html'), response(columns.join(','))]);
  const rows = await f.sheetsReadPublicMyCardRows(id);
  assert.equal(rows[0].length, 26); assert.equal(rows[0][25], '25');
});
