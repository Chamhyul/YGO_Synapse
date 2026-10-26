'use strict';
const { performance } = require('node:perf_hooks');
const processUsage = require('node:process');
const { captureMembershipStorageMetrics } = require('./inventoryRequestTiming');
const inactive = Object.freeze({ input() {}, committed() {}, finish() {} });

// process.cpuUsage는 동시 요청/SDK 작업도 포함하는 프로세스 단위 값이다.
// JSON은 byte 수를 얻는 동안만 사용하고 이 객체나 recorder에 보관하지 않는다.
function beginMembershipStorageMetrics() {
  const record = captureMembershipStorageMetrics();
  if (!record) return inactive;
  let attempts = 0, errors = 0, first = true, closed = false, startedCpu;
  const safe = action => { try { return action(); } catch (_) { errors++; } };
  safe(() => { startedCpu = processUsage.cpuUsage(); });
  function snapshot(raw, prefix) {
    if (!record.isActive()) return;
    const started = performance.now(); let cpu;
    safe(() => { cpu = processUsage.cpuUsage(); });
    safe(() => {
      const json = JSON.stringify(raw ?? null);
      const values = {
        [prefix + 'ParentJsonBytes']: Buffer.byteLength(json, 'utf8'),
        [prefix + 'MembershipReceiptCount']: Object.keys(raw?.membershipWriterReceipts ?? {}).length,
        [prefix + 'ProfileReceiptCount']: Object.keys(raw?.profileWriterReceipts ?? {}).length,
      };
      record(values);
    });
    safe(() => {
      const used = cpu && processUsage.cpuUsage(cpu);
      record({ [prefix + 'MetricsMs']: performance.now() - started,
        ...(used ? { [prefix + 'MetricsCpuMs']: (used.user + used.system) / 1000 } : {}), metricsErrors: errors });
    });
  }
  return {
    input(raw) {
      if (closed) return;
      attempts++;
      if (!first) return;
      first = false; snapshot(raw, 'input');
    },
    committed(raw) { snapshot(raw, 'committed'); },
    finish() {
      if (closed) return;
      closed = true;
      safe(() => {
        const cpu = startedCpu && processUsage.cpuUsage(startedCpu);
        record({ callbackCount: attempts, ...(cpu ? { processCpuUserMs: cpu.user / 1000, processCpuSystemMs: cpu.system / 1000 } : {}), metricsErrors: errors });
      });
    },
  };
}
module.exports = { beginMembershipStorageMetrics };
