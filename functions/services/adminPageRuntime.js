'use strict';

const { resolveUserStorageConfig } = require('../config/userStorage');
const { createConfiguredAdminPageHandler, validateAdminSessionEnvironment } = require('./adminSessionRepository');
const { createAdminBackendHandler, emulatorConfigured } = require('./adminTransport');
const { measure, withAdminRequestTiming } = require('./adminRequestTiming');

function unavailable(res) {
  res.set('Cache-Control', 'private, no-store');
  return res.status(503).json({ success: false });
}
function invalid() {
  return Object.assign(new Error('관리자 실행 환경 설정이 올바르지 않습니다.'), {
    code: 'USER_STORAGE_CONFIG_INVALID',
  });
}

/** 일반 export와 격리 HTTP 검사가 같은 관리자 경로 선택을 사용한다. */
function createAdminRouteHandlers({ env = process.env, productionDependencies, emulatorDependencies,
  createPageHandler = createConfiguredAdminPageHandler, proxy, writerBinding, authenticationProxy } = {}) {
  let initialSelection, directHandler;

  function select() {
    let writerConfig;
    if (env.USER_PROFILE_WRITER_MODE || env.USER_STORAGE_MODE === 'production') {
      writerConfig = require('../config/userProfileWriter').resolveProfileWriterConfig(env);
      if (writerConfig.mode === 'production') writerBinding = require('./userWriterSelection').selectProductionWriter({ env, writerBinding });
      if (!writerBinding?.adminSessions || writerBinding.transition?.runId !== writerConfig.runId
          || writerConfig.mode === 'emulator' && !emulatorDependencies) throw invalid();
    }
    const value = env.USER_STORAGE_BACKEND;
    const backend = value === undefined || value === '' || value === 'storage' ? 'storage' : value;
    if (!['storage', 'rtdb'].includes(backend)) throw invalid();
    // 실제 공유 저장소를 사용할 때 주입 설정과 process.env가 다른 DB를 가리키지 못하게 한다.
    if (!writerConfig && createPageHandler === createConfiguredAdminPageHandler) validateAdminSessionEnvironment(env);
    const config = writerConfig || (backend === 'rtdb' ? resolveUserStorageConfig(env) : undefined);
    const mode = config ? config.mode : emulatorConfigured(env) ? 'proxy' : 'production';
    // 한 번 선택한 실행 환경을 캐시된 인증/데이터 의존성으로 바꿔 쓰지 않는다.
    const selection = JSON.stringify([backend, mode, config?.projectId, config?.databaseURL,
      config?.namespace, config?.instanceId, config?.location, config?.targetId, config?.emulatorHost, config?.runId]);
    if (initialSelection !== undefined && initialSelection !== selection) throw invalid();
    if (mode === 'emulator' && (!emulatorDependencies || typeof emulatorDependencies !== 'object')) throw invalid();
    if (mode === 'production' && emulatorConfigured(env)) throw invalid();
    initialSelection = selection;
    return { backend, mode };
  }

  async function handlerFor(selected) {
    if (directHandler) return directHandler;
    directHandler = measure('admin.runtime.dependencies', () => Promise.resolve().then(async () => {
      const dependencies = selected.mode === 'emulator' ? emulatorDependencies
        : typeof productionDependencies === 'function' ? await productionDependencies(selected) : undefined;
      if (!dependencies || typeof dependencies !== 'object') throw invalid();
      select();
      return createPageHandler(dependencies, { env, writerBinding });
    }));
    return directHandler;
  }

  function dispatch(kind) {
    return withAdminRequestTiming(kind === 'pages' ? 'adminPages' : 'adminBackend', async (req, res) => {
      try {
        const selected = measure('admin.runtime.select', () => select());
        if (kind === 'pages' && selected.mode === 'production' && req.method === 'POST'
            && req.body?.authenticationResultStream === true
            && new URL(req.originalUrl || req.url, 'https://admin.invalid').pathname === '/admin/session') {
          authenticationProxy ||= require('./adminTransport').createAdminProxy({ authenticationResultOnly: true });
          return await authenticationProxy(req, res);
        }
        if (kind === 'pages' && selected.mode === 'proxy') {
          if (typeof proxy !== 'function') throw invalid();
          return await proxy(req, res);
        }
        if (kind === 'backend') {
          // 합성 의존성을 명시적으로 주입한 test/demo RTDB 검사에만 경로 재작성을 사용한다.
          // 일반 export에는 이 주입이 없으며 기존 backend의 에뮬레이터 차단도 그대로다.
          const transportEnv = selected.mode === 'emulator' ? {} : env;
          return await createAdminBackendHandler({ env: transportEnv,
            handler: async (request, response) => (await handlerFor(selected))(request, response) })(req, res);
        }
        return await (await handlerFor(selected))(req, res);
      } catch (_) {
        // 설정·의존성 실패를 기존 저장소나 운영 proxy로 대체하거나 원문을 노출하지 않는다.
        return unavailable(res);
      }
    });
  }
  return { adminPages: dispatch('pages'), adminBackend: dispatch('backend') };
}

module.exports = { createAdminRouteHandlers };
