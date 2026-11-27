'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { allowsPrPreviewOrigin } = require('./origin.cjs');

test('샘플 전용 DB를 쓰는 시험 API만 저장소의 PR 미리보기 출처를 허용한다', () => {
  const mode = { environment: 'preview', mode: 'demo' };
  const origin = 'https://ygo-synapse--pr-123-k3pcjmzo.web.app';
  assert.equal(allowsPrPreviewOrigin(origin, mode, true), true);
  assert.equal(allowsPrPreviewOrigin(origin, mode, false), false);
  assert.equal(allowsPrPreviewOrigin(origin, { ...mode, mode: 'firebase' }, true), false);
  assert.equal(allowsPrPreviewOrigin(origin, { ...mode, environment: 'production' }, true), false);
  for (const other of [
    'https://ygo-synapse.web.app',
    'https://ygo-synapse--pr-0-abc.web.app',
    'https://ygo-synapse--pr-1-abc.web.app.evil.example',
    'https://ygo-synapse--pr-1-abc.web.app:443',
    'https://ygo-synapse--pr-1-abc.web.app/path',
    'https://other--pr-1-abc.web.app',
    'http://ygo-synapse--pr-1-abc.web.app',
    'null',
  ]) {
    assert.equal(allowsPrPreviewOrigin(other, mode, true), false, other);
  }
});
