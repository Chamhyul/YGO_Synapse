'use strict';
const { createCardInfoHandler } = require('./cardInfoApi');
const { getCardApiAccess } = require('./cardApiAccessRepository');
// 명시적 demo binding과 카드 읽기 의존성만 연결한다. 일반 export는 기존 설정 차단을 유지한다.
function createWriterCardInfoHandler({ writerBinding, env = process.env, read, allow } = {}) {
  if (typeof read !== 'function' || !env.USER_PROFILE_WRITER_MODE) throw Object.assign(new Error('격리된 카드 읽기 의존성이 필요합니다.'), { code: 'USER_STORAGE_CONFIG_INVALID' });
  const access = getCardApiAccess({ writerBinding, env });
  const handler = createCardInfoHandler({ access, read, allow });
  return async (req, res) => {
    const replies = [], buffered = new Proxy(res, { get(target, property) {
      if (['set', 'status', 'json', 'send'].includes(property)) return (...args) => { replies.push([property, args]); return buffered; };
      const value = target[property]; return typeof value === 'function' ? value.bind(target) : value;
    } });
    try {
      await access.withRequest(req, () => handler(req, buffered));
      for (const [method, args] of replies) res[method](...args);
      return res;
    } catch (_) { return res.status(503).set('Cache-Control', 'private, no-store').json({ success: false, code: 'API_UNAVAILABLE' }); }
  };
}
module.exports = { createWriterCardInfoHandler };
