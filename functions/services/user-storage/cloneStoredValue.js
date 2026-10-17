'use strict';
const { Timestamp } = require('firebase-admin/firestore');

// codec가 이미 검증한 값의 사본만 만든다. 저장 경계의 codec 검사를 대체하지 않는다.
// null 원형, __proto__, 희소 배열, Timestamp/Date/-0를 JSON 왕복 없이 보존한다.
function cloneStoredValue(value) {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Timestamp) return new Timestamp(value.seconds, value.nanoseconds);
  if (value instanceof Date) return new Date(value.getTime());
  const prototype = Object.getPrototypeOf(value);
  const result = Array.isArray(value) ? new Array(value.length) : Object.create(prototype);
  const plain = prototype === Object.prototype || prototype === null || Array.isArray(value) && prototype === Array.prototype;
  for (const key of Object.keys(value)) {
    const child = cloneStoredValue(value[key]);
    // 검증된 일반 객체는 직접 할당한다. __proto__와 사용자 원형의 setter는 실행하지 않는다.
    if (plain && key !== '__proto__') result[key] = child;
    else Object.defineProperty(result, key, { value: child, enumerable: true, writable: true, configurable: true });
  }
  return result;
}
module.exports = { cloneStoredValue };
