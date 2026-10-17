> 이 파일은 분리 저장소 준비 당시의 보존용 템플릿이다. 현재 개발 원본은 기존 YGO_Synapse 단일 저장소이며 아래 게시·별도 프로젝트 설명은 현재 작업 지시가 아니다. 준비본을 재생성하거나 보존 중인 두 새 저장소에 덮어쓰지 않는다.

# YGO_Synapse_Service

유희왕 카드 검색·컬렉션·덱 관리용 비공식 팬 웹앱입니다. KONAMI의 공식 서비스이거나 제휴 서비스가 아닙니다.

## 라이선스

Copyright (C) 2026 참혈 (Chamhyul).

운영자가 보유하거나 이용허락할 수 있는 저작권 범위의 자체 소스코드와 문서는 **AGPL-3.0-only**로 제공합니다. 전문은 [LICENSE](LICENSE)를 참조하십시오. 상업적 이용·수정·재배포도 해당 라이선스 조건에 따라 가능합니다. 저작권을 포기하거나 퍼블릭 도메인으로 제공하는 것이 아닙니다. 법이 허용하는 범위에서 보증은 제공하지 않습니다.

제3자 코드·모델·폰트·아이콘은 원래 라이선스가 적용됩니다. 카드 이미지·게임 텍스트·상표·사용자 데이터에는 이 프로젝트의 AGPL 허락을 적용하지 않습니다. 폴더 위치나 package.json의 license 필드가 이러한 예외를 덮어쓰지 않습니다.

- [제3자 소프트웨어 및 모델 고지](legal/THIRD_PARTY_NOTICES.md)
- [이미지·데이터·브랜드 권리 및 출처](legal/ASSET_RIGHTS.md)
- [서비스 내 라이선스 화면](public/licenses.html)
- [npm 전체 의존성 목록](public/legal/npm-inventory.json) / [수집된 원문 고지](public/legal/npm-license-texts.txt)

## 소스와 실행

기존 프로젝트 원본: https://github.com/Chamhyul/YGO_Synapse . 기존 저장소와 이력은 그대로 보존합니다. 이 저장소는 검증된 현재 파일로 새 이력을 시작하는 비공개 저장소이며, 카드 코드 원본과 읽기 서버는 별도 비공개 저장소 `YGO_Synapse_Cards`에서 관리합니다. 기존 Git 이력을 가져오거나 기존 저장소의 원격 주소를 변경하지 않습니다.

게시 설정은 [repository-publication.json](repository-publication.json)에 기록합니다. 이 파일은 게시 대상의 이름·비공개·이력 방침을 명시하며 GitHub 자원을 생성하거나 공개 범위를 설정하지 않습니다. 저장소 생성·최초 커밋·푸시는 별도 승인 후 수행합니다.

배포 소스 다운로드: https://ygo-synapse.web.app/legal/ygo-source-20260908.tar.gz — 함수별 실제 소스 대응표와 인증 비밀값 제외 기록을 포함합니다. [구성 및 실행 안내](legal/DEPLOYED_SOURCE.md)를 참조하십시오. 개발 작업 트리와 운영 배포 소스는 다를 수 있습니다.

Docker Desktop에서 실행·검사합니다. 이 폴더만 빌드 컨텍스트로 사용하며 상위/형제 소스나 호스트 의존성을 연결하지 않습니다.

```sh
docker build -t ygo-main-service:local .
docker run --rm --network none ygo-main-service:local test
```

독립 HTTP 서버는 `.env.example`의 프로젝트·버킷·카드 서비스 주소를 실제 환경에 맞게 설정하고 `docker compose --profile read-api up read-api`로 실행합니다. `.env`는 Compose 파일과 같은 작업 디렉터리에 두며 Git에 포함하지 않습니다. 포트는5090, 경로는 기존 HTTPS 함수 이름입니다. 기본 Compose는 자격증명을 제공하지 않습니다. 실제 클라우드 접속은 별도 실행 계정과 권한이 필요합니다. `healthz` 성공은 DB·IAM 접근 성공을 뜻하지 않습니다.

기존 Firebase dev 구성은5101~5105/9250을 사용합니다. 이 구성은 기존 운영 인증/조회 접속 분기를 유지하므로 격리된 합성 검사 용도로 사용하지 않습니다. 격리된 연결 검사는 [통합 검사 안내](integration/read/README.md)를 따릅니다.

## 저장소 경계

운영 전환 목표는 카드 데이터와 사용자 정보 등 서비스 데이터를 서로 다른 Firebase 프로젝트의 DB에서 관리하는 것입니다. 새 카드 프로젝트가 읽기·검색·수집·저장·갱신·팩/색인·일러스트·사진 검색·관리·예약/큐 작업과 관련 카드 파일을 담당하고, 서비스 프로젝트는 사용자 인증·계정·멤버십·인벤토리 등을 담당합니다. 첫 운영 전환 전에 전체 기능·API 호환·데이터 정합성·실제 프로젝트 간 인증/권한·복구 절차를 검증해야 합니다. 카드 읽기만 먼저 전환하는 방식은 완료 기준에 해당하지 않습니다. 아래는 현재 구현이며, 전체 전환이 구현되거나 운영에 적용된 상태는 아닙니다.

사용자 인증·인벤토리·외부 카드 API 키/CORS/쿼터는 이 저장소가 담당합니다. 순수 카드 조회는 `CARD_SERVICE_URL` 설정 시 카드 읽기 서버로 연결합니다. 설정이 없으면 기존 동작을 유지합니다. 수집·저장·관리·Tasks는 아직 기존 호환 패키지를 사용합니다.

`functions/services/card-service/`는 카드 저장소에서 생성한 패키지입니다. `release.json`의 버전/원본 해시와 `content-sha256.json`을 함께 보존하고 직접 수정하지 않습니다. 소비 버전은 저장소 루트의 `card-service.lock.json`으로 고정합니다. 새 버전을 받을 때 카드 저장소의 `tools/export-compat.cjs`를 사용하고 변경을 검토한 뒤 `release.json`을 `card-service.lock.json`에 복사해 승인한 버전을 고정합니다. 전체 검사와 양쪽 이미지 연결 검사를 수행합니다. 다른 저장소의 현재 브랜치를 자동으로 내려받지 않습니다.

활성 GitHub Actions는 Docker 빌드·검사뿐입니다. 기존 배포·PR 미리보기·일러스트 동기화 정의는 `operations/workflows/*.disabled`에 참고본으로 보관합니다. 운영 대상 설정과 별도 승인 없이 활성화하지 않습니다. Docker 이미지 이름과 실행 포트는 GitHub 저장소 이름과 별도로 유지합니다.

이 독립 이미지의 의존성은 [설치 목록](legal/dependencies.json)과 [수집 원문](legal/dependency-license-texts.txt)에 기록합니다. 기존 웹 고지는 별도로 유지합니다. lockfile 변경 시 설치된 Docker 이미지에서 `node scripts/dependency-notices.cjs /out`으로 출력 폴더에 다시 생성하고 버전·미설치/원문 미수집 항목을 확인합니다.


개인 키·토큰·사용자 데이터는 소스 제공 대상에 포함하지 마십시오. 카드 이미지 데이터와 외부 저장소 접근 권한은 이 저장소의 라이선스로 제공되지 않습니다. 자체 배포자는 자신의 허가된 데이터와 설정을 준비해야 합니다. 모델과 OpenCV의 출처·재현 자료에 관한 확인 범위는 [제3자 고지](legal/THIRD_PARTY_NOTICES.md)를 참고하십시오.

AGPL의 해당 소스(Corresponding Source) 제공 의무가 적용되는 배포에서는 실행 버전과 일치하는 소스, 변경 사항, 필요한 빌드·설치 스크립트를 제공해야 합니다. 수정된 프로그램을 네트워크로 이용하게 하는 경우 AGPL 제13조의 소스 제공 안내도 확인하십시오. 저장소 홈페이지 링크만으로 배포 버전의 소스가 제공되었다고 단정할 수 없습니다.
