// 오류 메시지·코드·URL·요청/응답 객체는 인증정보를 포함할 수 있어 기록하지 않습니다.
function safeErrorSummary(error) {
  const summary = {
    type: error?.isAxiosError === true ? 'http_request_error' : 'internal_error',
  };
  const status = error?.response?.status;
  if (Number.isInteger(status) && status >= 100 && status <= 599) {
    summary.status = status;
  }
  return summary;
}

module.exports = { safeErrorSummary };
