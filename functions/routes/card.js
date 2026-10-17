// 기존 내부 참조를 유지하는 호환 진입점. 배포 등록은 기능별 모듈을 사용한다.
module.exports = { ...require("./cardCatalog"), ...require("./inventory") };
