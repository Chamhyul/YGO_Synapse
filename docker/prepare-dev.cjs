'use strict';
const fs = require('node:fs');
const { configstore } = require('/usr/local/lib/node_modules/firebase-tools/lib/configstore');
const projectId = 'ygo-synapse';

async function main() {
  // 운영에서 누구나 읽을 수 있는 웹 설정만 사용한다. ADC·서비스 계정 키는 필요 없다.
  const response = await fetch(`https://${projectId}.web.app/__/firebase/init.json`, {
    redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw Error(`공개 Firebase 설정 조회 실패: HTTP ${response.status}`);
  const source = await response.json();
  if (source.projectId !== projectId || typeof source.apiKey !== 'string' || !source.apiKey
      || source.authDomain !== `${projectId}.firebaseapp.com` || typeof source.appId !== 'string') {
    throw Error('운영 Firebase 웹 설정을 확인할 수 없습니다.');
  }
  const allowed = ['apiKey', 'authDomain', 'databaseURL', 'projectId', 'storageBucket', 'messagingSenderId', 'appId', 'measurementId'];
  const webConfig = Object.fromEntries(allowed.filter(key => typeof source[key] === 'string').map(key => [key, source[key]]));
  configstore.set('webconfig', { [projectId]: webConfig });

  const config = JSON.parse(fs.readFileSync('/app/firebase.json', 'utf8'));
  for (const name of ['functions', 'hosting', 'firestore', 'storage', 'ui']) {
    config.emulators[name].host = '0.0.0.0';
  }
  // 브라우저의 Firestore 화면이 사용하는 WebSocket도 명시적으로 제공한다.
  config.emulators.firestore.websocketPort = 9150;
  fs.writeFileSync('/app/firebase.docker.json', JSON.stringify(config, null, 2));
  console.log('공개 웹 설정 확인 완료. 로그인·공지 등 기존 운영 연결을 유지합니다.');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
