# 운영 소스 다운로드 안내

이 소스 묶음은 2026-09-08 운영 Hosting과 Cloud Functions의 배포 소스를 기준으로 구성합니다. 로컬 개발 중인 사진 검출 UI/모델 파일은 운영 Hosting에 포함되지 않았으므로 이 묶음에도 포함하지 않습니다.

## 구성

- public/: 운영 프런트엔드의 편집 가능한 HTML/CSS/JavaScript 및 고지. 게임 일러스트 원본, 사용자 데이터, 제작 출처 미확인 앱 아이콘 바이너리는 제외합니다.
- functions-sources/*.zip: 함수의 실제 배포 소스. FUNCTIONS.json에서 함수별 entryPoint, runtime, 대응 ZIP 및 SHA-256을 확인할 수 있습니다. 소스 버전이 다른 함수는 다른 ZIP을 사용합니다.
- FUNCTIONS.json: 원본 배포 ZIP의 해시와 공개용 ZIP 해시를 구분합니다. 제외된 비밀파일 목록만 기록하며 값은 포함하지 않습니다.
- scripts/: 공개용 소스 준비 및 이미지 데이터 처리 도구. 도구의 실행과 데이터 이용 권한은 구분됩니다.
- firebase.json, firestore.rules, firestore.indexes.json, storage.rules: 실행·배포 설정 자료. 운영 프로젝트를 복제해서 배포하지 말고 자신의 프로젝트와 권한으로 설정하십시오.
- LICENSE, THIRD_PARTY_NOTICES.md, ASSET_RIGHTS.md: 자체 코드 및 제3자 권리 고지.

## 실행·수정·배포

1. Node.js 24, npm 및 Firebase CLI를 준비합니다. Firebase 프로젝트·필요한 Google/Discord 연동은 자신의 계정으로 설정합니다.
2. FUNCTIONS.json에서 원하는 함수의 ZIP을 골라 빈 functions 디렉터리에 풉니다. 해당 디렉터리에서 npm ci를 실행합니다. 원본 package-lock.json을 유지하여 의존성을 설치합니다.
3. 함수마다 소스 버전이 다를 수 있으므로 모든 함수를 한 ZIP으로 덮어 배포하지 마십시오. 같은 ZIP을 공유하는 함수만 선택적으로 배포하거나, 별도 검토를 거쳐 소스를 통합합니다.
4. Firebase Secret Manager에는 코드가 defineSecret으로 선언한 이름에 자신의 값을 설정합니다. GOOGLE_APPLICATION_CREDENTIALS/ADC 또는 적절한 실행 서비스 계정 권한을 사용합니다. 제외된 serviceAccountKey.json은 운영자의 비밀값이며 배포 소스로 제공되지 않습니다. 로컬 테스트에서 필요하면 본인의 자격증명을 사용하되 공개하거나 소스에 넣지 마십시오.
5. Firebase CLI로 자신의 프로젝트를 선택하고 에뮬레이터를 실행합니다. 웹앱의 Firebase 프로젝트 ID, API 주소, OAuth 클라이언트/리디렉션 주소, App Check 설정은 자신의 배포에 맞게 변경합니다. 원본에는 일부 서비스 식별자가 고정되어 있습니다.
6. 이미지 기능은 본인이 사용할 수 있는 이미지와 CID/CIID 인덱스가 필요합니다. private/illustrations 및 private/illustrations-index.json의 구조와 생성 도구는 scripts와 서버 코드에 있습니다. 원본 이미지 데이터는 포함하지 않습니다.
7. 실제 배포는 Firebase CLI에서 필요한 Hosting/함수/규칙만 선택합니다. 이미지 API는 /api/illustrations/** Hosting rewrite와 getIllustration 함수를 함께 사용합니다.

인증 비밀값·개인정보·운영 DB는 해당 소스 묶음에 포함하지 않습니다. 외부 CDN 및 API는 해당 공급자의 조건을 따릅니다. 라이브러리 소스는 각 lockfile과 제3자 고지에 기재된 배포처에서 구할 수 있습니다. CI/CD 운영 이력이나 운영자의 실제 비밀값이 있어야만 코드를 편집할 수 있는 구조는 아닙니다.

## 적용 라이선스

운영자가 보유하거나 허락할 수 있는 자체 코드와 문서는 AGPL-3.0-only입니다. 각 ZIP의 원본 소스 표현은 보존했으며, ZIP 밖의 LICENSE 및 이 안내가 자체 코드의 이용허락을 명시합니다. 제3자 자료에는 원래 조건이 적용됩니다. 제공된 소스에 대한 보증은 라이선스가 정한 범위로 제한됩니다.
