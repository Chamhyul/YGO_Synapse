'use strict';
async function main() {
  const response = await fetch('http://127.0.0.1:5007/emulators', { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw Error('에뮬레이터 상태 조회 실패');
  const emulators = await response.json();
  for (const name of ['hosting', 'functions', 'firestore', 'storage']) {
    if (!emulators[name]) throw Error(`${name} 준비되지 않음`);
  }
  const hosting = await fetch('http://127.0.0.1:5005/__/firebase/init.json', { signal: AbortSignal.timeout(3000) });
  if (!hosting.ok || (await hosting.json()).projectId !== 'ygo-synapse') throw Error('웹 초기화 설정 확인 실패');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
