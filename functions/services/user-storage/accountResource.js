'use strict';
const { encodeKey, decodeKey } = require('./codec');
const invalid = () => Object.assign(new Error('계정 작업 식별자가 올바르지 않습니다.'), { code: 'USER_STORAGE_INVALID_ARGUMENT' });
function accountResource(uid) {
  if (typeof uid !== 'string' || !uid || uid.length > 128 || Buffer.from(uid).toString() !== uid) throw invalid();
  return `account/${encodeKey(uid)}`;
}
function checkAccountResource(key) {
  if (typeof key !== 'string' || !key.startsWith('account/')) throw invalid();
  const uid = decodeKey(key.slice(8)); if (accountResource(uid) !== key) throw invalid(); return uid;
}
module.exports = { accountResource, checkAccountResource };
