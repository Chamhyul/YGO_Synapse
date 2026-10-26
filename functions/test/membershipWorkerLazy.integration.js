'use strict';
// 운영 worker와 같은 지연 선택으로 기존 실제 RTDB/Auth의 중복·회수·역전환·ACK 유실 복구를 실행한다.
const binding = require('../services/userInventoryWriterRepository');
const create = binding.createUserInventoryWriterBinding;
binding.createUserInventoryWriterBinding = options => create({ ...options, deferOptionalServices: true });
require('./membershipClaimsFollowup.integration');
// worker가 사용하지 않은 선택 서비스도 기존 양방향 저장·교체·복구를 그대로 제공한다.
require('./cardApiWriter.integration');
require('./membershipCsvWriter.integration');
require('./adminWriter.integration');
require('./userInventoryWriter.integration');
