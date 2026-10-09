'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ADC_TYPES = new Set(['authorized_user', 'external_account', 'impersonated_service_account']);

function containsServiceAccountKey(value) {
  if (!value || typeof value !== 'object') return false;
  if (value.type === 'service_account' || Object.hasOwn(value, 'private_key')) return true;
  return Object.values(value).some(containsServiceAccountKey);
}

// ADC를 사용하더라도 환경변수·기본 설정에 장기 서비스 계정 키가 있으면 사용하지 않는다.
function assertKeylessApplicationCredentials({ env = process.env, homeDirectory = os.homedir(),
  platform = process.platform, readFile = fs.readFileSync, exists = fs.existsSync } = {}) {
  const explicit = env.GOOGLE_APPLICATION_CREDENTIALS || env.google_application_credentials;
  const configRoot = platform === 'win32' ? env.APPDATA : path.join(homeDirectory, '.config');
  const filename = explicit || (configRoot && path.join(configRoot, 'gcloud', 'application_default_credentials.json'));
  if (!filename || (!explicit && !exists(filename))) return;
  let credentials;
  try { credentials = JSON.parse(readFile(filename, 'utf8')); }
  catch (_) {
    throw new Error('기본 인증 설정을 읽지 못했습니다. 로컬 계정 인증 또는 단기 인증 설정을 확인해 주세요.');
  }
  if (!ADC_TYPES.has(credentials?.type) || containsServiceAccountKey(credentials)) {
    throw new Error('이 도구는 서비스 계정 비밀키를 사용하지 않습니다. 로컬 계정 인증 또는 단기 인증으로 전환해 주세요.');
  }
}

function initializeDataToolFirebaseApp(admin, options) {
  assertKeylessApplicationCredentials();
  if (!admin.apps.length) {
    admin.initializeApp({ ...options, credential: admin.credential.applicationDefault() });
  }
  const app = admin.app();
  if (app.options.credential?.privateKey || app.options.projectId !== options.projectId) {
    throw new Error('기존 앱의 인증 또는 프로젝트 설정이 이 도구의 실행 설정과 다릅니다.');
  }
  return app;
}

module.exports = { assertKeylessApplicationCredentials, initializeDataToolFirebaseApp };
