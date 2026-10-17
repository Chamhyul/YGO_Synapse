'use strict';
const { productionWriterRequested, resolveProfileWriterConfig } = require('../config/userProfileWriter');
const invalid = () => Object.assign(new Error('공통 사용자 writer 연결을 확인하지 못했습니다.'), { code: 'USER_STORAGE_CONFIG_INVALID' });
function selectProductionWriter({ env = process.env, writerBinding } = {}) {
  if (!productionWriterRequested(env)) return writerBinding;
  const config = resolveProfileWriterConfig(env);
  if (!writerBinding && env !== process.env) throw invalid();
  const binding = writerBinding || require('./userProfileWriterRuntime').getProfileWriterBinding();
  if (binding.transition?.runId !== config.runId || JSON.stringify(binding.claimsStorage?.config) !== JSON.stringify(config)) throw invalid();
  return binding;
}
module.exports = { selectProductionWriter, productionWriterRequested };
