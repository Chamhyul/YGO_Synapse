'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const { performance } = require('node:perf_hooks');
const { cpuUsage } = require('node:process');
const context = new AsyncLocalStorage();
const observers = new WeakMap();
const MAX_GETS = 64, MAX_CONNECTIONS = 4, MAX_CHANGES = 32, INTERVAL_MS = 20;
const round = n => Math.round(Math.max(0, n) * 1000) / 1000;
const kinds = new Set(['storage', 'profile', 'record']);

// .info/connected는 SDK의 로컬 연결 메타정보다. 업무 경로/원문/토큰은 관측하지 않는다.
// DB 객체별 한 번만 연결한다. unknown(-1)은 disconnected(0)로 해석하지 않는다.
function connectionFor(database) {
  if (!database || !['object', 'function'].includes(typeof database)) return undefined;
  let state = observers.get(database);
  if (state) return state;
  state = { state: -1, changedAt: undefined, sequence: 0, changes: [], dropped: 0, errors: 0 };
  observers.set(database, state);
  try {
    const ref = database.ref('.info/connected');
    if (typeof ref?.on !== 'function') return state;
    ref.on('value', snapshot => {
      try {
        const value = snapshot.val();
        if (typeof value !== 'boolean') return;
        const next = value ? 1 : 0;
        if (next === state.state) return;
        state.state = next; state.changedAt = performance.now(); state.sequence++;
        state.changes.push({ sequence: state.sequence, at: state.changedAt, state: next });
        if (state.changes.length > MAX_CHANGES) { state.changes.shift(); state.dropped++; }
      } catch (_) { state.errors++; }
    }, () => { state.errors++; });
  } catch (_) { state.errors++; }
  return state;
}

// 개별 요청의 숫자 관측만 보관한다. 타이머는 unref하며 응답 finish/close에서 제거한다.
function createReadDiagnostics(started = performance.now()) {
  const data = { version: 1, gets: [], droppedGets: 0, connections: [],
    eventLoopSamples: 0, eventLoopMaxDelayMs: 0, observerErrors: 0 };
  const links = new Map(), pending = new Set();
  let active = true, timer, lastTick = performance.now();
  const cpu = cpuUsage();
  const tick = () => {
    try {
      if (!active) return;
      const now = performance.now(), delay = round(now - lastTick - INTERVAL_MS); lastTick = now;
      data.eventLoopSamples++; data.eventLoopMaxDelayMs = Math.max(data.eventLoopMaxDelayMs, delay);
      for (const get of pending) {
        get.eventLoopSamples++; get.eventLoopMaxDelayMs = Math.max(get.eventLoopMaxDelayMs, delay);
      }
    } catch (_) { data.observerErrors++; }
  };
  try { timer = setInterval(tick, INTERVAL_MS); timer.unref(); } catch (_) { data.observerErrors++; }
  function link(database) {
    const state = connectionFor(database);
    if (!state) return undefined;
    if (links.has(state)) return links.get(state);
    if (links.size >= MAX_CONNECTIONS) return undefined;
    const entry = { id: links.size + 1, stateAtFirstGet: state.state, stateAtEnd: state.state,
      firstGetMs: round(performance.now() - started), changes: [], observerErrors: 0 };
    if (state.changedAt !== undefined) entry.lastObservedChangeAgeMs = round(performance.now() - state.changedAt);
    const value = { state, entry, sequence: state.sequence, dropped: state.dropped, errors: state.errors };
    links.set(state, value); data.connections.push(entry); return value;
  }
  function begin(database, kind) {
    if (!active || !kinds.has(kind)) return undefined;
    if (data.gets.length >= MAX_GETS) { data.droppedGets++; return undefined; }
    const connection = link(database), now = performance.now(), cpu = cpuUsage();
    const get = { id: data.gets.length + 1, kind, startMs: round(now - started),
      connectionId: connection?.entry.id || 0, stateAtStart: connection?.state.state ?? -1,
      eventLoopSamples: 0, eventLoopMaxDelayMs: 0 };
    data.gets.push(get); pending.add(get);
    return ok => {
      if (!active) return;
      pending.delete(get);
      const used = cpuUsage(cpu);
      Object.assign(get, { durationMs: round(performance.now() - now), ok,
        stateAtEnd: connection?.state.state ?? -1,
        processCpuUserMs: round(used.user / 1000), processCpuSystemMs: round(used.system / 1000) });
    };
  }
  return {
    run: action => context.run({ begin }, action),
    finish() {
      if (!active) return undefined;
      active = false; clearInterval(timer); pending.clear();
      try {
        for (const { state, entry, sequence, dropped, errors } of links.values()) {
          entry.stateAtEnd = state.state; entry.observerErrors = state.errors - errors;
          entry.droppedChanges = state.dropped - dropped;
          entry.changes = state.changes.filter(x => x.sequence > sequence)
            .map(x => ({ atMs: round(x.at - started), state: x.state }));
        }
        const used = cpuUsage(cpu);
        data.processCpuUserMs = round(used.user / 1000); data.processCpuSystemMs = round(used.system / 1000);
        return data;
      } catch (_) { return { version: 1, observerErrors: 1 }; }
    },
  };
}

function measureRtdbGet(database, kind, action) {
  let done;
  try { done = context.getStore()?.begin(database, kind); } catch (_) { /* 관측 실패를 업무에서 격리 */ }
  const finish = ok => { try { done?.(ok); } catch (_) { /* 원래 결과·오류를 보존 */ } };
  try {
    const result = action();
    if (!done) return result;
    return Promise.resolve(result).then(value => { finish(true); return value; }, error => { finish(false); throw error; });
  } catch (error) { finish(false); throw error; }
}
module.exports = { createReadDiagnostics, measureRtdbGet };
