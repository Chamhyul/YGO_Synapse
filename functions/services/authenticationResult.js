'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const context = new AsyncLocalStorage();
const CONTENT_TYPE = 'application/x-ndjson';

// 인증 결과와 기록 종료를 분리한다. HTTP 요청 자체는 기록/잠금 정리가
// 끝날 때까지 유지하므로 응답 종료 후의 비보장 fire-and-forget을 만들지 않는다.
function withAuthenticationResult(req, res, kind, work) {
  if (req.method !== 'POST' || req.body?.authenticationResultStream !== true
      || typeof res.write !== 'function' || typeof res.end !== 'function') return work(res);
  const state = { kind, res, published: false, ended: false, status: 200 };
  const proxy = new Proxy(res, { get(target, property) {
    if (property === 'status') return code => {
      state.status = code;
      if (!state.published) target.status(code);
      return proxy;
    };
    if (['set', 'type'].includes(property)) return (...args) => {
      if (!state.published) target[property](...args);
      return proxy;
    };
    if (property === 'json') return result => {
      if (!state.published) return target.json(result);
      state.finalResult = result;
      return proxy;
    };
    const value = target[property];
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return context.run(state, async () => {
    let completed = false;
    try { const result = await work(proxy); completed = true; return result; }
    catch (error) { if (!state.published) throw error; }
    finally {
      if (state.published && !state.ended && !res.writableEnded) {
        state.ended = true;
        const success = completed && state.status < 400 && state.finalResult?.success === true;
        try { res.end(JSON.stringify({ v: 1, type: 'recorded', success,
          ...(success ? { result: state.finalResult } : {}) }) + '\n'); } catch (_) {}
      }
    }
  });
}

function prepareAuthenticationResult(result, beforePublish) {
  const state = context.getStore();
  if (state && !state.published) { state.result = result; state.beforePublish = beforePublish; }
}
function publishAuthenticationResult(result) {
  const state = context.getStore();
  if (!state || state.published || state.res.destroyed || state.res.writableEnded) return;
  const value = result || state.result;
  if (value?.success !== true) return;
  // 연결 종료는 기존 업무 저장·journal 확정·복구를 중단하지 않는다.
  try {
    const frame = JSON.stringify({ v: 1, type: 'result', result: value }) + '\n';
    state.beforePublish?.();
    state.res.status(200).set('Content-Type', CONTENT_TYPE + '; charset=utf-8');
    state.res.set('Cache-Control', 'private, no-store, no-transform');
    state.res.set('X-Accel-Buffering', 'no');
    state.published = true;
    state.res.write(frame);
    state.res.flush?.();
  } catch (_) { /* 결과 전달 실패로 확정 저장·기록 정리를 취소하지 않는다. */ }
}
function publishAuthenticationCommit(operation, verifyReceipt) {
  const state = context.getStore(), details = operation.details;
  if (state?.result && (state.kind === 'membership' && details?.kind === 'membership' && details.action === 'complete'
      || state.kind === 'admin' && details?.kind === 'session' && details.action === 'set')) {
    verifyReceipt();
    publishAuthenticationResult();
  }
}
function isAuthenticationResultRequest() { return !!context.getStore(); }

// 고정 운영 주소에서 받은 결과만 로컬 전달 경로에서 중계한다. 호출자가
// UID·제공자 증명 형식을 검사한 뒤에만 첫 결과를 화면으로 보낼 수 있다.
async function readAuthenticationResponse(response, onResult) {
  if (!response.headers.get('content-type')?.startsWith(CONTENT_TYPE)) return response.json();
  let buffer = '', first, final, bytes = 0;
  const decoder = new TextDecoder();
  const packet = line => {
    if (!line.trim()) return;
    const value = JSON.parse(line);
    if (value.v !== 1 || final) throw new Error('Invalid authentication response');
    if (value.type === 'result' && !first && value.result?.success === true) {
      first = value.result; onResult?.(first);
    } else if (value.type === 'recorded' && first && value.success === true && value.result?.success === true) final = value.result;
    else throw new Error('Authentication recording unavailable');
  };
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > 1024 * 1024) throw new Error('Invalid authentication response');
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); packet(line);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) packet(buffer);
  if (!final) throw new Error('Authentication recording unavailable');
  return final;
}

module.exports = { CONTENT_TYPE, withAuthenticationResult, prepareAuthenticationResult,
  publishAuthenticationResult, publishAuthenticationCommit, isAuthenticationResultRequest, readAuthenticationResponse };
