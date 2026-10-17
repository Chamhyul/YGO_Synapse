'use strict';

const { PRODUCTION_TARGETS } = require('./userStorageTargets');

// 시험 연결은 운영 연결 선택기와 별도로 유지한다. 기본 Firebase 앱은 변경하지 않는다.
class UserStorageConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserStorageConfigError';
    this.code = 'USER_STORAGE_CONFIG_INVALID';
  }
}

function resolveRtdbConfig(env = process.env) {
  const fail = message => { throw new UserStorageConfigError(message); };
  if (env.USER_STORAGE_MODE && env.USER_STORAGE_MODE !== 'emulator') {
    fail('시험 전용 연결에서는 다른 사용자 저장소 연결 방식을 사용할 수 없습니다.');
  }
  if (env.USER_STORAGE_BACKEND !== 'rtdb' || env.NODE_ENV !== 'test') {
    fail('RTDB 준비 연결은 명시적인 test/rtdb 설정에서만 사용할 수 있습니다.');
  }
  const projectId = env.GCLOUD_PROJECT;
  if (typeof projectId !== 'string' || !/^demo-[a-z][a-z0-9-]{0,23}[a-z0-9]$/.test(projectId)
      || (env.GOOGLE_CLOUD_PROJECT && env.GOOGLE_CLOUD_PROJECT !== projectId)) {
    fail('같은 demo 프로젝트를 명시해야 합니다. 운영 프로젝트는 연결하지 않습니다.');
  }
  const host = env.FIREBASE_DATABASE_EMULATOR_HOST;
  if (typeof host !== 'string' || !/^(localhost|127\.0\.0\.1|\[::1\]|emulators):[1-9][0-9]{0,4}$/.test(host)) {
    fail('허용된 로컬 RTDB 에뮬레이터 주소가 필요합니다.');
  }
  const port = Number(host.slice(host.lastIndexOf(':') + 1));
  if (port > 65535) fail('RTDB 에뮬레이터 포트가 올바르지 않습니다.');
  const namespace = `${projectId}-default-rtdb`;
  const value = env.USER_DATABASE_URL;
  if (typeof value !== 'string' || /[\s\\]/.test(value)) fail('RTDB URL을 명시해야 합니다.');
  let url;
  try { url = new URL(value); } catch (_) { fail('RTDB URL 형식이 올바르지 않습니다.'); }
  if (url.protocol !== 'http:' || url.host !== host || url.username || url.password
      || url.pathname !== '/' || url.hash || [...url.searchParams].length !== 1
      || url.searchParams.get('ns') !== namespace) {
    fail('RTDB URL·에뮬레이터 주소·demo 프로젝트 namespace가 일치해야 합니다.');
  }
  return Object.freeze({ mode: 'emulator', projectId, emulatorHost: host, namespace, databaseURL: url.href });
}

function resolveProductionRtdbConfig(env = process.env, targets = PRODUCTION_TARGETS) {
  const fail = message => { throw new UserStorageConfigError(message); };
  if (env.USER_STORAGE_MODE !== 'production' || env.USER_STORAGE_BACKEND !== 'rtdb' || env.NODE_ENV !== 'production') {
    fail('운영 RTDB는 명시적인 production/rtdb 설정이 필요합니다.');
  }
  if (Object.entries(env).some(([key, value]) => key.includes('EMULATOR') && value)
      || ['GOOGLE_APPLICATION_CREDENTIALS', 'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE',
        'GCE_METADATA_HOST', 'GCE_METADATA_IP', 'METADATA_SERVER_DETECTION'].some(key => env[key])) {
    fail('운영 RTDB에서는 에뮬레이터·로컬 자격증명·인증 서버 재지정 설정을 사용할 수 없습니다.');
  }
  const service = typeof env.K_SERVICE === 'string' && !!env.K_SERVICE.trim() && typeof env.K_REVISION === 'string' && !!env.K_REVISION.trim();
  const job = typeof env.CLOUD_RUN_JOB === 'string' && !!env.CLOUD_RUN_JOB.trim() && typeof env.CLOUD_RUN_EXECUTION === 'string' && !!env.CLOUD_RUN_EXECUTION.trim();
  if (!service && !job || (env.CLOUD_RUN_JOB || env.CLOUD_RUN_EXECUTION) && !job) {
    fail('운영 RTDB 연결은 관리형 서버 런타임에서만 사용할 수 있습니다.');
  }
  const selected = Array.isArray(targets) ? targets.filter(target => target?.id === env.USER_STORAGE_TARGET) : [];
  if (typeof env.USER_STORAGE_TARGET !== 'string' || !env.USER_STORAGE_TARGET || selected.length !== 1) {
    fail('코드에 등록된 단일 운영 RTDB 대상이 필요합니다.');
  }
  const target = selected[0];
  if (typeof target.projectId !== 'string' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(target.projectId)
      || target.projectId.startsWith('demo-') || env.GCLOUD_PROJECT !== target.projectId
      || (env.GOOGLE_CLOUD_PROJECT && env.GOOGLE_CLOUD_PROJECT !== target.projectId)) {
    fail('운영 RTDB의 등록 프로젝트와 실행 프로젝트가 일치해야 합니다.');
  }
  if (typeof target.instanceId !== 'string' || !/^[a-z][a-z0-9-]{0,62}$/.test(target.instanceId)
      || typeof target.location !== 'string' || !/^[a-z]+-[a-z]+[0-9]$/.test(target.location)) {
    fail('운영 RTDB의 인스턴스와 위치를 코드에 명시해야 합니다.');
  }
  function parseURL(value) {
    if (typeof value !== 'string' || /[\s\\]/.test(value)) fail('정확한 운영 RTDB URL이 필요합니다.');
    let url;
    try { url = new URL(value); } catch (_) { fail('운영 RTDB URL 형식이 올바르지 않습니다.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) {
      fail('운영 RTDB URL은 경로·인증 정보가 없는 HTTPS 주소여야 합니다.');
    }
    return url;
  }
  const registeredURL = parseURL(target.databaseURL), configuredURL = parseURL(env.USER_DATABASE_URL);
  const expectedHost = target.location === 'us-central1'
    ? `${target.instanceId}.firebaseio.com` : `${target.instanceId}.${target.location}.firebasedatabase.app`;
  if (registeredURL.hostname !== expectedHost || configuredURL.href !== registeredURL.href) {
    fail('운영 RTDB URL·인스턴스·위치가 등록한 대상과 일치해야 합니다.');
  }
  if (env.FIREBASE_CONFIG) {
    let firebaseConfig;
    try { firebaseConfig = JSON.parse(env.FIREBASE_CONFIG); } catch (_) { fail('운영 Firebase 설정은 JSON 객체여야 합니다.'); }
    if (!firebaseConfig || typeof firebaseConfig !== 'object' || Array.isArray(firebaseConfig)
        || (firebaseConfig.projectId && firebaseConfig.projectId !== target.projectId)) {
      fail('기본 Firebase 설정과 운영 RTDB 프로젝트가 일치해야 합니다.');
    }
  }
  // URL의 이름으로 실제 소속을 증명하지 않는다. 소속은 사전 확인한 코드 등록값을 신뢰한다.
  return Object.freeze({ mode: 'production', targetId: target.id, projectId: target.projectId,
    instanceId: target.instanceId, location: target.location, databaseURL: configuredURL.href });
}

function resolveUserStorageConfig(env = process.env) {
  if (env.USER_STORAGE_MODE === undefined || env.USER_STORAGE_MODE === '' || env.USER_STORAGE_MODE === 'emulator') {
    return resolveRtdbConfig(env);
  }
  if (env.USER_STORAGE_MODE === 'production') return resolveProductionRtdbConfig(env);
  throw new UserStorageConfigError('지원하지 않는 사용자 저장소 연결 방식입니다.');
}

function sameConnectionConfig(left, right) {
  return ['mode', 'targetId', 'projectId', 'databaseURL', 'instanceId', 'location', 'emulatorHost', 'namespace']
    .every(key => left[key] === right[key]);
}

function createManagedServerCredential(config) {
  // Compute는 런타임 서비스 계정의 metadata 인증만 사용한다. 파일/CLI 로그인 ADC 탐색을 하지 않는다.
  const { Compute } = require('google-auth-library');
  const context = () => JSON.stringify([process.env.USER_PROFILE_WRITER_MODE, process.env.USER_PROFILE_WRITER_RUN_ID, process.env.STORAGE_BUCKET]);
  const initialContext = context();
  const check = () => {
    if (context() !== initialContext || !sameConnectionConfig(config, resolveUserStorageConfig())) {
      throw new UserStorageConfigError('실행 중인 사용자 저장소의 연결 설정을 바꿀 수 없습니다.');
    }
  };
  const client = new Compute({ scopes: [
    'https://www.googleapis.com/auth/firebase.database', 'https://www.googleapis.com/auth/userinfo.email',
    ...(process.env.USER_PROFILE_WRITER_MODE === 'production' ? ['https://www.googleapis.com/auth/cloud-platform'] : []),
  ] });
  // Firestore/Storage도 같은 Compute를 사용한다. 캐시된 토큰의 요청도 설정을 다시 확인한다.
  if (typeof client.getRequestHeaders === 'function') {
    const headers = client.getRequestHeaders.bind(client);
    client.getRequestHeaders = async (...args) => {
      check();
      const value = await headers(...args);
      // auth v10의 Headers를 auth v9와 gRPC도 읽는 header map으로 전달한다.
      return typeof value?.entries === 'function' ? Object.fromEntries(value.entries()) : value;
    };
  }
  return {
    cloudAuthClient: client,
    async getAccessToken() {
      check();
      await client.getAccessToken();
      const { access_token: accessToken, expiry_date: expiresAt } = client.credentials;
      const expiresIn = Math.floor((expiresAt - Date.now()) / 1000);
      if (typeof accessToken !== 'string' || !accessToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
        throw new UserStorageConfigError('관리형 서버의 RTDB 인증 정보를 확인할 수 없습니다.');
      }
      return { access_token: accessToken, expires_in: expiresIn };
    },
  };
}

function openConnection(config) {
  // 설정 검증이 끝나기 전 SDK 앱/자격증명/소켓을 만들지 않는다.
  const { initializeApp, deleteApp } = require('firebase-admin/app');
  const { getDatabase } = require('firebase-admin/database');
  const { randomUUID } = require('node:crypto');
  const credential = config.mode === 'production' ? createManagedServerCredential(config)
    : { getAccessToken: async () => ({ access_token: 'owner', expires_in: 3600 }) };
  const app = initializeApp({
    projectId: config.projectId,
    databaseURL: config.databaseURL,
    credential,
  }, `user-storage-${config.mode === 'emulator' ? 'test' : 'production'}-${randomUUID()}`);
  let database;
  try { database = getDatabase(app); }
  catch (error) { Promise.resolve(deleteApp(app)).catch(() => {}); throw error; }
  let closing;
  function close() {
    if (!closing) {
      database.goOffline();
      closing = deleteApp(app);
    }
    return closing;
  }
  return { config, database, app, authClient: credential.cloudAuthClient, close };
}

function createUserStorageConnection() { return openConnection(resolveRtdbConfig()); }
function createConfiguredUserStorageConnection() { return openConnection(resolveUserStorageConfig()); }

module.exports = { resolveRtdbConfig, resolveProductionRtdbConfig, resolveUserStorageConfig,
  createUserStorageConnection, createConfiguredUserStorageConnection, sameConnectionConfig, UserStorageConfigError };
