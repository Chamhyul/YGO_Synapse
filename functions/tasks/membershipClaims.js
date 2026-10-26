'use strict';
const { onValueWritten } = require('firebase-functions/v2/database');
const { resolveMembershipProviderRuntime } = require('../services/membershipProviderRuntime');
const { syncMembershipClaimsForProfileEvent } = require('../services/membershipClaims');
const { createMembershipClaimsFollowup } = require('../services/membershipClaimsFollowup');
const { withMembershipWorkerTiming, prepareMembershipWorkerStartup } = require('../services/membershipWorkerTiming');
const { withMembershipWorkerPreparation } = require('../services/membershipWorkerPreparation');

// 관리형 worker의 동기 구성만 기동 중 준비한다. 업무에서는 현재값을 재검증한다.
prepareMembershipWorkerStartup(() => resolveMembershipProviderRuntime());

// RTDB と同じリージョン。既存の通常 Functions 実行アカウントを使い、
// 公開 HTTP エンドポイントや新しいユーザー権限は追加しない。
exports.syncMembershipClaimsAfterProfile = withMembershipWorkerPreparation(onValueWritten({
  ref: '/users/{userKey}/profile', instance: 'ygo-synapse-default-rtdb', region: 'asia-southeast1',
  retry: true, timeoutSeconds: 60, memory: '256MiB', maxInstances: 3, concurrency: 1,
}, withMembershipWorkerTiming(createMembershipClaimsFollowup({
  select: () => resolveMembershipProviderRuntime(),
  sync: (uid, runtime, evidence) => syncMembershipClaimsForProfileEvent(uid,
    { storage: runtime.storage, permissionChanged: evidence.permissionChanged }),
}))), { select: () => resolveMembershipProviderRuntime() });
