# 라이선스 유지관리 메모

기준일: 2026-09-08. 서비스의 권리·출처 안내는 public/licenses.html 및 ASSET_RIGHTS.md에, 공개 범위 점검 결과는 PUBLICATION_AUDIT.md에 기록합니다. 이 메모는 Hosting에 동봉하지 않습니다.

## 이번에 확인한 사항

- OpenCV 내장 WASM에서 버전 4.13.0과 빌드 시각·옵션, zlib 1.3.1 / Protobuf 3.19.1 / FlatBuffers 25.9.23을 확인하고 해당 버전의 원문을 추가했습니다.
- DRAW2 ONNX의 로컬 SHA-256을 Hugging Face 고정 revision의 LFS 해시와 대조했습니다.
- CDN 메타데이터에서 Hangul-js 0.2.6, SheetJS CE 0.20.3을 확인했습니다. 사용 URL 자체는 여전히 버전 미고정입니다.
- Firebase JavaScript SDK 10.12.0의 공식 라이선스 원문을 추가했습니다.
- 앱 아이콘은 초기 커밋부터 포함되어 있으며, 제작자나 원본 작업 파일은 이력에서 확인되지 않았습니다.

## 유지관리 항목

1. 운영 함수 45개의 고정 generation 소스를 확보해 3개의 소스 ZIP으로 정리하고, 프런트엔드와 빌드·설치 안내를 포함한 운영 소스 아카이브를 준비했습니다. 서비스 계정 키가 포함된 2개 함수의 소스에서는 키 파일만 제외했으며, 원본/공개본 해시와 제외 파일은 FUNCTIONS.json에 기록했습니다. 커밋·푸시는 하지 않습니다. 공개 주소: /legal/ygo-source-20260908.tar.gz.
2. OpenCV의 원본 다운로드 URL과 런타임 수정에 대한 완전한 재현 기록은 추가 확보 대상입니다. 내장 버전 확인과 빌드 재현 가능성은 별개입니다.
3. DRAW2의 docs/export_models.py에서 YOLO 모델을 Hugging Face에서 받아 ONNX로 내보내는 코드를 확인했습니다. 학습 소스의 완전성은 별도 확인 대상입니다. DRAW2/OpenCV 파일은 현재 운영 Hosting에 배포되지 않았으므로 운영 소스 아카이브와 분리하고, 향후 사진 검출 배포 전에 검토합니다.
4. 의존성 변경 시 두 lockfile 기준으로 `node scripts/build_license_inventory.js`를 다시 실행합니다. legalFiles가 빈 항목, 불명확한 BSD 표기, 플랫폼별 optional dependency는 실제 배포 환경에서 확인합니다. 네이티브 바이너리는 해당 구성요소의 고지·소스 제공 조건을 따릅니다.
5. 미고정 CDN의 버전 변경과 라이선스 변경을 함께 확인합니다. 이 작업에서는 런타임 의존성 URL을 변경하지 않았습니다.

적용 라이선스: [AGPL-3.0-only 전문](LICENSE). 제3자 구성요소의 원래 조건은 THIRD_PARTY_NOTICES.md를 참조하십시오.

일러스트는 사용자의 결정에 따라 현재의 간결한 권리·출처 고지를 유지하며, 추가 허락 확인을 진행의 중단 조건으로 삼지 않습니다. 유사 사이트의 사용 사례를 이용허락 증빙으로 기록하지 않습니다.
