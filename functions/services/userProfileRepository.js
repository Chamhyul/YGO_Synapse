'use strict';

// 외부 프로필/가입/설정 계약을 저장소별로 연결한다. 멤버십 인증·권한 변경은 담당하지 않는다.
function createFirestoreUserProfileRepository({ db, getBucket, FieldValue } = {}) {
  const ref = uid => db.collection('users').doc(uid);
  const repository = {
    async read(uid) {
      const snapshot = await ref(uid).get();
      return { exists: snapshot.exists, value: snapshot.exists ? snapshot.data() : undefined };
    },
    async isRegistered(uid) {
      if ((await ref(uid).get()).exists) return true;
      const [exists] = await getBucket().file(`users/${uid}/inventory.json`).exists();
      return exists;
    },
    async completeRegistration(uid, versions) {
      if (await repository.isRegistered(uid)) return;
      const target = ref(uid);
      await db.runTransaction(async transaction => {
        const snapshot = await transaction.get(target);
        if (snapshot.exists) return;
        transaction.create(target, {
          createdAt: FieldValue.serverTimestamp(),
          registration: { completed: true, consent: {
            terms: versions.terms, privacy: versions.privacy, acceptedAt: FieldValue.serverTimestamp(),
          } },
        });
      });
    },
    async updateSettings(uid, settings) {
      await ref(uid).set({ settings: { ...settings, updatedAt: Date.now() } }, { merge: true });
    },
    async updateNickname(uid, nickname) {
      await ref(uid).set({ Nickname: nickname, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    },
  };
  return repository;
}

function createRtdbUserProfileRepository({ storage } = {}) {
  if (!storage?.profile || !storage?.inventory) {
    throw Object.assign(new Error('사용자 프로필과 인벤토리 저장소가 필요합니다.'), { code: 'USER_STORAGE_INVALID_CONFIG' });
  }
  const repository = {
    async read(uid) {
      const record = await storage.profile.read(uid);
      return { exists: record.exists, value: record.value };
    },
    async isRegistered(uid) {
      if ((await storage.profile.read(uid)).exists) return true;
      // 인벤토리 본문·카드 전체를 읽거나 조회만으로 프로필/과거 동의를 만들지 않는다.
      return (await storage.inventory.readMetadata(uid)).exists;
    },
    async completeRegistration(uid, versions) {
      if (await repository.isRegistered(uid)) return;
      await storage.profile.createIfAbsent(uid, {
        createdAt: null,
        registration: { completed: true, consent: { terms: versions.terms, privacy: versions.privacy, acceptedAt: null } },
      }, { serverTimestampPaths: [['createdAt'], ['registration', 'consent', 'acceptedAt']] });
    },
    async updateSettings(uid, settings) {
      await storage.profile.update(uid, { settings: { ...settings, updatedAt: Date.now() } });
    },
    async updateNickname(uid, nickname) {
      await storage.profile.update(uid, { Nickname: nickname, updatedAt: null }, { serverTimestampPaths: [['updatedAt']] });
    },
  };
  return repository;
}

function getUserProfileRepository() {
  if ((process.env.USER_PROFILE_WRITER_MODE === 'production' || process.env.USER_STORAGE_MODE === 'production')) {
    return require('./userWriterSelection').selectProductionWriter().repository;
  }
  if (process.env.USER_PROFILE_WRITER_MODE !== undefined && process.env.USER_PROFILE_WRITER_MODE !== '') {
    return require('./userProfileWriterRuntime').getProfileWriterRepository();
  }
  const backend = process.env.USER_STORAGE_BACKEND;
  if (backend === 'rtdb') {
    return createRtdbUserProfileRepository({ storage: require('./userStorageRuntime').getRtdbUserStorage() });
  }
  if (backend !== undefined && backend !== '' && backend !== 'storage') {
    throw Object.assign(new Error('사용자 저장소 backend 설정이 올바르지 않습니다.'), { code: 'USER_STORAGE_CONFIG_INVALID' });
  }
  return createFirestoreUserProfileRepository(require('../config/firebase'));
}

module.exports = { createFirestoreUserProfileRepository, createRtdbUserProfileRepository, getUserProfileRepository };
