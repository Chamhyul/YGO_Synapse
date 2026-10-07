const { db, getBucket } = require('../config/firebase');

// 기존 회원의 동의 이력을 만들어내지 않는다. 문서가 없는 구형 인벤토리도 보존한다.
async function isRegisteredUser(uid) {
  const snapshot = await db.collection('users').doc(uid).get();
  if (snapshot.exists) return true;
  const [exists] = await getBucket().file(`users/${uid}/inventory.json`).exists();
  return exists;
}

module.exports = { isRegisteredUser };
