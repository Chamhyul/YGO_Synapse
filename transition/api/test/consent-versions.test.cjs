'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { once } = require('node:events');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { createServer } = require('../server.cjs');

test('가입 API는 공개 문서의 해시만 동의 증적으로 저장한다', async t => {
  const webRoot = process.env.TRANSITION_WEB_ROOT || path.resolve(__dirname, '../../../public');
  const documents = ['terms', 'privacy'];
  const expected = Object.fromEntries(documents.map(name => [name,
    createHash('sha256').update(readFileSync(path.join(webRoot, `${name}.html`))).digest('hex'),
  ]));
  const writes = [];
  const app = createServer({
    config: { mode: 'firebase', environment: 'production', webRoot },
    database: { async writesReady() { return true; }, async close() {} },
    authentication: {
      async verify(header) {
        assert.equal(header, 'Bearer fixture');
        return 'fixture-user';
      },
      async verifyAppCheck(header) { assert.equal(header, 'fixture-app'); },
    },
    repository: {
      async registrationStatus(uid) {
        assert.equal(uid, 'fixture-user');
        return writes.length > 0;
      },
      async completeRegistration(uid, versions) { writes.push({ uid, versions }); },
    },
  });
  const listening = once(app.server, 'listening');
  app.server.listen(0, '127.0.0.1');
  await listening;
  t.after(() => app.close());

  const url = `http://127.0.0.1:${app.server.address().port}/api/v2/registration`;
  const headers = { Authorization: 'Bearer fixture', 'X-Firebase-AppCheck': 'fixture-app' };
  const status = await fetch(url, { headers });
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { success: true, registered: false, consentVersions: expected });

  const complete = consentVersions => fetch(url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ agreements: { terms: true, privacy: true }, consentVersions }),
  });
  for (const name of documents) {
    const stale = await complete({ ...expected, [name]: '0'.repeat(64) });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).code, 'CONSENT_VERSION_CHANGED');
    assert.deepEqual(writes, []);
  }
  const current = await complete(expected);
  assert.equal(current.status, 200);
  assert.deepEqual(await current.json(), { success: true, registered: true });
  assert.deepEqual(writes, [{ uid: 'fixture-user', versions: expected }]);
});
