'use strict';

// 같은 binding·전환·인증을 유지하며 선택적 서비스만 실제 첫 사용까지 미룬다.
// factory 오류는 전파하고, 빈 구현이나 다른 저장소로 대체하지 않는다.
function deferredWriterService(create, { passiveLease = false } = {}) {
  let value;
  const current = () => value ||= create();
  const target = passiveLease ? {
    // 아직 한 번도 사용하지 않은 서비스에는 활성 요청 lease가 없다.
    writerLease: (...args) => value?.writerLease?.(...args),
  } : {};
  return new Proxy(target, { get(object, key, receiver) {
    if (Reflect.has(object, key)) return Reflect.get(object, key, receiver);
    const actual = current(), member = Reflect.get(actual, key, actual);
    return typeof member === 'function' ? member.bind(actual) : member;
  } });
}

function deferredWriterAdapters(create) {
  let value;
  const current = () => value ||= create();
  return Object.fromEntries(['legacy', 'rtdb'].map(backend =>
    [backend, deferredWriterService(() => current()[backend])]));
}

module.exports = { deferredWriterService, deferredWriterAdapters };
