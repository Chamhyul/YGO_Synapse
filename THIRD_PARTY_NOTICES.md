# 제3자 소프트웨어 및 모델 고지

기준일: 2026-09-08. 제3자 구성요소는 각 원래 라이선스와 저작권 고지를 따릅니다.

## 직접 사용 및 브라우저 배포 구성요소

| 구성요소 | 확인된 버전/출처 | 라이선스 및 고지 |
| --- | --- | --- |
| ONNX Runtime Web | npm 1.21.0, public/vendor의 ort JS·WASM | MIT 및 포함 구성요소별 조건. [원문](public/legal/ONNX-Runtime-LICENSE.txt), [제3자 원문](public/legal/ONNX-Runtime-ThirdPartyNotices.txt), [소스](https://github.com/microsoft/onnxruntime/tree/v1.21.0) |
| DRAW2 카드 검출 모델 및 참고 코드 | HichTala/draw2, 아래 상세 참조 | AGPL-3.0. [프로젝트](https://github.com/HichTala/draw2), [모델](https://huggingface.co/HichTala/draw2), [전문](LICENSE) |
| OpenCV.js | 4.13.0, public/vendor/opencv.js의 내장 WASM 빌드 정보로 확인 | Apache-2.0, [원문](public/legal/OpenCV-LICENSE.txt), [소스](https://github.com/opencv/opencv/tree/4.13.0). 포함 라이브러리는 아래 참조 |
| Pretendard | CDN v1.3.9 | SIL OFL-1.1. Kil Hyung-jin 및 기반 폰트 권리자 고지는 [원문](public/legal/Pretendard-LICENSE.txt) 참조 |
| Materialize | CDN 1.0.0 | MIT, [원문](public/legal/Materialize-LICENSE.txt) |
| Material Icons | Google Fonts, 버전 미고정 | Apache-2.0, [원문](public/legal/Material-Icons-LICENSE.txt) |
| Font Awesome Free | CDN 7.2.0 | 폰트 OFL-1.1, 아이콘 CC-BY-4.0, 코드 MIT. Fonticons, Inc. 및 [원문 고지](public/legal/Font-Awesome-LICENSE.txt). 브랜드 상표는 별도 |
| Hangul-js | unpkg, 확인일 현재 0.2.6 (URL 미고정) | MIT, Jaemin Jo, [원문](public/legal/Hangul-js-LICENSE.txt), [버전 근거](https://unpkg.com/hangul-js/package.json) |
| SheetJS Community Edition | xlsx-latest CDN, 확인일 현재 0.20.3 (URL 미고정) | Apache-2.0, [원문](public/legal/SheetJS-LICENSE.txt), [버전 근거](https://cdn.sheetjs.com/xlsx-latest/package/package.json) |
| Firebase JavaScript SDK | compat 10.12.0 | Apache-2.0, [원문](public/legal/Firebase-SDK-LICENSE.txt), [소스](https://github.com/firebase/firebase-js-sdk/tree/firebase%4010.12.0) |

CDN 자료의 수집된 원문은 검토 시점의 고지입니다. 버전 미고정 URL의 미래 응답까지 확인했다는 의미가 아닙니다.

## OpenCV 빌드와 포함 라이브러리

내장 빌드 정보: OpenCV 4.13.0, 빌드 시각 2025-12-31T07:16:15Z, Emscripten, SINGLE_FILE=1, USE_PTHREADS=0. 빌드 정보에 표시된 구성요소의 원문을 함께 제공합니다.

- zlib 1.3.1: zlib 라이선스, [원문](public/legal/OpenCV-Zlib-LICENSE.txt).
- Protobuf 3.19.1: BSD-3-Clause 및 원문에 기재된 포함 코드 고지, [원문](public/legal/OpenCV-Protobuf-LICENSE.txt).
- FlatBuffers 25.9.23: Apache-2.0, [원문](public/legal/OpenCV-Flatbuffers-LICENSE.txt).
- 원문 출처: [OpenCV 4.13.0의 3rdparty](https://github.com/opencv/opencv/tree/4.13.0/3rdparty).
- 배포 JS SHA-256: `63366510248adf3a7eddf3e793dd825404efb7df3749f4d6f8557c7fa4ca8aa0`. 원본 다운로드 URL 및 로컬 런타임 수정의 완전한 빌드 재현 기록은 남아 있지 않습니다.

## DRAW2 출처와 변경

- 참고 소스 revision: `d650cea84b2388a56bb98e22443c8637cbf0eac4` (https://github.com/HichTala/draw2/tree/d650cea84b2388a56bb98e22443c8637cbf0eac4).
- 참고 파일: upstream `docs/scripts/pipeline.js`. 해당 전처리·OBB 결과 해석·NMS·변환 로직을 바탕으로 `public/photo-card-model-worker.js`와 `scripts/evaluate_draw2_detector.js`에서 워커 메시지, 프로젝트 입력/출력 및 평가 흐름에 맞게 수정했습니다. 로컬 변경 고지일: 2026-09-08. 원저작자 HichTala 및 upstream 기여자의 권리는 유지됩니다.
- 모델 고정 원본 URL: https://huggingface.co/HichTala/draw2/resolve/1030c147c4d0c1c48a3467581ec317087d233f9d/onnx/ygo_yolo.onnx
- 배포 파일: `public/vendor/ygo-card-detector.onnx` (39,016,336 bytes).
- SHA-256: `449e0d42cbf8429b170abf44d50cda29beeeb05dc80890102e12c06d6358cf97`.
- 공개된 ONNX 파일을 변경 없이 가져왔습니다. 공식 Hugging Face revision `1030c147c4d0c1c48a3467581ec317087d233f9d`의 LFS SHA-256과 위 로컬 해시가 일치합니다. [파일 메타데이터](https://huggingface.co/api/models/HichTala/draw2/tree/1030c147c4d0c1c48a3467581ec317087d233f9d/onnx). 학습용 카드 일러스트는 모델의 라이선스 대상과 구분합니다.
- Ultralytics 계열 사용 조건은 [공급자 안내](https://www.ultralytics.com/license)를 함께 확인해야 합니다. 별도 상업용 라이선스를 구매한 것으로 표시하지 않습니다.

## npm 및 네이티브 라이브러리

두 package-lock.json의 직접·전이 의존성을 [기계 판독 목록](public/legal/npm-inventory.json)에 기록했습니다. 버전, 라이선스 메타데이터, 설치 여부, 원문 파일 해시를 포함합니다. [원문 모음](public/legal/npm-license-texts.txt)은 로컬에 설치된 일치 버전에서 수집했습니다. metadata가 라이선스 원문을 대체하지 않으며, 원문 누락이 무제한 이용을 뜻하지 않습니다.

직접 의존성은 ONNX Runtime Web(MIT), sharp(Apache-2.0), axios(MIT), cheerio(MIT), firebase-admin·firebase-functions·firebase-functions-test·googleapis(Apache-2.0)입니다. 실제 고정 버전과 전이 패키지의 다른 조건은 목록을 기준으로 확인하십시오.

**sharp와 함께 제공되는 libvips는 sharp와 동일한 Apache 라이선스가 아닙니다.** 로컬 @img/sharp-libvips 패키지는 LGPL-3.0-or-later이며 네이티브 구성요소에 LGPL·MPL·BSD·MIT 등 여러 조건이 포함됩니다. 목록 생성기는 이 패키지의 README 및 versions.json도 고지에 포함합니다. 바이너리를 재배포하면 실제 대상 플랫폼의 고지, 해당 소스 및 교체/재링크 관련 의무를 별도로 확인해야 합니다. 서버에서만 실행하는 LGPL 라이브러리의 의무와 브라우저로 배포하는 바이너리의 의무를 혼동하지 마십시오. [libvips](https://github.com/libvips/libvips), [패키징 소스](https://github.com/lovell/sharp-libvips).

GitHub Actions 및 Firebase CLI 같은 빌드·배포 도구는 앱의 npm 목록과 별도입니다. 워크플로의 actions/checkout, actions/setup-node, google-github-actions/auth, FirebaseExtended/action-hosting-deploy는 각 upstream 조건을 따릅니다. 버전이 고정되지 않은 도구를 포함한 재현성 확인은 배포자의 책임입니다.

Google Identity Services, Analytics, AdSense 및 Google/Firebase/YouTube/Discord API는 외부 서비스입니다. 관련 스크립트·서비스 이용 권한을 이 프로젝트의 AGPL로 제공하지 않습니다. 각 공급자의 약관과 개인정보 처리 조건이 별도로 적용됩니다.
