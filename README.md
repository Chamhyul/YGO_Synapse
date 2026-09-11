# YGO Synapse

유희왕 카드 검색·컬렉션·덱 관리용 비공식 팬 웹앱입니다. KONAMI의 공식 서비스이거나 제휴 서비스가 아닙니다.

## 라이선스

Copyright (C) 2026 참혈 (Chamhyul).

운영자가 보유하거나 이용허락할 수 있는 저작권 범위의 자체 소스코드와 문서는 **AGPL-3.0-only**로 제공합니다. 전문은 [LICENSE](LICENSE)를 참조하십시오. 상업적 이용·수정·재배포도 해당 라이선스 조건에 따라 가능합니다. 저작권을 포기하거나 퍼블릭 도메인으로 제공하는 것이 아닙니다. 법이 허용하는 범위에서 보증은 제공하지 않습니다.

제3자 코드·모델·폰트·아이콘은 원래 라이선스가 적용됩니다. 카드 이미지·게임 텍스트·상표·사용자 데이터에는 이 프로젝트의 AGPL 허락을 적용하지 않습니다. 폴더 위치나 package.json의 license 필드가 이러한 예외를 덮어쓰지 않습니다.

- [제3자 소프트웨어 및 모델 고지](THIRD_PARTY_NOTICES.md)
- [이미지·데이터·브랜드 권리 및 출처](ASSET_RIGHTS.md)
- [미확인 사항과 배포 전 점검](LICENSE_REVIEW.md)
- [서비스 내 라이선스 화면](public/licenses.html)
- [npm 전체 의존성 목록](public/legal/npm-inventory.json) / [수집된 원문 고지](public/legal/npm-license-texts.txt)

## 소스와 실행

소스 저장소: https://github.com/Chamhyul/YGO_Synapse

배포 소스 다운로드: https://ygo-synapse.web.app/legal/ygo-source-20260908.tar.gz — 함수별 실제 소스 대응표와 인증 비밀값 제외 기록을 포함합니다. [구성 및 실행 안내](DEPLOYED_SOURCE.md)를 참조하십시오. 개발 작업 트리와 운영 배포 소스는 다를 수 있습니다.

Node.js 24와 Firebase CLI가 필요합니다. 저장소 루트와 functions에서 각각 `npm ci`를 실행합니다. Firebase 프로젝트 및 필요한 인증 정보를 자신의 환경에 설정한 뒤 루트에서 `npm run dev`로 에뮬레이터를 실행합니다. Hosting의 설정 포트는 **5005**입니다. 실제 외부 서비스/API는 별도 계정·설정·이용 조건이 필요하며, 에뮬레이터 실행이 외부 서비스 연결을 자동으로 격리하지는 않습니다.

프런트엔드는 public, 서버는 functions, 데이터 처리·검증 도구는 scripts에 있습니다. `npm run test:illustrations`와 functions의 `npm test`로 관련 테스트를 실행할 수 있습니다. `node scripts/build_license_inventory.js`는 두 lockfile과 현재 설치된 패키지의 고지를 읽어 공개용 목록을 재생성합니다. 누락된 플랫폼별 패키지 고지는 설치 환경에 따라 달라집니다.

개인 키·토큰·사용자 데이터는 소스 제공 대상에 포함하지 마십시오. 카드 이미지 데이터와 외부 저장소 접근 권한은 이 저장소의 라이선스로 제공되지 않습니다. 자체 배포자는 자신의 허가된 데이터와 설정을 준비해야 합니다. 모델과 OpenCV 재현에 필요한 미확인 사항은 LICENSE_REVIEW.md에 기록되어 있습니다.

AGPL의 해당 소스(Corresponding Source) 제공 의무가 적용되는 배포에서는 실행 버전과 일치하는 소스, 변경 사항, 필요한 빌드·설치 스크립트를 제공해야 합니다. 수정된 프로그램을 네트워크로 이용하게 하는 경우 AGPL 제13조의 소스 제공 안내도 확인하십시오. 저장소 홈페이지 링크만으로 배포 버전의 소스가 제공되었다고 단정할 수 없습니다.
