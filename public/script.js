/** YGO Synapse Client */
// 운영·로컬 모두 같은 함수 이름 목록으로 주소를 생성합니다.
const HTTP_FUNCTION_NAMES = [
    "getInitialData",
    "checkSheet",
    "addCards",
    "moveCards",
    "discardCards",
    "searchPack",
    "getPackCids",
    "crawlPackCardsBatch",
    "searchCardByNo",
    "searchCardByName",
    "getCardMetadata",
    "getCardsMetaBatch",
    "crawlCardMetaByName",
    "getRamMemoryStats",
    "getUserData",
    "getRegistrationStatus",
    "completeRegistration",
    "updateUserSettings",
    "updateNickname",
    "startDiscordMembershipVerification",
    "verifyDiscordMembership",
    "startYoutubeMembershipVerification",
    "verifyYoutubeMembership",
    "uploadMembershipCsv",
    "searchDeck",
    "searchCard",
    "searchCardByImage",
    "resolveCardNames",
    "suggestCardNames",
    "getDeckCards",
    "migrateFromSheet",
    "migrateFromData",
    "clearUserData",
    "migrateCardNumbersField",
    "manageNotice",
    "manageAdminRole"
];
const LOCAL_DEV_HOSTS = new Set(['localhost', '127.0.0.1', '192.168.0.22']);
const IS_LOCAL_DEV = LOCAL_DEV_HOSTS.has(location.hostname) || location.hostname.toLowerCase().endsWith('.local');
const LOCAL_EMULATOR_HOST = location.hostname === 'localhost' ? '127.0.0.1' : location.hostname;
// 기본 로컬 주소(5005 → 5001)와 분리 개발 주소(5105 → 5101)를 모두 지원합니다.
const LOCAL_FUNCTION_PORT = location.port === '5105' ? '5101' : '5001';
const LOCAL_FUNCTION_BASE_URL = `http://${LOCAL_EMULATOR_HOST}:${LOCAL_FUNCTION_PORT}/ygo-synapse/asia-northeast3`;
const PRODUCTION_FUNCTION_BASE_URL = 'https://asia-northeast3-ygo-synapse.cloudfunctions.net';
// 로컬 UI에서도 공용 카드 카탈로그는 운영 데이터를 사용합니다. 사용자 데이터 변경,
// 크롤링/마이그레이션/관리 기능은 에뮬레이터에 남겨 운영 데이터의 변경을 막습니다.
const PRODUCTION_READ_FUNCTIONS = new Set([
    'getInitialData',
    'searchCardByNo',
    'searchCardByName',
    'searchCard',
    'resolveCardNames',
    'suggestCardNames',
    'getCardMetadata',
    'getCardsMetaBatch',
    'searchPack',
    'getPackCids',
    'searchDeck',
    'getDeckCards',
    'getRamMemoryStats',
    'searchCardByImage'
]);
function getFunctionBaseUrl(name) {
    if (globalThis.AppBackend || typeof document !== 'undefined' && document.documentElement?.dataset?.backend === 'supabase') return '/api/unconnected';
    return IS_LOCAL_DEV && !PRODUCTION_READ_FUNCTIONS.has(name)
        ? LOCAL_FUNCTION_BASE_URL
        : PRODUCTION_FUNCTION_BASE_URL;
}
const FIREBASE_CONFIG = {
    ENDPOINTS: Object.fromEntries(HTTP_FUNCTION_NAMES.map(name => [name, `${getFunctionBaseUrl(name)}/${name}`]))
};
// 사용자 토큰은 SDK에서 가져오며 App Check 캐시·갱신도 SDK에 맡긴다.
let _cachedAuthToken = null;

// Firebase App Check 즉시 초기화
if (!window.YgoDiscordPopup?.isCallback && typeof firebase !== 'undefined' && firebase.appCheck && !window.YgoAuthBootstrap?.appCheckStarted) {
    // localhost에서 운영의 App Check 보호 API를 호출할 수 있도록 debug token을 발급합니다.
    // 콘솔에 출력된 토큰은 Firebase Console > App Check에서 한 번 등록해야 합니다.
    if (IS_LOCAL_DEV) self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
    const appCheck = firebase.appCheck();
    const provider = new firebase.appCheck.ReCaptchaEnterpriseProvider('6Le3FaksAAAAAFE9lMsuyGfgTkvNaVzrThMUthe3');
    appCheck.activate(provider, true);
}

const CLIENT_VERSION = "ver. 0.33.1";

const STORAGE_KEY = 'yugioh_spreadsheet_id';
const RECENT_KEY = 'recent_card_searches';
const THEME_KEY = 'yugioh_theme_mode'; // 초기 표시용 마지막 테마 (기존 기록 유지)
const GUEST_THEME_KEY = 'yugioh_theme_mode_guest';
const ACCOUNT_THEME_KEY_PREFIX = 'yugioh_theme_mode_user:';
const REGION_KEY = 'yugioh_region_setting';
const IS_DETAIL_MODE_KEY = 'yugioh_modal_detail_mode'; // 상세 모드 저장 키

/**
 * 자주 참조되는 주요 DOM 요소 캡슐화 객체
 */
const DOM = {
    get inventoryGridBody() { return document.getElementById('inventory-grid-body'); },
    get gridStatusArea() { return document.getElementById('grid-status-area'); },
    get inventoryFilterPopup() { return document.getElementById('inventory-filter-popup'); },
    get customDropdown() { return document.getElementById('custom-dropdown'); }
};

// window.isAuthInitialized = false; // Firebase Auth 초기 세션 확인 완료 여부

/**
 * 사용자 및 인증 상태 전역 스토어
 */
const UserStore = {
    user: null,
    settings: { theme: 'light', isDetailMode: false, hideMembershipVerify: false },
    isInitialSyncDone: false,
    isUserDataSyncDone: false,
    inventorySyncStatus: 'idle',
    claimsSyncStatus: 'idle',
    accountRevision: 0
};

/**
 * 카드 마스터 카탈로그 및 캐시 데이터 전역 스토어
 */
const CardDataStore = {
    allCardNames: [],
    allCardNamesNormalized: [],
    allCardNumbers: [],
    allProcessingTypes: [],
    cachedPackNames: null,
    masterJSON: { pack: {}, rarity: [] }
};

/**
 * Firebase Auth 세션 복원(초기화)이 완료될 때까지 대기하는 Promise
 */
function waitForAuthInit(timeoutMs = 3000) {
    if (window.isAuthInitialized) return Promise.resolve();
    return new Promise((resolve) => {
        const startTime = Date.now();
        const interval = setInterval(() => {
            if (window.isAuthInitialized || (Date.now() - startTime > timeoutMs)) {
                clearInterval(interval);
                resolve();
            }
        }, 30);
    });
}

/**
 * 비활동 자동 로그아웃 관리를 위한 매니저 (Inactivity Timeout: 기본 30분)
 */
const AutoLogoutManager = (function () {
    const session = window.createAuthSession({
        onExpire() {
            showToast('일정 시간 동안 활동이 없어 자동 로그아웃되었습니다.', 'toast-warn');
            signOutCurrentUser();
        }
    });
    return {
        start: () => UserStore.user && session.start(UserStore.user),
        stop: () => session.stop(),
        reset: () => session.reset()
    };
})();

// 초성 검색 및 성능 최적화용 캐시/도구

const HANGUL_CHOSUNG_LIST = [
    'ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 
    'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'
];

function getChosung(str) {
    if (!str) return '';
    let result = '';
    for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i);
        if (code >= 44032 && code <= 55203) {
            const index = Math.floor((code - 44032) / 588);
            result += HANGUL_CHOSUNG_LIST[index];
        } else {
            const char = str[i].toLowerCase();
            if (char !== ' ') {
                result += char;
            }
        }
    }
    return result;
}



// 디바운스(Debounce) 헬퍼 함수
function debounce(func, delay) {
    let timeoutId;
    const debounced = function (...args) {
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
        timeoutId = setTimeout(() => {
            func.apply(this, args);
        }, delay);
    };
    debounced.cancel = function () {
        if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
        }
    };
    return debounced;
}

// HTML 특수 문자 이스케이프 함수 (XSS 예방)
function escapeHTML(str) {
    if (str === null || str === undefined) return '';
    const s = String(str);
    return s.replace(/[&<>'"]/g, tag => {
        const chars = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            "'": '&#39;',
            '"': '&quot;'
        };
        return chars[tag] || tag;
    });
}

// 프리-정규화된 카드 이름 동기화 함수
function updateNormalizedNames() {
    cardCacheInstance.setAllKnownNames(CardDataStore.allCardNames);
    const previous = CardDataStore.allCardNamesNormalized;
    // 전역 목록의 입력 순서와 캐시의 검색 정렬은 따로 유지하고 이름별 계산만 공유한다.
    if (previous?.length === CardDataStore.allCardNames.length
        && CardDataStore.allCardNames.every((name, i) => previous[i] === cardCacheInstance.getKnownNameSearchEntry(name))) return;
    CardDataStore.allCardNamesNormalized = CardDataStore.allCardNames.map(name => cardCacheInstance.getKnownNameSearchEntry(name));
}





function updatePackNamesCache() {
    const packs = (CardDataStore.masterJSON && CardDataStore.masterJSON.pack) ? CardDataStore.masterJSON.pack : {};
    const names = Object.values(packs)
        .map(p => (p && p.name) ? String(p.name).trim() : '')
        .filter(Boolean);
    CardDataStore.cachedPackNames = [...new Set(names)];
}

function getAllPackNames() {
    if (!CardDataStore.cachedPackNames) updatePackNamesCache();
    return CardDataStore.cachedPackNames;
}

let migrationValidationTimeout = null; // 마이그레이션 링크 검증용 타임아웃

// Master JSON 원형 저장 및 관리를 위한 IndexedDB 유틸리티
const MasterDB = {
    DB_NAME: globalThis.AppBackend?.cacheName || 'YgoSynapseDB',
    STORE_NAME: 'masterCache',
    VERSION: 1,
    dbInstance: null, // 싱글톤 연결 객체 캐시 저장소

    open() {
        // 이미 열려 있는 DB 커넥션이 있다면 재사용
        if (this.dbInstance) {
            return Promise.resolve(this.dbInstance);
        }
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.DB_NAME, this.VERSION);
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(this.STORE_NAME)) {
                    db.createObjectStore(this.STORE_NAME);
                }
            };
            request.onsuccess = (e) => {
                this.dbInstance = e.target.result; // 성공 시 커넥션 캐싱
                resolve(this.dbInstance);
            };
            request.onerror = (e) => reject(e.target.error);
        });
    },

    async get(key) {
        try {
            const db = await this.open();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction(this.STORE_NAME, 'readonly');
                const store = transaction.objectStore(this.STORE_NAME);
                const request = store.get(key);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
        } catch (e) { return null; }
    },

    async set(key, val) {
        try {
            const db = await this.open();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction(this.STORE_NAME, 'readwrite');
                const store = transaction.objectStore(this.STORE_NAME);
                const request = store.put(val, key);
                request.onsuccess = () => resolve();
                request.onerror = () => reject(request.error);
            });
        } catch (e) { }
    },

    async loadAllMasterData() {
        try {
            const db = await this.open();
            return new Promise((resolve) => {
                const transaction = db.transaction(this.STORE_NAME, 'readonly');
                const store = transaction.objectStore(this.STORE_NAME);
                const keys = ['cardNames', 'cardNumbers', 'cardListSupplement', 'packData', 'rarity'];
                const result = {};
                let count = 0;
                keys.forEach(k => {
                    const req = store.get(k);
                    req.onsuccess = () => {
                        result[k] = req.result;
                        count++;
                        if (count === keys.length) resolve(result);
                    };
                    req.onerror = () => {
                        count++;
                        if (count === keys.length) resolve(result);
                    };
                });
            });
        } catch (e) { return {}; }
    },

    // 최신 보충 목록을 읽고 매니페스트와 함께 원자적으로 저장합니다.
    async updateCardLists(additions, manifest = null) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.STORE_NAME, 'readwrite');
            const store = tx.objectStore(this.STORE_NAME);
            const data = {};
            const keys = ['cardNames', 'cardNumbers', 'cardListSupplement'];
            let count = 0;
            let result;
            for (const key of keys) {
                const request = store.get(key);
                request.onsuccess = () => {
                    data[key] = request.result;
                    if (++count !== keys.length) return;
                    const names = CardListCache.clean(manifest ? manifest.names : data.cardNames);
                    const numbers = CardListCache.clean(manifest ? manifest.numbers : data.cardNumbers, true);
                    const supplement = CardListCache.mergeSupplement(data.cardListSupplement, additions, { names, numbers });
                    if (manifest) {
                        store.put(names, 'cardNames');
                        store.put(numbers, 'cardNumbers');
                        store.delete('cidIndex');
                    }
                    store.put(supplement, 'cardListSupplement');
                    result = { names, numbers, supplement };
                };
            }
            tx.oncomplete = () => resolve(result);
            tx.onerror = tx.onabort = () => reject(tx.error || new Error('카드 목록 저장 실패'));
        });
    },

    async saveMasterDataBatch(payload) {
        if (!payload || typeof payload !== 'object') return;
        try {
            const db = await this.open();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction(this.STORE_NAME, 'readwrite');
                const store = transaction.objectStore(this.STORE_NAME);
                Object.keys(payload).forEach(key => {
                    if (payload[key] !== undefined && payload[key] !== null) {
                        store.put(payload[key], key);
                    }
                });
                transaction.oncomplete = () => resolve();
                transaction.onerror = () => reject(transaction.error);
            });
        } catch (e) { throw e; }
    }
};

// 서버 목록과 검색으로 확인한 로컬 보충 목록은 별도로 보관합니다.
const CardListCache = {
    manifest: { names: [], numbers: [] },
    supplement: { names: [], numbers: [] },
    pendingWrite: Promise.resolve(),
    clean(values, number = false) {
        return [...new Set((Array.isArray(values) ? values : []).filter(value => typeof value === 'string')
            .map(value => number ? value.trim().toUpperCase() : value.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim().normalize('NFC'))
            .filter(value => value && !value.startsWith('##')))];
    },
    mergeSupplement(previous, additions, manifest) {
        const result = {};
        for (const key of ['names', 'numbers']) {
            const known = new Set(manifest[key]);
            result[key] = this.clean([...(previous?.[key] || []), ...(additions?.[key] || [])], key === 'numbers')
                .filter(value => !known.has(value));
        }
        return result;
    },
    init(data) {
        this.manifest = { names: this.clean(data.cardNames), numbers: this.clean(data.cardNumbers, true) };
        this.supplement = this.mergeSupplement(data.cardListSupplement, this.supplement, this.manifest);
        this.publish();
    },
    publish() {
        CardDataStore.allCardNames = [...new Set([...this.manifest.names, ...this.supplement.names])];
        CardDataStore.allCardNumbers = [...new Set([...this.manifest.numbers, ...this.supplement.numbers])];
        updateNormalizedNames();
    },
    persist(manifest = null) {
        // 로컬 저장 순서를 유지하고 실패한 이전 쓰기가 후속 쓰기를 막지 않게 합니다.
        const write = this.pendingWrite.catch(() => {}).then(async () => {
            const saved = await MasterDB.updateCardLists(this.supplement, manifest);
            this.manifest = { names: saved.names, numbers: saved.numbers };
            // 저장을 기다리는 동안 도착한 검색 결과도 유지합니다.
            this.supplement = this.mergeSupplement(saved.supplement, this.supplement, this.manifest);
            this.publish();
        });
        this.pendingWrite = write;
        return write;
    },
    rememberResponse(action, response) {
        if (!response?.success || response.isError || response.isPendingCrawl) return;
        const supported = ['searchCardByName', 'searchCardByNo', 'searchCard', 'getCardMetadata',
            'crawlCardMetaByName', 'crawlPackCardsBatch'];
        if (!supported.includes(action)) return;
        const cards = action === 'crawlPackCardsBatch' ? (response.results || []) : [response];
        const names = [], numbers = [];
        for (const card of cards) {
            if (!card || card.isError || card.isPendingCrawl) continue;
            const info = card.info || card.mergedInfo;
            if (!info && card.name) names.push(card.name);
            if (Array.isArray(card.names)) names.push(...card.names);
            if (Array.isArray(card.numbers)) numbers.push(...card.numbers);
            if (card.cardNo) numbers.push(card.cardNo);
            for (let index = 0; index < 10; index++) {
                const slot = info?.[index];
                if (!Array.isArray(slot) || typeof slot[0] !== 'string' || !slot[0]) continue;
                names.push(slot[0]);
                if (slot[2] && typeof slot[2] === 'object') numbers.push(...Object.keys(slot[2]));
            }
        }
        const next = this.mergeSupplement(this.supplement, { names, numbers }, this.manifest);
        if (JSON.stringify(next) === JSON.stringify(this.supplement)) return;
        this.supplement = next;
        this.publish();
        this.persist().catch(error => console.warn('[CardListCache] 로컬 보충 목록 저장 실패:', error));
    },
};

/**
 * 통합 캐시 클래스 - Phase 1 (Master JSON 연동)
 */
class ClientCache {
    constructor() {
        this._inventory = [];
        this._inventoryRevision = 0;
        this._allKnownNames = new Set();
        this._knownNames = [];
        this._knownNamesNormalized = [];
        this._knownNameEntries = new Map();
        this._inventoryNames = new Set();
        this._inventoryNameIndex = new Map();
        this._nameIndexKnownSource = null;
        this._indexes = {
            ownedNumbers: new Set(),
            nameToNos: {},
            locations: new Set()
        };
        this._sortedNames = [];
        this._sortedLocations = [];
        this._sortedOwnedNumbers = [];

        // 보유 카드 이름 및 번호 캐시용 Set 필드
        this._cachedOwnedNamesSet = null;
        this._cachedOwnedNumbersSet = null;
        this._sortedNamesNormalized = [];

        // 서버 통계 및 매핑 저장소
        this._summary = {
            amount: 0,
            locations: {}, // { "위치": ["번호1", ...] }
            rarities: {}   // { "레어도": 수량 }
        };
    }

    // O(1) 검색을 위한 전역 마스터 인덱스 (Static)
    // 서버 전체 CID 파일 대신 확인한 카드와 보유 재고의 연결만 사용합니다.
    static _knownNameToCid = Object.create(null);
    static _knownNumberToCid = Object.create(null);
    static _cidToNames = Object.create(null);
    static _nameToNos = {};
    static _noToName = {};
    static _noToPack = {};
    static _packToNos = {};
    static _noToRarities = {};
    static _nameToAnother = {};

    static registerCid(cid, names = [], numbers = []) {
        if (!cid || ['LOCAL_CID', 'MISSING_CID', 'null', 'undefined'].includes(String(cid))) return;
        cid = String(cid);
        const put = (map, key) => {
            if (!key) return;
            if (!Object.hasOwn(map, key)) map[key] = cid;
            else if (map[key] !== cid) map[key] = null;
        };
        if (!this._cidToNames[cid]) this._cidToNames[cid] = new Set();
        for (const name of names) if (name && typeof name === 'string') {
            this._cidToNames[cid].add(name);
            put(this._knownNameToCid, name);
            put(this._knownNameToCid, normalizeStr(name));
        }
        for (const number of numbers) if (number) put(this._knownNumberToCid, String(number).trim().toUpperCase());
    }

    static getCardNameByCid(cid, region = 'ko') {
        const meta = cidMetaMemoryCache.get(String(cid));
        const index = ['ko', 'ja', 'ae', 'cn', 'en', 'de', 'fr', 'it', 'es', 'pt'].indexOf(region);
        return meta?.info?.[index]?.[0] || [...(this._cidToNames[String(cid)] || [])][0]
            || cardCacheInstance._ownedByCid?.get(String(cid))?.[0]?.[0] || null;
    }

    /**
     * 앱 시작 시 IndexedDB에서 마스터 캐시 로드
     */
    /**
     * 앱 시작 시 IndexedDB에서 마스터 캐시 1회 일괄 로드 (Single Batch Read)
     */
    static async init() {
        if (globalThis.AppBackend) return globalThis.AppBackend.ready();
        const data = await MasterDB.loadAllMasterData();

        CardListCache.init(data);


        if (data.packData) {
            CardDataStore.masterJSON.pack = data.packData;
            updatePackNamesCache();
        }

        if (data.rarity) {
            CardDataStore.masterJSON.rarity = data.rarity;
        }

        this.rebuildMasterIndexes();
    }

    /**
     * 백엔드에서 받은 페이로드를 클라이언트 캐시에 통합 후 1회 일괄 저장 (Single Batch Write)
     */
    static async setMasterData(inc) {
        if (!inc) return;

        const updateBatch = {};

        if (inc.pack) {
            CardDataStore.masterJSON.pack = CardDataStore.masterJSON.pack || {};
            for (let pid in inc.pack) {
                CardDataStore.masterJSON.pack[pid] = inc.pack[pid];
            }
            updateBatch.packData = CardDataStore.masterJSON.pack;
            updatePackNamesCache();
        }

        if (inc.rarity) {
            CardDataStore.masterJSON.rarity = inc.rarity;
            updateBatch.rarity = inc.rarity;
        }

        if (Object.keys(updateBatch).length > 0) {
            await MasterDB.saveMasterDataBatch(updateBatch);
            this.rebuildMasterIndexes();
        }
    }

    /**
     * 단 한 번의 순회로 모든 마스터 인덱스를 재생성합니다. (O(1) 검색 지원)
     */
    static rebuildMasterIndexes() {
        // [On-Demand 전환] 카드 인덱스 구축 제거
        // 인덱스 초기화 (세션 캐시용으로만 유지)
        if (!this._knownNameToCid) this._knownNameToCid = {};
        this._cidToNames ||= Object.create(null);
        this._nameToNos = {};
        this._noToName = {};
        this._noToPack = {};
        this._packToNos = {};
        this._noToRarities = {};
        this._nameToAnother = {};

        // [On-Demand 전환] 카드 데이터 순회 및 팩 데이터 보강(card 참조) 로직 제거
        // 팩 카드 정보는 crawlPackCardsBatch API를 통해 On-Demand 조회

        // 레어도 메타데이터 전역 변수 업데이트 (UI 렌더링용) - 유지
        if (CardDataStore.masterJSON.rarity && CardDataStore.masterJSON.rarity.length > 0) {
            rarityMappingRaw = CardDataStore.masterJSON.rarity;
            const headers = rarityMappingRaw[0];
            rarityColMap = {};
            headers.forEach((h, i) => rarityColMap[h] = i);
            rarityRows = rarityMappingRaw.slice(1);
            rarityReverseMap = {};
            rarityOrderMap = {};
            rarityRows.forEach((r, index) => {
                const id = r[0];
                if (id) {
                    rarityOrderMap[id] = index;
                    r.forEach(cellVal => { if (cellVal) rarityReverseMap[cellVal] = index; });
                }
            });
            CardDataStore.allProcessingTypes = rarityRows.map(r => r[0]).filter(Boolean).filter(r => r !== "레어도" && r !== "Rarity");
        }
    }

    /**
     * [개편] 카드 번호로 데이터를 조회합니다. (Master JSON 기반)
     */
    static getCardByCode(cardNo) {
        if (!cardNo) return null;
        const upperNo = cardNo.toUpperCase();

        const name = this._noToName[upperNo];
        if (!name) return null;

        const cid = this._knownNameToCid[name];
        const raritiesSet = this._noToRarities[upperNo];

        return {
            name: name,
            illustrationCount: this._nameToAnother[name] || 0,
            rarities: raritiesSet ? Array.from(raritiesSet) : [],
            linkData: { id: cid, locale: UIStore.currentRegion }
        };
    }

    getCardByCode(cardNo) {
        return ClientCache.getCardByCode(cardNo);
    }

    /**
     * [복구] 호환성 메서드: 카드 번호로 데이터를 조회합니다.
     */
    getDetailByNo(cardNo) {
        return ClientCache.getCardByCode(cardNo);
    }

    getDetailByName(name) {
        if (!name) return null;

        const nosSet = ClientCache._nameToNos[name];
        if (!nosSet) return null;

        const raritiesByNo = {};
        nosSet.forEach(no => {
            const rares = ClientCache._noToRarities[no];
            raritiesByNo[no] = rares ? Array.from(rares) : [];
        });

        return {
            name,
            raritiesByNo,
            illustrationCount: ClientCache._nameToAnother[name] || 0
        };
    }

    /**
     * [Phase 2] 인벤토리 설정 및 인덱스 갱신
     */
    bindInventorySource(source) {
        this._inventorySource = source;
        this.syncInventorySource();
    }

    syncInventorySource() {
        if (!this._inventorySource || this._syncingInventorySource) return;
        const value = this._inventorySource.snapshot();
        if (value.allCards === this._inventory) return;
        this._syncingInventorySource = true;
        try {
            this._inventory = value.allCards;
            this._summary = { amount: value.amount, locations: value.inventoryDisplaySummary.locations,
                rarities: value.inventoryDisplaySummary.rarities };
            this.refreshIndexes({ summaryComplete: true });
        } finally { this._syncingInventorySource = false; }
    }

    setInventory(data, options) {
        if (this._inventorySource) { this.syncInventorySource(); return; }
        this._inventory = (data || []).map(row => [...row.slice(0, 6), row[6] || null, ...row.slice(7)]);
        this.refreshIndexes(options);
    }

    // 전체 응답은 서버 요약을 먼저 적용한 뒤 목록·검색 인덱스·집계를 한 번
    // 갱신한다. 빈 목록과 구형 요약 보존 규칙도 기존 재계산에서 처리한다.
    setInventorySnapshot(data, amount, locations, rarities, options) {
        if (this._inventorySource) { this.syncInventorySource(); return; }
        this._summary.amount = amount || 0;
        this._summary.locations = locations || {};
        this._summary.rarities = rarities || {};
        this.setInventory(data, options);
    }

    /**
     * [Phase 2] 전체 알려진 카드 이름 저장 및 동기화
     */
    setAllKnownNames(names) {
        if (!names || !Array.isArray(names)) return;
        const next = new Set(names);
        if (next.size === this._allKnownNames.size && [...next].every(name => this._allKnownNames.has(name))) return;
        const previousKnown = this._knownNameEntries;
        this._allKnownNames = next;
        this._knownNames = Array.from(next).sort();
        this._knownNameEntries = new Map(this._knownNames.map(name => [name,
            previousKnown.get(name) || this._inventoryNameIndex.get(name) || this.createNameSearchEntry(name)]));
        this._knownNamesNormalized = this._knownNames.map(name => this._knownNameEntries.get(name));
        // 공개 이름의 변경은 보유 수량·위치·CID·집계를 바꾸지 않는다.
        this.refreshInventoryNameIndex(this._inventoryNames, previousKnown);
    }

    getKnownNameSearchEntry(name) { return this._knownNameEntries.get(name); }

    createNameSearchEntry(name) {
        const normalized = name.replace(/\s+/g, '').toLowerCase();
        return { original: name, normalized, chosung: getChosung(normalized) };
    }

    // 공개 이름의 색인은 보존하고, 현재 보유 목록에만 있는 이름을 별도로 관리한다.
    // 검색에 제공하는 합집합은 기존 문자열 정렬/중복 제거 규칙을 유지한다.
    refreshInventoryNameIndex(names, previousKnown) {
        const previous = this._inventoryNameIndex;
        const extraNames = [...names].filter(name => !this._allKnownNames.has(name)).sort();
        if (this._nameIndexKnownSource === this._knownNamesNormalized && extraNames.length === previous.size
            && extraNames.every(name => previous.has(name))) return;
        this._nameIndexKnownSource = this._knownNamesNormalized;
        this._inventoryNameIndex = new Map(extraNames.map(name => [name,
            previous.get(name) || previousKnown?.get(name) || this.createNameSearchEntry(name)]));
        if (!extraNames.length) {
            this._sortedNames = this._knownNames;
            this._sortedNamesNormalized = this._knownNamesNormalized;
            return;
        }
        const mergedNames = [], mergedEntries = [];
        let known = 0, extra = 0;
        while (known < this._knownNames.length || extra < extraNames.length) {
            const useKnown = extra === extraNames.length || known < this._knownNames.length
                && this._knownNames[known] < extraNames[extra];
            if (useKnown) {
                mergedNames.push(this._knownNames[known]);
                mergedEntries.push(this._knownNamesNormalized[known++]);
            } else {
                const name = extraNames[extra++];
                mergedNames.push(name);
                mergedEntries.push(this._inventoryNameIndex.get(name));
            }
        }
        this._sortedNames = mergedNames;
        this._sortedNamesNormalized = mergedEntries;
    }


    /**
     * [Phase 2] 인벤토리 부분 업데이트
     */
    updateInventory(updates) {
        if (this._inventorySource) { this.syncInventorySource(); return; }
        if (!updates || !Array.isArray(updates)) return;
        updates.forEach(item => {
            const idx = this._inventory.findIndex(row =>
                String(row[1]).toUpperCase() === String(item.cardNo).toUpperCase() &&
                String(row[2]) === String(item.rarity) &&
                String(row[4]) === String(item.loc) &&
                String(row[5]) === String(item.illustration)
            );

            if (item.isDeleted) {
                if (idx > -1) this._inventory.splice(idx, 1);
            } else {
                if (idx > -1) {
                    this._inventory[idx][3] = item.qty;
                    if (Object.hasOwn(item, 'cid')) this._inventory[idx][6] = item.cid || null;
                } else {
                    this._inventory.push([item.name, item.cardNo, item.rarity, item.qty, item.loc, item.illustration, item.cid || null]);
                }
            }
        });
        this.refreshIndexes();
    }

    /**
     * [Phase 2] 인덱스 및 전역 룩업 변수 자동 동기화
     */
    refreshIndexes({ summaryComplete = false } = {}) {
        this._inventoryRevision = (this._inventoryRevision || 0) + 1;
        this._inventoryNameToCid = Object.create(null);
        this._inventoryNoToCid = Object.create(null);
        this._ownedByCid = new Map();
        const assign = (map, key, cid) => {
            if (!Object.hasOwn(map, key)) map[key] = cid;
            else if (map[key] !== cid) map[key] = null;
        };
        for (const row of this._inventory) if (row[6]) {
            const cid = String(row[6]);
            assign(this._inventoryNameToCid, normalizeStr(String(row[0])), cid);
            assign(this._inventoryNoToCid, String(row[1]).trim().toUpperCase(), cid);
            if (!this._ownedByCid.has(cid)) this._ownedByCid.set(cid, []);
            this._ownedByCid.get(cid).push(row);
        }
        const names = new Set();
        const nos = new Set();
        const locations = new Set();
        const nameToNos = {};

        this._inventory.forEach(r => {
            const name = String(r[0]).trim();
            const no = String(r[1]).trim().toUpperCase();
            const loc = String(r[4]).trim();

            if (name) names.add(name);
            if (no) nos.add(no);
            if (loc) locations.add(loc);

            if (name) {
                if (!nameToNos[name]) nameToNos[name] = new Set();
                nameToNos[name].add(no);
            }
        });

        this._indexes.ownedNumbers = nos;
        this._indexes.locations = locations;

        this._indexes.nameToNos = {};
        for (let key in nameToNos) {
            this._indexes.nameToNos[key] = Array.from(nameToNos[key]).sort();
        }

        // 보유 변경은 공개 카드 이름의 정렬·정규화·초성을 재계산하지 않는다.
        this._inventoryNames = names;
        this.refreshInventoryNameIndex(names);
        this._sortedLocations = Array.from(locations).sort();
        this._sortedOwnedNumbers = Array.from(nos).sort();

        // 로컬 인벤토리 데이터를 바탕으로 대시보드 요약 통계 강제 동기화
        if (!summaryComplete) this.rebuildSummaryFromInventory();
        this.rebuildOwnedSets();

        // UI 반영
        if (typeof refreshLocalLookups === 'function') {
            // UI 갱신 로직 호출 (로컬 캐싱 동기화)
            refreshLocalLookups();
        }
    }

    /**
     * 로컬 인벤토리를 기준으로 대시보드 통계용 summary 객체를 재구축합니다.
     */
    rebuildSummaryFromInventory() {
        if (this._inventorySource) { this.syncInventorySource(); return; }
        // 인벤토리가 완전히 비어있고, 이미 서버 통계에 데이터가 존재하는 최초 로딩 전에는 덮어쓰지 않음
        if (this._inventory.length === 0 && this._summary.amount > 0) {
            return;
        }

        let totalAmount = 0;
        const locMap = {};
        const rareMap = {};

        this._inventory.forEach(r => {
            const no = String(r[1]).trim().toUpperCase();
            const rare = String(r[2]).trim();
            const qty = parseInt(r[3]) || 0;
            const loc = String(r[4]).trim();

            if (qty > 0) {
                totalAmount += qty;
                if (loc) {
                    if (!locMap[loc]) locMap[loc] = [];
                    if (!locMap[loc].includes(no)) locMap[loc].push(no);
                }
                if (rare) {
                    rareMap[rare] = (rareMap[rare] || 0) + qty;
                }
            }
        });

        this._summary.amount = totalAmount;
        this._summary.locations = locMap;
        this._summary.rarities = rareMap;

        // 위치 목록 업데이트 (매핑의 키값들)
        const locSet = new Set(Object.keys(this._summary.locations));
        this._indexes.locations = locSet;
        this._sortedLocations = Array.from(locSet).sort();
    }

    getOwnedNamesSet() {
        this.syncInventorySource();
        if (!this._cachedOwnedNamesSet) {
            this.rebuildOwnedSets();
        }
        return this._cachedOwnedNamesSet;
    }

    getOwnedNumbersSet() {
        this.syncInventorySource();
        if (!this._cachedOwnedNumbersSet) {
            this.rebuildOwnedSets();
        }
        return this._cachedOwnedNumbersSet;
    }

    rebuildOwnedSets() {
        const ownedNames = new Set();
        const ownedNumbers = new Set();
        this._inventory.forEach(r => {
            const qty = parseInt(r[3]) || 0;
            if (qty > 0) {
                ownedNames.add(String(r[0]).trim());
                ownedNumbers.add(String(r[1]).trim().toUpperCase());
            }
        });
        this._cachedOwnedNamesSet = ownedNames;
        this._cachedOwnedNumbersSet = ownedNumbers;
    }

    getInventory() { this.syncInventorySource(); return this._inventory; }
    getAllNames() { this.syncInventorySource(); return this._sortedNames; }
    getAllNamesNormalized() { this.syncInventorySource(); return this._sortedNamesNormalized; }
    getOwnedNumbers() { this.syncInventorySource(); return this._sortedOwnedNumbers; }
    getAllLocations() { this.syncInventorySource(); return this._sortedLocations; }

    /**
     * 서버 요약 통계 설정
     */
    setSummary(amount, locations, rarities) {
        if (this._inventorySource) { this.syncInventorySource(); return; }
        this._inventoryRevision = (this._inventoryRevision || 0) + 1;
        this._summary.amount = amount || 0;
        this._summary.locations = locations || {};
        this._summary.rarities = rarities || {};

        // 위치 목록 업데이트 (매핑의 키값들)
        const locSet = new Set(Object.keys(this._summary.locations));
        this._indexes.locations = locSet;
        this._sortedLocations = Array.from(locSet).sort();

        if (typeof refreshLocalLookups === 'function') refreshLocalLookups();
    }

    getAmount() { this.syncInventorySource(); return this._summary.amount; }
    getLocationsMap() { this.syncInventorySource(); return this._summary.locations; }
    getRaritiesMap() { this.syncInventorySource(); return this._summary.rarities; }

    getNosByName(name) { this.syncInventorySource(); return this._indexes.nameToNos[name] || []; }

    /**
     * 모든 데이터 초기화 (데이터 삭제 시 사용)
     */
    clearAll() {
        if (this._inventorySource) { this.syncInventorySource(); return; }
        this._inventory = [];
        this._indexes.ownedNumbers = new Set();
        this._indexes.locations = new Set();
        this._summary.amount = 0;
        this._summary.locations = {};
        this._summary.rarities = {};
        this.refreshIndexes();
    }
}

const cardCacheInstance = new ClientCache();

let rarityMappingRaw = [];
let rarityColMap = {};
let rarityRows = [];
let rarityReverseMap = {};
let rarityOrderMap = {};

let isAppConfigured = false;

/**
 * UI 상태 전역 스토어
 */
const UIStore = {
    mode: null,
    inventoryMode: 'dashboard',
    lastManageMode: 'add',
    pendingBlurFn: null,
    dropdownFocus: -1,
    activeDropdownInput: null,
    lastHashBeforeModal: "",
    currentRegion: 'ko',
    isMobileSearchInProgress: false
};

/**
 * [공통] 리스트 항목 하이라이트 처리
 */
function updateHighlight(items, index) {
    items.forEach(i => i.classList.remove('selected'));
    if (items[index]) {
        items[index].classList.add('selected');
        items[index].scrollIntoView({ block: 'nearest' });
    }
}

let currentSheetLastUpdated = 0;
let currentCacheSeq = 0; // JSON 캐시 동기화용 시퀀스 번호

/**
 * 인벤토리 변경 API 호출 시 필요한 공통 동기화 페이로드 생성
 */
function buildAuthPayload() {
    if (globalThis.AppBackend) return globalThis.AppBackend.buildAuthPayload();
    return { lastUpdated: currentSheetLastUpdated, cacheSeq: currentCacheSeq };
}

/**
 * cid 기반 카드 상세 메타 데이터 인메모리 캐시 Map 및 래퍼 함수
 */
const cidMetaMemoryCache = new Map();

/**
 * CID 메타 메모리 캐시 증분 병합 (Incremental Merge) 헬퍼
 * 기존 객체 구조({ cid, name, info, numbers, raritiesByNo, rawSlot, isFull }) 호환 보장
 */
function mergeCardMetaToCache(cid, metaData, isFull = false) {
    if (!cid) return null;
    const cidStr = String(cid);
    let existing = cidMetaMemoryCache.get(cidStr);

    if (!existing) {
        existing = {
            success: true,
            cid: cidStr,
            name: '',
            info: {},
            numbers: [],
            raritiesByNo: {},
            isFull: false
        };
    } else {
        existing.success = true;
        if (!isFull && Date.now() - (existing.cachedAt || 0) > 60000) existing.isFull = false;
    }

    if (metaData) {
        if (isFull) existing.info = {};
        if (metaData.name && typeof metaData.name === 'string') {
            existing.name = metaData.name;
        }
        if (Array.isArray(metaData.numbers) && metaData.numbers.length > 0) existing.numbers = metaData.numbers;
        if (metaData.raritiesByNo && Object.keys(metaData.raritiesByNo).length > 0) existing.raritiesByNo = metaData.raritiesByNo;

        // 백엔드의 단일 통합 맵 규격(info)을 단 1줄로 깔끔하고 안전하게 누적 병합
        if (metaData.info && typeof metaData.info === 'object') {
            Object.assign(existing.info, metaData.info);
        }
        if (metaData.rawSlot && typeof metaData.rawSlot === 'object') {
            Object.assign(existing.info, metaData.rawSlot);
        }

        // 대표 카드 이름(name) 보완
        if (!existing.name && existing.info) {
            const firstLang = existing.info['0'] || existing.info['ko'] || existing.info[0];
            if (Array.isArray(firstLang) && typeof firstLang[0] === 'string') {
                existing.name = firstLang[0];
            }
        }

        if (isFull) {
            existing.isFull = true;
        }
    }

    existing.cachedAt = Date.now();
    const names = Object.entries(existing.info || {}).filter(([key, value]) =>
        Number(key) >= 0 && Number(key) < 10 && Array.isArray(value) && value[0]).map(([, value]) => value[0]);
    const numbers = Object.entries(existing.info || {}).filter(([key, value]) =>
        Number(key) >= 0 && Number(key) < 10 && Array.isArray(value)).flatMap(([, value]) => Object.keys(value[2] || {}));
    ClientCache.registerCid(cidStr, names, numbers);
    cidMetaMemoryCache.set(cidStr, existing);
    return existing;
}

/**
 * 단일 카드 상세 메타 캐시 조회 (isFull 미달 시 langOnly 증분 요청 연동)
 */
async function fetchCardMetaWithCache(cid, cardName = '', cardNo = '') {
    const cidStr = cid ? String(cid) : '';

    if (cidStr && cidMetaMemoryCache.has(cidStr)) {
        const cached = cidMetaMemoryCache.get(cidStr);
        if (cached && Date.now() - (cached.cachedAt || 0) > 60000) {
            cidMetaMemoryCache.delete(cidStr);
            return fetchCardMetaWithCache(cid, cardName, cardNo);
        }
        if (cached && cached.isFull) {
            return cached;
        }
        
        // 메모리에 스탯(rawSlot 10번 이상) 데이터가 이미 존재하는 경우에만 langOnly=true (일부 조회)
        const hasStatsInCache = cached && cached.info && (cached.info[10] !== undefined || cached.info["10"] !== undefined);
        if (hasStatsInCache) {
            const langRes = await callApi('getCardMetadata', { cid: cidStr, name: cardName || '', cardNo: cardNo || '', langOnly: true });
            if (langRes && !langRes.isError && langRes.cid) {
                return mergeCardMetaToCache(langRes.cid, { ...langRes, info: { ...cached.info, ...langRes.info } }, true);
            }
            return cached;
        }
    }

    // 평상시 (캐시가 없거나 스탯이 없는 경우) ➔ 전체 조회 진행 (langOnly: false)
    const metaData = await callApi('getCardMetadata', { cid: cidStr, name: cardName || '', cardNo: cardNo || '' });
    if (metaData && !metaData.isError && metaData.cid) {
        return mergeCardMetaToCache(metaData.cid, metaData, true);
    }
    return metaData;
}

/**
 * 포괄 검색 CID 묶음 배치(Batch) 메타데이터 요청
 */
async function fetchCardsMetaBatch(cids = [], { force = false } = {}) {
    if (!Array.isArray(cids) || cids.length === 0) return {};

    const cidStrs = [...new Set(cids.map(c => String(c)).filter(Boolean))];
    const refreshed = new Set();
    const needed = cidStrs.filter(cid => {
        if (force || !cidMetaMemoryCache.has(cid)) return true;
        const cached = cidMetaMemoryCache.get(cid);
        if (Date.now() - (cached?.cachedAt || 0) > 60000) return true;
        const raw = cached ? (cached.rawSlot || cached.info) : null;
        return !raw || (Array.isArray(raw) ? raw.length <= 10 : Object.keys(raw).length === 0);
    });

    for (let offset = 0; offset < needed.length; offset += 100) {
        try {
            const res = await callApi('getCardsMetaBatch', {}, { cids: needed.slice(offset, offset + 100) });
            if (res && res.success && res.results) {
                Object.keys(res.results).forEach(cid => {
                    mergeCardMetaToCache(cid, { rawSlot: res.results[cid] }, false);
                    refreshed.add(String(cid));
                });
            }
        } catch (e) {
            // 한 묶음의 실패가 뒤에 있는 후보의 조회까지 중단하지 않도록 한다.
            console.warn("fetchCardsMetaBatch error:", e);
        }
    }

    const resultMap = {};
    cidStrs.forEach(cid => {
        if (cidMetaMemoryCache.has(cid) && (!force || refreshed.has(cid))) {
            resultMap[cid] = cidMetaMemoryCache.get(cid);
        }
    });
    return resultMap;
}

/**
 * 입력폼 수량/행 카운트 전역 스토어
 */
const FormRowStore = {
    addCount: 1,
    moveCount: 1,
    discardCount: 1
};

let syncCounter = 0;


/* --- AD Units Refresh Logic --- */

let adLastRefreshTime = {}; // { slotId: timestamp }
const AD_REFRESH_INTERVAL = 45000; // 정책 준수를 위해 안전하게 45초 간격 유지

/**
 * 특정 광고 슬롯을 갱신합니다. (디자인 보호를 위해 페이드 전환 적용)
 * @param {string} slotId 광고 컨테이너 ID
 */
function refreshAdUnit(slotId) {
    if (globalThis.AppBackend && !globalThis.AppBackend.capabilities.advertising) return;
    const container = document.getElementById(slotId);
    if (!container || !container.offsetParent) return; // 미노출 상태면 무시

    const now = Date.now();
    if (adLastRefreshTime[slotId] && (now - adLastRefreshTime[slotId] < AD_REFRESH_INTERVAL)) {
        return;
    }

    container.classList.add('is-refreshing');

    setTimeout(() => {
        // [주의] 실제 광고 코드가 삽입되는 지점입니다. 
        // 광고주와의 계약 및 정책에 따라 수동 갱신 방식을 결정해야 합니다.
        // container.innerHTML = '<ins class="adsbygoogle" ...></ins>';

        try {
            if (window.adsbygoogle) {
                (adsbygoogle = window.adsbygoogle || []).push({});
            }
        } catch (e) { }

        container.classList.remove('is-refreshing');
        adLastRefreshTime[slotId] = now;
    }, 400);
}

/**
 * 현재 활성화된 모드에 맞는 광고들을 갱신합니다.
 */
function refreshPageAds(mode) {
    // 사이드바는 항상 갱신 대상 (시간 체크 통과 시)
    refreshAdUnit('sidebar-ad-container');

    // 모바일 앵커 (모바일 환경 확인 후)
    if (document.documentElement.classList.contains('is-mobile-device')) {
        refreshAdUnit('mobile-anchor-ad');
    }

    // 인페이지 가로형 배너들
    if (mode === 'add') refreshAdUnit('add-page-ad');
    else if (mode === 'move') refreshAdUnit('move-page-ad');
    else if (mode === 'discard') refreshAdUnit('discard-page-ad');
    else if (mode === 'search') refreshAdUnit('search-result-ad');
}

function updateLocalInventory(updates) {
    if (globalThis.AppBackend) return globalThis.AppBackend.refreshInventory();
    if (!updates || !Array.isArray(updates)) return;
    cardCacheInstance.updateInventory(updates);
    refreshLocalLookups();
}

function refreshLocalLookups() {
    // [Phase 2] 데이터 계산은 이제 cardCacheInstance.refreshIndexes()에서 자동 수행됨
    // 여기서는 UI 갱신 로직만 담당합니다.

    const datalist = document.getElementById('loc-datalist');
    if (datalist) datalist.innerHTML = cardCacheInstance.getAllLocations().map(l => `<option value="${escapeHTML(l)}">`).join('');

    const autoLocWrap = document.getElementById('wrap-auto-loc');
    const autoLocInput = document.getElementById('auto-location-input');
    if (autoLocWrap && autoLocInput) {
        autoLocWrap.dataset.options = JSON.stringify(cardCacheInstance.getAllLocations().map(l => ({ val: l, text: l })));
        setupDropdownForField(autoLocInput, autoLocWrap);
    }

    // [데스크톱 카드 뷰 대응] 모든 데스크톱 카드를 돌며 보관 위치(loc) 및 이동 위치(to) 드롭다운 갱신
    const allDesktopCards = document.querySelectorAll('.desktop-info-card[data-index]');
    allDesktopCards.forEach(card => {
        const locInp = card.querySelector('[data-field="loc"]');
        const locWrap = locInp ? locInp.closest('.custom-select-wrapper') : null;
        if (locWrap) {
            locWrap.dataset.options = JSON.stringify(cardCacheInstance.getAllLocations().map(l => ({ val: l, text: l })));
            if (cardCacheInstance.getAllLocations().length > 0) locWrap.classList.remove('no-option');
            setupDropdownForField(locInp, locWrap);
        }
        const toInp = card.querySelector('[data-field="to"]');
        const toWrap = toInp ? toInp.closest('.custom-select-wrapper') : null;
        if (toWrap) {
            toWrap.dataset.options = JSON.stringify(cardCacheInstance.getAllLocations().map(l => ({ val: l, text: l })));
            if (cardCacheInstance.getAllLocations().length > 0) toWrap.classList.remove('no-option');
            setupDropdownForField(toInp, toWrap);
        }
    });


}

function getLocalizedRarity(key) {
    var idx = rarityReverseMap[key];
    if (idx === undefined) {
        return key;
    }

    var row = rarityRows[idx];
    if (!row) return key;

    var colIdx = rarityColMap[UIStore.currentRegion];
    if (colIdx === undefined) return key;

    var val = row[colIdx];
    if (!val || val === "") return key;

    return val;
}

function compareRarity(a, b) {
    const idxA = (rarityReverseMap[a] !== undefined) ? rarityReverseMap[a] : 9999;
    const idxB = (rarityReverseMap[b] !== undefined) ? rarityReverseMap[b] : 9999;
    return idxA - idxB;
}

function handleHashChange(skipAutomation = false) {
    skipAutomation = skipAutomation === true;
    if (isInternalHashChange) return;
    // URL 해석은 방문 기록을 다시 만들지 않습니다. 캐시 초기화가 즉시 끝나도
    // switchToMode의 비동기 해시 잠금 때문에 실제 검색이 생략되지 않게 합니다.
    isInternalHashChange = true;
    try {
        const hash = window.location.hash.substring(1);

        // 모달 호출 해시인 경우, 모드 전환을 생략하고 모달만 띄우고 종료
        if (hash === 'terms' || hash === 'privacy') {
            checkUrlHashForModals();
            // 애니메이션 차단 해제
            requestAnimationFrame(() => {
                document.body.classList.remove('no-transition');
            });
            return;
        }

        // 일반 모드 진입 시, 모달이 열려 있다면 닫아주기
        const termsModal = document.getElementById('terms-modal');
        if (termsModal) {
            const inst = M.Modal.getInstance(termsModal);
            if (inst) inst.close();
        }
        const privacyModal = document.getElementById('privacy-modal');
        if (privacyModal) {
            const inst = M.Modal.getInstance(privacyModal);
            if (inst) inst.close();
        }

        if (typeof SearchNavigation !== 'undefined' && SearchNavigation.handleHashChange(skipAutomation)) return;
        // 새 주소 해석은 즉시 표시하고, 저장된 검색 방문 간 전환은 위 모듈에 맡깁니다.
        document.body.classList.add('no-transition');

        if (!hash) {
            switchToMode('home', true);
            // 애니메이션 차단 해제
            requestAnimationFrame(() => {
                document.body.classList.remove('no-transition');
            });
            return;
        }

        if (hash.startsWith('search')) {
            const qIdx = hash.indexOf('?');
            if (qIdx !== -1) {
                const urlParams = new URLSearchParams(hash.substring(qIdx + 1));
                const cid = urlParams.get('cid');
                const code = urlParams.get('code');
                const m = urlParams.get('m');
                const key = urlParams.get('key');
                const q = urlParams.get('q');
                const targetName = urlParams.get('target');

                if (cid) {
                    if (!skipAutomation) void renderTargetByCid(cid, code, true);
                    else switchToMode('search', true);
                } else if (code || targetName) {
                    const inputEl = document.getElementById('card-search');
                    if (inputEl) inputEl.value = code || targetName;
                    switchToMode('search', true);
                    if (!skipAutomation) void startSearch(true, code ? 'number' : 'name', true);
                } else if (key !== null || q !== null) {
                    const searchKey = key !== null ? key : q;
                    let searchType = 'auto';
                    if (m === '1') searchType = 'name';
                    else if (m === '2') searchType = 'number';

                    const inputEl = document.getElementById('card-search');
                    if (inputEl) inputEl.value = searchKey;
                    checkClearBtn();
                    switchToMode('search', true);
                    if (!skipAutomation) {
                        startSearch(true, searchType);
                    }
                } else {
                    switchToMode('search', true);
                }
            } else {
                switchToMode('search', true);
            }
        } else {
            const [mainMode, subMode] = hash.split('?')[0].split('/');
            const isLegacyManagePath = mainMode === 'manage';
            const targetMode = isLegacyManagePath ? (subMode || 'add') : mainMode;
            const validModes = isLegacyManagePath
                ? ['add', 'move', 'discard']
                : ['home', 'inventory', 'add', 'move', 'discard', 'settings'];
            if (validModes.includes(targetMode)) {
                if (targetMode === 'add' && hash !== 'add') {
                    window.history.replaceState(window.history.state, '', '#add');
                }
                switchToMode(targetMode, true, targetMode === 'inventory' ? subMode : null);
            } else {
                switchToMode('home', true);
            }
        }

        // 애니메이션 차단 해제 (레이아웃 반영 후)
        requestAnimationFrame(() => {
            document.body.classList.remove('no-transition');
        });
    } finally {
        isInternalHashChange = false;
    }
}

/**
 * 온보딩 감지 및 실행 로직
 * 구 버전 웹페이지(GitHub Pages)에서 리다이렉트된 사용자를 위한 초기 안내를 수행합니다.
 */
function startOnboarding() {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('from') === 'legacy') {
        // 리다이렉션 상태 저장 (로그인 완료 후 자동 모달 노출용)
        sessionStorage.setItem('ygo_redirect_legacy', 'true');
    }
}

function checkLegacyMigrationQuery() {
    // 쿼리 스트링 대신 sessionStorage 상태값을 기준으로 유입 검사
    if (sessionStorage.getItem('ygo_redirect_legacy') === 'true') {
        const modal = document.getElementById('legacy-migration-modal');
        if (modal) {
            const inst = getAppModal(modal);
            
            if (inst) {
                setTimeout(() => inst.open(), 200);
            }
        }
    }
}

/**
 * 애플리케이션 통합 초기화 함수
 */
async function initApp() {
    if (document.documentElement?.dataset?.backend === 'supabase' && !globalThis.AppBackend) {
        showLoading(false);
        showToast('데이터 연결 모듈을 불러오지 못했습니다. 새로고침해 주세요.', 'toast-error');
        return;
    }
    if (window.YgoDiscordPopup?.isCallback) return;
    window.YgoLoginTiming?.mark('ui_init_start');
    initFirebaseAuth();
    if (globalThis.AppBackend?.discordReturnSession) handleDiscordOAuthCallback();
    let uiPrepared = false;
    try {
    const footerVer = document.getElementById('footer-version');
    if (footerVer) footerVer.textContent = CLIENT_VERSION;

    // 로컬 DB 초기화
    const prepareCache = () => ClientCache.init();
    await (window.YgoLoginTiming?.startupMeasure ? window.YgoLoginTiming.startupMeasure('cache', prepareCache) : prepareCache());

    // DB 복원 후 인스턴스에 안전하게 이름 목록 주입
    if (CardDataStore.allCardNames.length > 0 && cardCacheInstance) {
        cardCacheInstance.setAllKnownNames(CardDataStore.allCardNames);
    }

    loadTheme();
    loadRegion();
    checkClearBtn();
    initPageAdd();

    // 서브 모듈 리스너 및 기능 초기화 일괄 실행
    fetchNotices();

    if (!globalThis.AppBackend?.discordReturnSession) handleDiscordOAuthCallback();
    document.getElementById('manage-common-footer')?.addEventListener('click', event => {
        if (event.target.tagName === 'BUTTON') event.target.blur();
    });
    if (typeof initMobileSearchListeners === 'function') initMobileSearchListeners();
    if (typeof initOverlaySearchListeners === 'function') initOverlaySearchListeners();
    if (document.documentElement.classList.contains('is-mobile-device')) {
        renderMobileCards();
    } else {
        renderDesktopCards();
    }

    // 구 버전에서 유입된 사용자 온보딩 처리
    startOnboarding();

    // [중요] 동기화 시작 전에 URL 해시를 먼저 분석하여 UI를 즉시 설정하되, 자동 검색은 로컬 캐시 로드 후로 미룸 (skipAutomation=true)
    handleHashChange(true);

    document.querySelectorAll('.modal').forEach(getAppModal);

    checkLegacyMigrationQuery();

    M.Tooltip.init(document.querySelectorAll('.tooltipped'));

    const searchInput = document.getElementById('card-search');
    if (searchInput && !searchInput._isInputBound) {
        searchInput._isInputBound = true;
        let isSearchComposing = false;
        let searchEditPending = false;
        const handleFocusOrClick = () => {
            if (searchEditPending) return;
            const val = searchInput.value.trim();
            if (isSearchComposing && !val) return;
            if (!val) { showRecentInDropdown(); } else { filterAndShowDropdown(searchInput.value); }
        };
        searchInput.addEventListener('click', handleFocusOrClick);
        searchInput.addEventListener('focus', handleFocusOrClick);
        const debouncedFilter = debounce((val) => {
            searchEditPending = false;
            if (document.activeElement !== searchInput || searchInput.value !== val) return;
            if (isSearchComposing && !val.trim()) return;
            filterAndShowDropdown(val);
        }, 100);

        searchInput.addEventListener('compositionstart', () => {
            isSearchComposing = true;
            searchEditPending = true;
            debouncedFilter.cancel();
        });
        searchInput.addEventListener('compositionend', () => {
            isSearchComposing = false;
            if (document.activeElement === searchInput) debouncedFilter(searchInput.value);
        });

        searchInput.addEventListener('input', (e) => {
            const val = e.target.value;
            debouncedFilter.cancel();
            checkClearBtn();
            if (globalThis.AppBackend) {
                if (val.trim() || isSearchComposing || e.isComposing) {
                    updatePendingCatalogDropdown(val);
                } else {
                    searchEditPending = false;
                    showRecentInDropdown();
                    return;
                }
            }
            if (!val.trim() && (isSearchComposing || e.isComposing)) {
                // 한글 조합 도중의 일시적인 빈 값으로 최근 검색을 표시하지 않습니다.
                return;
            }
            searchEditPending = true;
            debouncedFilter(val);
        });

        const dropdown = document.getElementById('custom-dropdown');
        if (dropdown) {
            // 클릭 완료 전 blur로 목록이 닫히거나 화면이 바뀌지 않도록 포커스만 유지합니다.
            dropdown.addEventListener('mousedown', (e) => {
                e.preventDefault();
            });
            dropdown.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                const target = e.target;
                if (target.closest('.clear-all-btn')) {
                    localStorage.removeItem(RECENT_KEY);
                    showRecentInDropdown();
                    return;
                }
                if (target.classList.contains('item-delete-btn') || target.closest('.item-delete-btn')) {
                    const delBtn = target.classList.contains('item-delete-btn') ? target : target.closest('.item-delete-btn');
                    if (delBtn && delBtn.closest('li')) {
                        const li = delBtn.closest('li');
                        if (li && li.dataset.val) deleteRecentItem(li.dataset.val, li.dataset.type);
                    }
                    return;
                }
                const li = target.closest('li');
                if (li && !li.classList.contains('recent-header-item') && !li.classList.contains('no-result-item')) {
                    const val = li.dataset.val;
                    const searchType = li.dataset.type || 'auto';
                    const isTarget = li.dataset.isTarget === 'true';
                    if (val) {
                        document.getElementById('card-search').value = val;
                        checkClearBtn();
                        startSearch(false, searchType, isTarget);
                    }
                }
            });
        }

        searchInput.addEventListener('keydown', function (e) {
            if (e.isComposing) return;
            const list = document.getElementById('custom-dropdown');
            const listOpen = !list.hidden && list.classList.contains('active');
            if (!listOpen && e.key !== 'Enter') return;
            const items = list.querySelectorAll('li:not(.recent-header-item):not(.no-result-item)');
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                UIStore.dropdownFocus++;
                if (UIStore.dropdownFocus >= items.length) UIStore.dropdownFocus = 0;
                updateHighlight(items, UIStore.dropdownFocus);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                UIStore.dropdownFocus--;
                if (UIStore.dropdownFocus < 0) UIStore.dropdownFocus = items.length - 1;
                updateHighlight(items, UIStore.dropdownFocus);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                const selectedItem = listOpen ? items[UIStore.dropdownFocus] : null;
                if (selectedItem?.dataset.val) {
                    this.value = selectedItem.dataset.val;
                    checkClearBtn();
                    startSearch(false, selectedItem.dataset.type || 'auto', selectedItem.dataset.isTarget === 'true');
                } else {
                    this.blur();
                    startSearch(false, 'auto', false);
                }
            }
        });

        searchInput.addEventListener('blur', () => {
            if (debouncedFilter.cancel) debouncedFilter.cancel();
            searchEditPending = false;
            if (globalThis.AppBackend) clearCatalogDropdownCandidates(dropdown);
            setTimeout(() => {
                if (document.activeElement === searchInput) return;
                toggleSearchWrapper(false);
            }, 75);
        });
    }

    document.getElementById('clear-btn').addEventListener('click', function () {
        searchInput.value = '';
        this.hidden = true;
        searchInput.focus();
        window.PhotoCardSearch?.refreshSearchControls?.();
        showRecentInDropdown();
    });

    document.addEventListener('click', function (e) {
        // 지역 설정 드롭다운 외부 클릭 감지 (새로운 구조 대응)
        if (!e.target.closest('.region-container')) closeDropdowns();
    });

    document.addEventListener('scroll', function (e) {
        if (e.target.classList && e.target.classList.contains('custom-options')) return;
        if (UIStore.activeDropdownInput) {
            // 검색바와 보관 위치 자동 입력의 중첩 목록은 CSS로 배치한다.
            const { id } = UIStore.activeDropdownInput;
            if (id === 'card-search' || id === 'auto-location-input') return;

            const wrapper = UIStore.activeDropdownInput.closest('.custom-select-wrapper') || UIStore.activeDropdownInput.closest('.search-input-wrapper');
            if (wrapper) {
                const globalDropdown = wrapper._dropdown || document.getElementById('custom-dropdown');
                if (globalDropdown && globalDropdown.classList.contains('active')) {
                    if (globalDropdown.classList.contains('desktop-card-dropdown')) {
                        positionDropdown(globalDropdown, wrapper);
                        return;
                    }
                    const rect = wrapper.getBoundingClientRect();

                    const scrollTop = window.pageYOffset || document.documentElement.scrollTop || document.body.scrollTop || 0;
                    const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft || document.body.scrollLeft || 0;

                    globalDropdown.style.top = (rect.bottom + scrollTop) + 'px';
                    globalDropdown.style.left = (rect.left + scrollLeft) + 'px';
                    globalDropdown.style.width = rect.width + 'px';
                }
            }
        }
    }, true);

    window.addEventListener('resize', () => {
        const wrapper = UIStore.activeDropdownInput?.closest('[data-card-field]');
        const dropdown = wrapper?._dropdown;
        if (dropdown?.dataset.cardSearchField && dropdown.classList.contains('active')) {
            positionDropdown(dropdown, wrapper);
        }
    });

    // 초기 로드 시 트랜지션 차단 (이미 index.html에서 추가되었을 수 있음)
    document.body.classList.remove('no-transition');
    document.body.classList.add('no-transition');

    // 로그인 화면 적용에는 로컬 캐시/정적 UI만 요구한다. 공용 카드 동기화를 추가 장벽으로 만들지 않는다.
    uiPrepared = true;
    window.YgoAuthBootstrap?.uiPrepared();
    resolveServiceUi();
    // 공용 데이터 동기화·자동 검색은 기존 준비 순서를 유지한다.
    await refreshInitialData();

    // 동기화 완료 후 자동화 로직만 별도로 추출하여 트리거 (캐시된 데이터 활용 보장)
    const currentHash = window.location.hash.substring(1);
    if (currentHash.startsWith('search')) {
        if (!lastSearchState) handleHashChange(false);
    }

    const autoLocWrap = document.getElementById('wrap-auto-loc');
    if (autoLocWrap) {
        setupCustomDropdown(autoLocWrap, null);
    }

    window.addEventListener('hashchange', handleHashChange);

    // 모든 초기화 완료 후 트랜지션 차단 해제 및 FODC 방지 클래스 제거
    requestAnimationFrame(() => {
        document.body.classList.remove('no-transition');
    });

    // 단축키(Ctrl+Enter / Cmd+Enter)를 통한 작업 실행 기능 추가
    document.addEventListener('keydown', function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            if (modalStates.size) return;
            const activeEl = document.activeElement;
            // 포커스가 input이나 textarea 등에 있을 때만 동작
            if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable)) {
                if (UIStore.mode === 'add') {
                    e.preventDefault();
                    if (typeof submitPageEntries === 'function') submitPageEntries();
                } else if (UIStore.mode === 'move') {
                    e.preventDefault();
                    if (typeof submitMoveEntries === 'function') submitMoveEntries();
                } else if (UIStore.mode === 'discard') {
                    e.preventDefault();
                    if (typeof submitDiscardEntries === 'function') submitDiscardEntries();
                }
            }
        }
    });
    } finally {
        if (!uiPrepared) {
            window.YgoAuthBootstrap?.uiFailed();
            rejectServiceUi(new Error('화면 준비 실패'));
        }
    }
}

// 애플리케이션 단일 초기화 이벤트 바인딩
document.addEventListener('DOMContentLoaded', initApp);

// 인증 대상 여부와 실제 헤더 공간을 함께 반영한다. 숨긴 버튼도 매번 다시 측정하여
// 창 크기·지역 문구·글꼴 크기가 바뀌면 버튼 표시를 복원할 수 있다.
function syncMembershipHeader(shouldShowVerify = null) {
    const verifyBtn = document.getElementById('membership-verify-btn');
    const authBtn = document.getElementById('auth-capsule-btn');
    if (!verifyBtn || !authBtn) return;
    if (shouldShowVerify !== null) verifyBtn.dataset.membershipEligible = String(shouldShowVerify);
    const hadVerifyFocus = document.activeElement === verifyBtn;
    const eligible = verifyBtn.dataset.membershipEligible === 'true';
    const mobile = document.documentElement.classList.contains('is-mobile-device');
    verifyBtn.hidden = !eligible;
    let overflow = false;
    const header = document.querySelector('.app-header');
    if (eligible && mobile && header) {
        const style = getComputedStyle(header);
        const number = value => parseFloat(value) || 0;
        const available = header.getBoundingClientRect().width
            - number(style.paddingLeft) - number(style.paddingRight)
            - number(style.borderLeftWidth) - number(style.borderRightWidth);
        const controls = [...header.children].filter(element => !element.hidden && element.getBoundingClientRect().width > 0);
        const required = controls.reduce((total, element) => {
            const controlStyle = getComputedStyle(element);
            // 테마 그룹의 자동 왼쪽 여백은 남는 공간이므로 필수 너비에서 제외한다.
            const leftMargin = element.classList?.contains('theme-switch-wrapper')
                ? 0 : number(controlStyle.marginLeft);
            return total + element.getBoundingClientRect().width
                + leftMargin + number(controlStyle.marginRight);
        }, 0) + Math.max(0, controls.length - 1) * number(style.columnGap);
        // 기본 gap 외에 16px의 여유가 없으면 혼잡해지기 전에 점으로 대체한다.
        overflow = available > 0 && available - required < 16;
        verifyBtn.hidden = overflow;
    }
    authBtn.classList.toggle('has-noti', eligible && mobile && overflow);
    if (authBtn.classList.contains('is-logged-in')) {
        authBtn.setAttribute('aria-label', overflow
            ? '내 계정: 멤버십 인증 필요, 환경설정으로 이동'
            : '내 계정: 환경설정으로 이동');
    }
    if (typeof renderDiscordMembershipHeader === 'function') renderDiscordMembershipHeader();
    // 크기 변경으로 현재 조작 중인 버튼이 숨겨지면 계정 진입으로 초점을 보존한다.
    if (verifyBtn.hidden && hadVerifyFocus) authBtn.focus();
}

// 펼쳐지는 배경이 아닌 닫힌 컨트롤만 관찰한다. 페이지 전환 높이와는 무관하다.
function initFluidControlSizing() {
    syncMembershipHeader();
    window.addEventListener('resize', () => syncMembershipHeader());
    if (document.fonts) document.fonts.ready.then(() => syncMembershipHeader());
    if (typeof ResizeObserver === 'undefined') return;
    const header = document.querySelector('.app-header');
    const searchBox = document.querySelector('.search-box');
    const observer = new ResizeObserver(entries => {
        for (const { target } of entries) {
            const height = target.getBoundingClientRect().height;
            if (!height) continue;
            if (target === header) {
                const minimum = parseFloat(getComputedStyle(header).minHeight) || 46;
                document.documentElement.style.setProperty('--app-header-growth', `${Math.max(0, height - minimum)}px`);
            } else if (target === searchBox) {
                document.documentElement.style.setProperty('--search-controls-height', `${height}px`);
            } else if (target.id === 'region-wrapper' || target.id === 'search-wrapper') {
                target.style.setProperty('--measured-capsule-height', `${height}px`);
            }
        }
        syncMembershipHeader();
    });
    for (const element of [header, searchBox, document.getElementById('region-wrapper'), document.getElementById('search-wrapper')]) {
        if (element) observer.observe(element);
    }
    if (header) [...header.children].forEach(element => observer.observe(element));
}
document.addEventListener('DOMContentLoaded', initFluidControlSizing);



function updateActiveNav(mode) {
    document.querySelectorAll('.app-navi-item').forEach(el => {
        el.classList.remove('active');
        el.removeAttribute('aria-current');
    });
    const searchNavItem = document.querySelector('.app-navi-item--mobile[data-mode="search"]');
    if (searchNavItem) searchNavItem.setAttribute('aria-expanded', 'false');
    let searchMode = mode;
    if (['add', 'move', 'discard'].includes(mode)) searchMode = 'manage';
    const targets = document.querySelectorAll(`[data-mode="${searchMode}"]`);
    targets.forEach(el => {
        el.classList.add('active');
        el.setAttribute('aria-current', 'page');
    });
}

function updateMetaThemeColor(mode) {
    const meta = document.getElementById('meta-theme-color');
    if (meta) {
        if (mode === 'light') { meta.setAttribute('content', '#f0f0f0'); } else { meta.setAttribute('content', '#1e1e1e'); }
    }
}

// 모달과 관리 시트의 배경 차단과 초점 복귀는 이 수명주기에서만 관리한다.
// 닫힘 애니메이션이 끝나기 전까지는 해당 모달도 배경 잠금을 소유한다.
const modalStates = new Map();
const modalAfterOpen = new WeakMap();
let modalBackgroundSnapshot = null;
let modalReturnFocus = null;

function getModalBackgroundTargets() {
    return [...document.querySelectorAll('#app-search-masthead, .app-header, .app-sidebar, .app-mobile-dock, .app-page-content, #main-footer, #mobile-search-overlay')];
}

function syncModalLayers() {
    const top = [...modalStates].reverse().find(([, state]) => !state.closing)?.[0];
    // 모달·사진 분석·일러스트 선택과 미이관 입력창이 같은 겹침 순서에 참여한다.
    let layer = 100000;
    for (const [modal, state] of modalStates) {
        if (state.backdrop && !modal.contains(state.backdrop)) state.backdrop.style.zIndex = String(layer);
        modal.style.zIndex = String(layer + 1);
        layer += 2;
        modal.inert = modal !== top;
        if (modal === top) modal.setAttribute('aria-modal', 'true');
        else modal.removeAttribute('aria-modal');
    }
    document.documentElement.classList.toggle('modal-open',
        modalStates.size > 0 && document.documentElement.classList.contains('is-mobile-device'));
    document.documentElement.classList.toggle('overlay-scroll-locked', modalStates.size > 0);
}

function beginModalLifecycle(modal, trigger, backdrop = null) {
    const opener = trigger || document.activeElement;
    if (!modalStates.size) {
        modalReturnFocus = opener;
        modalBackgroundSnapshot = getModalBackgroundTargets().map(element => ({
            element, inert: element.hasAttribute('inert')
        }));
    }
    const state = modalStates.get(modal) || { opener };
    state.backdrop = backdrop;
    state.closing = false;
    // 닫히는 중 다시 연 창도 가장 위의 창으로 취급한다.
    modalStates.delete(modal);
    modalStates.set(modal, state);
    for (const { element } of modalBackgroundSnapshot) element.inert = true;
    syncModalLayers();
}

function beginModalClose(modal) {
    const state = modalStates.get(modal);
    if (!state) return;
    state.closing = true;
    modalAfterOpen.delete(modal);
    syncModalLayers();
}

function focusModalReturnTarget(target) {
    if (!target || !target.isConnected || target === document.body || target === document.documentElement
        || target.disabled || target.classList.contains('disabled')
        || target.closest('[inert], [hidden], [aria-hidden="true"]') || !target.getClientRects().length) return false;
    target.focus({ preventScroll: true });
    return document.activeElement === target;
}

function finishModalLifecycle(modal) {
    const state = modalStates.get(modal);
    // 중복 종료와 닫힘 도중 재열림의 이전 종료 처리는 무시한다.
    if (!state || !state.closing) return false;
    const currentFocus = document.activeElement;
    const canRestoreFocus = modal.contains(currentFocus) || currentFocus === document.body || currentFocus === document.documentElement;
    modalStates.delete(modal);
    modal.inert = true;
    modal.removeAttribute('aria-modal');
    syncModalLayers();

    if (!modalStates.size) {
        for (const { element, inert } of modalBackgroundSnapshot) element.inert = inert;
        const target = modalReturnFocus;
        modalBackgroundSnapshot = null;
        modalReturnFocus = null;
        if (canRestoreFocus && !focusModalReturnTarget(target)) {
            if (['add-result-modal', 'move-result-modal', 'discard-result-modal'].includes(modal.id)) {
                // 성공 행이 제거되어 원래 입력란이 사라졌다면 관리 실행 버튼으로 돌아간다.
                focusModalReturnTarget(document.getElementById('manage-primary-btn'));
            }
        }
    } else if (canRestoreFocus) {
        const top = [...modalStates].reverse().find(([, entry]) => !entry.closing)?.[0];
        if (top) focusModalReturnTarget(top.contains(state.opener) ? state.opener : top);
    }
    return true;
}

function getAppModal(modal) {
    if (!modal) return null;
    const existing = M.Modal.getInstance(modal);
    if (existing) {
        globalThis.AppOverlays?.installModal(existing);
        return existing;
    }
    modal.inert = true;
    const options = getCommonModalOptions();
    const instance = M.Modal.init(modal, options);
    globalThis.AppOverlays?.installModal(instance);
    return instance;
}

// 직접 만든 시트도 같은 수명주기를 사용한다. 애니메이션 예약만 이 어댑터에서 관리한다.
const sheetAnimationStates = new WeakMap();

function isManagedSheetOpen(sheet) {
    const state = modalStates.get(sheet);
    return !!state && !state.closing;
}

function resetSheetAnimation(sheet) {
    const previous = sheetAnimationStates.get(sheet);
    if (previous) {
        cancelAnimationFrame(previous.frame);
        clearTimeout(previous.timer);
    }
    const state = { frame: null, timer: null };
    sheetAnimationStates.set(sheet, state);
    return state;
}

function openManagedSheet(sheet, { backdrop = null, trigger = null, initialFocus = sheet, onOpen = null, onDismiss = null } = {}) {
    if (!sheet) return;
    const state = resetSheetAnimation(sheet);
    const previous = modalStates.get(sheet);
    if (trigger && previous?.closing) {
        if (modalReturnFocus === previous.opener) modalReturnFocus = trigger;
        previous.opener = trigger;
    }
    state.onDismiss = onDismiss;
    sheet.hidden = false;
    if (backdrop) backdrop.hidden = false;
    // active를 붙이기 전 닫힌 위치와 배경막의 초기 스타일을 계산한다.
    void sheet.offsetHeight;
    beginModalLifecycle(sheet, trigger, backdrop);
    state.frame = requestAnimationFrame(() => {
        if (sheetAnimationStates.get(sheet) !== state || !isManagedSheetOpen(sheet)) return;
        sheet.classList.add('active');
        if (backdrop) backdrop.classList.add('active');
        // 다른 창을 연 사이에 예약된 초점 이동이 끼어들지 않도록 한다.
        if (!sheet.inert) focusModalReturnTarget(initialFocus);
        if (onOpen) onOpen();
    });
}

function closeManagedSheet(sheet, { backdrop = null, duration = globalThis.AppOverlays?.duration() ?? 200, onClose = null } = {}) {
    if (!isManagedSheetOpen(sheet)) return;
    const state = resetSheetAnimation(sheet);
    beginModalClose(sheet);
    sheet.classList.remove('active');
    if (backdrop) backdrop.classList.remove('active');
    state.timer = setTimeout(() => {
        if (sheetAnimationStates.get(sheet) !== state) return;
        sheet.hidden = true;
        if (backdrop) backdrop.hidden = true;
        finishModalLifecycle(sheet);
        if (onClose) onClose();
    }, duration);
}

function handleManagedSheetKeydown(event) {
    const top = [...modalStates].reverse().find(([, state]) => !state.closing)?.[0];
    if (!top || (!sheetAnimationStates.has(top) && !top.classList.contains('ui-overlay'))) return;
    // 일러스트 선택기의 방향키·초점 순환·history 처리는 기존 선택기가 소유한다.
    if (document.querySelector('.illustration-picker-root')) return;
    if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (top.classList.contains('modal') && M.Modal.getInstance(top)?.options?.dismissible === false) return;
        const close = top.classList.contains('modal') ? () => M.Modal.getInstance(top)?.close() : sheetAnimationStates.get(top)?.onDismiss || {
            'mobile-entry-bottom-sheet': closeEntryBottomSheet,
            'mobile-sheet-input-overlay': closeSheetOverlay,
            'mobile-sheet-qty-overlay': closeQtyOverlay,
            'mobile-sheet-dropdown-select': closeSheetDropdownSelect,
            'catalog-filter-editor': typeof closeCatalogFilterEditor === 'function' ? closeCatalogFilterEditor : null
        }[top.id];
        if (close) close();
        return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
    }
    const target = event.target;
    if (top.contains(target) && (event.key === 'Enter' || event.key === ' ')) {
        const field = target.closest('input[data-field]');
        const action = field?.closest('.sheet-input-box') || target.closest('[role="button"]');
        if (action) {
            event.preventDefault();
            event.stopImmediatePropagation();
            action.click();
            return;
        }
    }
    if (event.key !== 'Tab') return;
    const focusable = [...top.querySelectorAll('button, input, select, textarea, a[href], [tabindex]')]
        .filter(el => el.tabIndex >= 0 && !el.disabled && !el.classList.contains('disabled')
            && !el.closest('[inert], [hidden], [aria-hidden="true"]') && el.getClientRects().length);
    const index = focusable.indexOf(document.activeElement);
    if (!focusable.length || index < 0 || (event.shiftKey ? index === 0 : index === focusable.length - 1)) {
        event.preventDefault();
        focusModalReturnTarget((event.shiftKey ? focusable.at(-1) : focusable[0]) || top);
    }
}
document.addEventListener('keydown', handleManagedSheetKeydown, true);

let transitionTimer = null;
let pageTransitionFrame = null;
let pageTransitionRevision = 0;
let isInternalHashChange = false;

// 표시 애니메이션과 조작 가능 여부를 함께 갱신합니다. 상위 모달의 inert는 건드리지 않습니다.
function setViewActive(element, active, activeClass = 'active', inactiveClass = null) {
    if (!element) return;
    if (!active && element.contains(document.activeElement)) document.activeElement.blur();
    element.inert = !active;
    element.classList.toggle(activeClass, active);
    if (inactiveClass) element.classList.toggle(inactiveClass, !active);
}

function setModePanelActive(element, active) {
    setViewActive(element, active, 'anim-active', 'anim-hidden');
}

function setActivePage(page) {
    document.querySelectorAll('#app-page-stack > .content-section').forEach(section => {
        setViewActive(section, section === page);
    });
}

/* ==========================================================================
   보유 현황 목록 (Inventory Grid) 엔진
   ========================================================================== */

/**
 * 인벤토리 그리드의 전역 상태 관리 객체
 */
let inventoryGridState = {
    allData: [],        // 필터링/정렬 전 전체 데이터
    filteredData: [],   // 필터링/정렬 후 현재 데이터셋
    displayLimit: 50,   // 현재 표시 중인 행 수
    sort: {
        colIndex: 1,    // 기본 정렬: 카드 번호
        dir: 'asc'      // 'asc' | 'desc'
    },
    filters: {},        // { colIndex: Set(선택된값들) } 또는 { colIndex: "검색어" }
    isRendering: false,
    lastSyncTime: 0     // 마지막으로 서버와 동기화한 시간
};

/**
 * [목록 진입점] 인벤토리 그리드 렌더링 상태 결정
 * @param {boolean} forceSync 강제 동기화 여부
 */
async function renderInventoryGrid(forceSync = false) {
    const container = document.getElementById('inventory-grid-container');
    if (!container) return;

    // 새로고침 시 인증 세션 복원 완료까지 대기
    if (!window.isAuthInitialized) {
        await waitForAuthInit();
    }

    if (!UserStore.user) {
        renderInventoryLoginRequiredState();
        return;
    }

    if (UserStore.inventorySyncStatus === 'loading' || UserStore.inventorySyncStatus === 'error') {
        const area = document.getElementById('grid-status-area');
        if (area) {
            area.textContent = UserStore.inventorySyncStatus === 'error' ? '보유 정보 동기화에 실패했습니다. 위의 다시 시도를 눌러주세요.' : '보유 정보를 동기화하는 중입니다.';
            area.hidden = false;
        }
        return;
    }

    // [중요] 새로고침 시 최초 동기화(UserStore.isInitialSyncDone)와 사용자 데이터(UserStore.isUserDataSyncDone)가 완료될 때까지 대기
    if ((!UserStore.isInitialSyncDone || !UserStore.isUserDataSyncDone) && !forceSync) {
        if (window._inventorySyncWaitInterval) return;

        // 대기 중임을 알리는 로딩 UI 표시
        renderInventoryLoadingState(document.getElementById('grid-status-area'));

        // Promise.all로 두 동기화 완료를 직접 대기 (폴링 제거)
        Promise.all([
            new Promise(resolve => {
                if (UserStore.isInitialSyncDone) { resolve(); return; }
                const check = setInterval(() => { if (UserStore.isInitialSyncDone) { clearInterval(check); resolve(); } }, 50);
                setTimeout(() => { clearInterval(check); resolve(); }, 5000); // 5초 타임아웃
            }),
            new Promise(resolve => {
                if (UserStore.isUserDataSyncDone) { resolve(); return; }
                const check = setInterval(() => { if (UserStore.isUserDataSyncDone) { clearInterval(check); resolve(); } }, 50);
                setTimeout(() => { clearInterval(check); resolve(); }, 5000);
            })
        ]).then(() => {
            const data = cardCacheInstance.getInventory();
            if (UserStore.isInitialSyncDone && UserStore.isUserDataSyncDone && data.length > 0) {
                startGridRendering();
            } else {
                renderInventoryReadyState();
            }
        });
        return;
    }

    // 이미 모든 동기화가 끝난 상태에서의 렌더링 결정
    const data = cardCacheInstance.getInventory();
    if (UserStore.isInitialSyncDone && UserStore.isUserDataSyncDone && !forceSync && data.length > 0) {
        startGridRendering();
    } else if (forceSync || (UserStore.isInitialSyncDone && UserStore.isUserDataSyncDone && data.length === 0)) {
        if (forceSync) {
            await checkAndSyncInventoryData(true);
        } else {
            // 동기화는 끝났는데 데이터가 없는 경우와 초기 상태 구분
            if (UserStore.isInitialSyncDone && UserStore.isUserDataSyncDone && data.length === 0) {
                renderInventoryReadyState("등록된 카드가 없습니다.");
            } else {
                renderInventoryReadyState("데이터를 불러옵니다.");
            }
        }
    } else {
        startGridRendering();
    }
}

function renderInventoryLoadingState(statusArea) {
    if (!statusArea) return;

    statusArea.innerHTML = `
        <div class="grid-loader-overlay">
            <div class="loading-spinner-small color-theme-002" aria-hidden="true"></div>
            <div class="grid-loader-text">정보 가져오는 중</div>
        </div>
    `;
    statusArea.hidden = false;
}

/**
 * 사용자 데이터 동기화 확인 및 진행
 */
async function checkAndSyncInventoryData(force = false) {
    const statusArea = document.getElementById('grid-status-area');
    const tbody = document.getElementById('inventory-grid-body');
    if (tbody) tbody.innerHTML = '';
    renderInventoryLoadingState(statusArea);

    try {
        if (!UserStore.isInitialSyncDone || force) {
            await loadUserData(); // 정의되지 않은 syncUserData 대신 loadUserData 호출
        }

        inventoryGridState.allData = cardCacheInstance.getInventory();
        inventoryGridState.lastSyncTime = Date.now();

        const loaderText = statusArea ? statusArea.querySelector('.grid-loader-text') : null;
        if (loaderText) loaderText.textContent = "리스트 생성 중";

        setTimeout(startGridRendering, 300);

    } catch (e) {
        console.error("인벤토리 동기화 실패:", e);
        // [지시] 실패 토스트 메시지 제거
        const data = cardCacheInstance.getInventory();
        if (data.length === 0) {
            renderInventoryReadyState("등록된 카드가 없습니다.");
        } else {
            renderInventoryReadyState("데이터를 불러옵니다.");
        }
    }
}

/**
 * 그리드 렌더링 준비 (데이터 가공 및 테이블 생성)
 */
function startGridRendering() {
    inventoryGridState.allData = cardCacheInstance.getInventory();
    inventoryGridState.displayLimit = 50;

    if (inventoryGridState.allData.length === 0) {
        renderInventoryReadyState("등록된 카드가 없습니다.");
        return;
    }

    // 필터링 및 정렬 적용
    applyGridFiltersAndSort();

    // 테이블 구조 렌더링
    renderInventoryListTable();
}

/**
 * "데이터를 불러옵니다." 초기 상태 혹은 데이터 없음 상태 표시
 */
function renderInventoryReadyState(message = "데이터를 불러옵니다.") {
    const tbody = document.getElementById('inventory-grid-body');
    if (tbody) tbody.innerHTML = '';

    const statusArea = document.getElementById('grid-status-area');
    if (!statusArea) return;

    statusArea.innerHTML = `
        <div class="grid-ready-view">
            <div class="grid-ready-text">${message}</div>
            <button type="button" class="ui-button grid-ready-action color-theme shape-capsule" onclick="manualSyncInventory()">불러오기</button>
        </div>
    `;
    statusArea.hidden = false;
}

function renderInventoryLoginRequiredState() {
    const tbody = document.getElementById('inventory-grid-body');
    if (tbody) tbody.innerHTML = '';

    const statusArea = document.getElementById('grid-status-area');
    if (!statusArea) return;

    statusArea.innerHTML = `
        <div class="grid-ready-view">
            <div class="grid-ready-text">로그인 후 보유 현황을 확인하고 관리할 수 있습니다.</div>
            <button type="button" class="ui-button ui-button--sign-in color-theme shape-capsule" onclick="toggleAuthModal()">로그인하기</button>
        </div>
    `;
    statusArea.hidden = false;
}

/**
 * 수동 불러오기 버튼 핸들러
 */
function manualSyncInventory() {
    renderInventoryGrid(true);
}

/**
 * 필터링 및 정렬 로직 적용
 */
function applyGridFiltersAndSort() {
    let data = [...inventoryGridState.allData];

    // 1. 필터 적용
    Object.keys(inventoryGridState.filters).forEach(colIdx => {
        const filter = inventoryGridState.filters[colIdx];
        const idx = parseInt(colIdx);

        if (filter instanceof Set) {
            // 선택형 필터 (Type 2)
            data = data.filter(row => filter.has(String(row[idx] ?? '')));
        } else if (typeof filter === 'string' && filter.trim() !== '') {
            // 입력형 필터 (Type 1)
            const keyword = filter.toLowerCase();
            data = data.filter(row => String(row[idx]).toLowerCase().includes(keyword));
        }
    });

    // 2. 정렬 적용
    const { colIndex, dir } = inventoryGridState.sort;
    if (dir && colIndex >= 0) data.sort((a, b) => {
        let valA = a[colIndex];
        let valB = b[colIndex];

        // 수량 정렬 처리
        if (colIndex === 3) {
            valA = parseInt(valA) || 0;
            valB = parseInt(valB) || 0;
        }

        const comparison = colIndex === 3 ? valA - valB :
            String(colIndex === 2 ? getLocalizedRarity(valA) : valA).localeCompare(
                String(colIndex === 2 ? getLocalizedRarity(valB) : valB), 'ko', { numeric:true, sensitivity:'base' });
        return dir === 'asc' ? comparison : -comparison;
    });

    // 모바일 기기인 경우 카드 이름, 번호, 위치가 동일한 항목들을 합산 처리
    if (document.documentElement.classList.contains('is-mobile-device')) {
        const groupedMap = new Map();
        data.forEach(row => {
            // 키 기준: 이름(0), 번호(1), 위치(4)
            const key = `${row[0]}|${row[1]}|${row[4]}`;
            if (!groupedMap.has(key)) {
                // 복사본 생성하여 합산 작업 수행 (원본 캐시 데이터 보호)
                const newRow = [...row];
                newRow[3] = parseInt(newRow[3]) || 0;
                groupedMap.set(key, newRow);
            } else {
                const existingRow = groupedMap.get(key);
                existingRow[3] += (parseInt(row[3]) || 0);
            }
        });
        data = Array.from(groupedMap.values());
    }

    inventoryGridState.filteredData = data;
}

/**
 * 테이블 뼈대 렌더링 및 헤더 이벤트 바인딩
 */
function renderInventoryListTable() {
    const tbody = document.getElementById('inventory-grid-body');
    const statusArea = document.getElementById('grid-status-area');
    const scrollArea = document.getElementById('inventory-scroll-area');
    if (!tbody || !scrollArea) return;

    // 상태 영역 숨김
    if (statusArea) statusArea.hidden = true;

    // 헤더 상태 업데이트
    updateGridHeaderUI();

    // 첫 배치 렌더링
    renderInventoryBatch(true);

    // 스크롤 이벤트 바인딩 (인피니트 스크롤) - 중복 바인딩 방지
    if (!scrollArea.dataset.scrollBound) {
        scrollArea.addEventListener('scroll', handleGridScroll);
        scrollArea.dataset.scrollBound = "true";
    }


}



/**
 * 그리드 헤더의 정렬 및 필터 아이콘 UI 업데이트
 */
function updateGridHeaderUI() {
    const { colIndex, dir } = inventoryGridState.sort;
    const ths = document.querySelectorAll('.inventory-table th');

    ths.forEach((th, idx) => {
        th.classList.remove('active-sort');
        const activeIcon = th.querySelector('.active-icon');

        if (idx === colIndex) {
            th.classList.add('active-sort');
            if (activeIcon) {
                activeIcon.className = (dir === 'asc') ? 'fa-solid fa-sort-up active-icon' : 'fa-solid fa-sort-down active-icon';
            }
        } else {
            if (activeIcon) activeIcon.className = 'fa-solid active-icon';
        }

        // 필터 활성화 여부 표시
        const filterBtn = th.querySelector('.filter-trigger-btn');
        if (filterBtn) {
            const hasFilter = inventoryGridState.filters[idx] &&
                (inventoryGridState.filters[idx] instanceof Set ? true : inventoryGridState.filters[idx] !== "");
            filterBtn.classList.toggle('active-filter', !!hasFilter);
        }
    });
}

/**
 * 인피니트 스크롤 배치 렌더링
 * @param {boolean} isInitial 초기 렌더링 여부
 */
function renderInventoryBatch(isInitial = false) {
    const tbody = document.getElementById('inventory-grid-body');
    if (!tbody) return;

    if (isInitial) tbody.replaceChildren();

    const start = isInitial ? 0 : inventoryGridState.displayLimit - 50;
    const end = Math.min(inventoryGridState.displayLimit, inventoryGridState.filteredData.length);
    const Fragment = document.createDocumentFragment();

    for (let i = start; i < end; i++) {
        const row = inventoryGridState.filteredData[i];
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${escapeHTML(row[0])}</td>
            <td>${escapeHTML(row[1])}</td>
            <td>${escapeHTML(getLocalizedRarity(row[2]))}</td>
            <td>${escapeHTML(row[3])}</td>
            <td>${escapeHTML(row[4])}</td>
            <td>${escapeHTML(row[5] || '기본')}</td>
        `;
        Fragment.appendChild(tr);
    }

    tbody.appendChild(Fragment);

    // 더 불러올 데이터가 없으면 센서 숨김
    const sensor = document.getElementById('grid-append-sensor');
    if (sensor) {
        sensor.hidden = end >= inventoryGridState.filteredData.length;
    }
}

/**
 * 스크롤 이벤트 핸들러 (바닥 도달 감지)
 */
function handleGridScroll(e) {
    const area = e.target;
    if (inventoryGridState.displayLimit >= inventoryGridState.filteredData.length) return;

    // 바닥 근처(30px) 도달 시
    if (area.scrollTop + area.clientHeight >= area.scrollHeight - 30) {
        if (inventoryGridState.isRendering) return;

        inventoryGridState.isRendering = true;
        const loader = document.getElementById('grid-bottom-loader');
        if (loader) loader.hidden = false;

        setTimeout(() => {
            inventoryGridState.displayLimit += 50;
            renderInventoryBatch(false);
            if (loader) loader.hidden = true;
            inventoryGridState.isRendering = false;
        }, 300);
    }
}

/**
 * 정렬 버튼 핸들러
 */
function handleGridSort(colIdx, trigger) {
    const isMobile = document.documentElement.classList.contains('is-mobile-device');
    if (isMobile) {
        openGridFilterMobile(colIdx, trigger);
        return;
    }

    if (inventoryGridState.sort.colIndex === colIdx) {
        inventoryGridState.sort.dir = inventoryGridState.sort.dir === 'asc' ? 'desc' : 'asc';
    } else {
        inventoryGridState.sort.colIndex = colIdx;
        inventoryGridState.sort.dir = 'asc';
    }

    startGridRendering();
}

/**
 * 필터 팝업 열기
 */
let inventoryFilterEditor = null;
function openGridFilter(event, colIdx) {
    event?.stopPropagation?.();
    openInventoryFilter(colIdx, event?.currentTarget || event?.target?.closest?.('.filter-trigger-btn'));
}
function openGridFilterMobile(colIdx, trigger = document.activeElement) { openInventoryFilter(colIdx, trigger); }
function openInventoryFilter(colIdx, trigger) {
    if (inventoryFilterEditor) closeInventoryFilter({restoreFocus:false});
    const mobile = document.documentElement.classList.contains('is-mobile-device');
    const root = document.getElementById(mobile ? 'mobile-grid-filter-sheet' : 'inventory-filter-popup');
    const backdrop = document.getElementById('grid-filter-sheet-overlay');
    const label = ['카드 이름','카드 번호','레어도','수량','보관 위치','일러스트'][colIdx];
    const key = ['name','number','rarity','quantity','location','illustration'][colIdx];
    const options = [...new Set(inventoryGridState.allData.map(row=>String(row[colIdx] ?? '')))].map(value=>({value,label:colIdx === 2 ? getLocalizedRarity(value) : value}));
    const current=inventoryGridState.filters[colIdx];
    const values = current instanceof Set ? [...current] : typeof current === 'string' && current ? options.filter(option=>matchKorean(option.label,current)).map(option=>option.value) : options.map(option=>option.value);
    const editor={ root,backdrop,mobile,trigger,colIdx,key,options,drafts:{[key]:values},sort:inventoryGridState.sort.colIndex === colIdx ? inventoryGridState.sort.dir || '' : '' };
    inventoryFilterEditor=editor;
    const makeButton=(icon,name,action)=>{const button=document.createElement('button');button.type='button';button.className='ui-button ui-button--text color-text-001';button.setAttribute('aria-label',name);const i=document.createElement('i');i.className='material-icons';i.textContent=icon;i.setAttribute('aria-hidden','true');button.append(i);button.onclick=action;return button;};
    const header=document.createElement('header');header.className='ui-overlay__header';
    const title=document.createElement('h2');title.id=mobile ? 'grid-filter-sheet-title' : 'inventory-filter-title';title.className='color-text-000';title.textContent=label;root.setAttribute('aria-labelledby',title.id);
    const tools=document.createElement('div');tools.className='ui-overlay__header';
    const content=document.createElement('div');content.className='ui-overlay__body';
    const body=document.createElement('div');body.className='catalog-filter-editor__body';body.id=mobile ? 'grid-filter-sheet-body' : 'inventory-filter-body';content.append(body);
    function render() {
        body.replaceChildren();
        if (!(mobile && colIdx === 3)) editor.view=FilterEditor.render({form:body,key,definition:{label,options},drafts:editor.drafts,mobile,scope:'inventory',sort:editor.sort,errorId:root.id,changed:()=>{}});
        tools.replaceChildren();
        if (colIdx !== 5) tools.append(FilterEditor.sortButton(editor.sort, direction=>{editor.sort=direction;editor.view?.sort(direction);}));
        tools.append(makeButton('refresh','초기화',()=>{editor.drafts[key]=options.map(option=>option.value);editor.sort='';render();}),makeButton('close','닫기',closeInventoryFilter));
    }
    header.append(title,tools);
    const footer=document.createElement('footer');footer.className='ui-overlay__footer';
    const apply=document.createElement('button');apply.type='button';apply.className='ui-button color-theme shape-capsule';apply.textContent='적용';apply.id=mobile ? 'grid-filter-sheet-apply-btn' : 'inventory-filter-apply';
    apply.onclick=()=>{
        if (!(mobile && colIdx === 3)) {
            const selected=new Set(editor.drafts[key]);
            if (selected.size === options.length) delete inventoryGridState.filters[colIdx]; else inventoryGridState.filters[colIdx]=selected;
        }
        if (colIdx !== 5) {
            if (editor.sort) inventoryGridState.sort={colIndex:colIdx,dir:editor.sort};
            else if (inventoryGridState.sort.colIndex === colIdx) inventoryGridState.sort={colIndex:-1,dir:''};
        }
        closeInventoryFilter();startGridRendering();
    };
    footer.append(apply);root.replaceChildren(header,content,footer);render();
    if (mobile) {
        openManagedSheet(root,{backdrop,trigger,initialFocus:tools.lastElementChild,onDismiss:closeInventoryFilter});
    } else {
        AppOverlays.openPopup(root, trigger, { anchorElement: trigger?.closest?.('th'), gap: 0, fitBelow: true });
        tools.lastElementChild.focus({preventScroll:true});
    }
}
function closeInventoryFilter({restoreFocus=true} = {}) {
    const editor=inventoryFilterEditor;if (!editor) return;inventoryFilterEditor=null;
    if (editor.mobile) closeManagedSheet(editor.root,{backdrop:editor.backdrop});
    else AppOverlays.closePopup(editor.root,()=>{if (restoreFocus && editor.trigger?.isConnected) editor.trigger.focus({preventScroll:true});});
}
function closeGridFilter() { closeInventoryFilter(); }
function closeGridFilterSheet() { closeInventoryFilter(); }
document.addEventListener('pointerdown',event=>{
    const editor=inventoryFilterEditor;
    if (editor && !editor.mobile && !editor.root.contains(event.target) && !editor.trigger?.contains?.(event.target)) closeInventoryFilter({restoreFocus:false});
});
document.addEventListener('keydown',event=>{if (event.key==='Escape' && inventoryFilterEditor) {event.preventDefault();closeInventoryFilter();}});

function switchToMode(mode, isInstant = false, subMode = null) {
    if (typeof OnboardingManager !== 'undefined' && OnboardingManager.isActive()) OnboardingManager.stop();
    if (mode !== 'search' && UIStore.mode === 'search' && typeof SearchNavigation !== 'undefined') SearchNavigation.leave();
    // 모바일 검색 모드 활성화 시 다른 페이지로 이동하면 검색창 자동 닫기 + 실제 페이지는 전환 애니메이션 스킵
    if (mode !== 'search') {
        const overlay = document.getElementById('mobile-search-overlay');
        if (overlay && overlay.classList.contains('active')) {
            closeMobileSearch(true);
            isInstant = true;
        }
    }

    // [AD] 모드 전환 시 광고 갱신
    if (typeof refreshPageAds === 'function') refreshPageAds(mode);

    globalThis.AppFeedback?.dismissToast();

    // 'manage' 모드로 진입 시 실제 내부 모드로 매핑
    if (mode === 'manage') {
        mode = UIStore.lastManageMode;
    }

    // 새로고침 시 인증 세션 복원이 완료될 때까지 라우팅 및 렌더링을 안전하게 대기
    const isManageMode = ['add', 'move', 'discard'].includes(mode);
    if (isManageMode || mode === 'inventory' || mode === 'settings') {
        if (isManageMode) UIStore.lastManageMode = mode;
        if (!window.isAuthInitialized) {
            waitForAuthInit().then(() => {
                switchToMode(mode, isInstant, subMode);
            });
            return;
        }
    }

    if (mode === 'settings') prepareMembershipEntry();

    const isSameMode = UIStore.mode === mode;
    const isSameSubMode = mode !== 'inventory' || !subMode || subMode === UIStore.inventoryMode;
    if (isSameMode && isSameSubMode && mode !== 'search') return;

    // hash/뒤로가기로 이동해도 이전 모드의 입력 노드를 먼저 제자리에 돌려놓는다.
    window.RegistrationLookup?.closeInline(false);
    window.RegistrationLookup?.close();
    if (typeof currentEditingRow !== 'undefined' && currentEditingRow) closeEntryBottomSheet();

    if (mode === 'inventory') {
        if (subMode) {
            UIStore.inventoryMode = subMode;
        } else {
            // 해시를 분석하여 초기 서브모드 결정
            const hash = window.location.hash;
            if (hash.includes('inventory/list')) UIStore.inventoryMode = 'list';
            else if (hash.includes('inventory/dashboard')) UIStore.inventoryMode = 'dashboard';
        }
    }
    const previousMode = UIStore.mode;
    UIStore.mode = mode;
    updateActiveNav(mode);
    const body = document.body;
    const searchInput = document.getElementById('card-search');

    // URL 해시 업데이트
    if (!isInternalHashChange) {
        isInternalHashChange = true;
        let finalHash = '';

        if (mode === 'home') {
            finalHash = '';
        } else if (mode === 'search') {
            if (window.location.hash.startsWith('#search')) {
                finalHash = window.location.hash.substring(1);
            } else {
                finalHash = 'search';
            }
        } else if (mode === 'inventory') {
            finalHash = `${mode}/${UIStore.inventoryMode}`;
        } else {
            finalHash = mode;
        }

        if (finalHash === '') {
            // 홈으로 이동 시 해시 제거 (앞/뒤로 가기 히스토리 보존을 위해 pushState 사용)
            history.pushState(null, '', window.location.pathname + window.location.search);
        } else {
            window.location.hash = finalHash;
        }
        setTimeout(() => { isInternalHashChange = false; }, 100);
    }

    if (mode === 'home') {
        searchInput.value = ''; document.getElementById('clear-btn').hidden = true;
        toggleSearchWrapper(false); searchInput.placeholder = "";
        window.scrollTo(0, 0);
    } else if (mode === 'search') { searchInput.placeholder = ""; }
    else {
        searchInput.value = ''; document.getElementById('clear-btn').hidden = true;
        toggleSearchWrapper(false); searchInput.placeholder = "카드 검색";
    }

    if (mode === 'home') { body.classList.remove('mode-compact'); } else { body.classList.add('mode-compact'); }

    const helpButton = document.querySelector('.help-trigger-btn');
    if (helpButton) helpButton.inert = mode !== 'home';

    // 모바일에서 홈을 벗어나면 퇴장 애니메이션 중에도 로고 링크를 탐색하지 않는다.
    const masthead = document.getElementById('app-search-masthead');
    if (masthead) {
        masthead.inert = document.documentElement.classList.contains('is-mobile-device') && mode !== 'home';
    }

    const wrapper = document.getElementById('app-page-stack');
    const transitionRevision = ++pageTransitionRevision;
    if (pageTransitionFrame !== null) {
        cancelAnimationFrame(pageTransitionFrame);
        pageTransitionFrame = null;
        document.body.classList.remove('no-transition');
    }
    if (transitionTimer) {
        clearTimeout(transitionTimer); transitionTimer = null;
    }

    let targetContentId = '';
    if (mode === 'home') targetContentId = 'app-page-home';
    else if (mode === 'inventory') targetContentId = 'app-page-inventory';
    else if (mode === 'search') targetContentId = 'app-page-search';
    else if (isManageMode) {
        targetContentId = 'app-page-manage';
        if (mode === 'move') initPageMove();
        if (mode === 'discard') initPageDiscard();
    }
    else if (mode === 'settings') targetContentId = 'app-page-settings';

    const currentEl = wrapper.querySelector('.content-section.active');
    const nextEl = document.getElementById(targetContentId);

    // [버그 수정] 동일 페이지 내에서 세부 모드(탭)만 바뀌는 경우 애니메이션을 생략함
    if (currentEl === nextEl) {
        setActivePage(nextEl);
        if (isManageMode) {
            handleManageUI(mode, previousMode === 'search');
        } else if (mode === 'inventory') {
            switchInventoryMode(UIStore.inventoryMode, true);
        }
        if (typeof OnboardingManager !== 'undefined' && !OnboardingManager.isActive() && (typeof UserStore.user !== 'undefined' && UserStore.user || typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser)) {
            setTimeout(() => {
                if (transitionRevision === pageTransitionRevision && !OnboardingManager.isActive()) OnboardingManager.start(mode);
            }, 300);
        }
        return;
    }

    if (isInstant) {
        document.body.classList.add('no-transition');

        setActivePage(nextEl);

        if (isManageMode) {
            handleManageUI(mode, previousMode === 'search');
        } else if (mode === 'inventory') {
            switchInventoryMode(UIStore.inventoryMode, true);
        }

        if ((isManageMode || mode === 'home' || mode === 'inventory' || mode === 'settings') && previousMode === 'search') {
            document.getElementById('result-area').innerHTML = '';
        }

        pageTransitionFrame = requestAnimationFrame(() => {
            if (transitionRevision !== pageTransitionRevision) return;
            pageTransitionFrame = null;
            document.body.classList.remove('no-transition');
        });
        return;
    }

    // 절대 위치 배치 제거: 문서 흐름을 유지하여 높이 붕괴 방지

    if (isManageMode) {
        handleManageUI(mode, previousMode === 'search');
        const innerContainer = document.getElementById('manage-mode-forms');
        if (innerContainer) void innerContainer.offsetHeight;
    } else if (mode === 'inventory') {
        switchInventoryMode(UIStore.inventoryMode, true);
        const innerContainer = document.getElementById('inventory-mode-forms');
        if (innerContainer) void innerContainer.offsetHeight;
    }

    // [최종 안정화] JS가 높이에 개입하지 않도록 모든 인라인 스타일 지정을 배제함
    pageTransitionFrame = requestAnimationFrame(() => {
        if (transitionRevision !== pageTransitionRevision) return;
        pageTransitionFrame = null;
        document.body.classList.remove('no-transition');
        setActivePage(nextEl);
    });

    transitionTimer = setTimeout(() => {
        if (transitionRevision !== pageTransitionRevision) return;

        if ((isManageMode || mode === 'home' || mode === 'settings') && previousMode === 'search') {
            document.getElementById('result-area').innerHTML = '';
        }

        // 온보딩 가이드 트리거 (로그인 상태일 때만)
        if (typeof OnboardingManager !== 'undefined' && !OnboardingManager.isActive() && (typeof UserStore.user !== 'undefined' && UserStore.user || typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser)) {
            setTimeout(() => {
                if (transitionRevision === pageTransitionRevision && !OnboardingManager.isActive()) OnboardingManager.start(mode);
            }, 300);
        }

        transitionTimer = null;
    }, 400);
}

function checkClearBtn() {
    const input = document.getElementById('card-search');
    const button = document.getElementById('clear-btn');
    if (button) button.hidden = !input?.value || input.disabled;
}
function toggleSearchWrapper(isOpen, { immediate = false } = {}) {
    const wrapper = document.getElementById('search-wrapper');
    const list = document.getElementById('custom-dropdown');
    if (!wrapper || !list) return;
    clearTimeout(wrapper._dropdownHeightTimer);

    if (isOpen && Number(wrapper.dataset.suppressDropdownUntil || 0) > Date.now()) {
        list.classList.remove('active');
        list.hidden = true;
        wrapper.classList.remove('active', 'photo-search-open');
        wrapper.style.setProperty('--dropdown-height', '0px');
        return;
    }

    if (isOpen) {
        wrapper.classList.add('active');
        if (wrapper.classList.contains('photo-search-open')) {
            list.classList.remove('active');
            return;
        }
        list.hidden = false;
        list.classList.add('active');
        wrapper._dropdownHeightTimer = setTimeout(() => {
            if (!list.classList.contains('active')) return;
            const height = `${Math.min(list.scrollHeight, 250)}px`;
            if (wrapper.style.getPropertyValue('--dropdown-height') !== height) {
                wrapper.style.setProperty('--dropdown-height', height);
            }
        }, 50);
        return;
    }

    list.classList.remove('active');
    if (immediate) list.hidden = true;
    if (window.PhotoCardSearch?.hasDesktopPhoto?.()) {
        wrapper.classList.add('active', 'photo-search-open');
        return;
    }
    wrapper.classList.remove('active', 'photo-search-open');
    const photoPanel = document.getElementById('desktop-photo-search-panel');
    if (photoPanel) photoPanel.hidden = true;
    wrapper.style.setProperty('--dropdown-height', '0px');
}


function initPageAdd() {
    const isMobile = document.documentElement.classList.contains('is-mobile-device');
    const list = document.getElementById(isMobile ? 'mobile-cards-list-general' : 'desktop-cards-list-general');
    if (!list) return;
    list.innerHTML = '';
    manageAddEntry();
}

function adjustAddCount(delta) {
    FormRowStore.addCount = Math.max(1, FormRowStore.addCount + delta);
    const label = `${FormRowStore.addCount}장`;
    const mobile = document.getElementById('add-count');
    const desktop = document.getElementById('add-count-desktop');
    if (mobile) mobile.innerText = label;
    if (desktop) desktop.innerText = label;
}

function addMultipleRows(e) {
    if (e && e.target) e.target.blur();
    const count = FormRowStore.addCount;

    let firstNewCard = null;
    for (let i = 0; i < count; i++) {
        const card = desktopAddEntry('add');
        if (i === 0) firstNewCard = card;
    }
    if (firstNewCard && e && e.detail === 0) {
        const input = firstNewCard.querySelector('[data-field="no"]');
        if (input) input.focus();
    }
}

function addMultipleMoveRows(e) {
    if (e && e.target) e.target.blur();

    let firstNewCard = null;
    for (let i = 0; i < FormRowStore.moveCount; i++) {
        const card = desktopAddEntry('move');
        if (i === 0) firstNewCard = card;
    }
    if (firstNewCard && e && e.detail === 0) {
        const input = firstNewCard.querySelector('[data-field="name"]');
        if (input) input.focus();
    }
}

function initPageDiscard() {
    const isMobile = document.documentElement.classList.contains('is-mobile-device');
    if (isMobile) {
        const listContainer = document.getElementById('mobile-cards-list-discard');
        if (listContainer && listContainer.querySelectorAll('.mobile-info-card[data-index]').length === 0) {
            listContainer.innerHTML = '';
            mobileAddEntry('discard');
        }
    } else {
        const listContainer = document.getElementById('desktop-cards-list-discard');
        if (listContainer && listContainer.querySelectorAll('.desktop-info-card[data-index]').length === 0) {
            listContainer.innerHTML = '';
            desktopAddEntry('discard');
        }
    }
}

function adjustDiscardCount(delta) {
    FormRowStore.discardCount += delta;
    if (FormRowStore.discardCount < 1) FormRowStore.discardCount = 1;
    
    const el = document.getElementById('add-discard-count');
    if (el) el.innerText = FormRowStore.discardCount + "장";
    
    const elDesktop = document.getElementById('add-discard-count-desktop');
    if (elDesktop) elDesktop.innerText = FormRowStore.discardCount + "장";
}

function addMultipleDiscardRows(e) {
    if (e && e.target) e.target.blur();

    let firstNewCard = null;
    for (let i = 0; i < FormRowStore.discardCount; i++) {
        const card = desktopAddEntry('discard');
        if (i === 0) firstNewCard = card;
    }
    if (firstNewCard && e && e.detail === 0) {
        const input = firstNewCard.querySelector('[data-field="name"]');
        if (input) input.focus();
    }
}

function handleAddButtonKey(e, type) {
    if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (type === 'add') adjustAddCount(1);
        else if (type === 'move') adjustMoveCount(1);
        else if (type === 'discard') adjustDiscardCount(1);
    } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (type === 'add') adjustAddCount(-1);
        else if (type === 'move') adjustMoveCount(-1);
        else if (type === 'discard') adjustDiscardCount(-1);
    }
}

function manageAddEntry(initialData = null) {
    const isMobile = document.documentElement.classList.contains('is-mobile-device');
    if (isMobile) {
        return mobileAddEntry('add', initialData);
    } else {
        return desktopAddEntry('add', initialData);
    }
}



function handleAutoLocInput(input) {
    const wrapper = input.closest('.custom-select-wrapper');
    if (!wrapper) return;

    // 입력 시 에러 상태 및 확정 하이라이트 해제
    wrapper.classList.remove('error-highlight');
    wrapper.classList.remove('active-highlight');
    delete input.dataset.confirmed;

    // 값이 있으면 has-value 클래스 추가 (X 버튼 노출용)
    if (input.value.trim().length > 0) {
        wrapper.classList.add('has-value');
    } else {
        wrapper.classList.remove('has-value');
    }

    // [지시 사항] 드롭다운이 열려있을 때는 테두리 강조 효과 비활성화
    if (wrapper.classList.contains('active')) {
        return;
    }
}

function applyAutoLocationToTable(value) {
    const isMobile = document.documentElement.classList.contains('is-mobile-device');
    const containerId = isMobile ? 'mobile-cards-list-general' : 'desktop-cards-list-general';

    const container = document.getElementById(containerId);
    if (!container) return;
    
    const cardClass = isMobile ? '.mobile-info-card[data-index]' : '.desktop-info-card[data-index]';
    const cards = container.querySelectorAll(cardClass);
    cards.forEach(card => {
        const locInput = card.querySelector('[data-field="loc"]');
        if (locInput && !locInput.value.trim()) {
            locInput.value = value;
        }
    });

    if (isMobile) {
        renderMobileCards();
    }
}




function handleAddRareChange(input) {
    const row = getRowFromInput(input);
    if (!row) return;
    const target = getQueryTarget(row);
    const qtyInput = target.querySelector('.page-card-qty, [data-field="qty"]');
    if (qtyInput) {
        if (input.value) {
            qtyInput.removeAttribute('readonly');
            if (!qtyInput.value) {
                qtyInput.value = "1";
            }
        } else {
            qtyInput.setAttribute('readonly', 'true');
            qtyInput.value = "";
        }
    }

}



function handleDiscardNameInput(input) {
    const row = getRowFromInput(input);
    if (!row) return;
    const target = getQueryTarget(row);
    const noInput = target.querySelector('.discard-card-no');
    const nameVal = input.value.trim();
    if (!nameVal) {
        clearPageNameAndNo(input);
        return;
    }

    if (!input.dataset.programmatic) {
        if (noInput) {
            noInput.dataset.programmatic = "true";
            noInput.value = "";
            delete noInput.dataset.programmatic;
        }
        resetDiscardRow(row, 'no');
    }

    // 보유한 번호가 단 1개인 경우 자동 기입 및 핸들러 트리거
    const ownedNos = cardCacheInstance.getNosByName(nameVal);
    if (ownedNos && ownedNos.length === 1 && noInput) {
        noInput.value = ownedNos[0];
        validateDiscardNoInput(noInput, true);
    }
}





function resetDiscardRow(row, level) {
    IllustrationPicker.close(false, false);
    const target = getQueryTarget(row);
    const illustInp = target.querySelector('.discard-card-illustration, .desktop-card-illust, [data-field="illust"]'); const rareInp = target.querySelector('.discard-card-rarity, .desktop-card-rare, [data-field="rare"]'); const locInp = target.querySelector('.discard-card-loc, .desktop-card-loc, [data-field="loc"]'); const qtyInput = target.querySelector('.discard-card-qty, .desktop-card-qty, [data-field="qty"]');
    const illustWrap = illustInp ? illustInp.closest('.custom-select-wrapper') : null; const rareWrap = rareInp ? rareInp.closest('.custom-select-wrapper') : null; const locWrap = locInp ? locInp.closest('.custom-select-wrapper') : null;
    if (illustWrap) { illustWrap.classList.remove('single-option'); illustWrap.classList.add('no-option'); }
    if (rareWrap) { rareWrap.classList.remove('single-option'); rareWrap.classList.add('no-option'); }
    if (locWrap) { locWrap.classList.remove('single-option'); locWrap.classList.add('no-option'); }
    if (level === 'no') {
        setIllustrationValue(illustInp, ""); illustInp.setAttribute('readonly', true); if (illustWrap) illustWrap.dataset.options = "[]";
        rareInp.value = ""; rareInp.setAttribute('readonly', true); if (rareWrap) rareWrap.dataset.options = "[]"; delete rareInp.dataset.raw;
        locInp.value = ""; if (locWrap) locWrap.dataset.options = "[]"; delete locInp.dataset.raw; qtyInput.value = '';
    }

    if (document.documentElement.classList.contains('is-mobile-device')) {
        renderMobileCards();
    }
}

function updateDiscardIllusts(row, matches) {
    prepareOwnedIllustrations(row, matches);
    const target = getQueryTarget(row);
    const illustInp = target.querySelector('.discard-card-illustration, [data-field="illust"]');
    const illustWrap = illustInp ? illustInp.closest('.custom-select-wrapper') : null;
    const cardNoInp = target.querySelector('.discard-card-no, [data-field="no"]');
    const cardNo = cardNoInp ? cardNoInp.value.trim() : "";
    if (!illustInp || !illustWrap || !cardNo) return;

    const uniqueIllusts = [...new Set(matches.map(r => String(r[5] || "기본").trim()))].sort((a, b) => { if (a === "기본") return -1; if (b === "기본") return 1; return a.localeCompare(b, undefined, { numeric: true }); });
    const validIllusts = uniqueIllusts.filter(illust => checkDiscardIllustAvailability(cardNo, illust, row));
    const options = validIllusts.map(i => ({ val: i, text: i }));
    illustWrap.dataset.options = JSON.stringify(options);
    illustInp.readOnly = true; illustWrap.classList.remove('no-option');
    setupDropdownForField(illustInp, illustWrap);
    const currentVal = getIllustrationValue(illustInp); const isValid = options.some(o => o.val === currentVal);
    if (isValid) { handleDiscardIllustChange(illustInp); } else {
        if (options.length === 1) { illustWrap.classList.add('single-option'); setIllustrationValue(illustInp, options[0].val); handleDiscardIllustChange(illustInp); }
        else if (options.length === 0) { setIllustrationValue(illustInp, ""); illustWrap.classList.add('no-option'); resetDiscardRow(row, 'no'); }
        else { setIllustrationValue(illustInp, ""); illustWrap.classList.remove('single-option'); handleDiscardIllustChange(illustInp); }
    }

    if (document.documentElement.classList.contains('is-mobile-device')) {
        renderMobileCards();
    }
}

function updateDiscardIllustsDynamic(wrap) {
    const row = getRowFromInput(wrap);
    const target = getQueryTarget(row);
    const cardNoInp = target.querySelector('.discard-card-no, [data-field="no"]');
    const cardNo = cardNoInp ? cardNoInp.value.trim().toUpperCase() : "";
    if (!cardNo) return;
    const matches = cardCacheInstance.getInventory().filter(r => String(r[1]).trim().toUpperCase() === cardNo);

    const uniqueIllusts = [...new Set(matches.map(r => String(r[5] || "기본").trim()))].sort((a, b) => { if (a === "기본") return -1; if (b === "기본") return 1; return a.localeCompare(b, undefined, { numeric: true }); });
    const validIllusts = uniqueIllusts.filter(illust => checkDiscardIllustAvailability(cardNo, illust, row));
    const options = validIllusts.map(i => ({ val: i, text: i }));
    wrap.dataset.options = JSON.stringify(options);

    if (options.length <= 1) wrap.classList.add('single-option');
    else wrap.classList.remove('single-option');
}

function updateMoveIllustsDynamic(wrap) {
    const row = getRowFromInput(wrap);
    const target = getQueryTarget(row);
    const cardNoInp = target.querySelector('.move-card-no, [data-field="no"]');
    const cardNo = cardNoInp ? cardNoInp.value.trim().toUpperCase() : "";
    if (!cardNo) return;
    const matches = cardCacheInstance.getInventory().filter(r => String(r[1]).trim().toUpperCase() === cardNo);

    const uniqueIllusts = [...new Set(matches.map(r => String(r[5] || "기본").trim()))].sort((a, b) => { if (a === "기본") return -1; if (b === "기본") return 1; return a.localeCompare(b, undefined, { numeric: true }); });
    const validIllusts = uniqueIllusts.filter(illust => checkMoveIllustAvailability(cardNo, illust, row));
    const options = validIllusts.map(i => ({ val: i, text: i }));
    wrap.dataset.options = JSON.stringify(options);

    if (options.length <= 1) wrap.classList.add('single-option');
    else wrap.classList.remove('single-option');
}

function handleDiscardIllustChange(input) {
    const row = getRowFromInput(input);
    const target = getQueryTarget(row);
    const cardNoInp = target.querySelector('.discard-card-no, [data-field="no"]');
    const cardNo = cardNoInp ? cardNoInp.value.trim() : "";
    const selectedIllust = getIllustrationValue(input);
    setIllustrationValue(input, selectedIllust);
    if (!selectedIllust) {
        const rareInp = target.querySelector('.discard-card-rarity, [data-field="rare"]');
        if (rareInp) { rareInp.value = ""; handleDiscardRareChange(rareInp); }
        return;
    }
    const dbIllust = selectedIllust;
    const matches = cardCacheInstance.getInventory().filter(r => String(r[1]).trim().toUpperCase() === cardNo && String(r[5] || "기본").trim() === dbIllust);
    updateDiscardRarities(row, matches);

    if (document.documentElement.classList.contains('is-mobile-device')) {
        renderMobileCards();
    }
}

function updateDiscardRarities(row, matches) {
    const target = getQueryTarget(row);
    const rareInp = target.querySelector('.discard-card-rarity, [data-field="rare"]');
    const rareWrap = rareInp ? rareInp.closest('.custom-select-wrapper') : null;
    const cardNoInp = target.querySelector('.discard-card-no, [data-field="no"]');
    const cardNo = cardNoInp ? cardNoInp.value.trim() : "";
    const illustInp = target.querySelector('.discard-card-illustration, [data-field="illust"]');
    const illust = getIllustrationValue(illustInp);
    if (!rareInp || !rareWrap || !cardNo) return;

    const uniqueRares = [...new Set(matches.map(r => String(r[2]).trim()))].sort(compareRarity);
    const validRares = uniqueRares.filter(rare => checkDiscardRareAvailability(cardNo, illust, rare, row));

    const options = validRares.map(r => ({ val: r, text: getLocalizedRarity(r) }));
    rareWrap.dataset.options = JSON.stringify(options);
    rareInp.removeAttribute('readonly'); rareWrap.classList.remove('no-option');
    setupDropdownForField(rareInp, rareWrap);
    const currentVal = rareInp.value;
    const currentRaw = rareInp.dataset.raw || currentVal;
    const isValid = options.some(o => o.val === currentRaw);

    if (isValid) { handleDiscardRareChange(rareInp); } else {
        if (options.length === 1) { rareWrap.classList.add('single-option'); rareInp.value = options[0].text; rareInp.dataset.raw = options[0].val; handleDiscardRareChange(rareInp); }
        else if (options.length === 0) { rareInp.value = ""; rareWrap.classList.add('no-option'); }
        else { rareInp.value = ""; delete rareInp.dataset.raw; rareWrap.classList.remove('single-option'); handleDiscardRareChange(rareInp); }
    }

    if (document.documentElement.classList.contains('is-mobile-device')) {
        renderMobileCards();
    }
}

function updateDiscardRaritiesDynamic(wrap) {
    const row = getRowFromInput(wrap);
    const target = getQueryTarget(row);
    const cardNoInp = target.querySelector('.discard-card-no, [data-field="no"]');
    const cardNo = cardNoInp ? cardNoInp.value.trim().toUpperCase() : "";
    const illustInp = target.querySelector('.discard-card-illustration, [data-field="illust"]');
    const illust = getIllustrationValue(illustInp);
    const rareInput = target.querySelector('.discard-card-rarity, [data-field="rare"]');
    const rare = rareInput ? (rareInput.dataset.raw || rareInput.value) : "";
    if (!cardNo || !illust || !rare) return;

    const matches = cardCacheInstance.getInventory().filter(r => String(r[1]).trim().toUpperCase() === cardNo && String(r[5] || "기본").trim() === illust && String(r[2]).trim() === rare);
    const uniqueRares = [...new Set(matches.map(r => String(r[2]).trim()))].sort(compareRarity);
    const validRares = uniqueRares.filter(rare => checkDiscardRareAvailability(cardNo, illust, rare, row));
    const options = validRares.map(r => ({ val: r, text: getLocalizedRarity(r) }));

    wrap.dataset.options = JSON.stringify(options);
    if (options.length <= 1) wrap.classList.add('single-option');
    else wrap.classList.remove('single-option');
}

function handleDiscardRareChange(input) {
    const row = getRowFromInput(input);
    const target = getQueryTarget(row);
    const cardNoInp = target.querySelector('.discard-card-no, [data-field="no"]');
    const cardNo = cardNoInp ? cardNoInp.value.trim() : "";
    const illustInp = target.querySelector('.discard-card-illustration, [data-field="illust"]');
    const selectedIllust = getIllustrationValue(illustInp);
    const selectedRare = input.dataset.raw || input.value;
    if (!input.value) {
        const locInp = target.querySelector('.discard-card-loc, [data-field="loc"]');
        if (locInp) { locInp.value = ""; handleDiscardLocChange(locInp); }
        return;
    }
    const dbIllust = selectedIllust;
    const matches = cardCacheInstance.getInventory().filter(r => String(r[1]).trim().toUpperCase() === cardNo && String(r[5] || "기본").trim() === dbIllust && String(r[2]).trim() === selectedRare);
    updateDiscardLocations(row, matches);

    if (document.documentElement.classList.contains('is-mobile-device')) {
        renderMobileCards();
    }
}

function updateDiscardLocations(row, matches) {
    const target = getQueryTarget(row);
    const locInp = target.querySelector('.discard-card-loc, [data-field="loc"]');
    const locWrap = locInp ? locInp.closest('.custom-select-wrapper') : null;
    const cardNoInp = target.querySelector('.discard-card-no, [data-field="no"]');
    const cardNo = cardNoInp ? cardNoInp.value.trim() : "";
    const illustInp = target.querySelector('.discard-card-illustration, [data-field="illust"]');
    const illust = getIllustrationValue(illustInp);
    const rareInput = target.querySelector('.discard-card-rarity, [data-field="rare"]');
    const rare = rareInput ? (rareInput.dataset.raw || rareInput.value) : "";
    if (!locInp || !locWrap || !cardNo) return;

    locInp.removeAttribute('readonly'); locWrap.classList.remove('no-option');
    setupDropdownForField(locInp, locWrap);

    const locMap = {};
    matches.forEach(r => { const loc = String(r[4]).trim(); const qty = parseInt(r[3]) || 0; if (qty > 0) locMap[loc] = (locMap[loc] || 0) + qty; });

    const globalUsage = getGlobalUsageMap(row);
    let usedLocs = new Set();
    if (globalUsage[cardNo] && globalUsage[cardNo][illust] && globalUsage[cardNo][illust][rare]) {
        usedLocs = globalUsage[cardNo][illust][rare];
    }

    const validLocs = [];
    Object.keys(locMap).forEach(loc => {
        if (!usedLocs.has(loc)) {
            validLocs.push({ val: loc, text: `${loc} (보유: ${locMap[loc]})`, max: locMap[loc] });
        }
    });
    validLocs.sort((a, b) => a.val.localeCompare(b.val));
    locWrap.dataset.options = JSON.stringify(validLocs);

    const currentVal = locInp.value; const validOption = validLocs.find(o => o.val === currentVal);
    if (validOption) { locInp.dataset.maxQty = validOption.max; handleDiscardLocChange(locInp); } else {
        if (validLocs.length === 1) { locWrap.classList.add('single-option'); locInp.value = validLocs[0].val; locInp.dataset.maxQty = validLocs[0].max; handleDiscardLocChange(locInp); }
        else { locInp.value = ""; locWrap.classList.remove('single-option'); handleDiscardLocChange(locInp); }
    }
    if (validLocs.length === 0) locWrap.classList.add('no-option');

    if (document.documentElement.classList.contains('is-mobile-device')) {
        renderMobileCards();
    }
}

function updateDiscardLocationsDynamic(wrap) {
    const row = getRowFromInput(wrap);
    const target = getQueryTarget(row);
    const cardNoInp = target.querySelector('.discard-card-no, [data-field="no"]');
    const cardNo = cardNoInp ? cardNoInp.value.trim() : "";
    const illustInp = target.querySelector('.discard-card-illustration, [data-field="illust"]');
    const illust = getIllustrationValue(illustInp);
    const rareInput = target.querySelector('.discard-card-rarity, [data-field="rare"]');
    const rare = rareInput ? (rareInput.dataset.raw || rareInput.value) : "";
    if (!cardNo || !illust || !rare) return;

    const matches = cardCacheInstance.getInventory().filter(r => String(r[1]).trim().toUpperCase() === cardNo && String(r[5] || "기본").trim() === illust && String(r[2]).trim() === rare);

    const locMap = {};
    matches.forEach(r => { const loc = String(r[4]).trim(); const qty = parseInt(r[3]) || 0; if (qty > 0) locMap[loc] = (locMap[loc] || 0) + qty; });

    const globalUsage = getGlobalUsageMap(row);
    let usedLocs = new Set();
    if (globalUsage[cardNo] && globalUsage[cardNo][illust] && globalUsage[cardNo][illust][rare]) {
        usedLocs = globalUsage[cardNo][illust][rare];
    }

    const validLocs = [];
    Object.keys(locMap).forEach(loc => {
        if (!usedLocs.has(loc)) {
            validLocs.push({ val: loc, text: `${loc} (보유: ${locMap[loc]})`, max: locMap[loc] });
        }
    });
    validLocs.sort((a, b) => a.val.localeCompare(b.val));
    wrap.dataset.options = JSON.stringify(validLocs);

    if (validLocs.length <= 1) wrap.classList.add('single-option');
    else wrap.classList.remove('single-option');
}

function handleDiscardLocChange(input) {
    const row = getRowFromInput(input);
    const target = getQueryTarget(row);
    const qtyInput = target.querySelector('.discard-card-qty, [data-field="qty"]');
    const maxQty = parseInt(input.dataset.maxQty) || 0;
    if (!input.value) { 
        if (qtyInput) {
            qtyInput.value = ""; qtyInput.setAttribute('readonly', true); 
        }
        if (document.documentElement.classList.contains('is-mobile-device')) {
            renderMobileCards();
        }
        return; 
    }
    const rareInput = target.querySelector('.discard-card-rarity, [data-field="rare"]');
    const isRareEntered = rareInput && (rareInput.dataset.raw || rareInput.value.trim()).length > 0;

    if (maxQty > 0 && isRareEntered) {
        if (qtyInput) {
            qtyInput.removeAttribute('readonly');
            qtyInput.max = maxQty;
            qtyInput.placeholder = `최대 ${maxQty}`;
            const currentQty = parseInt(qtyInput.value);
            if (!isNaN(currentQty) && currentQty > maxQty) {
                qtyInput.value = maxQty;
            }
        }
    } else {
        if (qtyInput) {
            qtyInput.value = "";
            qtyInput.placeholder = "재고 없음";
            qtyInput.setAttribute('readonly', true);
        }
    }

    if (document.documentElement.classList.contains('is-mobile-device')) {
        renderMobileCards();
    }
}

function getGlobalUsageMap(excludeRow) {
    const usage = {};
    const isMove = (UIStore.mode === 'move');
    const isDiscard = (UIStore.mode === 'discard');
    if (!isMove && !isDiscard) return usage;

    const isMobile = document.documentElement.classList.contains('is-mobile-device');
    const listContainerId = isMobile 
        ? (isMove ? 'mobile-cards-list-move' : 'mobile-cards-list-discard')
        : (isMove ? 'desktop-cards-list-move' : 'desktop-cards-list-discard');
    const cardClass = isMobile ? '.mobile-info-card[data-index]' : '.desktop-info-card[data-index]';

    const listContainer = document.getElementById(listContainerId);
    if (!listContainer) return usage;

    const cards = listContainer.querySelectorAll(cardClass);
    cards.forEach(card => {
        if (card === excludeRow) return;
        const data = getDesktopCardData(card);
        if (data.cardNo && data.illustration && data.rarity && data.loc) {
            const no = data.cardNo;
            const illust = data.illustration;
            const rare = data.rarity;
            const loc = data.loc;
            if (!usage[no]) usage[no] = {};
            if (!usage[no][illust]) usage[no][illust] = {};
            if (!usage[no][illust][rare]) usage[no][illust][rare] = new Set();
            usage[no][illust][rare].add(loc);
        }
    });
    return usage;
}

function checkDiscardIllustAvailability(cardNo, illust, excludeRow) {
    const matches = cardCacheInstance.getInventory().filter(r => String(r[1]).trim().toUpperCase() === cardNo && String(r[5] || "기본").trim() === illust);
    const uniqueRares = [...new Set(matches.map(r => String(r[2]).trim()))];
    return uniqueRares.some(rare => checkDiscardRareAvailability(cardNo, illust, rare, excludeRow));
}

function checkDiscardRareAvailability(cardNo, illust, rare, currentRow) {
    const dbMatches = cardCacheInstance.getInventory().filter(r => String(r[1]).trim().toUpperCase() === cardNo && String(r[5] || "기본").trim() === illust && String(r[2]).trim() === rare);
    const dbLocs = new Set(dbMatches.map(r => String(r[4]).trim()));

    const globalUsage = getGlobalUsageMap(currentRow);
    let usedLocs = new Set();
    if (globalUsage[cardNo] && globalUsage[cardNo][illust] && globalUsage[cardNo][illust][rare]) {
        usedLocs = globalUsage[cardNo][illust][rare];
    }

    for (let loc of dbLocs) {
        if (!usedLocs.has(loc)) return true;
    }
    return false;
}

function isCardDepleted(cardNo, excludeRow) {
    const matches = cardCacheInstance.getInventory().filter(r => String(r[1]).trim().toUpperCase() === cardNo);
    if (matches.length === 0) return true;

    const uniqueIllusts = [...new Set(matches.map(r => String(r[5] || "기본").trim()))];
    return !uniqueIllusts.some(illust => checkDiscardIllustAvailability(cardNo, illust, excludeRow));
}

function handleAddLocChange(input) {
    const row = getRowFromInput(input);
    if (!row) return;
}


function getActiveContainer(el) {
    if (!el) return null;
    return el.closest('.desktop-info-card') || el.closest('.mobile-info-card') || el.closest('#mobile-entry-bottom-sheet');
}


function handleCardNameInput(input) {
    if (input.hasAttribute('readonly')) return;
    const row = getRowFromInput(input);
    if (!row) return;

    const container = getActiveContainer(input);
    if (!container) return;

    const clearBtn = container.querySelector('.clear-name-btn') || input.parentNode.querySelector('.clear-name-btn');
    const nameVal = input.value.trim();

    if (clearBtn && !clearBtn.closest('.desktop-info-card--editable')) clearBtn.hidden = !nameVal;

    const isMove = !!container.querySelector('.move-card-no') || !!container.querySelector('.desktop-card-to');
    const isDiscard = !!container.querySelector('.discard-card-no') || (UIStore.mode === 'discard' && !!container.closest('.desktop-info-card'));
    const noClass = isMove ? '.move-card-no, .desktop-card-no' : (isDiscard ? '.discard-card-no, .desktop-card-no' : '.page-card-no, .desktop-card-no');
    const noInput = container.querySelector(noClass);

    if (!input.dataset.programmatic) {
        if (noInput && !noInput.dataset.lockedForName) {
            noInput.dataset.programmatic = "true";
            noInput.value = "";
            handleCardNoInput(noInput);
            delete noInput.dataset.programmatic;
        }

        if (isMove) {
            resetMoveRow(row, 'no');
        } else if (isDiscard) {
            resetDiscardRow(row, 'no');
        }
    }


}

function handleCardNoInput(input) {
    if (input.value === "(번호 없음)") return;
    const row = getRowFromInput(input);
    if (!row) return;

    const container = getActiveContainer(input);
    if (!container) return;

    const isMove = !!container.querySelector('.move-card-no') || !!container.querySelector('.desktop-card-to');
    const isDiscard = !!container.querySelector('.discard-card-no') || (UIStore.mode === 'discard' && !!container.closest('.desktop-info-card'));

    const start = input.selectionStart;
    if (!globalThis.AppBackend?.isQualifiedNumber?.(input.value)) {
        input.value = input.value.replace(/[ㄱ-ㅎ|ㅏ-ㅣ|가-힣]/g, '').toUpperCase();
    }
    input.setSelectionRange(start, start);

    if (isMove || isDiscard) {
        const cardNo = input.value.trim().toUpperCase();
        if (!cardNo) {
            if (isMove) resetMoveRow(row, 'no');
            else resetDiscardRow(row, 'no');
            if (row && row !== container) {
                // 실시간 동기화 생략
            }
            return;
        }
        const matches = cardCacheInstance.getInventory().filter(r => String(r[1]).trim().toUpperCase() === cardNo);
        if (matches.length > 0) {
            if (isMove) updateMoveIllusts(row, matches);
            else updateDiscardIllusts(row, matches);
        } else {
            if (isMove) resetMoveRow(row, 'no');
            else resetDiscardRow(row, 'no');
        }
    }


}

function handleCardQtyInput(input) {
    const row = getRowFromInput(input);
    const container = getActiveContainer(input);
    if (!row || !container) return;

    let val = parseInt(input.value) || 1;
    if (val < 1) val = 1;
    if (input.max) {
        const maxVal = parseInt(input.max);
        if (!isNaN(maxVal) && val > maxVal) val = maxVal;
    }
    input.value = val;


}

function clearPageNameAndNo(btn_or_input) {
    IllustrationPicker.close(false, false);
    const container = getActiveContainer(btn_or_input);
    if (!container) return;
    const row = getRowFromInput(btn_or_input);

    const isMove = !!container.querySelector('.move-card-no') || !!container.querySelector('.desktop-card-to');
    const isDiscard = !!container.querySelector('.discard-card-no') || (UIStore.mode === 'discard' && !!container.closest('.desktop-info-card'));

    const nameInput = container.querySelector('[data-field="name"]');
    const noInput = container.querySelector('[data-field="no"]');

    if (container) {
        delete container.dataset.searchMode;
        delete container.dataset.cardData;
        delete container.dataset.illustrationCid;
    }
    if (row) {
        delete row.dataset.searchMode;
        delete row.dataset.cardData;
        delete row.dataset.illustrationCid;
    }

    if (nameInput) {
        nameInput.dataset.programmatic = "true";
        nameInput.value = "";
        nameInput.removeAttribute('readonly');
        nameInput.classList.remove('hyperlink-style', 'error-placeholder');
        if (!nameInput.closest('.desktop-info-card--editable')) {
            nameInput.classList.remove('is-card-retry');

        }
        nameInput.placeholder = "카드 이름";
        nameInput.onclick = null;
        nameInput.dataset.prevName = "";
        delete nameInput.dataset.programmatic;
    }

    if (noInput) {
        registrationNumberSelections.delete(noInput);
        noInput.dataset.programmatic = "true";
        noInput.value = "";
        noInput.removeAttribute('readonly');
        noInput.placeholder = "카드 번호";
        noInput.onclick = null;
        delete noInput.dataset.lockedForName;
        delete noInput.dataset.errorRetry;
        delete noInput.dataset.prevCardNo;

        handleCardNoInput(noInput);
        delete noInput.dataset.programmatic;
    }

    const noWrap = noInput ? noInput.closest('.custom-select-wrapper') : null;
    if (noWrap) {
        noWrap.classList.add('no-arrow');
        noWrap.dataset.options = "[]";
        const arrow = noWrap.querySelector('.arrow-icon');
        if (arrow && !noWrap.closest('.desktop-info-card--editable')) arrow.hidden = true;
        noWrap.classList.add('no-option');
        noWrap.classList.remove('single-option');
    }

    if (isMove) {
        resetMoveRow(row || container, 'no');
    } else if (isDiscard) {
        resetDiscardRow(row || container, 'no');
    }

    const clearBtn = container.querySelector('.clear-name-btn') || (btn_or_input.classList && btn_or_input.classList.contains('clear-name-btn') ? btn_or_input : null);
    if (clearBtn && !clearBtn.closest('.desktop-info-card--editable')) clearBtn.hidden = true;


}

async function fetchCardByName(input, force = false, confirmedCid = null, unresolvedDeckName = false, matchedNumber = null) {
    if (!input) return;
    if (!force && input.hasAttribute('readonly')) return;

    const container = getActiveContainer(input);
    if (!container) return;
    const row = getRowFromInput(input);

    const isMove = !!container.querySelector('.move-card-no') || !!container.querySelector('.desktop-card-to');
    const isDiscard = !!container.querySelector('.discard-card-no') || (UIStore.mode === 'discard' && !!container.closest('.desktop-info-card'));
    const mode = isMove ? 'move' : (isDiscard ? 'discard' : 'add');

    if (container.dataset.searchMode === "number") return;
    container.dataset.searchMode = "name";
    if (row) row.dataset.searchMode = "name";

    const nameVal = input.value.trim();
    const prevName = input.dataset.prevName || "";

    const nameInput = container.querySelector('[data-field="name"]') || input;
    const noInput = container.querySelector('[data-field="no"]');
    const noWrap = noInput ? noInput.closest('.custom-select-wrapper') : null;

    if (!nameVal) {
        clearPageNameAndNo(input);
        return;
    }

    if (prevName === nameVal) return;
    input.dataset.prevName = nameVal;

    if (noInput) {
        noInput.setAttribute('readonly', true);
        noInput.placeholder = "검색 중...";
        noInput.value = "";
        noInput.dataset.lockedForName = "true";
    }

    const illustInp = container.querySelector('[data-field="illust"]');
    const rareInp = container.querySelector('[data-field="rare"]');
    const locInp = container.querySelector('[data-field="loc"]');
    const qtyInp = container.querySelector('[data-field="qty"]');

    if (rareInp) { 
        rareInp.value = ""; 
        rareInp.setAttribute('readonly', true); 
        const wrap = rareInp.closest('.custom-select-wrapper');
        if (wrap) { wrap.dataset.options = "[]"; wrap.classList.remove('single-option'); wrap.classList.add('no-option'); }
    }
    if (illustInp) { 
        setIllustrationValue(illustInp, "");
        illustInp.setAttribute('readonly', true); 
        const wrap = illustInp.closest('.custom-select-wrapper');
        if (wrap) { wrap.dataset.options = "[]"; wrap.classList.remove('single-option'); wrap.classList.add('no-option'); }
    }
    if (qtyInp) {
        qtyInp.setAttribute('readonly', true);
        qtyInp.value = "";
    }
    if (locInp) {
        locInp.value = "";
        if (mode === 'add') locInp.removeAttribute('readonly');
        else locInp.setAttribute('readonly', true);
        const wrap = locInp.closest('.custom-select-wrapper');
        if (wrap) { wrap.dataset.options = "[]"; wrap.classList.remove('single-option'); wrap.classList.add('no-option'); }
    }



    try {
        if (noWrap) {
            noWrap.classList.add('no-arrow', 'no-option');
            noWrap.dataset.options = "[]";
            const arrow = noWrap.querySelector('.arrow-icon');
            if (arrow && !noWrap.closest('.desktop-info-card--editable')) arrow.hidden = true;
        }

        let res = null;

        if (mode === 'add') {
            res = unresolvedDeckName ? { isError: true, isNotFoundError: true }
                : await callApi('searchCardByName', { name: nameVal, ...(confirmedCid && globalThis.AppBackend ? { cid: confirmedCid, ...(matchedNumber ? { matchedNumber } : {}) } : {}) });
        } else {
            const ownedNames = cardCacheInstance.getOwnedNamesSet();
            if (!ownedNames.has(nameVal)) {
                res = { isError: true, isNotFoundError: true };
            } else {
                const nosByName = cardCacheInstance.getNosByName(nameVal);
                const validNos = nosByName.filter(no => isMove ? !isMoveCardDepleted(no, row || container) : !isCardDepleted(no, row || container));
                if (validNos.length === 0) {
                    res = { isError: true, isDepleted: true };
                } else {
                    const cid = findCidByNameOrNo(nameVal) || null;
                    const inventory = cardCacheInstance.getInventory().filter(r => r[0] === nameVal);
                    const raritiesByNo = {};
                    inventory.forEach(r => {
                        const no = String(r[1]).toUpperCase();
                        const rare = String(r[2]).trim();
                        if (!raritiesByNo[no]) raritiesByNo[no] = ["", rare];
                        else if (!raritiesByNo[no].includes(rare)) raritiesByNo[no].push(rare);
                    });
                    res = {
                        success: true,
                        name: nameVal,
                        numbers: validNos,
                        illustrationCount: 1,
                        linkData: { id: cid, locale: UIStore.currentRegion },
                        raritiesByNo: raritiesByNo
                    };
                }
            }
        }

        if (input.value.trim() !== nameVal) return;

        if (res.isError || res.status === 'error') {
            let errorMsg = "카드 이름 확인";
            if (res.isDepleted) errorMsg = "모두 선택됨";
            else if (res.isNetworkError) errorMsg = "검색 오류";

            // 에러 시 lockedForName 잔류 방지 (미해제 시 이후 번호 입력 차단 버그)
            if (noInput) delete noInput.dataset.lockedForName;

            noInput.placeholder = errorMsg;
            noInput.dataset.errorRetry = "true";

            input.removeAttribute('readonly');
            input.classList.remove('hyperlink-style');
            if (!input.closest('.desktop-info-card--editable')) {
                input.classList.remove('is-card-retry');

            }

            input.dataset.prevName = "";
            if (nameInput) nameInput.dataset.prevName = "";

            noInput.onclick = () => {
                if (noInput.dataset.errorRetry) {
                    input.dataset.prevName = "";
                    if (nameInput) nameInput.dataset.prevName = "";
                    fetchCardByName(input);
                }
            };
            return;
        }

        lockNameInputAndSetLink(nameInput, res.name, container, res.linkData);

        const cardDataPayload = {
            name: res.name,
            numbers: res.numbers,
            illustrations: res.illustrations,
            illustrationCount: res.illustrationCount,
            raritiesByNo: res.raritiesByNo,
            linkData: res.linkData
        };
        prepareCardIllustrations(container, res.linkData?.id, res.illustrations || []);

        if (container) {
            container.dataset.cardData = JSON.stringify(cardDataPayload);
        }

        if (row) {
            row.dataset.cardData = JSON.stringify(cardDataPayload);
        }

        if (mode === 'add' && res.rarityMappingRaw) {
            rarityMappingRaw = res.rarityMappingRaw;
            const headers = rarityMappingRaw[0];
            rarityColMap = {};
            headers.forEach((h, i) => rarityColMap[h] = i);
            rarityRows = rarityMappingRaw.slice(1);
            rarityReverseMap = {};
            rarityOrderMap = {};
            rarityRows.forEach((r, index) => {
                const id = r[0];
                if (id) {
                    rarityOrderMap[id] = index;
                    r.forEach(cellVal => { if (cellVal) rarityReverseMap[cellVal] = index; });
                }
            });
            CardDataStore.allProcessingTypes = rarityRows.map(r => r[0]).filter(Boolean).filter(r => r !== "레어도" && r !== "Rarity");
        }

        const numbers = res.numbers || [];

        setupNumberDropdownAndUnlock(noInput, numbers, container, (selectedInput) => {
            if (mode === 'add') {
                handleCardNoInput(selectedInput);
                const selNo = selectedInput.value;
                const selRarities = (res.raritiesByNo && res.raritiesByNo[selNo])
                    ? res.raritiesByNo[selNo]
                    : (res.rarities || []);
                applyPageCardDataToRows({
                    name: res.name,
                    numbers: numbers,
                    illustrations: res.illustrations,
                    illustrationCount: res.illustrationCount,
                    rarities: selRarities,
                    raritiesByNo: res.raritiesByNo || {},
                    cardNo: selNo,
                    isFallback: false,
                    linkData: res.linkData
                }, container);
            } else if (mode === 'move') {
                handleCardNoInput(selectedInput);
            } else {
                handleCardNoInput(selectedInput);
            }
        });

        if (numbers.length === 1) {
            noInput.value = numbers[0];
            noInput.setAttribute('readonly', true);
            if (mode === 'add') {
                await fetchCardByNumber(noInput);
                const singleNo = numbers[0];
                const singleRarities = (res.raritiesByNo && res.raritiesByNo[singleNo])
                    ? res.raritiesByNo[singleNo]
                    : (res.rarities || []);
                applyPageCardDataToRows({
                    name: res.name,
                    numbers: numbers,
                    illustrations: res.illustrations,
                    illustrationCount: res.illustrationCount,
                    rarities: singleRarities,
                    raritiesByNo: res.raritiesByNo || {},
                    cardNo: singleNo,
                    isFallback: false,
                    linkData: res.linkData
                }, container);
            } else if (mode === 'move') {
                handleCardNoInput(noInput);
            } else {
                handleCardNoInput(noInput);
            }
        } else if (numbers.length > 1) {
            if (document.activeElement === noInput) {
                noInput.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            }
        }



    } catch (e) {
        console.error("fetchCardByName error:", e);
        if (input.value.trim() !== nameVal) return;
        // 예외 발생 시 lockedForName 잔류 방지
        if (noInput) delete noInput.dataset.lockedForName;
        noInput.placeholder = "검색 오류 (클릭재시도)";
        noInput.dataset.errorRetry = "true";
        noInput.onclick = () => {
            if (noInput.dataset.errorRetry) {
                input.dataset.prevName = "";
                if (nameInput) nameInput.dataset.prevName = "";
                fetchCardByName(input);
            }
        };
    }
}

function updateSubCellsFromCache(cardNo, row_or_container) {
    const container = getActiveContainer(row_or_container) || row_or_container;
    const row = getRowFromInput(container);
    let cardDataStr = container.dataset.cardData || (row ? row.dataset.cardData : null);

    if (cardDataStr) {
        try {
            const data = JSON.parse(cardDataStr);
            // 팩명·언어가 붙은 번호도 같은 발매 조합으로 판정한다.
            // 표시용 캐시 키의 대소문자 차이 때문에 이전 선택지가 남지 않도록 한다.
            const options = UIStore.mode === 'add'
                ? globalThis.AppBackend?.getRegistrationOptions?.(data.linkData?.id, cardNo)
                : null;
            if (options) {
                applyPageCardDataToRows({ ...data, ...options, cardNo, isFallback: false }, container);
                return;
            }
            const hasSpecificData = data.raritiesByNo && data.raritiesByNo[cardNo];

            if (hasSpecificData || data.cardNo === cardNo || (data.numbers && data.numbers.includes(cardNo))) {
                const rarities = hasSpecificData
                ? data.raritiesByNo[cardNo]
                : (data.rarities && data.rarities.length > 0)
                    ? data.rarities
                    : (data.raritiesByNo && data.raritiesByNo[cardNo] ? data.raritiesByNo[cardNo] : []);
                const finalData = {
                    ...data,
                    cardNo: cardNo,
                    rarities: rarities,
                    isFallback: false
                };

                applyPageCardDataToRows(finalData, container);
                return;
            }
        } catch (e) { }
    }

    if (cardNo) {
        const noInput = container.querySelector('[data-field="no"]');
        if (noInput && !noInput.dataset.lockedForName) {
            fetchCardByNumber(noInput);
            return;
        }
    }

    const anotherInp = container.querySelector('[data-field="illust"]');
    const illustrationWrap = anotherInp ? anotherInp.closest('.custom-select-wrapper') : null;
    const rarityInp = container.querySelector('[data-field="rare"]');
    const rarityWrap = rarityInp ? rarityInp.closest('.custom-select-wrapper') : null;

    if (rarityInp) { rarityInp.value = ""; rarityInp.setAttribute('readonly', true); }
    if (rarityWrap) { rarityWrap.dataset.options = "[]"; rarityWrap.classList.remove('single-option'); rarityWrap.classList.add('no-option'); }
    if (anotherInp) { setIllustrationValue(anotherInp, ""); anotherInp.setAttribute('readonly', true); }
    if (illustrationWrap) { illustrationWrap.dataset.options = "[]"; illustrationWrap.classList.remove('single-option'); illustrationWrap.classList.add('no-option'); }
}

function lockNameInputAndSetLink(nameInput, name, container, linkData = null) {
    if (!nameInput) return;
    resetNameInputForSearchFunc(nameInput, container);
    nameInput.dataset.programmatic = "true";
    nameInput.value = name;
    
    const finalLinkId = linkData?.id || findCidByNameOrNo(name);

    if (finalLinkId && finalLinkId !== "MISSING_CID") {
        prepareCardIllustrations(container, finalLinkId);
        nameInput.classList.add('hyperlink-style');
        nameInput.onclick = function(event) {
            event?.stopPropagation();
            void renderTargetByCid(String(finalLinkId));
        };
    }
    
    nameInput.setAttribute('readonly', true);
    delete nameInput.dataset.programmatic;
    
    const clearBtn = container.querySelector('.clear-name-btn');
    if (clearBtn && !clearBtn.closest('.desktop-info-card--editable')) clearBtn.hidden = false;
}

function setupNumberDropdownAndUnlock(noInput, numbers, container, onSelectCallback) {
    if (!noInput) return;
    noInput.removeAttribute('readonly');
    delete noInput.dataset.lockedForName;
    delete noInput.dataset.errorRetry;
    noInput.onclick = null;
    noInput.placeholder = "카드 번호";

    const noWrap = noInput.closest('.custom-select-wrapper');
    if (noWrap) {
        noWrap.classList.remove('no-option');
        const options = numbers.map(n => ({ val: n, text: n }));
        noWrap.dataset.options = JSON.stringify(options);

        if (numbers.length > 1) {
            noWrap.classList.remove('no-arrow');
            setupCustomDropdown(noWrap, (selectedInput) => {
                onSelectCallback(selectedInput);
            });
            const arrow = noWrap.querySelector('.arrow-icon');
            if (arrow && !noWrap.closest('.desktop-info-card--editable')) {
                arrow.hidden = false;

            }
        } else {
            noWrap.classList.add('no-arrow');
            const arrow = noWrap.querySelector('.arrow-icon');
            if (arrow && !noWrap.closest('.desktop-info-card--editable')) {
                arrow.hidden = true;

            }
        }
    }
}

function resetNameInputForSearchFunc(nameInput, container) {
    if (!nameInput) return;
    nameInput.dataset.programmatic = "true";
    nameInput.value = "";
    nameInput.placeholder = "카드 이름";
    nameInput.removeAttribute('readonly');
    nameInput.classList.remove('hyperlink-style', 'error-placeholder');
    if (!nameInput.closest('.desktop-info-card--editable')) {
        nameInput.classList.remove('is-card-retry');

    }
    nameInput.onclick = null;
    delete nameInput.dataset.programmatic;
    const clearBtn = container.querySelector('.clear-name-btn');
    if (clearBtn && !clearBtn.closest('.desktop-info-card--editable')) clearBtn.hidden = true;
}

async function fetchCardByNumber(input, force = false) {
    if (!input) return;
    if (!force && input.hasAttribute('readonly')) return;
    if (input.dataset.lockedForName === "true") return;
    if (input.dataset.invalidInput === "true") {
        delete input.dataset.invalidInput;
        return;
    }

    const container = getActiveContainer(input);
    if (!container) return;
    const row = getRowFromInput(input);

    const isMove = !!container.querySelector('.move-card-no') || !!container.querySelector('.desktop-card-to');
    const isDiscard = !!container.querySelector('.discard-card-no') || (UIStore.mode === 'discard' && !!container.closest('.desktop-info-card'));
    const mode = isMove ? 'move' : (isDiscard ? 'discard' : 'add');



    let searchMode = container.dataset.searchMode;
    const nameInput = container.querySelector('[data-field="name"]');
    const cardNo = input.value.trim().toUpperCase();

    const prevCardNo = input.dataset.prevCardNo;
    if (prevCardNo === cardNo) return;
    input.dataset.prevCardNo = cardNo;

    if (searchMode === "name") {
        if (mode === 'add') {
            updateSubCellsFromCache(cardNo, container);
        } else if (mode === 'move') {
            handleCardNoInput(input);
        } else {
            handleCardNoInput(input);
        }
        return;
    }

    if (!searchMode && cardNo !== "") {
        searchMode = "number";
        container.dataset.searchMode = "number";
        if (row) row.dataset.searchMode = "number";
    }

    if (searchMode === "number") {
        if (!cardNo) {
            if (mode === 'add') {
                updateSubCellsFromCache("", container);
            } else if (mode === 'move') {
                resetMoveRow(row || container, 'no');
            } else {
                resetDiscardRow(row || container, 'no');
            }
            return;
        }
    } else {
        if (!cardNo) return;
    }

    if (mode !== 'add') {
        if (!cardCacheInstance.getOwnedNumbers().includes(cardNo)) {
            input.value = ""; 
            input.placeholder = "번호 확인!"; 
            input.classList.add('error-placeholder');
            setTimeout(() => { 
                input.placeholder = "카드 번호"; 
                input.classList.remove('error-placeholder'); 
            }, 5000);
            if (isMove) resetMoveRow(row || container, 'no');
            else resetDiscardRow(row || container, 'no');
            return;
        }

        if (isMove ? isMoveCardDepleted(cardNo, row || container) : isCardDepleted(cardNo, row || container)) {
            input.value = ""; 
            input.placeholder = "모두 선택됨"; 
            input.classList.add('error-placeholder');
            setTimeout(() => { 
                input.placeholder = "카드 번호"; 
                input.classList.remove('error-placeholder'); 
            }, 5000);
            if (isMove) resetMoveRow(row || container, 'no');
            else resetDiscardRow(row || container, 'no');
            return;
        }

        const matches = cardCacheInstance.getInventory().filter(r => String(r[1]).trim().toUpperCase() === cardNo);
        if (matches.length > 0) {
            const name = matches[0][0];
            lockNameInputAndSetLink(nameInput, name, container);

            // [보완] 백그라운드 비동기 조회를 통해 카드 상세 정보(CID 등)를 가져와 하이퍼링크 입혀주기
            const detail = cardCacheInstance.getDetailByName(name);
            if (detail && detail.linkData) {
                lockNameInputAndSetLink(nameInput, name, container, detail.linkData);
            } else {
                callApi('searchCardByName', { name }).then(res => {
                    if (res && res.success && res.linkData) {
                        if (nameInput.value === name) {
                            lockNameInputAndSetLink(nameInput, name, container, res.linkData);
                        }
                    }
                }).catch(err => console.error("Failed to fetch linkData in background:", err));
            }
            
            const nosByName = cardCacheInstance.getNosByName(name);
            const validNos = nosByName.filter(no => isMove ? !isMoveCardDepleted(no, row || container) : !isCardDepleted(no, row || container));

            setupNumberDropdownAndUnlock(input, validNos, container, (selected) => {
                handleCardNoInput(selected);
            });

            if (validNos.length === 1) {
                input.setAttribute('readonly', true);
            }

            if (isMove) {
                updateMoveIllusts(row || container, matches);
            } else {
                updateDiscardIllusts(row || container, matches);
            }
        }
        return;
    }

    const cached = mode !== 'add' ? cardCacheInstance.getDetailByNo(cardNo) : null;
    if (cached) {
        const name = cached.name;
        lockNameInputAndSetLink(nameInput, name, container, cached.linkData);

        const numbersSet = ClientCache._nameToNos[name];
        let numbers = numbersSet ? Array.from(numbersSet) : [];
        const detail = cardCacheInstance.getDetailByName(name) || {};
        if (detail.raritiesByNo) {
            Object.keys(detail.raritiesByNo).forEach(no => {
                if (!numbers.includes(no)) numbers.push(no);
            });
        }
        if (cardNo && !numbers.includes(cardNo)) {
            numbers.push(cardNo);
        }

        if (row) {
            const raritiesForCard = (cached.rarities && cached.rarities.length > 0)
                ? cached.rarities
                : (detail.raritiesByNo && detail.raritiesByNo[cardNo] ? detail.raritiesByNo[cardNo] : []);
            row.dataset.cardData = JSON.stringify({
                name: name,
                numbers: numbers,
                illustrationCount: cached.illustrationCount || detail.illustrationCount || 0,
                rarities: raritiesForCard,
                raritiesByNo: detail.raritiesByNo || {},
                linkData: cached.linkData
            });
        }

        setupNumberDropdownAndUnlock(input, numbers, container, (selectedInput) => {
            handleCardNoInput(selectedInput);
            const selNo = selectedInput.value;
            const selRarities = (detail.raritiesByNo && detail.raritiesByNo[selNo])
                ? detail.raritiesByNo[selNo]
                : (cached.rarities || []);
            applyPageCardDataToRows({
                name: name,
                numbers: numbers,
                illustrationCount: cached.illustrationCount || detail.illustrationCount || 0,
                rarities: selRarities,
                raritiesByNo: detail.raritiesByNo || {},
                cardNo: selNo,
                isFallback: false,
                linkData: cached.linkData
            }, container);
        });

        if (numbers.length === 1) {
            input.setAttribute('readonly', true);
        }

        applyPageCardDataToRows({
            name: name,
            numbers: numbers,
            illustrationCount: cached.illustrationCount || detail.illustrationCount || 0,
            rarities: raritiesForCard,
            raritiesByNo: detail.raritiesByNo || {},
            cardNo: cardNo,
            isFallback: false,
            linkData: cached.linkData
        }, container);
        const clearBtn = container.querySelector('.clear-name-btn');
        if (clearBtn && nameInput && nameInput.value && !clearBtn.closest('.desktop-info-card--editable')) clearBtn.hidden = false;
        return;
    }

    resetNameInputForSearchFunc(nameInput, container);
    if (nameInput) {
        nameInput.dataset.programmatic = "true";
        nameInput.placeholder = "조회 중...";
        nameInput.setAttribute('readonly', true);
        delete nameInput.dataset.programmatic;
    }

    updateSubCellsFromCache("", container);

    try {
        const res = await callApi('searchCardByNo', { cardNo });
        if (input.value.trim() !== cardNo) return;

        if (res.isError) {
            resetNameInputForSearchFunc(nameInput, container);
            const errorMsg = "카드 번호 확인 (클릭하여 재시도)";

            if (nameInput) {
                nameInput.dataset.programmatic = "true";
                nameInput.placeholder = errorMsg;
                nameInput.classList.add('error-placeholder');
                nameInput.setAttribute('readonly', true);

                if (res.name.includes("서버가 바쁩니다")) {
                    nameInput.placeholder = "과부하: 3초후 재시도...";
                    input.dataset.prevCardNo = "";
                    setTimeout(() => {
                        fetchCardByNumber(input);
                    }, 3000);
                }

                if (!nameInput.closest('.desktop-info-card--editable')) nameInput.classList.add('is-card-retry');
                nameInput.onclick = () => {
                    input.dataset.prevCardNo = '';
                    fetchCardByNumber(input);
                };
                delete nameInput.dataset.programmatic;
            }
            return;
        }

        if (res.name.includes("오류") || res.name.includes("확인하세요")) {
            resetNameInputForSearchFunc(nameInput, container);
            const errorMsg = "카드 번호 확인 (클릭하여 재시도)";

            if (nameInput) {
                nameInput.dataset.programmatic = "true";
                nameInput.placeholder = errorMsg;
                nameInput.classList.add('error-placeholder');
                nameInput.setAttribute('readonly', true);
                if (!nameInput.closest('.desktop-info-card--editable')) nameInput.classList.add('is-card-retry');
                nameInput.onclick = () => {
                    input.dataset.prevCardNo = '';
                    fetchCardByNumber(input);
                };
                delete nameInput.dataset.programmatic;
            }

            input.dataset.programmatic = "true";
            input.value = "";
            input.placeholder = errorMsg;
            input.classList.add('error-placeholder');
            delete input.dataset.programmatic;

            input.dataset.errorRetry = "true";
            if (!input.closest('.desktop-info-card--editable')) input.classList.add('is-card-retry');
            input.onclick = () => {
                if (input.dataset.errorRetry) {
                    input.dataset.prevCardNo = "";
                    input.dataset.programmatic = "true";
                    input.placeholder = "카드 번호";
                    input.classList.remove('error-placeholder');
                    if (!input.closest('.desktop-info-card--editable')) input.classList.remove('is-card-retry');
                    delete input.dataset.programmatic;
                    fetchCardByNumber(input);
                }
            };
        } else {
            if (res.rarityMappingRaw) {
                rarityMappingRaw = res.rarityMappingRaw;
                const headers = rarityMappingRaw[0];
                rarityColMap = {};
                headers.forEach((h, i) => rarityColMap[h] = i);
                rarityRows = rarityMappingRaw.slice(1);
                rarityReverseMap = {};
                rarityOrderMap = {};
                rarityRows.forEach((row, index) => {
                    const id = row[0];
                    if (id) {
                        rarityOrderMap[id] = index;
                        row.forEach(cellVal => {
                            if (cellVal) rarityReverseMap[cellVal] = index;
                        });
                    }
                });
                CardDataStore.allProcessingTypes = rarityRows.map(r => r[0]).filter(Boolean).filter(r => r !== "레어도" && r !== "Rarity");
            }

            lockNameInputAndSetLink(nameInput, res.name, container, res.linkData);

            const numbersSet = ClientCache._nameToNos[res.name];
            let numbers = numbersSet ? Array.from(numbersSet) : [];
            if (res.raritiesByNo) {
                Object.keys(res.raritiesByNo).forEach(no => {
                    if (!numbers.includes(no)) numbers.push(no);
                });
            }
            if (cardNo && !numbers.includes(cardNo)) {
                numbers.push(cardNo);
            }

            const rarities = (res.rarities && res.rarities.length > 0)
                ? res.rarities
                : (res.raritiesByNo && res.raritiesByNo[cardNo] ? res.raritiesByNo[cardNo] : []);

            if (row) {
                row.dataset.cardData = JSON.stringify({
                    name: res.name,
                    numbers: numbers,
                    illustrations: res.illustrations,
                    illustrationCount: res.illustrationCount,
                    rarities: rarities,
                    raritiesByNo: res.raritiesByNo || {},
                    linkData: res.linkData
                });
            }

            setupNumberDropdownAndUnlock(input, numbers, container, (selectedInput) => {
                handleCardNoInput(selectedInput);
                const selNo = selectedInput.value;
                const selRarities = (res.raritiesByNo && res.raritiesByNo[selNo])
                    ? res.raritiesByNo[selNo]
                    : (res.rarities || []);
                applyPageCardDataToRows({
                    name: res.name,
                    numbers: numbers,
                    illustrations: res.illustrations,
                    illustrationCount: res.illustrationCount,
                    rarities: selRarities,
                    raritiesByNo: res.raritiesByNo || {},
                    cardNo: selNo,
                    isFallback: false,
                    linkData: res.linkData
                }, container);
            });

            if (numbers.length === 1) {
                input.setAttribute('readonly', true);
            }

            applyPageCardDataToRows({
                name: res.name,
                numbers: numbers,
                illustrations: res.illustrations,
                illustrationCount: res.illustrationCount,
                rarities: rarities,
                raritiesByNo: res.raritiesByNo || {},
                cardNo: cardNo,
                isFallback: false,
                linkData: res.linkData
            }, container);
            const clearBtn = container.querySelector('.clear-name-btn');
            if (clearBtn && nameInput && nameInput.value && !clearBtn.closest('.desktop-info-card--editable')) clearBtn.hidden = false;
        }
    } catch (e) {
        if (input.value.trim() !== cardNo) return;
        resetNameInputForSearchFunc(nameInput, container);
        if (nameInput) {
            nameInput.dataset.programmatic = "true";
            nameInput.placeholder = "접속 오류(클릭재시도)";
            nameInput.classList.add('error-placeholder');
            nameInput.setAttribute('readonly', true);
            if (!nameInput.closest('.desktop-info-card--editable')) nameInput.classList.add('is-card-retry');
            nameInput.onclick = () => {
                input.dataset.prevCardNo = '';
                fetchCardByNumber(input);
            };
            delete nameInput.dataset.programmatic;
        }
    }
}

function applyPageCardDataToRows(data, row_or_container) {
    const container = getActiveContainer(row_or_container) || row_or_container;
    if (!data || !container) return;

    if (UIStore.mode === 'add' && globalThis.AppBackend?.getRegistrationOptions) {
        const cardNo = container.querySelector('[data-field="no"]')?.value ?? data.cardNo ?? '';
        const options = globalThis.AppBackend.getRegistrationOptions(data.linkData?.id, cardNo);
        if (options) data = { ...data, ...options };
    }

    container.dataset.cardData = JSON.stringify(data);
    prepareCardIllustrations(container, data.linkData?.id, data.illustrations || []);

    const row = getRowFromInput(container);
    if (row && row !== container) {
        row.dataset.cardData = JSON.stringify(data);
    }

    const anotherInp = container.querySelector('[data-field="illust"]');
    const illustrationWrap = anotherInp ? anotherInp.closest('.custom-select-wrapper') : null;
    const rarityInp = container.querySelector('[data-field="rare"]');
    const rarityWrap = rarityInp ? rarityInp.closest('.custom-select-wrapper') : null;
    const locInp = container.querySelector('[data-field="loc"]');
    const locWrap = locInp ? locInp.closest('.custom-select-wrapper') : null;

    const illustrationIds = Array.isArray(data.illustrations)
        ? [...new Set(data.illustrations.map(Number).filter(id => Number.isInteger(id) && id > 0))].sort((a, b) => a - b)
        : Array.from({ length: data.illustrationCount || 1 }, (_, i) => i + 1);
    let illustOptions = [];

    const isMobileDevice = document.documentElement.classList.contains('is-mobile-device');

    if (illustrationWrap) {
        if (illustrationIds.length > 1) {
            if (anotherInp && !illustrationIds.some(id => String(id) === getIllustrationValue(anotherInp))) {
                setIllustrationValue(anotherInp, '');
            }
            illustrationIds.forEach(id => {
                let suffix = "th"; if (id % 100 < 11 || id % 100 > 13) { if (id % 10 === 1) suffix = "st"; if (id % 10 === 2) suffix = "nd"; if (id % 10 === 3) suffix = "rd"; }
                illustOptions.push({ val: String(id), text: id === 1 ? "기본" : `${id}${suffix}` });
            });
            illustrationWrap.dataset.options = JSON.stringify(illustOptions);
            illustrationWrap.classList.remove('single-option');
            illustrationWrap.classList.remove('no-option');
        } else if (illustrationIds.length === 1) {
            if (anotherInp) {
                setIllustrationValue(anotherInp, String(illustrationIds[0]));
                anotherInp.dataset.raw = String(illustrationIds[0]);
            }
            illustrationWrap.classList.add('single-option');
            illustrationWrap.classList.remove('no-option');
            illustrationWrap.dataset.options = JSON.stringify([{ val: String(illustrationIds[0]), text: illustrationIds[0] === 1 ? "기본" : String(illustrationIds[0]) }]);
        } else {
            if (anotherInp) setIllustrationValue(anotherInp, '');
            illustrationWrap.dataset.options = '[]';
            illustrationWrap.classList.remove('single-option');
            illustrationWrap.classList.add('no-option');
        }
        if (anotherInp) {
            setupDropdownForField(anotherInp, illustrationWrap);
        }
    }

    let rareOptions = [];
    let sources = [];
    if (!data.isFallback && data.rarities && data.rarities.length > 0) {
        sources = data.rarities.slice(1).filter(Boolean);
        if (sources.length === 0) {
            sources = data.rarities.filter(Boolean);
        }
    } else {
        sources = [...CardDataStore.allProcessingTypes].sort(compareRarity);
    }

    sources = sources.filter(r => r !== "레어도" && r !== "Rarity");
    rareOptions = sources.map(r => ({ val: r, text: getLocalizedRarity(r) }));

    if (rarityWrap) {
        rarityWrap.dataset.options = JSON.stringify(rareOptions);
        rarityWrap.classList.toggle('no-option', rareOptions.length === 0);

        if (rareOptions.length === 1) {
            if (rarityInp) {
                rarityInp.value = rareOptions[0].text;
                rarityInp.dataset.raw = rareOptions[0].val;
            }
            rarityWrap.classList.add('single-option');
            handleAddRareChange(rarityInp);
        } else {
            if (rarityInp) {
                const currentRaw = rarityInp.dataset.raw || rarityInp.value;
                const existsInOptions = rareOptions.some(opt => opt.val === currentRaw || opt.text === currentRaw);
                if (!existsInOptions) {
                    rarityInp.value = "";
                    rarityInp.dataset.raw = "";
                }
            }
            rarityWrap.classList.remove('single-option');
        }
        if (!isMobileDevice && rarityInp) {
            setupDropdownForField(rarityInp, rarityWrap);
        }
    }

    if (anotherInp && getIllustrationValue(anotherInp)) {
        globalThis.AppBackend?.onSelectionChange?.(anotherInp);
    }

    if (locInp) {
        locInp.removeAttribute('readonly');
        if (locWrap) {
            locWrap.dataset.options = JSON.stringify(cardCacheInstance.getAllLocations().map(l => ({ val: l, text: l })));
            if (cardCacheInstance.getAllLocations().length > 0) {
                locWrap.classList.remove('no-option');
            }
        }

        const autoLocInput = document.getElementById('auto-location-input');
        const autoLocWrapper = document.getElementById('wrap-auto-loc');
        if (autoLocInput && autoLocInput.value.trim() && autoLocWrapper && autoLocWrapper.classList.contains('active-highlight')) {
            if (!locInp.value.trim()) {
                locInp.value = autoLocInput.value.trim();
            }
        }
        if (!isMobileDevice && locWrap) {
            setupDropdownForField(locInp, locWrap);
        }
    }



    // 바텀시트가 열린 상태에서 비동기 조회 완료 후 드롭다운 UI 즉시 갱신
    if (container.id === 'mobile-entry-bottom-sheet' || container.closest('#mobile-entry-bottom-sheet')) {
        if (typeof updateSheetDropdownState === 'function') updateSheetDropdownState();
    }
}

function getUniqueLocationsFromInventory() {
    if (typeof cardCacheInstance !== 'undefined' && typeof cardCacheInstance.getInventory === 'function') {
        const rawInv = cardCacheInstance.getInventory() || [];
        const locsSet = new Set();
        rawInv.forEach(r => {
            const loc = String(r[4] || '').trim();
            if (loc) locsSet.add(loc);
        });
        return Array.from(locsSet).sort();
    }
    return [];
}

function syncCardIdentityFieldLocks(container) {
    const locked = !container.querySelector('[data-field="name"]')?.value.trim()
        && !container.querySelector('[data-field="no"]')?.value.trim();
    for (const input of container.querySelectorAll('input:is([data-field="illust"], [data-field="rare"], [data-field="loc"])')) {
        if (input.disabled !== locked) input.disabled = locked;
    }
    return locked;
}

function initCardWidgets(container) {
    if (!container) return;

    // 1. 이름 입력창 및 자동완성 바인딩
    const nameInput = container.querySelector('[data-field="name"]') || 
                      container.querySelector('.desktop-card-name') || 
                      container.querySelector('.card-name-input');
    const nameWrap = nameInput ? nameInput.closest('.custom-select-wrapper') : null;
    if (nameWrap) {
        if (UIStore.mode === 'add') {
            setupGlobalCardNameAutocomplete(nameWrap);
        } else {
            setupCardNameAutocomplete(nameWrap);
        }
    }

    // 2. 카드 번호 입력창 및 자동완성 바인딩
    const noInput = container.querySelector('[data-field="no"]') || 
                    container.querySelector('.desktop-card-no') || 
                    container.querySelector('.move-card-no, .discard-card-no, .page-card-no');
    const noWrap = noInput ? noInput.closest('.custom-select-wrapper') : null;
    if (noWrap) {
        setupCardNoAutocomplete(noWrap);
    }

    if (container.matches('.desktop-info-card--editable')) {
        const sync = () => syncCardIdentityFieldLocks(container);
        for (const input of [nameInput, noInput]) {
            if (!input) continue;
            onInputValueAssigned(input, sync);
            input.addEventListener('input', sync);
        }
        sync();
    }

    // 3. 이동 위치(to) 입력창 바인딩
    const toInput = container.querySelector('[data-field="to"]') || 
                    container.querySelector('.desktop-card-to');
    const toWrap = toInput ? toInput.closest('.custom-select-wrapper') : null;
    if (toWrap) {
        const locs = getUniqueLocationsFromInventory();
        toWrap.dataset.options = JSON.stringify(locs.map(l => ({ val: l, text: l })));
        setupDropdownForField(toInput, toWrap);
    }

    // 4. 보관 위치(loc) 입력창 바인딩
    const locInput = container.querySelector('[data-field="loc"]') || 
                    container.querySelector('.desktop-card-loc');
    const locWrap = locInput ? locInput.closest('.custom-select-wrapper') : null;
    const isAdd = !container.querySelector('.move-card-no') && 
                  !container.querySelector('.discard-card-no') && 
                  !(UIStore.mode === 'move' || UIStore.mode === 'discard');
    if (isAdd && locWrap) {
        const locs = getUniqueLocationsFromInventory();
        locWrap.dataset.options = JSON.stringify(locs.map(l => ({ val: l, text: l })));
        if (locs.length > 0) locWrap.classList.remove('no-option');
        setupDropdownForField(locInput, locWrap);
    }
}

function saveRecentSearch(keyword, searchType = 'auto', isTarget = false) {
    if (!keyword) return;
    let recent = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    recent = recent.filter(r => {
        if (typeof r === 'string') return r !== keyword;
        return !(r.keyword === keyword && r.searchType === searchType && r.isTarget === isTarget);
    });
    recent.unshift({ keyword, searchType, isTarget });
    if (recent.length > 5) recent.pop();
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
}



let managementRequestPending = false;

async function requestManagementOperation(endpoint, payload, rows, loadingText) {
    if (managementRequestPending) return null;
    managementRequestPending = true;
    const user = UserStore.user;
    let response;
    try {
        showLoading(true, loadingText);
        try { response = await callApi(endpoint, buildAuthPayload(), payload); }
        catch (error) {
            if (UserStore.user !== user) return null;
            settleManagementRows(rows, null, String(error));
            return { success: false, message: '처리 결과를 확인할 수 없습니다. 보유 현황을 확인한 뒤 다시 시도해주세요.' };
        }
        if (UserStore.user !== user) return null;
        if (!response || typeof response !== 'object') {
            settleManagementRows(rows, null, '응답 양식 오류');
            return { success: false, message: '처리 결과를 확인할 수 없습니다. 보유 현황을 확인한 뒤 다시 시도해주세요.' };
        }
        settleManagementRows(rows, response);
        if (response.success) {
            // 저장 성공과 표시용 캐시 갱신 실패를 구분한다.
            try {
                updateLocalInventory(response.updatedItems);
                if (response.locations !== undefined) {
                    cardCacheInstance.setSummary(response.amount, response.locations, response.rarities);
                    updateTotals();
                }
                syncCounter++;
            } catch (_) {
                showToast('저장 응답을 받았지만 보유 정보 갱신에 실패했습니다. 새로고침 후 확인해주세요.', 'toast-warn');
            }
        }
        if (rows.some(row => row.log.failReason === 'unconfirmed_result')) {
            return { ...response, resultUnconfirmed: true, message: '처리 결과를 확인할 수 없습니다. 보유 현황을 확인한 뒤 다시 시도해주세요.' };
        }
        return response;
    } finally {
        managementRequestPending = false;
        showLoading(false);
    }
}

// 성공 표시는 저장 응답으로 확정하며, 실패/미확인 행은 입력 목록에 남긴다.
function settleManagementRows(rows, response, errorMessage = '') {
    const results = AppManagementResults.reconcile(rows.map(row => row.log), response, errorMessage);
    rows.forEach((row, index) => {
        Object.assign(row.log, results[index]);
        if (row.el) row.el.dataset[row.statusKey || 'status'] = results[index].status;
    });
    return results;
}

function showResultModal(successCount, successQty, detailLog, errorMsg, isFullSynced) {
    showManagementResult('add', detailLog, errorMsg, isFullSynced);
}

function showDiscardResultModal(successCount, successQty, detailLog, errorMsg, isFullSynced) {
    showManagementResult('discard', detailLog, errorMsg, isFullSynced);
}

function showManagementResult(operation, items, errorMessage, fullSynced) {
    const modal = document.getElementById(`${operation}-result-modal`);
    AppManagementResults.render(modal, items, {
        formatIllustration: IllustrationImages.label,
        formatRarity: getLocalizedRarity, errorMessage, fullSynced
    });
    AppManagementResults.setView(modal, UserStore.settings.isDetailMode ? 'detail' : 'summary');
    getAppModal(modal).open();
}

async function handleContinueDiscard() {

    const isMobile = document.documentElement.classList.contains('is-mobile-device');
    const containerId = isMobile ? 'mobile-cards-list-discard' : 'desktop-cards-list-discard';
    const cardClass = isMobile ? '.mobile-info-card[data-index]' : '.desktop-info-card[data-index]';
    const container = document.getElementById(containerId);
    
    let hasFailures = false;
    let hasSuccess = false;

    if (container) {
        const cards = Array.from(container.querySelectorAll(cardClass));
        cards.forEach(card => {
            if (card.dataset.status === 'success') {
                card.remove();
                hasSuccess = true;
            } else {
                hasFailures = true;
                delete card.dataset.status;
            }
        });
        
        const remainingCount = container.querySelectorAll(cardClass).length;
        if (!hasFailures || remainingCount === 0) {
            container.innerHTML = '';
            if (isMobile) mobileAddEntry('discard');
            else desktopAddEntry('discard');
        } else {
            if (!isMobile) reindexDesktopCards(container);
        }
    }

    if (hasSuccess) {
        if (syncCounter >= 9) {
            syncCounter = 0;
            await refreshInitialData(true);
        }
    }

    if (isMobile) {
        renderMobileCards();
    }
}

async function submitPageEntries() {
    if (!requireInventoryReady()) return;
    if (managementRequestPending) return;
    const submitBtn = document.getElementById('add-submit-main-btn');
    if (submitBtn && submitBtn.classList.contains('disabled')) return;

    const entries = [];
    const isMobile = document.documentElement.classList.contains('is-mobile-device');

    if (isMobile) {
        const listContainerId = 'mobile-cards-list-general';
        const listContainer = document.getElementById(listContainerId);
        if (listContainer) {
            const cards = listContainer.querySelectorAll('.mobile-info-card[data-index]');
            cards.forEach((card, idx) => {
                const data = getDesktopCardData(card);
                const nameInp = card.querySelector('[data-field="name"]');
                const rareInp = card.querySelector('[data-field="rare"]');
                entries.push({
                    el: card,
                    no: idx + 1,
                    cardNo: data.cardNo,
                    nameText: data.name,
                    namePlaceholder: nameInp ? nameInp.placeholder : "",
                    illustrationRaw: data.illustration,
                    procRaw: data.rarity,
                    loc: data.loc,
                    qty: data.qty,
                    rawRarityVal: rareInp ? rareInp.value : ""
                });
            });
        }
    } else {
        const listContainerId = 'desktop-cards-list-general';
        const listContainer = document.getElementById(listContainerId);
        if (listContainer) {
            const cards = listContainer.querySelectorAll('.desktop-info-card[data-index]');
            cards.forEach((card, idx) => {
                const data = getDesktopCardData(card);
                const nameInp = card.querySelector('[data-field="name"]');
                const rareInp = card.querySelector('[data-field="rare"]');
                entries.push({
                    el: card,
                    no: idx + 1,
                    cardNo: data.cardNo,
                    nameText: data.name,
                    namePlaceholder: nameInp ? nameInp.placeholder : "",
                    illustrationRaw: data.illustration,
                    procRaw: data.rarity,
                    loc: data.loc,
                    qty: data.qty,
                    rawRarityVal: rareInp ? rareInp.value : ""
                });
            });
        }
    }

    let hasInput = entries.some(item => item.cardNo !== "");
    if (!hasInput) {
        showToast('등록할 카드가 없습니다.', 'toast-warn');
        return;
    }

    if (!UserStore.user) {
        savePendingFormData();
        toggleAuthModal(true);
        return;
    }

    const validRows = [];
    const detailLog = [];
    const submittedRows = [];
    let successCount = 0; let successQty = 0;

    entries.forEach(item => {
        const no = item.no;
        const cardNo = item.cardNo;
        let nameText = item.nameText;
        const namePlaceholder = item.namePlaceholder;
        const el = item.el;

        if (!cardNo) {
            detailLog.push({ no, name: "", cardNo: "", illustration: "", rarity: "", loc: "", qty: 0, status: 'fail', failReason: 'empty_no' });
            el.dataset.status = 'fail'; return;
        }

        let illustrationRaw = item.illustrationRaw;
        let procRaw = item.procRaw;
        let loc = item.loc;
        const qty = item.qty;

        let failReason = null;
        if (namePlaceholder.includes("검색 중") || namePlaceholder.includes("조회 중")) {
            failReason = "loading";
            nameText = "조회 중...";
        } else if (namePlaceholder.includes("입력") || namePlaceholder.includes("오류") || namePlaceholder.includes("확인") || !nameText) {
            failReason = "invalid_no"; nameText = "유효하지 않은 카드";
        } else if (!illustrationRaw) {
            failReason = "no_illustration"; illustrationRaw = "미선택";
        } else if (!procRaw) {
            const procDisp = item.rawRarityVal;
            if (procDisp && el) {
                const wrap = el.querySelector('[data-field="rare"], .page-card-rarity')?.closest('.custom-select-wrapper');
                if (wrap) {
                    const options = JSON.parse(wrap.dataset.options || "[]");
                    const matched = options.find(o => o.text === procDisp);
                    if (matched) procRaw = matched.val;
                }
            }
            if (!procRaw) failReason = "no_rarity";
        }
        if (!failReason && !loc) failReason = "no_loc";
        if (!failReason && (!Number.isSafeInteger(Number(qty)) || Number(qty) < 1)) failReason = "invalid_qty";

        if (failReason) {
            detailLog.push({ no, name: nameText, cardNo, illustration: illustrationRaw, rarity: item.rawRarityVal || "미선택", loc: loc || "미선택", qty: qty || 0, status: 'fail', failReason });
            el.dataset.status = 'fail';
        } else {
            let cid = findCidByNameOrNo(nameText, cardNo);
            try {
                const data = JSON.parse(el.dataset.cardData || '{}');
                cid = data.linkData?.id || cid;
            } catch (error) { /* 구형 입력 행은 서버에서 CID를 보완합니다. */ }
            validRows.push([nameText, cardNo, procRaw, qty, loc, illustrationRaw, cid]);
            detailLog.push({ no, cid, name: nameText, cardNo, illustration: illustrationRaw, rarity: procRaw, loc, qty, status: 'pending' });
            el.dataset.status = 'pending';
            submittedRows.push({ log: detailLog[detailLog.length - 1], el });
        }
    });

    if (validRows.length > 0) {
        const response = await requestManagementOperation('addCards', { rows: validRows }, submittedRows, '등록 중...');
        if (!response) return;
        const totals = AppManagementResults.summarize(detailLog);
        showResultModal(totals.successCount, totals.totalQty, detailLog, (response.resultUnconfirmed || !response.success) ? response.message : null);
    } else if (detailLog.length > 0) {
        showResultModal(0, 0, detailLog);
    } else {
        // [토스트 삭제] UI 모달에서 안내되므로 제거
    }
}

async function submitDiscardEntries() {
    if (!requireInventoryReady()) return;
    if (managementRequestPending) return;
    const submitBtn = document.getElementById('discard-submit-main-btn');
    if (submitBtn && submitBtn.classList.contains('disabled')) return;

    const entries = [];
    const isMobile = document.documentElement.classList.contains('is-mobile-device');

    if (isMobile) {
        const listContainer = document.getElementById('mobile-cards-list-discard');
        if (listContainer) {
            const cards = listContainer.querySelectorAll('.mobile-info-card[data-index]');
            cards.forEach((card, idx) => {
                const data = getDesktopCardData(card);
                entries.push({
                    el: card,
                    no: idx + 1,
                    cardNo: data.cardNo,
                    nameText: data.name,
                    illustration: data.illustration,
                    rarity: data.rarity,
                    loc: data.loc,
                    qty: data.qty
                });
            });
        }
    } else {
        const listContainer = document.getElementById('desktop-cards-list-discard');
        if (listContainer) {
            const cards = listContainer.querySelectorAll('.desktop-info-card[data-index]');
            cards.forEach((card, idx) => {
                const data = getDesktopCardData(card);
                entries.push({
                    el: card,
                    no: idx + 1,
                    cardNo: data.cardNo,
                    nameText: data.name,
                    illustration: data.illustration,
                    rarity: data.rarity,
                    loc: data.loc,
                    qty: data.qty
                });
            });
        }
    }

    const validRows = [];
    const detailLog = [];
    const submittedRows = [];
    let successCount = 0; let successQty = 0;
    let hasFail = false;

    entries.forEach(item => {
        const no = item.no;
        const cardNo = item.cardNo;
        let nameText = item.nameText;
        const el = item.el;

        if (!cardNo) return;

        let illustration = item.illustration;
        let rarity = item.rarity;
        let loc = item.loc;
        const qty = item.qty;

        let failReason = null;
        if (!cardNo || !nameText) {
            failReason = "invalid_no";
        } else if (!illustration) {
            failReason = "no_illustration";
        } else if (!rarity) {
            failReason = "no_rarity";
        } else if (!loc) {
            failReason = "no_loc";
        } else if (!Number.isSafeInteger(Number(qty)) || Number(qty) < 1) {
            failReason = "invalid_qty";
        }

        if (failReason) {
            hasFail = true;
            el.dataset.status = 'fail';
            detailLog.push({ no, name: nameText, cardNo, illustration: illustration || "-", rarity: rarity || "-", loc: loc || "-", qty: qty || 0, status: 'fail', failReason });
        } else {
            const cid = findCidByNameOrNo(nameText, cardNo);
            validRows.push({ cardNo, cid, name: nameText, rarity, illustration, loc, qty });
            detailLog.push({ no, cid, name: nameText, cardNo, illustration, rarity, loc, qty, status: 'pending' });
            el.dataset.status = 'pending';
            submittedRows.push({ log: detailLog[detailLog.length - 1], el });
        }
    });

    if (validRows.length === 0 && !hasFail) {
        showToast('제거할 카드가 없습니다.', 'toast-warn');
        return;
    }

    if (!UserStore.user) {
        savePendingFormData();
        toggleAuthModal(true);
        return;
    }

    if (validRows.length === 0 && hasFail) {
        showDiscardResultModal(0, 0, detailLog);
        return;
    }

    const response = await requestManagementOperation('discardCards', { discards: validRows }, submittedRows, '카드 제거 중...');
    if (!response) return;
    const totals = AppManagementResults.summarize(detailLog);
    showDiscardResultModal(totals.successCount, totals.totalQty, detailLog, (response.resultUnconfirmed || !response.success) ? response.message : null);

}

function decomposeHangul(str) {
    if (!str) return "";
    return str.normalize('NFD');
}

function normalizeStr(str) { return str ? String(str).replace(/\s+/g, '').toLowerCase() : ''; }

function getCardNameByNumber(cardNo) {
    if (!cardNo) return '';
    const normNo = normalizeStr(cardNo);
    if (typeof cardCacheInstance !== 'undefined') {
        const found = cardCacheInstance.getInventory().find(r => normalizeStr(r[1]) === normNo);
        if (found && found[0]) return String(found[0]);
    }
    return '';
}

function matchKorean(item, query) {
    if (!item || !query) return false;
    const normText = item.normalized || normalizeStr(item.original || item.val || item);
    const normQuery = normalizeStr(query);
    if (!normQuery) return false;

    // 1. 단순 부분 문자열 매칭
    if (normText.includes(normQuery)) return true;

    // 2. 초성 전용 매칭 (검색어가 자음으로만 구성된 경우)
    const isChosungOnly = /^[ㄱ-ㅎ]+$/.test(normQuery);
    if (isChosungOnly) {
        const itemChosung = item.chosung || getChosung(normText);
        return itemChosung.includes(normQuery);
    }

    // 3. Hangul.search 자모 매칭
    if (typeof Hangul !== 'undefined' && typeof Hangul.search === 'function') {
        try {
            return Hangul.search(normText, normQuery) !== -1;
        } catch (e) {
            return false;
        }
    }

    return false;
}

/**
 * 카드명 자동완성 공통 관련도 정렬.
 * 완전 일치 → 앞부분 일치 → 더 앞에서 일치 → 짧은 이름 → 가나다순 순서입니다.
 */
function compareCardNameSuggestion(a, b, query) {
    const normalizedQuery = normalizeStr(query);
    const normalizedA = a.normalized || normalizeStr(a.original || a.val || a);
    const normalizedB = b.normalized || normalizeStr(b.original || b.val || b);

    const exactA = normalizedA === normalizedQuery;
    const exactB = normalizedB === normalizedQuery;
    if (exactA !== exactB) return exactA ? -1 : 1;

    const startsA = normalizedA.startsWith(normalizedQuery);
    const startsB = normalizedB.startsWith(normalizedQuery);
    if (startsA !== startsB) return startsA ? -1 : 1;

    const indexA = normalizedA.indexOf(normalizedQuery);
    const indexB = normalizedB.indexOf(normalizedQuery);
    const positionA = indexA < 0 ? Number.MAX_SAFE_INTEGER : indexA;
    const positionB = indexB < 0 ? Number.MAX_SAFE_INTEGER : indexB;
    if (positionA !== positionB) return positionA - positionB;

    const originalA = String(a.original || a.val || a);
    const originalB = String(b.original || b.val || b);
    return originalA.length - originalB.length || originalA.localeCompare(originalB, 'ko');
}

function sortCardNameSuggestions(items, query, limit = 8) {
    return items.slice().sort((a, b) => compareCardNameSuggestion(a, b, query)).slice(0, limit);
}

function showRecentInDropdown() {
    const currentValue = document.getElementById('card-search').value;
    if (currentValue.trim()) {
        filterAndShowDropdown(currentValue);
        return;
    }
    const recent = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    const list = document.getElementById('custom-dropdown');
    clearCatalogDropdownCandidates(list);
    UIStore.dropdownFocus = -1;
    Array.from(list.children).forEach(child => { if (!child.classList.contains('recent-header-item')) { child.remove(); } });
    let header = document.getElementById('recent-header');
    if (!header) {
        header = document.createElement('li');
        header.id = 'recent-header';
        header.className = 'recent-header-item';
        header.innerHTML = `<span class="color-text-001">최근 검색</span><button type="button" class="ui-button ui-button--text color-text-002 clear-all-btn">전체 제거</button>`;
        list.prepend(header);
    }
    if (recent.length === 0) {
        const noResultLi = document.createElement('li');
        noResultLi.className = 'no-result-item color-text-002';
        noResultLi.innerText = '검색 기록이 없습니다.';
        list.appendChild(noResultLi);
    } else {
        const ownedNames = cardCacheInstance.getOwnedNamesSet();
        const ownedNumbers = cardCacheInstance.getOwnedNumbersSet();
        recent.slice(0, 5).forEach(r => {
            const li = document.createElement('li');
            li.className = 'recent-item-row color-type004';
            const keyword = typeof r === 'string' ? r : r.keyword;
            const searchType = typeof r === 'string' ? 'auto' : (r.searchType || 'auto');
            const isTarget = typeof r === 'string' ? false : !!r.isTarget;

            li.dataset.val = keyword;
            li.dataset.type = searchType;
            li.dataset.isTarget = isTarget ? 'true' : 'false';

            let tagHtml = '';
            if (isTarget) {
                const isOwned = searchType === 'number'
                    ? ownedNumbers.has(String(keyword).trim().toUpperCase())
                    : ownedNames.has(String(keyword).trim());
                const ownershipClass = isOwned ? ' color-tint-theme' : ' color-tint-neutral';
                if (searchType === 'number') {
                    tagHtml = `<span class="ui-tag shape-rounded001${ownershipClass}">번호</span>`;
                } else {
                    tagHtml = `<span class="ui-tag shape-rounded001${ownershipClass}">이름</span>`;
                }
            }

            li.innerHTML = `<span>${tagHtml}${escapeHTML(keyword)}</span><button type="button" class="ui-button ui-button--text color-text-002 item-delete-btn" aria-label="검색 기록 삭제"><i class="material-icons" aria-hidden="true">close</i></button>`;
            list.appendChild(li);
        });
    }
    toggleSearchWrapper(true);
}

function filterAndShowDropdown(val, isMobile = false) {
    if (!val.trim()) {
        if (isMobile) showMobileRecentInDropdown(); else showRecentInDropdown();
        return;
    }
    const list = document.getElementById(isMobile ? 'mobile-custom-dropdown' : 'custom-dropdown');
    if (!list) return;
    const render = () => {
        const matches = collectCatalogMatches(val, { autocomplete: true }).slice(0, 5);
        list._catalogCandidates = matches;
        renderCatalogDropdown(list, val, isMobile, matches);
    };
    if (!globalThis.AppBackend) return render();
    list._catalogSuggestionRequest?.abort();
    const request = list._catalogSuggestionRequest = new AbortController();
    return globalThis.AppBackend.prepareSuggestions(val, isMobile, request.signal).then(current => {
        if (current && !request.signal.aborted) render();
    });
}

function clearCatalogDropdownCandidates(list) {
    if (!list) return;
    list._catalogSuggestionRequest?.abort();
    list._catalogCandidates = [];
    list.style.height = '';
    UIStore.dropdownFocus = -1;
}

function updatePendingCatalogDropdown(val, isMobile = false) {
    const list = document.getElementById(isMobile ? 'mobile-custom-dropdown' : 'custom-dropdown');
    if (!list) return;
    list._catalogSuggestionRequest?.abort();
    const query = normalizeStr(val.normalize('NFC'));
    const consonantsOnly = /^[ㄱ-ㅎ]+$/.test(query);
    const continuation = catalogueContinuationPattern(query);
    const matches = query ? (list._catalogCandidates || []).filter(item => item.type === 'name'
        ? matchesCatalogName(item, query, consonantsOnly, continuation)
        : query.length >= 6 && item.normalized.includes(query)) : [];
    renderCatalogDropdown(list, val, isMobile, matches, true);
}

function holdOpenSuggestionDropdown(list) {
    if (!list.classList.contains('active')) return false;
    if (list.style.height) return true;
    if (!list.children.length) return false;
    const height = getComputedStyle(list).height;
    if (!(parseFloat(height) > 0)) return false;
    list.style.height = height;
    return true;
}

function renderCatalogDropdown(list, val, isMobile, combinedMatches, pending = false) {
    UIStore.dropdownFocus = -1;
    const keepFrame = pending && !combinedMatches.length && holdOpenSuggestionDropdown(list);
    if (!keepFrame) list.style.height = '';
    if (isMobile) {
        // 최근 검색 버튼은 유지하고 자동완성 행만 갱신한다(가로 스크롤 위치도 유지).
        for (const child of Array.from(list.children)) {
            if (!child.classList.contains('mobile-recent-container')) child.remove();
        }
        if (!list.querySelector('.mobile-recent-container')) {
            appendMobileRecentHistory(list, JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'));
        }
    } else {
        list.innerHTML = '';
    }

    if (pending && combinedMatches.length === 0) {
        if (keepFrame) return;
        if (isMobile) list.classList.toggle('active', list.children.length > 0);
        else toggleSearchWrapper(false, { immediate: true });
        return;
    }

    if (combinedMatches.length === 0) {
        const noResult = document.createElement('li');
        noResult.className = 'no-result-item color-text-002';
        noResult.innerText = '일치하는 카드가 없습니다.';
        list.appendChild(noResult);
        if (isMobile) list.classList.add('active');
        else toggleSearchWrapper(true);
        return;
    }

    const nameQuery = typeof Hangul !== 'undefined' && typeof Hangul.disassemble === 'function'
        ? Hangul.disassemble(normalizeStr(val.normalize('NFC'))).join('')
        : '';
    const escapedQuery = escapeHTML(val);
    combinedMatches.forEach(m => {
        const li = document.createElement('li');
        li.className = 'text-suggest color-type004';
        li.dataset.val = m.val;
        li.dataset.type = m.type;
        li.dataset.isTarget = 'true';

        const tagColorClass = m.isOwned ? 'color-tint-theme' : 'color-tint-neutral';
        const textColorClass = m.isOwned ? 'color-text-theme' : 'color-text-001';
        const matchColorClass = m.isOwned ? 'color-text-000' : 'color-text-001';
        let html = "";
        const escapedVal = escapeHTML(m.val);
        if (m.type === 'name') {
            html = escapedVal;
            if (nameQuery) {
                // 공백을 제외한 자모의 위치를 원래 카드 이름의 글자 위치에 대응시킨다.
                const offsets = [];
                const searchableName = Hangul.disassemble(m.val, true).map((group, index) => {
                    const text = normalizeStr(group.join(''));
                    for (let i = 0; i < text.length; i++) offsets.push(index);
                    return text;
                }).join('');
                const match = searchableName.indexOf(nameQuery);
                if (match !== -1) {
                    const start = offsets[match];
                    const end = offsets[match + nameQuery.length - 1] + 1;
                    html = escapeHTML(m.val.slice(0, start)) +
                        `<span class="text-match ${matchColorClass}">${escapeHTML(m.val.slice(start, end))}</span>` +
                        escapeHTML(m.val.slice(end));
                }
            }
            html = `<span class="ui-tag shape-rounded001 ${tagColorClass}">이름</span><span class="${textColorClass}">${html}</span>`;
        } else {
            const idx = escapedVal.toLowerCase().indexOf(escapedQuery.toLowerCase());
            if (idx !== -1) {
                const len = escapedQuery.length;
                html = escapedVal.substring(0, idx) +
                    `<span class="text-match ${matchColorClass}">${escapedVal.substring(idx, idx + len)}</span>` +
                    escapedVal.substring(idx + len);
            } else {
                html = escapedVal;
            }
            html = `<span class="ui-tag shape-rounded001 ${tagColorClass}">번호</span><span class="${textColorClass}">${html}</span>`;
        }

        li.innerHTML = html;
        if (isMobile) {
            li.addEventListener('click', () => {
                executeMobileSearch(m.val, m.type, true);
            });
        }
        list.appendChild(li);
    });
    if (isMobile) list.classList.add('active');
    else toggleSearchWrapper(true);
}

function deleteRecentItem(name, type = 'auto') {
    let recent = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    recent = recent.filter(r => {
        if (typeof r === 'string') return r !== name;
        return !(r.keyword === name && (r.searchType || 'auto') === type);
    });
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
    showRecentInDropdown();
}
function handleHelpClick() {
    if (UIStore.mode === 'home' && typeof OnboardingManager !== 'undefined') {
        OnboardingManager.start('home', true);
    }
}

function getLocalTheme(key) {
    try {
        const value = localStorage.getItem(key);
        return ['light', 'dark'].includes(value) ? value : null;
    } catch (e) {
        return null;
    }
}

function getSystemTheme() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function getThemeRecordKey() {
    return UserStore.user ? ACCOUNT_THEME_KEY_PREFIX + UserStore.user.uid : GUEST_THEME_KEY;
}

function rememberTheme(mode) {
    // 마지막 표시값과 비로그인/계정별 기록은 서로 다른 역할이다.
    for (const key of [THEME_KEY, getThemeRecordKey()]) {
        try { localStorage.setItem(key, mode); } catch (e) { /* 저장 실패와 화면 적용은 분리한다. */ }
    }
}

function applyTheme(mode) {
    UserStore.settings.theme = mode;
    document.documentElement.classList.toggle('dark-mode', mode === 'dark');
    const toggle = document.getElementById('theme-toggle-btn');
    if (toggle) {
        const dark = mode === 'dark';
        toggle.setAttribute('aria-pressed', String(dark));
        toggle.setAttribute('aria-label', dark ? '라이트 모드로 전환' : '다크 모드로 전환');
        const icon = toggle.querySelector('.material-icons');
        if (icon) icon.textContent = dark ? 'light_mode' : 'dark_mode';
    }
    updateMetaThemeColor(mode);
}

function loadUserTheme(settingsFromServer, waitForServer = false) {
    const localTheme = getLocalTheme(getThemeRecordKey());
    // 계정 기록이 없으면 서버 응답까지 초기 표시를 유지한다.
    if (UserStore.user && !localTheme && waitForServer) return;
    const serverTheme = UserStore.user && ['light', 'dark'].includes(settingsFromServer?.theme)
        ? settingsFromServer.theme : null;
    const mode = localTheme || serverTheme || getSystemTheme();
    applyTheme(mode);
    rememberTheme(mode);
}
/**
 * 사용자 설정을 저장 (DB + LocalStorage)
 */
async function saveUserSetting(field, value) {
    UserStore.accountRevision++;
    UserStore.settings[field] = value;

    // 로컬 스토리지 호환성 유지
    if (field === 'theme') {
        rememberTheme(value);
    } else if (field === 'isDetailMode') {
        localStorage.setItem(IS_DETAIL_MODE_KEY, value ? 'true' : 'false');
    }

    // 로그인 상태라면 DB 동기화
    if (UserStore.user) {
        try {
            const settings = {};
            settings[field] = value;
            // 2번째 인자는 URL 쿼리(params), 3번째 인자가 POST 본문(postData)입니다.
            if (field === 'onboarding' && globalThis.AppBackend?.syncOnboarding) await globalThis.AppBackend.syncOnboarding(value);
            else if (field === 'readNotices' && globalThis.AppBackend?.syncReadNotices) await globalThis.AppBackend.syncReadNotices(value);
            else await callApi('updateUserSettings', {}, { settings });
        } catch (e) {
            console.error("Settings sync failed:", e);
        }
    }
}

/**
 * 저장된 설정을 로드하여 UI에 적용
 */
function loadUserSettings(settingsFromServer) {
    loadUserTheme(settingsFromServer);
    const savedDetailMode = (settingsFromServer && settingsFromServer.isDetailMode !== undefined)
        ? settingsFromServer.isDetailMode
        : (localStorage.getItem(IS_DETAIL_MODE_KEY) === 'true');

    UserStore.settings.isDetailMode = savedDetailMode;

    // 온보딩 정보 동기화 (DB -> LocalStorage)
    if (settingsFromServer && settingsFromServer.onboarding) {
        if (typeof OnboardingManager !== 'undefined') OnboardingManager.restore(settingsFromServer.onboarding);
    }

    // 공지사항 읽음 정보 동기화 (DB -> LocalStorage)
    if (settingsFromServer && Array.isArray(settingsFromServer.readNotices)) {
        let localNotices;
        try { localNotices = JSON.parse(localStorage.getItem(getReadNoticesStorageKey()) || '[]'); } catch (_) { localNotices = []; }
        const mergedNotices = [...new Set([...(Array.isArray(localNotices) ? localNotices : []), ...settingsFromServer.readNotices])];
        localStorage.setItem(getReadNoticesStorageKey(), JSON.stringify(mergedNotices));
        globalThis.AppBackend?.syncReadNotices?.(mergedNotices).catch(() => {});
    }
    refreshNoticeReadState();

}

/**
 * 모달 상세/요약 토글 핸들러
 */
function handleToggleDetail(isDetail = !UserStore.settings.isDetailMode) {
    saveUserSetting('isDetailMode', isDetail);
    applyModalDetailUI(isDetail);
}

function applyModalDetailUI(isDetail) {
    const activeModal = document.querySelector('.modal.open[data-result-operation]');
    if (!activeModal || activeModal.dataset.resultOperation === 'import') return;
    AppManagementResults.setView(activeModal, isDetail ? 'detail' : 'summary');
}

function loadTheme() {
    // 인증 확인 전에는 비로그인 기록을 적용하지 않고 HTML의 마지막 표시를 유지한다.
    applyTheme(getLocalTheme(THEME_KEY) || getSystemTheme());
}
function toggleTheme() {
    const mode = document.documentElement.classList.contains('dark-mode') ? 'light' : 'dark';
    applyTheme(mode);
    saveUserSetting('theme', mode);
}

const regionMap = { 'ko': '한국', 'ja': '일본', 'ae': '아시아', 'cn': '중국', 'en': '영미', 'de': '독일', 'fr': '프랑스', 'it': '이탈리아', 'es': '스페인', 'pt': '포르투갈' };
function syncRegionOptionSelection(code) {
    document.querySelectorAll('#region-dropdown [role="option"]').forEach(option => {
        option.setAttribute('aria-selected', String(option.dataset.region === code));
    });
}
function loadRegion() {
    const savedRegion = localStorage.getItem(REGION_KEY) || 'ko';
    UIStore.currentRegion = savedRegion;
    document.getElementById('region-text').innerText = regionMap[savedRegion];
    document.documentElement.setAttribute('data-region', savedRegion);
    updateFaqLanguage(savedRegion);
    syncRegionOptionSelection(savedRegion);
}
// 모든 드롭다운 닫기 (현재는 지역 설정만 및 검색바 등)
function closeDropdowns() {
    // 지역 설정 닫기
    document.querySelectorAll('.region-container.active').forEach(regionWrapper => {
        regionWrapper.classList.remove('active');
        regionWrapper.querySelector('.region-capsule')?.setAttribute('aria-expanded', 'false');
        // 높이 변수 초기화 (애니메이션 종료 후 자연스럽게 무시되지만 명시적 초기화)
        regionWrapper.style.setProperty('--region-dropdown-height', '0px');
    });

    // 필요 시 다른 드롭다운 닫기 로직 추가
}

// 지역 설정 드롭다운 토글 (물리적 확장 애니메이션 적용)
function toggleRegionDropdown(event, wrapper = document.getElementById('region-wrapper')) {
    event.stopPropagation();
    const dropdown = wrapper.querySelector('.region-dropdown-list');

    // 이미 열려있는지 확인
    const isActive = wrapper.classList.contains('active');

    // 모든 드롭다운 닫기 (자신 포함)
    closeDropdowns();

    if (!isActive) {
        wrapper.classList.add('active');
        wrapper.querySelector('.region-capsule')?.setAttribute('aria-expanded', 'true');

        // 높이 계산 및 애니메이션 시작
        requestAnimationFrame(() => {
            if (!wrapper.classList.contains('active')) return;
            const scrollHeight = dropdown.scrollHeight;
            // 드롭다운의 실제 높이만큼 배경 확장
            wrapper.style.setProperty('--region-dropdown-height', scrollHeight + 'px');
        });
    }
}

function handleRegionButtonKeydown(event, wrapper = document.getElementById('region-wrapper')) {
    if (event.key === 'Escape') {
        closeDropdowns();
        return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;

    event.preventDefault();
    if (!wrapper.classList.contains('active')) toggleRegionDropdown(event, wrapper);

    const options = [...wrapper.querySelectorAll('[role="option"]')];
    const target = event.key === 'ArrowUp' ? options.at(-1) : options[0];
    target?.focus();
}

function handleRegionOptionKeydown(event, wrapper = document.getElementById('region-wrapper')) {
    const option = event.target.closest('[role="option"]');
    if (!option) return;

    const options = [...wrapper.querySelectorAll('[role="option"]')];
    const currentIndex = options.indexOf(option);
    let nextIndex = currentIndex;

    if (event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % options.length;
    else if (event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + options.length) % options.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = options.length - 1;
    else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        option.click();
        wrapper.querySelector('.region-capsule')?.focus();
        return;
    } else if (event.key === 'Escape') {
        event.preventDefault();
        closeDropdowns();
        wrapper.querySelector('.region-capsule')?.focus();
        return;
    } else if (event.key === 'Tab') {
        closeDropdowns();
        return;
    } else {
        return;
    }

    event.preventDefault();
    options[nextIndex]?.focus();
}

let lastSearchState = null;
let searchSequence = 0;

/**
 * 검색 상태를 URL Hash 규격으로 갱신
 * - 포괄: #search?m=0&key=(검색어) / m=1 / m=2
 * - 단일: #search?cid=(cid) 또는 #search?cid=(cid)&code=(code)
 */
function updateSearchHash(type, params = {}, force = false) {
    if (isInternalHashChange && !force) return;
    isInternalHashChange = true;
    let finalHash = 'search';

    if (type === 'broad') {
        let m = 0;
        if (params.searchType === 'name') m = 1;
        else if (params.searchType === 'number') m = 2;
        const key = params.key || '';
        finalHash = `search?m=${m}&key=${encodeURIComponent(key)}`;
    } else if (type === 'target') {
        let cid = params.cid;
        if (cid === 'null' || cid === 'undefined' || !cid) cid = '';
        const code = params.code || params.prioritizeNumber || '';
        if (code && cid) {
            finalHash = `search?cid=${encodeURIComponent(cid)}&code=${encodeURIComponent(code)}`;
        } else if (cid) {
            finalHash = `search?cid=${encodeURIComponent(cid)}`;
        } else if (code) {
            finalHash = `search?code=${encodeURIComponent(code)}`;
        }
    }

    const currentHash = window.location.hash.startsWith('#') ? window.location.hash.substring(1) : window.location.hash;
    if (currentHash !== finalHash || force) {
        history.replaceState(null, '', '#' + finalHash);
    }
    isInternalHashChange = false;
}

// 지역 선택 처리 (0.001초 프론트 메모리 속성/종족 변경 & URL 해시 기반 실시간 갱신)
function selectRegion(code, text) {
    UIStore.currentRegion = code;
    localStorage.setItem(REGION_KEY, code);
    document.getElementById('region-text').innerText = text;
    document.documentElement.setAttribute('data-region', code);
    updateFaqLanguage(code);
    syncRegionOptionSelection(code);

    closeDropdowns();

    updateTooltipsOnly();
    updateRarityInputs();

    // 0.001초 메모리 상에서 속성, 종족, 분류 뱃지 즉시 변경
    updateMemoryDecodedElements();

    // URL 해시 기반 실시간 갱신
    if (typeof handleHashChange === 'function') {
        handleHashChange(true);
    } else {
        refreshCurrentSearchResult();
    }
}

function updateMemoryDecodedElements() {
    const locIdx = getRegionLocIdx();
    const resultArea = document.getElementById('result-area');
    if (!resultArea) return;

    // 대상 카드 뷰 테이블 갱신 (속성/종족)
    const monsterTable = resultArea.querySelector('.search-card__table--monster');
    if (monsterTable && typeof lastSearchState !== 'undefined' && lastSearchState && lastSearchState.targetMeta) {
        const rawSlot = lastSearchState.targetMeta.rawSlot || lastSearchState.targetMeta.info || [];
        const attrVal = rawSlot[13];
        const speciesVal = rawSlot[14];

        const cells = monsterTable.querySelectorAll('td');
        if (cells.length >= 2) {
            if (attrVal !== null && attrVal !== undefined && DECODE_ATTR[locIdx] && DECODE_ATTR[locIdx][attrVal]) {
                cells[0].textContent = DECODE_ATTR[locIdx][attrVal];
            }
            if (speciesVal !== null && speciesVal !== undefined && DECODE_SPECIES[locIdx] && DECODE_SPECIES[locIdx][speciesVal]) {
                cells[1].textContent = DECODE_SPECIES[locIdx][speciesVal];
            }
        }
    }
}

function getInventoryRowsByCidOrName(targetCid, targetCardName, prioritizeNumber = null) {
    if (typeof cardCacheInstance === 'undefined') return [];

    const relatedNames = new Set();
    if (targetCardName) relatedNames.add(targetCardName);

    if (targetCid && typeof ClientCache !== 'undefined') {
        if (ClientCache._cidToNames && ClientCache._cidToNames[targetCid]) {
            ClientCache._cidToNames[targetCid].forEach(n => relatedNames.add(n));
        }

    }

    const normRelatedSet = new Set([...relatedNames].map(n => normalizeStr(n)));

    const candidates = targetCid
        ? [...(cardCacheInstance._ownedByCid?.get(String(targetCid)) || []), ...cardCacheInstance.getInventory().filter(row => !row[6])]
        : cardCacheInstance.getInventory();
    let rows = candidates.filter(row => {
        if (targetCid && row[6]) return true;
        const rowNorm = normalizeStr(String(row[0]));
        if (normRelatedSet.has(rowNorm)) return true;
        if (prioritizeNumber && normalizeStr(String(row[1])) === normalizeStr(prioritizeNumber)) return true;
        return false;
    });

    const targetNorm = targetCardName ? normalizeStr(targetCardName) : null;
    const prioNorm = prioritizeNumber ? normalizeStr(prioritizeNumber) : null;

    rows.sort((a, b) => {
        const aName = normalizeStr(String(a[0]));
        const bName = normalizeStr(String(b[0]));
        const aNo = normalizeStr(String(a[1]));
        const bNo = normalizeStr(String(b[1]));

        if (prioNorm) {
            if (aNo === prioNorm && bNo !== prioNorm) return -1;
            if (bNo === prioNorm && aNo !== prioNorm) return 1;
        }

        if (targetNorm) {
            if (aName === targetNorm && bName !== targetNorm) return -1;
            if (bName === targetNorm && aName !== targetNorm) return 1;
        }

        return 0;
    });

    return rows;
}

function refreshCurrentSearchResult() {
    if (typeof UIStore.mode !== 'undefined' && UIStore.mode === 'search') {
        if (lastSearchState) {
            if (lastSearchState.type === 'target') {
                const targetCardName = lastSearchState.targetCardName;
                const prioritizeNumber = lastSearchState.prioritizeNumber;
                const targetCid = lastSearchState.targetCid;

                let updatedTargetRows = getInventoryRowsByCidOrName(targetCid, targetCardName, prioritizeNumber);


                renderTargetSearchResult(
                    targetCardName,
                    updatedTargetRows,
                    prioritizeNumber,
                    null,
                    targetCid
                );
            } else if (lastSearchState.type === 'broad') {
                renderCatalogResults(lastSearchState);
            }
        } else {
            if (window.location.hash.startsWith('#search?')) {
                handleHashChange(false);
                return;
            }
            const inputEl = document.getElementById('card-search');
            if (inputEl && inputEl.value.trim()) {
                startSearch(true);
            }
        }
    }
}

function updateTooltipsOnly() {
    const resultArea = (typeof SearchNavigation !== 'undefined' && SearchNavigation.currentPane())
        || document.getElementById('result-area');
    if (!resultArea) return;
    const headers = resultArea.querySelectorAll('th.sp-col.tooltipped');
    if (headers.length === 0) return;

    headers.forEach(th => {
        const key = th.dataset.key;
        const idx = th.dataset.index;

        let newTooltip = key;

        if (idx !== undefined && idx !== "undefined" && idx !== "") {
            const row = rarityRows[idx];
            if (row && rarityColMap[UIStore.currentRegion] !== undefined) {
                const val = row[rarityColMap[UIStore.currentRegion]];
                if (val && val !== "") newTooltip = val;
            }
        }

        newTooltip = escapeHTML(String(newTooltip)).replace(/\(/g, '<br>(');
        th.setAttribute('data-tooltip', newTooltip);
    });

    M.Tooltip.init(headers, { html: true, margin: 3 });
}

function updateRarityInputs() {
    const inputs = document.querySelectorAll('.page-card-rarity, .move-card-rarity, .discard-card-rarity');
    inputs.forEach(input => {
        const rawVal = input.dataset.raw || input.value;
        if (rawVal) {
            input.value = getLocalizedRarity(rawVal);

            if (!input.dataset.raw) input.dataset.raw = rawVal;
        }

        const wrapper = input.closest('.custom-select-wrapper');
        if (wrapper && wrapper.dataset.options) {
            try {
                const options = JSON.parse(wrapper.dataset.options);
                const newOptions = options.map(opt => {
                    return {
                        val: opt.val,
                        text: getLocalizedRarity(opt.val),
                        max: opt.max
                    };
                });
                wrapper.dataset.options = JSON.stringify(newOptions);
            } catch (e) { console.error(e); }
        }
    });
}

// 검색 응답은 입력 행과 무관하게 60초 동안 재사용합니다.
const cardResponseCache = new Map();
const cardRequestPromises = new Map();
let cardCacheRevision = 0;
async function callApi(action, params = {}, postData = null) {
    const cacheable = !postData && ['searchCardByName', 'searchCardByNo', 'getCardMetadata', 'searchCard'].includes(action)
        && !params.warmup;
    const key = `${action}:${JSON.stringify(Object.fromEntries(Object.entries(params).sort()))}`;
    if (cacheable) {
        const cached = cardResponseCache.get(key);
        if (cached && cached.expires > Date.now()) return structuredClone(cached.data);
        if (cardRequestPromises.has(key)) return structuredClone(await cardRequestPromises.get(key));
    }
    const revision = cardCacheRevision;
    const promise = requestApi(action, params, postData).then(res => {
        CardListCache.rememberResponse(action, res);
        if (res?.success && postData && res.inventoryMigration) scheduleInventoryMigration(res);
        if (res?.success && ['crawlCardMetaByName', 'crawlPackCardsBatch', 'searchPack'].includes(action)) {
            cardCacheRevision++;
            cardResponseCache.clear();
            cardRequestPromises.clear();
            cidMetaMemoryCache.clear();
        }
        if (cacheable && res?.success && !res.isPendingCrawl && revision === cardCacheRevision) {
            cardResponseCache.set(key, { data: structuredClone(res), expires: Date.now() + 60000 });
            if (cardResponseCache.size > 500) cardResponseCache.delete(cardResponseCache.keys().next().value);
            const cid = res.cid || res.linkData?.id;
            if (cid && res.info && params.langOnly !== true) mergeCardMetaToCache(cid, res, true);
        }
        return res;
    }).finally(() => {
        if (cardRequestPromises.get(key) === promise) cardRequestPromises.delete(key);
    });
    if (cacheable) cardRequestPromises.set(key, promise);
    return structuredClone(await promise);
}

async function getApiAppCheckToken(forceRefresh = false) {
    try {
        if (typeof firebase === 'undefined' || !firebase.appCheck) throw new Error();
        // getToken은 유효한 캐시를 사용하고, 필요할 때만 갱신한다. 동시 발급도 SDK가 처리한다.
        const prepare = () => firebase.appCheck().getToken(forceRefresh);
        const timing = typeof window === 'undefined' ? null : window.YgoLoginTiming;
        const result = await (timing?.appCheck ? timing.appCheck(forceRefresh ? 'refresh' : 'request', forceRefresh, prepare) : prepare());
        if (!result?.token) throw new Error();
        return result.token;
    } catch (error) {
        // SDK 원문·토큰·URL을 전달하지 않고 알려진 설정 거부만 고정 분류한다.
        const failure = typeof window === 'undefined' ? undefined : window.YgoLoginTiming?.appCheckFailure?.(error);
        let denied = false, throttled = false;
        try {
            denied = ['appCheck/fetch-status-error', 'app-check/fetch-status-error'].includes(error?.code)
                && [400, 403, 404].includes(error?.customData?.httpStatus);
            throttled = ['appCheck/initial-throttle', 'app-check/initial-throttle', 'appCheck/throttled', 'app-check/throttled'].includes(error?.code);
        } catch (_) {}
        throw Object.assign(new Error(denied
            ? (IS_LOCAL_DEV ? '로컬 앱 인증 설정이 거부되었습니다. 현재 브라우저의 디버그 토큰 등록을 확인해 주세요.'
                : '앱 인증 설정을 확인하지 못했습니다. 관리자에게 문의해 주세요.')
            : '앱 인증을 준비하지 못했습니다. 잠시 후 다시 시도해 주세요.'),
        { code: denied ? 'APPCHECK_CONFIGURATION_REJECTED' : 'APPCHECK_UNAVAILABLE',
            ...(throttled ? { reason: 'throttled', retryable: false } : denied ? { retryable: false }
                : failure ? { retryable: failure.retryable } : {}) });
    }
}

// SDK 호출 자체를 취소하지는 않지만, 만료된 조회가 토큰 준비를 계속 기다리지는 않는다.
function awaitApiPreparation(promise, signal) {
    if (!signal) return promise;
    return new Promise((resolve, reject) => {
        const abort = () => reject(Object.assign(new Error('서비스 연결 확인 시간이 초과됐습니다.'), { code: 'SERVICE_CHECK_TIMEOUT' }));
        if (signal.aborted) {
            Promise.resolve(promise).catch(() => {});
            abort();
            return;
        }
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
}

let membershipAuthenticationSerial = 0;
async function requestApi(action, params = {}, postData = null) {
    if (globalThis.AppBackend) return globalThis.AppBackend.request(action, params, postData);
    if (typeof document !== 'undefined' && document.documentElement?.dataset?.backend === 'supabase') throw new Error('Supabase 연결 모듈을 불러오지 못했습니다.');
    if (postData && ['addCards', 'moveCards', 'discardCards', 'clearUserData', 'migrateFromData', 'migrateFromSheet'].includes(action)
        && !requireInventoryReady()) throw Object.assign(new Error('보유 정보 동기화가 필요합니다.'), { code: 'INVENTORY_SYNC_REQUIRED' });
    const loginTiming = typeof window !== 'undefined' && params.warmup !== 'true' && ['getRegistrationStatus', 'getUserData'].includes(action)
        ? window.YgoLoginTiming?.request(action) : null;
    const endpoint = FIREBASE_CONFIG.ENDPOINTS[action];
    if (!endpoint) {
        throw new Error(`등록되지 않은 서버 기능입니다: ${action}`);
    }

    const url = new URL(endpoint);
    const savedId = localStorage.getItem(STORAGE_KEY);

    // API 키 제거, ssId 자동 추가 (GET 파라미터)
    if (savedId) url.searchParams.append("ssId", savedId);
    for (const key in params) { url.searchParams.append(key, params[key]); }

    const options = {
        method: postData ? 'POST' : 'GET',
        headers: {
            'Content-Type': 'application/json'
        }
    };
    if (action === 'searchCardByImage') options.signal = AbortSignal.timeout(45000);
    if (action === 'getRegistrationStatus') options.signal = AbortSignal.timeout(30000);
    const preparingMembership = postData?.membershipPrepare === true;
    const loginResultStream = !preparingMembership && (action === 'getRegistrationStatus' && String(params.includeUserData) === 'true'
        || action === 'getUserData' && postData && !postData.membershipClaimsOnly && !postData.membershipClaimsReadOnly
          && params.warmup !== 'true' && postData.warmup !== 'true');
    const resultStream = !preparingMembership && (loginResultStream || ['verifyYoutubeMembership', 'verifyDiscordMembership'].includes(action))
        && typeof window !== 'undefined' && window.YgoAuthenticationResult;
    if (resultStream && loginResultStream && action === 'getRegistrationStatus') url.searchParams.set('loginMembershipResult', 'true');
    const resultSerial = resultStream ? ++membershipAuthenticationSerial : 0, resultRevision = resultStream ? authStateRevision : 0;
    // 첫 결과 뒤 화면을 이동해도 작은 인증 요청의 기록 정리를 이어간다.
    if (resultStream) options.keepalive = true;
    if (preparingMembership) {
        options.signal = AbortSignal.timeout(5000);
        // Discord 이동으로 문서가 바뀌어도 작은 읽기 준비 요청은 전달한다.
        options.keepalive = true;
    }

    // 최신 Firebase ID Token을 즉시 가져와 Authorization 헤더에 설정 (오래된 캐시 토큰으로 인한 403 거부 방지)
    const authUser = UserStore.user || (['getRegistrationStatus', 'completeRegistration'].includes(action)
        ? firebase.auth().currentUser : null);
    if (preparingMembership && !authUser) throw Object.assign(new Error('로그인이 필요합니다.'), { code: 'AUTH_INVALID' });
    if (authUser) {
        try {
            const prepareToken = () => awaitApiPreparation(authUser.getIdToken(), options.signal);
            const token = await (loginTiming ? loginTiming.measure('id_token', prepareToken) : prepareToken());
            _cachedAuthToken = token;
            options.headers['Authorization'] = `Bearer ${token}`;
        } catch (authErr) {
            if (authErr.code === 'SERVICE_CHECK_TIMEOUT') throw authErr;
            const invalid = ['auth/user-token-expired', 'auth/invalid-user-token', 'auth/user-disabled', 'auth/user-not-found'].includes(authErr.code);
            throw Object.assign(new Error('로그인 인증 정보를 준비하지 못했습니다.'), {
                code: invalid ? 'AUTH_INVALID' : 'AUTH_VERIFICATION_UNAVAILABLE'
            });
        }
    }

    // App Check 실패를 로그인 실패로 바꾸거나 인증 헤더 없이 요청하지 않는다.
    const prepareAppCheck = () => awaitApiPreparation(getApiAppCheckToken(), options.signal);
    options.headers['X-Firebase-AppCheck'] = await (loginTiming ? loginTiming.measure('app_check', prepareAppCheck) : prepareAppCheck());

    if (postData) {
        // POST 요청 시 ssId를 본문에 포함
        const body = {
            ...postData,
            ...(resultStream ? loginResultStream ? { loginMembershipResult: true } : { authenticationResultStream: true } : {}),
            ssId: savedId
        };
        options.body = JSON.stringify(body);
    }

    try {
        if (preparingMembership && (authUser.uid !== UserStore.user?.uid
            || authUser.uid !== firebase.auth().currentUser?.uid)) {
            throw Object.assign(new Error('서비스 계정이 변경되었습니다.'), { code: 'REQUEST_SUPERSEDED' });
        }
        const sendRequest = () => fetch(url.toString(), options);
        const response = await (loginTiming ? loginTiming.measure('http', sendRequest) : sendRequest());
        if (loginTiming) { try { loginTiming.server(response.headers?.get('X-YGO-Login-Timing')); } catch (_) {} }
        if (!response.ok) {
            const errBody = await response.json().catch(() => ({}));
            console.error(`[API Error Details] Action: ${action}, Status: ${response.status}`, errBody);
            const detailMsg = errBody.message || errBody.name || (Object.keys(errBody).length ? JSON.stringify(errBody) : "");
            throw Object.assign(new Error(detailMsg ? `HTTP ${response.status}: ${detailMsg}` : `HTTP error! status: ${response.status}`), { code: errBody.code, status: response.status });
        }

        const currentResult = () => resultSerial === membershipAuthenticationSerial && resultRevision === authStateRevision
            && authUser?.uid === UserStore.user?.uid && firebase.auth().currentUser?.uid === authUser?.uid;
        const parse = () => resultStream ? resultStream.read(response, {
            // 기존 전체 JSON과 같은 보유 정보 크기를 허용한다. 인증 단독 응답의 1MiB 제한은 유지한다.
            ...(loginResultStream ? { maxBytes: Infinity } : {}),
            async onRecorded(result) {
                if (loginResultStream) {
                    // 첫 응답의 회원 여부/보유 정보를 늦은 기록 프레임으로 덮어쓰지 않는다.
                    // 전체 데이터 적용에서 시작한 제한된 완료 확인을 중복 시작하지 않는다.
                    return;
                }
                if (!currentResult() || result.uid !== authUser.uid || !result.membershipClaims) return;
                const ready = await refreshMembershipClaims(authUser, result);
                if (!currentResult()) return;
                UserStore.claimsSyncStatus = ready ? 'ready' : 'pending';
                followMembershipClaims(authUser);
                setInventorySyncStatus(UserStore.inventorySyncStatus);
            },
            onFailure() {
                if (currentResult()) showToast(loginResultStream
                    ? '회원 정보의 권한 동기화 결과를 확인하지 못했습니다. 다시 확인해 주세요.'
                    : '인증 결과의 작업 기록을 확인하지 못했습니다. 다시 확인해 주세요.', 'toast-warn');
            }
        }) : response.json();
        const res = await (loginTiming ? loginTiming.measure('response_json', parse) : parse());
        if (resultStream && loginResultStream) {
            const data = res?.initialData || res;
            if (data?.membershipClaims) data.membershipClaims.tokenRefreshDeferred = true;
        }

        if (res && res.debug && res.debug.serverTime) {
            // [로그 삭제] 서버 실행 시간 로그 제거
        }

        return res;
    } catch (e) {
        console.error(`[API] callApi Error (${action}):`, e);
        // [토스트 삭제] UI에서 안내되거나 상위에서 처리하므로 제거
        throw e;
    }
}



// 검색 시 최신 공통 목록을 확인합니다. 같은 탭에서는 1분에 한 번만 조회합니다.
let _lastPublicRefreshAt = 0;
let _publicRefreshPromise = null;
async function refreshPublicDataQuietly() {
    if (globalThis.AppBackend && !globalThis.AppBackend.capabilities.publicRefresh) return;
    if (!UserStore.isInitialSyncDone || document.hidden) return;
    if (_publicRefreshPromise) return _publicRefreshPromise;
    if (Date.now() - _lastPublicRefreshAt < 60000) return;
    _publicRefreshPromise = (async () => {
        const res = await callApi('getInitialData');
        await applyPublicData(res);
        _lastPublicRefreshAt = Date.now();
    })();
    try { await _publicRefreshPromise; }
    catch (error) { console.warn('[Sync] 검색 목록 갱신 실패:', error); }
    finally { _publicRefreshPromise = null; }
}
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void refreshPublicDataQuietly();
});

async function refreshInitialData(forceSync = false) {
    if (globalThis.AppBackend) return globalThis.AppBackend.refreshInitialData();
    showLoading(true, "공통 데이터 동기화 중...");
    try {
        const lastSync = parseInt(localStorage.getItem('masterSyncUpdatedAt')) || 0;
        const now = Date.now();

        // 30분 이내 동기화 기록이 있고 강제 동기화가 아니면 생략
        const SYNC_COOLDOWN_MS = 30 * 60 * 1000;
        if (!forceSync && lastSync > 0 && (now - lastSync) < SYNC_COOLDOWN_MS) {
            UserStore.isInitialSyncDone = true;
            checkAndHideInitialLoading();
            return;
        }

        // [스마트 온디맨드 웜업] getInitialData와 동시에 getCardMetadata 컨테이너를 선제 깨우기
        // → API 컨테이너 초기화 요청이며 전체 카드 데이터를 미리 읽지는 않습니다.
        callApi('getCardMetadata', { warmup: 'true' }).catch(() => {});

        const res = await callApi('getInitialData');

        await applyPublicData(res);
        _lastPublicRefreshAt = Date.now();
        UserStore.isInitialSyncDone = true; // 동기화 완료 플래그 설정
        checkAndHideInitialLoading(); // 통합 로딩 종료 체크

    } catch (e) {
        console.error("[Sync] refreshInitialData Error:", e);
        UserStore.isInitialSyncDone = true; // 에러 발생 시에도 로직 진행을 위해 플래그 설정
        checkAndHideInitialLoading();
    }
}

async function startSearch(isInstant = false, searchType = 'auto', forcedIsTarget = null, navigationOptions = {}) {
    const sequence = ++searchSequence;
    // [AD] 검색 시 결과 하단 광고 갱신
    if (typeof refreshAdUnit === 'function') refreshAdUnit('search-result-ad');

    const inputEl = document.getElementById('card-search');
    if (!inputEl) return;
    const name = inputEl.value.trim();
    if (!name) return;

    // 선택 즉시 닫고 blur로 예약된 자동완성도 취소합니다.
    inputEl.blur();
    toggleSearchWrapper(false, { immediate: true });
    checkClearBtn();

    // 이미 목록에서 고른 대상은 공통 목록의 네트워크 갱신을 기다리지 않습니다.
    if (forcedIsTarget === true) {
        void refreshPublicDataQuietly();
    }

    const queryNorm = normalizeStr(name);

    // 1. 대상 검색(isTarget) 여부 판별 로직
    let isTarget = false;
    if (forcedIsTarget !== null) {
        // 최근 검색어 클릭 등 명시적으로 isTarget 값이 전달된 경우에만 적용
        isTarget = forcedIsTarget;
    } else {
        // 상단 검색바 입력, 엔터, 돋보기 버튼, 이름/번호 검색 실행 시에는
        // 동일 이름의 카드가 DB에 존재하더라도 무조건 [포괄 검색 목록]을 띄움
        isTarget = false;
    }

    // 최근 검색어 저장
    saveRecentSearch(name, searchType, isTarget);

    // 2. 검색 실행 및 결과 생성
    if (isTarget) {
        // [대상 검색]
        let targetCardName = name;
        let prioritizeNumber = null;

        const matchedNameInOwned = typeof cardCacheInstance !== 'undefined' ? cardCacheInstance.getAllNames().find(n => normalizeStr(String(n)) === queryNorm) : null;
        const matchedNameInDb = typeof CardDataStore.allCardNames !== 'undefined' ? CardDataStore.allCardNames.find(n => normalizeStr(String(n)) === queryNorm) : null;
        const exactCardName = matchedNameInOwned || matchedNameInDb;

        const matchedNumberInOwned = typeof cardCacheInstance !== 'undefined' ? cardCacheInstance.getOwnedNumbers().find(n => normalizeStr(String(n)) === queryNorm) : null;
        const matchedNumberInDb = typeof CardDataStore.allCardNumbers !== 'undefined' ? CardDataStore.allCardNumbers.find(n => normalizeStr(String(n)) === queryNorm) : null;
        const exactCardNumber = matchedNumberInOwned || matchedNumberInDb;

        let fetchedCid = null;

        if (searchType === 'number' || (exactCardNumber && !exactCardName)) {
            prioritizeNumber = exactCardNumber || name;
            let resolvedName = typeof getCardNameByNumber === 'function' ? getCardNameByNumber(prioritizeNumber) : null;
            if (!resolvedName && typeof cardCacheInstance !== 'undefined') {
                const foundRow = cardCacheInstance.getInventory().find(r => normalizeStr(String(r[1])) === queryNorm);
                if (foundRow && foundRow[0]) resolvedName = String(foundRow[0]);
            }
            if (!resolvedName) {
                try {
                    const res = await callApi('getCardMetadata', { cardNo: prioritizeNumber });
                    if (res && res.success && res.name) {
                        resolvedName = res.name;
                        if (res.cid) fetchedCid = res.cid;
                    }
                } catch (e) {
                    console.warn("[startSearch] getCardMetadata cardNo error:", e);
                }
            }
            if (resolvedName) {
                targetCardName = resolvedName;
            } else if (exactCardName) {
                targetCardName = exactCardName;
            }
        } else if (exactCardName) {
            targetCardName = exactCardName;
        }

        if (sequence !== searchSequence) return;

        const targetCid = fetchedCid || findCidByNameOrNo(targetCardName, prioritizeNumber);
        if (typeof SearchNavigation === 'undefined') updateSearchHash('target', { cid: targetCid, code: prioritizeNumber }, true);

        // CID 기반 다국어 보유 카드 수집 및 언어권 상단 정렬
        let targetRows = getInventoryRowsByCidOrName(targetCid, targetCardName, prioritizeNumber);

        // 카드의 기본 정보를 먼저 표시하고 메타데이터는 같은 화면 안에서 갱신한다.
        const metaPromise = fetchCardMetaWithCache(targetCid, targetCardName, prioritizeNumber);

        const renderTargetFunc = (mountContainer) => {
            // 동기적으로 그려지는 카드명/캐시 정보부터 표시하고 상세 조회는 이어서 반영합니다.
            void renderTargetSearchResult(targetCardName, targetRows, prioritizeNumber, mountContainer, targetCid, metaPromise)
                .catch(error => console.error('[Search] 대상 카드 렌더링 실패:', error));
        };

        if (typeof SearchNavigation !== 'undefined') {
            SearchNavigation.showTarget({ type: 'target', targetCardName, targetRows,
                prioritizeNumber, targetCid, targetMeta: null }, renderTargetFunc,
                { ...navigationOptions, instant: isInstant });
        } else {
            await renderTargetFunc();
            switchToMode('search', isInstant);
        }

    } else {
        if (typeof SearchNavigation === 'undefined') updateSearchHash('broad', { searchType, key: name }, true);
        await showCatalogSearch(name, searchType, sequence, isInstant);
        return;
    }

    toggleSearchWrapper(false, { immediate: true });
    checkClearBtn();
    showLoading(false);
}

const DECODE_ATTR = [
    ["어둠", "빛", "땅", "물", "화염", "바람", "신"],
    ["闇属性", "光属性", "地属性", "水属性", "炎属性", "風属性", "神属性"],
    ["DARK", "LIGHT", "EARTH", "WATER", "FIRE", "WIND", "DIVINE"],
    ["暗属性", "光属性", "地属性", "水属性", "炎属性", "风属性", "神属性"],
    ["DARK", "LIGHT", "EARTH", "WATER", "FIRE", "WIND", "DIVINE"]
];

const DECODE_SPECIES = [
    ["드래곤족", "언데드족", "악마족", "화염족", "해룡족", "암석족", "기계족", "어류족", "공룡족", "곤충족", "야수족", "야수전사족", "식물족", "물족", "전사족", "비행야수족", "천사족", "마법사족", "번개족", "파충류족", "창조신족", "환신야수족", "사이킥족", "환룡족", "사이버스족", "환상마족"],
    ["ドラゴン族", "アンデット族", "悪魔族", "炎族", "海竜族", "岩石族", "機械族", "魚族", "恐竜族", "昆虫族", "獣族", "獣戦士族", "植物族", "水族", "戦士族", "鳥獣族", "天使族", "魔法使い族", "雷族", "爬虫類族", "創造神族", "幻神獣族", "サイキック族", "幻竜族", "サイバース族", "幻想魔族"],
    ["Dragon", "Zombie", "Fiend", "Pyro", "Sea Serpent", "Rock", "Machine", "Fish", "Dinosaur", "Insect", "Beast", "Beast-Warrior", "Plant", "Aqua", "Warrior", "Winged Beast", "Fairy", "Spellcaster", "Thunder", "Reptile", "Creator God", "Divine-Beast", "Psychic", "Wyrm", "Cyberse", "Illusion"],
    ["龙族", "不死族", "恶魔族", "炎族", "海龙族", "岩石族", "机械族", "鱼族", "恐龙族", "昆虫族", "兽族", "兽战士族", "植物族", "水族", "战士族", "鸟兽族", "天使族", "魔法师族", "雷族", "爬虫类族", "创造神族", "幻神兽族", "念动力族", "幻龙族", "电子界族", "幻想魔族"],
    ["Dragon", "Zombie", "Fiend", "Pyro", "Sea Serpent", "Rock", "Machine", "Fish", "Dinosaur", "Insect", "Beast", "Beast-Warrior", "Plant", "Aqua", "Warrior", "Winged Beast", "Fairy", "Spellcaster", "Thunder", "Reptile", "Creator God", "Divine-Beast", "Psychic", "Wyrm", "Cyberse", "Illusion"]
];

const DECODE_ETC = [
    ["일반", "효과", "의식", "융합", "싱크로", "엑시즈", "펜듈럼", "스피릿", "툰", "튜너", "유니온", "듀얼", "리버스", "링크", "특수 소환", "일반 마법", "지속 마법", "속공 마법", "필드 마법", "장착 마법", "의식 마법", "일반 함정", "지속 함정", "카운터 함정"],
    ["通常", "効果", "儀式", "融合", "シンクロ", "エクシーズ", "ペンデュラム", "スピリット", "トゥーン", "チューナー", "ユニオン", "デュアル", "リバース", "リンク", "特殊召喚", "通常魔法", "永続魔法", "速攻魔法", "フィールド魔法", "装備魔法", "儀式魔法", "通常罠", "永続罠", "カウンター罠"],
    ["Normal", "Effect", "Ritual", "Fusion", "Synchro", "Xyz", "Pendulum", "Spirit", "Toon", "Tuner", "Union", "Gemini", "Flip", "Link", "Special Summon", "Normal Spell", "Continuous Spell", "Quick-Play Spell", "Field Spell", "Equip Spell", "Ritual Spell", "Normal Trap", "Continuous Trap", "Counter Trap"],
    ["通常", "效果", "仪式", "融合", "同调", "超量", "灵摆", "灵魂", "卡通", "调整", "同盟", "二重", "反转", "连接", "特殊召唤", "通常魔法", "永续魔法", "速攻魔法", "场地魔法", "装备魔法", "仪式魔法", "通常陷阱", "永续陷阱", "反击陷阱"],
    ["Normal", "Effect", "Ritual", "Fusion", "Synchro", "Xyz", "Pendulum", "Spirit", "Toon", "Tuner", "Union", "Gemini", "Flip", "Link", "Special Summon", "Normal Spell", "Continuous Spell", "Quick-Play Spell", "Field Spell", "Equip Spell", "Ritual Spell", "Normal Trap", "Continuous Trap", "Counter Trap"]
];

function getRegionLocIdx() {
    const raw = (typeof UIStore.currentRegion !== 'undefined' ? UIStore.currentRegion : 'ko').toString().toLowerCase();
    const map = {
        'ko': 0, 'kr': 0,
        'ja': 1, 'jp': 1,
        'ae': 2,
        'cn': 3, 'zh': 3, 'sc': 3,
        'en': 4, 'de': 4, 'fr': 4, 'it': 4, 'es': 4, 'pt': 4
    };
    return map[raw] !== undefined ? map[raw] : 0;
}

function getRegionLangKeys() {
    const raw = (typeof UIStore.currentRegion !== 'undefined' ? UIStore.currentRegion : 'ko').toString().toLowerCase();
    const map = {
        'ko': ['ko', 'KR', 'KO', 0],
        'kr': ['ko', 'KR', 'KO', 0],
        'ja': ['ja', 'JP', 'JA', 1],
        'jp': ['ja', 'JP', 'JA', 1],
        'ae': ['ae', 'AE', 2],
        'cn': ['cn', 'zh', 'SC', 'CN', 3],
        'zh': ['cn', 'zh', 'SC', 'CN', 3],
        'sc': ['cn', 'zh', 'SC', 'CN', 3],
        'en': ['en', 'EN', 4],
        'de': ['de', 'DE', 'en', 'EN', 4],
        'fr': ['fr', 'FR', 'en', 'EN', 4],
        'it': ['it', 'IT', 'en', 'EN', 4],
        'es': ['es', 'ES', 'en', 'EN', 4],
        'pt': ['pt', 'PT', 'en', 'EN', 4]
    };
    return map[raw] || ['ko', 'KR', 'KO', 0];
}

function extractLangData(cardMeta) {
    if (!cardMeta || !cardMeta.info) return null;
    const info = cardMeta.info;

    // info가 1차원 데이터 배열일 경우 즉시 반환
    if (Array.isArray(info)) {
        if (info.length > 0) return info;
    }

    const keys = getRegionLangKeys();

    for (const k of keys) {
        if (info[k] && Array.isArray(info[k]) && info[k].length > 0) return info[k];
    }
    if (info['ko'] && Array.isArray(info['ko']) && info['ko'].length > 0) return info['ko'];
    if (info['KR'] && Array.isArray(info['KR']) && info['KR'].length > 0) return info['KR'];
    if (info[0] && Array.isArray(info[0]) && info[0].length > 0) return info[0];

    if (info['en'] && Array.isArray(info['en']) && info['en'].length > 0) return info['en'];
    if (info['EN'] && Array.isArray(info['EN']) && info['EN'].length > 0) return info['EN'];
    if (info[4] && Array.isArray(info[4]) && info[4].length > 0) return info[4];

    const anyKey = Object.keys(info)[0];
    if (anyKey && Array.isArray(info[anyKey]) && info[anyKey].length > 0) return info[anyKey];

    return null;
}

// 과거 저장 데이터의 줄바꿈 표기를 보정하되 HTML로 해석하지 않습니다.
function normalizeCardTextLineBreaks(value) {
    return String(value || "").replace(/<br\s*\/?\s*>/gi, "\n");
}

function extractCidFromMeta(cardMeta) {
    if (!cardMeta) return null;
    if (cardMeta.cid && cardMeta.cid !== "null" && cardMeta.cid !== "undefined") return cardMeta.cid;
    if (cardMeta.rawSlot && Array.isArray(cardMeta.rawSlot) && cardMeta.rawSlot[1]) {
        return cardMeta.rawSlot[1];
    }

    return null;
}

function findCidByNameOrNo(cardName, cardNo = null) {
    const number = String(cardNo || '').trim().toUpperCase();
    const name = normalizeStr(String(cardName || ''));
    if (number) {
        if (Object.hasOwn(cardCacheInstance._inventoryNoToCid || {}, number)) return cardCacheInstance._inventoryNoToCid[number];
        if (Object.hasOwn(ClientCache._knownNumberToCid, number)) return ClientCache._knownNumberToCid[number];
    }
    if (Object.hasOwn(cardCacheInstance._inventoryNameToCid || {}, name)) return cardCacheInstance._inventoryNameToCid[name];
    return ClientCache._knownNameToCid[cardName] || ClientCache._knownNameToCid[name] || null;
}

async function renderTargetByCid(cid, code = null, isInstant = false, navigationOptions = {}) {
    if (!cid) return;
    ++searchSequence;
    const cardName = ClientCache.getCardNameByCid(cid, UIStore.currentRegion) || code || `CID: ${cid}`;
    const targetRows = getInventoryRowsByCidOrName(cid, cardName, code);
    // Do not wait for the network before entering the selected card.
    const metaPromise = fetchCardMetaWithCache(cid, cardName).then(meta => {
        if (meta?.info) {
            const names = Object.values(meta.info).filter(value => Array.isArray(value)
                && typeof value[0] === 'string' && value[0].length < 150).map(value => value[0]);
            ClientCache.registerCid(cid, names, code ? [code] : []);
        }
        return meta;
    });
    const render = mount => renderTargetSearchResult(cardName, targetRows, code, mount, cid, metaPromise);
    if (typeof SearchNavigation !== 'undefined') {
        SearchNavigation.showTarget({ type: 'target', targetCardName: cardName, targetRows,
            prioritizeNumber: code, targetCid: cid, targetMeta: null }, render,
            { ...navigationOptions, instant: isInstant });
    } else {
        switchToMode('search', isInstant);
        await render();
    }
}

async function renderTargetSearchResult(targetCardName, targetRows, prioritizeNumber = null, mountContainer = null, forcedCid = null, preFetchedMetaPromise = null) {
    let targetCid = forcedCid || findCidByNameOrNo(targetCardName, prioritizeNumber);
    if (targetCid) targetRows = getInventoryRowsByCidOrName(targetCid, targetCardName, prioritizeNumber);

    const previousCardName = (typeof lastSearchState !== 'undefined' && lastSearchState) ? lastSearchState.targetCardName : null;
    const previousCid = (typeof lastSearchState !== 'undefined' && lastSearchState) ? lastSearchState.targetCid : null;

    const targetArea = mountContainer || (typeof SearchNavigation !== 'undefined' && SearchNavigation.currentPane()) || document.getElementById('result-area');
    targetArea.setAttribute('aria-busy', 'false');

    // 동일한 카드의 보유 목록 수정 시 상단 카드 정보는 유지합니다.
    const existingTempBox = targetArea.querySelector('.search-card');
    const existingBottomSec = targetArea.querySelector('.target-inventory-section');

    const isSameCard = previousCid && targetCid
        ? String(previousCid) === String(targetCid)
        : previousCardName && targetCardName && previousCardName === targetCardName;

    if (existingTempBox && existingBottomSec && !mountContainer && isSameCard) {
        lastSearchState = { ...lastSearchState, targetRows, targetCid };
        if (typeof SearchNavigation !== 'undefined') SearchNavigation.updateTarget(lastSearchState, targetArea);
        renderOwnedCardsToContainer(targetRows, existingBottomSec);
        return;
    }

    const targetSequence = ++searchSequence;
    targetArea.innerHTML = '';

    const tempBox = document.createElement('article');
    tempBox.className = 'search-card color-surface-001 shape-rounded002';
    const titleId = `search-card-title-${targetSequence}`;
    tempBox.setAttribute('aria-labelledby', titleId);
    targetArea.appendChild(tempBox);

    // 2. 하단 보유 카드 검색 결과 영역
    // 언어 변경으로 상단 설명을 다시 그려도 보유 상세의 펼침 상태는 유지합니다.
    const bottomSec = isSameCard && existingBottomSec ? existingBottomSec : document.createElement('section');
    bottomSec.className = 'target-inventory-section';
    bottomSec.setAttribute('aria-label', '보유 정보');
    renderOwnedCardsToContainer(targetRows, bottomSec);
    targetArea.appendChild(bottomSec);

    // 이름·정보·설명을 textContent와 DocumentFragment로 조립합니다.
    const renderCardDetails = (cardMeta) => {
        const previousFocus = document.activeElement;
        let focusSelector = null;
        let focusArtwork = null;
        if (previousFocus && tempBox.contains(previousFocus)) {
            const focusClasses = ['search-card__title', 'search-results__back', 'search-art-toggle', 'search-art-prev', 'search-art-next',
                'search-art-strip-prev', 'search-art-strip-next'];
            const focusedClass = focusClasses.find(name => previousFocus.classList.contains(name));
            if (focusedClass) focusSelector = `.${focusedClass}`;
            else if (previousFocus.classList.contains('search-art-thumb')) focusArtwork = previousFocus.dataset.artworkId;
            else if (previousFocus === tempBox.querySelector('.search-art-region > button')) focusSelector = '.search-art-region > button';
        }
        const locIdx = getRegionLocIdx();
        const langArr = extractLangData(cardMeta);

        // 메타 데이터 디코딩
        let nameVal = targetCardName;
        if (langArr && langArr[0]) nameVal = langArr[0];

        let kind = 0, etcList = [], levelVal = null, attrVal = null, speciesVal = null;
        let atkVal = null, defVal = null, scaleVal = null, cardTextVal = "", penTextVal = "";

        if (cardMeta && cardMeta.info) {
            const info = cardMeta.info;
            kind = info[10] !== undefined ? info[10] : (info["10"] !== undefined ? info["10"] : 0);
            etcList = Array.isArray(info[11] || info["11"]) ? (info[11] || info["11"]) : [];
            levelVal = info[12] !== undefined ? info[12] : info["12"];
            attrVal = info[13] !== undefined ? info[13] : info["13"];
            speciesVal = info[14] !== undefined ? info[14] : info["14"];
            atkVal = info[15] !== undefined ? info[15] : info["15"];
            defVal = info[16] !== undefined ? info[16] : info["16"];
            scaleVal = info[17] !== undefined ? info[17] : info["17"];
            if (langArr) {
                cardTextVal = normalizeCardTextLineBreaks(langArr[3]);
                penTextVal = normalizeCardTextLineBreaks(langArr[4]);
            }
        }

        const fragment = document.createDocumentFragment();

        // 1. [이름] 구역 — textContent로 XSS 안전하게 처리 (escapeHTML 불필요)
        const sec1 = document.createElement('header');
        sec1.className = 'search-card__name';
        const nameTitle = document.createElement('h2');
        nameTitle.className = 'search-card__title color-text-000';
        nameTitle.id = titleId;
        nameTitle.textContent = nameVal;
        sec1.appendChild(nameTitle);
        const backLink = tempBox.querySelector('.search-results__back');
        if (backLink) sec1.prepend(backLink);
        if (prioritizeNumber) {
            const nameSub = document.createElement('p');
            nameSub.className = 'search-card__number color-text-002';
            nameSub.textContent = `(검색 번호: ${prioritizeNumber})`;
            sec1.appendChild(nameSub);
        }
        fragment.appendChild(sec1);

        // 2. [정보] 구역
        const sec2 = document.createElement('div');
        sec2.className = 'search-card__info border-basic shape-rounded002';

        if (kind === 1 || kind === 2 || etcList.some(e => e >= 15 && e <= 23)) {
            // 마법 / 함정 ➔ 1행 1열 단일 셀 구도
            let spellTrapText = (kind === 2 || etcList.some(e => e >= 21 && e <= 23)) ? "함정" : "마법";
            const matchedEtc = etcList.find(e => e >= 15 && e <= 23);
            if (matchedEtc !== undefined && DECODE_ETC[locIdx] && DECODE_ETC[locIdx][matchedEtc]) {
                spellTrapText = DECODE_ETC[locIdx][matchedEtc];
            } else {
                spellTrapText = (kind === 2 ? "일반 함정" : "일반 마법");
            }
            const stTable = document.createElement('table');
            stTable.className = 'search-card__table color-text-000';
            stTable.setAttribute('aria-label', '카드 정보');
            const stTbody = document.createElement('tbody');
            const stTr = document.createElement('tr');
            const stTd = document.createElement('td');
            stTd.className = 'search-card__kind search-card__value color-surface-001 color-text-001 border-basic';
            stTd.textContent = spellTrapText;
            stTr.appendChild(stTd); stTbody.appendChild(stTr); stTable.appendChild(stTbody);
            sec2.appendChild(stTable);
        } else {
            // 몬스터 ➔ 기본 정보 2행과 조건부 분류 1행
            const attrText = (attrVal !== null && attrVal !== undefined && DECODE_ATTR[locIdx]?.[attrVal]) ? DECODE_ATTR[locIdx][attrVal] : "-";
            const speciesText = (speciesVal !== null && speciesVal !== undefined && DECODE_SPECIES[locIdx]?.[speciesVal]) ? DECODE_SPECIES[locIdx][speciesVal] : "-";
            let levelLabel = "레벨";
            if (etcList.includes(5)) levelLabel = "랭크";
            else if (etcList.includes(13)) levelLabel = "LINK";
            const levelDisplay = levelVal !== null && levelVal !== undefined ? (levelLabel === "LINK" ? `LINK-${levelVal}` : `★ ${levelVal}`) : "-";
            const atkDisplay = atkVal !== null && atkVal !== undefined ? (atkVal === -1 ? "?" : String(atkVal)) : "-";
            const defDisplay = !etcList.includes(13) && defVal !== null && defVal !== undefined ? (defVal === -1 ? "?" : String(defVal)) : "-";
            const scaleDisplay = etcList.includes(6) && scaleVal !== null && scaleVal !== undefined && scaleVal !== '' ? String(scaleVal) : "-";

            const mTable = document.createElement('table');
            mTable.className = 'search-card__table search-card__table--monster color-text-000';
            mTable.setAttribute('aria-label', '카드 정보');
            const mTbody = document.createElement('tbody');

            // 행 1: 속성 / 종족 / 레벨
            const mkThTd = (key, label, value) => {
                const th = document.createElement('th');
                th.className = 'search-card__label color-surface-002 color-text-000 border-basic';
                th.id = `search-card-${targetSequence}-${key}`;
                if (key === 'pendulum') {
                    const fullLabel = document.createElement('span');
                    fullLabel.className = 'search-card__label-desktop';
                    fullLabel.textContent = label;
                    const shortLabel = document.createElement('span');
                    shortLabel.className = 'search-card__label-mobile';
                    shortLabel.textContent = '펜듈럼';
                    th.append(fullLabel, shortLabel);
                } else {
                    th.textContent = label;
                }
                const td = document.createElement('td');
                td.className = 'search-card__value color-surface-001 color-text-001 border-basic';
                td.setAttribute('headers', th.id);
                td.textContent = value;
                return [th, td];
            };
            const tr1 = document.createElement('tr');
            tr1.append(...mkThTd('attribute', '속성', attrText), ...mkThTd('race', '종족', speciesText), ...mkThTd('level', levelLabel, levelDisplay));
            mTbody.appendChild(tr1);

            // 행 2: 공격력 / 수비력 / 펜듈럼 스케일
            const tr2 = document.createElement('tr');
            tr2.append(...mkThTd('attack', '공격력', atkDisplay), ...mkThTd('defense', '수비력', defDisplay), ...mkThTd('pendulum', '펜듈럼 스케일', scaleDisplay));
            mTbody.appendChild(tr2);

            // 행 3: 분류 배지 (조건부)
            const monsterEtcList = etcList.filter(e => e >= 0 && e <= 14);
            if (monsterEtcList.length > 0) {
                const tr3 = document.createElement('tr');
                const tdBadge = document.createElement('td');
                tdBadge.colSpan = 6;
                tdBadge.className = 'search-card__classifications color-surface-001 color-text-001 border-basic';
                const accessibleLabel = document.createElement('span');
                accessibleLabel.className = 'visually-hidden';
                accessibleLabel.textContent = '분류: ';
                const badges = document.createElement('div');
                badges.className = 'ui-chip-list';
                monsterEtcList.forEach(e => {
                    const label = DECODE_ETC[locIdx]?.[e] || "";
                    if (label) {
                        const span = document.createElement('span');
                        span.className = 'ui-chip ui-chip--compact color-tint-theme shape-capsule';
                        span.textContent = label;
                        badges.appendChild(span);
                    }
                });
                if (badges.children.length) {
                    tdBadge.append(accessibleLabel, badges);
                    tr3.appendChild(tdBadge);
                    mTbody.appendChild(tr3);
                }
            }
            mTable.appendChild(mTbody);
            sec2.appendChild(mTable);
        }
        fragment.appendChild(sec2);

        // 3. 펜듈럼 효과와 카드 텍스트를 하나의 설명 영역에 배치합니다.
        const textSection = document.createElement('div');
        textSection.className = 'search-card__text color-surface-000 color-text-000 shape-rounded002';
        const appendTextSection = (title, content) => {
            const section = document.createElement('section');
            section.className = 'search-card__text-section';
            const heading = document.createElement('h3');
            heading.className = 'search-card__text-heading';
            heading.textContent = title;
            const body = document.createElement('p');
            body.className = 'search-card__text-body';
            body.textContent = content;
            section.append(heading, body);
            textSection.appendChild(section);
        };
        if (etcList.includes(6)) appendTextSection('[펜듈럼 효과]', penTextVal || '-');
        appendTextSection('[카드 텍스트]', cardTextVal || '카드 텍스트 정보가 없습니다.');
        fragment.appendChild(textSection);

        // tempBox 초기화 후 Fragment를 한 번에 삽입 (Reflow 1회)
        tempBox.innerHTML = '';
        tempBox.appendChild(fragment);
        const artworkReady = SearchIllustrations.mount(tempBox, targetCid || cardMeta?.cid, cardMeta?.info);
        const restoreDetailFocus = () => {
            if (!tempBox.isConnected || targetSequence !== searchSequence) return;
            // 조회를 기다리는 동안 사용자가 다른 조작으로 옮긴 초점은 가져오지 않습니다.
            if (document.activeElement !== previousFocus && document.activeElement !== document.body) return;
            const control = focusArtwork
                ? [...tempBox.querySelectorAll('.search-art-thumb')].find(thumb => thumb.dataset.artworkId === focusArtwork)
                : tempBox.querySelector(focusSelector);
            if (!control) return;
            if (focusSelector === '.search-card__title') {
                control.tabIndex = -1;
                control.classList.add('search-results__focus-target');
            }
            control.focus({ preventScroll: true });
        };
        if (focusSelector === '.search-card__title' || focusSelector === '.search-results__back' || focusSelector === '.search-art-toggle') restoreDetailFocus();
        else if (focusSelector || focusArtwork) Promise.resolve(artworkReady).then(restoreDetailFocus).catch(() => {});
    };

    if (!targetCid) targetCid = findCidByNameOrNo(targetCardName, prioritizeNumber);

    // 2순위: 로컬 캐시 메타데이터 확보
    let targetMeta = null;
    if (typeof cardCacheInstance !== 'undefined' && cardCacheInstance._mergedMeta && cardCacheInstance._mergedMeta[targetCardName]) {
        targetMeta = { rawSlot: cardCacheInstance._mergedMeta[targetCardName] };
    }
    if (!targetMeta && targetCid && typeof cidMetaMemoryCache !== 'undefined' && cidMetaMemoryCache.has(String(targetCid))) {
        targetMeta = cidMetaMemoryCache.get(String(targetCid));
    }

    // [방안 B - 1차 렌더링] 로컬 캐시(또는 카드명만)으로 즉시 렌더링 — API 대기 없음
    // 수평 전환 시 애니메이션 진행 중에 카드명이 즉시 표시되는 효과
    renderCardDetails(targetMeta);

    // 3순위: API 완료 대기 (preFetchedMetaPromise는 이미 RAM에서 거의 즉시 resolve)
    try {
        const res = await (preFetchedMetaPromise || fetchCardMetaWithCache(targetCid, targetCardName, prioritizeNumber));
        if (targetSequence !== searchSequence) return;
        if (res && (res.info || res.rawSlot)) {
            targetMeta = res;
            // [방안 B - 2차 렌더링] 완전한 API 데이터로 갱신
            renderCardDetails(targetMeta);
        }
    } catch (e) {
        console.warn("[TargetBox] getCardMetadata 연동 실패, 기본 캐시 유지:", e.message);
    }

    if (targetSequence !== searchSequence) return;
    const realCid = extractCidFromMeta(targetMeta) || targetCid;
    if (realCid && realCid !== "null" && realCid !== "undefined") {
        targetCid = realCid;
        ClientCache.registerCid(targetCid, [targetCardName], [prioritizeNumber]);
        targetRows = getInventoryRowsByCidOrName(targetCid, targetCardName, prioritizeNumber);
        // 전환 애니메이션이 끝나면 결과 요소는 임시 컨테이너에서 본문으로 이동합니다.
        if (bottomSec.isConnected) renderOwnedCardsToContainer(targetRows, bottomSec);
    }

    if (typeof SearchNavigation !== 'undefined') {
        SearchNavigation.updateTarget({ type: 'target', targetCardName, targetRows, prioritizeNumber, targetCid, targetMeta }, targetArea);
    } else if (!mountContainer) {
        lastSearchState = { type: 'target', targetCardName, targetRows, prioritizeNumber, targetCid, targetMeta };
        if (targetCid && targetCid !== "null" && targetCid !== "undefined") {
            updateSearchHash('target', { cid: targetCid, code: prioritizeNumber }, true);
        }
    }

    // [핵심] 2차 렌더링에서 이미 최종 메타데이터로 완성됨 (lastSearchState 갱신 후 추가 호출 불필요)

    // 보유 표는 자체 수명 주기로 초기화합니다. 전환 중인 이전 화면을 다시 초기화하지 않습니다.
    M.Tooltip.init(tempBox.querySelectorAll('.tooltipped'));
}

function renderOwnedCardsToContainer(rows, container) {
    if (UserStore.user && UserStore.inventorySyncStatus !== 'ready') {
        container.textContent = UserStore.inventorySyncStatus === 'error' ? '보유 정보 동기화 실패' : '보유 정보 동기화 중';
        return;
    }
    return OwnedCards.render(rows, container, {
        contextKey: typeof UserStore !== 'undefined' ? (UserStore.user?.uid || 'guest') : 'guest',
        compareRarity,
        describeRarity(key, card) {
            const index = rarityReverseMap[key];
            const row = index !== undefined ? rarityRows[index] : null;
            const preferred = row?.[rarityColMap[UIStore.currentRegion]];
            const locale = preferred ? '' : getOwnedCardDisplayContext(card).locale;
            return {
                label: preferred || row?.[rarityColMap[locale]] || key,
            };
        },
        async loadIllustration(card, illustration) {
            const { cid } = getOwnedCardDisplayContext(card);
            if (!cid || typeof IllustrationImages === 'undefined') return { status: 'error', url: null };
            // 저장된 CIID만 전달하며, 번호가 없을 때 다른 일러스트를 대신 선택하지 않습니다.
            try { return await IllustrationImages.preload(cid, illustration); }
            catch (_) { return { status: 'error', url: null }; }
        },
    });
}

function getOwnedCardDisplayContext(card = {}) {
    const number = String(card.number || '').trim().toUpperCase();
    const locales = ['ko', 'ja', 'ae', 'cn', 'en', 'de', 'fr', 'it', 'es', 'pt'];
    const validCid = value => /^[1-9]\d{0,9}$/.test(String(value || '')) ? String(value) : '';
    const localeEntries = meta => locales.map((locale, index) => {
        const data = meta?.info?.[locale] ?? meta?.info?.[index];
        return { locale, name: Array.isArray(data) ? data[0] : data?.name,
            packs: Array.isArray(data) ? data[2] : data?.packs };
    });
    const matchesNumber = meta => !!number && (Array.isArray(meta?.numbers)
        && meta.numbers.some(value => String(value).trim().toUpperCase() === number)
        || localeEntries(meta).some(entry => Object.keys(entry.packs || {}).some(value => value.trim().toUpperCase() === number)));
    const cache = typeof cidMetaMemoryCache !== 'undefined' ? cidMetaMemoryCache : new Map();
    const currentMeta = typeof lastSearchState !== 'undefined' ? lastSearchState?.targetMeta : null;
    let cid = validCid(card.cid);
    if (!cid && number) {
        const inventoryMap = typeof cardCacheInstance !== 'undefined' ? cardCacheInstance._inventoryNoToCid : null;
        const knownMap = typeof ClientCache !== 'undefined' ? ClientCache._knownNumberToCid : null;
        const mapping = [inventoryMap, knownMap].find(map => map && Object.hasOwn(map, number));
        if (mapping) cid = validCid(mapping[number]);
        else {
            // 이름이 같다는 이유로 다른 카드의 이미지를 연결하지 않습니다.
            const candidates = [...cache.entries(), [currentMeta?.cid, currentMeta]]
                .filter(([key, meta]) => validCid(key) && matchesNumber(meta));
            const ids = [...new Set(candidates.map(([key]) => validCid(key)))];
            if (ids.length === 1) cid = ids[0];
        }
    }
    const meta = cache.get(cid) || (validCid(currentMeta?.cid) === cid && cid ? currentMeta : null);
    const matchingLocales = number ? localeEntries(meta).filter(entry =>
        Object.keys(entry.packs || {}).some(value => value.trim().toUpperCase() === number)) : [];
    const namedLocales = matchingLocales.filter(entry => entry.name === card.name);
    const source = matchingLocales.length === 1 ? matchingLocales[0] : namedLocales.length === 1 ? namedLocales[0] : null;
    return { cid, locale: source?.locale || '' };
}

// 서버가 확정한 요약과 토큰이 다를 때만 갱신한다. 화면의 멤버십은 기존 API 응답으로 표시한다.
async function refreshMembershipClaims(user, result) {
    if (result?.membershipClaims?.status !== 'synced' || !result.membershipClaims.version
        || typeof user?.getIdTokenResult !== 'function' || typeof user?.getIdToken !== 'function') return false;
    const revision = authStateRevision;
    const current = () => authStateRevision === revision && UserStore.user?.uid === user.uid
        && firebase.auth().currentUser?.uid === user.uid;
    try {
        if (!current()) return false;
        const token = await user.getIdTokenResult();
        if (!current()) return false;
        if (token.claims?.ygoMembership?.version !== result.membershipClaims.version) await user.getIdToken(true);
        return current();
    } catch (_) { return false; }
}

function followMembershipClaims(user) {
    const sync = globalThis.YgoMembershipClaimsSync;
    if (!sync) return;
    if (UserStore.claimsSyncStatus !== 'pending') { sync.cancel(); return; }
    const revision = authStateRevision;
    sync.start({
        isCurrent: () => authStateRevision === revision && UserStore.user === user
            && firebase.auth().currentUser?.uid === user.uid,
        check: () => callApi('getUserData', {}, { membershipClaimsOnly: true }),
        refresh: result => refreshMembershipClaims(user, result),
        onStatus: status => {
            UserStore.claimsSyncStatus = status;
            setInventorySyncStatus(UserStore.inventorySyncStatus);
        },
    });
}

let userDataSyncTask = null;
let userDataSyncSerial = 0;
let inventorySyncSnapshot = null;
const inventorySyncTokenValid = token => typeof token === 'string' && /^i1:[a-f0-9]{64}$/.test(token);
function reusableInventorySnapshot() {
    const saved = inventorySyncSnapshot;
    if (!saved || typeof cardCacheInstance === 'undefined' || saved.cache !== cardCacheInstance
        || saved.uid !== UserStore.user?.uid || saved.authRevision !== authStateRevision
        || saved.cacheRevision !== cardCacheInstance._inventoryRevision
        || !Number.isSafeInteger(saved.cacheRevision) || !inventorySyncTokenValid(saved.token)) return null;
    return saved;
}

async function loadUserData(initialData, options = {}) {
    if (!UserStore.user) return false;
    const owner = UserStore.user, revision = authStateRevision;
    if (!options.force && initialData === undefined && userDataSyncTask?.owner === owner
        && userDataSyncTask.revision === revision) return userDataSyncTask.promise;
    // 쓰기 응답이 반영되는 동안 새 전체 snapshot이 시작되지 않게 한다.
    if (typeof managementRequestPending !== 'undefined' && managementRequestPending) return false;
    const task = { owner, revision, serial: ++userDataSyncSerial, accountRevision: UserStore.accountRevision,
        inventorySnapshot: options.membershipClaimsReadOnly === true && UserStore.inventorySyncStatus === 'ready'
            ? reusableInventorySnapshot() : null,
        timing: typeof window === 'undefined' ? null : window.YgoLoginTiming?.current() };
    userDataSyncTask = task;
    UserStore.isUserDataSyncDone = false;
    UserStore.claimsSyncStatus = 'loading';
    setInventorySyncStatus('loading');
    showLoading(true, '내 인벤토리 로딩 중...');
    task.promise = Promise.resolve().then(() => performUserDataSync(initialData, options, task))
        .finally(() => { if (userDataSyncTask === task) userDataSyncTask = null; });
    return task.promise;
}

function retryUserDataSync() {
    if (UserStore.inventorySyncStatus === 'ready' && ['pending', 'checking'].includes(UserStore.claimsSyncStatus)) {
        UserStore.claimsSyncStatus = 'pending';
        followMembershipClaims(UserStore.user);
        return;
    }
    return loadUserData(undefined, { background: true });
}

function requireInventoryReady() {
    if (!UserStore.user) return true; // 기존 로그인 유도 분기를 유지한다.
    if (UserStore.inventorySyncStatus === 'ready') return true;
    showToast(UserStore.inventorySyncStatus === 'error'
        ? '보유 정보를 불러오지 못했습니다. 동기화를 다시 시도해 주세요.'
        : '보유 정보를 동기화하는 중입니다. 완료 후 다시 시도해 주세요.', 'toast-warn');
    return false;
}

function setInventorySyncStatus(status) {
    UserStore.inventorySyncStatus = status;
    const area = document.getElementById('user-sync-status');
    if (area) {
        area.hidden = !UserStore.user || status === 'idle' || status === 'ready' && UserStore.claimsSyncStatus !== 'pending';
        const label = area.querySelector('[data-sync-message]');
        if (label) label.textContent = status === 'ready' && UserStore.claimsSyncStatus === 'pending' ? '보유 정보는 준비되었습니다. 멤버십 권한 동기화 확인이 필요합니다.' : status === 'error' ? '보유 정보 동기화에 실패했습니다.' : '보유 정보를 동기화하고 있습니다.';
        const retry = area.querySelector('button');
        if (retry) retry.hidden = status !== 'error' && UserStore.claimsSyncStatus !== 'pending';
    }
    document.querySelectorAll('[data-requires-inventory]').forEach(button => {
        if (UserStore.user && status !== 'ready') {
            if (!button.disabled) { button.disabled = true; button.dataset.userSyncDisabled = 'true'; }
        } else if (button.dataset.userSyncDisabled === 'true') {
            button.disabled = false; delete button.dataset.userSyncDisabled;
        }
    });
    if (status !== 'ready' && UserStore.user) {
        const pendingText = status === 'error' ? '확인 실패' : '확인 중';
        document.querySelectorAll('.catalog-search-quantity').forEach(node => { node.textContent = pendingText; });
        document.querySelectorAll('.target-inventory-section').forEach(node => { node.textContent = status === 'error' ? '보유 정보 동기화 실패' : '보유 정보 동기화 중'; });
        for (const id of ['total-cards', 'kind-cards', 'inv-total-cards', 'inv-kind-cards']) {
            const node = document.getElementById(id); if (node) node.textContent = '—';
        }
        for (const id of ['inv-location-stats', 'inv-rarity-stats']) {
            const panel = document.getElementById(id);
            if (!panel) continue;
            const content = panel.querySelector('[data-stat-content]');
            const failed = status === 'error';
            panel.querySelector('.loading-spinner-small').hidden = failed;
            content.hidden = !failed;
            content.classList.toggle('ui-stat-empty', failed);
            content.classList.toggle('color-text-002', failed);
            content.textContent = failed ? '동기화 실패' : '';
        }
    }
}

function applyAccountData(res) {
    // 멤버십 정보가 없더라도 기본 UI 렌더링을 위해 초기화 호출
    const membership = (res && res.settings && res.settings.membership) ? res.settings.membership : null;

    UserStore.sourceMembership = res?.sourceMembership || null;

    // 기타 사용자 설정 및 멤버십 동기화
    if (res && res.settings) {
        if (res.settings.isDetailMode !== undefined) UserStore.settings.isDetailMode = res.settings.isDetailMode;
        if (res.settings.hideMembershipVerify !== undefined) UserStore.settings.hideMembershipVerify = res.settings.hideMembershipVerify;
        if (res.settings.membership) UserStore.settings.membership = res.settings.membership;
    }

    applyMembershipStatus(membership);
    if (typeof updateAuthUI === 'function') updateAuthUI(UserStore.user);

    // Firestore 직접 조회를 제거하고 서버 API 응답(res)의 데이터로 UI 업데이트 진행
    const userData = {
        createdAt: res ? res.createdAt : null,
        Nickname: res ? res.nickname : ""
    };

    // 계정 정보 섹션 UI 업데이트
    updateUserInfoCard(UserStore.user, userData);

    if (res?.settings) loadUserSettings(res.settings);
}

async function performUserDataSync(initialData, options, task) {
    if (UserStore.user !== task.owner || authStateRevision !== task.revision || task.serial !== userDataSyncSerial) return false;
    if (!UserStore.user) {
        UserStore.isUserDataSyncDone = true;
        return;
    }
    const ownerUid = UserStore.user.uid, ownerRevision = task.revision;
    const loginTiming = task.timing;
    let endLoginRender, loginReady = false;
    const current = () => UserStore.user?.uid === ownerUid && authStateRevision === ownerRevision && task.serial === userDataSyncSerial;
    UserStore.isUserDataSyncDone = false; // [추가] 동기화 시작 시 플래그 초기화
    try {
        const requestBody = { inventoryConditional: true,
            ...(options.membershipClaimsReadOnly === true ? { membershipClaimsReadOnly: true } : {}) };
        const savedInventory = task.inventorySnapshot;
        if (savedInventory) requestBody.inventoryToken = savedInventory.token;
        const fetchData = () => initialData === undefined
            ? callApi('getUserData', {}, requestBody) : Promise.resolve(initialData);
        let res = await (loginTiming ? loginTiming.measure('user_data', fetchData) : fetchData());
        if (res?.inventorySync?.status === 'unchanged'
            && (!savedInventory || reusableInventorySnapshot() !== savedInventory
                || res.inventorySync.token !== savedInventory.token || Object.hasOwn(res, 'allCards'))) {
            // 새 수정·초기화·계정/캐시 교체나 미지원 응답이면 전체 snapshot으로 복구한다.
            if (!current()) return;
            res = await callApi('getUserData', {}, { ...requestBody, inventoryToken: undefined });
            if (res?.inventorySync?.status === 'unchanged') throw new Error('인벤토리 전체 응답을 확인하지 못했습니다.');
        }
        if (res?.success === false) throw Object.assign(new Error('회원 정보 조회 실패'), { code: res.code });
        if (!current()) return;
        const applyClaimsResult = async value => {
        if (value?.membershipClaims) {
            if (value.membershipClaims.status === 'synced' && value.membershipClaims.tokenRefreshDeferred === true) {
                // 회원 여부는 서버의 현재 원본으로 확정됐다. 토큰 복사본 갱신은
                // 화면/전체 보유 정보 반영을 막지 않고 현재 계정/revision에 한정해 회수한다.
                UserStore.claimsSyncStatus = 'checking';
                Promise.resolve().then(() => current() && refreshMembershipClaims(task.owner, value)).then(ready => {
                    if (!current()) return;
                    UserStore.claimsSyncStatus = ready ? 'ready' : 'pending';
                    if (!ready) followMembershipClaims(task.owner);
                    setInventorySyncStatus(UserStore.inventorySyncStatus);
                }).catch(() => {
                    if (!current()) return;
                    UserStore.claimsSyncStatus = 'pending';
                    followMembershipClaims(task.owner);
                    setInventorySyncStatus(UserStore.inventorySyncStatus);
                });
                return;
            }
            const refreshClaims = () => refreshMembershipClaims(UserStore.user, value);
            const tokenReady = await (loginTiming ? loginTiming.measure('claims_token', refreshClaims) : refreshClaims());
            if (!current()) return;
            UserStore.claimsSyncStatus = value.membershipClaims.status === 'synced' && tokenReady ? 'ready' : 'pending';
            if (!current()) return;
        }
        if (!value?.membershipClaims) UserStore.claimsSyncStatus = 'not_required';
        };
        await applyClaimsResult(res);
        if (!current()) return;
        if (res?.inventorySync?.status === 'unchanged' && reusableInventorySnapshot() !== savedInventory) {
            res = await callApi('getUserData', {}, { ...requestBody, inventoryToken: undefined });
            if (!res?.success || res.inventorySync?.status === 'unchanged') throw new Error('인벤토리 전체 응답을 확인하지 못했습니다.');
            await applyClaimsResult(res);
            if (!current()) return;
        }
        followMembershipClaims(UserStore.user);
        if (['ready', 'not_required'].includes(UserStore.claimsSyncStatus)) loginTiming?.checkpoint?.('claims_ready');
        endLoginRender = loginTiming?.begin('render');

        if (task.accountRevision === UserStore.accountRevision) applyAccountData(res);

        if (res && res.success) {
            UserStore.inventorySyncStatus = 'ready';
            applyUserData(res, { includeSettings: task.accountRevision === UserStore.accountRevision });
            if (res.inventorySync && inventorySyncTokenValid(res.inventorySync.token) && typeof cardCacheInstance !== 'undefined'
                && Number.isSafeInteger(cardCacheInstance._inventoryRevision)
                && (res.inventorySync.status === 'unchanged'
                    || Array.isArray(res.allCards) && res.inventoryMigration?.status === 'complete'
                        && Number.isSafeInteger(res.inventoryMigration.unresolvedCount) && res.inventoryMigration.unresolvedCount >= 0)) {
                inventorySyncSnapshot = { uid: ownerUid, authRevision: ownerRevision, cache: cardCacheInstance,
                    cacheRevision: cardCacheInstance._inventoryRevision, token: res.inventorySync.token };
            } else inventorySyncSnapshot = null;
            if (!res.settings) loadUserTheme();
            loginReady = true;
            loginTiming?.checkpoint?.('inventory_ready');
        } else {
            loadUserTheme(undefined, true);
        }
    } catch (e) {
        if (!current()) return;
        // 계정 요약이 확인된 뒤의 인벤토리 장애로 계정 표시를 취소하지 않는다.
        if (!options.background || e.code === 'ACCOUNT_ROLE_UNAVAILABLE') {
        // 현재 권한을 확인하지 못했을 때 과거 관리자 표시를 계속 인정하지 않는다.
        if (!UserStore.settings) UserStore.settings = {};
        UserStore.settings.membership = { status: 'unknown', type: 'none', levelName: '확인 필요' };
        UserStore.sourceMembership = null;
        applyMembershipStatus(UserStore.settings.membership);
        showToast('회원 상태를 확인하지 못했습니다. 새로고침 후 다시 확인해 주세요.', 'toast-warn');
        // 서버 조회 실패는 설정 없음과 다르므로 계정 기록을 임의로 만들지 않는다.
        loadUserTheme(undefined, true);
        }
        UserStore.claimsSyncStatus = 'error';
        if (e.code === 'AUTH_INVALID') {
            await firebase.auth().signOut().catch(() => {});
            if (!current()) return false;
        }
        console.error("[Sync] getUserData failed");
        return false;
    } finally {
        endLoginRender?.(loginReady);
        if (!current()) { loginTiming?.finish('superseded'); return; }
        UserStore.isUserDataSyncDone = loginReady;
        setInventorySyncStatus(loginReady ? 'ready' : 'error');
        if (loginReady && typeof UIStore !== 'undefined' && UIStore.mode === 'settings') prepareMembershipEntry();
        checkAndHideInitialLoading();

        // [추가] 사용자가 현재 보유 현황 페이지의 목록 모드를 보고 있다면, 로그인 성공 후 자동으로 목록을 갱신합니다.
        if (typeof UIStore.mode !== 'undefined' && UIStore.mode === 'inventory' &&
            typeof UIStore.inventoryMode !== 'undefined' && UIStore.inventoryMode === 'list') {
            renderInventoryGrid();
        }

        showLoading(false);
        if (loginReady) loginTiming?.checkpoint?.('entry_ready');
        loginTiming?.finish(loginReady ? 'ready' : 'failed');
        if (!loginReady) return false;

        // 데이터 동기화가 완료된 후 온보딩 가이드 트리거 (로그인 완료 및 로딩 해제 시점)
        if (typeof OnboardingManager !== 'undefined' && typeof UIStore.mode !== 'undefined') {
            setTimeout(() => {
                OnboardingManager.start(UIStore.mode);
            }, 300);
        }

        if (typeof restorePendingFormData === 'function') {
            restorePendingFormData();
        }
    }
    return loginReady;
}

/**
 * 유튜브 멤버십 상태 적용 및 UI 업데이트
 */
function applyMembershipStatus(membership) {
    const mem = membership || (UserStore.settings && UserStore.settings.membership);
    const isPremium = (mem && mem.status === 'active');

    if (isPremium) {
        document.body.classList.add('is-premium');
    } else {
        document.body.classList.remove('is-premium');
    }

    // 헤더 아이콘 즉시 갱신
    const authIconElem = document.querySelector('#auth-capsule-btn .auth-icon');
    if (authIconElem) {
        authIconElem.textContent = isPremium ? 'diamond' : 'account_circle';
    }

    // 상단 헤더 멤버십 인증 버튼 제어
    const isHidden = UserStore.settings && UserStore.settings.hideMembershipVerify === true;
    syncMembershipHeader(!isPremium && !isHidden && !!UserStore.user);

    // 환경설정 페이지 UI 갱신 (데이터가 없어도 기본 버튼 노출을 위해 항상 호출)
    renderMembershipSettings(mem);
}

/**
 * 계정 카드의 역할별 요소 조회. 페이지·헤더·인증 모달과 별도로 관리한다.
 */
function getAccountCardElement(role) {
    const card = document.querySelector('[data-account-card]');
    return role ? card?.querySelector(`[data-account="${role}"]`) : card;
}

/**
 * 서버에서 확정한 멤버십 결과를 계정 카드에 표시한다.
 */
function renderMembershipSettings(membership) {
    const card = getAccountCardElement();
    const label = getAccountCardElement('membership');
    if (!card || !label) return;

    const isPremium = membership?.status === 'active';
    let levelName = membership?.status === 'unknown' ? '확인 필요' : '일반';
    if (isPremium) {
        levelName = membership.levelName || '유튜브 멤버십';
        if (levelName === '디스코드 멤버십 회원') levelName = '유튜브 멤버십';
    }
    label.textContent = levelName;
    card.classList.toggle('border-theme', isPremium);
}

/**
 * 환경설정의 멤버십 확인 버튼: 환경설정 진입과 인증창 열기
 */
async function syncYoutubeMembership(source = 'header') {
    if (!UserStore.user) {
        showToast('로그인이 필요합니다.', 'toast-warn');
        return;
    }
    switchToMode('settings');
    openMembershipAuthModal(source);
}

/**
 * 서버 인벤토리 데이터 적용
 */
let inventoryMigrationTimer = null;
let inventoryMigrationFailures = 0;
function scheduleInventoryMigration(res) {
    clearTimeout(inventoryMigrationTimer);
    const state = res.inventoryMigration;
    UserStore.inventoryVersion = res.inventoryVersion;
    UserStore.inventoryMigration = state;
    if (!state || state.status === 'complete' || !UserStore.user) {
        inventoryMigrationFailures = 0;
        return;
    }
    const uid = UserStore.user.uid;
    const delay = Math.max(1500, Number(state.retryAt || 0) - Date.now(),
        state.status === 'retryableError' ? Math.min(300000, 30000 * 2 ** inventoryMigrationFailures) : 0);
    inventoryMigrationTimer = setTimeout(async () => {
        if (UserStore.user?.uid !== uid) return;
        if (document.hidden) { scheduleInventoryMigration(res); return; }
        try {
            const next = await callApi('getUserData');
            if (UserStore.user?.uid !== uid) return;
            if (!next?.success) throw new Error(next?.message || '인벤토리 이관 상태 조회 실패');
            // 오래된 전체 응답으로 사용자가 방금 수정한 수량을 덮어쓰지 않습니다.
            const cids = new Map((next.allCards || []).map(row => [JSON.stringify([row[0], row[1]]), row[6] || null]));
            for (const row of cardCacheInstance.getInventory()) {
                const key = JSON.stringify([row[0], row[1]]);
                if (cids.has(key)) row[6] = cids.get(key);
            }
            cardCacheInstance.refreshIndexes();
            refreshCurrentSearchResult();
            inventoryMigrationFailures = next.inventoryMigration?.status === 'retryableError' ? inventoryMigrationFailures + 1 : 0;
            scheduleInventoryMigration(next);
        } catch (error) {
            if (UserStore.user?.uid !== uid) return;
            inventoryMigrationFailures++;
            scheduleInventoryMigration({ ...res, inventoryMigration: { ...state, status: 'retryableError', retryAt: Date.now() + 30000 } });
        }
    }, delay);
}

function applyUserData(res, { includeSettings = true } = {}) {
    if (!res) return;
    const unchanged = res.inventorySync?.status === 'unchanged';
    if (!unchanged) scheduleInventoryMigration(res);

    // 서버로부터 받은 설정 적용 (테마, 상세 모드 등)
    if (includeSettings && res.settings) {
        loadUserSettings(res.settings);
    }

    // 1. 인벤토리 목록 저장
    const batched = !unchanged && res.allCards && typeof cardCacheInstance.setInventorySnapshot === 'function';
    if (batched) {
        const summary = res.inventoryDisplaySummary;
        if (summary?.version === 1) {
            cardCacheInstance.setInventorySnapshot(res.allCards, summary.amount, summary.locations, summary.rarities, { summaryComplete: true });
        } else cardCacheInstance.setInventorySnapshot(res.allCards, res.amount, res.locations, res.rarities);
    } else if (!unchanged && res.allCards) {
        cardCacheInstance.setInventory(res.allCards);
    }

    // 2. 통계 및 매핑 저장 (초기 로딩 및 로컬 데이터를 바탕으로 통계 강제 동기화 보정)
    if (!unchanged && !batched) {
        cardCacheInstance.setSummary(res.amount, res.locations, res.rarities);
        cardCacheInstance.rebuildSummaryFromInventory();
    }

    // 3. UI 갱신
    updateTotals();

    // 환경 설정 페이지 UI 갱신 (위치 목록 등)
    updateRarityInputs();

    // 유저 데이터 세팅 완료 후 단 1회 정밀 결과 갱신
    refreshCurrentSearchResult();
}

function rarityLangsToRows(data) {
    const langs = data && data.langs;
    if (!langs || typeof langs !== 'object' || Array.isArray(langs)) throw new Error('레어도 파일 형식 오류');
    for (let i = 0; i <= 10; i++) if (!Array.isArray(langs[String(i)])) throw new Error(`레어도 언어 ${i} 형식 오류`);
    const rows = [['display', 'ko', 'ja', 'ae', 'cn', 'en', 'de', 'fr', 'it', 'es', 'pt']];
    for (let row = 0; row < langs['10'].length; row++) {
        rows.push([langs['10'][row], ...Array.from({ length: 10 }, (_, i) => langs[String(i)][row] || '')]);
    }
    return rows;
}

async function downloadPublicResource(descriptor) {
    if (!descriptor || descriptor.available !== true || !descriptor.url || !descriptor.generation) return null;
    const url = new URL(descriptor.url);
    url.searchParams.set('generation', descriptor.generation);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`공개 데이터 다운로드 실패: HTTP ${response.status}`);
    return response.json();
}

async function applyPublicData(res) {
    if (!res || res.schemaVersion !== 2 || res.syncType !== 'storage-links' || !res.resources) {
        throw new Error('지원하지 않는 공개 데이터 응답 형식입니다.');
    }
    const versions = await MasterDB.get('publicResourceVersions') || {};
    const nextVersions = { ...versions };
    const resources = res.resources;

    const cardDescriptor = resources.cardManifest;
    const needsCards = cardDescriptor?.available && (versions.cardManifest !== cardDescriptor.generation ||
        !CardDataStore.allCardNames?.length || !CardDataStore.allCardNumbers?.length);
    if (needsCards) {
        try {
            const data = await downloadPublicResource(cardDescriptor);
            if (!data || !Array.isArray(data.names) || !Array.isArray(data.numbers) ||
                data.names.some(value => typeof value !== 'string') || data.numbers.some(value => typeof value !== 'string')) {
                throw new Error('카드 매니페스트 형식 오류');
            }
            await CardListCache.persist({ names: data.names, numbers: data.numbers });
            nextVersions.cardManifest = cardDescriptor.generation;
            localStorage.setItem('cardListUpdatedAt', String(cardDescriptor.updatedAt || 0));
        } catch (error) {
            console.warn('[Sync] 카드 매니페스트 갱신 실패. 기존 캐시를 유지합니다.', error);
        }
    }

    const cacheUpdates = {};
    const packsDescriptor = resources.packs;
    if (packsDescriptor?.available && (versions.packs !== packsDescriptor.generation ||
        !Object.keys(CardDataStore.masterJSON.pack || {}).length)) {
        try {
            const data = await downloadPublicResource(packsDescriptor);
            if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('팩 목록 형식 오류');
            cacheUpdates.packData = data;
            nextVersions.packs = packsDescriptor.generation;
        } catch (error) {
            console.warn('[Sync] 팩 목록 갱신 실패. 기존 캐시를 유지합니다.', error);
        }
    }

    const rarityDescriptor = resources.rarity;
    if (rarityDescriptor?.available && (versions.rarity !== rarityDescriptor.generation ||
        !CardDataStore.masterJSON.rarity?.length)) {
        try {
            cacheUpdates.rarity = rarityLangsToRows(await downloadPublicResource(rarityDescriptor));
            nextVersions.rarity = rarityDescriptor.generation;
        } catch (error) {
            console.warn('[Sync] 레어도 매핑 갱신 실패. 기존 캐시를 유지합니다.', error);
        }
    }

    cacheUpdates.publicResourceVersions = nextVersions;
    await MasterDB.saveMasterDataBatch(cacheUpdates);
    if (cacheUpdates.packData) {
        CardDataStore.masterJSON.pack = cacheUpdates.packData;
        localStorage.setItem('packUpdatedAt', String(packsDescriptor.updatedAt || 0));
        updatePackNamesCache();
    }
    if (cacheUpdates.rarity) {
        CardDataStore.masterJSON.rarity = cacheUpdates.rarity;
        localStorage.setItem('rarityUpdatedAt', String(rarityDescriptor.updatedAt || 0));
    }

    currentSheetLastUpdated = res.serverTime || Date.now();
    localStorage.setItem('masterSyncUpdatedAt', String(currentSheetLastUpdated));

    rarityMappingRaw = CardDataStore.masterJSON.rarity || [];
    if (rarityMappingRaw.length > 0) {
        const headers = rarityMappingRaw[0];
        rarityColMap = {};
        headers.forEach((h, i) => rarityColMap[h] = i);

        rarityRows = rarityMappingRaw.slice(1);
        rarityReverseMap = {};
        rarityOrderMap = {};

        rarityRows.forEach((row, index) => {
            const id = row[0];
            if (id) {
                rarityOrderMap[id] = index;
                row.forEach(cellVal => {
                    if (cellVal) rarityReverseMap[cellVal] = index;
                });
            }
        });
    }

    refreshLocalLookups();
    updateRarityInputs();

    // 공통 로드 완료 후 렌더링
    isAppConfigured = true;
}




async function handleContinueRegistration() {

    const isMobile = document.documentElement.classList.contains('is-mobile-device');
    const containerId = isMobile ? 'mobile-cards-list-general' : 'desktop-cards-list-general';
    const cardClass = isMobile ? '.mobile-info-card[data-index]' : '.desktop-info-card[data-index]';
    const container = document.getElementById(containerId);

    let hasFailures = false;
    let hasSuccess = false;

    if (container) {
        const cards = Array.from(container.querySelectorAll(cardClass));
        cards.forEach(card => {
            const cardNoVal = (card.querySelector('[data-field="no"]') || card.querySelector('.page-card-no') || {}).value || "";
            if (card.dataset.status === 'success' || !cardNoVal.trim()) {
                card.remove();
                hasSuccess = true;
            } else {
                hasFailures = true;
                delete card.dataset.status;
            }
        });

        const remainingCount = container.querySelectorAll(cardClass).length;
        if (!hasFailures || remainingCount === 0) {
            container.innerHTML = '';
            if (isMobile) mobileAddEntry('add');
            else desktopAddEntry('add');
        } else {
            if (!isMobile) reindexDesktopCards(container);
        }
    }

    if (hasSuccess) {
        if (syncCounter >= 9) {
            syncCounter = 0;
            await refreshInitialData(true);
        }
    }

    if (isMobile) {
        renderMobileCards();
    }
}

/**
 * 초기화 과정(공통 데이터 동기화 + 인증 확인)의 통합 로딩 종료 처리
 */
function checkAndHideInitialLoading() {
    if (!UserStore.isInitialSyncDone) return;

    if (!window.isAuthInitialized) {
        // 마스터 동기화는 완료되었으나, 아직 Firebase Auth 검증 진행 중인 경우
        showLoading(true, "로그인 상태 확인 중...");
    } else {
        // Firebase Auth 검증까지 완전히 종료된 경우
        if (!UserStore.user) {
            // 비로그인 사용자의 경우 로딩 오버레이 즉시 닫기
            showLoading(false);
        }
    }
}



function showLoading(show, html) {
    // 인증 팝업 완료와 서비스 로그인 완료는 다르다. 확인 중에는 다른 작업도 로딩을 닫지 못한다.
    if (typeof serviceLoginPending !== 'undefined' && serviceLoginPending) {
        show = true;
        // Firebase 인증 후 통합 계정·보유 조회 대기를 실제 로그인과 구분한다.
        html = typeof registrationCheckPending !== 'undefined' && registrationCheckPending
            ? '내 인벤토리 로딩 중...' : '로그인 중...';
    } else if (typeof UserStore !== 'undefined' && UserStore.user && UserStore.inventorySyncStatus === 'loading') {
        // 공통 데이터 등 다른 작업의 종료가 사용자 데이터 동기화 화면을 닫지 못한다.
        show = true;
        html = '내 인벤토리 로딩 중...';
    }
    const overlay = document.getElementById('loading-overlay');
    const loadingText = document.getElementById('loading-text');
    if (overlay && loadingText) {
        if (show) loadingText.innerHTML = html;
        overlay.hidden = !show;
        document.body.classList.toggle('is-loading', Boolean(show));
    }
}

function initPageMove() {
    const isMobile = document.documentElement.classList.contains('is-mobile-device');
    if (isMobile) {
        const listContainer = document.getElementById('mobile-cards-list-move');
        if (listContainer && listContainer.querySelectorAll('.mobile-info-card[data-index]').length === 0) {
            listContainer.innerHTML = '';
            mobileAddEntry('move');
        }
    } else {
        const listContainer = document.getElementById('desktop-cards-list-move');
        if (listContainer && listContainer.querySelectorAll('.desktop-info-card[data-index]').length === 0) {
            listContainer.innerHTML = '';
            desktopAddEntry('move');
        }
    }
}
function adjustMoveCount(delta) { 
    FormRowStore.moveCount += delta; 
    if (FormRowStore.moveCount < 1) FormRowStore.moveCount = 1; 
    
    const el = document.getElementById('add-move-count');
    if (el) el.innerText = FormRowStore.moveCount + "장";
    
    const elDesktop = document.getElementById('add-move-count-desktop');
    if (elDesktop) elDesktop.innerText = FormRowStore.moveCount + "장";
}



function handleMoveNameInput(input) {
    const row = getRowFromInput(input);
    if (!row) return;
    const target = getQueryTarget(row);
    const noInput = target ? target.querySelector('.move-card-no') : row.querySelector('.move-card-no');
    const nameVal = input.value.trim();
    if (!nameVal) {
        clearPageNameAndNo(input);
        return;
    }

    if (!input.dataset.programmatic) {
        if (noInput) {
            noInput.dataset.programmatic = "true";
            noInput.value = "";
            delete noInput.dataset.programmatic;
        }
        resetMoveRow(row, 'no');
    }

    // 보유한 번호가 단 1개인 경우 자동 기입 및 핸들러 트리거
    const ownedNos = cardCacheInstance.getNosByName(nameVal);
    if (ownedNos && ownedNos.length === 1 && noInput) {
        noInput.value = ownedNos[0];
        validateMoveNoInput(noInput, true);
    }
}

// 이름/번호는 편집 중 추천만 표시하고, 명시적인 확정 동작에서만 조회합니다.
const registrationNumberSelections = new WeakMap();

function usesRegistrationCatalog(field, input) {
    if (!globalThis.AppBackend?.registrationSuggestions || UIStore.mode !== 'add') return false;
    if (field === 'name') return true;
    const container = getActiveContainer(input);
    const row = getRowFromInput(input);
    const mobile = input?.id === 'sheet-card-no';
    const name = container?.querySelector('[data-field="name"]');
    const resolvedMobileName = mobile && Boolean(row?.dataset.cardData && name?.value && name.classList.contains('hyperlink-style'));
    return field === 'no' && Boolean(input) && (mobile || !input.readOnly) && !input.dataset.lockedForName
        && !resolvedMobileName && ![container, row].some(element => element?.dataset.searchMode === 'name');
}

function registrationNameChoices(input) {
    const numberInput = getActiveContainer(input)?.querySelector('[data-field="no"]');
    const selection = registrationNumberSelections.get(numberInput);
    if (UIStore.mode === 'add' && selection?.number === numberInput?.value) return selection?.choices;
}

function filterRegistrationCatalogSuggestions(candidates, field, value) {
    const query = normalizeStr(value.normalize('NFC'));
    if (!query || value.trim().length > 100) return [];
    if (field === 'no') return candidates.filter(candidate => candidate.value.toLowerCase().includes(query));

    const matching = globalThis.YgoCardNameAutocomplete;
    const pattern = new RegExp(matching.pattern(query, matching.variants(query)), 'u');
    return candidates.filter(candidate => pattern.test(normalizeStr(candidate.value.normalize('NFC'))));
}

async function confirmRegistrationNumber(input, value, candidate) {
    const container = getActiveContainer(input);
    const nameInput = container?.querySelector('[data-field="name"]');
    const row = getRowFromInput(input);
    const initialName = nameInput?.value;
    const selection = { number: value };
    registrationNumberSelections.set(input, selection);
    const isCurrent = () => input.isConnected && getRowFromInput(input) === row && getActiveContainer(input) === container
        && input.value === value && nameInput?.value === initialName && registrationNumberSelections.get(input) === selection
        && usesRegistrationCatalog('no', input);
    try {
        if (!candidate?.complete) {
            const matches = await globalThis.AppBackend.registrationSuggestions(value, 'no');
            candidate = matches.find(match => match.value === value);
        }
        if (!isCurrent()) return;
        const cards = candidate?.cards || [];
        if (cards.length > 1 && nameInput) {
            clearPageNameAndNo(input);
            updateSubCellsFromCache('', container);
            input.value = value;
            selection.choices = cards.map(card => ({ ...card, number: value }));
            registrationNumberSelections.set(input, selection);
            nameInput.placeholder = '카드 이름 선택';
            if (input.id === 'sheet-card-no') {
                updateBottomSheetClearButtons();
                updateSheetDropdownState();
                if (!activeOverlayType) openSheetOverlay('name');
                else if (activeOverlayType === 'name') showOverlaySuggestions(document.getElementById('overlay-search-input').value);
            } else {
                nameInput.focus();
                nameInput._cardSearchController?.refresh();
            }
            return;
        }
        const cid = cards[0]?.cid;
        if (!cid) {
            await fetchCardByNumber(input, true);
            return;
        }
        const match = await globalThis.AppBackend.registrationNumber(cid, value);
        if (!isCurrent()) return;
        if (match.multiple) {
            if (!nameInput) return;
            nameInput.value = match.name;
            await fetchCardByName(nameInput, true, cid, false, value);
        } else {
            input.value = (match.number || value).toUpperCase();
            await fetchCardByNumber(input, true);
        }
    } catch {
        if (isCurrent()) await fetchCardByNumber(input, true);
    }
}

function setupCardSearchDropdown(wrapper, getSuggestions, lookup, registrationField) {
    const input = wrapper.querySelector('input');
    if (input._cardSearchController) return;
    const { field } = input.dataset;
    const isDesktopCardSearch = ['name', 'no'].includes(field) && Boolean(wrapper.closest('.desktop-info-card--editable'));
    const fitsSuggestions = isDesktopCardSearch && field === 'name';
    // 기존 인라인 조회/초기화와 키보드 처리를 이 제어기로 통합합니다.
    ['oninput', 'onblur', 'onkeydown'].forEach(attr => input.removeAttribute(attr));
    let dropdown = wrapper._dropdown;
    if (!dropdown) {
        dropdown = document.createElement('ul');
        dropdown.className = 'global-dropdown custom-options';
        document.body.appendChild(dropdown);
        wrapper._dropdown = dropdown;
    }
    if (isDesktopCardSearch) dropdown.dataset.cardSearchField = field;
    if (fitsSuggestions && !CSS.supports('field-sizing', 'content')) {
        bindDesktopCardNameWidth(input, wrapper);
    }
    const resetSuggestionWidth = () => {
        if (fitsSuggestions) desktopCardGeometryRules.get(wrapper)?.style.removeProperty('--card-suggestion-width');
    };
    let currentFocusIdx = -1;
    let renderedQuery;
    let renderedCandidates = [];
    let lastCatalogCandidates = [];
    let lastNumberOptions;
    let lastNumberCandidates = [];
    let suggestionsPending = false;
    let committedValue = null;
    let dirty = true;
    let request;
    const hide = () => {
        currentFocusIdx = -1;
        renderedCandidates = [];
        dropdown.style.height = '';
        wrapper.classList.remove('active');
        input.classList.remove('active');
        dropdown.classList.remove('active');
        resetSuggestionWidth();
        if (UIStore.activeDropdownInput === input) UIStore.activeDropdownInput = null;
    };
    const close = () => {
        scheduled.cancel();
        request?.abort();
        lastCatalogCandidates = [];
        lastNumberOptions = undefined;
        lastNumberCandidates = [];
        suggestionsPending = false;
        hide();
    };
    const commit = (value, candidate) => {
        close();
        if (input.readOnly || input.disabled) return;
        const choices = registrationField === 'name' && registrationNameChoices(input);
        if (choices) {
            const selected = choices.includes(candidate) ? candidate : choices.find(choice => choice.value === value);
            if (!selected) return;
            input.value = selected.value;
            void lookup(input, true, selected.cid, false, selected.number);
            return;
        }
        input.value = value;
        if (!dirty && committedValue === value) return;
        committedValue = value;
        dirty = false;
        if (value && registrationField === 'no' && usesRegistrationCatalog('no', input)) void confirmRegistrationNumber(input, value, candidate);
        else if (candidate?.cid) lookup(input, false, candidate.cid);
        else lookup(input);
    };
    const renderValues = (values, emptyMessage) => {
        if (document.activeElement !== input || input.readOnly || input.disabled
            || input.closest('#mobile-entry-bottom-sheet')) { close(); return; }
        UIStore.activeDropdownInput = input;
        renderedQuery = input.value;
        renderedCandidates = values;
        currentFocusIdx = -1;
        dropdown.style.height = '';
        dropdown.innerHTML = '';
        for (const candidate of values) {
            const { value } = candidate;
            const li = document.createElement('li');
            li.className = 'custom-option';
            li.innerText = value;
            li.onmousedown = event => event.preventDefault();
            li.onclick = () => commit(value, candidate);
            dropdown.appendChild(li);
        }
        if (!values.length) {
            const li = document.createElement('li');
            li.className = 'custom-option item-no-match';
            li.innerText = emptyMessage ?? (input.dataset.field === 'no' ? '번호 확인' : '카드 이름 확인');
            dropdown.appendChild(li);
        }
        wrapper.classList.add('active');
        dropdown.classList.add('active');
        if (!values.length) resetSuggestionWidth();
        positionDropdown(dropdown, wrapper, false, fitsSuggestions && values.length > 0);
    };
    const renderPendingValues = values => {
        if (values.length) {
            renderValues(values);
        } else if (holdOpenSuggestionDropdown(dropdown)) {
            currentFocusIdx = -1;
            renderedCandidates = [];
            dropdown.replaceChildren();
            positionDropdown(dropdown, wrapper);
        } else {
            hide();
        }
    };
    const render = () => {
        request?.abort();
        if (document.activeElement !== input || input.readOnly || input.disabled
            || input.closest('#mobile-entry-bottom-sheet')) { close(); return; }
        const query = input.value;
        const choices = registrationField === 'name' && registrationNameChoices(input);
        if (choices) {
            lastCatalogCandidates = [];
            suggestionsPending = false;
            renderValues(choices.filter(choice => normalizeStr(choice.value).includes(normalizeStr(query))));
            return;
        }
        if (!usesRegistrationCatalog(registrationField, input)) {
            lastCatalogCandidates = [];
            suggestionsPending = false;
            const matches = getSuggestions().map(value => ({ value }));
            if (registrationField === 'no' && UIStore.mode === 'add') {
                lastNumberOptions = wrapper.dataset.options;
                lastNumberCandidates = matches;
            }
            renderValues(matches);
            return;
        }
        if (!query.trim()) { close(); return; }
        suggestionsPending = true;
        const controller = request = new AbortController();
        const isCurrent = () => !controller.signal.aborted && document.activeElement === input
            && input.value === query && usesRegistrationCatalog(registrationField, input);
        globalThis.AppBackend.registrationSuggestions(query.trim(), registrationField, controller.signal).then(remote => {
            if (!isCurrent()) return;
            lastCatalogCandidates = remote.slice(0, 8);
            suggestionsPending = false;
            renderValues(lastCatalogCandidates);
        }, () => {
            if (!isCurrent()) return;
            lastCatalogCandidates = [];
            suggestionsPending = false;
            renderValues([], '카드 추천을 불러오지 못했습니다.');
        });
    };
    const scheduled = debounce(render, 100);
    input._cardSearchController = { close, refresh: render };
    input.addEventListener('input', () => {
        dirty = true;
        request?.abort();
        if (input.dataset.field === 'no') {
            registrationNumberSelections.delete(input);
            const start = input.selectionStart;
            input.value = input.value.replace(/[ㄱ-ㅎㅏ-ㅣ가-힣]/g, '').toUpperCase();
            input.setSelectionRange(start, start);
        }
        const choices = registrationField === 'name' && registrationNameChoices(input);
        if (choices) {
            scheduled.cancel();
            render();
            return;
        }
        const query = input.value.trim();
        if (query && usesRegistrationCatalog(registrationField, input)) {
            suggestionsPending = true;
            renderPendingValues(filterRegistrationCatalogSuggestions(lastCatalogCandidates, registrationField, input.value));
        } else if (query && registrationField === 'no' && UIStore.mode === 'add' && wrapper.dataset.options
            && wrapper.dataset.options === lastNumberOptions) {
            suggestionsPending = true;
            renderPendingValues(lastNumberCandidates.filter(candidate => candidate.value.toUpperCase().includes(query.toUpperCase())));
        } else {
            close();
        }
        // 조회 결과의 하위 필드는 이 시점에 초기화하거나 갱신하지 않습니다.
        scheduled();
    });
    input.addEventListener('focus', () => {
        if (!suggestionsPending && (dirty || input.value !== committedValue)) render();
    });
    input.addEventListener('click', () => {
        if (!input.readOnly && !suggestionsPending) render();
    });
    input.addEventListener('blur', close);
    input.addEventListener('keydown', event => {
        if (event.isComposing) return;
        if (input.closest('#mobile-entry-bottom-sheet')) return;
        if (input.readOnly) {
            if (input.dataset.field === 'name' && ['Escape', 'Backspace', 'Delete'].includes(event.key)) {
                event.preventDefault();
                close();
                dirty = true;
                committedValue = null;
                clearPageNameAndNo(input);
            }
            return;
        }
        if (event.key === 'Enter') {
            event.preventDefault();
            const selected = dropdown.classList.contains('active') && renderedQuery === input.value
                ? renderedCandidates[currentFocusIdx] : undefined;
            commit(selected?.value ?? input.value, selected);
        } else if (event.key === 'Tab') {
            if (dirty || input.value !== committedValue) {
                const first = renderedQuery === input.value && dropdown.classList.contains('active')
                    ? renderedCandidates[suggestionsPending ? currentFocusIdx : 0] : usesRegistrationCatalog(registrationField, input)
                        ? undefined : { value: getSuggestions()[0] };
                if (first?.value !== undefined) commit(first.value, first);
            }
            close(); // 기본 Tab/Shift+Tab 포커스 이동은 그대로 둡니다.
        } else if (event.key === 'Escape') {
            event.preventDefault();
            close();
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (!dropdown.classList.contains('active') && !suggestionsPending) render();
            const items = dropdown.querySelectorAll('li:not(.item-no-match)');
            if (!items.length) return;
            currentFocusIdx = event.key === 'ArrowDown' ? (currentFocusIdx + 1) % items.length
                : (currentFocusIdx > 0 ? currentFocusIdx - 1 : items.length - 1);
            updateHighlight(items, currentFocusIdx);
        }
    });
}

function setupCardNameAutocomplete(wrapper) {
    const input = wrapper.querySelector('input');
    const showAllOwnedNames = () => {
        let allNames = cardCacheInstance.getAllNames();
        const ownedNamesSet = cardCacheInstance.getOwnedNamesSet();
        
        const targetRow = getRowFromInput(input);

        let filteredNames = [];
        for (let i = 0; i < allNames.length; i++) {
            const name = allNames[i];
            if (ownedNamesSet.has(name)) {
                if (targetRow) {
                    const nos = cardCacheInstance.getNosByName(name);
                    const allDepleted = nos.every(no => UIStore.mode === 'move' ? isMoveCardDepleted(no, targetRow) : isCardDepleted(no, targetRow));
                    if (allDepleted) continue;
                }
                filteredNames.push(name);
                if (filteredNames.length >= 8) break; // 8개 매칭 충족 시 조기 종료
            }
        }
        return filteredNames;
    };

    const handleInput = () => {
        const query = input.value.replace(/\s+/g, '').toLowerCase();
        if (!query) {
            return showAllOwnedNames();
        }

        const ownedNamesSet = cardCacheInstance.getOwnedNamesSet();

        const targetRow = getRowFromInput(input);

        let matches = [];
        const localNamesNormalized = cardCacheInstance.getAllNamesNormalized();
        const queryChosung = getChosung(query);

        for (let i = 0; i < localNamesNormalized.length; i++) {
            const item = localNamesNormalized[i];
            if (!ownedNamesSet.has(item.original)) continue;

            if (item.chosung.includes(queryChosung)) {
                if (Hangul.search(item.normalized, query) !== -1) {
                    if (targetRow) {
                        const nos = cardCacheInstance.getNosByName(item.original);
                        const allDepleted = nos.every(no => UIStore.mode === 'move' ? isMoveCardDepleted(no, targetRow) : isCardDepleted(no, targetRow));
                        if (allDepleted) continue;
                    }
                    matches.push(item);
                }
            }
        }

        return sortCardNameSuggestions(matches, query, 8).map(item => item.original);
    };

    setupCardSearchDropdown(wrapper, handleInput, fetchCardByName);
}

function setupGlobalCardNameAutocomplete(wrapper) {
    const input = wrapper.querySelector('input');
    const handleInput = () => {
        const query = input.value.trim().toLowerCase();

        if (!query) {
            return [];
        }

        const normalizedQuery = query.replace(/\s+/g, '');
        const queryChosung = getChosung(normalizedQuery);
        let matches = [];
        if (typeof CardDataStore.allCardNamesNormalized !== 'undefined' && CardDataStore.allCardNamesNormalized.length > 0) {
            for (let i = 0; i < CardDataStore.allCardNamesNormalized.length; i++) {
                const item = CardDataStore.allCardNamesNormalized[i];
                if (item.chosung.includes(queryChosung)) {
                    if (Hangul.search(item.normalized, normalizedQuery) !== -1) {
                        matches.push(item);
                    }
                }
            }
        } else {
            const localNamesNormalized = cardCacheInstance.getAllNamesNormalized();
            for (let i = 0; i < localNamesNormalized.length; i++) {
                const item = localNamesNormalized[i];
                if (item.chosung.includes(queryChosung)) {
                    if (Hangul.search(item.normalized, normalizedQuery) !== -1) {
                        matches.push(item);
                    }
                }
            }
        }

        return sortCardNameSuggestions(matches, normalizedQuery, 8).map(item => item.original);
    };

    setupCardSearchDropdown(wrapper, handleInput, fetchCardByName, 'name');
}

function setupCardNoAutocomplete(wrapper) {
    const input = wrapper.querySelector('input');
    const isDiscardOrMove = (UIStore.mode === 'discard') || (UIStore.mode === 'move') || (wrapper.id && (wrapper.id.startsWith('wrap-discard') || wrapper.id.startsWith('wrap-move') || wrapper.id.startsWith('wrap-from')));

    const getNameVal = () => {
        const cardEl = input.closest('.desktop-info-card') || getRowFromInput(input);
        if (cardEl) {
            const nameInp = cardEl.querySelector('.desktop-card-name, [data-field="name"]');
            return nameInp ? nameInp.value.trim() : "";
        }
        return "";
    };

    const getSourceList = () => {
        let src = [];
        if (wrapper.dataset.options) {
            try {
                const options = JSON.parse(wrapper.dataset.options);
                if (options && options.length > 0) {
                    src = options.map(opt => typeof opt === 'object' ? opt.val : opt);
                }
            } catch (e) { }
        }
        if (src.length === 0) {
            const targetRow = getRowFromInput(input);
            if (targetRow && targetRow.dataset.cardData) {
                try {
                    const cardData = JSON.parse(targetRow.dataset.cardData);
                    if (cardData.numbers && cardData.numbers.length > 0) {
                        src = cardData.numbers;
                    } else if (cardData.raritiesByNo) {
                        src = Object.keys(cardData.raritiesByNo);
                    }
                } catch (e) { }
            }
        }
        if (src.length === 0 && getActiveContainer(input)?.dataset.searchMode === 'name'
            && UIStore.mode === 'add') return src;
        if (src.length === 0) {
            const nameVal = getNameVal();
            if (nameVal) {
                if (UIStore.mode === 'add') {
                    const allNos = (typeof ClientCache !== 'undefined' && ClientCache._nameToNos) ? ClientCache._nameToNos[nameVal] : null;
                    if (allNos) {
                        src = Array.from(allNos);
                    }
                } else {
                    const nosByName = cardCacheInstance.getNosByName(nameVal);
                    if (nosByName.length > 0) {
                        src = nosByName;
                    }
                }
            }
        }
        if (src.length === 0) {
            src = (UIStore.mode === 'add')
                ? ((typeof CardDataStore.allCardNumbers !== 'undefined' && CardDataStore.allCardNumbers.length > 0) ? CardDataStore.allCardNumbers : cardCacheInstance.getOwnedNumbers())
                : cardCacheInstance.getOwnedNumbers();
        }
        if (isDiscardOrMove) {
            const targetRow = getRowFromInput(input);
            if (targetRow) {
                src = src.filter(no => !(UIStore.mode === 'move' ? isMoveCardDepleted(no, targetRow) : isCardDepleted(no, targetRow)));
            }
        }
        return src;
    };

    const handleInput = () => {
        const val = input.value.trim();
        const source = getSourceList();
        const query = val.toUpperCase();

        let matches = [];
        for (let i = 0; i < source.length; i++) {
            const no = source[i];
            // 카드 번호이므로 단순 문자열 포함 여부만 검사
            if (no.toUpperCase().includes(query)) {
                matches.push(no);
                if (matches.length >= 8) break; // 8개 매칭 충족 시 조기 종료
            }
        }
        return matches;
    };

    setupCardSearchDropdown(wrapper, handleInput, fetchCardByNumber, 'no');
}

/**
 * 드롭다운의 위치 및 데스크톱 카드 스타일을 공통으로 설정하는 헬퍼 함수.
 * setupCardNameAutocomplete, setupGlobalCardNameAutocomplete,
 * setupCardNoAutocomplete, setupCustomDropdown에서 공통 호출됩니다.
 */
// 카드 목록 포털과 자동 너비의 실측값을 요소의 style 속성 없이 적용한다.
let desktopCardGeometrySheet;
let desktopCardGeometryId = 0;
const desktopCardGeometryRules = new WeakMap();

function getDesktopCardGeometry(element) {
    if (!desktopCardGeometrySheet) {
        desktopCardGeometrySheet = new CSSStyleSheet();
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, desktopCardGeometrySheet];
    }
    if (!desktopCardGeometryRules.has(element)) {
        const id = ++desktopCardGeometryId;
        element.dataset.cardGeometry = id;
        const selector = `[data-card-geometry="${id}"]`;
        const fieldSelector = element.dataset.cardField ? `.desktop-info-card--editable ${selector}[data-card-field]` : selector;
        const index = desktopCardGeometrySheet.insertRule(`${fieldSelector} {}`, desktopCardGeometrySheet.cssRules.length);
        desktopCardGeometryRules.set(element, desktopCardGeometrySheet.cssRules[index]);
    }
    return desktopCardGeometryRules.get(element).style;
}

function releaseDesktopCardGeometry(element) {
    const rule = desktopCardGeometryRules.get(element);
    if (!rule) return;
    const index = Array.from(desktopCardGeometrySheet.cssRules).indexOf(rule);
    if (index !== -1) desktopCardGeometrySheet.deleteRule(index);
    desktopCardGeometryRules.delete(element);
    delete element.dataset.cardGeometry;
}

function releaseDesktopCardFields(card) {
    for (const wrapper of card.querySelectorAll('.custom-select-wrapper')) {
        if (wrapper._dropdown) {
            releaseDesktopCardGeometry(wrapper._dropdown);
            wrapper._dropdown.remove();
        }
        releaseDesktopCardGeometry(wrapper);
    }
}

function positionDropdown(localDropdown, wrapper, useCardStyle = false, measureSuggestions = false) {
    const isDesktopCard = useCardStyle || Boolean(wrapper.closest('.desktop-info-card--editable'));
    const scrollTop = window.pageYOffset || document.documentElement.scrollTop || 0;
    const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft || 0;
    if (isDesktopCard) {
        localDropdown.classList.add('desktop-card-dropdown', 'border-basic', 'color-surface-001', 'shape-rounded003', 'shadow-medium');
        const geometry = getDesktopCardGeometry(localDropdown);
        if (measureSuggestions) {
            geometry.removeProperty('width');
            const width = Math.ceil(localDropdown.getBoundingClientRect().width);
            getDesktopCardGeometry(wrapper).setProperty('--card-suggestion-width', `${width}px`);
        }
        const rect = wrapper.getBoundingClientRect();
        geometry.top = `${rect.bottom + scrollTop + 6}px`;
        geometry.left = `${rect.left + scrollLeft}px`;
        if (localDropdown.dataset.cardSearchField) geometry.width = `${rect.width}px`;
        else geometry.minWidth = `${rect.width}px`;
    } else {
        const rect = wrapper.getBoundingClientRect();
        if (localDropdown.classList.contains('desktop-card-dropdown')) {
            localDropdown.classList.remove('desktop-card-dropdown', 'border-basic', 'color-surface-001', 'shape-rounded003', 'shadow-medium');
            releaseDesktopCardGeometry(localDropdown);
        }
        localDropdown.style.top = `${rect.bottom + scrollTop}px`;
        localDropdown.style.left = `${rect.left + scrollLeft}px`;
        localDropdown.style.width = `${rect.width}px`;
    }
}

const inputAutoWidthMinimums = { name: 0, rare: 70, loc: 120, to: 120 };

function onInputValueAssigned(input, callback) {
    // 값 복원이나 조회 결과 대입에서는 input 이벤트가 발생하지 않는다.
    const descriptor = Object.getOwnPropertyDescriptor(input, 'value')
        || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    Object.defineProperty(input, 'value', {
        ...descriptor,
        set(value) {
            descriptor.set.call(this, value);
            callback();
        }
    });
}

function bindDesktopCardNameWidth(input, wrapper) {
    const resize = (reposition = false) => {
        if (!input.isConnected) return;
        updateInputAutoWidth(input);
        const dropdown = wrapper._dropdown;
        if (reposition && dropdown?.classList.contains('active')) positionDropdown(dropdown, wrapper);
    };

    onInputValueAssigned(input, () => resize(true));
    input.addEventListener('input', () => resize());
    new MutationObserver(() => resize(true)).observe(input, { attributeFilter: ['placeholder', 'value'] });
    resize();
    if (document.fonts?.status === 'loading') document.fonts.ready.then(() => resize(true));
}

function createInputWidthTester() {
    const span = document.createElement('span');
    span.className = 'desktop-card-width-tester';
    return span;
}

function readInputWidth(input, wrapper) {
    const styles = window.getComputedStyle(input);
    const arrow = wrapper.querySelector('.arrow-icon');
    const hasArrow = arrow && window.getComputedStyle(arrow).display !== 'none';
    const paddingLeft = parseFloat(styles.paddingLeft) || 0;
    const paddingRight = parseFloat(styles.paddingRight) || 0;
    const extraSpace = input.dataset.field === 'name'
        ? (parseFloat(styles.borderLeftWidth) || 0) + (parseFloat(styles.borderRightWidth) || 0) + 1
        : (hasArrow ? 15 : 8);
    return {
        wrapper,
        text: input.value || input.placeholder || '',
        font: [styles.fontSize, styles.fontFamily, styles.fontWeight, styles.letterSpacing],
        extraSpace: paddingLeft + paddingRight + extraSpace,
        minWidth: inputAutoWidthMinimums[input.dataset.field]
    };
}

function setInputWidthTester(span, { text, font }) {
    const geometry = getDesktopCardGeometry(span);
    [geometry.fontSize, geometry.fontFamily, geometry.fontWeight, geometry.letterSpacing] = font;
    span.textContent = text;
}

function applyInputWidth({ wrapper, extraSpace, minWidth }, textWidth) {
    const geometry = getDesktopCardGeometry(wrapper);
    if (wrapper.dataset.cardField === 'name') {
        geometry.setProperty('--card-name-value-width', `${Math.ceil(textWidth + extraSpace)}px`);
        return;
    }
    geometry.width = `${Math.max(textWidth + extraSpace + 10, minWidth)}px`;
}

function updateInputAutoWidth(inputEl) {
    if (!inputEl?.classList.contains('desktop-card-input') ||
        !Object.hasOwn(inputAutoWidthMinimums, inputEl.dataset.field)) return;
    const wrapper = inputEl.closest('.custom-select-wrapper');
    if (!wrapper) return;

    let span = document.getElementById('input-width-tester');
    if (!span) {
        span = createInputWidthTester();
        span.id = 'input-width-tester';
        document.body.appendChild(span);
    }
    const data = readInputWidth(inputEl, wrapper);
    setInputWidthTester(span, data);
    applyInputWidth(data, span.getBoundingClientRect().width);
}

function getQueryTarget(row) {
    if (row && row.classList.contains('mobile-info-card')) {
        if (row === currentEditingRow) {
            const sheetContainer = document.getElementById('sheet-fields-container');
            if (sheetContainer) return sheetContainer;
        }
    }
    return row;
}

function validateDiscardNoInput(input, force = false) {
    const doValidate = () => {
        const val = input.value.trim().toUpperCase();
        const row = getRowFromInput(input);
        if (!row) return;
        const target = getQueryTarget(row);
        if (input.dataset.invalidInput === "true") {
            delete input.dataset.invalidInput;
            return;
        }
        const nameInput = target.querySelector('.card-name-input, [data-field="name"]');
        if (!val) { resetDiscardRow(row, 'no'); return; }
        if (!cardCacheInstance.getOwnedNumbers().includes(val)) {
            input.value = ""; input.placeholder = "번호 확인!"; input.classList.add('error-placeholder');
            setTimeout(() => { input.placeholder = "카드 번호"; input.classList.remove('error-placeholder'); }, 5000);
            resetDiscardRow(row, 'no');
        } else {
            if (isCardDepleted(val, row)) {
                input.value = ""; input.placeholder = "모두 선택됨"; input.classList.add('error-placeholder');
                setTimeout(() => { input.placeholder = "카드 번호"; input.classList.remove('error-placeholder'); }, 5000);
                resetDiscardRow(row, 'no');
                return;
            }
            const matches = cardCacheInstance.getInventory().filter(r => String(r[1]).trim().toUpperCase() === val);
            if (matches.length > 0) {
                const name = matches[0][0];
                if (nameInput) {
                    nameInput.dataset.programmatic = "true";
                    nameInput.value = name;
                    delete nameInput.dataset.programmatic;
                }
                updateDiscardIllusts(row, matches);
            }
        }
    };

    if (force) {
        doValidate();
    } else {
        setTimeout(() => {
            if (input.dataset.programmatic === "true") return;
            doValidate();
        }, 150);
    }
}

function validateMoveNoInput(input, force = false) {
    const doValidate = () => {
        const val = input.value.trim().toUpperCase();
        const row = getRowFromInput(input);
        if (!row) return;
        const target = getQueryTarget(row);
        if (input.dataset.invalidInput === "true") {
            delete input.dataset.invalidInput;
            return;
        }
        const nameInput = target.querySelector('.card-name-input, [data-field="name"]');
        if (!val) { resetMoveRow(row, 'no'); return; }
        if (!cardCacheInstance.getOwnedNumbers().includes(val)) {
            input.value = ""; input.placeholder = "번호 확인!"; input.classList.add('error-placeholder');
            setTimeout(() => { input.placeholder = "카드 번호"; input.classList.remove('error-placeholder'); }, 5000);
            resetMoveRow(row, 'no');
        } else {
            const matches = cardCacheInstance.getInventory().filter(r => String(r[1]).trim().toUpperCase() === val);
            if (matches.length > 0) {
                const name = matches[0][0];
                if (nameInput) {
                    nameInput.dataset.programmatic = "true";
                    nameInput.value = name;
                    delete nameInput.dataset.programmatic;
                }
                updateMoveIllusts(row, matches);
            }
        }
    };

    if (force) {
        doValidate();
    } else {
        setTimeout(() => {
            if (input.dataset.programmatic === "true") return;
            doValidate();
        }, 150);
    }
}

function getRowFromInput(el) {
    if (!el) return null;

    // 1. 데스크톱 카드 혹은 모바일 카드에 직접 속해 있는 경우
    const cardEl = el.closest('.desktop-info-card, .mobile-info-card');
    if (cardEl) return cardEl;

    // 2. 바텀시트 내에 삽입되어 편집 중인 경우
    const isBottomSheetEl = el.closest('#mobile-entry-bottom-sheet');
    if (isBottomSheetEl) {
        return currentEditingRow;
    }

    return null;
}




function setupDropdownForField(input, wrap) {
    if (!input || !wrap) return;
    const fieldName = input.dataset.field;
    const row = getRowFromInput(input);
    if (!row) return;

    // 공통 헬퍼: 선택된 값을 원본 행 대응 필드에 기록
    const syncSelectedToOriginal = (selectedInput) => {
        const targetRow = getRowFromInput(selectedInput);
        if (!targetRow) return;
        const origEl = targetRow.querySelector(`[data-field="${fieldName}"]`);
        if (origEl && origEl !== selectedInput) {
            origEl.value = selectedInput.value;
            if (selectedInput.dataset.raw !== undefined) origEl.dataset.raw = selectedInput.dataset.raw;
            if (selectedInput.dataset.maxQty !== undefined) origEl.dataset.maxQty = selectedInput.dataset.maxQty;
        }
    };

    if (fieldName === 'no') {
        setupCardNoAutocomplete(wrap);
    } else if (fieldName === 'illust') {
        setupCustomDropdown(wrap, (selectedInput) => {
            syncSelectedToOriginal(selectedInput);
            if (UIStore.mode === 'move') {
                if (typeof handleMoveIllustChange === 'function') handleMoveIllustChange(selectedInput);
            } else if (UIStore.mode === 'discard') {
                if (typeof handleDiscardIllustChange === 'function') handleDiscardIllustChange(selectedInput);
            }
        });
    } else if (fieldName === 'rare') {
        setupCustomDropdown(wrap, (selectedInput) => {
            syncSelectedToOriginal(selectedInput);
            if (UIStore.mode === 'move') {
                if (typeof handleMoveRareChange === 'function') handleMoveRareChange(selectedInput);
            } else if (UIStore.mode === 'discard') {
                if (typeof handleDiscardRareChange === 'function') handleDiscardRareChange(selectedInput);
            } else {
                if (typeof handleAddRareChange === 'function') handleAddRareChange(selectedInput);
            }
        });
    } else if (fieldName === 'loc') {
        setupCustomDropdown(wrap, (selectedInput) => {
            syncSelectedToOriginal(selectedInput);
            if (UIStore.mode === 'move') {
                if (typeof handleMoveLocChange === 'function') handleMoveLocChange(selectedInput);
            } else if (UIStore.mode === 'discard') {
                if (typeof handleDiscardLocChange === 'function') handleDiscardLocChange(selectedInput);
            } else {
                if (typeof handleAddLocChange === 'function') handleAddLocChange(selectedInput);
            }
        });
    } else if (fieldName === 'to') {
        setupCustomDropdown(wrap, (selectedInput) => {
            syncSelectedToOriginal(selectedInput);
        });
    }
}





function updateDropdownArrowState(wrapper) {
    let count = 0;
    try {
        const options = JSON.parse(wrapper.dataset.options || '[]');
        count = options.length;
    } catch (e) {
        count = 0;
    }

    const isFree = wrapper.dataset.type === 'free';

    if (isFree) {
        wrapper.classList.remove('single-option', 'no-option');
    } else {
        if (count === 1) {
            wrapper.classList.add('single-option');
            wrapper.classList.remove('no-option');
        } else if (count === 0) {
            wrapper.classList.remove('single-option');
            wrapper.classList.add('no-option');
        } else {
            wrapper.classList.remove('single-option', 'no-option');
        }
    }

    if (wrapper.closest('.desktop-info-card--editable')) return;

    if (wrapper.classList.contains('no-arrow')) {
        const arrow = wrapper.querySelector('.arrow-icon');
        if (arrow) {
            arrow.hidden = true;

        }
        return;
    }

    const arrow = wrapper.querySelector('.arrow-icon');
    if (arrow) {
        if (isFree || count >= 2) {
            arrow.hidden = false;

        } else {
            arrow.hidden = true;

        }
    }
    if (wrapper.closest('#sheet-fields-container .card-info-fields')) updateSheetDropdownState();
}

// Labels are presentation only; inventory comparisons keep their original values.
function getIllustrationValue(input) {
    if (!input || !input.value) return '';
    return input.dataset.raw || IllustrationImages.ciidValue(input.value) || input.value;
}

function setIllustrationValue(input, value) {
    if (!input) return;
    input.dataset.raw = String(value || '');
    input.value = IllustrationImages.label(value) || String(value || '');
}

function prepareCardIllustrations(container, cid, ids = []) {
    if (!container || !IllustrationImages.normalizeKey(cid, 1)) return;
    container.dataset.illustrationCid = String(cid);
    const row = getRowFromInput(container);
    if (row) row.dataset.illustrationCid = String(cid);
    void IllustrationImages.preloadCard(String(cid), ids);
}

function prepareOwnedIllustrations(container, matches) {
    const cid = matches.find(item => item[6])?.[6] || findCidByNameOrNo(matches[0]?.[0]);
    prepareCardIllustrations(container, cid, matches.map(item => item[5] || '1'));
}

function openIllustrationPicker(input, wrapper) {
    if (!input || input.disabled) return;
    if (UIStore.mode === 'move') updateMoveIllustsDynamic(wrapper);
    else if (UIStore.mode === 'discard') updateDiscardIllustsDynamic(wrapper);
    const options = JSON.parse(wrapper.dataset.options || '[]');
    updateDropdownArrowState(wrapper);
    if (options.length < 2) {
        if (options.length === 1 && getIllustrationValue(input) !== String(options[0].val)) {
            setIllustrationValue(input, options[0].val);
            if (wrapper._changeCallback) wrapper._changeCallback(input);
        }
        if (options.length === 0) {
            setIllustrationValue(input, '');
            if (wrapper._changeCallback) wrapper._changeCallback(input);
        }
        return;
    }
    const row = getRowFromInput(input);
    const container = getActiveContainer(row) || row;
    let data = {};
    try { data = JSON.parse(container?.dataset.cardData || row?.dataset.cardData || '{}'); } catch (_) {}
    const cid = container?.dataset.illustrationCid || row?.dataset.illustrationCid || data.linkData?.id;
    IllustrationPicker.open({
        anchor: input, cid, options, value: getIllustrationValue(input),
        mobile: document.documentElement.classList.contains('is-mobile-device'),
        onSelect: opt => {
            if (input.disabled) return;
            setIllustrationValue(input, opt.val);
            if (wrapper._changeCallback) wrapper._changeCallback(input);
            else if (UIStore.mode === 'move') handleMoveIllustChange(input);
            else if (UIStore.mode === 'discard') handleDiscardIllustChange(input);
            if (document.documentElement.classList.contains('is-mobile-device')) renderMobileCards();
        }
    });
}

function setupIllustrationField(wrapper, changeCallback) {
    const input = wrapper.querySelector('input');
    wrapper._changeCallback = changeCallback;
    input.readOnly = true;
    input.inputMode = 'none';
    input.setAttribute('role', 'button');
    input.setAttribute('aria-label', '일러스트 선택');
    input.placeholder = '일러스트';
    input.setAttribute('aria-haspopup', 'dialog');
    if (!input.hasAttribute('aria-expanded')) input.setAttribute('aria-expanded', 'false');
    setIllustrationValue(input, getIllustrationValue(input));
    updateDropdownArrowState(wrapper);
    if (wrapper.dataset.illustrationInit) return;
    wrapper.dataset.illustrationInit = 'true';
    wrapper.addEventListener('click', event => {
        // Mobile wrappers already have an inline handler for the second sheet.
        if (wrapper.hasAttribute('onclick')) return;
        event.stopPropagation();
        openIllustrationPicker(input, wrapper);
    });
    input.addEventListener('keydown', event => {
        if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) {
            event.preventDefault();
            openIllustrationPicker(input, wrapper);
        }
    });
    wrapper._arrowObserver = new MutationObserver(() => updateDropdownArrowState(wrapper));
    wrapper._arrowObserver.observe(wrapper, { attributes: true, attributeFilter: ['data-options'] });
}

function setupCustomDropdown(wrapper, changeCallback) {
    if (globalThis.AppBackend) {
        const original = changeCallback;
        changeCallback = input => { original?.(input); globalThis.AppBackend.onSelectionChange(input); };
    }
    if (wrapper.querySelector('[data-field="no"]')) {
        setupCardNoAutocomplete(wrapper);
        return;
    }
    if (wrapper.querySelector('[data-field="illust"]')) {
        setupIllustrationField(wrapper, changeCallback);
        return;
    }
    const isAutoLocation = wrapper.id === 'wrap-auto-loc';
    const input = isAutoLocation
        ? wrapper.querySelector('.auto-location__input')
        : wrapper.querySelector('.custom-input') ?? wrapper.querySelector('.manage-footer__location-input');
    const optionClass = isAutoLocation ? 'auto-location__option color-type000' : 'custom-option';
    const isFreeType = wrapper.dataset.type === 'free';
    let currentFocusIdx = -1;

    // [핵심] 리스너 중복 등록 방지 (누수 차단)
    if (wrapper.dataset.dropdownInit === "true") {
        wrapper._changeCallback = changeCallback; // 콜백 함수만 최신으로 교체
        updateDropdownArrowState(wrapper);
        return;
    }
    wrapper.dataset.dropdownInit = "true";
    wrapper._changeCallback = changeCallback;

    if (!wrapper._arrowObserver) {
        wrapper._arrowObserver = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                if (mutation.type === 'attributes' && mutation.attributeName === 'data-options') {
                    updateDropdownArrowState(wrapper);
                    updateInputAutoWidth(input);
                }
            });
        });
        wrapper._arrowObserver.observe(wrapper, { attributes: true, attributeFilter: ['data-options'] });
    }
    updateDropdownArrowState(wrapper);

    // 개별 드롭다운 요소 생성 또는 찾기 후 Body에 부착 및 참조 보관
    let localDropdown = wrapper._dropdown;
    if (!localDropdown) {
        localDropdown = document.createElement('ul');
        localDropdown.className = isAutoLocation ? 'auto-location__options custom-options' : 'global-dropdown custom-options';
        const expansionBg = wrapper.querySelector(isAutoLocation ? '.dropdown-capsule__surface' : '.search-expansion-bg');
        if (expansionBg) {
            expansionBg.appendChild(localDropdown);
        } else {
            document.body.appendChild(localDropdown);
        }

        wrapper._dropdown = localDropdown;
    }

    const closeDropdown = () => {
        wrapper.classList.remove('active');
        localDropdown.classList.remove('active');
        if (UIStore.activeDropdownInput === input) {
            currentFocusIdx = -1;
            UIStore.activeDropdownInput = null;
        }
        if (isAutoLocation) {
            const val = input.value.trim();
            // 드롭다운이 닫힐 때 값이 있고 확정 상태('true')가 아니면 에러 체크
            if (val.length > 0 && input.dataset.confirmed !== 'true') {
                wrapper.classList.add('error-highlight');
            } else if (input.dataset.confirmed === 'true') {
                wrapper.classList.add('active-highlight');
            } else {
                wrapper.classList.remove('error-highlight', 'active-highlight');
            }
        } else {
            handleAutoLocInput(input);
        }
    };
    const clearBtn = wrapper.querySelector(isAutoLocation ? '.auto-location__clear' : '.clear-btn');
    if (clearBtn) {
        // mousedown 시 e.preventDefault()로 blur 방지
        clearBtn.onmousedown = (e) => {
            e.preventDefault();
        };
        clearBtn.onclick = (e) => {
            if (input.disabled) return;
            e.stopPropagation();
            input.value = "";
            input.dataset.confirmed = "false";
            delete input.dataset.raw;
            wrapper.classList.remove('has-value', 'active-highlight', 'error-highlight');
            updateInputAutoWidth(input);
            if (wrapper._changeCallback) wrapper._changeCallback(input);
            input.focus();
            closeDropdown();
        };
    }

    const openDropdown = () => {
        if (input.closest('#mobile-entry-bottom-sheet')) return;
        if (UIStore.pendingBlurFn && UIStore.activeDropdownInput === input) { clearTimeout(UIStore.pendingBlurFn); UIStore.pendingBlurFn = null; }
        if (input.hasAttribute('readonly') && !input.value && (!wrapper.dataset.options || wrapper.dataset.options === "[]") && !isFreeType) return;
        if (input.disabled) return;

        // 옵션이 2개 미만(0~1개)인 경우 드롭다운UI 노출 차단
        const rawData = JSON.parse(wrapper.dataset.options || "[]");
        if (input.classList.contains('page-card-no') && rawData.length < 2) return;

        if (UIStore.activeDropdownInput && UIStore.activeDropdownInput !== input) { UIStore.activeDropdownInput.blur(); }
        UIStore.activeDropdownInput = input;

        wrapper.classList.add('active');
        wrapper.classList.remove('active-highlight');
        wrapper.classList.remove('error-highlight');

        if (input.classList.contains('move-card-from') || (UIStore.mode === 'move' && (input.classList.contains('desktop-card-loc') || input.dataset.field === 'loc'))) { updateFromLocOptionsDynamic(wrapper); }
        else if (input.classList.contains('move-card-illustration') || (UIStore.mode === 'move' && (input.classList.contains('desktop-card-illust') || input.dataset.field === 'illust'))) { updateMoveIllustsDynamic(wrapper); }
        else if (input.classList.contains('discard-card-illustration') || (UIStore.mode === 'discard' && (input.classList.contains('desktop-card-illust') || input.dataset.field === 'illust'))) { updateDiscardIllustsDynamic(wrapper); }
        else if (input.classList.contains('discard-card-rarity')) { updateDiscardRaritiesDynamic(wrapper); }
        else if (input.classList.contains('discard-card-loc') || (UIStore.mode === 'discard' && (input.classList.contains('desktop-card-loc') || input.dataset.field === 'loc'))) { updateDiscardLocationsDynamic(wrapper); }

        if (!isFreeType && rawData.length === 0) return;

        // readonly 드롭다운이면서 비어있는 경우 첫 번째 옵션 자동 선택 (하이라이트 유지)
        if (input.hasAttribute('readonly') && !input.value && rawData.length > 0 && !isFreeType) {
            const firstOpt = rawData[0];
            if (input.classList.contains('move-card-from') || input.classList.contains('discard-card-loc')) {
                input.value = firstOpt.val;
            } else {
                input.value = firstOpt.text;
            }
            input.dataset.raw = firstOpt.val;
            if (firstOpt.max) input.dataset.maxQty = firstOpt.max;
            currentFocusIdx = 0;
            if (wrapper._changeCallback) wrapper._changeCallback(input);
        }

        if (rawData.length === 1 && !isFreeType && input.hasAttribute('readonly')) { return; }
        renderGlobalDropdown(false);
    };

    const renderGlobalDropdown = (useFilter = true) => {
        if (!wrapper.classList.contains('active')) return;
        const rawData = JSON.parse(wrapper.dataset.options || "[]");
        const query = input.value;
        const normalizedQuery = query.replace(/\s+/g, '').toLowerCase();
        let filtered = rawData;

        if (input.classList.contains('move-card-to') || input.classList.contains('desktop-card-to') || input.id === 'rename-to-input') {
            let fromVal = "";
            if (input.classList.contains('move-card-to') || input.classList.contains('desktop-card-to')) {
                const row = getRowFromInput(input);
                const fromInput = row ? row.querySelector('.move-card-from, .desktop-card-loc, [data-field="loc"]') : null;
                fromVal = fromInput ? fromInput.value : "";
            } else {
                const fromInput = document.getElementById('rename-from-input'); fromVal = fromInput ? fromInput.value : "";
            }
            if (fromVal) { filtered = filtered.filter(opt => opt.val !== fromVal); }
        }

        if (useFilter && query) {
            filtered = filtered.filter(opt => {
                const normalizedOpt = opt.text.replace(/\s+/g, '').toLowerCase();
                return Hangul.search(normalizedOpt, normalizedQuery) !== -1;
            });
        }

        localDropdown.innerHTML = "";
        if (filtered.length === 0) {
            const li = document.createElement('li');
            li.className = isAutoLocation ? 'auto-location__option item-no-match color-text-002' : 'custom-option item-no-match';

            let noResultText = '존재하지 않는 데이터';
            if (isAutoLocation ||
                input.classList.contains('page-card-loc') ||
                input.classList.contains('desktop-card-loc') ||
                input.classList.contains('move-card-to') ||
                input.classList.contains('desktop-card-to')) {
                noResultText = '새로운 보관 위치 추가';
            } else if (input.id === 'rename-to-input') {
                noResultText = '새로운 위치';
            }
            li.innerText = noResultText;
            localDropdown.appendChild(li);
        } else {
            filtered.forEach((opt) => {
                const li = document.createElement('li');
                li.className = optionClass;
                if (opt.text === input.value) li.classList.add('selected');
                li.innerText = opt.text;
                li.dataset.val = opt.val;
                if (opt.max) li.dataset.max = opt.max;
                li.onmousedown = (e) => e.preventDefault();
                li.onclick = () => selectOption(opt);
                localDropdown.appendChild(li);
            });
        }

        // 위치 계산 및 Body Append (자동 입력란 격리 보정 포함)
        // 보관 위치 자동 입력란(Nesting)인 경우 JS에 의한 절대 위치/너비 설정을 건너뛰고 CSS에 맡김
        if (!isAutoLocation) {
            positionDropdown(localDropdown, wrapper);
            if (!localDropdown.parentNode) document.body.appendChild(localDropdown);
        }

        localDropdown.classList.add('active');
    };
    const selectOption = (optData) => {
        if (input.disabled) {
            closeDropdown();
            return;
        }
        if (input.classList.contains('move-card-from') || input.classList.contains('discard-card-loc') || input.classList.contains('desktop-card-loc')) {
            input.value = optData.val;
        } else {
            input.value = optData.text;
        }

        input.dataset.raw = optData.val;
        if (optData.max) { input.dataset.maxQty = optData.max; }
        if (isAutoLocation) {
            input.dataset.confirmed = "true";
            wrapper.classList.add('has-value');
            applyAutoLocationToTable(input.value);
        }
        closeDropdown();
        updateInputAutoWidth(input);
        if (wrapper._changeCallback) wrapper._changeCallback(input);
    };
    const updateFromLocOptionsDynamic = (wrap) => {
        const row = getRowFromInput(wrap);
        if (!row) return;
        const cardNoInp = row.querySelector('.move-card-no, .desktop-card-no, [data-field="no"]');
        const cardNo = cardNoInp ? cardNoInp.value.trim() : "";
        const illustInp = row.querySelector('.move-card-illustration, .desktop-card-illust, [data-field="illust"]');
        const illust = getIllustrationValue(illustInp);

        const rareInput = row.querySelector('.move-card-rarity, .desktop-card-rare, [data-field="rare"]');
        if (!rareInput || !cardNo) return;
        let rareRaw = rareInput.dataset.raw;

        if (!rareRaw && rareInput.value) {
            const currentVal = rareInput.value;
            const potentialMatches = cardCacheInstance.getInventory().filter(r => String(r[1]).trim().toUpperCase() === cardNo && String(r[5] || "기본").trim() === illust);
            const matchedRow = potentialMatches.find(r => getLocalizedRarity(r[2]) === currentVal);
            if (matchedRow) rareRaw = matchedRow[2];
        }

        const rare = rareRaw;

        const matches = cardCacheInstance.getInventory().filter(r => String(r[1]).trim().toUpperCase() === cardNo && String(r[5] || "기본").trim() === illust && String(r[2]).trim() === rare);
        const locMap = {};
        matches.forEach(r => { const loc = String(r[4]).trim(); const qty = parseInt(r[3]) || 0; if (qty > 0) locMap[loc] = (locMap[loc] || 0) + qty; });
        const validLocs = [];
        Object.keys(locMap).forEach(loc => { const avail = getAvailableQty(cardNo, illust, rare, loc, row); if (avail > 0) { validLocs.push({ val: loc, text: `${loc} (잔여: ${avail})`, max: avail }); } });
        validLocs.sort((a, b) => a.val.localeCompare(b.val));
        wrap.dataset.options = JSON.stringify(validLocs);
        if (validLocs.length === 1) wrap.classList.add('single-option'); else wrap.classList.remove('single-option');
        if (validLocs.length === 0) wrap.classList.add('no-option'); else wrap.classList.remove('no-option');
    };

    input.addEventListener('focus', openDropdown); input.addEventListener('click', openDropdown);
    input.addEventListener('blur', () => {
        if (input.disabled || input.closest('#mobile-entry-bottom-sheet')) { closeDropdown(); return; }
        if (input.classList.contains('move-card-to') || input.classList.contains('desktop-card-to')) {
            const row = getRowFromInput(input);
            const fromInput = row ? row.querySelector('.move-card-from, .desktop-card-loc, [data-field="loc"]') : null;
            if (fromInput) { const val = input.value.trim(); const fromVal = fromInput.value.trim(); if (val && fromVal && normalizeStr(val) === normalizeStr(fromVal)) { input.value = ""; } }
        }
        const rawData = JSON.parse(wrapper.dataset.options || "[]"); const query = input.value.trim();
        const isStrict = !isFreeType || (input.dataset.lockedForName === "true");
        if (!query) {
            if (rawData.length === 1 && isStrict) { selectOption(rawData[0]); } else if (isStrict) { input.value = ""; if (wrapper._changeCallback) wrapper._changeCallback(input); } closeDropdown(); return;
        }
        const normalized = normalizeStr(query); const decomposed = decomposeHangul(normalized);
        let filtered = rawData;
        if (input.classList.contains('move-card-to') || input.classList.contains('desktop-card-to')) {
            const row = getRowFromInput(input);
            const fromInput = row ? row.querySelector('.move-card-from, .desktop-card-loc, [data-field="loc"]') : null;
            const fromVal = fromInput ? fromInput.value : "";
            if (fromVal) { filtered = filtered.filter(opt => opt.val !== fromVal); }
        }
        filtered = filtered.filter(opt => decomposeHangul(normalizeStr(opt.text)).includes(decomposed));
        if (filtered.length > 0) {
            // 이미 입력된 값이 있는 경우 해당 값을 유지하거나 첫 번째 일치 항목 선택 (유사한/맨 위의 값 입력 반영)
            const exactMatch = filtered.find(opt => (opt.text === query || opt.val === query));
            if (isFreeType) {
                if (exactMatch) selectOption(exactMatch);
                else closeDropdown();
            } else {
                selectOption(exactMatch || filtered[0]);
            }
        } else {
            if (rawData.length === 1 && isStrict) {
                selectOption(rawData[0]);
            } else if (isStrict) {
                // 필터링 결과가 없고 엄격 모드인 경우 비우고 placeholder 갱신
                // [예외 처리] 데이터 로딩 중이거나 주입 중인 특수 상태("...")면 지우지 않음
                if (input.value && (input.value.includes("...") || query.includes("..."))) {
                    closeDropdown(); return;
                }
                if (input.placeholder && input.placeholder.includes("...")) {
                    closeDropdown(); return;
                }

                input.value = "";
                input.dataset.invalidInput = "true";

                const isRare = input.classList.contains('page-card-rarity') || input.classList.contains('desktop-card-rare') || input.dataset.field === 'rare';
                const isIllust = input.classList.contains('page-card-illustration') || input.classList.contains('desktop-card-illust') || input.dataset.field === 'illust';
                if (isRare) {
                    input.placeholder = "레어도 선택";
                } else if (isIllust) {
                    input.placeholder = "일러스트";
                } else {
                    input.placeholder = "번호 재선택";
                }

                if (wrapper._changeCallback) {
                    wrapper._changeCallback(input);
                }
            }
            closeDropdown();
        }
    });
    input.addEventListener('input', (e) => {
        if (input.disabled) return;
        // [핵심] 타자 도중에 즉각 렌더링되는 현상 방지 (번호 입력란 전용)
        if (wrapper._changeCallback && !input.classList.contains('page-card-no')) {
            wrapper._changeCallback(input);
        }
        delete input.dataset.raw;
        updateInputAutoWidth(input);
        const rawData = JSON.parse(wrapper.dataset.options || "[]"); if (rawData.length === 1 && !isFreeType) { input.value = rawData[0].val; updateInputAutoWidth(input); return; } if (!wrapper.classList.contains('active')) wrapper.classList.add('active'); currentFocusIdx = -1; renderGlobalDropdown(true);
    });
    input.addEventListener('keydown', (e) => {
        if (input.disabled || input.closest('#mobile-entry-bottom-sheet')) return;
        if (!wrapper.classList.contains('active')) { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { openDropdown(); return; } }
        const items = localDropdown.querySelectorAll('li:not([style*="default"])');
        if (e.key === 'ArrowDown') { e.preventDefault(); currentFocusIdx++; if (currentFocusIdx >= items.length) currentFocusIdx = 0; updateHighlight(items, currentFocusIdx); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); currentFocusIdx--; if (currentFocusIdx < 0) currentFocusIdx = items.length - 1; updateHighlight(items, currentFocusIdx); }
        else if (e.key === 'Enter') {
            if (e.isComposing) return; // 한글 입력 중 엔터 키 중복 처리 방지
            const isShortcut = e.ctrlKey || e.metaKey;
            if (!isShortcut) e.preventDefault();
            if (currentFocusIdx > -1 && items[currentFocusIdx]) {
                items[currentFocusIdx].click();
            } else {
                if (isAutoLocation && input.value.trim().length > 0) {
                    input.dataset.confirmed = "true";
                    applyAutoLocationToTable(input.value.trim());
                    wrapper.classList.remove('error-highlight');
                    wrapper.classList.add('active-highlight');
                }
                if (!isShortcut) input.blur();
            }
        }
        else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            if (isAutoLocation) {
                input.value = "";
                input.dataset.confirmed = "false";
                wrapper.classList.remove('has-value', 'active-highlight', 'error-highlight');
                if (wrapper._changeCallback) wrapper._changeCallback(input);
            }
            input.blur();
            closeDropdown();
        }
        else if (e.key === 'Tab') {
            if (e.isComposing) return; // 한글 입력 중 탭 키 중복 처리 방지
            const rawData = JSON.parse(wrapper.dataset.options || "[]"); const query = input.value.trim(); const normalized = normalizeStr(query); const decomposed = decomposeHangul(normalized);
            let filtered = rawData;
            if (input.classList.contains('move-card-to') || input.classList.contains('desktop-card-to')) {
                const row = getRowFromInput(input);
                const fromInput = row ? row.querySelector('.move-card-from') : null;
                const fromVal = fromInput ? fromInput.value : "";
                if (fromVal) { filtered = filtered.filter(opt => opt.val !== fromVal); }
            }
            if (query) { filtered = filtered.filter(opt => decomposeHangul(normalizeStr(opt.text)).includes(decomposed)); }

            const isStrict = !isFreeType || (input.dataset.lockedForName === "true");

            if (currentFocusIdx > -1 && items[currentFocusIdx]) {
                const opt = { val: items[currentFocusIdx].dataset.val, text: items[currentFocusIdx].innerText, max: items[currentFocusIdx].dataset.max };
                selectOption(opt);
            } else if (filtered.length > 0) {
                // 포커스 시 이미 첫 번째가 선택되므로, 탭을 눌렀을 때는 필터링된 첫 번째를 확정
                selectOption(filtered[0]);
            } else {
                // 일치하는게 없으면 비움 및 placeholder 변경
                if (isStrict) {
                    input.value = "";
                    input.dataset.invalidInput = "true";
                    const isRare = input.classList.contains('page-card-rarity') || input.classList.contains('desktop-card-rare') || input.dataset.field === 'rare';
                    const isIllust = input.classList.contains('page-card-illustration') || input.classList.contains('desktop-card-illust') || input.dataset.field === 'illust';
                    if (isRare) {
                        input.placeholder = "레어도 선택";
                    } else if (isIllust) {
                        input.placeholder = "일러스트";
                    } else {
                        input.placeholder = "번호 재선택";
                    }
                    if (wrapper._changeCallback) wrapper._changeCallback(input);
                }
            }
            if (UIStore.pendingBlurFn) { clearTimeout(UIStore.pendingBlurFn); UIStore.pendingBlurFn = null; } closeDropdown();
        }
    });
    updateInputAutoWidth(input);
}



function resetMoveRow(row, level) {
    IllustrationPicker.close(false, false);
    const target = getQueryTarget(row);
    const illustInp = target.querySelector('.move-card-illustration, .desktop-card-illust, [data-field="illust"]'); const rareInp = target.querySelector('.move-card-rarity, .desktop-card-rare, [data-field="rare"]'); const fromInp = target.querySelector('.move-card-from, .desktop-card-loc, [data-field="loc"]'); const qtyInput = target.querySelector('.move-card-qty, .desktop-card-qty, [data-field="qty"]');
    const illustWrap = illustInp ? illustInp.closest('.custom-select-wrapper') : null; const rareWrap = rareInp ? rareInp.closest('.custom-select-wrapper') : null; const fromWrap = fromInp ? fromInp.closest('.custom-select-wrapper') : null;
    if (illustWrap) { illustWrap.classList.remove('single-option'); illustWrap.classList.add('no-option'); }
    if (rareWrap) { rareWrap.classList.remove('single-option'); rareWrap.classList.add('no-option'); }
    if (fromWrap) { fromWrap.classList.remove('single-option'); fromWrap.classList.add('no-option'); }

    if (qtyInput) qtyInput.setAttribute('readonly', true);
    if (level === 'no') { 
        setIllustrationValue(illustInp, ""); illustInp.setAttribute('readonly', true); if (illustWrap) illustWrap.dataset.options = "[]";
        rareInp.value = ""; rareInp.setAttribute('readonly', true); if (rareWrap) rareWrap.dataset.options = "[]"; delete rareInp.dataset.raw; 
        fromInp.value = ""; if (fromWrap) fromWrap.dataset.options = "[]"; delete fromInp.dataset.raw; qtyInput.value = ''; 
    }

    if (document.documentElement.classList.contains('is-mobile-device')) {
        renderMobileCards();
    }
}
function updateMoveIllusts(row, matches) {
    prepareOwnedIllustrations(row, matches);
    const target = getQueryTarget(row);
    const illustInp = target.querySelector('.move-card-illustration, [data-field="illust"]');
    const illustWrap = illustInp ? illustInp.closest('.custom-select-wrapper') : null;
    const cardNoInp = target.querySelector('.move-card-no, [data-field="no"]');
    const cardNo = cardNoInp ? cardNoInp.value.trim() : "";
    if (!illustInp || !illustWrap || !cardNo) return;

    const uniqueIllusts = [...new Set(matches.map(r => String(r[5] || "기본").trim()))].sort((a, b) => { if (a === "기본") return -1; if (b === "기본") return 1; return a.localeCompare(b, undefined, { numeric: true }); });
    const validIllusts = uniqueIllusts.filter(illust => checkMoveIllustAvailability(cardNo, illust, row));
    const options = validIllusts.map(i => ({ val: i, text: i }));
    illustWrap.dataset.options = JSON.stringify(options);
    illustInp.readOnly = true; illustWrap.classList.remove('no-option');
    setupDropdownForField(illustInp, illustWrap);
    const currentVal = getIllustrationValue(illustInp); const isValid = options.some(o => o.val === currentVal);
    if (isValid) { handleMoveIllustChange(illustInp); } else { if (options.length === 0) { setIllustrationValue(illustInp, ""); illustWrap.classList.add('no-option'); } else if (options.length === 1) { illustWrap.classList.add('single-option'); setIllustrationValue(illustInp, options[0].val); handleMoveIllustChange(illustInp); } else { setIllustrationValue(illustInp, ""); illustWrap.classList.remove('single-option'); handleMoveIllustChange(illustInp); } }

    if (document.documentElement.classList.contains('is-mobile-device')) {
        renderMobileCards();
    }
}
function handleMoveIllustChange(input) {
    const row = getRowFromInput(input);
    const target = getQueryTarget(row);
    const cardNoInp = target.querySelector('.move-card-no, [data-field="no"]');
    const cardNo = cardNoInp ? cardNoInp.value.trim() : "";
    const selectedIllust = getIllustrationValue(input);
    setIllustrationValue(input, selectedIllust);
    if (!selectedIllust) {
        const rareInp = target.querySelector('.move-card-rarity, [data-field="rare"]');
        if (rareInp) { rareInp.value = ""; handleMoveRareChange(rareInp); }
        return;
    }
    const dbIllust = selectedIllust;
    const matches = cardCacheInstance.getInventory().filter(r => String(r[1]).trim().toUpperCase() === cardNo && String(r[5] || "기본").trim() === dbIllust);
    updateMoveRarities(row, matches);

    if (document.documentElement.classList.contains('is-mobile-device')) {
        renderMobileCards();
    }
}
function updateMoveRarities(row, matches) {
    const target = getQueryTarget(row);
    const rareInp = target.querySelector('.move-card-rarity, [data-field="rare"]');
    const rareWrap = rareInp ? rareInp.closest('.custom-select-wrapper') : null;
    const cardNoInp = target.querySelector('.move-card-no, [data-field="no"]');
    const cardNo = cardNoInp ? cardNoInp.value.trim() : "";
    const illustInp = target.querySelector('.move-card-illustration, [data-field="illust"]');
    const illust = getIllustrationValue(illustInp);
    if (!rareInp || !rareWrap || !cardNo) return;

    const uniqueRares = [...new Set(matches.map(r => String(r[2]).trim()))].sort(compareRarity);
    const validRares = uniqueRares.filter(rare => checkMoveRareAvailability(cardNo, illust, rare, row));
    const options = validRares.map(r => ({ val: r, text: getLocalizedRarity(r) }));
    rareWrap.dataset.options = JSON.stringify(options);
    rareInp.removeAttribute('readonly'); rareWrap.classList.remove('no-option');
    setupDropdownForField(rareInp, rareWrap);
    const currentVal = rareInp.value; const isValid = options.some(o => o.val === currentVal);
    if (isValid) { handleMoveRareChange(rareInp); } else { if (options.length === 0) { rareInp.value = ""; rareWrap.classList.add('no-option'); } else if (options.length === 1) { rareWrap.classList.add('single-option'); rareInp.value = options[0].text; rareInp.dataset.raw = options[0].val; handleMoveRareChange(rareInp); } else { rareInp.value = ""; delete rareInp.dataset.raw; rareWrap.classList.remove('single-option'); handleMoveRareChange(rareInp); } }

    if (document.documentElement.classList.contains('is-mobile-device')) {
        renderMobileCards();
    }
}
function handleMoveRareChange(input) {
    const row = getRowFromInput(input);
    const target = getQueryTarget(row);
    const cardNoInp = target.querySelector('.move-card-no, [data-field="no"]');
    const cardNo = cardNoInp ? cardNoInp.value.trim() : "";
    const illustInp = target.querySelector('.move-card-illustration, [data-field="illust"]');
    const selectedIllust = getIllustrationValue(illustInp);
    const selectedRare = input.dataset.raw || input.value;
    if (!input.value) {
        const fromInp = target.querySelector('.move-card-from, [data-field="loc"]');
        if (fromInp) { fromInp.value = ""; handleMoveLocChange(fromInp); }
        return;
    }
    const dbIllust = selectedIllust;
    const matches = cardCacheInstance.getInventory().filter(r => String(r[1]).trim().toUpperCase() === cardNo && String(r[5] || "기본").trim() === dbIllust && String(r[2]).trim() === selectedRare);
    updateMoveLocations(row, matches);

    if (document.documentElement.classList.contains('is-mobile-device')) {
        renderMobileCards();
    }
}
function getAvailableQty(cardNo, illust, rare, loc, currentRow) {
    const dbMatches = cardCacheInstance.getInventory().filter(r => String(r[1]).trim().toUpperCase() === cardNo && String(r[5] || "기본").trim() === illust && String(r[2]).trim() === rare && String(r[4]).trim() === loc);
    const totalDbQty = dbMatches.reduce((sum, r) => sum + (parseInt(r[3]) || 0), 0);
    
    let usedQty = 0;
    const isMobile = document.documentElement.classList.contains('is-mobile-device');
    const modeSuffix = (UIStore.mode === 'discard') ? 'discard' : 'move';
    const containerId = isMobile ? `mobile-cards-list-${modeSuffix}` : `desktop-cards-list-${modeSuffix}`;
    const cardClass = isMobile ? '.mobile-info-card[data-index]' : '.desktop-info-card[data-index]';
    
    const container = document.getElementById(containerId);
    if (container) {
        const cards = container.querySelectorAll(cardClass);
        cards.forEach(c => {
            if (c === currentRow) return;
            const data = getDesktopCardData(c);
            if (data.cardNo === cardNo && data.illustration === illust && data.rarity === rare && data.loc === loc) {
                usedQty += data.qty;
            }
        });
    }
    return Math.max(0, totalDbQty - usedQty);
}
function checkMoveRareAvailability(cardNo, illust, rare, currentRow) {
    const dbMatches = cardCacheInstance.getInventory().filter(r => String(r[1]).trim().toUpperCase() === cardNo && String(r[5] || "기본").trim() === illust && String(r[2]).trim() === rare);
    const dbLocs = [...new Set(dbMatches.map(r => String(r[4]).trim()))];
    return dbLocs.some(loc => getAvailableQty(cardNo, illust, rare, loc, currentRow) > 0);
}
function checkMoveIllustAvailability(cardNo, illust, excludeRow) {
    const matches = cardCacheInstance.getInventory().filter(r => String(r[1]).trim().toUpperCase() === cardNo && String(r[5] || "기본").trim() === illust);
    const uniqueRares = [...new Set(matches.map(r => String(r[2]).trim()))];
    return uniqueRares.some(rare => checkMoveRareAvailability(cardNo, illust, rare, excludeRow));
}
function isMoveCardDepleted(cardNo, excludeRow) {
    const matches = cardCacheInstance.getInventory().filter(r => String(r[1]).trim().toUpperCase() === cardNo);
    if (matches.length === 0) return true;
    const uniqueIllusts = [...new Set(matches.map(r => String(r[5] || "기본").trim()))];
    return !uniqueIllusts.some(illust => checkMoveIllustAvailability(cardNo, illust, excludeRow));
}
function updateMoveRowMaxQty(qtyInput) {
    if (UIStore.mode !== 'move') return;
    const row = getRowFromInput(qtyInput);
    if (!row) return;
    const target = getQueryTarget(row);
    const noInp = target.querySelector('.move-card-no, [data-field="no"]');
    const illustInp = target.querySelector('.move-card-illustration, [data-field="illust"]');
    const rareInp = target.querySelector('.move-card-rarity, [data-field="rare"]');
    const locInp = target.querySelector('.move-card-from, [data-field="loc"]');
    
    const no = noInp ? noInp.value.trim().toUpperCase() : '';
    const illust = getIllustrationValue(illustInp);
    const rare = rareInp ? (rareInp.dataset.raw || rareInp.value.trim()) : '';
    const loc = locInp ? locInp.value.trim() : '';
    
    if (!no || !illust || !rare || !loc) return;
    
    const avail = getAvailableQty(no, illust, rare, loc, row);
    
    qtyInput.max = avail;
    qtyInput.placeholder = `최대 ${avail}`;
    
    const val = parseInt(qtyInput.value) || 0;
    if (val > avail) {
        qtyInput.value = avail;
    }
    
    if (locInp) {
        locInp.dataset.maxQty = avail;
    }
}
function recalcSiblingRowQtys(changedRow) {
    if (UIStore.mode !== 'move') return;
    // 이동 모드에서는 우선순위에 따른 강제 차감을 처리하지 않고 각 행이 실시간 가용 재고를 제약받으므로 아무 작업도 하지 않습니다.
    return;
}
function updateMoveLocations(row, matches) {
    const target = getQueryTarget(row);
    const fromInp = target.querySelector('.move-card-from, [data-field="loc"]');
    const fromWrap = fromInp ? fromInp.closest('.custom-select-wrapper') : null;
    const cardNoInp = target.querySelector('.move-card-no, [data-field="no"]');
    const cardNo = cardNoInp ? cardNoInp.value.trim() : "";
    const illustInp = target.querySelector('.move-card-illustration, [data-field="illust"]');
    const illust = getIllustrationValue(illustInp);
    const rareInput = target.querySelector('.move-card-rarity, [data-field="rare"]');
    const rare = rareInput ? (rareInput.dataset.raw || rareInput.value) : "";
    if (!fromInp || !fromWrap || !cardNo) return;

    fromInp.removeAttribute('readonly'); fromWrap.classList.remove('no-option');
    setupDropdownForField(fromInp, fromWrap);

    const locMap = {};
    matches.forEach(r => { const loc = String(r[4]).trim(); const qty = parseInt(r[3]) || 0; if (qty > 0) locMap[loc] = (locMap[loc] || 0) + qty; });
    const validLocs = []; Object.keys(locMap).forEach(loc => { const avail = getAvailableQty(cardNo, illust, rare, loc, row); if (avail > 0) { validLocs.push({ val: loc, text: `${loc} (잔여: ${avail})`, max: avail }); } });
    fromWrap.dataset.options = JSON.stringify(validLocs);
    const currentVal = fromInp.value; const validOption = validLocs.find(o => o.val === currentVal);
    if (validOption) { fromInp.dataset.maxQty = validOption.max; handleMoveLocChange(fromInp); } else { if (validLocs.length === 1) { fromWrap.classList.add('single-option'); fromInp.value = validLocs[0].val; fromInp.dataset.maxQty = validLocs[0].max; handleMoveLocChange(fromInp); } else { fromInp.value = ""; fromWrap.classList.remove('single-option'); handleMoveLocChange(fromInp); } }
    if (validLocs.length === 0) fromWrap.classList.add('no-option');

    if (document.documentElement.classList.contains('is-mobile-device')) {
        renderMobileCards();
    }
}
function handleMoveLocChange(input) {
    const row = getRowFromInput(input);
    const target = getQueryTarget(row);
    const qtyInput = target.querySelector('.move-card-qty, [data-field="qty"]');
    const maxQty = parseInt(input.dataset.maxQty) || 0;
    const toInput = target.querySelector('.move-card-to, [data-field="to"]');
    if (toInput && toInput.value) { const fromVal = input.value.trim(); const toVal = toInput.value.trim(); if (fromVal && normalizeStr(fromVal) === normalizeStr(toVal)) { toInput.value = ""; } }
    if (!input.value) { 
        if (qtyInput) {
            qtyInput.value = ""; qtyInput.setAttribute('readonly', true); 
        }
        if (document.documentElement.classList.contains('is-mobile-device')) {
            renderMobileCards();
        }
        return; 
    }
    const rareInput = target.querySelector('.move-card-rarity, [data-field="rare"]');
    const isRareEntered = rareInput && (rareInput.dataset.raw || rareInput.value.trim()).length > 0;

    if (maxQty > 0 && isRareEntered) {
        if (qtyInput) {
            qtyInput.removeAttribute('readonly');
            qtyInput.max = maxQty;
            qtyInput.placeholder = `최대 ${maxQty}`;
            const currentQty = parseInt(qtyInput.value);
            if (!isNaN(currentQty) && currentQty > maxQty) {
                qtyInput.value = maxQty;
            }
        }
    } else {
        if (qtyInput) {
            qtyInput.value = "";
            qtyInput.placeholder = "재고 없음";
            qtyInput.setAttribute('readonly', true);
        }
    }

    if (document.documentElement.classList.contains('is-mobile-device')) {
        renderMobileCards();
    }
}
function showMoveResultModal(moves, isFullSynced) {
    showManagementResult('move', moves, null, isFullSynced);
}

async function finishMoveProcess() {
    const modal = document.getElementById('move-result-modal');
    const hasSuccess = modal.dataset.hasSuccess === "true";

    const isMobile = document.documentElement.classList.contains('is-mobile-device');
    const containerId = isMobile ? 'mobile-cards-list-move' : 'desktop-cards-list-move';
    const cardClass = isMobile ? '.mobile-info-card[data-index]' : '.desktop-info-card[data-index]';
    const container = document.getElementById(containerId);

    if (container) {
        const cards = Array.from(container.querySelectorAll(cardClass));
        cards.forEach(card => {
            const cardNoVal = (card.querySelector('[data-field="no"]') || card.querySelector('.move-card-no') || {}).value || "";
            if (card.dataset.moveStatus === 'success' || !cardNoVal.trim()) {
                card.remove();
            } else {
                delete card.dataset.moveStatus;
            }
        });

        const remainingCount = container.querySelectorAll(cardClass).length;
        if (remainingCount === 0) {
            container.innerHTML = '';
            if (isMobile) mobileAddEntry('move');
            else desktopAddEntry('move');
        } else {
            if (!isMobile) reindexDesktopCards(container);
        }
    }

    if (hasSuccess) {
        if (syncCounter >= 9) {
            syncCounter = 0;
            await refreshInitialData(true);
        }
    }

    if (isMobile) {
        renderMobileCards();
    }
}

async function submitMoveEntries() {
    if (!requireInventoryReady()) return;
    if (managementRequestPending) return;
    const submitBtn = document.getElementById('move-submit-main-btn');
    if (submitBtn && submitBtn.classList.contains('disabled')) return;

    const entries = [];
    const isMobile = document.documentElement.classList.contains('is-mobile-device');

    if (isMobile) {
        const listContainer = document.getElementById('mobile-cards-list-move');
        if (listContainer) {
            const cards = listContainer.querySelectorAll('.mobile-info-card[data-index]');
            cards.forEach(card => {
                const data = getDesktopCardData(card);
                const qtyInp = card.querySelector('[data-field="qty"]');
                const maxQty = parseInt(qtyInp ? qtyInp.max : 0) || 0;
                entries.push({
                    el: card,
                    cardNo: data.cardNo,
                    cardName: data.name,
                    rarity: data.rarity,
                    illustration: data.illustration,
                    currentLoc: data.loc,
                    targetLoc: data.to,
                    moveQty: data.qty,
                    maxQty: maxQty
                });
            });
        }
    } else {
        const listContainer = document.getElementById('desktop-cards-list-move');
        if (listContainer) {
            const cards = listContainer.querySelectorAll('.desktop-info-card[data-index]');
            cards.forEach(card => {
                const data = getDesktopCardData(card);
                const qtyInp = card.querySelector('[data-field="qty"]');
                const maxQty = parseInt(qtyInp ? qtyInp.max : 0) || 0;
                entries.push({
                    el: card,
                    cardNo: data.cardNo,
                    cardName: data.name,
                    rarity: data.rarity,
                    illustration: data.illustration,
                    currentLoc: data.loc,
                    targetLoc: data.to,
                    moveQty: data.qty,
                    maxQty: maxQty
                });
            });
        }
    }

    const moves = [];
    const submittedRows = [];
    let failCount = 0;

    entries.forEach(item => {
        const cardNo = item.cardNo;
        const cardName = item.cardName;
        const rarity = item.rarity;
        const illustration = item.illustration;
        const currentLoc = item.currentLoc;
        const targetLoc = item.targetLoc;
        const moveQty = item.moveQty;
        const maxQty = item.maxQty;
        const el = item.el;

        if (!cardNo) return;

        let isValid = true;
        if (!cardName || !illustration || !rarity || !currentLoc || !targetLoc || !Number.isSafeInteger(Number(moveQty)) || Number(moveQty) < 1) isValid = false;
        if (moveQty > maxQty || currentLoc === targetLoc) isValid = false;

        if (!isValid) {
            failCount++;
            el.dataset.moveStatus = 'fail';
        } else {
            el.dataset.moveStatus = 'pending';
        }
        moves.push({ cardNo, cid: findCidByNameOrNo(cardName, cardNo), cardName, rarity, illustration, currentLoc, targetLoc, moveQty, maxQty, status: isValid ? 'pending' : 'fail',
            failReason: isValid ? null : !cardName ? 'invalid_no' : !illustration ? 'no_illustration' : !rarity ? 'no_rarity' : !currentLoc ? 'no_loc' : !targetLoc ? 'no_target_loc' : currentLoc === targetLoc ? 'same_loc' : moveQty > maxQty ? 'insufficient_qty' : 'invalid_qty' });
        if (isValid) submittedRows.push({ log: moves[moves.length - 1], el, statusKey: 'moveStatus' });
    });

    if (moves.length === 0) { showToast('이동할 카드가 없습니다.', 'toast-warn'); return; }

    if (!UserStore.user) {
        savePendingFormData();
        toggleAuthModal(true);
        return;
    }
    if (failCount === moves.length) { showMoveResultModal(moves); return; }

    const pendingMoves = moves.filter(move => move.status === 'pending');
    const response = await requestManagementOperation('moveCards', { moves: pendingMoves }, submittedRows, '카드 이동 중...');
    if (response) showMoveResultModal(moves);

}

async function submitBulkMoveEntries() {
    if (!requireInventoryReady()) return;
    if (managementRequestPending) return;
    const fromInput = document.getElementById('rename-from-input');
    const toInput = document.getElementById('rename-to-input');

    if (!fromInput || !toInput) return;

    const fromLoc = fromInput.value.trim();
    const toLoc = toInput.value.trim();

    if (!fromLoc || !toLoc) {
        showToast('대상 위치와 이동할 위치를 모두 입력해주세요.', 'toast-warn');
        return;
    }

    if (fromLoc === toLoc) {
        showToast('서로 다른 위치를 입력해주세요.', 'toast-warn');
        return;
    }

    if (!UserStore.user) {
        savePendingFormData();
        toggleAuthModal(true);
        return;
    }

    const moves = [];
    for (const row of cardCacheInstance._inventory || []) {
        if (row[4] !== fromLoc || row[3] <= 0) continue;
        moves.push({ itemId: row[7], printingId: row[8], variantId: row[9], locationId: row[10], cid: row[6] || findCidByNameOrNo(row[0], row[1]), cardNo: row[1], cardName: row[0] || 'Unknown', rarity: row[2] || '',
            illustration: row[5] || '', currentLoc: fromLoc, targetLoc: toLoc,
            moveQty: row[3], maxQty: row[3], status: 'pending' });
    }
    if (!moves.length) { showToast('이동할 카드가 없습니다.', 'toast-warn'); return; }
    const response = await requestManagementOperation('moveCards', { moves }, moves.map(log => ({ log })), '카드 일괄 이동 중...');
    if (!response) return;
    if (moves.every(move => move.status === 'success')) toggleRenameMode();
    showMoveResultModal(moves);

}

function adjustStepQty(btn, delta) {
    const container = btn.closest('.desktop-qty-wrapper');
    const input = container ? container.querySelector('input[type="number"]') : null;
    if (!input || input.hasAttribute('readonly')) return;

    if (UIStore.mode === 'move') {
        updateMoveRowMaxQty(input);
    }

    let val = parseInt(input.value) || 0;
    val += delta;

    const min = parseInt(input.min) || 1;
    const max = parseInt(input.max);

    if (val < min) val = min;
    if (!isNaN(max) && val > max) val = max;

    input.value = val;

    const event = new Event('input', { bubbles: true });
    input.dispatchEvent(event);
}

function renderDashboardStatList(panelId, entries, unit) {
    const panel = document.getElementById(panelId);
    if (!panel) return;

    const content = panel.querySelector('[data-stat-content]');
    const empty = entries.length === 0;
    panel.querySelector('.loading-spinner-small').hidden = true;
    content.hidden = false;
    content.classList.toggle('ui-stat-empty', empty);
    content.classList.toggle('color-text-002', empty);
    if (empty) {
        content.textContent = '데이터가 없습니다.';
        return;
    }

    const rows = document.createDocumentFragment();
    const extra = document.createElement('div');
    extra.id = `${panelId}-extra`;
    extra.hidden = true;
    for (const [index, [label, count]] of entries.entries()) {
        const row = document.createElement('div');
        row.className = 'stat-item';
        const name = document.createElement('span');
        name.className = 'stat-name color-text-001';
        name.textContent = label;
        const badge = document.createElement('span');
        badge.className = 'stat-cnt ui-chip color-tint-theme shape-capsule';
        badge.textContent = count + unit;
        row.append(name, badge);
        (index < 3 ? rows : extra).append(row);
    }

    if (extra.childElementCount) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'stat-more-btn ui-button color-theme-001';
        button.setAttribute('aria-controls', extra.id);
        button.setAttribute('aria-expanded', 'false');

        const label = document.createElement('span');
        label.textContent = '더보기';
        const icon = document.createElement('i');
        icon.className = 'material-icons';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = 'expand_more';
        button.append(label, icon);
        button.addEventListener('click', () => {
            const expanded = extra.hidden;
            extra.hidden = !expanded;
            button.setAttribute('aria-expanded', String(expanded));
            label.textContent = expanded ? '접기' : '더보기';
        });
        rows.append(extra, button);
    }
    content.replaceChildren(rows);
}

/**
 * 보유 현황 대시보드 통계를 업데이트합니다.
 */
function updateDashboardStats() {
    if (UserStore.user && UserStore.inventorySyncStatus !== 'ready') {
        setInventorySyncStatus(UserStore.inventorySyncStatus);
        return;
    }

    const invTotalElem = document.getElementById('inv-total-cards');
    const invKindElem = document.getElementById('inv-kind-cards');
    if (invTotalElem) invTotalElem.textContent = cardCacheInstance.getAmount();
    if (invKindElem) invKindElem.textContent = cardCacheInstance.getOwnedNumbers().length;

    const locations = Object.entries(cardCacheInstance.getLocationsMap())
        .sort((a, b) => b[1].length - a[1].length)
        .map(([label, numbers]) => [label, numbers.length]);
    const rarities = Object.entries(cardCacheInstance.getRaritiesMap())
        .sort((a, b) => compareRarity(b[0], a[0]))
        .map(([key, quantity]) => [getLocalizedRarity(key), quantity]);

    renderDashboardStatList('inv-location-stats', locations, '종');
    renderDashboardStatList('inv-rarity-stats', rarities, '장');
}

/**
 * 보유 현황 내부 모드를 전환합니다.
 */
function switchInventoryMode(mode, instant) {
    UIStore.inventoryMode = mode;

    // 라디오 버튼 동기화
    const radio = document.querySelector(`input[name="inventory-mode"][value="${mode}"]`);
    if (radio) radio.checked = true;

    const forms = ['dashboard', 'list'];
    const wrapper = document.getElementById('inventory-mode-forms');
    const segmentControl = document.querySelector('#app-page-inventory .ui-segment');
    if (!wrapper) return;

    if (instant && segmentControl) {
        segmentControl.classList.add('no-transition');
    }

    forms.forEach(f => {
        const el = document.getElementById(`form-inventory-${f}`);
        setModePanelActive(el, f === mode);
    });

    if (mode === 'list') {
        // 목록 탭 진입 시 인벤토리 그리드 렌더링 진입
        renderInventoryGrid();
    } else {
        // 대시보드 탭 진입 시 통계 업데이트 로직 호출 가능
        updateDashboardStats();
    }

    if (instant) {
        if (segmentControl) {
            segmentControl.classList.add('no-transition');
            requestAnimationFrame(() => {
                segmentControl.classList.remove('no-transition');
            });
        }
        return;
    }

    // 높이 애니메이션은 CSS transition: height에 맡김
    // 필요 시 wrapper.style.height를 잠시 강제하여 전이를 트리거할 수 있음

    // URL 업데이트
    updateInventoryUrl();
}

function updateInventoryUrl() {
    if (UIStore.mode !== 'inventory') return;
    const finalHash = `inventory/${UIStore.inventoryMode}`;
    if (window.location.hash !== '#' + finalHash) {
        isInternalHashChange = true;
        window.history.replaceState(null, '', window.location.pathname + window.location.search + '#' + finalHash);
        setTimeout(() => { isInternalHashChange = false; }, 100);
    }
}



// -----------------------------------------------------------------------------
// 팩 검색 자동 완성 로직
// -----------------------------------------------------------------------------
function filterPackNameMatches(names, value) {
    const query = value.normalize('NFC').replace(/\s+/g, '').toLowerCase();
    return query ? names.filter(name => name && typeof name === 'string'
        && Hangul.search(name.normalize('NFC').replace(/\s+/g, '').toLowerCase(), query) !== -1) : names;
}

function getLocalPackNameMatches(value) {
    return filterPackNameMatches(getAllPackNames(), value);
}

function setupPackNameAutocomplete(input, suggestions, onSelect) {
    let currentFocusIdx = -1;
    let suggestionRequest;
    let lastSuggestions = [];
    let suggestionsPending = false;

    const hideSuggestions = () => {
        suggestions.hidden = true;
        currentFocusIdx = -1;
    };

    const closeSuggestions = () => {
        fetchSuggestions.cancel();
        suggestionRequest?.abort();
        lastSuggestions = [];
        suggestionsPending = false;
        hideSuggestions();
    };

    const selectPack = name => {
        input.value = name;
        onSelect();
    };

    const renderSuggestions = (filtered, emptyMessage = '팩 이름 확인') => {
        currentFocusIdx = -1;
        suggestions.replaceChildren();

        if (filtered.length === 0) {
            const li = document.createElement('li');
            li.className = 'color-text-002';
            li.textContent = emptyMessage;
            suggestions.append(li);
        } else {
            filtered.slice(0, 5).forEach(name => {
                const li = document.createElement('li');
                const chip = document.createElement('button');
                chip.type = 'button';
                chip.tabIndex = -1;
                chip.className = 'ui-chip ui-chip--compact ui-chip--interactive color-type005 shape-capsule';
                chip.textContent = name;
                chip.onmousedown = event => event.preventDefault();
                chip.onclick = () => {
                    selectPack(name);
                };
                li.append(chip);
                suggestions.append(li);
            });
        }

        suggestions.hidden = false;
        suggestions.scrollLeft = 0;
    };

    const fetchSuggestions = debounce(async value => {
        const request = new AbortController();
        suggestionRequest = request;
        const isCurrent = () => !request.signal.aborted && document.activeElement === input && input.value === value;
        try {
            const names = await AppBackend.packSuggestions(value, request.signal);
            if (!isCurrent()) return;
            lastSuggestions = names.slice(0, 5);
            suggestionsPending = false;
            renderSuggestions(lastSuggestions);
        } catch (_) {
            if (!isCurrent()) return;
            lastSuggestions = [];
            suggestionsPending = false;
            renderSuggestions([], '팩 추천을 불러오지 못했습니다.');
        }
    }, 100);

    input.addEventListener('input', () => {
        if (globalThis.AppBackend?.packSuggestions) {
            if (!input.value.trim()) {
                closeSuggestions();
                return;
            }
            suggestionRequest?.abort();
            suggestionsPending = true;
            const matches = filterPackNameMatches(lastSuggestions, input.value);
            if (matches.length) renderSuggestions(matches);
            else hideSuggestions();
            fetchSuggestions(input.value);
            return;
        }
        const query = input.value.replace(/\s+/g, '').toLowerCase();
        if (!query) {
            closeSuggestions();
            return;
        }

        renderSuggestions(getLocalPackNameMatches(query));
    });

    input.addEventListener('focus', () => {
        if (!input.value.trim()) return;
        if (globalThis.AppBackend?.packSuggestions) {
            fetchSuggestions(input.value);
            return;
        }
        renderSuggestions(getLocalPackNameMatches(input.value));
    });

    input.addEventListener('blur', event => {
        if (!suggestions.contains(event.relatedTarget)) closeSuggestions();
    });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            const wasOpen = !suggestions.hidden;
            closeSuggestions();
            if (wasOpen) {
                e.preventDefault();
                e.stopPropagation();
            }
            return;
        }
        if (suggestions.hidden) return;

        const items = suggestions.querySelectorAll('button');
        if (!items.length) return;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            currentFocusIdx++;
            if (currentFocusIdx >= items.length) currentFocusIdx = 0;
            updateHighlight(items, currentFocusIdx);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            currentFocusIdx--;
            if (currentFocusIdx < 0) currentFocusIdx = items.length - 1;
            updateHighlight(items, currentFocusIdx);
        } else if (e.key === 'Enter') {
            if (e.isComposing) return;
            if (suggestionsPending && currentFocusIdx === -1) {
                closeSuggestions();
                return;
            }
            e.preventDefault();
            if (currentFocusIdx >= 0 && currentFocusIdx < items.length) {
                items[currentFocusIdx].click();
            } else {
                items[0].click();
            }
        } else if (e.key === 'Tab') {
            if (e.isComposing) return;
            let selectedVal = null;
            if (currentFocusIdx > -1 && items[currentFocusIdx]) {
                selectedVal = items[currentFocusIdx].innerText;
            } else if (!suggestionsPending && items.length > 0) {
                selectedVal = items[0].innerText;
            }
            if (selectedVal) selectPack(selectedVal);
            closeSuggestions();
        }
    });

    function updateHighlight(items, index) {
        items.forEach(item => item.classList.remove('selected'));
        if (index >= 0 && index < items.length) {
            items[index].classList.add('selected');
            items[index].scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
    }
    return closeSuggestions;
}

// ==========================================
// Firebase Auth 연동 및 UI 동작 제어 로직
// ==========================================

let authStateRevision = 0;
let serviceAuthStarted = false;
let resolveServiceUi, rejectServiceUi;
const serviceUiReady = new Promise((resolve, reject) => { resolveServiceUi = resolve; rejectServiceUi = reject; });
serviceUiReady.catch(() => {});
let pendingRegistrationUser = null;
let pendingConsentVersions = null;
let registrationSaving = false;
let loginInProgress = false;
let registrationCheckPending = false;
let pendingServiceAuthUser = null;
let serviceLoginFailureCode = null;
let serviceLoginPending = false;

function setServiceLoginPending(pending) {
    serviceLoginPending = pending;
    showLoading(pending, '로그인 중...');
}

function reportAuthFailure(stage, error) {
    if (!['sign-in-popup', 'sign-in-redirect', 'redirect-result'].includes(stage)) return;
    // OAuth 오류의 message/customData에는 계정·인증 정보가 포함될 수 있어 고정 분류만 남긴다.
    const codes = ['auth/operation-not-supported-in-this-environment', 'auth/web-storage-unsupported',
        'auth/network-request-failed', 'auth/unauthorized-domain', 'auth/auth-domain-config-required',
        'auth/invalid-api-key', 'auth/app-not-authorized', 'auth/operation-not-allowed',
        'auth/account-exists-with-different-credential', 'auth/credential-already-in-use',
        'auth/invalid-credential', 'auth/invalid-oauth-provider', 'auth/invalid-auth-event',
        'auth/cancelled-popup-request', 'auth/popup-blocked', 'auth/popup-closed-by-user',
        'auth/redirect-cancelled-by-user', 'auth/redirect-operation-pending', 'auth/timeout',
        'auth/internal-error', 'auth/too-many-requests', 'auth/user-disabled', 'auth/argument-error'];
    const names = ['FirebaseError', 'Error', 'TypeError', 'SecurityError', 'QuotaExceededError',
        'InvalidStateError', 'NotSupportedError', 'AbortError', 'NetworkError', 'DOMException'];
    let code = 'unknown', name = 'unknown';
    try {
        const candidateCode = error?.code, candidateName = error?.name;
        if (codes.includes(candidateCode)) code = candidateCode;
        if (names.includes(candidateName)) name = candidateName;
    } catch (_) { /* 오류 분류 실패가 기존 로그인 실패 처리를 막지 않는다. */ }
    try {
        console.warn(`[Firebase Auth] stage=${stage} code=${code} name=${name}`);
    } catch (_) { /* 콘솔을 사용할 수 없어도 사용자 안내와 버튼 복원을 유지한다. */ }
}

async function getServiceRegistrationStatus(user, revision) {
    const trace = window.YgoLoginTiming?.recovery?.('registration');
    const measure = (name, work) => trace ? trace.measure(name, work) : work();
    try {
        for (let attempt = 0; attempt < 3; attempt++) {
            if (revision !== authStateRevision || firebase.auth().currentUser?.uid !== user.uid) {
                trace?.finish('superseded'); return null;
            }
            try {
                const result = await measure('registration_attempt', () => callApi('getRegistrationStatus', { includeUserData: 'true' }));
                if (revision !== authStateRevision || firebase.auth().currentUser?.uid !== user.uid) {
                    trace?.finish('superseded'); return null;
                }
                trace?.finish('ready'); return result;
            } catch (error) {
                if (error.retryable === false || error.code === 'APPCHECK_CONFIGURATION_REJECTED' || error.code === 'AUTH_INVALID' || attempt === 2
                    || (error.status && error.status !== 401 && error.status < 500)) throw error;
                if (['APPCHECK_REQUIRED', 'APPCHECK_INVALID', 'APPCHECK_UNAVAILABLE'].includes(error.code)) {
                    await measure('app_check_refresh', () => awaitApiPreparation(getApiAppCheckToken(true), AbortSignal.timeout(30000))).catch(error => {
                        if (error.retryable === false) throw error;
                    });
                }
                await measure('retry_delay', () => new Promise(resolve => setTimeout(resolve, attempt === 0 ? 500 : 1500)));
            }
        }
    } catch (error) { trace?.finish('failed', error); throw error; }
}

async function handleFirebaseAuthState(user) {
    const revision = ++authStateRevision;
    window.YgoDiscordPopup?.cancelActive?.();
    discordMembershipStartPreparation = null;
    serviceLoginFailureCode = null;
    pendingRegistrationUser = null;
    pendingConsentVersions = null;
    pendingServiceAuthUser = null;
    registrationCheckPending = !!user;
    if (user) setServiceLoginPending(true);
    toggleLoginBtn();
    if (!user) {
        // 진행 중인 인증 팝업에 앞서 도착한 초기 비로그인 알림은 종료 결과가 아니다.
        if (!loginInProgress) window.YgoLoginTiming?.current()?.finish('signed_out');
        if (!loginInProgress && serviceLoginPending) setServiceLoginPending(false);
        applyServiceAuthState(null);
        M.Modal.getInstance(document.getElementById('signup-modal'))?.close();
        return;
    }
    const loginTiming = window.YgoLoginTiming?.start();
    // 다른 계정의 조회·보유 정보가 새 계정에 노출되지 않도록 먼저 분리한다.
    applyServiceAuthState(null);
    try {
        const status = await (loginTiming ? loginTiming.measure('registration_gate', () => getServiceRegistrationStatus(user, revision)) : getServiceRegistrationStatus(user, revision));
        if (revision !== authStateRevision || firebase.auth().currentUser?.uid !== user.uid) return;
        if (!status?.success || typeof status.registered !== 'boolean') throw new Error('가입 상태 조회 실패');
        const waitForUi = () => window.YgoAuthBootstrap?.whenUiReady() || serviceUiReady;
        await (loginTiming ? loginTiming.measure('ui_ready_wait', waitForUi) : waitForUi());
        if (revision !== authStateRevision || firebase.auth().currentUser?.uid !== user.uid) return;
        setServiceLoginPending(false);
        M.Modal.getInstance(document.getElementById('auth-modal'))?.close();
        if (status.registered) {
            if (status.initialAccount && status.initialAccount.success !== true) throw new Error('계정 정보 조회 실패');
            applyServiceAuthState(user, status.initialData, status.initialAccount);
        } else {
            loginTiming?.finish('signup_required');
            applyServiceAuthState(null);
            openServiceRegistration(user, status.consentVersions);
        }
    } catch (error) {
        if (revision !== authStateRevision || firebase.auth().currentUser?.uid !== user.uid) return;
        loginTiming?.finish('failed');
        setServiceLoginPending(false);
        applyServiceAuthState(null);
        if (error.code === 'AUTH_INVALID') {
            showToast('로그인 정보가 만료되었거나 유효하지 않습니다. 다시 로그인해 주세요.', 'toast-error');
            await firebase.auth().signOut().catch(() => {
                showToast('로그아웃하지 못했습니다. 다시 시도해 주세요.', 'toast-error');
            });
        } else {
            pendingServiceAuthUser = user;
            serviceLoginFailureCode = error.reason === 'throttled' ? 'APPCHECK_THROTTLED'
                : ['APPCHECK_CONFIGURATION_REJECTED', 'APPCHECK_UNAVAILABLE', 'SERVICE_CHECK_TIMEOUT'].includes(error.code) ? error.code : null;
            toggleAuthModal(true);
        }
    } finally {
        if (revision === authStateRevision) {
            registrationCheckPending = false;
            toggleLoginBtn();
        }
    }
}

function openServiceRegistration(user, versions) {
    pendingRegistrationUser = user;
    pendingConsentVersions = versions;
    document.getElementById('terms-agree-cb').checked = false;
    document.getElementById('privacy-agree-cb').checked = false;
    const message = document.getElementById('signup-status');
    message.textContent = '';
    message.hidden = true;
    setRegistrationSaving(false);
    getAppModal(document.getElementById('signup-modal')).open();
}

function clearServiceRegistration() {
    ++authStateRevision;
    if (!pendingRegistrationUser) return;
    pendingRegistrationUser = null;
    pendingConsentVersions = null;
    setRegistrationSaving(false);
    M.Modal.getInstance(document.getElementById('signup-modal'))?.close();
}

function toggleRegistrationButton() {
    const button = document.getElementById('signup-complete-btn');
    if (button) button.disabled = registrationSaving || !pendingRegistrationUser
        || !document.getElementById('terms-agree-cb')?.checked
        || !document.getElementById('privacy-agree-cb')?.checked;
}

function setRegistrationSaving(saving) {
    registrationSaving = saving;
    const modal = document.getElementById('signup-modal');
    modal.setAttribute('aria-busy', String(saving));
    modal.querySelectorAll('[data-signup-cancel], input').forEach(control => { control.disabled = saving; });
    const instance = M.Modal.getInstance(modal);
    if (instance) instance.options.dismissible = !saving;
    document.getElementById('signup-complete-btn').textContent = saving ? '가입 처리 중…' : '동의하고 가입';
    toggleRegistrationButton();
}

async function completeServiceRegistration() {
    if (registrationSaving || !pendingRegistrationUser || document.getElementById('signup-complete-btn').disabled) return;
    const user = pendingRegistrationUser;
    const revision = authStateRevision;
    const message = document.getElementById('signup-status');
    setRegistrationSaving(true);
    message.textContent = '서비스 가입을 처리하고 있습니다.';
    message.hidden = false;
    try {
        const result = await callApi('completeRegistration', {}, {
            agreements: { terms: true, privacy: true }, consentVersions: pendingConsentVersions,
        });
        if (revision !== authStateRevision || firebase.auth().currentUser?.uid !== user.uid) return;
        if (!result?.success || result.registered !== true) throw new Error('가입 완료 실패');
        const finishRegistration = globalThis.AppBackend?.finishRegistration;
        if (finishRegistration) await finishRegistration(user);
        if (revision !== authStateRevision || firebase.auth().currentUser?.uid !== user.uid) return;
        pendingRegistrationUser = null;
        pendingConsentVersions = null;
        setRegistrationSaving(false);
        M.Modal.getInstance(document.getElementById('signup-modal'))?.close();
        if (!finishRegistration) applyServiceAuthState(user);
    } catch (error) {
        if (revision !== authStateRevision) return;
        if (error.code === 'CONSENT_VERSION_CHANGED') {
            const status = await callApi('getRegistrationStatus').catch(() => null);
            if (revision !== authStateRevision) return;
            pendingConsentVersions = status?.consentVersions || null;
            document.getElementById('terms-agree-cb').checked = false;
            document.getElementById('privacy-agree-cb').checked = false;
            message.textContent = '문서가 변경되었습니다. 다시 확인하고 동의해 주세요.';
        } else {
            message.textContent = '가입을 완료하지 못했습니다. 다시 시도하거나 취소해 주세요.';
        }
    } finally {
        if (revision === authStateRevision) setRegistrationSaving(false);
    }
}

function cancelServiceRegistration() {
    if (!pendingRegistrationUser || registrationSaving) return;
    pendingRegistrationUser = null;
    pendingConsentVersions = null;
    ++authStateRevision;
    toggleRegistrationButton();
    firebase.auth().signOut().catch(() => {
        showToast('로그아웃하지 못했습니다. 다시 시도해 주세요.', 'toast-error');
    });
}

function initFirebaseAuth() {
    if (globalThis.AppBackend) return globalThis.AppBackend.initAuth();
    if (serviceAuthStarted) return;
    if (typeof firebase === 'undefined' || !firebase.auth) {
        setTimeout(initFirebaseAuth, 200); // SDK 로드 대기
        return;
    }

    serviceAuthStarted = true;
    window.YgoLoginTiming?.mark('service_auth_start');

    // [신규 웜업] 사용자 인증 진행 중 인벤토리 인스턴스를 선제 부팅(Hot-Start)시키기 위한 비동기 핑 — 대기(await)하지 않음
    if (typeof callApi === 'function') {
        callApi('getUserData', { warmup: 'true' }).catch(() => {});
    }

    // 리다이렉트 로그인 시 타사 쿠키 차단(세션 끊김)을 막기 위해 authDomain을 동적 변경 (로컬 환경 제외)
    if (firebase.app && firebase.app().options) {
        if (!IS_LOCAL_DEV) {
            firebase.app().options.authDomain = window.location.hostname;
        }
    }

    // 리다이렉트 로그인 복귀 시 발생하는 예외 처리
    (window.YgoAuthBootstrap?.redirect || firebase.auth().getRedirectResult()).catch(function (error) {
        reportAuthFailure('redirect-result', error);
        if (!registrationCheckPending && serviceLoginPending) setServiceLoginPending(false);
        showToast('로그인하지 못했습니다. 다시 시도해 주세요.', 'toast-error');
    });

    // Safari 최적화: Auth 토큰을 변수에 사전 저장 — 로그인/갱신/로그아웃 시 자동 업데이트
    // onIdTokenChanged는 최초 로그인, 1시간마다 자동 갱신, 로그아웃 시 모두 호출됨
    firebase.auth().onIdTokenChanged(async (user) => {
        if (user) {
            try {
                _cachedAuthToken = await user.getIdToken();
            } catch (e) {
                _cachedAuthToken = null;
            }
        } else {
            _cachedAuthToken = null;
        }
    });

    firebase.auth().onAuthStateChanged(function (user) {
        handleFirebaseAuthState(user);
    });
}

function applyServiceAuthState(user, initialData, initialAccount) {
    window.isAuthInitialized = true;
    const previousOwner = UserStore.user?.uid || null;
    UserStore.user = user;
    if (typeof OnboardingManager !== 'undefined') OnboardingManager.authChanged();
    loadUserTheme(undefined, true);
    if (previousOwner !== (user?.uid || null)) {
        userDataSyncSerial++;
        userDataSyncTask = null;
        UserStore.accountRevision++;
        UserStore.isUserDataSyncDone = false;
        UserStore.inventorySyncStatus = 'idle';
        UserStore.claimsSyncStatus = 'idle';
        globalThis.YgoMembershipClaimsSync?.cancel();
        cardCacheInstance.clearAll();
        clearTimeout(inventoryMigrationTimer);
        delete UserStore.settings.membership;
        UserStore.sourceMembership = null;
        UserStore.settings.hideMembershipVerify = false;
        document.querySelectorAll('.target-inventory-section').forEach(section => renderOwnedCardsToContainer([], section));
    }
    const homeUnauthContent = document.getElementById('home-unauth-content');
    const homeAuthContent = document.getElementById('home-auth-content');

    if (user) {
        // 비활동 자동 로그아웃 감지 시작 (30분)
        if (AutoLogoutManager.start() === false) return;

        if (homeUnauthContent) homeUnauthContent.hidden = true;
        if (homeAuthContent) homeAuthContent.hidden = false;

        if (initialAccount) applyAccountData(initialAccount);
        // 구버전 서버의 본문 없음/통합 본문은 종전 로딩 경로로 호환한다.
        const splitSync = !!initialAccount;
        loadUserData(initialData, { background: splitSync });

        // 로그인 성공 시 로그인 모달/바텀시트 자동으로 닫기
        const modalId = 'auth-modal';
        const modalElem = document.getElementById(modalId);
        if (modalElem) {
            const instance = M.Modal.getInstance(modalElem);
            if (instance) instance.close();
        }
    } else {
        // 비활동 자동 로그아웃 감지 중단
        AutoLogoutManager.stop();

        if (homeUnauthContent) homeUnauthContent.hidden = false;
        if (homeAuthContent) homeAuthContent.hidden = true;

        // [추가] Guest 사용자는 추가 동기화 대기 없음
        UserStore.isUserDataSyncDone = true;
        setInventorySyncStatus('idle');
        checkAndHideInitialLoading();

        updateProviderUI('google', false, 0);
        updateProviderUI('twitter', false, 0);

        // [추가] 비로그인 상태로 전환 시 보유 현황 목록 모드에 있다면 로그인 유도 UI로 즉시 갱신
        if (typeof UIStore.mode !== 'undefined' && UIStore.mode === 'inventory' &&
            typeof UIStore.inventoryMode !== 'undefined' && UIStore.inventoryMode === 'list') {
            renderInventoryGrid();
        }
    }

    // 헤더 및 연동 정보 렌더링 호출 (user가 null이어도 호출하여 UI 초기화)
    renderLinkedAccounts(user);

    // 인증 초기화 완료 후 통합 로딩 종료 체크
    checkAndHideInitialLoading();
}

let currentNoticeIndex = -1; // 데스크톱·모바일에서 선택한 공지 인덱스

function openNoticeModal(targetId) {
    const trigger = document.getElementById('noti-btn');
    closeNotiPopup();
    const index = Math.max(0, notices.findIndex(n => n.id === targetId));
    if (document.documentElement.classList.contains('is-mobile-device')) {
        if (targetId && notices.length) openNoticeDetailMode(index, trigger);
        else openNoticeListMode(trigger);
        return;
    }
    delete document.getElementById('notice-modal').dataset.documentMode;
    document.querySelector('#notice-modal .ui-overlay__header h2').textContent = '공지사항';
    document.getElementById('notice-content-area').hidden = false;
    document.querySelector('#notice-modal [data-notice-navigation]').hidden = false;
    currentNoticeIndex = notices.length ? index : -1;
    if (notices[index]) markNoticeAsRead(notices[index].id);
    renderDocumentNoticeList(document.getElementById('notice-date-list'));
    renderCurrentNotice(document.getElementById('notice-modal'));
    syncDocumentListAccess();
    getAppModal(document.getElementById('notice-modal')).open(trigger ? [trigger] : undefined);
}

function renderDocumentNoticeList(container) {
    container.replaceChildren();
    if (!notices.length) {
        const p = document.createElement('p'); p.className = 'color-text-002'; p.textContent = '공지사항이 없습니다.'; container.append(p); return;
    }
    notices.forEach((noti, index) => {
        const item = document.createElement('button'); item.type = 'button';
        item.className = 'document-view__item ui-button ' + (currentNoticeIndex === index ? 'color-type004' : 'color-type000') + (document.documentElement.classList.contains('is-mobile-device') ? '' : ' shape-rounded002');
        item.setAttribute('aria-current', currentNoticeIndex === index ? 'true' : 'false');
        const date = document.createElement('time'); date.className = 'document-view__date color-text-002'; date.textContent = noti.date;
        const title = document.createElement('span'); title.textContent = noti.title + (isNoticeNew(noti) ? ' · NEW' : '');
        if (noti.isPinned > 0) { const pin = document.createElement('i'); pin.className = 'material-icons color-text-theme'; pin.setAttribute('aria-hidden', 'true'); pin.textContent = 'push_pin'; title.prepend(pin); }
        item.append(date, title);
        item.onclick = () => {
            if (document.documentElement.classList.contains('is-mobile-device')) openNoticeDetailMode(index, item);
            else {
                const panel = document.getElementById('notice-modal');
                delete panel.dataset.documentMode;
                currentNoticeIndex = index; markNoticeAsRead(noti.id);
                renderDocumentNoticeList(container); renderCurrentNotice(panel); syncDocumentListAccess();
                (compactDocument.matches ? panel.querySelector('.ui-overlay__header button') : container.children[index])?.focus({preventScroll:true});
            }
        };
        container.append(item);
    });
}

function renderCurrentNotice(panel) {
    const content = panel.querySelector('.document-view__content'); content.replaceChildren();
    const notice = notices[currentNoticeIndex];
    if (notice) {
        const title = document.createElement('h3'); title.className = 'color-text-000'; title.textContent = notice.title;
        const date = document.createElement('p'); date.className = 'color-text-002'; date.textContent = notice.date;
        const body = document.createElement('div'); body.innerHTML = sanitizeNoticeHtml(notice.content); content.append(title, date, body);
    } else { const p = document.createElement('p'); p.className = 'color-text-002'; p.textContent = '등록된 공지사항이 없습니다.'; content.append(p); }
    content.scrollTop = 0;
    panel.querySelector('[data-notice-position]').textContent = notice ? `${currentNoticeIndex + 1} / ${notices.length}` : '0 / 0';
    for (const [selector, disabled] of [['[data-notice-prev]', currentNoticeIndex <= 0], ['[data-notice-next]', currentNoticeIndex < 0 || currentNoticeIndex >= notices.length - 1]]) {
        const button = panel.querySelector(selector); button.disabled = disabled; button.classList.toggle('color-disabled', disabled);
    }
    const more = panel.querySelector('[data-notice-more]'); more.hidden = !notice;

}

const compactDocument = window.matchMedia('(max-width:768px)');
function syncDocumentListAccess() {
    const panel = document.getElementById('notice-modal');
    const list = document.getElementById('notice-date-list');
    const mobile = document.documentElement.classList.contains('is-mobile-device');
    document.querySelectorAll('.document-view__content').forEach(content => content.classList.toggle('shape-rounded-lg', !mobile));
    const overlay = !mobile && compactDocument.matches && panel.dataset.documentMode === 'list';
    const collapsed = !mobile && compactDocument.matches && !overlay;
    const content = panel.querySelector('.document-view__content');
    const footer = panel.querySelector('[data-notice-navigation]');
    if ((collapsed && list.contains(document.activeElement)) || (overlay && (content.contains(document.activeElement) || footer.contains(document.activeElement)))) {
        panel.querySelector('.ui-overlay__header button')?.focus({preventScroll:true});
    }
    list.inert = collapsed;
    if (collapsed) list.setAttribute('aria-hidden', 'true'); else list.removeAttribute('aria-hidden');
    content.inert = overlay; footer.inert = overlay;
    for (const element of [content, footer]) {
        if (overlay) element.setAttribute('aria-hidden', 'true'); else element.removeAttribute('aria-hidden');
    }
    panel.querySelector('.ui-overlay__header h2').textContent = overlay ? '공지 목록' : '공지사항';
}
compactDocument.addEventListener('change', syncDocumentListAccess);
syncDocumentListAccess();

/**
 * 모바일: 공지 목록 모달 열기
 */
function openNoticeListMode(trigger) {
    if (!document.documentElement.classList.contains('is-mobile-device')) {
        const panel = document.getElementById('notice-modal');
        panel.dataset.documentMode = 'list';
        syncDocumentListAccess();
        panel.querySelector('[aria-current="true"]')?.focus({preventScroll:true});
        return;
    }
    const listModal = document.getElementById('notice-list-modal');
    const detailModal = document.getElementById('notice-detail-modal');
    if (!listModal) return;

    const listInstance = getAppModal(listModal);

    const detailInstance = M.Modal.getInstance(detailModal);

    updateMobileNoticeList();

    // 새 시트의 잠금을 먼저 등록한 뒤 이전 본문 시트를 동시에 닫는다.
    listInstance.open(trigger ? [trigger] : undefined);
    if (detailInstance && detailInstance.isOpen) detailInstance.close();
}

function sanitizeNoticeHtml(content) { return AppDocuments.sanitize(content); }

/**
 * 모바일: 개별 공지 상세 모달 열기
 */
function openNoticeDetailMode(index, trigger) {
    if (index < 0 || index >= notices.length) return;
    currentNoticeIndex = index;

    const listModal = document.getElementById('notice-list-modal');
    const detailModal = document.getElementById('notice-detail-modal');
    if (!detailModal) return;

    const detailInstance = getAppModal(detailModal);

    const listInstance = M.Modal.getInstance(listModal);

    const noti = notices[index];

    // 내용 렌더링
    renderCurrentNotice(detailModal);

    modalAfterOpen.set(detailModal, () => {
        if (listInstance && listInstance.isOpen) listInstance.close();
        markNoticeAsRead(noti.id);
    });
    detailInstance.open(trigger ? [trigger] : undefined);
}

/**
 * [보조 Firebase 앱 기반] 메인 Auth 세션과 완전히 분리된 유튜브 OAuth 2.0 accessToken 수집
 * 메인 앱과 동일한 설정을 가진 임시 보조 앱 인스턴스로 구글 팝업을 실행하므로
 * 메인 앱의 로그인 세션에 전혀 영향을 주지 않음
 */
async function getYoutubeAccessTokenViaSecondaryApp() {
    const SECONDARY_APP_NAME = '__yt_verify_temp__';
    let secondaryApp = null;

    try {
        // 기존 앱 설정을 그대로 복사하여 보조 앱 인스턴스 생성
        const mainOptions = firebase.app().options;

        // 이미 존재하면 재사용, 없으면 새로 생성
        try {
            secondaryApp = firebase.app(SECONDARY_APP_NAME);
        } catch (e) {
            secondaryApp = firebase.initializeApp(mainOptions, SECONDARY_APP_NAME);
        }

        const secondaryAuth = firebase.auth(secondaryApp);

        // 보조 앱에서 구글 팝업 실행 (youtube.readonly scope + 계정 선택창 강제 표시)
        const provider = new firebase.auth.GoogleAuthProvider();
        provider.addScope('https://www.googleapis.com/auth/youtube.readonly');
        provider.setCustomParameters({ prompt: 'select_account' });

        const result = await secondaryAuth.signInWithPopup(provider);
        const accessToken = result?.credential?.accessToken;

        // 보조 앱 세션 즉시 초기화 (토큰 수집 후 보조 앱 로그아웃)
        await secondaryAuth.signOut();

        return accessToken;
    } finally {
        // 보조 앱 인스턴스 삭제 (메모리 정리)
        if (secondaryApp) {
            try { await secondaryApp.delete(); } catch (e) { /* 무시 */ }
        }
    }
}

let youtubeMembershipVerificationPending = false;
// 준비 응답은 권한 증명이 아니다. 같은 계정/revision의 짧은 연결 준비만 공유한다.
const membershipPreparationTasks = new Map();
function beginMembershipPreparation(provider) {
    const targets = provider === 'youtube'
        ? ['startYoutubeMembershipVerification', 'verifyYoutubeMembership', 'getUserData']
        : ['verifyDiscordMembership', 'getUserData'];
    const revision = authStateRevision, uid = UserStore.user?.uid;
    const current = () => uid && authStateRevision === revision && UserStore.user?.uid === uid
        && firebase.auth().currentUser?.uid === uid;
    const clock = () => globalThis.performance?.now?.() ?? Date.now();
    const pending = new Map();
    for (const name of targets) {
        const previous = membershipPreparationTasks.get(name);
        if (current() && previous?.uid === uid && previous.revision === revision
            && !previous.failed && clock() < previous.deadline) {
            pending.set(name, previous.promise);
            continue;
        }
        if (!current()) { pending.set(name, Promise.resolve(false)); continue; }
        const prepared = { uid, revision, deadline: clock() + 60000, failed: false };
        prepared.promise = Promise.resolve().then(() => current()
            ? callApi(name, { warmup: 'true' }, { warmup: 'true', membershipPrepare: true }) : null)
            .then(result => {
                const ready = current() && result?.success === true && result.membershipPreparation?.version === 1
                    && result.membershipPreparation?.target === name && result.membershipPreparation?.ready === true;
                prepared.failed = !ready;
                return !!ready;
            }, () => { prepared.failed = true; return false; });
        membershipPreparationTasks.set(name, prepared);
        pending.set(name, prepared.promise);
    }
    return { wait: name => pending.get(name) || Promise.resolve(false) };
}

// 계정/설정 진입 시만 시작한다. 반복 타이머·권한 결과 캐시·자동 OAuth는 사용하지 않는다.
let membershipWorkerPreparationTask;
function beginMembershipWorkerPreparation() {
    const uid = UserStore.user?.uid, revision = authStateRevision;
    if (!uid || firebase.auth().currentUser?.uid !== uid) return;
    const now = globalThis.performance?.now?.() ?? Date.now();
    if (membershipWorkerPreparationTask?.uid === uid && membershipWorkerPreparationTask.revision === revision
        && now < membershipWorkerPreparationTask.deadline) return;
    // 성공/실패 모두 짧게 제한한다. 업무에서 기다리거나 권한 근거로 사용하지 않는다.
    membershipWorkerPreparationTask = { uid, revision, deadline: now + 60000 };
    Promise.resolve().then(() => UserStore.user?.uid === uid && authStateRevision === revision
        && firebase.auth().currentUser?.uid === uid
        ? callApi('getUserData', { warmup: 'true' },
            { warmup: 'true', membershipPrepare: true, workerPrepare: true }) : null).catch(() => {});
}
function prepareMembershipEntry() {
    if (!UserStore.user || UserStore.inventorySyncStatus !== 'ready'
        || typeof discordMembershipStarting !== 'undefined' && discordMembershipStarting
        || youtubeMembershipVerificationPending
        || typeof discordMembershipHeaderState !== 'undefined' && discordMembershipHeaderState?.phase === 'pending') return;
    if (globalThis.AppBackend?.prepareMembershipEntry) return globalThis.AppBackend.prepareMembershipEntry();
    beginMembershipPreparation('youtube');
    beginMembershipPreparation('discord');
    beginMembershipWorkerPreparation();
    prepareDiscordMembershipStart();
}

async function startYoutubeMembershipVerify() {
    if (globalThis.AppBackend && !globalThis.AppBackend.membershipEnabled('youtube')) return globalThis.AppBackend.notifyUnavailable();
    if (!requireInventoryReady()) return;
    const user = UserStore.user;
    if (!user) {
        showToast('로그인이 필요합니다.', 'toast-warn');
        return;
    }
    if (youtubeMembershipVerificationPending
        || typeof discordMembershipStarting !== 'undefined' && discordMembershipStarting
        || typeof discordMembershipHeaderState !== 'undefined' && discordMembershipHeaderState?.phase === 'pending') return;
    youtubeMembershipVerificationPending = true;
    let headerCompleted = false;
    setDiscordMembershipHeader('pending', user.uid);
    const revision = authStateRevision;
    const current = () => authStateRevision === revision && UserStore.user?.uid === user.uid
        && firebase.auth().currentUser?.uid === user.uid;
    try {
        // 팝업은 클릭 직후 실행한다. 시작 요청을 먼저 기다리면 Safari에서 차단될 수 있다.
        const popup = getYoutubeAccessTokenViaSecondaryApp();
        const challengeRequest = callApi('startYoutubeMembershipVerification', {}, {});
        const preparation = globalThis.AppBackend ? null : beginMembershipPreparation('youtube');
        const [accessToken, challenge] = await Promise.all([popup, challengeRequest]);
        if (!current()) throw Object.assign(new Error(), { code: 'YOUTUBE_SESSION_CHANGED' });
        if (!accessToken || !challenge?.success || challenge.uid !== user.uid || !challenge.verificationId) {
            throw Object.assign(new Error(), { code: 'YOUTUBE_PROOF_REQUIRED' });
        }
        if (!current()) throw Object.assign(new Error(), { code: 'YOUTUBE_SESSION_CHANGED' });
        const res = await callApi('verifyYoutubeMembership', {}, { verificationId: challenge.verificationId, accessToken });
        if (!current()) throw Object.assign(new Error(), { code: 'YOUTUBE_SESSION_CHANGED' });
        if (!res?.success || res.uid !== user.uid) {
            showToast(res?.message || '멤버십을 확인하지 못했습니다. 다시 인증해 주세요.', 'toast-error');
            return;
        }
        const providerActive = res.sourceMembership?.status === 'active';
        if (!providerActive) showToast('유튜브 채널이 멤버십 회원 목록에 등록되어 있지 않습니다.', 'toast-warn');
        if (!UserStore.settings) UserStore.settings = {};
        UserStore.sourceMembership = res.sourceMembership || null;
        UserStore.settings.membership = res.membership;
        applyMembershipStatus(res.membership);
        const modalInstance = M.Modal.getInstance(document.getElementById('membership-auth-modal'));
        if (modalInstance) modalInstance.close();
        resetMembershipVerifyModal();
        setDiscordMembershipHeader('complete', user.uid);
        headerCompleted = true;
        globalThis.YgoAuthenticationResult?.displayed?.('youtube');
        let claimsReady = false;
        if (res.membershipClaims) {
            claimsReady = await refreshMembershipClaims(user, res);
            if (!current()) return;
        }
        if (UserStore.inventorySyncStatus === 'ready') {
            // 같은 계정의 준비된 보유 정보는 인증 결과로 무효화되지 않는다.
            if (res.membershipClaims) {
                UserStore.claimsSyncStatus = claimsReady ? 'ready' : 'pending';
                followMembershipClaims(user);
                setInventorySyncStatus('ready');
            }
        } else {
            if (preparation) await preparation.wait('getUserData');
            if (!current()) throw Object.assign(new Error(), { code: 'YOUTUBE_SESSION_CHANGED' });
            // 인벤토리가 없거나 실패/로딩 상태면 기존 전체 동기화와 화면 가림을 유지한다.
            if (typeof loadUserData === 'function'
                && await loadUserData(undefined, { membershipClaimsReadOnly: true }) === false) return;
        }
        if (!current()) throw Object.assign(new Error(), { code: 'YOUTUBE_SESSION_CHANGED' });
    } catch (error) {
        const cancelled = ['auth/popup-closed-by-user', 'auth/cancelled-popup-request', 'auth/user-cancelled', 'auth/access-denied'].includes(error.code);
        if (!cancelled) showToast(error.code === 'YOUTUBE_SESSION_CHANGED'
            ? '서비스 계정이 변경되었습니다. 다시 인증해 주세요.'
            : '유튜브 인증을 완료하지 못했습니다. 계정과 승인한 권한을 확인하고 다시 시도해 주세요.', 'toast-error');
    } finally {
        youtubeMembershipVerificationPending = false;
        if (!headerCompleted) setDiscordMembershipHeader('idle');
    }
}

/**
 * [유틸리티] 공통 모달 옵션 반환
 */
function getCommonModalOptions() {
    const isMobile = document.documentElement.classList.contains('is-mobile-device');
    return {
        dismissible: true,
        opacity: 0.4,
        startingTop: '10%',
        endingTop: '10%',
        inDuration: isMobile ? 350 : 300,
        outDuration: isMobile ? 250 : 200,
        onOpenStart: function (el, trigger) {
            if (el.classList.contains('ui-overlay')) {
                this.options.inDuration = this.options.outDuration = globalThis.AppOverlays?.duration() ?? 200;
            }
            beginModalLifecycle(el, trigger, this.$overlay?.[0]);
        },
        onOpenEnd: function (el) {
            if (!this.isOpen) return;
            if (isMobile) el.style.top = '';
            const afterOpen = modalAfterOpen.get(el);
            modalAfterOpen.delete(el);
            if (afterOpen) afterOpen();
        },
        onCloseStart: function (el) {
            beginModalClose(el);
            if (el.id === 'signup-modal') cancelServiceRegistration();
            if (el.id === 'migration-modal') resetDataTransferValidation();
        },
        onCloseEnd: function (el) {
            if (this.isOpen || !modalStates.get(el)?.closing) return;
            try {
                // 기능별 후처리는 공통 잠금/초점 처리와 분리해 기존 시점에 실행한다.
                if (el.id === 'terms-modal' || el.id === 'privacy-modal') {
                    const currentHash = window.location.hash;
                    if (currentHash === '#terms' || currentHash === '#privacy') {
                        const targetHash = UIStore.lastHashBeforeModal || '';
                        window.history.pushState(null, null, window.location.pathname + window.location.search + targetHash);
                        UIStore.lastHashBeforeModal = '';
                    }
                }
                if (el.id === 'membership-auth-modal') resetMembershipVerifyModal();
                if (el.id === 'add-result-modal') handleContinueRegistration();
                if (el.id === 'move-result-modal') finishMoveProcess();
                if (el.id === 'discard-result-modal') handleContinueDiscard();
                if (el.id === 'legacy-migration-modal') {
                    sessionStorage.removeItem('ygo_redirect_legacy');
                    const cleanUrl = window.location.protocol + '//' + window.location.host + window.location.pathname + window.location.hash;
                    window.history.replaceState({ path: cleanUrl }, '', cleanUrl);
                }
            } finally {
                // 성공 행 정리 후에도 존재하는 대상으로 초점을 복귀한다.
                finishModalLifecycle(el);
            }
        }
    };
}

/**
 * 모바일: 공지 목록 렌더링
 */
function updateMobileNoticeList() {
    renderDocumentNoticeList(document.getElementById('mobile-notice-list-container'));
}

function navigateNotice(direction) {
    const index = currentNoticeIndex + direction;
    if (index < 0 || index >= notices.length) return;
    currentNoticeIndex = index;
    markNoticeAsRead(notices[index].id);
    const mobile = document.documentElement.classList.contains('is-mobile-device');
    renderCurrentNotice(document.getElementById(mobile ? 'notice-detail-modal' : 'notice-modal'));
    if (!mobile) renderDocumentNoticeList(document.getElementById('notice-date-list'));
}

function renderLinkedAccounts(user) {
    // 상단 헤더 캡슐 버튼 업데이트
    const authTextElem = document.getElementById('auth-btn-text');
    const authCapsuleElem = document.getElementById('auth-capsule-btn');
    const authIconElem = authCapsuleElem ? authCapsuleElem.querySelector('.auth-icon') : null;

    if (authTextElem && authCapsuleElem) {
        if (user) {
            authTextElem.textContent = '내 계정';
            authCapsuleElem.setAttribute('aria-label', '내 계정: 환경설정으로 이동');
            authCapsuleElem.classList.add('is-logged-in');

            // 멤버십 확인 버튼 표시 제어 (프리미엄이 아니고, 숨기기 설정이 false일 때만 표시)
            const mem = UserStore.settings && UserStore.settings.membership;
            const isPremium = document.body.classList.contains('is-premium') || (mem && mem.status === 'active');
            const isHidden = UserStore.settings.hideMembershipVerify === true;
            const shouldShowVerify = !isPremium && !isHidden;

            syncMembershipHeader(shouldShowVerify);

            // 멤버십 여부에 따른 아이콘 변경
            if (isPremium) {
                if (authIconElem) authIconElem.textContent = 'diamond';
            } else {
                if (authIconElem) authIconElem.textContent = 'account_circle';
            }
        } else {
            authTextElem.textContent = '로그인';
            authCapsuleElem.setAttribute('aria-label', '로그인');
            authCapsuleElem.classList.remove('is-logged-in');
            authCapsuleElem.classList.remove('has-noti'); // 비로그인 시 알림 제거
            if (authIconElem) authIconElem.textContent = 'account_circle';

            // 멤버십 확인 버튼 숨김
            syncMembershipHeader(false);
        }
    }

    if (typeof renderDiscordMembershipHeader === 'function') renderDiscordMembershipHeader();

    // 환경설정 페이지 계정 카드 표시 제어
    const infoCard = getAccountCardElement();
    if (infoCard) {
        infoCard.hidden = !user;
        // 실제 데이터 렌더링은 loadUserData 직후에 수행한다.
        if (!user) {
            getAccountCardElement('nickname-display').hidden = false;
            getAccountCardElement('nickname-edit').hidden = true;
            getAccountCardElement('nickname').textContent = '게스트';
            getAccountCardElement('joined').textContent = '가입일: -';
            getAccountCardElement('nickname-input').value = '';
            renderMembershipSettings(null);
        }
    }

    if (!user) return;

    const activeProviders = user.providerData.map(p => p.providerId);

    // 환경 설정 페이지 UI 업데이트 (동기화)
    const isGoogleLinked = activeProviders.includes('google.com');
    const isTwitterLinked = activeProviders.includes('twitter.com');
    const totalLinked = activeProviders.length;

    updateProviderUI('google', isGoogleLinked, totalLinked);
    updateProviderUI('twitter', isTwitterLinked, totalLinked);
}

/**
 * 환경설정 상단 계정 정보 카드 실시간 렌더링
 */
function updateUserInfoCard(user, userData) {
    if (!user) return;

    const infoCard = getAccountCardElement();
    const nicknameElem = getAccountCardElement('nickname');
    const joinedElem = getAccountCardElement('joined');

    if (!infoCard) return;

    renderMembershipSettings(UserStore.settings?.membership);

    // 닉네임 우선순위: Nickname 필드 > 사용자 UID (계획에 따른 닉네임 기본값)
    const nickname = userData.Nickname || user.uid;
    if (nicknameElem) nicknameElem.textContent = nickname;

    // 가입일 표시
    if (joinedElem) joinedElem.textContent = '가입일: -';
    if (joinedElem && userData.createdAt) {
        const date = userData.createdAt.toDate ? userData.createdAt.toDate() : new Date(userData.createdAt);
        if (Number.isNaN(date.getTime())) return;
        const yyyy = date.getFullYear();
        const mm = String(date.getMonth() + 1).padStart(2, '0');
        const dd = String(date.getDate()).padStart(2, '0');
        const hh = String(date.getHours()).padStart(2, '0');
        const mi = String(date.getMinutes()).padStart(2, '0');
        joinedElem.textContent = `가입일: ${yyyy}-${mm}-${dd} ${hh}:${mi}`;
    }
}

/**
 * 닉네임 인라인 편집 전환 및 포커스 관리
 */
function toggleNicknameEdit(isEdit) {
    if (!UserStore.user) return;

    const displayWrapper = getAccountCardElement('nickname-display');
    const editWrapper = getAccountCardElement('nickname-edit');
    const editInput = getAccountCardElement('nickname-input');
    const nickname = getAccountCardElement('nickname');
    if (!displayWrapper || !editWrapper || !editInput || !nickname) return;
    const currentName = nickname.textContent;

    displayWrapper.hidden = isEdit;
    editWrapper.hidden = !isEdit;
    if (isEdit) {
        editInput.value = ''; // 입력창 비움
        editInput.placeholder = currentName; // 기존 닉네임을 플레이스홀더로
        editInput.focus();
    } else {
        getAccountCardElement('nickname-edit-button')?.focus();
    }
}

/**
 * 닉네임 수정 확인
 */
function confirmNicknameEdit() {
    const editInput = getAccountCardElement('nickname-input');
    const nickname = getAccountCardElement('nickname');
    if (!UserStore.user || !editInput || !nickname) return;
    const newName = editInput.value.trim();
    const currentName = nickname.textContent;

    if (newName === "" || newName === currentName) {
        toggleNicknameEdit(false); // 변경 없으면 그냥 닫기
        return;
    }

    updateNickname(newName);
}

/**
 * 닉네임 DB 업데이트
 */
async function updateNickname(newNickname) {
    if (!UserStore.user) return;
    UserStore.accountRevision++;
    
    try {
        // Firestore 직접 조작 대신 신설된 updateNickname API 엔드포인트 호출
        const res = await callApi('updateNickname', {}, { nickname: newNickname });
        
        if (res && res.success) {
            showToast('닉네임이 성공적으로 변경되었습니다.', 'toast-main');
            toggleNicknameEdit(false);
            loadUserData(undefined, { background: true, force: true });
        } else {
            showToast(res?.message || '닉네임 변경에 실패했습니다.', 'toast-alert');
        }
    } catch (e) {
        console.error("[Settings] Nickname update error:", e);
        showToast('닉네임 변경에 실패했습니다.', 'toast-alert');
    }
}

function updateProviderUI(providerKey, isLinked, totalLinked) {
    const containerElem = document.getElementById(`${providerKey}-link-container`);
    const btnElem = document.getElementById(`${providerKey}-link-btn`);
    if (!containerElem || !btnElem) return;

    if (isLinked) {
        containerElem.classList.remove('is-unlinked');
        containerElem.classList.add('is-linked');
        btnElem.textContent = '연결 끊기';
        btnElem.classList.add('red', 'darken-1');
        // 1개만 연결되어 있으면 끊기 비활성화
        if (totalLinked <= 1) {
            btnElem.classList.add('disabled');
        } else {
            btnElem.classList.remove('disabled');
        }
    } else {
        containerElem.classList.remove('is-linked');
        containerElem.classList.add('is-unlinked');
        btnElem.textContent = '연결';
        btnElem.classList.remove('red', 'darken-1');
        btnElem.classList.remove('disabled');
    }
}

function getProviderInstance(providerName) {
    if (providerName === 'google') {
        return new firebase.auth.GoogleAuthProvider();
    }
    if (providerName === 'twitter') return new firebase.auth.TwitterAuthProvider();
    return null;
}

function toggleAuthModal(showGuide = false) {
    if (UserStore.user) {
        switchToMode('settings');
        return;
    }
    const modalElem = document.getElementById('auth-modal');
    if (!modalElem) return;

    const guide = document.getElementById('login-guide-msg');
    const introduction = document.getElementById('login-sub-msg');
    const failed = !!pendingServiceAuthUser || !!serviceLoginFailureCode;
    if (guide) {
        const messages = {
            APPCHECK_CONFIGURATION_REJECTED: IS_LOCAL_DEV
                ? '로컬 앱 인증 설정이 거부되었습니다. 현재 브라우저의 디버그 토큰 등록을 확인해 주세요.'
                : '앱 인증 설정을 확인하지 못했습니다. 관리자에게 문의해 주세요.',
            APPCHECK_THROTTLED: '앱 인증 요청이 제한되었습니다. 시간을 두고 다시 시도해 주세요. 계속되면 관리자에게 문의해 주세요.',
            APPCHECK_UNAVAILABLE: '앱 인증을 준비하지 못했습니다. 연결 상태를 확인한 뒤 다시 시도해 주세요.',
            SERVICE_CHECK_TIMEOUT: '서비스 연결 확인 시간이 초과됐습니다. 다시 시도해 주세요.',
            AUTH_PREPARATION_FAILED: '로그인 도구를 준비하지 못했습니다. 연결 상태를 확인한 뒤 로그인 방법을 다시 선택해 주세요.',
            AUTH_INVALID: '로그인 정보가 만료되었거나 유효하지 않습니다. 다시 로그인해 주세요.',
            PROVIDER_SIGN_IN_FAILED: '인증을 완료하지 못했습니다. 로그인 방법을 다시 선택해 주세요.',
            SERVICE_CONNECTION_FAILED: '서비스 계정을 연결하지 못했습니다. 다시 시도해 주세요.',
        };
        guide.hidden = !showGuide && !failed;
        guide.textContent = messages[serviceLoginFailureCode] || (pendingServiceAuthUser
            ? '로그인을 완료하지 못했습니다. 다시 시도해 주세요.' : '로그인 후 이용 가능합니다.');
    }
    if (introduction) introduction.hidden = showGuide || failed;
    if (pendingRegistrationUser) {
        getAppModal(document.getElementById('signup-modal')).open();
        return;
    }
    toggleLoginBtn();
    getAppModal(modalElem).open();
    if (!failed) globalThis.AppBackend?.prepareSignIn?.();
}

function toggleLoginBtn() {
    const retryAvailable = !!pendingServiceAuthUser && pendingServiceAuthUser.uid === firebase.auth().currentUser?.uid;
    for (const id of ['google-login-btn', 'twitter-login-btn']) {
        const button = document.getElementById(id);
        if (button) {
            button.disabled = loginInProgress || registrationCheckPending;
            button.hidden = retryAvailable;
        }
    }
    const retry = document.getElementById('service-login-retry-btn');
    if (retry) {
        retry.hidden = !retryAvailable;
        retry.disabled = loginInProgress || registrationCheckPending || !retryAvailable;
    }
}

async function retryServiceLoginConfirmation() {
    if (globalThis.AppBackend) return globalThis.AppBackend.retrySignIn();
    if (loginInProgress || registrationCheckPending || typeof firebase === 'undefined' || !firebase.auth) return;
    const current = firebase.auth().currentUser;
    if (!current || pendingServiceAuthUser?.uid !== current.uid) {
        toggleAuthModal();
        return;
    }
    loginInProgress = true;
    try { await handleFirebaseAuthState(current); }
    finally {
        loginInProgress = false;
        toggleLoginBtn();
    }
}

function getServiceSignInMode(providerName) {
    if (IS_LOCAL_DEV) return 'popup';
    const nav = typeof navigator === 'undefined' ? {} : navigator;
    const ua = nav.userAgent || '';
    const mobile = nav.userAgentData?.mobile === true
        || /Android|iPhone|iPad|iPod|Mobile|IEMobile|Opera Mini/i.test(ua)
        || (/Macintosh/i.test(ua) && nav.maxTouchPoints > 1);
    return providerName === 'google' && !mobile ? 'popup' : 'redirect';
}

async function signInWithProvider(providerName) {
    if (globalThis.AppBackend) return globalThis.AppBackend.signIn(providerName);
    if (pendingServiceAuthUser) return retryServiceLoginConfirmation();
    const btn = document.getElementById(providerName === 'google' ? 'google-login-btn' : 'twitter-login-btn');
    if (!btn || btn.disabled || typeof firebase === 'undefined' || !firebase.auth) return;
    const provider = getProviderInstance(providerName);
    if (!provider) return;
    loginInProgress = true;
    setServiceLoginPending(true);
    toggleLoginBtn();
    let mode = getServiceSignInMode(providerName);
    try {
        window.YgoLoginTiming?.provider(mode);
        if (mode === 'popup') {
            const popupTiming = providerName === 'google' ? window.YgoLoginTiming?.beginPopup?.() : undefined;
            try {
                // 사용자 클릭의 활성 상태를 유지하도록 팝업 앞에서 비동기 준비를 기다리지 않는다.
                const popupPromise = firebase.auth().signInWithPopup(provider);
                popupTiming?.returned();
                await popupPromise;
                popupTiming?.settled(true);
            } catch (error) {
                popupTiming?.settled(false);
                if (IS_LOCAL_DEV || providerName !== 'google' || error?.code !== 'auth/popup-blocked') throw error;
                mode = 'redirect';
                window.YgoLoginTiming?.provider(mode, true);
                await firebase.auth().signInWithRedirect(provider);
            }
        } else await firebase.auth().signInWithRedirect(provider);
        // 인증 결과 반환만으로 로딩을 닫지 않는다. 최종 결과는 onAuthStateChanged에서 처리한다.
    } catch (error) {
        window.YgoLoginTiming?.cancelProvider?.();
        reportAuthFailure(mode === 'popup' ? 'sign-in-popup' : 'sign-in-redirect', error);
        if (!registrationCheckPending) setServiceLoginPending(false);
        showToast('로그인하지 못했습니다. 다시 시도해 주세요.', 'toast-error');
    } finally {
        loginInProgress = false;
        toggleLoginBtn();
    }
}

/**
 * 유튜브 멤버십 인증 모달 오픈
 */
function openMembershipAuthModal(source = 'header') {
    if (!UserStore.user) {
        showToast('로그인이 필요합니다.', 'toast-warn');
        return;
    }
    resetMembershipVerifyModal();
    const hideButton = document.getElementById('never-show-membership-verify');
    const hideFooter = document.getElementById('membership-hide-footer');
    if (hideButton) hideButton.hidden = source === 'settings';
    if (hideFooter) hideFooter.hidden = source === 'settings';
    const linkedMembership = UserStore.sourceMembership;
    const active = linkedMembership?.status === 'active';
    const discordBadge = document.getElementById('badge-discord-linked');
    const youtubeBadge = document.getElementById('badge-youtube-linked');
    if (discordBadge) discordBadge.hidden = !(active && linkedMembership.type === 'discord');
    if (youtubeBadge) youtubeBadge.hidden = !(active && linkedMembership.type === 'csv');

    const modal = document.getElementById('membership-auth-modal');
    if (modal) {
        getAppModal(modal).open();
        prepareMembershipEntry();
    }
}

/**
 * 디스코드 멤버십 인증 시작
 */
let discordMembershipStarting = false;
let discordMembershipStartPreparation = null;
const discordStartClock = () => globalThis.performance?.now?.() ?? Date.now();

// 권한 결과가 아닌 짧은 일회용 OAuth 시작 상태만 메모리에서 공유한다.
// 모달 재열기/빠른 클릭은 같은 요청을 사용하며 저장소·로그에는 주소를 남기지 않는다.
function prepareDiscordMembershipStart() {
    if (globalThis.AppBackend && !globalThis.AppBackend.membershipEnabled('discord')) return null;
    const uid = UserStore.user?.uid, revision = authStateRevision, redirectUri = location.origin + '/';
    if (!uid || firebase.auth().currentUser?.uid !== uid) return null;
    const previous = discordMembershipStartPreparation;
    if (previous && previous.uid === uid && previous.revision === revision
        && previous.redirectUri === redirectUri && !previous.failed && !previous.claimed
        && discordStartClock() < previous.deadline) return previous;
    const prepared = { uid, revision, redirectUri, deadline: discordStartClock() + 270000,
        result: null, claimed: false, failed: false };
    discordMembershipStartPreparation = prepared;
    prepared.promise = (async () => {
        const result = await callApi('startDiscordMembershipVerification', {}, { redirectUri });
        if (discordMembershipStartPreparation !== prepared || authStateRevision !== revision
            || UserStore.user?.uid !== uid || firebase.auth().currentUser?.uid !== uid
            || discordStartClock() >= prepared.deadline) throw new Error('Discord 준비가 만료되었습니다.');
        if (!result?.success || result.uid !== uid || !/^[a-f0-9]{64}$/.test(result.verificationId)) throw new Error('Discord 준비 응답이 올바르지 않습니다.');
        const url = new URL(result.authorizationUrl);
        if (url.origin !== 'https://discord.com' || url.pathname !== '/oauth2/authorize'
            || url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== result.verificationId
            || url.searchParams.getAll('redirect_uri').length !== 1 || url.searchParams.get('redirect_uri') !== redirectUri) throw new Error('Discord 준비 주소가 올바르지 않습니다.');
        prepared.result = { ...result, authorizationUrl: url.href };
        prepared.readyAt = discordStartClock();
        return prepared.result;
    })();
    // 모달을 닫거나 YouTube를 선택해도 실패한 선행 요청을 반드시 회수한다.
    prepared.promise.catch(() => { prepared.failed = true; });
    if (!globalThis.AppBackend) beginMembershipPreparation('discord');
    return prepared;
}
// 전역 계정 버튼의 대기/완료 표시는 YouTube와 Discord가 함께 사용한다.
let discordMembershipHeaderState = null;
let discordMembershipHeaderTimer = null;
let discordMembershipWidthAnimation = null;

function animateDiscordMembershipWidth(button, fromWidth) {
    const old = discordMembershipWidthAnimation;
    discordMembershipWidthAnimation = null;
    old?.cancel();
    button.classList.remove('is-membership-resizing');
    const toWidth = button.getBoundingClientRect().width;
    if (typeof button.animate !== 'function' || Math.abs(toWidth - fromWidth) < 0.5
        || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    button.classList.add('is-membership-resizing');
    const animation = button.animate([{ width: `${fromWidth}px` }, { width: `${toWidth}px` }],
        { duration: 220, easing: 'ease-out' });
    discordMembershipWidthAnimation = animation;
    const finish = () => {
        if (discordMembershipWidthAnimation !== animation) return;
        discordMembershipWidthAnimation = null;
        button.classList.remove('is-membership-resizing');
    };
    animation.finished.then(finish, finish);
}

function setDiscordMembershipHeader(phase, uid) {
    if (discordMembershipHeaderTimer !== null) clearTimeout(discordMembershipHeaderTimer);
    discordMembershipHeaderTimer = null;
    discordMembershipHeaderState = phase === 'pending' || phase === 'complete' ? { phase, uid } : null;
    if (!discordMembershipHeaderState) {
        const button = document.getElementById?.('auth-capsule-btn');
        const icon = button?.querySelector('.auth-icon');
        const text = document.getElementById?.('auth-btn-text');
        const fromWidth = button?.getBoundingClientRect().width;
        if (button) {
            delete button.dataset.membershipVerification;
            button.removeAttribute('aria-busy');
            button.setAttribute('aria-label', UserStore.user ? '내 계정: 환경설정으로 이동' : '로그인');
        }
        if (icon) {
            icon.classList.remove('is-membership-pending');
            icon.textContent = UserStore.user && UserStore.settings?.membership?.status === 'active' ? 'diamond' : 'account_circle';
        }
        if (text) { text.textContent = UserStore.user ? '내 계정' : '로그인'; text.removeAttribute('aria-live'); }
        if (button) animateDiscordMembershipWidth(button, fromWidth);
        syncMembershipHeader();
        return;
    }
    renderDiscordMembershipHeader();
    if (phase === 'complete') {
        const completed = discordMembershipHeaderState;
        discordMembershipHeaderTimer = setTimeout(() => {
            if (discordMembershipHeaderState === completed) setDiscordMembershipHeader('idle');
        }, 5000);
    }
}

function renderDiscordMembershipHeader() {
    const state = discordMembershipHeaderState;
    if (!state) return;
    const currentUid = UserStore.user?.uid || globalThis.firebase?.auth?.().currentUser?.uid;
    if (currentUid && currentUid !== state.uid || state.phase === 'complete' && UserStore.user?.uid !== state.uid
        || !currentUid && window.isAuthInitialized && !registrationCheckPending) {
        setDiscordMembershipHeader('idle');
        return;
    }
    const button = document.getElementById?.('auth-capsule-btn');
    if (!button) return;
    const pending = state.phase === 'pending';
    const label = pending ? '멤버십 인증 중' : '멤버십 인증 완료';
    const text = document.getElementById?.('auth-btn-text');
    const labelChanged = text?.textContent !== label || button.dataset.membershipVerification !== state.phase;
    const fromWidth = labelChanged ? button.getBoundingClientRect().width : null;
    button.dataset.membershipVerification = state.phase;
    button.setAttribute('aria-busy', String(pending));
    button.setAttribute('aria-label', label);
    const icon = button.querySelector('.auth-icon');
    if (icon) {
        icon.classList.toggle('is-membership-pending', pending);
        icon.textContent = pending ? 'sync' : UserStore.settings?.membership?.status === 'active' ? 'diamond' : 'account_circle';
    }
    if (text) { text.setAttribute('aria-live', 'polite'); text.textContent = label; }
    if (labelChanged) animateDiscordMembershipWidth(button, fromWidth);
}

async function startDiscordMembershipVerify() {
    if (globalThis.AppBackend && !globalThis.AppBackend.membershipEnabled('discord')) return globalThis.AppBackend.notifyUnavailable();
    if (!requireInventoryReady()) return;
    const user = UserStore.user;
    if (!user) { showToast('로그인이 필요합니다.', 'toast-warn'); return; }
    if (discordMembershipStarting || typeof youtubeMembershipVerificationPending !== 'undefined' && youtubeMembershipVerificationPending) return;
    discordMembershipStarting = true;
    setDiscordMembershipHeader('pending', user.uid);
    const revision = authStateRevision;
    const clickedAt = discordStartClock();
    let popup, navigating = false;
    try {
        const prepared = prepareDiscordMembershipStart();
        if (!prepared) throw new Error();
        const wasPrepared = !!prepared.result;
        // await 전에 사용자 클릭 안에서 연다. 준비됐으면 안내 문서를 요청하지 않는다.
        popup = globalThis.YgoDiscordPopup?.open?.({ prepared: wasPrepared });
        prepared.claimed = true;
        const res = prepared.result || await prepared.promise;
        if (revision !== authStateRevision || UserStore.user?.uid !== user.uid
            || firebase.auth().currentUser?.uid !== user.uid || discordStartClock() >= prepared.deadline) throw new Error();
        discordMembershipStartPreparation = null;
        const pending = { uid: user.uid, state: res.verificationId,
            expiresAt: Date.now() + Math.max(0, prepared.deadline - discordStartClock()) };
        if (popup && popup.authorize({ authorizationUrl: res.authorizationUrl, state: pending.state, deadline: pending.expiresAt })) {
            const navigationMs = Math.round((discordStartClock() - clickedAt) * 1000) / 1000;
            const result = await popup.result;
            if (revision !== authStateRevision || UserStore.user?.uid !== user.uid
                || firebase.auth().currentUser?.uid !== user.uid || Date.now() >= pending.expiresAt) throw new Error();
            await handleDiscordOAuthCallback({ popup: true, pending, ...result,
                timingParams: { discordFlow: 'popup', discordStartPrepared: String(wasPrepared), discordNavigationMs: String(navigationMs) } });
            return;
        }
        sessionStorage.setItem('discord_membership_verification', JSON.stringify(pending));
        sessionStorage.removeItem('discord_oauth_pending');
        // 이동/복귀 계측에는 계정·state·주소 없이 숫자와 준비 여부만 남긴다.
        try {
            sessionStorage.removeItem('discord_start_timing');
            sessionStorage.setItem('discord_start_timing', JSON.stringify({ version: 1, prepared: wasPrepared,
                navigationMs: Math.round((discordStartClock() - clickedAt) * 1000) / 1000 }));
        } catch (_) { /* 부가 계측 저장 실패는 OAuth 이동을 막지 않는다. */ }
        navigating = true;
        window.location.href = res.authorizationUrl;
    } catch (error) {
        navigating = false; setDiscordMembershipHeader('idle');
        if (error?.code !== 'DISCORD_POPUP_CANCELLED') showToast('Discord 인증을 시작하지 못했습니다. 복귀 주소와 로그인 상태를 확인해 주세요.', 'toast-error');
    }
    finally { popup?.cancel(); if (!navigating) discordMembershipStarting = false; }
}

// Firebase 초기화와 같은 계정의 서비스 복원 상태를 확인한다.
async function waitForDiscordServiceUser(uid, expiresAt, prepareReturn) {
    // 복원 재시도보다 먼저 포기하지 않는다. 기존 nonce 만료 안에서만 기다린다.
    const deadline = Math.min(Number.isFinite(expiresAt) ? expiresAt : 0, Date.now() + 300000);
    while (Date.now() < deadline) {
        const user = globalThis.firebase?.auth?.().currentUser;
        if (user && user.uid !== uid || UserStore.user && UserStore.user.uid !== uid) {
            throw Object.assign(new Error(), { code: 'DISCORD_SESSION_CHANGED' });
        }
        if (prepareReturn) {
            const session = prepareReturn(user);
            if (session) return session;
        } else if (!registrationCheckPending && UserStore.user?.uid === uid && user?.uid === uid
            && UserStore.inventorySyncStatus === 'ready') return user;
        if (window.isAuthInitialized && !registrationCheckPending
            && (!UserStore.user || UserStore.inventorySyncStatus === 'error')) {
            throw Object.assign(new Error(), { code: 'DISCORD_RESTORE_FAILED' });
        }
        await new Promise(resolve => {
            if (!prepareReturn || !document.addEventListener) { setTimeout(resolve, 50); return; }
            const finish = () => {
                clearTimeout(timer);
                document.removeEventListener('ygo:discord-session', finish);
                resolve();
            };
            const timer = setTimeout(finish, 50);
            document.addEventListener('ygo:discord-session', finish, { once: true });
        });
    }
    throw Object.assign(new Error(), { code: 'DISCORD_VERIFICATION_EXPIRED' });
}

async function handleDiscordOAuthCallback(popupProof) {
    const popup = popupProof?.popup === true;
    let authenticationDisplayed = false, restoreResult;
    let raw, code, state;
    if (popup) {
        raw = JSON.stringify(popupProof.pending); code = popupProof.code; state = popupProof.state;
    } else {
        const params = new URLSearchParams(location.search);
        raw = sessionStorage.getItem('discord_membership_verification');
        if (!raw && !sessionStorage.getItem('discord_oauth_pending')) return;
        if (!params.has('code') && !params.has('error')) return;
        sessionStorage.removeItem('discord_membership_verification');
        sessionStorage.removeItem('discord_oauth_pending');
        code = params.get('code'); state = params.get('state');
        params.delete('code'); params.delete('state'); params.delete('error'); params.delete('error_description');
        const clean = new URL(location.href); clean.search = params.toString();
        window.history.replaceState({}, document.title, clean.href);
    }
    const trace = window.YgoLoginTiming?.recovery?.('discord');
    const measure = (name, work) => trace ? trace.measure(name, work) : work();
    try {
        const pending = JSON.parse(raw);
        if (!pending || pending.state !== state || !Number.isFinite(pending.expiresAt) || pending.expiresAt <= Date.now()) {
            throw Object.assign(new Error(), { code: 'DISCORD_VERIFICATION_EXPIRED' });
        }
        if (!code) { trace?.finish('cancelled'); showToast('Discord 인증을 취소했습니다.', 'toast-info'); return; }
        setDiscordMembershipHeader('pending', pending.uid);
        const prepareReturn = !popup && globalThis.AppBackend?.discordReturnSession;
        const sessionOrUser = popup ? UserStore.user : await measure('restore_wait', () => waitForDiscordServiceUser(pending.uid, pending.expiresAt, prepareReturn));
        const returnSession = prepareReturn ? sessionOrUser : null;
        const user = returnSession?.user || sessionOrUser;
        if (!user || user.uid !== pending.uid || firebase.auth().currentUser?.uid !== pending.uid) throw Object.assign(new Error(), { code: 'DISCORD_SESSION_CHANGED' });
        const revision = authStateRevision;
        let startTiming;
        try {
            if (!popup) {
                startTiming = JSON.parse(sessionStorage.getItem('discord_start_timing'));
                sessionStorage.removeItem('discord_start_timing');
            }
        } catch (_) { /* 계측 부재는 인증을 막지 않는다. */ }
        const timingParams = popup ? popupProof.timingParams : startTiming?.version === 1 && typeof startTiming.prepared === 'boolean'
            && Number.isFinite(startTiming.navigationMs) && startTiming.navigationMs >= 0 && startTiming.navigationMs <= 300000
            ? { discordStartPrepared: String(startTiming.prepared), discordNavigationMs: String(startTiming.navigationMs) } : {};
        const proof = { code, verificationId: state };
        const res = await measure('membership_request', () => returnSession ? returnSession.verify(proof) : callApi('verifyDiscordMembership', timingParams, proof));
        if (!res?.success || res.uid !== user.uid) throw new Error();
        if (returnSession?.isRestoring?.()) {
            restoreResult = document.getElementById('discord-restore-membership-result');
            if (restoreResult) {
                const level = res.membership?.status === 'active' ? res.membership.levelName : '활성 멤버십 없음';
                restoreResult.textContent = level ? `멤버십 인증 완료 · ${level}` : '멤버십 인증 완료';
                restoreResult.hidden = false;
                globalThis.YgoAuthenticationResult?.displayed?.('discord');
            }
        }
        if (returnSession) await measure('inventory_restore_wait', returnSession.waitForInventory);
        const current = () => revision === authStateRevision && UserStore.user?.uid === user.uid && firebase.auth().currentUser?.uid === user.uid;
        if (!current()) throw Object.assign(new Error(), { code: 'DISCORD_SESSION_CHANGED' });
        if (!UserStore.settings) UserStore.settings = {};
        measure('render', () => {
            if (returnSession) returnSession.apply(res);
            else {
                UserStore.sourceMembership = res.sourceMembership || null;
                UserStore.settings.membership = res.membership;
                applyMembershipStatus(res.membership);
            }
            const dialog = document.getElementById?.('membership-auth-modal');
            if (dialog && typeof M !== 'undefined') {
                M.Modal.getInstance(dialog)?.close();
                resetMembershipVerifyModal();
            }
            setDiscordMembershipHeader('complete', user.uid);
            authenticationDisplayed = true;
            if (!restoreResult) globalThis.YgoAuthenticationResult?.displayed?.('discord');
        });
        let claimsReady;
        if (res.membershipClaims) {
            claimsReady = await measure('claims_sync', () => refreshMembershipClaims(user, res));
            if (!current()) { trace?.finish('superseded'); return; }
        }
        // 복귀 시 가입 확인이 이미 동기화한 목록은 멤버십 변경만으로 무효화되지 않는다.
        // 다른 작업으로 동기화가 필요해진 경우에는 기존 단일 동기화와 전체 로딩을 유지한다.
        await measure('final_sync', async () => {
            if (UserStore.inventorySyncStatus !== 'ready') {
                if (!await loadUserData(undefined, { membershipClaimsReadOnly: true })) throw Object.assign(new Error(), { code: 'DISCORD_RESTORE_FAILED' });
            } else if (res.membershipClaims) {
                UserStore.claimsSyncStatus = claimsReady ? 'ready' : 'pending';
                followMembershipClaims(user);
                setInventorySyncStatus('ready');
            }
        });
        if (!current()) { trace?.finish('superseded'); return; }
        trace?.finish('ready');
    } catch (error) {
        if (!authenticationDisplayed) setDiscordMembershipHeader('idle');
        trace?.finish('failed', error);
        const restoreFailed = error.code === 'DISCORD_RESTORE_FAILED';
        const appFailed = ['APPCHECK_UNAVAILABLE', 'APPCHECK_CONFIGURATION_REJECTED', 'APPCHECK_REQUIRED', 'APPCHECK_INVALID'].includes(error.code);
        showToast(restoreFailed ? '서비스 로그인을 복원하지 못했습니다. 로그인 상태를 확인한 뒤 다시 인증해 주세요.'
            : appFailed ? '앱 인증을 준비하지 못했습니다. 잠시 후 다시 인증해 주세요.'
                : 'Discord 인증이 만료되었거나 계정이 변경되었습니다. 다시 인증해 주세요.', 'toast-error');
    } finally {
        if (restoreResult) {
            restoreResult.hidden = true;
            restoreResult.textContent = '';
        }
    }
}

/**
 * 멤버십 인증 메시지 숨기기 핸들러 (2단계 확인)
 */
let membershipHideClickCount = 0;
async function handleNeverShowMembership() {
    const button = document.getElementById('never-show-membership-verify');
    if (!button || button.hidden || button.disabled || !UserStore.user) return;
    const guide = document.getElementById('membership-hide-guide');
    if (membershipHideClickCount === 0) {
        membershipHideClickCount = 1;
        if (guide) guide.hidden = false;
        button.textContent = '숨기기 확인';
        return;
    }
    button.disabled = true;
    try {
        await saveUserSetting('hideMembershipVerify', true);
        const instance = M.Modal.getInstance(document.getElementById('membership-auth-modal'));
        if (instance) instance.close();
        syncMembershipHeader(false);
        resetMembershipVerifyModal();
    } catch (error) {
        showToast('설정 저장에 실패했습니다.', 'toast-error');
    } finally {
        button.disabled = false;
    }
}

/** 닫기 방법과 관계없이 다음 열림은 첫 확인 단계에서 시작한다. */
function resetMembershipVerifyModal() {
    membershipHideClickCount = 0;
    const button = document.getElementById('never-show-membership-verify');
    if (button) button.textContent = '다시 표시하지 않음';
    const guide = document.getElementById('membership-hide-guide');
    if (guide) guide.hidden = true;
}

function toggleProviderLink(providerName) {
    const user = UserStore.user;
    if (!user) return;
    if (globalThis.AppBackend && user !== globalThis.firebase?.auth?.().currentUser) {
        return globalThis.AppBackend.notifyUnavailable();
    }

    const providerId = providerName === 'google' ? 'google.com' : 'twitter.com';
    const activeProviders = UserStore.user.providerData.map(p => p.providerId);

    if (activeProviders.includes(providerId)) {
        // 이미 연결됨 -> 연결 해제
        if (activeProviders.length <= 1) {
            return;
        }
        user.unlink(providerId).then(() => {
            if (UserStore.user !== user || firebase.auth().currentUser?.uid !== user.uid) return;
            // UserCredential에서 최신 정보를 받거나 UserStore.user 자체 사용 (V8/Compat에서는 UserStore.user가 자동 갱신됨)
            UserStore.user = firebase.auth().currentUser;
            renderLinkedAccounts(UserStore.user);
        }).catch(err => {
            console.error("Unlink Error", err);
            showToast('연결 해제 실패', 'toast-error');
        });

    } else {
        // 연결 안됨 -> 신규 연결
        const provider = getProviderInstance(providerName);
        user.linkWithPopup(provider).then((result) => {
            if (UserStore.user !== user || firebase.auth().currentUser?.uid !== user.uid) return;
            // 인증 객체 교체: result.user 에는 추가된 providerData가 포함됨
            UserStore.user = result.user;
            renderLinkedAccounts(UserStore.user);
        }).catch(err => {
            console.error("Link Error", err);
            // credential_already_in_use 등의 에러 핸들링
            if (err.code === 'auth/credential-already-in-use') {
                showToast('이미 다른 계정에 연동된 서비스입니다.', 'toast-error');
            } else {
                showToast('계정 연결에 실패했습니다.', 'toast-error');
            }
        });
    }
}

function deleteAccount() {
    const user = UserStore.user;
    if (!user) return;
    if (globalThis.AppBackend && (!globalThis.AppBackend.capabilities.accountDeletion
        || user !== globalThis.firebase?.auth?.().currentUser)) {
        return globalThis.AppBackend.notifyUnavailable();
    }

    // 계정 삭제 전용 모달이 있으므로 데이터 삭제와 구분하여 처리 (기존 confirm 유지 혹은 모달 통합 가능)
    if (confirm("정말로 계정을 삭제하시겠습니까?\n모든 데이터와 연동 정보가 영구 삭제됩니다.")) {
        user.delete().then(() => {
            if (firebase.auth().currentUser && firebase.auth().currentUser.uid !== user.uid) return;
            switchToMode('home');
            window.location.reload(); // 상태 완전 초기화
        }).catch(err => {
            console.error("Delete Error", err);
            if (err.code === 'auth/requires-recent-login') {
                showToast('세션이 만료되었습니다. 다시 로그인 해주세요.', 'toast-warn');
                signOutCurrentUser();
            } else {
                showToast('계정 삭제 실패', 'toast-error');
            }
        });
    }
}

/**
 * 데이터 삭제 확인 모달 오픈
 */
function openDataClearModal() {
    if (!requireInventoryReady()) return;
    if (dataClearBusy || migrationState.busy || !checkAuthBeforeAction()) return;
    const message = document.getElementById('data-clear-status-msg');
    message.textContent = '';
    message.hidden = true;
    getAppModal(document.getElementById('data-clear-confirm-modal')).open();
}

async function executeDataClear() {
    if (!requireInventoryReady()) return;
    if (dataClearBusy || migrationState.busy || !checkAuthBeforeAction()) return;
    const user = UserStore.user;
    const message = document.getElementById('data-clear-status-msg');
    dataClearBusy = true;
    setDataTransferBusy('data-clear-confirm-modal', true);
    message.className = 'color-text-001';
    message.textContent = '보유 카드를 삭제하는 중입니다. 완료될 때까지 창을 닫을 수 없습니다.';
    message.hidden = false;
    let result;
    try {
        result = await callApi('clearUserData', {}, {});
        if (UserStore.user === user && !result?.success) throw new Error(result?.message || '보유 카드를 삭제하지 못했습니다.');
    } catch (error) {
        result = null;
        if (UserStore.user === user) {
            message.className = 'color-text-red';
            message.textContent = error.message || '서버 통신 중 오류가 발생했습니다.';
        }
    } finally {
        setDataTransferBusy('data-clear-confirm-modal', false);
        dataClearBusy = false;
    }
    if (UserStore.user !== user) {
        M.Modal.getInstance(document.getElementById('data-clear-confirm-modal')).close();
        return;
    }
    if (!result?.success) return;
    M.Modal.getInstance(document.getElementById('data-clear-confirm-modal')).close();
    getAppModal(document.getElementById('data-clear-success-modal')).open();
    cardCacheInstance.clearAll();
    try { await loadUserData(); }
    catch (_) { if (UserStore.user === user) showToast('삭제는 완료되었습니다. 보유 정보 새로고침을 다시 시도해주세요.', 'toast-warn'); }
}

function signOutCurrentUser() {
    if (globalThis.AppBackend) return globalThis.AppBackend.signOut();
    AutoLogoutManager.stop();
    if (typeof firebase !== 'undefined' && firebase.auth) {
        firebase.auth().signOut().then(() => {
            const modalId = 'auth-modal';
            const modalElem = document.getElementById(modalId);
            const instance = M.Modal.getInstance(modalElem);
            if (instance) instance.close();
            // 로그아웃 후 홈 화면으로 리다이렉트
            switchToMode('home');
        });
    }
}

// ------------------------------------------
// 이용약관 및 개인정보 동의 모달 제어
// ------------------------------------------


// ------------------------------------------
// 공지사항 및 알림 시스템 로직
// ------------------------------------------

// ------------------------------------------
// [개편] 공지사항 및 알림 시스템 로직 (Firestore 연동)
// ------------------------------------------

let notices = []; // Storage(notices.json)에서 로드된 공지사항 데이터
const READ_NOTICES_KEY = 'ygo_synapse_read_notices';
let noticeLoadState = 'idle';
const NOTICE_STORAGE_URL = 'https://storage.googleapis.com/ygo-synapse.firebasestorage.app/public/notices.json';

function applyNotices(nextNotices) {
    // id 형식: "YYYY.MM.DDTHH:MM" (KST). 과도기 하이픈 형식도 함께 읽습니다.
    // createdAt: 브라우저가 파싱할 수 있는 ISO 구분자로 변환하여 작성 시각 반영
    notices = (Array.isArray(nextNotices) ? nextNotices : []).map(n => {
        const normalizedId = String(n.id).replace(/^(\d{4})-(\d{2})-(\d{2})T/, '$1.$2.$3T');
        return {
            ...n,
            id: normalizedId,
            date: normalizedId.substring(0, 10),
            createdAt: new Date(normalizedId.replace(/^(\d{4})\.(\d{2})\.(\d{2})T/, '$1-$2-$3T') + ':00+09:00').getTime()
        };
    });
    updateNotiBadge();
}

/**
 * [개편] Storage(notices.json)에서 공지사항 데이터를 가져옵니다.
 * JSON 파일은 이미 정렬된 상태로 저장되어 있으므로 별도 정렬 불필요.
 */
async function fetchNotices() {
    if (globalThis.AppBackend && !globalThis.AppBackend.capabilities.notices) return;
    if (noticeLoadState === 'loading') return;
    noticeLoadState = 'loading';
    refreshNoticeReadState();
    try {
        if (globalThis.AppBackend?.fetchNotices) {
            const data = await globalThis.AppBackend.fetchNotices();
            if (!Array.isArray(data.notices)) throw Error('NOTICE_UNAVAILABLE');
            applyNotices(data.notices);
            noticeLoadState = 'ready';
            return;
        }
        // 캐시된 본문이 있어도 ETag를 재검증하여 최신 공지만 적용합니다.
        const res = await fetch(NOTICE_STORAGE_URL, { cache: 'no-cache' });
        if (!res.ok) {
            // 파일이 존재하지 않는 경우(404 등) 예외를 발생시키지 않고 빈 공지로 처리
            applyNotices([]);
            return;
        }
        const data = await res.json();
        applyNotices(data.notices);
    } catch (_) {
        noticeLoadState = 'error';
    } finally {
        if (noticeLoadState === 'loading') noticeLoadState = 'ready';
        refreshNoticeReadState();
    }
}

function refreshNoticeReadState() {
    updateNotiBadge();
    const popup = document.getElementById('noti-popup');
    if (popup?.classList.contains('active') || popup && isManagedSheetOpen(popup)) renderNotiPopup();
}

function getTop8NoticeIds() {
    return notices.slice(0, 8).map(n => n.id);
}

function getReadNoticesStorageKey() {
    return globalThis.AppBackend?.readNoticesStorageKey?.() || READ_NOTICES_KEY;
}


/** 기존 날짜-제목 기록과 과도기 ID도 읽되, 저장은 현재 공지 ID로 한다. */
function getReadNoticeIds() {
    let stored;
    try { stored = JSON.parse(localStorage.getItem(getReadNoticesStorageKey()) || '[]'); }
    catch { return []; }
    if (!Array.isArray(stored)) return [];
    const readKeys = new Set(stored.filter(key => typeof key === 'string').map(key =>
        key.replace(/^(\d{4})-(\d{2})-(\d{2})T/, '$1.$2.$3T')));
    return notices.filter(n => readKeys.has(n.id) || readKeys.has(`${n.date}-${n.title}`)).map(n => n.id);
}

/** 최신 8건 중 아직 열람하지 않은 공지인지 확인한다. */
function isNoticeNew(noti) {
    return getTop8NoticeIds().includes(noti.id) && !getReadNoticeIds().includes(noti.id);
}

/** 선택한 공지 1건만 읽음 처리한다. 기존 기록은 저장 시 ID로 호환한다. */
function markNoticeAsRead(id) {
    const top8Ids = getTop8NoticeIds();
    if (!top8Ids.includes(id)) return;
    const readIds = getReadNoticeIds();
    if (readIds.includes(id)) return;
    const updatedReadList = [...new Set([...readIds, id])].filter(key => top8Ids.includes(key));
    localStorage.setItem(getReadNoticesStorageKey(), JSON.stringify(updatedReadList));
    updateNotiBadge();
    if (typeof saveUserSetting === 'function') saveUserSetting('readNotices', updatedReadList);
    const popup = document.getElementById('noti-popup');
    if (popup && popup.classList.contains('active')) renderNotiPopup();
}

function closeNotiPopup() {
    const popup = document.getElementById('noti-popup');
    if (!popup || (!popup.classList.contains('active') && !isManagedSheetOpen(popup))) return;
    const trigger = document.getElementById('noti-btn');
    popup.classList.remove('active');
    trigger?.setAttribute('aria-expanded', 'false');
    if (popup.classList.contains('ui-overlay--sheet')) {
        closeManagedSheet(popup, { backdrop: document.getElementById('noti-popup-backdrop') });
    } else {
        const restoreFocus = popup.contains(document.activeElement);
        globalThis.AppOverlays.closePopup(popup, () => {
            const active = document.activeElement;
            if (restoreFocus && (popup.contains(active) || active === document.body || active === document.documentElement)) {
                focusModalReturnTarget(trigger);
            }
        });
    }
}

function toggleNotiPopup(event) {
    event?.stopPropagation();
    const popup = document.getElementById('noti-popup');
    if (!popup) return;
    if (popup.classList.contains('active') || isManagedSheetOpen(popup)) return closeNotiPopup();
    const mobile = document.documentElement.classList.contains('is-mobile-device');
    popup.classList.toggle('ui-overlay--sheet', mobile);
    popup.classList.toggle('ui-overlay--popup', !mobile);
    popup.classList.toggle('shape-rounded-lg', mobile);
    popup.classList.toggle('shape-rounded003', !mobile);
    popup.classList.toggle('shadow-mobile-sheet', mobile);
    popup.classList.toggle('shadow-medium', !mobile);
    if (noticeLoadState === 'idle' || noticeLoadState === 'error') fetchNotices();
    renderNotiPopup();
    const trigger = document.getElementById('noti-btn');
    trigger?.setAttribute('aria-expanded', 'true');
    if (mobile) {
        popup.style.removeProperty('left');
        popup.style.removeProperty('top');
        openManagedSheet(popup, { backdrop: document.getElementById('noti-popup-backdrop'), trigger, onDismiss: closeNotiPopup });
    } else {
        popup.classList.add('active');
        globalThis.AppOverlays.openPopup(popup, trigger);
    }
}

document.addEventListener('click', event => {
    const popup = document.getElementById('noti-popup');
    if (popup?.classList.contains('ui-overlay--popup') && !popup.contains(event.target)
        && !document.getElementById('noti-btn')?.contains(event.target)) closeNotiPopup();
});
document.addEventListener('keydown', event => {
    const popup = document.getElementById('noti-popup');
    if (event.key === 'Escape' && popup?.classList.contains('active') && popup.classList.contains('ui-overlay--popup')) {
        event.preventDefault();
        closeNotiPopup();
        document.getElementById('noti-btn')?.focus({ preventScroll: true });
    }
});

function renderNotiPopup() {
    const listContainer = document.getElementById('noti-list-container');
    if (!listContainer) return;

    // 최대 5개 노출 (이미 정렬된 notices 사용)
    const displayNotices = notices.slice(0, 5);

    let htmlStr = '';
    displayNotices.forEach(noti => {
        const isNew = isNoticeNew(noti);
        const isPinned = noti.isPinned > 0;
        const pinIcon = isPinned ? '<i class="material-icons pin-icon color-text-theme" aria-hidden="true">push_pin</i>' : '';
        htmlStr += `
            <button type="button" class="noti-item ui-button shape-rounded003 ${isPinned ? 'color-type002 is-pinned' : 'color-type004'} ${isNew ? 'is-new' : ''}" data-notice-id="${escapeHTML(noti.id)}">
                <span class="noti-item__heading"><span class="noti-item-title color-text-000">${pinIcon}${escapeHTML(noti.title)}</span><span class="noti-item__unread color-text-red" aria-hidden="true"></span></span>
                <time class="noti-item-date color-text-001" datetime="${escapeHTML(noti.date.replaceAll('.', '-'))}">${escapeHTML(noti.date)}</time>
                <span class="visually-hidden">${isPinned ? '고정 공지. ' : ''}${isNew ? '새 공지' : '읽은 공지'}</span>
            </button>
        `;
    });

    if (notices.length === 0 || noticeLoadState === 'error') {
        const message = noticeLoadState === 'loading' ? '공지사항을 불러오는 중입니다.'
            : noticeLoadState === 'error' ? '공지사항을 불러오지 못했습니다. 창을 다시 열어 재시도해 주세요.' : '공지사항이 없습니다.';
        htmlStr += `<p class="noti-state ${noticeLoadState === 'error' ? 'color-text-red' : 'color-text-001'}" role="status" aria-live="polite">${message}</p>`;
    }

    listContainer.innerHTML = htmlStr;
    listContainer.querySelectorAll('[data-notice-id]').forEach(item => {
        item.onclick = () => openNoticeModal(item.dataset.noticeId);
    });
}

function updateNotiBadge() {
    const badge = document.getElementById('noti-badge');
    if (!badge) return;

    // 신규 공지가 하나라도 있는지 확인 (최신 8개 검사는 isNoticeNew 내에서 처리됨)
    const hasUnreadNew = notices.slice(0, 8).some(noti => isNoticeNew(noti));
    badge.hidden = !hasUnreadNew;
}
/**
 * [공지사항 전용 도구] 콘솔용 공지사항 관리 헬퍼 (NoticeSet)
 * 사용법: NoticeSet.list(), NoticeSet.add(), NoticeSet.update(), NoticeSet.delete()
 */
window.NoticeSet = {
    url: FIREBASE_CONFIG.ENDPOINTS.manageNotice,
    storageUrl: NOTICE_STORAGE_URL,

    async request(body) {
        if (typeof firebase === 'undefined' || !firebase.auth) {
            console.error("오류: Firebase Auth SDK가 로드되지 않았습니다.");
            return { success: false, error: "Firebase Auth 미로드" };
        }
        const user = firebase.auth().currentUser;
        if (!user) {
            console.error("오류: 먼저 관리자 계정으로 로그인해야 공지사항을 관리할 수 있습니다.");
            return { success: false, error: "로그인이 필요합니다." };
        }

        try {
            const token = await user.getIdToken();
            const res = await fetch(this.url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${token}`
                },
                body: JSON.stringify(body)
            });
            const result = await res.json();
            console.log("결과:", result);
            if (res.ok && Array.isArray(result.notices)) {
                // 관리 API가 반환한 최신 목록을 즉시 적용해 Storage 캐시와 분리합니다.
                applyNotices(result.notices);
                const popup = document.getElementById('noti-popup');
                if (popup && popup.classList.contains('active')) renderNotiPopup();
            } else if (res.ok) {
                await fetchNotices();
            }
            return result;
        } catch (e) {
            console.error("요청 중 오류 발생:", e);
            return { success: false, error: e.toString() };
        }
    },

    async list() {
        try {
            const res = await fetch(this.storageUrl, { cache: 'no-cache' });
            if (!res.ok) {
                console.log("등록된 공지사항이 없습니다.");
                return [];
            }
            const data = await res.json();
            const list = data.notices || [];
            console.table(list);
            return list;
        } catch (e) {
            console.log("등록된 공지사항이 없습니다.");
            return [];
        }
    },

    add(title, content = "", isPinned = 0) {
        return this.request({ action: "add", title, content, isPinned });
    },

    update(id, fields) {
        return this.request({ action: "update", id, ...fields });
    },

    delete(id) {
        return this.request({ action: "delete", id });
    }
};

/**
 * [웹앱 전반 시스템 관리 도구] 콘솔용 관리자 권한 도구 (AdminManager)
 * 사용법: 
 *   - AdminManager.listAdmin()                   : 전체 관리자 목록 조회
 *   - AdminManager.setAdmin(targetUid, true/false): 일반 관리자 지정 / 해제 (owner 전용)
 *   - AdminManager.setOwner(targetUid)           : 총책임자 승격 (owner 전용)
 */
window.AdminManager = {
    url: FIREBASE_CONFIG.ENDPOINTS.manageAdminRole,

    async request(body) {
        if (typeof firebase === 'undefined' || !firebase.auth) {
            console.error("오류: Firebase Auth SDK가 로드되지 않았습니다.");
            return { success: false, error: "Firebase Auth 미로드" };
        }
        const user = firebase.auth().currentUser;
        if (!user) {
            console.error("오류: 먼저 로그인해야 관리자 제어 명령을 실행할 수 있습니다.");
            return { success: false, error: "로그인이 필요합니다." };
        }

        try {
            const token = await user.getIdToken();
            const res = await fetch(this.url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${token}`
                },
                body: JSON.stringify(body)
            });
            const result = await res.json();
            if (!res.ok) {
                console.error("실패:", result.error || result.message);
            } else {
                console.log("성공:", result.message || result);
            }
            return result;
        } catch (e) {
            console.error("요청 중 오류 발생:", e);
            return { success: false, error: e.toString() };
        }
    },

    // 📋 관리자 목록 조회
    async listAdmin() {
        const res = await this.request({ action: "list" });
        if (res && res.adminList) {
            console.table(res.adminList);
        }
        return res;
    },

    // 🛡️ 일반 관리자 지정 / 해제 (owner 전용, 회원 혜택은 다음 사용자 조회에 반영)
    setAdmin(targetUid, isAdmin = true) {
        return this.request({ action: "setAdmin", targetUid, isAdmin: Boolean(isAdmin) });
    },

    // 👑 총책임자(owner) 승격 (owner 전용)
    setOwner(targetUid) {
        return this.request({ action: "setOwner", targetUid });
    }
};

// 공지사항 상세 렌더링 및 모달 관련 기존 함수들은 상단의 통합된 openNoticeModal 및 관련 함수들이 대체합니다.

// ------------------------------------------
// 초기화 및 이벤트 리스너 추가
// ------------------------------------------

// 공지사항 데이터 로드(fetchNotices)는 initApp에서 통합 호출됩니다.

/**
 * [전환] 마이그레이션 모달 내 탭 전환 (파일/구글 시트)
 */
// 가져오기 창의 검증·실행 수명주기. 이전 파일/링크/계정의 응답을 새 창에 적용하지 않는다.
let pendingMigrationData = null;
const migrationState = { revision: 0, mode: 'file', reader: null, sheet: null, owner: null, busy: false };
let dataClearBusy = false;
const dataTransferLocks = new Map();

function setDataTransferBusy(id, busy) {
    const modal = document.getElementById(id);
    const instance = M.Modal.getInstance(modal);
    if (busy && !dataTransferLocks.has(id)) {
        const controls = [...modal.querySelectorAll('button, input, select, textarea')].map(control => [control, control.disabled]);
        dataTransferLocks.set(id, { controls, dismissible: instance.options.dismissible });
        controls.forEach(([control]) => { control.disabled = true; });
        instance.options.dismissible = false;
    } else if (!busy && dataTransferLocks.has(id)) {
        const lock = dataTransferLocks.get(id);
        lock.controls.forEach(([control, disabled]) => { control.disabled = disabled; });
        instance.options.dismissible = lock.dismissible;
        dataTransferLocks.delete(id);
    }
    modal.setAttribute('aria-busy', String(busy));
    const spinner = document.getElementById(id === 'migration-modal' ? 'migration-spinner' : 'data-clear-spinner');
    spinner.hidden = !busy;
}

function setMigrationMessage(text, color = 'color-text-001', icon = '') {
    const msg = document.getElementById('migration-status-msg');
    msg.textContent = text;
    msg.hidden = !text;
    msg.className = color;
    const fileGuide = document.getElementById('migration-file-guide');
    fileGuide.hidden = migrationState.mode === 'file' && Boolean(text) && color === 'color-text-red';
    const mark = document.getElementById('migration-valid-mark');
    mark.textContent = '';
    if (icon) {
        const node = document.createElement('i');
        node.className = `material-icons ${color}`;
        node.textContent = icon;
        mark.appendChild(node);
    }
}

function resetDataTransferValidation() {
    if (migrationState.busy) return;
    migrationState.revision++;
    clearTimeout(migrationValidationTimeout);
    const reader = migrationState.reader;
    migrationState.reader = null;
    if (reader?.readyState === 1) reader.abort();
    pendingMigrationData = null;
    migrationState.sheet = null;
    migrationState.owner = null;
    document.getElementById('migration-exec-btn').disabled = true;
    document.getElementById('migration-spinner').hidden = true;
    setMigrationMessage('');
}

function migrationPreviewMessage(preview) {
    let message = `검증 완료: ${preview.data?.length ?? preview.rowCount}개 항목 · ${preview.totalQty.toLocaleString()}장.`;
    if (preview.legacyQuantity) message += ' 수량 열이 없어 행마다 1장으로 처리합니다.';
    if (preview.skippedZeroCount) message += ` 수량 0인 ${preview.skippedZeroCount}개 행은 제외합니다.`;
    return message;
}

function toggleMigrationTab(mode) {
    if (migrationState.busy) return;
    resetDataTransferValidation();
    migrationState.mode = mode === 'sheet' ? 'sheet' : 'file';
    const isSheet = migrationState.mode === 'sheet';
    document.getElementById('mig-content-file').hidden = isSheet;
    document.getElementById('mig-content-sheet').hidden = !isSheet;
    document.getElementById('mig-mode-file').checked = !isSheet;
    document.getElementById('mig-mode-sheet').checked = isSheet;
    if (isSheet) validateMigrationLink();
    else handleMigrationFileUpload({ target: document.getElementById('migration-file-input') });
}

function handleMigrationFileUpload(event) {
    if (migrationState.busy || migrationState.mode !== 'file') return;
    const file = event.target.files?.[0];
    if (!file) return;
    resetDataTransferValidation();
    const revision = migrationState.revision, user = UserStore.user;
    const current = () => revision === migrationState.revision && migrationState.mode === 'file'
        && UserStore.user === user && event.target.files?.[0] === file;
    document.getElementById('mig-file-name').textContent = file.name;
    setMigrationMessage('파일을 확인하는 중…');
    const reader = migrationState.reader = new FileReader();
    reader.onload = async event => {
        if (!current()) return;
        try {
            const bytes = new Uint8Array(event.target.result);
            let rows;
            if (/\.csv$/i.test(file.name)) {
                let decoded;
                try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
                catch (_) { throw new Error('UTF-8 형식의 CSV 파일을 선택해주세요.'); }
                rows = AppDataTransfer.parseCsv(decoded);
            } else if (/\.xlsx?$/i.test(file.name)) {
                // 이전 HTML에 이미 준비된 XLSX도 같은 API로 사용할 수 있다.
                const spreadsheet = typeof window.AppSpreadsheet?.load === 'function'
                    ? await window.AppSpreadsheet.load() : window.XLSX;
                if (!current()) return;
                if (typeof spreadsheet?.read !== 'function' || typeof spreadsheet?.utils?.sheet_to_json !== 'function') {
                    throw Object.assign(new Error('Excel 파일 도구를 준비하지 못했습니다. 페이지를 새로고침한 뒤 다시 선택해주세요.'),
                        { code: 'SPREADSHEET_LOAD_FAILED' });
                }
                const workbook = spreadsheet.read(bytes, { type: 'array' });
                if (!workbook.SheetNames.includes('MyCard')) throw new Error('"MyCard" 시트를 찾을 수 없습니다.');
                rows = spreadsheet.utils.sheet_to_json(workbook.Sheets.MyCard, { header: 1 });
            } else throw new Error('Excel 또는 UTF-8 CSV 파일을 선택해주세요.');
            const preview = AppDataTransfer.parseRows(rows);
            pendingMigrationData = preview.data;
            migrationState.owner = user;
            setMigrationMessage(migrationPreviewMessage(preview), preview.legacyQuantity || preview.skippedZeroCount ? 'color-text-001' : 'color-text-theme', 'check_circle');
            document.getElementById('migration-exec-btn').disabled = false;
        } catch (error) {
            if (!current()) return;
            pendingMigrationData = null;
            const message = error.code === 'SPREADSHEET_LOAD_FAILED' || error.message.startsWith('가져올 카드가 없습니다.')
                ? error.message : '양식에 맞는 파일을 골라주세요.';
            setMigrationMessage(message, 'color-text-red', 'error');
        } finally { if (current()) migrationState.reader = null; }
    };
    reader.onerror = () => { if (current()) setMigrationMessage('파일을 읽지 못했습니다. 다시 선택해주세요.', 'color-text-red', 'error'); };
    reader.readAsArrayBuffer(file);
}

function openMigrationModal(mode = 'sheet') {
    if (migrationState.busy || dataClearBusy) return;
    const modal = document.getElementById('migration-modal');
    resetDataTransferValidation();
    document.getElementById('migration-sheet-url').value = '';
    document.getElementById('migration-file-input').value = '';
    document.getElementById('mig-file-name').textContent = '파일 선택';
    toggleMigrationTab(mode);
    getAppModal(modal).open();
}

function getMigrationSheetId(value) {
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.hostname !== 'docs.google.com') return null;
        return url.pathname.match(/^\/spreadsheets\/d\/([\w-]{25,})(?:\/|$)/)?.[1] || null;
    } catch (_) { return null; }
}

function validateMigrationLink() {
    if (migrationState.busy || migrationState.mode !== 'sheet') return;
    resetDataTransferValidation();
    const input = document.getElementById('migration-sheet-url');
    const url = input.value.trim(), id = getMigrationSheetId(url);
    if (!url) return;
    if (!id) { setMigrationMessage('올바른 구글 시트 링크를 입력해주세요.', 'color-text-red', 'error'); return; }
    const revision = migrationState.revision, user = UserStore.user;
    const current = () => revision === migrationState.revision && migrationState.mode === 'sheet'
        && UserStore.user === user && input.value.trim() === url;
    setMigrationMessage('시트와 수량을 확인하는 중…');
    migrationValidationTimeout = setTimeout(async () => {
        try {
            const result = await callApi('checkSheet', { targetId: id });
            if (!current()) return;
            if (result?.status === 'OK' && result.fingerprint && Number.isSafeInteger(result.totalQty) && result.totalQty > 0) {
                migrationState.sheet = { id, url, fingerprint: result.fingerprint };
                migrationState.owner = user;
                setMigrationMessage(migrationPreviewMessage(result), result.legacyQuantity || result.skippedZeroCount ? 'color-text-001' : 'color-text-theme', 'check_circle');
                document.getElementById('migration-exec-btn').disabled = false;
            } else if (result?.status === 'NO_ACCESS') {
                setMigrationMessage('공개·링크 공유 및 다운로드 허용 설정을 확인해 주세요.', 'color-text-001', 'warning');
            } else setMigrationMessage(result?.message || '시트 데이터를 확인할 수 없습니다. 서버의 가져오기 기능을 확인해주세요.', 'color-text-red', 'error');
        } catch (_) {
            if (current()) setMigrationMessage('시트 연결 확인에 실패했습니다. 다시 확인해주세요.', 'color-text-red', 'error');
        }
    }, 500);
}

async function executeMigration() {
    if (!requireInventoryReady()) return;
    if (migrationState.busy || dataClearBusy || document.getElementById('migration-exec-btn').disabled) return;
    if (!checkAuthBeforeAction()) return;
    if (migrationState.owner !== UserStore.user) {
        resetDataTransferValidation();
        setMigrationMessage('계정이 변경되었습니다. 파일 또는 시트 주소를 다시 확인해주세요.', 'color-text-001');
        return;
    }
    const fileMode = migrationState.mode === 'file';
    if (fileMode ? !pendingMigrationData : !migrationState.sheet
        || migrationState.sheet.url !== document.getElementById('migration-sheet-url').value.trim()) return;
    const payload = fileMode ? { data: pendingMigrationData } : {
        spreadsheetId: migrationState.sheet.id, fingerprint: migrationState.sheet.fingerprint
    };
    const user = UserStore.user;
    migrationState.busy = true;
    setDataTransferBusy('migration-modal', true);
    setMigrationMessage('카드 데이터를 가져오는 중입니다. 완료될 때까지 창을 닫을 수 없습니다.');
    let result;
    try {
        if (!window.YgoImportAttempt) throw new Error('가져오기 도구를 준비하지 못했습니다. 페이지를 새로고침해 주세요.');
        const action = fileMode ? 'migrateFromData' : 'migrateFromSheet';
        result = await window.YgoImportAttempt.execute({ uid: user.uid, source: fileMode ? 'file' : 'sheet', payload,
            bindGeneration: globalThis.AppBackend?.id === 'supabase',
            send: (query, body) => callApi(action, query, body), isCurrent: () => UserStore.user === user });
        if (UserStore.user === user && !result?.success) throw new Error(result?.message || '가져오기에 실패했습니다.');
    } catch (error) {
        if (UserStore.user === user) {
            if (error.code === 'SHEET_CHANGED') {
                migrationState.sheet = null;
                const lock = dataTransferLocks.get('migration-modal');
                lock.controls = lock.controls.map(([control, disabled]) => [control, control.id === 'migration-exec-btn' ? true : disabled]);
            }
            setMigrationMessage(error.message || '서버 통신 중 오류가 발생했습니다.', 'color-text-red', 'error');
        }
        result = null;
    } finally {
        setDataTransferBusy('migration-modal', false);
        migrationState.busy = false;
    }
    if (UserStore.user !== user) { resetDataTransferValidation(); return; }
    if (!result?.success) return;
    M.Modal.getInstance(document.getElementById('migration-modal')).close();
    showMigrationResultModal(result);
    cardCacheInstance.clearAll();
    try { await loadUserData(); }
    catch (_) { if (UserStore.user === user) showToast('가져오기는 완료되었습니다. 보유 정보 새로고침을 다시 시도해주세요.', 'toast-warn'); }
}

function toggleMigrationResultView(view) {
    AppManagementResults.setView(document.getElementById('migration-result-modal'), view);
}

function showMigrationResultModal(result) {
    const modal = document.getElementById('migration-result-modal');
    const items = Array.isArray(result.importedItems)
        ? result.importedItems.map((item, index) => ({ ...item, no: index + 1, status: 'success', processedQty: item.qty })) : [];
    AppManagementResults.render(modal, items, {
        formatIllustration: IllustrationImages.label, formatRarity: getLocalizedRarity
    });
    if (!Array.isArray(result.importedItems)) {
        // updatedItems는 최종 보유량이다. 추가량이나 성공 집계를 추정하지 않는다.
        document.getElementById('migration-success-text').textContent = '가져오기가 완료되었습니다. 이 서버 응답에서는 추가 매수와 상세 집계를 확인할 수 없습니다.';
    }
    toggleMigrationResultView('summary');
    getAppModal(modal).open();
}

function openLegacyDataImport() {
    if (!checkAuthBeforeAction()) return;
    M.Modal.getInstance(document.getElementById('legacy-migration-modal')).close();
    switchToMode('settings');
    openMigrationModal('file');
}

function checkAuthBeforeAction() {
    if (!UserStore.user) {
        toggleAuthModal();
        showToast('로그인이 필요합니다.', 'toast-warn');
        return false;
    }
    return true;
}



// 모든 선언과 DOM 파싱이 끝난 defer 실행에서 인증 조회를 시작한다. 화면 적용은 준비 장벽을 따른다.

// VisualViewport API를 활용한 키보드 감지 및 하단 바 숨김 기능 (모바일)
(function initNavVisibilityControl() {
    const isMobile = document.documentElement.classList.contains('is-mobile-device');
    if (!isMobile) return;

    if (!window.visualViewport) return;

    let initialHeight = window.visualViewport.height;

    const handleResize = () => {
        const currentHeight = window.visualViewport.height;
        // 높이가 초기 높이의 75% 미만으로 줄어들면 키보드가 올라온 것으로 판단
        if (currentHeight < initialHeight * 0.75) {
            document.documentElement.classList.add('nav-hidden');
        } else {
            document.documentElement.classList.remove('nav-hidden');
            // 초기 높이보다 커지는 경우(회전 등) 대응
            if (currentHeight > initialHeight) {
                initialHeight = currentHeight;
            }
        }
    };

    window.visualViewport.addEventListener('resize', handleResize);
})();

function updateTotals() {
    if (UserStore.user && UserStore.inventorySyncStatus !== 'ready') { setInventorySyncStatus(UserStore.inventorySyncStatus); return; }
    const totalCount = cardCacheInstance.getAmount();
    const totalElem = document.getElementById('total-cards');
    if (totalElem) totalElem.innerText = totalCount;

    const kindCount = cardCacheInstance.getOwnedNumbers().length;
    const kindElem = document.getElementById('kind-cards');
    if (kindElem) kindElem.innerText = kindCount;

    // 대시보드 통계도 함께 업데이트
    if (typeof updateDashboardStats === 'function') updateDashboardStats();
}

/**
 * 이용약관 및 개인정보 처리방침 모달 제어 (해시 연동)
 */
async function openLicensesModal(e) {
    e?.preventDefault();
    const panel = document.getElementById('licenses-modal');
    getAppModal(panel).open(e?.currentTarget ? [e.currentTarget] : undefined);
    const content = document.getElementById('licenses-content');
    content.textContent = '불러오는 중...';
    try {
        const response = await fetch('licenses.html');
        if (!response.ok) throw new Error('문서 조회 실패');
        const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
        const main = doc.querySelector('main');
        main.querySelector('h1')?.remove(); main.querySelector(':scope > a[href="/"]')?.remove();
        content.innerHTML = sanitizeNoticeHtml(main.innerHTML.replace(/\r?\n/g, ''));
    } catch (error) { content.textContent = '문서를 불러오지 못했습니다. 자세히보기에서 원문을 확인해 주세요.'; }
}

function openTermsModal(e) {
    if (e && e.preventDefault) e.preventDefault();
    const modal = document.getElementById('terms-modal');
    if (modal) {
        const inst = M.Modal.getInstance(modal);
        if (inst) inst.open();

        // 현재 해시가 약관 관련이 아닐 때만 이전 해시로 저장 (덮어쓰기 방지)
        const currentHash = window.location.hash;
        if (currentHash !== '#terms' && currentHash !== '#privacy') {
            UIStore.lastHashBeforeModal = currentHash;
        }

        // 해시 업데이트 (URL에 명시적으로 노출)
        if (window.location.hash !== '#terms') {
            window.history.pushState(null, null, '#terms');
        }
    }
}

function openPrivacyModal(e) {
    if (e && e.preventDefault) e.preventDefault();
    const modal = document.getElementById('privacy-modal');
    if (modal) {
        const inst = M.Modal.getInstance(modal);
        if (inst) inst.open();

        // 이전 해시 저장
        const currentHash = window.location.hash;
        if (currentHash !== '#terms' && currentHash !== '#privacy') {
            UIStore.lastHashBeforeModal = currentHash;
        }

        // 해시 업데이트
        if (window.location.hash !== '#privacy') {
            window.history.pushState(null, null, '#privacy');
        }
    }
}

/**
 * URL 해시를 확인하여 해당하는 모달을 자동으로 오픈
 */
function checkUrlHashForModals() {
    const hash = window.location.hash;
    if (hash === '#terms') {
        const modal = document.getElementById('terms-modal');
        if (modal) {
            const inst = M.Modal.getInstance(modal);
            if (inst) inst.open();
        }
    } else if (hash === '#privacy') {
        const modal = document.getElementById('privacy-modal');
        if (modal) {
            const inst = M.Modal.getInstance(modal);
            if (inst) inst.open();
        }
    }
}

// 이벤트 리스너 등록 (새로고침 시 유지 및 URL 직접 접근 지원)
window.addEventListener('load', checkUrlHashForModals);
/**
 * 데이터 내보내기 모달 열기
 */
function openExportModal() {
    if (!requireInventoryReady()) return;
    if (!checkAuthBeforeAction()) return;
    const qtyElem = document.getElementById('export-total-qty');
    if (qtyElem) {
        const totalAmount = cardCacheInstance.getAmount() || 0;
        qtyElem.textContent = totalAmount.toLocaleString() + '장';
    }
    const modalElem = document.getElementById('export-modal');
    if (modalElem) getAppModal(modalElem).open();
}

/**
 * 보유 인벤토리 데이터를 CSV 파일로 내보내기
 */
function exportInventoryToCSV() {
    if (!requireInventoryReady()) return;
    if (!checkAuthBeforeAction()) return;
    const data = cardCacheInstance.getInventory();
    if (!data || data.length === 0) {
        showToast('내보낼 데이터가 없습니다.', 'toast-warn');
        return;
    }

    const csvContent = AppDataTransfer.toCsv(data.map(row => [
        row[0], row[1], getLocalizedRarity(row[2]), row[3], row[4], row[5]
    ]));

    // [사용자 요청] 크롬 호환성을 위한 정석적인 다운로드 로직 적용
    // 1. Blob 생성 (BOM 포함)
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });

    // 2. ObjectURL 생성
    const url = window.URL.createObjectURL(blob);

    // 3. <a> 태그 생성
    const a = document.createElement('a');

    // 4. 파일명 구성 (YYYYMMDD 형식 포함)
    const now = new Date();
    const dateStr = now.getFullYear() + String(now.getMonth() + 1).padStart(2, '0') + String(now.getDate()).padStart(2, '0');
    const fileName = `YGO_Synapse_Export_${dateStr}.csv`;

    // 5. href 및 download 속성 할당
    a.href = url;
    a.download = fileName;
    a.hidden = true;

    // 6. document.body에 명시적으로 추가 (크롬에서 download 속성 활성화를 위해 필수)
    document.body.appendChild(a);

    // 7. 클릭하여 다운로드 트리거
    a.click();

    // [정리] DOM에서 제거 및 메모리 해제
    setTimeout(() => {
        a.remove();
        window.URL.revokeObjectURL(url);
    }, 100);

    const modalElem = document.getElementById('export-modal');
    if (modalElem) M.Modal.getInstance(modalElem).close();

    showToast('데이터를 내보냈습니다.', 'toast-success');
}

// [정리] window.addEventListener('hashchange', checkUrlHashForModals) 제거. handleHashChange 단일 리스너로 통합 관리됨.

// ============================================
// 상위 탭 / 하위 칩 (Chip) 커스텀 레이아웃 관리 함수
// ============================================


function switchManageTab(tab) {
    if (tab === UIStore.mode) return;
    switchToMode(tab);
}

let isRenameMode = false; // 보관 위치 이름 변경 모드 상태
let isDeleteLocationMode = false; // 보관 위치 삭제 모드 상태
let isDeleteLocationConfirmPending = false; // 보관 위치 삭제 복구 불가 확인 대기 상태
let deleteLocationSubmitting = false;

function openPhotoRegistration() {
    if (!window.PhotoCardSearch) return;
    PhotoCardSearch.openRegistrationSheet();
}

function handleManageUI(mode, preserveInputNodes = false) {
    const radioEl = document.getElementById('tab-mode-' + mode);
    if (radioEl) radioEl.checked = true;

    const forms = [
        document.getElementById('general-mode-wrapper'),
        document.getElementById('manage-move-wrapper'),
        document.getElementById('manage-discard-wrapper')
    ];

    const targetId = { add: 'general-mode-wrapper', move: 'manage-move-wrapper', discard: 'manage-discard-wrapper' }[mode];
    const autoLocInfo = document.getElementById('manage-auto-loc-container');
    setModePanelActive(autoLocInfo, mode === 'add');

    // 크로스페이드 처리 (CSS transition: height에 맡김)
    forms.forEach(f => {
        setModePanelActive(f, f?.id === targetId);
    });

    // [통합] 공통 하단 푸터 업데이트
    updateManageFooter(mode);

    if (typeof resizeGrid === 'function') resizeGrid();

    // 검색에서 돌아올 때는 공백·원시 값·선택 상태까지 작성 중인 노드를 유지한다.
    if (preserveInputNodes) return;

    // 관리 페이지 진입 및 탭 전환 시 신버전 카드 렌더링 및 올바른 모드로 바인딩
    if (document.documentElement.classList.contains('is-mobile-device')) {
        if (typeof renderMobileCards === 'function') renderMobileCards();
    } else {
        if (typeof renderDesktopCards === 'function') renderDesktopCards();
    }
}



function measureManageActionWidth(button, label) {
    const measure = document.createElement('span');
    const buttonStyle = getComputedStyle(button);
    measure.className = 'manage-footer-text-measure';
    measure.style.fontSize = buttonStyle.fontSize;
    measure.style.fontWeight = buttonStyle.fontWeight;
    measure.innerText = label;
    document.body.appendChild(measure);
    const textWidth = measure.offsetWidth;
    measure.remove();
    return textWidth + 28;
}

function updateManageFooter(mode) {
    const footer = document.getElementById('manage-common-footer');
    const leftEl = document.getElementById('manage-footer-left');
    const rightEl = document.getElementById('manage-footer-right');
    if (!footer || !leftEl || !rightEl) return;

    if (mode !== 'move') {
        isRenameMode = false;
    }
    if (mode !== 'discard') {
        isDeleteLocationMode = false;
        isDeleteLocationConfirmPending = false;
    }


    // 1. 좌측 버튼 설정 정의 (버튼 2개 기준)
    let leftButtons = [];
    if (mode === 'move') {
        if (isRenameMode) {
            leftButtons = [
                { text: '일괄 이동', onclick: "submitBulkMoveEntries()", type: 'primary' },
                { text: '취소', onclick: "toggleRenameMode()", type: 'flat' }
            ];
        } else {
            leftButtons = [
                { text: '일괄 이동', onclick: "toggleRenameMode()" },
                { text: null, hide: true } // 두 번째 버튼 숨김
            ];
        }
    } else if (mode === 'discard') {
        if (isDeleteLocationMode) {
            leftButtons = [
                { text: isDeleteLocationConfirmPending ? '복구 불가 확인' : '위치 삭제', onclick: "submitDeleteLocation()", type: 'danger' },
                { text: '취소', onclick: "toggleDeleteLocationMode()", type: 'flat' }
            ];
        } else {
            leftButtons = [
                { text: '위치 삭제', onclick: "toggleDeleteLocationMode()" },
                { text: null, hide: true } // 두 번째 버튼 숨김
            ];
        }
    }

    // 2. 내용물 업데이트 전 상태 표시 (클릭 방지 및 텍스트 페이드아웃)
    footer.classList.add('is-updating');

    // 지연 제거: 즉시 내용물 교체 및 너비 애니메이션 시작하여 상단 콘텐츠와 동기화
    const updateContent = () => {
        // [좌측 버튼 처리] 버튼 그룹 wrapper를 확보하여 버튼이 커져도 외부 레이아웃이 영향받지 않게 고정폭 부여
        let btnWrapper = leftEl.querySelector('.manage-footer-btn-group');
        if (!btnWrapper) {
            btnWrapper = document.createElement('div');
            btnWrapper.className = 'manage-footer-btn-group';
            // leftEl의 맨 앞에 삽입
            leftEl.insertBefore(btnWrapper, leftEl.firstChild);
        }

        let currentBtns = btnWrapper.querySelectorAll('.btn-manage-action');

        // 버튼이 없으면 초기 생성
        if (currentBtns.length === 0) {
            btnWrapper.innerHTML = Array.from({ length: 3 }, () => '<button class="btn-manage-action waves-effect"><span class="btn-text-content"></span></button>').join('');
            currentBtns = btnWrapper.querySelectorAll('.btn-manage-action');
        }

        currentBtns.forEach((btn, idx) => {
            if (idx >= leftButtons.length) {
                btn.classList.add('btn-hidden');
                btn.setAttribute('aria-hidden', 'true');
                btn.setAttribute('tabindex', '-1');
            }
        });

        leftButtons.forEach((btnInfo, idx) => {
            const btn = currentBtns[idx];
            if (!btn) return;

            if (btnInfo.hide) {
                btn.classList.add('btn-hidden');
                btn.setAttribute('aria-hidden', 'true');
                btn.setAttribute('tabindex', '-1');
            } else {
                btn.classList.remove('btn-hidden');
                btn.setAttribute('aria-hidden', 'false');
                btn.setAttribute('tabindex', '0');

                const allSpans = Array.from(btn.querySelectorAll('.btn-text-content'));
                const oldTextSpan = allSpans.find(s => s.classList.contains('active')) || allSpans[allSpans.length - 1];
                const newText = btnInfo.text;

                // 텍스트가 바뀔 때만 크로스페이드 수행
                if (oldTextSpan && oldTextSpan.innerText !== newText) {
                    // [중요] 이미 진행 중인 다른 모든 span들을 즉시 제거하여 쌓임 방지
                    allSpans.forEach(s => {
                        if (s !== oldTextSpan) s.remove();
                    });

                    btn.style.width = `${measureManageActionWidth(btn, newText)}px`;

                    oldTextSpan.classList.remove('active');
                    oldTextSpan.classList.add('outgoing');

                    const newTextSpan = document.createElement('span');
                    newTextSpan.className = 'btn-text-content incoming';
                    newTextSpan.innerText = newText;
                    btn.appendChild(newTextSpan);

                    // 강제 리플로우 후 활성화
                    void newTextSpan.offsetWidth;
                    newTextSpan.classList.remove('incoming');
                    newTextSpan.classList.add('active');

                    // 애니메이션 후 정리 (속도 개선에 맞춰 0.3s로 조정 가능)
                    setTimeout(() => {
                        if (oldTextSpan.parentNode === btn) btn.removeChild(oldTextSpan);
                    }, 400);
                } else if (allSpans.length === 0) {
                    // 초기 상태 처리
                    btn.innerHTML = `<span class="btn-text-content active">${newText}</span>`;
                    btn.style.width = `${measureManageActionWidth(btn, newText)}px`;
                }

                btn.setAttribute('onclick', btnInfo.onclick);

                const isPrimary = btnInfo.type === 'primary';
                const isDanger = btnInfo.type === 'danger';
                btn.classList.toggle('is-action-primary', isPrimary);
                btn.classList.toggle('is-action-danger', isDanger);
                btn.classList.toggle('btn', isPrimary || isDanger);
                btn.classList.toggle('waves-light', isPrimary || isDanger);
                btn.classList.toggle('btn-flat', btnInfo.type === 'flat');
            }
        });

        // 일괄 이동 모드 또는 제거(위치 삭제) 모드 시 입력란을 좌측 영역 끝에 추가 (캡슐형 스타일)
        if ((mode === 'move' && isRenameMode) || (mode === 'discard' && isDeleteLocationMode)) {
            const inputContainerId = 'rename-inputs-container';
            let inputContainer = document.getElementById(inputContainerId);
            if (!inputContainer) {
                inputContainer = document.createElement('div');
                inputContainer.id = inputContainerId;
                inputContainer.className = 'manage-footer__location-fields';
                leftEl.appendChild(inputContainer);
            }

            if (mode === 'move') {
                inputContainer.innerHTML = `
                    <div class="custom-select-wrapper no-arrow rename-capsule-wrap" id="wrap-rename-from" data-type="strict">
                        <input type="text" id="rename-from-input" class="manage-footer__location-input browser-default" placeholder="대상 위치" autocomplete="off">
                    </div>
                    <div class="custom-select-wrapper no-arrow rename-capsule-wrap" id="wrap-rename-to" data-type="free">
                        <input type="text" id="rename-to-input" class="manage-footer__location-input browser-default" placeholder="이동할 위치" autocomplete="off" disabled>
                    </div>
                `;

                const fromWrap = document.getElementById('wrap-rename-from');
                const toWrap = document.getElementById('wrap-rename-to');

                if (typeof cardCacheInstance !== 'undefined') {
                    const locations = cardCacheInstance.getAllLocations().map(l => ({ val: l, text: l }));
                    fromWrap.dataset.options = JSON.stringify(locations);
                    toWrap.dataset.options = JSON.stringify(locations);
                }

                setupCustomDropdown(fromWrap, handleRenameFromChange);
                setupCustomDropdown(toWrap, null);
            } else if (mode === 'discard') {
                let deleteWrap = document.getElementById('wrap-delete-location');
                if (!deleteWrap) {
                    inputContainer.innerHTML = `
                        <div class="custom-select-wrapper no-arrow rename-capsule-wrap" id="wrap-delete-location" data-type="strict">
                            <input type="text" id="delete-location-input" class="manage-footer__location-input browser-default" placeholder="삭제할 위치" autocomplete="off">
                        </div>
                    `;

                    deleteWrap = document.getElementById('wrap-delete-location');
                    setupCustomDropdown(deleteWrap, handleDeleteLocationChange);

                    const deleteInput = document.getElementById('delete-location-input');
                    if (deleteInput && !deleteInput._isInputBound) {
                        deleteInput._isInputBound = true;
                        deleteInput.addEventListener('input', () => {
                            if (isDeleteLocationConfirmPending) {
                                isDeleteLocationConfirmPending = false;
                                updateManageFooter('discard');
                            }
                        });
                    }
                }

                if (deleteWrap && typeof cardCacheInstance !== 'undefined') {
                    const locations = getDeletableLocations().map(l => ({ val: l, text: l }));
                    deleteWrap.dataset.options = JSON.stringify(locations);
                }
            }
        } else {
            const inputContainer = document.getElementById('rename-inputs-container');
            if (inputContainer) inputContainer.remove();
        }

        // [우측 영역 처리] 
        rightEl.innerHTML = '';
        if (mode === 'add') {
            rightEl.innerHTML = `<button type="button" id="manage-primary-btn" class="ui-button color-theme manage-footer__primary" onclick="submitPageEntries()" tabindex="0">등록</button>`;
        } else if (mode === 'move') {
            rightEl.innerHTML = `<button type="button" id="manage-primary-btn" class="ui-button color-theme manage-footer__primary" onclick="submitMoveEntries()" tabindex="0">이동</button>`;
        } else if (mode === 'discard') {
            rightEl.innerHTML = `<button type="button" id="manage-primary-btn" class="ui-button color-theme manage-footer__primary" onclick="submitDiscardEntries()" tabindex="0">제거</button>`;
        }

        requestAnimationFrame(() => {
            footer.classList.remove('is-updating');
        });
    };

    // 브라우저 렌더링 주기에 맞춰 지연 없이 실행
    requestAnimationFrame(updateContent);
}

function toggleRenameMode() {
    isRenameMode = !isRenameMode;
    updateManageFooter('move');
}



// 행을 다시 만들지 않고 표시 순서에 맞는 공통 색상·접합 상태만 갱신한다.
function updateManagementCardStack(cards) {
    cards.forEach((card, idx) => {
        card.classList.add('ui-stack-card', 'shape-rounded003');
        card.classList.toggle('color-card-odd', idx % 2 === 0);
        card.classList.toggle('color-card-even', idx % 2 !== 0);
        card.classList.toggle('is-joined-before', idx > 0);
        card.classList.toggle('is-joined-after', idx < cards.length - 1);
    });
}

function getMobileCardHtml(idx, nextNum, data) {
    const isMove = (UIStore.mode === 'move');
    const isDiscard = (UIStore.mode === 'discard');

    let nameClass = 'page-card-name';
    let noClass = 'page-card-no';
    let illustClass = 'page-card-illustration';
    let rareClass = 'page-card-rarity';
    let locClass = 'page-card-loc';
    let qtyClass = 'page-card-qty';

    if (isMove) {
        nameClass = 'card-name-input';
        noClass = 'move-card-no';
        illustClass = 'move-card-illustration';
        rareClass = 'move-card-rarity';
        locClass = 'move-card-from';
        qtyClass = 'move-card-qty';
    } else if (isDiscard) {
        nameClass = 'card-name-input';
        noClass = 'discard-card-no';
        illustClass = 'discard-card-illustration';
        rareClass = 'discard-card-rarity';
        locClass = 'discard-card-loc';
        qtyClass = 'discard-card-qty';
    }
    
    let displayName = data.name || '';
    if (!displayName) {
        if (data.searchMode === 'fetching') displayName = "조회 중...";
        else displayName = "카드 추가";
    }
    
    const cardNo = data.cardNo || '';
    const illust = IllustrationImages.label(data.illustration) || '';
    const rarity = data.rarity ? getLocalizedRarity(data.rarity) : '';
    const loc = data.loc || '';
    const to = data.to || '';
    const qty = (data.qty && parseInt(data.qty) > 0) ? parseInt(data.qty) : null;

    const actionsHtml = isDiscard ? `
        <button type="button" class="btn-card-action delete ui-button ui-button--text color-text-table ui-control--disabled" onclick="triggerMobileDelete(${idx})" title="제거" aria-label="제거"><i class="material-icons" aria-hidden="true">delete</i></button>
    ` : `
        <button type="button" class="btn-card-action copy ui-button ui-button--text color-text-table" onclick="triggerMobileCopy(${idx})" title="복제" aria-label="복제"><i class="material-icons" aria-hidden="true">library_add</i></button>
        <button type="button" class="btn-card-action delete ui-button ui-button--text color-text-table ui-control--disabled" onclick="triggerMobileDelete(${idx})" title="제거" aria-label="제거"><i class="material-icons" aria-hidden="true">delete</i></button>
    `;

    const bottomBadges = isMove ? `
        <span class="card-info-badge color-text-table illust">${escapeHTML(illust || '일러스트')}</span>
        <span class="card-info-badge color-text-table rarity">${escapeHTML(rarity || '레어도')}</span>
        <span class="card-info-badge color-text-table location">${escapeHTML(loc || '보관 위치')}</span>
        <i class="material-icons loc-arrow color-text-table">arrow_forward</i>
        <span class="card-info-badge color-text-table location to-loc">${escapeHTML(to || '이동 위치')}</span>
        <span class="card-info-badge color-text-table qty">${qty !== null ? qty + '장' : '수량'}</span>
    ` : `
        <span class="card-info-badge color-text-table illust">${escapeHTML(illust || '일러스트')}</span>
        <span class="card-info-badge color-text-table rarity">${escapeHTML(rarity || '레어도')}</span>
        <span class="card-info-badge color-text-table location">${escapeHTML(loc || '보관 위치')}</span>
        <span class="card-info-badge color-text-table qty">${qty !== null ? qty + '장' : '수량'}</span>
    `;

    return `
        <div class="mobile-info-card ui-stack-card shape-rounded003 ${idx % 2 === 0 ? 'color-card-odd' : 'color-card-even'}" data-index="${idx}" onclick="handleMobileCardClick(event)">
            <div class="card-row-top">
                <span class="card-num-badge">${nextNum}</span>
                <span class="card-num-divider color-text-table" aria-hidden="true">|</span>
                <button type="button" class="card-title-text ui-button ui-button--text color-text-table" aria-haspopup="dialog" aria-controls="mobile-entry-bottom-sheet">${escapeHTML(displayName)}</button>
                <span class="card-code-text color-text-table">${escapeHTML(cardNo || '-')}</span>
                <div class="card-actions">
                    ${actionsHtml}
                </div>
            </div>
            <div class="card-row-bottom">
                ${bottomBadges}
            </div>

            <div class="mobile-card-fields card-info-fields" hidden>
                <!-- 카드 이름 -->
                <div class="sheet-form-field">
                    <label class="color-text-001">카드 이름</label>
                    <div class="custom-select-wrapper sheet-input-box border-basic shape-rounded002 color-text-000 no-arrow" onclick="openSheetOverlay('name', event)">
                        <input type="text" class="custom-input browser-default ${nameClass}" data-field="name" value="${escapeHTML(data.name || '')}" placeholder="카드 이름 입력" oninput="handleCardNameInput(this)" onblur="fetchCardByName(this)" onkeydown="if(event.isComposing && (event.key==='Enter' || event.key==='Tab')) { event.preventDefault(); return; } if(this.hasAttribute('readonly') && (event.key==='Escape' || event.key==='Backspace' || event.key==='Delete')) { clearPageNameAndNo(this); event.preventDefault(); return; } if(event.key==='Enter') { this.blur(); }" autocomplete="off" readonly>
                        <button type="button" class="ui-button ui-button--text clear-name-btn clear-btn" aria-label="카드 이름 지우기" onclick="clearBottomSheetField('name', event)" hidden><i class="material-icons" aria-hidden="true">cancel</i></button>
                    </div>
                </div>
                <!-- 카드 번호 -->
                <div class="sheet-form-field">
                    <label class="color-text-001">카드 번호</label>
                    <div class="custom-select-wrapper sheet-input-box border-basic shape-rounded002 color-text-000 no-arrow" onclick="openSheetOverlay('no')">
                        <input type="text" class="custom-input browser-default ${noClass}" data-field="no" value="${escapeHTML(cardNo)}" placeholder="카드 번호 입력" oninput="handleCardNoInput(this)" onblur="fetchCardByNumber(this)" onkeydown="if(event.key==='Enter' && !this.closest('.custom-select-wrapper').classList.contains('active')) fetchCardByNumber(this)" autocomplete="off" readonly>
                        <i class="material-icons arrow-icon" aria-hidden="true">arrow_drop_down</i>
                        <button type="button" class="ui-button ui-button--text clear-btn" aria-label="카드 번호 지우기" onclick="clearBottomSheetField('no', event)" hidden><i class="material-icons" aria-hidden="true">cancel</i></button>
                    </div>
                </div>
                <!-- 일러스트 & 레어도 -->
                <div class="sheet-form-row">
                    <div class="sheet-form-field">
                        <label class="color-text-001">일러스트</label>
                        <div class="custom-select-wrapper sheet-input-box border-basic shape-rounded002 color-text-000 no-option" data-field-wrap="illust" data-type="strict" onclick="openSheetDropdownOverlay('illust')">
                            <input type="text" class="custom-input browser-default ${illustClass}" data-field="illust" inputmode="none" role="button" aria-label="일러스트 선택" aria-haspopup="dialog" aria-expanded="false" data-raw="${escapeHTML(data.illustration || '')}" value="${escapeHTML(illust)}" placeholder="일러스트" readonly>
                            <span class="card-info-field-value" aria-hidden="true"></span>
                            <i class="material-icons arrow-icon" aria-hidden="true">arrow_drop_down</i>
                        </div>
                    </div>
                    <div class="sheet-form-field">
                        <label class="color-text-001">레어도</label>
                        <div class="custom-select-wrapper sheet-input-box border-basic shape-rounded002 color-text-000 no-option" data-field-wrap="rare" data-type="strict" onclick="openSheetDropdownOverlay('rare')">
                            <input type="text" class="custom-input browser-default ${rareClass}" data-field="rare" value="${escapeHTML(data.rarity || '')}" placeholder="레어도" readonly>
                            <span class="card-info-field-value" aria-hidden="true"></span>
                            <i class="material-icons arrow-icon" aria-hidden="true">arrow_drop_down</i>
                        </div>
                    </div>
                </div>
                <!-- 보관 위치 & 이동 위치 & 수량 -->
                <div class="sheet-form-row">
                    <div class="sheet-form-field">
                        <label class="color-text-001">보관 위치</label>
                        <div class="custom-select-wrapper sheet-input-box border-basic shape-rounded002 color-text-000 no-option" data-field-wrap="loc" data-type="${isMove || isDiscard ? 'strict' : 'free'}" onclick="openSheetOverlay('loc')">
                            <input type="text" class="custom-input browser-default ${locClass}" data-field="loc" value="${escapeHTML(loc)}" placeholder="보관 위치" readonly>
                            <span class="card-info-field-value" aria-hidden="true"></span>
                            <i class="material-icons arrow-icon" aria-hidden="true">arrow_drop_down</i>
                        </div>
                    </div>
                    <div class="sheet-form-field"${isMove ? '' : ' hidden'}>
                        <label class="color-text-001">이동 위치</label>
                        <div class="custom-select-wrapper sheet-input-box border-basic shape-rounded002 color-text-000" data-field-wrap="to" data-type="free" onclick="openSheetOverlay('to')">
                            <input type="text" class="custom-input browser-default move-card-to" data-field="to" value="${escapeHTML(to)}" placeholder="이동 위치" readonly>
                            <span class="card-info-field-value" aria-hidden="true"></span>
                            <i class="material-icons arrow-icon" aria-hidden="true">arrow_drop_down</i>
                        </div>
                    </div>
                    <div class="sheet-form-field">
                        <label class="color-text-001">수량</label>
                        <div class="custom-select-wrapper sheet-input-box border-basic shape-rounded002 color-text-000 no-arrow" data-field-wrap="qty" onclick="openSheetOverlay('qty')">
                            <input type="number" class="custom-input browser-default ${qtyClass} qty-input" data-field="qty" value="${qty !== null ? qty : ''}" placeholder="수량" min="1" readonly oninput="handleCardQtyInput(this)">
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
}

function updateMobileCardDisplay(cardEl) {
    if (!cardEl) return;
    const nameInp = cardEl.querySelector('[data-field="name"]');
    const noInp = cardEl.querySelector('[data-field="no"]');
    const illustInp = cardEl.querySelector('[data-field="illust"]');
    const rareInp = cardEl.querySelector('[data-field="rare"]');
    const locInp = cardEl.querySelector('[data-field="loc"]');
    const toInp = cardEl.querySelector('[data-field="to"]');
    const qtyInp = cardEl.querySelector('[data-field="qty"]');

    let displayName = nameInp ? nameInp.value.trim() : '';
    if (!displayName) {
        if (cardEl.dataset.searchMode === 'fetching') displayName = "조회 중...";
        else displayName = "카드 추가";
    }

    const cardNo = noInp ? noInp.value.trim().toUpperCase() : '';
    const illust = IllustrationImages.label(getIllustrationValue(illustInp));
    const rarity = rareInp ? getLocalizedRarity(rareInp.dataset.raw || rareInp.value) : '';
    const loc = locInp ? locInp.value.trim() : '';
    const to = toInp ? toInp.value.trim() : '';
    const qty = qtyInp ? (parseInt(qtyInp.value) > 0 ? parseInt(qtyInp.value) : null) : null;

    const titleEl = cardEl.querySelector('.card-title-text');
    if (titleEl) titleEl.innerText = displayName;

    const codeEl = cardEl.querySelector('.card-code-text');
    if (codeEl) codeEl.innerText = cardNo || '-';

    const badgeIllust = cardEl.querySelector('.card-info-badge.illust');
    if (badgeIllust) badgeIllust.innerText = illust || '일러스트';

    const badgeRarity = cardEl.querySelector('.card-info-badge.rarity');
    if (badgeRarity) badgeRarity.innerText = rarity || '레어도';

    const badgeLocs = cardEl.querySelectorAll('.card-info-badge.location');
    if (badgeLocs.length > 0) {
        if (UIStore.mode === 'move') {
            badgeLocs[0].innerText = loc || '보관 위치';
            if (badgeLocs.length > 1) {
                badgeLocs[1].innerText = to || '이동 위치';
            }
        } else {
            badgeLocs[0].innerText = loc || '보관 위치';
        }
    }

    const badgeQty = cardEl.querySelector('.card-info-badge.qty');
    if (badgeQty) badgeQty.innerText = qty !== null ? `${qty}장` : '수량';
}

function renderMobileCardsFromData(dataArray, previousRows) {
    let listContainerId = 'mobile-cards-list-general';
    if (UIStore.mode === 'move') {
        listContainerId = 'mobile-cards-list-move';
    } else if (UIStore.mode === 'discard') {
        listContainerId = 'mobile-cards-list-discard';
    }

    const listContainer = document.getElementById(listContainerId);
    if (!listContainer) return;
    if (currentEditingRowIndex !== -1) return;

    const previousChildren = previousRows && [...listContainer.children];
    listContainer.innerHTML = '';

    if (dataArray.length === 0) {
        globalThis.AppOverlays?.restoreRowExits?.(listContainer, previousChildren);
        return;
    }

    dataArray.forEach((data, idx) => {
        const nextNum = idx + 1;
        const cardHtml = getMobileCardHtml(idx, nextNum, data);
        listContainer.insertAdjacentHTML('beforeend', cardHtml);

        const cardEl = listContainer.querySelector(`.mobile-info-card[data-index="${idx}"]`);
        if (cardEl) {
            if (data.searchMode) cardEl.dataset.searchMode = data.searchMode;
            if (data.cardData) cardEl.dataset.cardData = JSON.stringify(data.cardData);

            const nameInp = cardEl.querySelector('[data-field="name"]');
            const noInp = cardEl.querySelector('[data-field="no"]');
            const illustInp = cardEl.querySelector('[data-field="illust"]');
            const rareInp = cardEl.querySelector('[data-field="rare"]');
            const locInp = cardEl.querySelector('[data-field="loc"]');
            const toInp = cardEl.querySelector('[data-field="to"]');

            if (data.cardData && data.name) {
                const linkData = data.cardData.linkData;
                lockNameInputAndSetLink(nameInp, data.name, cardEl, linkData);
            }

            if (data.wrapperStates) {
                restoreSelectWrapperState(nameInp, data.wrapperStates.name);
                restoreSelectWrapperState(noInp, data.wrapperStates.no);
                restoreSelectWrapperState(illustInp, data.wrapperStates.illust);
                restoreSelectWrapperState(rareInp, data.wrapperStates.rare);
                restoreSelectWrapperState(locInp, data.wrapperStates.loc);
                restoreSelectWrapperState(toInp, data.wrapperStates.to);
            }

            initCardWidgets(cardEl);
            restoreDesktopDropdownOptions(cardEl, data);
            updateMobileCardDisplay(cardEl);
            if (previousRows?.[idx]) globalThis.AppOverlays?.animateRowEntrance?.(cardEl, previousRows[idx]);
        }
    });
    globalThis.AppOverlays?.restoreRowExits?.(listContainer, previousChildren);
    reindexMobileCards(listContainer);
}

function renderMobileCards() {
    const isMobile = document.documentElement.classList.contains('is-mobile-device');
    if (!isMobile) return;
    if (currentEditingRow) updateSheetDropdownState();

    let listContainerId = 'mobile-cards-list-general';
    if (UIStore.mode === 'move') {
        listContainerId = 'mobile-cards-list-move';
    } else if (UIStore.mode === 'discard') {
        listContainerId = 'mobile-cards-list-discard';
    }
    const listContainer = document.getElementById(listContainerId);
    if (!listContainer) return;
    
    const cards = listContainer.querySelectorAll('.mobile-info-card[data-index]');
    const collectedData = [];
    cards.forEach(c => {
        collectedData.push(getDesktopCardData(c));
    });
    
    renderMobileCardsFromData(collectedData, cards);
}

function mobileAddEntry(mode, initialData = null) {
    let listContainerId = 'mobile-cards-list-general';
    if (mode === 'move') {
        listContainerId = 'mobile-cards-list-move';
    } else if (mode === 'discard') {
        listContainerId = 'mobile-cards-list-discard';
    }

    const listContainer = document.getElementById(listContainerId);
    if (!listContainer) return null;

    const currentCount = listContainer.querySelectorAll('.mobile-info-card[data-index]').length;
    const nextNum = currentCount + 1;
    const idx = currentCount;

    let defaultLoc = "";
    if (mode === 'add') {
        const autoLocInput = document.getElementById('auto-location-input');
        const autoLocWrapper = document.getElementById('wrap-auto-loc');
        if (autoLocInput && autoLocInput.value.trim() && autoLocWrapper && autoLocWrapper.classList.contains('active-highlight')) {
            defaultLoc = autoLocInput.value.trim();
        }
    }

    const data = initialData || {
        name: "",
        cardNo: "",
        illustration: "",
        rarity: "",
        loc: defaultLoc,
        to: "",
        qty: "",
        cardData: null
    };

    const cardHtml = getMobileCardHtml(idx, nextNum, data);
    listContainer.insertAdjacentHTML('beforeend', cardHtml);

    const cardEl = listContainer.querySelector(`.mobile-info-card[data-index="${idx}"]`);
    if (cardEl) {
        if (data.cardData) cardEl.dataset.cardData = JSON.stringify(data.cardData);
        if (data.searchMode) cardEl.dataset.searchMode = data.searchMode;
        
        initCardWidgets(cardEl);

        if (initialData) {
            const nameInp = cardEl.querySelector('[data-field="name"]');
            if (initialData.cardData) {
                if (initialData.name && nameInp) {
                    lockNameInputAndSetLink(nameInp, initialData.name, cardEl, initialData.cardData.linkData);
                }
                restoreDesktopDropdownOptions(cardEl, initialData);
            }
        }

        updateMobileCardDisplay(cardEl);
    }
    reindexMobileCards(listContainer);
    globalThis.AppOverlays?.animateRowEntrance?.(cardEl);
    return cardEl;
}

function reindexMobileCards(listContainer) {
    if (!listContainer) return;
    const cards = listContainer.querySelectorAll('.mobile-info-card[data-index]');
    cards.forEach((card, idx) => {
        card.dataset.index = idx;
        const badge = card.querySelector('.card-num-badge');
        if (badge) badge.innerText = idx + 1;
        
        const copyBtn = card.querySelector('.btn-card-action.copy');
        if (copyBtn) copyBtn.setAttribute('onclick', `triggerMobileCopy(${idx})`);

        const deleteBtn = card.querySelector('.btn-card-action.delete');
        if (deleteBtn) {
            if (cards.length === 1) deleteBtn.setAttribute('disabled', 'true');
            else deleteBtn.removeAttribute('disabled');
            if (UIStore.mode === 'move') deleteBtn.setAttribute('onclick', `triggerMobileMoveDelete(${idx})`);
            else if (UIStore.mode === 'discard') deleteBtn.setAttribute('onclick', `triggerMobileDiscardDelete(${idx})`);
            else deleteBtn.setAttribute('onclick', `triggerMobileDelete(${idx})`);
        }
    });
    updateManagementCardStack(cards);
}

function handleMobileAddCardClick() {
    let listContainerId = 'mobile-cards-list-general';
    const listContainer = document.getElementById(listContainerId);

    mobileAddEntry(UIStore.mode);
    if (listContainer) {
        reindexMobileCards(listContainer);
        const cards = listContainer.querySelectorAll('.mobile-info-card[data-index]');
        if (cards.length > 0) {
            openEditBottomSheet(cards.length - 1);
        }
    }
}

function handleMobileAddMoveCardClick() {
    const listContainer = document.getElementById('mobile-cards-list-move');
    mobileAddEntry('move');
    if (listContainer) {
        reindexMobileCards(listContainer);
        const cards = listContainer.querySelectorAll('.mobile-info-card[data-index]');
        if (cards.length > 0) {
            openEditBottomSheet(cards.length - 1);
        }
    }
}

function handleMobileAddDiscardCardClick() {
    const listContainer = document.getElementById('mobile-cards-list-discard');
    mobileAddEntry('discard');
    if (listContainer) {
        reindexMobileCards(listContainer);
        const cards = listContainer.querySelectorAll('.mobile-info-card[data-index]');
        if (cards.length > 0) {
            openEditBottomSheet(cards.length - 1);
        }
    }
}

function triggerMobileCopy(idx) {
    let listContainerId = 'mobile-cards-list-general';
    if (UIStore.mode === 'move') {
        listContainerId = 'mobile-cards-list-move';
    } else if (UIStore.mode === 'discard') {
        listContainerId = 'mobile-cards-list-discard';
    }

    const listContainer = document.getElementById(listContainerId);
    if (!listContainer) return;
    const cards = listContainer.querySelectorAll('.mobile-info-card[data-index]');
    const card = cards[idx];
    if (!card) return;

    const data = getDesktopCardData(card);
    mobileAddEntry(UIStore.mode, data);
    reindexMobileCards(listContainer);
}

function triggerMobileDelete(idx) {
    let listContainerId = 'mobile-cards-list-general';
    const listContainer = document.getElementById(listContainerId);
    if (!listContainer) return;
    const cards = listContainer.querySelectorAll('.mobile-info-card[data-index]');
    if (cards.length > 1 && cards[idx]) {
        if (!globalThis.AppOverlays?.animateRowExit?.(cards[idx])) cards[idx].remove();
        reindexMobileCards(listContainer);
    }
}

function triggerMobileMoveDelete(idx) {
    const listContainer = document.getElementById('mobile-cards-list-move');
    if (!listContainer) return;
    const cards = listContainer.querySelectorAll('.mobile-info-card[data-index]');
    if (cards.length > 1 && cards[idx]) {
        if (!globalThis.AppOverlays?.animateRowExit?.(cards[idx])) cards[idx].remove();
        reindexMobileCards(listContainer);
    }
}

function triggerMobileDiscardDelete(idx) {
    const listContainer = document.getElementById('mobile-cards-list-discard');
    if (!listContainer) return;
    const cards = listContainer.querySelectorAll('.mobile-info-card[data-index]');
    if (cards.length > 1 && cards[idx]) {
        if (!globalThis.AppOverlays?.animateRowExit?.(cards[idx])) cards[idx].remove();
        reindexMobileCards(listContainer);
    }
}

function handleRenameFromChange(input) {
    const toInput = document.getElementById('rename-to-input');
    if (toInput) {
        if (input.value.trim() !== '') {
            toInput.removeAttribute('disabled');
        } else {
            toInput.setAttribute('disabled', 'true');
            toInput.value = '';
        }
    }
}

function toggleDeleteLocationMode() {
    isDeleteLocationMode = !isDeleteLocationMode;
    isDeleteLocationConfirmPending = false;
    updateManageFooter('discard');
}

function handleDeleteLocationChange(input) {
    if (isDeleteLocationConfirmPending) {
        isDeleteLocationConfirmPending = false;
        updateManageFooter('discard');
    }
}

function getDeletableLocations() {
    return globalThis.AppBackend?.getInventoryLocationNames?.() ?? cardCacheInstance.getAllLocations();
}

async function submitDeleteLocation() {
    if (deleteLocationSubmitting || !requireInventoryReady()) return;
    const deleteInput = document.getElementById('delete-location-input');
    if (!deleteInput) return;

    const deleteLoc = deleteInput.value.trim();

    if (!deleteLoc) {
        showToast('삭제할 위치를 입력해주세요.', 'toast-warn');
        return;
    }

    if (typeof cardCacheInstance === 'undefined') {
        showToast('카드 캐시 인스턴스가 로드되지 않았습니다.', 'toast-error');
        return;
    }

    const locations = getDeletableLocations();
    if (!locations.includes(deleteLoc)) {
        showToast('유효하지 않은 보관 위치입니다.', 'toast-warn');
        return;
    }

    if (!UserStore.user) {
        savePendingFormData();
        toggleAuthModal(true);
        return;
    }

    // 1단계: 복구 불가 확인 상태 전환
    const owner = UserStore.user;
    const backend = globalThis.AppBackend;
    const confirmation = isDeleteLocationConfirmPending;
    if (!confirmation || confirmation.name !== deleteLoc || confirmation.owner !== owner) {
        const { revision, generation } = backend?.inventoryState || {};
        isDeleteLocationConfirmPending = { name: deleteLoc, owner, revision, generation };
        updateManageFooter('discard');
        return;
    }

    if (backend) {
        deleteLocationSubmitting = true;
        showLoading(true, '위치 삭제 중...');
        try {
            const { revision, generation } = confirmation;
            const inventory = await backend.request('deleteLocation', {}, { name: deleteLoc, version: { revision, generation } });
            if (UserStore.user !== owner) return;
            applyUserData(inventory, { includeSettings: false });
            syncCounter++;
            if (isDeleteLocationMode) toggleDeleteLocationMode();
            showToast('보관 위치와 해당 카드가 삭제되었습니다.', '');
        } catch (error) {
            if (UserStore.user !== owner) return;
            if (error.inventory) applyUserData(error.inventory, { includeSettings: false });
            isDeleteLocationConfirmPending = false;
            if (isDeleteLocationMode) updateManageFooter('discard');
            const messages = {
                INVENTORY_REVISION_CHANGED: '보유 정보가 변경되었습니다. 위치를 다시 확인해 주세요.',
                INVENTORY_GENERATION_CHANGED: '보유 카드가 초기화되었습니다. 위치를 다시 확인해 주세요.',
                LOCATION_NOT_FOUND: '보관 위치를 찾을 수 없습니다. 목록을 다시 확인해 주세요.',
                NOT_FOUND: '현재 연결된 서버는 위치 삭제를 지원하지 않습니다.',
            };
            showToast(messages[error.code] || '위치 삭제 결과를 확인하지 못했습니다. 다시 시도해 주세요.', 'toast-error');
        } finally {
            deleteLocationSubmitting = false;
            showLoading(false);
        }
        return;
    }

    // 2단계: 실제 삭제 실행
    showLoading(true, "위치 삭제 중...");
    const discards = [];

    try {
        const inventory = cardCacheInstance._inventory || [];
        
        inventory.forEach(row => {
            const cardName = row[0];
            const cardNo = row[1];
            const rarity = row[2];
            const qty = row[3];
            const loc = row[4];
            const illustration = row[5];

            if (loc === deleteLoc && qty > 0) {
                discards.push({
                    cardNo: cardNo,
                    name: cardName || "Unknown",
                    rarity: rarity || "",
                    illustration: illustration || "",
                    loc: deleteLoc,
                    qty: qty
                });
            }
        });

        if (discards.length === 0) {
            showLoading(false);
            showToast('삭제할 카드가 없습니다.', 'toast-warn');
            toggleDeleteLocationMode();
            return;
        }

        const res = await callApi('discardCards', buildAuthPayload(), { discards });
        showLoading(false);

        if (res.success) {
            updateLocalInventory(res.updatedItems);
            if (res.locations !== undefined) {
                cardCacheInstance.setSummary(res.amount, res.locations, res.rarities);
                updateTotals();
            }
            syncCounter++;
            toggleDeleteLocationMode();
        } else {
            showToast(res.message || '위치 삭제에 실패했습니다.', 'toast-error');
        }
    } catch (error) {
        console.error("Delete location error:", error);
        showLoading(false);
        showToast('위치 삭제 중 오류가 발생했습니다.', 'toast-error');
    }
}

// ==========================================
// 모바일 전용 검색 오버레이 로직
// ==========================================

let mobileSearchOpenFrame = null;
let mobileSearchCloseTimer = null;

function openMobileSearch() {
    const overlay = document.getElementById('mobile-search-overlay');
    const input = document.getElementById('mobile-card-search');
    if (!overlay || !input) return;
    cancelAnimationFrame(mobileSearchOpenFrame);
    clearTimeout(mobileSearchCloseTimer);

    // 히스토리 추가하여 뒤로가기로 닫을 수 있게 처리
    const currentState = history.state || {};
    if (!currentState.mobileSearchOpen) {
        history.pushState({ mobileSearchOpen: true }, '');
    }

    overlay.hidden = false;
    // display:none에서 복귀한 닫힘 상태를 먼저 계산하여 상단 이동·배경 페이드를 시작한다.
    void overlay.offsetHeight;
    mobileSearchOpenFrame = requestAnimationFrame(() => {
        overlay.classList.add('active');
    });

    // 입력값 초기화 및 포커스
    input.value = '';
    const clearBtn = document.getElementById('mobile-search-clear-btn');
    if (clearBtn) clearBtn.hidden = true;
    
    // 최근 검색어 먼저 표시
    showMobileRecentInDropdown();
    
    // 하단 탭바 하이라이트 변경
    document.querySelectorAll('.app-navi-item--mobile').forEach(el => {
        el.classList.remove('active');
        el.removeAttribute('aria-current');
    });
    const searchNavItem = document.querySelector('.app-navi-item--mobile[data-mode="search"]');
    if (searchNavItem) {
        searchNavItem.classList.add('active');
        searchNavItem.setAttribute('aria-expanded', 'true');
    }
    
    input.focus();
}

function closeMobileSearch(fromPopState = false) {
    const overlay = document.getElementById('mobile-search-overlay');
    const input = document.getElementById('mobile-card-search');
    if (!overlay) return;

    cancelAnimationFrame(mobileSearchOpenFrame);
    clearTimeout(mobileSearchCloseTimer);

    overlay.classList.remove('active');
    if (globalThis.AppBackend) clearCatalogDropdownCandidates(document.getElementById('mobile-custom-dropdown'));
    
    // 하단 탭바 원래 모드에 맞게 복원
    if (typeof updateActiveNav === 'function' && typeof UIStore.mode !== 'undefined') {
        updateActiveNav(UIStore.mode);
    }
    
    mobileSearchCloseTimer = setTimeout(() => {
        overlay.hidden = true;
        if (input) input.value = '';
        const dropdown = document.getElementById('mobile-custom-dropdown');
        if (dropdown) dropdown.classList.remove('active');
    }, globalThis.AppOverlays?.duration() ?? 200); // 배경·상단 전환과 동일한 종료 시점

    if (!fromPopState) {
        const currentState = history.state || {};
        if (currentState.mobileSearchOpen) {
            history.back(); // pushState 된 내역 팝
        }
    }
}

// 모바일 최근 검색 가로형 UI 추가 함수
function appendMobileRecentHistory(list, recent) {
    if (!recent || recent.length === 0) return;
    const ownedNames = cardCacheInstance.getOwnedNamesSet();
    const ownedNumbers = cardCacheInstance.getOwnedNumbersSet();

    const li = document.createElement('li');
    li.className = 'mobile-recent-container';
    
    const actions = document.createElement('div');
    actions.className = 'recent-search-actions';

    recent.slice(0, 10).forEach(r => {
        const keyword = typeof r === 'string' ? r : r.keyword;
        const searchType = typeof r === 'string' ? 'auto' : (r.searchType || 'auto');
        const isTarget = typeof r === 'string' ? false : !!r.isTarget;

        const isOwned = isTarget && (searchType === 'number'
            ? ownedNumbers.has(String(keyword).trim().toUpperCase())
            : ownedNames.has(String(keyword).trim()));
        const appearance = isTarget
            ? `shape-capsule ${isOwned ? 'color-tint-theme' : 'color-tint-neutral'}`
            : 'ui-button--text color-text-001';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `ui-button recent-search-button ${appearance}`;
        button.innerText = keyword;
        button.addEventListener('click', (e) => {
            e.stopPropagation();
            executeMobileSearch(keyword, searchType, isTarget);
        });
        actions.appendChild(button);
    });
    li.appendChild(actions);

    const deleteIcon = document.createElement('button');
    deleteIcon.type = 'button';
    deleteIcon.className = 'ui-button ui-button--text color-text-002 clear-all-icon';
    deleteIcon.setAttribute('aria-label', '전체 검색 기록 삭제');
    deleteIcon.innerHTML = '<i class="material-icons" aria-hidden="true">delete</i>';
    deleteIcon.onclick = clearMobileAllRecent;
    li.appendChild(deleteIcon);

    list.appendChild(li);
}

// 모바일 전용 최근 검색어 표시
function showMobileRecentInDropdown() {
    const recent = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    const list = document.getElementById('mobile-custom-dropdown');
    if (!list) return;

    clearCatalogDropdownCandidates(list);
    list.innerHTML = '';
    
    appendMobileRecentHistory(list, recent);
    
    if (list.innerHTML.trim() === '') {
        list.classList.remove('active');
    } else {
        list.classList.add('active');
    }
}

function clearMobileAllRecent(e) {
    if (e) e.stopPropagation();
    localStorage.setItem(RECENT_KEY, '[]');
    document.querySelector('#mobile-custom-dropdown .mobile-recent-container')?.remove();
    
    // 다시 검색창 텍스트 상태를 확인하여 렌더링 방식 결정
    const mSearchInput = document.getElementById('mobile-card-search');
    const val = mSearchInput ? mSearchInput.value.trim() : '';
    if (val) {
        mobileFilterAndShowDropdown(val);
    } else {
        showMobileRecentInDropdown();
    }
}

// 모바일 전용 검색 자동완성 (공통 필터링 함수 호출로 통합)
function mobileFilterAndShowDropdown(val) {
    filterAndShowDropdown(val, true);
}

async function executeMobileSearch(query, searchType = 'auto', forcedIsTarget = null) {
    if (!query) return;
    
    const desktopInput = document.getElementById('card-search');
    if (desktopInput) {
        desktopInput.value = query;
    }
    
    UIStore.isMobileSearchInProgress = true;
    const mSearchBtn = document.getElementById('mobile-search-btn');
    if (mSearchBtn) {
        const icon = mSearchBtn.querySelector('i');
        if (icon) {
            icon.innerText = 'autorenew';
            icon.classList.add('loading-spin');
        }
    }
    
    try {
        const pendingSearch = startSearch(false, searchType, forcedIsTarget);
        closeMobileSearch(true);
        await pendingSearch;
    } finally {
        UIStore.isMobileSearchInProgress = false;
        if (mSearchBtn) {
            const icon = mSearchBtn.querySelector('i');
            if (icon) {
                icon.innerText = 'search';
                icon.classList.remove('loading-spin');
            }
        }
    }
}

function initMobileSearchListeners() {
    // 모바일 검색 입력 리스너
    const mSearchInput = document.getElementById('mobile-card-search');
    const mClearBtn = document.getElementById('mobile-search-clear-btn');
    const mSearchBtn = document.getElementById('mobile-search-btn');
    
    if (mSearchInput) {
        if (mSearchInput._isInputBound) return;
        mSearchInput._isInputBound = true;

        const debouncedMobileFilter = debounce((val) => {
            // 지우기 직전에 예약된 검색이 최근 검색 목록을 덮어쓰지 않도록 한다.
            if (mSearchInput.value.trim() !== val) return;
            if (globalThis.AppBackend && !document.getElementById('mobile-search-overlay')?.classList.contains('active')) return;
            mobileFilterAndShowDropdown(val);
        }, 100);

        mSearchInput.addEventListener('input', (e) => {
            const val = e.target.value.trim();
            if (val) {
                if (mClearBtn) mClearBtn.hidden = false;
                if (globalThis.AppBackend) updatePendingCatalogDropdown(val, true);
                debouncedMobileFilter(val);
            } else {
                debouncedMobileFilter.cancel && debouncedMobileFilter.cancel();
                if (mClearBtn) mClearBtn.hidden = true;
                showMobileRecentInDropdown();
            }
        });

        mSearchInput.addEventListener('keydown', (e) => {
            if (e.isComposing) return;
            if (e.key === 'Enter') {
                e.preventDefault();
                mSearchInput.blur();
                
                const targetVal = mSearchInput.value.trim();
                if (targetVal) {
                    executeMobileSearch(targetVal, 'auto');
                }
            }
        });
    }

    if (mSearchBtn && mSearchInput) {
        mSearchBtn.addEventListener('click', (e) => {
            e.preventDefault();
            const val = mSearchInput.value.trim();
            if (val) {
                executeMobileSearch(val, 'auto');
            }
        });
    }

    if (mClearBtn) {
        mClearBtn.addEventListener('click', (e) => {
            e.preventDefault();
            mSearchInput.value = '';
            mClearBtn.hidden = true;
            showMobileRecentInDropdown();
            mSearchInput.focus();
        });
    }

    // 뒤로가기로 모달 닫기
    window.addEventListener('popstate', (e) => {
        // 검색 진행 중에는 popstate에 의해 모달이 강제로 닫히는 동작을 차단하여 오작동 방지
        if (UIStore.isMobileSearchInProgress) return;

        const overlay = document.getElementById('mobile-search-overlay');
        if (overlay && overlay.classList.contains('active')) {
            const currentState = e.state || {};
            // 현재 상태에 mobileSearchOpen이 없으면 닫힌 것으로 간주
            if (!currentState.mobileSearchOpen) {
                closeMobileSearch(true);
            }
        }
    });
}

/* ==========================================================================
   [모바일 개편] 모바일 카드 뷰, 바텀 시트 및 입력 오버레이 로직
   ========================================================================== */

let currentEditingRow = null;    // 원본 입력 노드를 돌려줄 소유 행
let currentEditingRowIndex = -1; // 현재 바텀 시트에서 편집 중인 테이블 행 인덱스 (0-based)
let activeOverlayType = '';
let packOverlaySelect = null;
let packOverlaySuggestionRequest = null;
let packOverlayLastSuggestions = [];
let qtyPickerSelectedVal = 1;     // 수량 조절 오버레이 내 선택된 임시 값



function getActiveMobileListContainer() {
    let listContainerId = 'mobile-cards-list-general';
    if (UIStore.mode === 'move') {
        listContainerId = 'mobile-cards-list-move';
    } else if (UIStore.mode === 'discard') {
        listContainerId = 'mobile-cards-list-discard';
    }
    return document.getElementById(listContainerId);
}

function handleMobileCardClick(event) {
    if (event.target.closest('.card-actions, .mobile-card-fields')) return;
    openEditBottomSheet(Number(event.currentTarget.dataset.index));
}

function openEditBottomSheet(idx) {
    const listContainer = getActiveMobileListContainer();
    if (!listContainer) return;

    const cards = listContainer.querySelectorAll('.mobile-info-card[data-index]');
    const row = cards[idx];
    if (!row) return;

    const sheetContainer = document.getElementById('sheet-fields-container');
    if (!sheetContainer) return;

    // 행 전환 전에 자식의 값을 확정하고 원본 노드를 원래 소유자에게 반환한다.
    if (currentEditingRow && currentEditingRow !== row) {
        closeEntrySheetChildren();
        returnEditingFields();
    }
    currentEditingRow = row;
    currentEditingRowIndex = idx;

    // 2. 대상 카드의 가상 입력란을 바텀시트로 물리적 이동 (Append)
    const fields = row.querySelector('.mobile-card-fields');
    const cardData = getDesktopCardData(row); // 이동 전에 원본 데이터 미리 수집

    if (fields) {
        // 바텀시트 입력 폼 필드들에 ID 동적 부여 (기존 ID 기반 헬퍼 호환성 확보)
        const nameInp = fields.querySelector('[data-field="name"]');
        if (nameInp) nameInp.id = 'sheet-card-name';
        const noInp = fields.querySelector('[data-field="no"]');
        if (noInp) noInp.id = 'sheet-card-no';
        const illustInp = fields.querySelector('[data-field="illust"]');
        if (illustInp) illustInp.id = 'sheet-card-illust';
        const rareInp = fields.querySelector('[data-field="rare"]');
        if (rareInp) rareInp.id = 'sheet-card-rarity';
        const locInp = fields.querySelector('[data-field="loc"]');
        if (locInp) locInp.id = 'sheet-card-loc';
        const toInp = fields.querySelector('[data-field="to"]');
        if (toInp) toInp.id = 'sheet-card-to';
        const qtyInp = fields.querySelector('[data-field="qty"]');
        if (qtyInp) qtyInp.id = 'sheet-card-qty';

        const illustWrap = fields.querySelector('[data-field-wrap="illust"]');
        if (illustWrap) illustWrap.id = 'wrap-sheet-illust';
        const rareWrap = fields.querySelector('[data-field-wrap="rare"]');
        if (rareWrap) rareWrap.id = 'wrap-sheet-rare';
        const locWrap = fields.querySelector('[data-field-wrap="loc"]');
        if (locWrap) locWrap.id = 'wrap-sheet-loc';
        const toWrap = fields.querySelector('[data-field-wrap="to"]');
        if (toWrap) toWrap.id = 'wrap-sheet-to';
        const qtyWrap = fields.querySelector('[data-field-wrap="qty"]');
        if (qtyWrap) qtyWrap.id = 'wrap-sheet-qty';

        sheetContainer.appendChild(fields);
        fields.removeAttribute('hidden');
        fields.querySelectorAll('.sheet-form-field > label').forEach(label => {
            label.htmlFor = label.nextElementSibling.querySelector('input').id;
        });

        // 드롭다운 옵션 복원
        restoreDesktopDropdownOptions(fields, cardData);
    }

    // 3. 지우기 버튼 및 드롭다운 상태 업데이트
    updateBottomSheetClearButtons();
    updateSheetDropdownState();

    // 4. 네비게이션 버튼 & Progress 인디케이터 세팅
    const prevBtn = document.getElementById('sheet-prev-btn');
    const nextBtn = document.getElementById('sheet-next-btn');
    const progressEl = document.getElementById('sheet-card-progress');

    if (progressEl) {
        progressEl.innerText = `${idx + 1} / ${cards.length}`;
    }

    if (idx === 0) {
        prevBtn.classList.add('disabled');
    } else {
        prevBtn.classList.remove('disabled');
    }

    if (idx === cards.length - 1) {
        nextBtn.innerHTML = `<i class="material-icons">add</i>`;
    } else {
        nextBtn.innerHTML = `<i class="material-icons">keyboard_arrow_right</i>`;
    }

    prevBtn.disabled = idx === 0;
    nextBtn.setAttribute('aria-label', idx === cards.length - 1 ? '입력란 추가' : '다음 카드');

    const sheet = document.getElementById('mobile-entry-bottom-sheet');
    // 같은 시트 내 행 전환은 기존 진입점과 수명주기를 유지한다.
    if (!isManagedSheetOpen(sheet)) {
        openManagedSheet(sheet, {
            backdrop: document.getElementById('bottom-sheet-overlay'),
            trigger: row.querySelector('.card-title-text')
        });
    }
}

function closeEntrySheetChildren() {
    // 수량은 닫기가 확정이다. 동적 ID와 편집 소유자가 유효할 때 먼저 반영한다.
    closeQtyOverlay();
    closeSheetOverlay();
    closeSheetDropdownSelect();
    IllustrationPicker.close(false, false);
}

function returnEditingFields() {
    const fields = document.getElementById('sheet-fields-container')?.querySelector('.mobile-card-fields');
    if (currentEditingRow && fields) {
        fields.querySelectorAll('input').forEach(input => {
            input.setAttribute('readonly', 'true');
            delete input.dataset.lockedForName;
            delete input.dataset.errorRetry;
            delete input.dataset.prevCardNo;
        });
        delete currentEditingRow.dataset.searchMode;
        fields.querySelectorAll('input[id^="sheet-card-"], div[id^="wrap-sheet-"]').forEach(el => el.removeAttribute('id'));
        currentEditingRow.appendChild(fields);
        fields.setAttribute('hidden', '');
        updateMobileCardDisplay(currentEditingRow);
    }
    const sheet = document.getElementById('mobile-entry-bottom-sheet');
    if (sheet) delete sheet.dataset.searchMode;
}

function closeEntryBottomSheet() {
    const sheet = document.getElementById('mobile-entry-bottom-sheet');
    if (!isManagedSheetOpen(sheet)) return;
    closeEntrySheetChildren();
    closeManagedSheet(sheet, {
        backdrop: document.getElementById('bottom-sheet-overlay')
    });
    returnEditingFields();
    currentEditingRow = null;
    currentEditingRowIndex = -1;
}



function navigateSheetCard(direction) {
    const listContainer = getActiveMobileListContainer();
    if (!listContainer) return;

    const cards = listContainer.querySelectorAll('.mobile-info-card[data-index]');
    if (!currentEditingRow) return;

    const targetIdx = currentEditingRowIndex + direction;

    if (direction === -1) {
        if (targetIdx >= 0) {
            openEditBottomSheet(targetIdx);
        }
    } else if (direction === 1) {
        if (targetIdx < cards.length) {
            openEditBottomSheet(targetIdx);
        } else {
            // 맨 마지막 카드에서 다음을 누를 때 카드 추가 및 바텀시트 전환
            mobileAddEntry(UIStore.mode);
            reindexMobileCards(listContainer);
            const updatedCards = listContainer.querySelectorAll('.mobile-info-card[data-index]');
            openEditBottomSheet(updatedCards.length - 1);
        }
    }
}

// 7. 입력 오버레이 제어
function openSheetOverlay(type, event) {
    if (!currentEditingRow) return;
    const linkedName = type === 'name' ? document.getElementById('sheet-card-name') : null;
    if (linkedName?.readOnly && linkedName.classList.contains('hyperlink-style') && linkedName.onclick) {
        linkedName.onclick(event);
        return;
    }
    if (type === 'no') {
        const sheetNo = document.getElementById('sheet-card-no');
        if (sheetNo && sheetNo.dataset.lockedForName === 'true') {
            return;
        }
    }

    const field = document.getElementById('sheet-card-' + type);
    if (field?.disabled) return;
    const value = field?.value.trim() || '';
    if (type === 'qty') {
        openQtyOverlay(value);
        return;
    }
    const placeholders = { name: '카드 이름 입력', no: '카드 번호 입력', loc: '보관 위치 입력', to: '이동 위치 입력' };
    openSheetInputOverlay(type, field, placeholders[type], value);
}

function openSheetInputOverlay(type, trigger, label, value, onSelect = null) {
    const overlay = document.getElementById('mobile-sheet-input-overlay');
    const input = document.getElementById('overlay-search-input');
    const clearBtn = document.getElementById('overlay-clear-btn');
    const list = document.getElementById('overlay-suggestions-list');

    if (!overlay || !input || !list) return;
    overlay.dataset.sheetInputType = type;
    input._cancelSuggestions?.();
    activeOverlayType = type;
    packOverlaySelect = onSelect;
    packOverlayLastSuggestions = [];
    registrationOverlayLastSuggestions = [];
    input.type = 'text';
    input.enterKeyHint = type === 'pack' || type === 'photo-name' ? 'search' : '';
    input.placeholder = label;
    input.value = value;
    clearBtn.hidden = !value;
    list.style.height = '';
    list.innerHTML = '';
    overlay.setAttribute('aria-label', label);
    input.setAttribute('aria-label', label);
    openManagedSheet(overlay, { trigger, initialFocus: input, onDismiss: closeSheetOverlay });
    // 검색 오버레이는 탭을 누른 사용자 제스처 안에서 모바일 키보드를 연다.
    if (type === 'pack' || type === 'photo-name') focusModalReturnTarget(input);
    showOverlaySuggestions(type === 'loc' || type === 'to' ? '' : value);
}

function closeSheetOverlay() {
    document.getElementById('overlay-search-input')?._cancelSuggestions?.();
    const list = document.getElementById('overlay-suggestions-list');
    if (list) list.style.height = '';
    closeManagedSheet(document.getElementById('mobile-sheet-input-overlay'));
    activeOverlayType = '';
    packOverlaySelect = null;
    packOverlayLastSuggestions = [];
    registrationOverlayLastSuggestions = [];
}

function closePackLookupInput() {
    if (activeOverlayType === 'pack') closeSheetOverlay();
}

function closePhotoNameInput() {
    if (activeOverlayType === 'photo-name') closeSheetOverlay();
}

function clearOverlayInput() {
    const input = document.getElementById('overlay-search-input');
    const clearBtn = document.getElementById('overlay-clear-btn');
    if (input) {
        input._cancelSuggestions?.();
        registrationOverlayLastSuggestions = [];
        input.value = '';
        input.focus();
        if (clearBtn) clearBtn.hidden = true;
        showOverlaySuggestions('');
    }
}

let registrationOverlaySuggestions;
let registrationOverlayLastSuggestions = [];

function renderCardOverlaySuggestions(list, candidates, { remember = true } = {}) {
    if (remember) registrationOverlayLastSuggestions = candidates;
    if (remember || candidates.length) list.style.height = '';
    else holdOpenSuggestionDropdown(list);
    list.replaceChildren(...candidates.map(candidate => {
        const { value } = candidate;
        const item = document.createElement('li');
        item.innerText = value;
        item.className = 'ui-button color-type004 text-suggest';
        item.setAttribute('role', 'button');
        item.tabIndex = 0;
        item.onclick = () => selectOverlayItem(value, candidate);
        return item;
    }));
}

async function showRegistrationCatalogSuggestions(list, field, query, fieldInput) {
    const photoName = field === 'photo-name';
    const row = photoName ? null : currentEditingRow;
    const searchInput = document.getElementById('overlay-search-input');
    const controller = registrationOverlaySuggestions = new AbortController();
    const isCurrent = () => !controller.signal.aborted && activeOverlayType === field && searchInput.value.trim() === query
        && (photoName || (currentEditingRow === row && usesRegistrationCatalog(field, fieldInput)));
    try {
        const candidates = await globalThis.AppBackend.registrationSuggestions(query, photoName ? 'name' : field, controller.signal);
        if (!isCurrent()) return;
        renderCardOverlaySuggestions(list, candidates.slice(0, 10));
    } catch {
        if (!isCurrent()) return;
        registrationOverlayLastSuggestions = [];
        list.style.height = '';
        const message = document.createElement('li');
        message.className = 'item-no-match color-text-001 no-result-item';
        message.setAttribute('role', 'status');
        message.textContent = '카드 추천을 불러오지 못했습니다.';
        list.replaceChildren(message);
    }
}

// 8. 오버레이 자동완성 / 목록 추천
function showOverlaySuggestions(query) {
    registrationOverlaySuggestions?.abort();
    const list = document.getElementById('overlay-suggestions-list');
    if (!list) return;
    const field = activeOverlayType;
    if (field === 'photo-name') {
        if (query.trim() && globalThis.AppBackend?.registrationSuggestions) {
            void showRegistrationCatalogSuggestions(list, field, query.trim());
        } else {
            renderCardOverlaySuggestions(list, []);
        }
        return;
    }
    const fieldInput = document.getElementById(`sheet-card-${field}`);
    const choices = field === 'name' && registrationNameChoices(fieldInput);
    if (choices) {
        renderCardOverlaySuggestions(list, choices.filter(choice => normalizeStr(choice.value).includes(normalizeStr(query))));
        return;
    }
    if (usesRegistrationCatalog(field, fieldInput)) {
        if (query.trim()) void showRegistrationCatalogSuggestions(list, field, query.trim(), fieldInput);
        else renderCardOverlaySuggestions(list, []);
        return;
    }
    if (field === 'pack') {
        if (query.trim()) void showPackOverlaySuggestions(query.trim(), list);
        else {
            packOverlayLastSuggestions = [];
            list.replaceChildren();
        }
        return;
    }
    list.style.height = '';
    list.replaceChildren();

    const normalizedQuery = query.trim().toLowerCase().replace(/\s+/g, '');
    const isMove = (UIStore.mode === 'move');
    const isDiscard = (UIStore.mode === 'discard');

    const editingRow = currentEditingRow;

    if (activeOverlayType === 'name') {
        if (!normalizedQuery && !isMove && !isDiscard) return;
        const localNamesNormalized = cardCacheInstance.getAllNamesNormalized();
        let matches = [];

        if (isMove || isDiscard) {
            const ownedNamesSet = cardCacheInstance.getOwnedNamesSet();
            if (!normalizedQuery) {
                for (let i = 0; i < localNamesNormalized.length; i++) {
                    const item = localNamesNormalized[i];
                    if (ownedNamesSet.has(item.original)) {
                        const nos = cardCacheInstance.getNosByName(item.original);
                        const allDepleted = nos.every(no => isMove ? isMoveCardDepleted(no, editingRow) : isCardDepleted(no, editingRow));
                        if (!allDepleted) {
                            matches.push(item.original);
                            if (matches.length >= 10) break;
                        }
                    }
                }
            } else {
                const queryChosung = getChosung(normalizedQuery);
                for (let i = 0; i < localNamesNormalized.length; i++) {
                    const item = localNamesNormalized[i];
                    if (ownedNamesSet.has(item.original)) {
                        if (item.chosung.includes(queryChosung)) {
                            if (Hangul.search(item.normalized, normalizedQuery) !== -1) {
                                const nos = cardCacheInstance.getNosByName(item.original);
                                const allDepleted = nos.every(no => isMove ? isMoveCardDepleted(no, editingRow) : isCardDepleted(no, editingRow));
                                if (!allDepleted) {
                                    matches.push(item.original);
                                    if (matches.length >= 10) break;
                                }
                            }
                        }
                    }
                }
            }
        } else {
            if (!normalizedQuery) {
                for (let i = 0; i < Math.min(localNamesNormalized.length, 10); i++) {
                    matches.push(localNamesNormalized[i].original);
                }
            } else {
                const queryChosung = getChosung(normalizedQuery);
                for (let i = 0; i < localNamesNormalized.length; i++) {
                    const item = localNamesNormalized[i];
                    if (item.chosung.includes(queryChosung)) {
                        if (Hangul.search(item.normalized, normalizedQuery) !== -1) {
                            matches.push(item.original);
                            if (matches.length >= 10) break;
                        }
                    }
                }
            }
        }

        renderCardOverlaySuggestions(list, matches.map(value => ({ value })));
    } else if (activeOverlayType === 'no') {
        let source = [];

        // 바텀시트의 번호 필드가 검색 중 상태이면 목록을 비우고 안내 표시
        const sheetNoEl = document.getElementById('sheet-card-no');
        if (sheetNoEl && sheetNoEl.dataset.lockedForName === 'true') {
            const li = document.createElement('li');
            li.className = 'item-no-match color-text-001 no-result-item';            li.setAttribute('role', 'status');
            li.innerText = '검색 중...';
            list.replaceChildren(li);
            return;
        }

        // 1. 모바일 바텀시트 자신의 번호 래퍼에 보관된 options 정보를 1순위로 조회 (자기 참조 구조)
        const noWrap = sheetNoEl ? sheetNoEl.closest('.sheet-input-box') : null;
        if (noWrap && noWrap.dataset.options) {
            try {
                const options = JSON.parse(noWrap.dataset.options);
                if (options && options.length > 0) {
                    source = options.map(opt => typeof opt === 'object' ? opt.val : opt);
                }
            } catch (e) {
                console.error("Failed to parse sheet noWrap options:", e);
            }
        }

        // 2. 옵션 데이터가 설정되어 있지 않다면 캐시 폴백 처리
        if (!source.length && UIStore.mode === 'add' && (
            editingRow?.dataset.searchMode === 'name'
            || (editingRow?.dataset.cardData && document.getElementById('sheet-card-name')?.classList.contains('hyperlink-style'))
        )) {
            try { source = JSON.parse(editingRow.dataset.cardData || '{}').numbers || []; } catch {}
            if (!source.length) {
                list.replaceChildren();
                return;
            }
        }
        if (source.length === 0) {
            if (isMove || isDiscard) {
                let ownedNumbers = cardCacheInstance.getOwnedNumbers();
                ownedNumbers = ownedNumbers.filter(no => isMove ? !isMoveCardDepleted(no, editingRow) : !isCardDepleted(no, editingRow));

                const nameVal = document.getElementById('sheet-card-name').value.trim();
                if (nameVal) {
                    const nosByName = cardCacheInstance.getNosByName(nameVal);
                    if (nosByName.length > 0) {
                        const ownedSet = new Set(ownedNumbers);
                        source = nosByName.filter(no => ownedSet.has(no));
                    } else {
                        source = ownedNumbers;
                    }
                } else {
                    source = ownedNumbers;
                }
            } else {
                const nameVal = document.getElementById('sheet-card-name').value.trim();
                if (nameVal) {
                    // 한글 번역명이 아닌 원본 고유 영문명을 키값으로 치환하여 캐시 맵 쿼리 실행
                    let cacheName = nameVal;
                    if (editingRow && editingRow.dataset.cardData) {
                        try {
                            const cData = JSON.parse(editingRow.dataset.cardData);
                            if (cData && cData.name) cacheName = cData.name;
                        } catch {}
                    }
                    const allNos = (typeof ClientCache !== 'undefined' && ClientCache._nameToNos) ? ClientCache._nameToNos[cacheName] : null;
                    if (allNos) {
                        source = Array.from(allNos);
                    } else {
                        // 등록 모드에서는 사용자 소장 재고에 기인한 필터링을 생략하고, 발매 번호 풀로 안전하게 폴백
                        source = (typeof CardDataStore.allCardNumbers !== 'undefined' && Array.isArray(CardDataStore.allCardNumbers) && CardDataStore.allCardNumbers.length > 0)
                            ? CardDataStore.allCardNumbers
                            : cardCacheInstance.getOwnedNumbers();
                    }
                } else {
                    source = (typeof CardDataStore.allCardNumbers !== 'undefined' && Array.isArray(CardDataStore.allCardNumbers) && CardDataStore.allCardNumbers.length > 0)
                        ? CardDataStore.allCardNumbers
                        : cardCacheInstance.getOwnedNumbers();
                }
            }
        }

        let matches = [];
        const queryUpper = normalizedQuery.toUpperCase();
        for (let i = 0; i < source.length; i++) {
            const no = source[i];
            if (no.toUpperCase().includes(queryUpper)) {
                matches.push(no);
                if (matches.length >= 10) break;
            }
        }

        renderCardOverlaySuggestions(list, matches.map(value => ({ value })));
    } else if (activeOverlayType === 'loc' || activeOverlayType === 'to') {
        const isMove = (UIStore.mode === 'move');
        const isDiscard = (UIStore.mode === 'discard');

        // 이동/제거 모드의 보관위치(from/loc)일 때는 바텀시트 래퍼 옵션(잔여수량 포함)을 우선 참조
        if ((isMove || isDiscard) && activeOverlayType === 'loc') {
            const sheetLocEl = document.getElementById('sheet-card-loc');
            const locWrap = sheetLocEl ? sheetLocEl.closest('.sheet-input-box') : null;
            let locSource = [];
            if (locWrap && locWrap.dataset.options) {
                try {
                    const options = JSON.parse(locWrap.dataset.options);
                    if (options && options.length > 0) {
                        locSource = options;
                    }
                } catch (e) { /* ignore */ }
            }

            if (locSource.length > 0) {
                const filtered = locSource.filter(opt => {
                    const val = typeof opt === 'object' ? opt.val : opt;
                    if (!normalizedQuery) return true;
                    return Hangul.search(val.toLowerCase(), normalizedQuery) !== -1;
                });
                filtered.forEach(opt => {
                    const val = typeof opt === 'object' ? opt.val : opt;
                    const text = typeof opt === 'object' ? opt.text : opt;
                    const li = document.createElement('li');
                    li.innerText = text;
                    li.className = 'ui-button color-type004 text-suggest';                    li.setAttribute('role', 'button');
                    li.tabIndex = 0;
                    li.onclick = () => selectOverlayItem(val);
                    list.appendChild(li);
                });
            } else {
                const li = document.createElement('li');
                li.className = 'item-no-match color-text-001 no-result-item';                li.setAttribute('role', 'status');
                li.innerText = '선택 가능한 보관위치 없음';
                list.appendChild(li);
            }
        } else {
            // 등록 모드 또는 이동 위치(to)일 때는 기존 로직 유지
            const locations = cardCacheInstance.getAllLocations();

            // 이동 위치(to) 선택 시 현재 보관 위치로 기입된 장소는 리스트에서 필터링 제외
            let excludedLoc = '';
            if (isMove && activeOverlayType === 'to') {
                const sheetLocEl = document.getElementById('sheet-card-loc');
                if (sheetLocEl) excludedLoc = sheetLocEl.value.trim();
            }

            const matches = locations.filter(loc => {
                if (excludedLoc && loc === excludedLoc) return false;
                if (!normalizedQuery) return true;
                return Hangul.search(loc.toLowerCase(), normalizedQuery) !== -1;
            });

            matches.forEach(loc => {
                const li = document.createElement('li');
                li.innerText = loc;
                li.className = 'ui-button color-type004 text-suggest';                li.setAttribute('role', 'button');
                li.tabIndex = 0;
                li.onclick = () => selectOverlayItem(loc);
                list.appendChild(li);
            });
        }
    }
}

function renderPackOverlaySuggestions(list, names) {
    list.replaceChildren(...names.slice(0, 5).map(name => {
        const item = document.createElement('li');
        item.className = 'ui-button color-type004 text-suggest';
        item.setAttribute('role', 'button');
        item.tabIndex = 0;
        item.textContent = name;
        item.onclick = () => selectOverlayItem(name);
        return item;
    }));
}

async function showPackOverlaySuggestions(query, list) {
    packOverlaySuggestionRequest?.abort();
    const request = new AbortController();
    packOverlaySuggestionRequest = request;
    const isCurrent = () => !request.signal.aborted && activeOverlayType === 'pack'
        && isManagedSheetOpen(document.getElementById('mobile-sheet-input-overlay'))
        && document.getElementById('overlay-search-input').value.trim() === query;
    try {
        const matches = globalThis.AppBackend?.packSuggestions
            ? await AppBackend.packSuggestions(query, request.signal)
            : getLocalPackNameMatches(query);
        if (!isCurrent()) return;
        packOverlayLastSuggestions = matches.slice(0, 5);
        renderPackOverlaySuggestions(list, packOverlayLastSuggestions);
    } catch (error) {
        if (!isCurrent()) return;
        packOverlayLastSuggestions = [];
        const item = document.createElement('li');
        item.className = 'item-no-match color-text-001 no-result-item';
        item.setAttribute('role', 'status');
        item.textContent = '팩 추천을 불러오지 못했습니다.';
        list.replaceChildren(item);
    }
}

// 오버레이 아이템 선택 핸들러
function selectOverlayItem(value, candidate) {
    if (!isManagedSheetOpen(document.getElementById('mobile-sheet-input-overlay'))) return;
    if (activeOverlayType === 'pack' || activeOverlayType === 'photo-name') {
        if (!value) return;
        const select = packOverlaySelect;
        if (!candidate && activeOverlayType === 'photo-name') {
            candidate = registrationOverlayLastSuggestions.find(item => item.value === value);
        }
        closeSheetOverlay();
        select?.(value, candidate);
        return;
    }
    const row = currentEditingRow;
    if (!row) return;

    const isMove = (UIStore.mode === 'move');
    const isDiscard = (UIStore.mode === 'discard');

    const nameClass = (isMove || isDiscard) ? '.card-name-input' : '.page-card-name';
    const noClass = isMove ? '.move-card-no' : (isDiscard ? '.discard-card-no' : '.page-card-no');
    const locClass = isMove ? '.move-card-from' : (isDiscard ? '.discard-card-loc' : '.page-card-loc');

    if (activeOverlayType === 'name') {
        const sheetName = document.getElementById('sheet-card-name');
        const choices = registrationNameChoices(sheetName);
        if (choices) {
            candidate = choices.includes(candidate) ? candidate : choices.find(choice => choice.value === value);
            if (!candidate) return;
        }
        sheetName.value = value;
        const originalName = row.querySelector(nameClass);
        if (originalName) {
            originalName.value = value;
        }
        if (isMove) {
            handleMoveNameInput(originalName || sheetName);
        } else if (isDiscard) {
            handleDiscardNameInput(originalName || sheetName);
        } else {
            fetchCardByName(originalName || sheetName, true, candidate?.cid, false, candidate?.number);
        }
    } else if (activeOverlayType === 'no') {
        const sheetNo = document.getElementById('sheet-card-no');
        sheetNo.value = value;
        const originalNo = row.querySelector(noClass);
        if (originalNo) {
            originalNo.value = value;
        }
        if (isMove) {
            validateMoveNoInput(originalNo || sheetNo, true);
        } else if (isDiscard) {
            validateDiscardNoInput(originalNo || sheetNo, true);
        } else if (value && usesRegistrationCatalog('no', originalNo || sheetNo)) {
            updateBottomSheetClearButtons();
            updateSheetDropdownState();
            closeSheetOverlay();
            void confirmRegistrationNumber(originalNo || sheetNo, value, candidate);
            return;
        } else {
            fetchCardByNumber(originalNo || sheetNo, true);
        }
    } else if (activeOverlayType === 'loc') {
        const sheetLoc = document.getElementById('sheet-card-loc');
        if (sheetLoc?.disabled) {
            closeSheetOverlay();
            return;
        }
        if (sheetLoc) {
            sheetLoc.value = value;
            const locWrap = sheetLoc.closest('.custom-select-wrapper');
            if (locWrap && locWrap.dataset.options) {
                try {
                    const options = JSON.parse(locWrap.dataset.options);
                    const matchedOpt = options.find(o => (o.val || o) === value);
                    if (matchedOpt && matchedOpt.max !== undefined) {
                        sheetLoc.dataset.maxQty = matchedOpt.max;
                    }
                } catch {}
            }
            if (isMove) {
                handleMoveLocChange(sheetLoc);
            } else if (isDiscard) {
                handleDiscardLocChange(sheetLoc);
            } else {
                handleAddLocChange(sheetLoc);
            }
        }
        const originalLoc = row.querySelector(locClass);
        if (originalLoc) {
            originalLoc.value = value;
        }
        renderMobileCards();
    } else if (activeOverlayType === 'to' && isMove) {
        const sheetLoc = document.getElementById('sheet-card-loc');
        const fromVal = sheetLoc ? sheetLoc.value.trim() : '';
        if (fromVal && value && normalizeStr(fromVal) === normalizeStr(value)) {
            return; // 동일 위치 이동 대입 방지
        }
        document.getElementById('sheet-card-to').value = value;
        const originalTo = row.querySelector('.move-card-to');
        if (originalTo) {
            originalTo.value = value;
            renderMobileCards();
        }
    }

    updateBottomSheetClearButtons();
    updateSheetDropdownState();
    closeSheetOverlay();
}

// 9. 수량 오버레이 구현
function getCurrentMaxQty() {
    // 바텀시트가 열려 있는 경우 바텀시트 내부 수량 인풋을 1순위로 확인
    const sheetQtyInp = document.getElementById('sheet-card-qty');
    if (sheetQtyInp && sheetQtyInp.getAttribute('max')) {
        const parsedMax = parseInt(sheetQtyInp.getAttribute('max'));
        if (!isNaN(parsedMax) && parsedMax > 0) {
            return parsedMax;
        }
    }

    let qtyClass = '.page-card-qty';
    if (UIStore.mode === 'move') {
        qtyClass = '.move-card-qty';
    } else if (UIStore.mode === 'discard') {
        qtyClass = '.discard-card-qty';
    }

    const listContainer = getActiveMobileListContainer();
    if (listContainer && currentEditingRowIndex !== -1) {
        const cards = listContainer.querySelectorAll('.mobile-info-card[data-index]');
        const row = cards[currentEditingRowIndex];
        if (row) {
            const qtyInp = row.querySelector(qtyClass);
            if (qtyInp && qtyInp.max) {
                const parsedMax = parseInt(qtyInp.max);
                if (!isNaN(parsedMax) && parsedMax > 0) {
                    return parsedMax;
                }
            }
        }
    }
    return 99;
}

function setQtyPickerItemSelected(item, selected) {
    item.classList.toggle('selected', selected);
    item.classList.toggle('color-text-001', !selected);
    item.classList.toggle('color-text-theme', selected);
}

function openQtyOverlay(currentVal) {
    const overlay = document.getElementById('mobile-sheet-qty-overlay');
    const picker = document.getElementById('qty-picker-scroll-area');

    if (!overlay || !picker || !currentEditingRow) return;

    // 카드 정보 바텀시트와 동일한 높이 적용
    const entrySheet = document.getElementById('mobile-entry-bottom-sheet');
    const qtyContent = overlay.querySelector('.qty-overlay-content');
    if (entrySheet && qtyContent) {
        const sheetHeight = entrySheet.offsetHeight;
        if (sheetHeight > 0) {
            qtyContent.style.height = `${sheetHeight}px`;
        }
    }

    let val = Math.max(1, parseInt(currentVal) || 1);
    const maxQty = getCurrentMaxQty();
    if (val > maxQty) val = maxQty;
    
    qtyPickerSelectedVal = val;

    // 1 ~ maxQty 스크롤 휠 아이템 렌더링 (숫자 N만 표시)
    picker.innerHTML = '';
    for (let i = 1; i <= maxQty; i++) {
        const item = document.createElement('div');
        item.className = 'qty-picker-item';
        setQtyPickerItemSelected(item, i === val);
        item.innerText = i;
        item.dataset.val = i;
        item.setAttribute('role', 'button');
        item.setAttribute('aria-label', `${i}장`);
        item.tabIndex = i === val ? 0 : -1;
        item.onkeydown = event => {
            const direction = { ArrowUp: -1, ArrowDown: 1, Home: -maxQty, End: maxQty }[event.key];
            if (direction === undefined) return;
            event.preventDefault();
            const next = Math.max(1, Math.min(maxQty, i + direction));
            selectQtyFromPicker(next);
            focusModalReturnTarget(picker.querySelector(`.qty-picker-item[data-val="${next}"]`));
        };
        item.onclick = () => {
            if (item.classList.contains('selected')) {
                startQtyInlineInput(item);
            } else {
                selectQtyFromPicker(i);
            }
        };
        picker.appendChild(item);
    }

    openManagedSheet(overlay, {
        backdrop: overlay.querySelector('.ui-overlay__backdrop'),
        trigger: document.getElementById('sheet-card-qty'),
        onOpen: () => selectQtyFromPicker(val)
    });
}

function closeQtyOverlay() {
    const overlay = document.getElementById('mobile-sheet-qty-overlay');
    if (!isManagedSheetOpen(overlay)) return;
    const inlineInput = document.getElementById('qty-inline-input');
    if (inlineInput && !inlineInput.hidden) finishQtyInlineInput(inlineInput);
    const input = document.getElementById('sheet-card-qty');
    if (currentEditingRow && input) {
        input.value = String(Math.max(1, Math.min(getCurrentMaxQty(), qtyPickerSelectedVal)));
        recalcSiblingRowQtys(currentEditingRow);
    }
    closeManagedSheet(overlay, { backdrop: overlay.querySelector('.ui-overlay__backdrop') });
}

function selectQtyFromPicker(i) {
    qtyPickerSelectedVal = i;
    const picker = document.getElementById('qty-picker-scroll-area');
    picker.querySelectorAll('.qty-picker-item').forEach(item => {
        const selected = parseInt(item.dataset.val) === i;
        item.tabIndex = selected ? 0 : -1;
        setQtyPickerItemSelected(item, selected);
    });

    const selectedItem = picker.querySelector(`.qty-picker-item[data-val="${i}"]`);
    if (selectedItem) {
        picker.scrollTop = selectedItem.offsetTop - picker.clientHeight / 2 + selectedItem.clientHeight / 2;
    }
}

function resetQtyPickerVal() {
    selectQtyFromPicker(1);
}

function startQtyInlineInput(selectedItem) {
    const input = document.getElementById('qty-inline-input');
    const picker = document.getElementById('qty-picker-scroll-area');
    if (!input || !picker) return;

    // 입력 중에는 스크롤 방지
    picker.classList.add('is-direct-entry');

    input.value = selectedItem.dataset.val;
    input.hidden = false;
    input.focus();
    input.select();

    // 버튼 토글: 초기화 숨김, 체크 표시
    const resetBtn = document.getElementById('qty-reset-btn');
    const checkBtn = document.getElementById('qty-check-btn');
    if (resetBtn) resetBtn.hidden = true;
    if (checkBtn) checkBtn.hidden = false;
}

function finishQtyInlineInput(input) {
    if (!input || input.hidden) return;
    let val = parseInt(input.value);
    const maxQty = getCurrentMaxQty();
    if (isNaN(val) || val < 1) val = 1;
    if (val > maxQty) val = maxQty;

    qtyPickerSelectedVal = val;
    input.hidden = true;

    // 스크롤 잠금 해제
    const picker = document.getElementById('qty-picker-scroll-area');
    if (picker) {
        picker.classList.remove('is-direct-entry');
    }

    // 최종 선택 값으로 정렬
    selectQtyFromPicker(val);

    // 버튼 토글: 초기화 표시, 체크 숨김
    const resetBtn = document.getElementById('qty-reset-btn');
    const checkBtn = document.getElementById('qty-check-btn');
    if (resetBtn) resetBtn.hidden = false;
    if (checkBtn) checkBtn.hidden = true;
}

function handleQtyInlineInput(input) {
    let val = parseInt(input.value);
    if (isNaN(val) || val < 1) return;
    const maxQty = getCurrentMaxQty();
    if (val > maxQty) val = maxQty;

    qtyPickerSelectedVal = val;

    // 실시간으로 휠 스크롤 갱신 및 포지셔닝
    const picker = document.getElementById('qty-picker-scroll-area');
    if (picker) {
        picker.querySelectorAll('.qty-picker-item').forEach(item => {
            setQtyPickerItemSelected(item, parseInt(item.dataset.val) === val);
        });
        const selectedItem = picker.querySelector(`.qty-picker-item[data-val="${val}"]`);
        if (selectedItem) {
            picker.scrollTop = selectedItem.offsetTop - picker.clientHeight / 2 + selectedItem.clientHeight / 2;
        }
    }
}

function handleQtyPickerScroll(picker) {
    if (!isManagedSheetOpen(document.getElementById('mobile-sheet-qty-overlay'))) return;
    const items = picker.querySelectorAll('.qty-picker-item');
    const pickerCenter = picker.scrollTop + picker.clientHeight / 2;
    let closestItem = null;
    let minDiff = Infinity;

    items.forEach(item => {
        const itemCenter = item.offsetTop + item.clientHeight / 2;
        const diff = Math.abs(pickerCenter - itemCenter);
        if (diff < minDiff) {
            minDiff = diff;
            closestItem = item;
        }
    });

    if (closestItem) {
        const val = parseInt(closestItem.dataset.val);
        qtyPickerSelectedVal = val;
        items.forEach(it => {
            const selected = it === closestItem;
            it.tabIndex = selected ? 0 : -1;
            setQtyPickerItemSelected(it, selected);
        });
    }
}

// 10. 바텀 시트 지우기 기능 및 드롭다운 상태 제어
function updateBottomSheetClearButtons() {
    const nameInput = document.getElementById('sheet-card-name');
    const noInput = document.getElementById('sheet-card-no');

    if (nameInput) {
        const nameVal = nameInput.value.trim();
        const wrapper = nameInput.closest('.sheet-input-box');
        const nameClear = wrapper ? wrapper.querySelector('.clear-btn') : null;
        if (nameClear) nameClear.hidden = !nameVal;
        // 카드 이름은 기본적으로 화살표가 없으므로 제어 불필요
    }

    if (noInput) {
        const noVal = noInput.value.trim();
        const wrapper = noInput.closest('.sheet-input-box');
        const noClear = wrapper ? wrapper.querySelector('.clear-btn') : null;
        const arrow = wrapper ? wrapper.querySelector('.arrow-icon') : null;
        if (noClear) {
            const showClear = !!noVal;
            noClear.hidden = !showClear;
            if (arrow) {
                if (showClear) {
                    arrow.hidden = true; // 지우기 버튼 노출 시 화살표 감춤
                } else {
                    // 지우기 버튼 제거 시 옵션이 존재하는 상황인지 체크하고 복원
                    const hasOptions = wrapper && !wrapper.classList.contains('no-arrow') && !wrapper.classList.contains('no-option');
                    arrow.hidden = !hasOptions;
                }
            }
        }
    }
}

function updateSheetDropdownState() {
    const fields = document.querySelector('#sheet-fields-container .card-info-fields');
    if (!fields) return;
    const identityLocked = syncCardIdentityFieldLocks(fields);
    const awaitingNumber = !fields.querySelector('[data-field="no"]').value.trim();

    for (const box of fields.querySelectorAll('[data-field-wrap="illust"], [data-field-wrap="rare"]')) {
        const input = box.querySelector('input');
        let count = 0;
        try {
            const options = JSON.parse(box.dataset.options || '[]');
            if (Array.isArray(options)) count = options.length;
        } catch (error) {
            console.error(error);
        }
        const unavailable = awaitingNumber || count <= 1;
        box.classList.toggle('is-unavailable', unavailable);
        box.classList.toggle('is-awaiting-number', awaitingNumber);
        box.classList.toggle('color-text-000', !unavailable);
        box.classList.toggle('color-text-002', unavailable);
        input.tabIndex = unavailable ? -1 : 0;
        input.setAttribute('aria-disabled', String(unavailable));
        const arrow = box.querySelector('.arrow-icon');
        if (arrow) arrow.hidden = !(awaitingNumber || !unavailable);
    }

    const locBox = fields.querySelector('[data-field-wrap="loc"]');
    if (locBox) {
        locBox.classList.toggle('is-unavailable', identityLocked);
        locBox.classList.toggle('color-text-000', !identityLocked);
        locBox.classList.toggle('color-text-002', identityLocked);
    }

    for (const value of fields.querySelectorAll('.card-info-field-value')) {
        const input = value.previousElementSibling;
        value.textContent = input.closest('.is-awaiting-number') ? input.placeholder : input.value || input.placeholder;
    }
}

function clearBottomSheetField(type, event) {
    if (event) event.stopPropagation();
    if (currentEditingRowIndex === -1) return;

    const listContainer = getActiveMobileListContainer();
    if (!listContainer) return;

    const cards = listContainer.querySelectorAll('.mobile-info-card[data-index]');
    const row = cards[currentEditingRowIndex];
    if (!row) return;

    const isMove = (UIStore.mode === 'move');
    const isDiscard = (UIStore.mode === 'discard');

    if (isMove) {
        const nameInput = document.getElementById('sheet-card-name') || row.querySelector('.card-name-input');
        const noInput = document.getElementById('sheet-card-no') || row.querySelector('.move-card-no');
        const toInput = document.getElementById('sheet-card-to') || row.querySelector('.move-card-to');

        if (type === 'name') {
            if (nameInput) nameInput.value = "";
            if (noInput) noInput.value = "";
            resetMoveRow(row, 'no');
        } else if (type === 'no') {
            if (noInput) noInput.value = "";
            resetMoveRow(row, 'no');
        } else if (type === 'to') {
            const sheetTo = document.getElementById('sheet-card-to');
            if (sheetTo) sheetTo.value = "";
            if (toInput) toInput.value = "";
        }
    } else if (isDiscard) {
        const nameInput = document.getElementById('sheet-card-name') || row.querySelector('.card-name-input');
        const noInput = document.getElementById('sheet-card-no') || row.querySelector('.discard-card-no');

        if (type === 'name') {
            if (nameInput) nameInput.value = "";
            if (noInput) noInput.value = "";
            resetDiscardRow(row, 'no');
        } else if (type === 'no') {
            if (noInput) noInput.value = "";
            resetDiscardRow(row, 'no');
        }
    } else {
        const nameInput = document.getElementById('sheet-card-name') || row.querySelector('.page-card-name');
        const noInput = document.getElementById('sheet-card-no') || row.querySelector('.page-card-no');

        const searchMode = row.dataset.searchMode;
        const isNameMode = (searchMode === "name" || (noInput && noInput.dataset.lockedForName === "true"));

        if (isNameMode) {
            if (type === 'name') {
                // 이름 지우면 둘 다 삭제
                clearPageNameAndNo(nameInput || document.getElementById('sheet-card-name') || row);
            } else if (type === 'no') {
                // 번호 지우면 번호만 삭제
                if (noInput) {
                    noInput.value = "";
                    noInput.dataset.prevCardNo = "";
                }
                const rarityInp = document.getElementById('sheet-card-rarity') || row.querySelector('.page-card-rarity');
                if (rarityInp) {
                    rarityInp.value = "";
                    rarityInp.dataset.raw = "";
                }
                const illustInp = document.getElementById('sheet-card-illust') || row.querySelector('.page-card-illustration');
                if (illustInp) {
                    setIllustrationValue(illustInp, "");
                    illustInp.dataset.raw = "";
                }
                const rareWrap = document.getElementById('wrap-sheet-rare') || row.querySelector('[data-field-wrap="rare"]');
                if (rareWrap) {
                    rareWrap.dataset.options = "[]";
                    rareWrap.classList.add('no-option');
                }
                const illustWrap = document.getElementById('wrap-sheet-illust') || row.querySelector('[data-field-wrap="illust"]');
                if (illustWrap) {
                    illustWrap.dataset.options = "[]";
                    illustWrap.classList.add('no-option');
                }
            }
        } else {
            // 번호 선입력 상태는 이름/번호 중 뭘 지우든 둘 다 삭제
            clearPageNameAndNo(noInput || nameInput || document.getElementById('sheet-card-no') || row);
        }
    }

    // 바텀 시트와 모바일 카드 동기화
    renderMobileCards();
    updateBottomSheetClearButtons();
}

function openSheetDropdownOverlay(type) {
    if (!currentEditingRow) return;
    if (document.getElementById(type === 'illust' ? 'wrap-sheet-illust' : 'wrap-sheet-rare')?.classList.contains('is-unavailable')) return;
    if (type === 'illust') {
        const input = document.getElementById('sheet-card-illust');
        const wrapper = document.getElementById('wrap-sheet-illust');
        if (input && wrapper) openIllustrationPicker(input, wrapper);
        return;
    }
    const dropdownSheet = document.getElementById('mobile-sheet-dropdown-select');
    const dropdownOverlay = document.getElementById('sheet-dropdown-overlay');
    const optionsList = document.getElementById('dropdown-select-options-list');
    const titleSpan = document.getElementById('dropdown-select-title');

    if (!dropdownSheet || !dropdownOverlay || !optionsList || !titleSpan) return;

    let targetWrapId = (type === 'rare') ? 'wrap-sheet-rare' : 'wrap-sheet-illust';
    const wrap = document.getElementById(targetWrapId);
    if (!wrap) return;

    try {
        const options = JSON.parse(wrap.dataset.options || '[]');
        if (options.length <= 1) return;

        titleSpan.innerText = (type === 'rare') ? '레어도 선택' : '일러스트 선택';
        optionsList.innerHTML = '';

        const currentVal = (type === 'rare') ? 
            document.getElementById('sheet-card-rarity').value.trim() : 
            document.getElementById('sheet-card-illust').value.trim();

        options.forEach(opt => {
            let val = '';
            let raw = '';
            let displayText = '';
            if (typeof opt === 'object' && opt !== null) {
                val = opt.val || '';
                raw = opt.raw || val;
                displayText = opt.text || val;
            } else {
                val = String(opt);
                raw = val;
                displayText = (type === 'rare') ? getLocalizedRarity(val) : val;
            }

            const li = document.createElement('li');
            li.innerText = displayText;
            const selected = displayText === currentVal || val === currentVal;
            li.classList.toggle('selected', selected);
            li.classList.add('rarity-sheet-option', 'ui-button', 'color-type002', 'border-basic', 'shape-rounded003');
            li.setAttribute('aria-pressed', String(selected));
            if (selected) {
                const check = document.createElement('i');
                check.className = 'material-icons';
                check.setAttribute('aria-hidden', 'true');
                check.textContent = 'check';
                li.appendChild(check);
            }
            li.setAttribute('role', 'button');
            li.tabIndex = 0;
            li.onclick = () => {
                selectSheetDropdownItem(type, val, raw, displayText);
            };
            optionsList.appendChild(li);
        });

        openManagedSheet(dropdownSheet, {
            backdrop: dropdownOverlay,
            trigger: wrap.querySelector('input')
        });
    } catch (e) {
        console.error(e);
    }
}

function closeSheetDropdownSelect() {
    closeManagedSheet(document.getElementById('mobile-sheet-dropdown-select'), {
        backdrop: document.getElementById('sheet-dropdown-overlay')
    });
}

function selectSheetDropdownItem(type, val, raw, text) {
    if (currentEditingRowIndex === -1) return;

    const row = currentEditingRow;
    if (!row) return;

    const isMove = (UIStore.mode === 'move');
    const isDiscard = (UIStore.mode === 'discard');

    const rarityClass = isMove ? '.move-card-rarity' : (isDiscard ? '.discard-card-rarity' : '.page-card-rarity');
    const illustClass = isMove ? '.move-card-illustration' : (isDiscard ? '.discard-card-illustration' : '.page-card-illustration');

    if (type === 'rare') {
        const sheetInput = document.getElementById('sheet-card-rarity');
        if (sheetInput?.disabled) return;
        if (sheetInput) {
            const localizedText = text || getLocalizedRarity(raw || val);
            sheetInput.value = localizedText;
            sheetInput.dataset.raw = raw;
            if (isMove) {
                handleMoveRareChange(sheetInput);
            } else if (isDiscard) {
                handleDiscardRareChange(sheetInput);
            } else {
                handleAddRareChange(sheetInput);
            }
        }
        const originalRare = row.querySelector(rarityClass);
        if (originalRare) {
            const localizedText = text || getLocalizedRarity(raw || val);
            originalRare.value = localizedText;
            originalRare.dataset.raw = raw;
        }
    } else if (type === 'illust') {
        const sheetInput = document.getElementById('sheet-card-illust');
        if (sheetInput?.disabled) return;
        if (sheetInput) {
            sheetInput.value = val;
            sheetInput.dataset.raw = raw;
            if (isMove) {
                handleMoveIllustChange(sheetInput);
            } else if (isDiscard) {
                handleDiscardIllustChange(sheetInput);
            }
        }
        const originalIllust = row.querySelector(illustClass);
        if (originalIllust) {
            originalIllust.value = val;
            originalIllust.dataset.raw = raw;
        }
    }

    renderMobileCards();
    closeSheetDropdownSelect();
}

// 11. 초기 DOM 로드 시 바텀 오버레이 이벤트 리스너 추가
function initOverlaySearchListeners() {
    // 오버레이 입력 실시간 감지
    const overlayInput = document.getElementById('overlay-search-input');
    const overlayClearBtn = document.getElementById('overlay-clear-btn');
    if (overlayInput) {
        if (overlayInput._isInputBound) return;
        overlayInput._isInputBound = true;

        const show = (val) => {
            if (isManagedSheetOpen(document.getElementById('mobile-sheet-input-overlay'))) showOverlaySuggestions(val);
        };
        const debouncedShowSuggestions = debounce(show, 100);
        const debouncedShowPackSuggestions = debounce(show, 100);
        overlayInput._cancelSuggestions = () => {
            debouncedShowSuggestions.cancel();
            debouncedShowPackSuggestions.cancel();
            packOverlaySuggestionRequest?.abort();
            registrationOverlaySuggestions?.abort();
        };

        overlayInput.addEventListener('input', (e) => {
            registrationOverlaySuggestions?.abort();
            const pack = activeOverlayType === 'pack';
            if (pack) {
                overlayInput._cancelSuggestions();
                const list = document.getElementById('overlay-suggestions-list');
                if (list && overlayInput.value.trim()) {
                    renderPackOverlaySuggestions(list, filterPackNameMatches(packOverlayLastSuggestions, overlayInput.value));
                }
            }
            if (activeOverlayType === 'no') {
                const start = e.target.selectionStart;
                e.target.value = e.target.value.replace(/[ㄱ-ㅎ|ㅏ-ㅣ|가-힣]/g, '').toUpperCase();
                e.target.setSelectionRange(start, start);
            }
            const val = e.target.value.trim();
            if (val) {
                const field = activeOverlayType;
                if (field === 'photo-name' || (UIStore.mode === 'add' && (field === 'name' || field === 'no'))) {
                    const list = document.getElementById('overlay-suggestions-list');
                    const choices = field === 'name' && registrationNameChoices(document.getElementById('sheet-card-name'));
                    const matches = choices
                        ? choices.filter(choice => normalizeStr(choice.value).includes(normalizeStr(val)))
                        : filterRegistrationCatalogSuggestions(registrationOverlayLastSuggestions, field === 'photo-name' ? 'name' : field, val);
                    if (list) renderCardOverlaySuggestions(list, matches, { remember: false });
                }
                if (overlayClearBtn) overlayClearBtn.hidden = false;
                (pack ? debouncedShowPackSuggestions : debouncedShowSuggestions)(val);
            } else {
                registrationOverlayLastSuggestions = [];
                debouncedShowSuggestions.cancel && debouncedShowSuggestions.cancel();
                if (overlayClearBtn) overlayClearBtn.hidden = true;
                showOverlaySuggestions('');
            }
        });

        // 입력 오버레이에서 엔터를 칠 때 입력 확정 처리
        overlayInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
                e.preventDefault();
                selectOverlayItem(overlayInput.value.trim());
            }
        });
    }
}

/* ==========================================================================
   데스크톱 카드 UI 렌더링 및 동기화 구현
   ========================================================================== */

function getSelectWrapperState(inputEl) {
    const wrap = inputEl ? inputEl.closest('.custom-select-wrapper') : null;
    if (!wrap) return null;
    return {
        options: wrap.dataset.options || null,
        isSingle: wrap.classList.contains('single-option'),
        isNoOption: wrap.classList.contains('no-option')
    };
}

function restoreSelectWrapperState(inputEl, state) {
    const wrap = inputEl ? inputEl.closest('.custom-select-wrapper') : null;
    if (!wrap || !state) return;
    if (state.options !== null) wrap.dataset.options = state.options;
    else delete wrap.dataset.options;

    if (state.isSingle) wrap.classList.add('single-option');
    else wrap.classList.remove('single-option');

    if (state.isNoOption) wrap.classList.add('no-option');
    else wrap.classList.remove('no-option');
}



function renderDesktopCardsFromData(dataArray, previousRows) {
    let listContainerId = 'desktop-cards-list-general';
    if (UIStore.mode === 'move') {
        listContainerId = 'desktop-cards-list-move';
    } else if (UIStore.mode === 'discard') {
        listContainerId = 'desktop-cards-list-discard';
    }

    const listContainer = document.getElementById(listContainerId);
    if (!listContainer) return;

    const previousChildren = previousRows && [...listContainer.children];
    listContainer.querySelectorAll('.desktop-info-card[data-index]').forEach(releaseDesktopCardFields);
    listContainer.replaceChildren();

    if (dataArray.length === 0) {
        globalThis.AppOverlays?.restoreRowExits?.(listContainer, previousChildren);
        return;
    }

    dataArray.forEach((data, idx) => {
        const nextNum = idx + 1;
        const cardHtml = getDesktopCardHtml(UIStore.mode, idx, nextNum);
        listContainer.insertAdjacentHTML('beforeend', cardHtml);

        const cardEl = listContainer.querySelector(`.desktop-info-card[data-index="${idx}"]`);
        if (cardEl) {
            if (data.searchMode) cardEl.dataset.searchMode = data.searchMode;
            if (data.cardData) cardEl.dataset.cardData = JSON.stringify(data.cardData);

            const nameInp = cardEl.querySelector('[data-field="name"]');
            const noInp = cardEl.querySelector('[data-field="no"]');
            const illustInp = cardEl.querySelector('[data-field="illust"]');
            const rareInp = cardEl.querySelector('[data-field="rare"]');
            const locInp = cardEl.querySelector('[data-field="loc"]');
            const toInp = cardEl.querySelector('[data-field="to"]');
            const qtyInp = cardEl.querySelector('[data-field="qty"]');

            if (nameInp) nameInp.value = data.name;
            if (noInp) noInp.value = data.cardNo;
            if (illustInp) {
                setIllustrationValue(illustInp, data.illustration);
                illustInp.dataset.raw = data.illustration;
            }
            if (rareInp) {
                rareInp.value = getLocalizedRarity(data.rarity);
                rareInp.dataset.raw = data.rarity;
            }
            if (locInp) locInp.value = data.loc;
            if (toInp) toInp.value = data.to;
            if (qtyInp) qtyInp.value = data.qty;

            if (data.cardData && data.name) {
                const linkData = data.cardData.linkData;
                lockNameInputAndSetLink(nameInp, data.name, cardEl, linkData);
            }

            if (data.wrapperStates) {
                restoreSelectWrapperState(nameInp, data.wrapperStates.name);
                restoreSelectWrapperState(noInp, data.wrapperStates.no);
                restoreSelectWrapperState(illustInp, data.wrapperStates.illust);
                restoreSelectWrapperState(rareInp, data.wrapperStates.rare);
                restoreSelectWrapperState(locInp, data.wrapperStates.loc);
                restoreSelectWrapperState(toInp, data.wrapperStates.to);
            }

            initCardWidgets(cardEl);
            restoreDesktopDropdownOptions(cardEl, data);
            if (previousRows?.[idx]) globalThis.AppOverlays?.animateRowEntrance?.(cardEl, previousRows[idx]);
        }
    });
    globalThis.AppOverlays?.restoreRowExits?.(listContainer, previousChildren);
    reindexDesktopCards(listContainer);
}



function reindexDesktopCards(listContainer) {
    const cards = listContainer.querySelectorAll('.desktop-info-card[data-index]');
    const isSingleRow = (cards.length === 1);

    cards.forEach((card, idx) => {
        card.dataset.index = idx;
        const badge = card.querySelector('.card-num-badge');
        if (badge) badge.innerText = idx + 1;

        const nextNum = idx + 1;
        const fromWrap = card.querySelector('[id^="desktop-wrap-move-from-"]');
        if (fromWrap) fromWrap.id = `desktop-wrap-move-from-${nextNum}`;
        const toWrap = card.querySelector('[id^="desktop-wrap-move-to-"]');
        if (toWrap) toWrap.id = `desktop-wrap-move-to-${nextNum}`;
        const genWrap = card.querySelector('[id^="desktop-wrap-"]');
        if (genWrap && !fromWrap && !toWrap) {
            const mode = UIStore.mode;
            genWrap.id = `desktop-wrap-${mode}-${idx}`;
        }

        // 단일 행일 때 제거 버튼 비활성화
        const delBtn = card.querySelector('.btn-card-action.delete');
        if (delBtn) {
            if (isSingleRow) {
                delBtn.setAttribute('disabled', 'true');
            } else {
                delBtn.removeAttribute('disabled');
            }
        }
    });
    updateManagementCardStack(cards);
}

function restoreDesktopDropdownOptions(cardEl, data) {
    const isMove = (UIStore.mode === 'move');
    const isDiscard = (UIStore.mode === 'discard');
    if (isMove || isDiscard) {
        const cardNo = data.cardNo;
        if (!cardNo) return;
        const matches = cardCacheInstance.getInventory().filter(r => String(r[1]).trim().toUpperCase() === cardNo);
        if (matches.length > 0) {
            if (isMove) updateMoveIllusts(cardEl, matches);
            else updateDiscardIllusts(cardEl, matches);
        }
    } else {
        if (data.cardData) {
            applyPageCardDataToRows(data.cardData, cardEl);
        }
    }
}



function desktopAddEntry(mode, initialData = null) {
    let listContainerId = 'desktop-cards-list-general';
    if (mode === 'move') {
        listContainerId = 'desktop-cards-list-move';
    } else if (mode === 'discard') {
        listContainerId = 'desktop-cards-list-discard';
    }

    const listContainer = document.getElementById(listContainerId);
    if (!listContainer) return null;

    const currentCount = listContainer.querySelectorAll('.desktop-info-card[data-index]').length;
    const nextNum = currentCount + 1;
    const cardHtml = getDesktopCardHtml(mode, currentCount, nextNum);
    listContainer.insertAdjacentHTML('beforeend', cardHtml);

    const cardEl = listContainer.querySelector(`.desktop-info-card[data-index="${currentCount}"]`);
    if (cardEl) {
        initCardWidgets(cardEl);
        
        if (mode === 'add') {
            const locInp = cardEl.querySelector('[data-field="loc"]');
            if (locInp) locInp.removeAttribute('readonly');

            const autoLocInput = document.getElementById('auto-location-input');
            const autoLocWrapper = document.getElementById('wrap-auto-loc');
            if (autoLocInput && autoLocInput.value.trim() && autoLocWrapper && autoLocWrapper.classList.contains('active-highlight')) {
                if (locInp) locInp.value = autoLocInput.value.trim();
            }
        }

        if (initialData) {
            const nameInp = cardEl.querySelector('[data-field="name"]');
            const noInp = cardEl.querySelector('[data-field="no"]');
            const illustInp = cardEl.querySelector('[data-field="illust"]');
            const rareInp = cardEl.querySelector('[data-field="rare"]');
            const locInp = cardEl.querySelector('[data-field="loc"]');
            const toInp = cardEl.querySelector('[data-field="to"]');
            const qtyInp = cardEl.querySelector('[data-field="qty"]');

            if (nameInp) nameInp.value = initialData.name || "";
            if (noInp) noInp.value = initialData.cardNo || "";
            if (illustInp) {
                setIllustrationValue(illustInp, initialData.illustration || "");
                illustInp.dataset.raw = initialData.illustration || "";
            }
            if (rareInp) {
                rareInp.value = getLocalizedRarity(initialData.rarity) || "";
                rareInp.dataset.raw = initialData.rarity || "";
            }
            if (locInp) locInp.value = initialData.loc || "";
            if (toInp) toInp.value = initialData.to || "";
            if (qtyInp) qtyInp.value = initialData.qty || "1";

            if (initialData.cardData) {
                cardEl.dataset.cardData = JSON.stringify(initialData.cardData);
                if (initialData.name) {
                    lockNameInputAndSetLink(nameInp, initialData.name, cardEl, initialData.cardData.linkData);
                }
                restoreDesktopDropdownOptions(cardEl, initialData);
            }
        }
    }

    reindexDesktopCards(listContainer);
    globalThis.AppOverlays?.animateRowEntrance?.(cardEl);
    return cardEl;
}

function renderDesktopCards() {
    const isMobile = document.documentElement.classList.contains('is-mobile-device');
    if (isMobile) return;

    let listContainerId = 'desktop-cards-list-general';
    if (UIStore.mode === 'move') {
        listContainerId = 'desktop-cards-list-move';
    } else if (UIStore.mode === 'discard') {
        listContainerId = 'desktop-cards-list-discard';
    }

    const listContainer = document.getElementById(listContainerId);
    if (!listContainer) return;

    const cards = listContainer.querySelectorAll('.desktop-info-card[data-index]');
    const collectedData = [];
    cards.forEach(c => {
        collectedData.push(getDesktopCardData(c));
    });

    renderDesktopCardsFromData(collectedData, cards);
}



function getDesktopCardHtml(mode, idx, nextNum) {
    if (mode === 'move') {
        return `
            <div class="desktop-info-card desktop-info-card--editable ui-stack-card shape-rounded003 ${idx % 2 === 0 ? 'color-card-odd' : 'color-card-even'}" data-index="${idx}">
                <div class="card-row-top">
                    <div class="desktop-card-index">
                        <div class="desktop-card-index-badge">
                            <span class="card-num-badge">${nextNum}</span>
                        </div>
                        <span class="card-num-divider color-text-table" aria-hidden="true">|</span>
                    </div>
                    <div class="custom-select-wrapper no-arrow" data-card-field="name">
                        <input type="text" class="desktop-card-input color-text-table shape-capsule browser-default border-cardinput desktop-card-name custom-input" data-field="name" placeholder="카드 이름" autocomplete="off">
                        <i class="material-icons clear-name-btn" onclick="clearPageNameAndNo(this)">cancel</i>
                    </div>
                    <div class="custom-select-wrapper no-arrow" data-card-field="no">
                        <input type="text" class="desktop-card-input color-text-table shape-capsule browser-default border-cardinput desktop-card-no custom-input" data-field="no" placeholder="카드 번호" autocomplete="off">
                        <i class="material-icons arrow-icon">arrow_drop_down</i>
                    </div>
                    <div class="card-actions">
                        <button type="button" class="btn-card-action delete ui-button color-danger ui-control--disabled color-disabled" onclick="triggerDesktopDelete(this)" title="제거" aria-label="제거"><i class="material-icons" aria-hidden="true">delete</i></button>
                    </div>
                </div>
                <div class="card-row-bottom">
                    <div class="custom-select-wrapper no-option" data-type="strict" data-card-field="illust">
                        <input type="text" class="desktop-card-input color-text-table shape-capsule browser-default border-cardinput desktop-card-illust custom-input" data-field="illust" inputmode="none" role="button" aria-label="일러스트 선택" aria-haspopup="dialog" aria-expanded="false" placeholder="일러스트" readonly>
                        <i class="material-icons arrow-icon">arrow_drop_down</i>
                    </div>
                    <div class="custom-select-wrapper no-option" data-type="strict" data-card-field="rare">
                        <input type="text" class="desktop-card-input color-text-table shape-capsule browser-default border-cardinput desktop-card-rare custom-input" data-field="rare" placeholder="레어도" readonly>
                        <i class="material-icons arrow-icon">arrow_drop_down</i>
                    </div>
                    <div class="desktop-card-move-locations">
                        <div class="custom-select-wrapper no-option" data-type="strict" id="desktop-wrap-move-from-${nextNum}" data-card-field="loc">
                            <input type="text" class="desktop-card-input color-text-table shape-capsule browser-default border-cardinput desktop-card-loc custom-input" data-field="loc" placeholder="보관 위치" readonly>
                            <i class="material-icons arrow-icon">arrow_drop_down</i>
                        </div>
                        <i class="material-icons loc-arrow">arrow_forward</i>
                        <div class="custom-select-wrapper" data-type="free" id="desktop-wrap-move-to-${nextNum}" data-card-field="to">
                            <input type="text" class="desktop-card-input color-text-table shape-capsule browser-default border-cardinput desktop-card-to custom-input" data-field="to" placeholder="이동 위치">
                            <i class="material-icons arrow-icon">arrow_drop_down</i>
                        </div>
                    </div>
                    <div class="desktop-qty-wrapper border-cardinput shape-capsule color-text-table">
                        <input type="number" class="desktop-card-input color-text-table shape-capsule browser-default desktop-card-qty qty-input" data-field="qty" placeholder="수량" min="1" readonly oninput="handleCardQtyInput(this)" onfocus="updateMoveRowMaxQty(this)">
                        <span>장</span>
                        <div class="desktop-qty-controls">
                            <div class="qty-up-btn" onclick="adjustStepQty(this, 1)"><i class="material-icons">keyboard_arrow_up</i></div>
                            <div class="qty-down-btn" onclick="adjustStepQty(this, -1)"><i class="material-icons">keyboard_arrow_down</i></div>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    const isDiscard = (mode === 'discard');
    const actionsHtml = isDiscard ? `
        <button type="button" class="btn-card-action delete ui-button color-danger ui-control--disabled color-disabled" onclick="triggerDesktopDelete(this)" title="제거" aria-label="제거"><i class="material-icons" aria-hidden="true">delete</i></button>
    ` : `
        <button type="button" class="btn-card-action copy ui-button color-theme" onclick="triggerDesktopCopy(this)" title="복제" aria-label="복제"><i class="material-icons" aria-hidden="true">library_add</i></button>
        <button type="button" class="btn-card-action delete ui-button color-danger ui-control--disabled color-disabled" onclick="triggerDesktopDelete(this)" title="제거" aria-label="제거"><i class="material-icons" aria-hidden="true">delete</i></button>
    `;

    const locPlaceholder = "보관 위치";
    const locReadonly = isDiscard ? "readonly" : "";

    return `
        <div class="desktop-info-card desktop-info-card--editable ui-stack-card shape-rounded003 ${idx % 2 === 0 ? 'color-card-odd' : 'color-card-even'}" data-index="${idx}">
            <div class="card-row-top">
                <div class="desktop-card-index">
                    <div class="desktop-card-index-badge">
                        <span class="card-num-badge">${nextNum}</span>
                    </div>
                    <span class="card-num-divider color-text-table" aria-hidden="true">|</span>
                </div>
                <div class="custom-select-wrapper no-arrow" data-card-field="name">
                    <input type="text" class="desktop-card-input color-text-table shape-capsule browser-default border-cardinput desktop-card-name custom-input" data-field="name" placeholder="카드 이름" autocomplete="off">
                    <i class="material-icons clear-name-btn" onclick="clearPageNameAndNo(this)">cancel</i>
                </div>
                <div class="custom-select-wrapper no-arrow" data-card-field="no">
                    <input type="text" class="desktop-card-input color-text-table shape-capsule browser-default border-cardinput desktop-card-no custom-input" data-field="no" placeholder="카드 번호" autocomplete="off">
                    <i class="material-icons arrow-icon">arrow_drop_down</i>
                </div>
                <div class="card-actions">
                    ${actionsHtml}
                </div>
            </div>
            <div class="card-row-bottom">
                <div class="custom-select-wrapper no-option" data-type="strict" data-card-field="illust">
                    <input type="text" class="desktop-card-input color-text-table shape-capsule browser-default border-cardinput desktop-card-illust custom-input" data-field="illust" inputmode="none" role="button" aria-label="일러스트 선택" aria-haspopup="dialog" aria-expanded="false" placeholder="일러스트" readonly>
                    <i class="material-icons arrow-icon">arrow_drop_down</i>
                </div>
                <div class="custom-select-wrapper no-option" data-type="strict" data-card-field="rare">
                    <input type="text" class="desktop-card-input color-text-table shape-capsule browser-default border-cardinput desktop-card-rare custom-input" data-field="rare" placeholder="레어도" readonly>
                    <i class="material-icons arrow-icon">arrow_drop_down</i>
                </div>
                <div class="custom-select-wrapper${mode === 'discard' ? ' no-option' : ''}" data-type="${mode === 'add' ? 'free' : 'strict'}" id="desktop-wrap-${mode}-${idx}" data-card-field="loc">
                    <input type="text" class="desktop-card-input color-text-table shape-capsule browser-default border-cardinput desktop-card-loc custom-input" data-field="loc" placeholder="${locPlaceholder}" ${locReadonly}>
                    <i class="material-icons arrow-icon">arrow_drop_down</i>
                </div>
                <div class="desktop-qty-wrapper border-cardinput shape-capsule color-text-table">
                    <input type="number" class="desktop-card-input color-text-table shape-capsule browser-default desktop-card-qty qty-input" data-field="qty" placeholder="수량" min="1" readonly oninput="handleCardQtyInput(this)">
                    <span>장</span>
                    <div class="desktop-qty-controls">
                        <div class="qty-up-btn" onclick="adjustStepQty(this, 1)"><i class="material-icons">keyboard_arrow_up</i></div>
                        <div class="qty-down-btn" onclick="adjustStepQty(this, -1)"><i class="material-icons">keyboard_arrow_down</i></div>
                    </div>
                </div>
            </div>
        </div>
    `;
}









function getDesktopCardData(cardEl) {
    const nameInp = cardEl.querySelector('[data-field="name"]');
    const noInp = cardEl.querySelector('[data-field="no"]');
    const illustInp = cardEl.querySelector('[data-field="illust"]');
    const rareInp = cardEl.querySelector('[data-field="rare"]');
    const locInp = cardEl.querySelector('[data-field="loc"]');
    const toInp = cardEl.querySelector('[data-field="to"]');
    const qtyInp = cardEl.querySelector('[data-field="qty"]');

    let cardDataObj = null;
    if (cardEl.dataset.cardData) {
        try { cardDataObj = JSON.parse(cardEl.dataset.cardData); } catch (e) {}
    }

    return {
        name: nameInp ? nameInp.value.trim() : "",
        cardNo: noInp ? noInp.value.trim().toUpperCase() : "",
        illustration: getIllustrationValue(illustInp),
        rarity: rareInp ? (rareInp.dataset.raw || rareInp.value) : "",
        loc: locInp ? locInp.value.trim() : "",
        to: toInp ? toInp.value.trim() : "",
        qty: qtyInp ? (qtyInp.value.trim() === "" ? "" : (parseInt(qtyInp.value) || 1)) : 1,
        cardData: cardDataObj,
        searchMode: cardEl.dataset.searchMode || "",
        wrapperStates: {
            name: getSelectWrapperState(nameInp),
            no: getSelectWrapperState(noInp),
            illust: getSelectWrapperState(illustInp),
            rare: getSelectWrapperState(rareInp),
            loc: getSelectWrapperState(locInp),
            to: getSelectWrapperState(toInp)
        }
    };
}

function triggerDesktopCopy(btn) {
    let listContainerId = 'desktop-cards-list-general';
    if (UIStore.mode === 'move') {
        listContainerId = 'desktop-cards-list-move';
    } else if (UIStore.mode === 'discard') {
        listContainerId = 'desktop-cards-list-discard';
    }

    const listContainer = document.getElementById(listContainerId);
    if (!listContainer) return;
    const card = btn.closest('.desktop-info-card');
    if (!card) return;

    const data = getDesktopCardData(card);
    const copyData = {
        name: data.name,
        cardNo: data.cardNo,
        illustration: data.illustration,
        rarity: data.rarity,
        loc: data.loc,
        to: data.to,
        qty: "1",
        cardData: data.cardData
    };

    const newCard = desktopAddEntry(UIStore.mode, copyData);
    if (newCard) {
        if (card.nextSibling) {
            listContainer.insertBefore(newCard, card.nextSibling);
        }
        reindexDesktopCards(listContainer);
        const focusInp = newCard.querySelector('[data-field="no"]');
        if (focusInp) focusInp.focus();
    }
}

function triggerDesktopDelete(btn) {
    let listContainerId = 'desktop-cards-list-general';
    if (UIStore.mode === 'move') {
        listContainerId = 'desktop-cards-list-move';
    } else if (UIStore.mode === 'discard') {
        listContainerId = 'desktop-cards-list-discard';
    }

    const listContainer = document.getElementById(listContainerId);
    if (!listContainer) return;
    const card = btn.closest('.desktop-info-card[data-index]');
    if (!card) return;

    const delBtn = card.querySelector('.btn-card-action.delete');
    if (delBtn && delBtn.hasAttribute('disabled')) return;

    releaseDesktopCardFields(card);
    if (!globalThis.AppOverlays?.animateRowExit?.(card)) card.remove();
    reindexDesktopCards(listContainer);
    
    const remainingCards = listContainer.querySelectorAll('.desktop-info-card[data-index]');
    if (remainingCards.length === 0) {
        desktopAddEntry(UIStore.mode);
    }
}

function savePendingFormData() {
    if (typeof UIStore.mode === 'undefined') return;
    
    const payload = {
        mode: UIStore.mode,
        ts: Date.now(),
        data: {}
    };

    const isMobile = document.documentElement.classList.contains('is-mobile-device');
    const listMode = UIStore.mode === 'add' ? 'general' : UIStore.mode;
    const containerId = `${isMobile ? 'mobile' : 'desktop'}-cards-list-${listMode}`;
    const container = document.getElementById(containerId);

    if (container) {
        const cardClass = isMobile ? '.mobile-info-card[data-index]' : '.desktop-info-card[data-index]';
        const cards = container.querySelectorAll(cardClass);
        const rows = [];
        cards.forEach(card => {
            const cardNoInput = card.querySelector('[data-field="no"]');
            const cardNameInput = card.querySelector('[data-field="name"]');
            const rarityInput = card.querySelector('[data-field="rare"]');
            const qtyInput = card.querySelector('[data-field="qty"]');
            const locInput = card.querySelector('[data-field="loc"]');
            const toInput = card.querySelector('[data-field="to"]');
            const illustrationInput = card.querySelector('[data-field="illust"]');

            if (cardNoInput && cardNoInput.value.trim()) {
                rows.push({
                    cardNo: cardNoInput.value.trim(),
                    cardName: cardNameInput ? cardNameInput.value.trim() : '',
                    rarity: rarityInput ? rarityInput.value : '',
                    rarityRaw: rarityInput ? (rarityInput.dataset.raw || '') : '',
                    qty: qtyInput ? parseInt(qtyInput.value) || 1 : 1,
                    loc: locInput ? locInput.value.trim() : '',
                    to: toInput ? toInput.value.trim() : '',
                    illustration: getIllustrationValue(illustrationInput)
                });
            }
        });
        payload.data.rows = rows;
    }

    if (UIStore.mode === 'move') {
        if (typeof isRenameMode !== 'undefined' && isRenameMode) {
            payload.data.isRenameMode = true;
            const renameFrom = document.getElementById('rename-from-input');
            const renameTo = document.getElementById('rename-to-input');
            payload.data.renameFromVal = renameFrom ? renameFrom.value.trim() : '';
            payload.data.renameToVal = renameTo ? renameTo.value.trim() : '';
        }
    }

    try {
        sessionStorage.setItem('pending_action_data', JSON.stringify(payload));
    } catch (e) {
        console.error('[Auth] Failed to save pending action data:', e);
    }
}

function restorePendingFormData() {
    let raw;
    try {
        raw = sessionStorage.getItem('pending_action_data');
    } catch (e) {
        console.error('[Auth] Failed to read pending action data:', e);
        return;
    }
    if (!raw) return;

    let payload;
    try {
        payload = JSON.parse(raw);
    } catch (e) {
        console.error('[Auth] Failed to parse pending action data:', e);
        sessionStorage.removeItem('pending_action_data');
        return;
    }

    if (!payload || !payload.mode || (Date.now() - payload.ts > 1800000)) {
        sessionStorage.removeItem('pending_action_data');
        return;
    }

    switchToMode(payload.mode, true);
    const rows = payload.data?.rows;
    if (!Array.isArray(rows) || (!rows.length && !payload.data.isRenameMode)) {
        sessionStorage.removeItem('pending_action_data');
        return;
    }

    setTimeout(() => {
        const dataArray = rows.map(r => ({
            name: r.nameText || r.cardName || "",
            cardNo: r.cardNo || "",
            illustration: r.illustrationRaw || r.illustration || "",
            rarity: r.procRaw || r.rarityRaw || r.rarity || "",
            loc: r.loc || r.currentLoc || "",
            to: r.targetLoc || r.to || "",
            qty: r.qty || r.moveQty || 1,
            cardData: null
        }));

        if (payload.mode === 'move' && payload.data.isRenameMode) {
            isRenameMode = true;
            const renameFrom = document.getElementById('rename-from-input');
            const renameTo = document.getElementById('rename-to-input');
            if (renameFrom && payload.data.renameFromVal) renameFrom.value = payload.data.renameFromVal;
            if (renameTo && payload.data.renameToVal) renameTo.value = payload.data.renameToVal;
        }

        if (dataArray.length) {
            if (document.documentElement.classList.contains('is-mobile-device')) renderMobileCardsFromData(dataArray);
            else renderDesktopCardsFromData(dataArray);
        }
        updateManageFooter(payload.mode);
        sessionStorage.removeItem('pending_action_data');
        showToast('이전 입력 데이터가 복원되었습니다.', 'toast-info');
    }, 500);
}

// FAQ 번역 원본은 초기 HTML에 두고, 초기화 후에는 같은 12개 항목을 재사용한다.
let faqResources = null;

function initFaqResources() {
    if (faqResources) return faqResources;
    const section = document.getElementById('home-faq-section');
    if (!section) return null;
    const groups = Array.from(section.querySelectorAll('.home-resources__language'));
    const container = groups.find(group => group.dataset.lang === 'ko');
    if (!container) return null;
    const translations = new Map(groups.map(group => [group.dataset.lang, {
        lang: group.lang,
        panels: Array.from(group.querySelectorAll('[data-resource-panel]')).map(panel => ({
            name: panel.dataset.resourcePanel,
            items: Array.from(panel.querySelectorAll('details')).map(item => ({
                title: item.querySelector('summary > span').cloneNode(true),
                body: item.querySelector('.ui-disclosure__body').cloneNode(true),
            })),
        })),
    }]));
    const panels = Array.from(container.querySelectorAll('[data-resource-panel]'));
    const selected = document.getElementById('faq-radio-tips')?.checked ? 'tips' : 'faq';
    panels.forEach(panel => {
        panel.id = `home-resources-${panel.dataset.resourcePanel}`;
        const radio = document.getElementById(`faq-radio-${panel.dataset.resourcePanel}`);
        radio?.setAttribute('aria-controls', panel.id);
        panel.hidden = panel.dataset.resourcePanel !== selected;
    });
    // 번역을 보관한 뒤 중복 표시용 DOM만 제거한다. 실제 항목·summary·본문 노드는 유지한다.
    groups.forEach(group => { if (group !== container) group.remove(); });
    container.classList.add('home-resources__language--live');
    faqResources = { container, panels, translations, selected, language: 'ko', transition: null, disclosures: new Map() };
    panels.forEach(panel => panel.querySelectorAll('details').forEach(item => {
        item.querySelector('summary').addEventListener('click', event => {
            if (event.defaultPrevented || event.button > 0) return;
            event.preventDefault();
            toggleFaqDisclosure(faqResources, item);
        });
    }));
    // 화면 너비나 답변 높이가 전환 도중 변하면 고정 높이를 남기지 않고 현재 선택으로 정착한다.
    if (typeof ResizeObserver !== 'undefined') {
        const observer = new ResizeObserver(() => {
            const state = faqResources;
            state.disclosures.forEach((running, item) => {
                if (Math.abs(item.getBoundingClientRect().width - running.width) > 1) {
                    finishFaqDisclosure(state, item);
                }
            });
            const running = state.transition;
            if (!running) return;
            const active = state.panels.find(panel => panel.dataset.resourcePanel === state.selected);
            if (Math.abs(active.getBoundingClientRect().height - running.height) > 1
                || Math.abs(state.container.getBoundingClientRect().width - running.width) > 1) {
                finishFaqTransition(state);
            }
        });
        panels.forEach(panel => observer.observe(panel));
    }
    return faqResources;
}

function finishFaqTransition(state) {
    const running = state.transition;
    state.transition = null;
    running?.animations.forEach(animation => animation.cancel());
    state.container.classList.remove('home-resources__language--switching');
    state.panels.forEach(panel => {
        panel.classList.remove('home-resources__panel--leaving');
        panel.hidden = panel.dataset.resourcePanel !== state.selected;
        panel.inert = panel.hidden;
    });
}

function finishFaqDisclosure(state, item) {
    const running = state.disclosures.get(item);
    if (!running) return;
    state.disclosures.delete(item);
    item.open = running.open;
    running.animation.cancel();
    item.classList.remove('ui-disclosure--closing');
    item.querySelector('.ui-disclosure__body').inert = false;
}

function toggleFaqDisclosure(state, item) {
    finishFaqTransition(state);
    const running = state.disclosures.get(item);
    const open = !(running ? running.open : item.open);
    const fromHeight = item.getBoundingClientRect().height;
    finishFaqDisclosure(state, item);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !item.animate) {
        item.open = open;
        return;
    }
    // 닫힘 중에도 본문을 그리되 키보드 탐색에서는 제외한다.
    item.open = true;
    const height = open ? item.getBoundingClientRect().height : item.querySelector('summary').getBoundingClientRect().height;
    if (!open) item.classList.add('ui-disclosure--closing');
    item.querySelector('.ui-disclosure__body').inert = !open;
    const animation = item.animate([{ height: `${fromHeight}px` }, { height: `${height}px` }], {
        duration: 300, easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
    });
    const current = { animation, open, width: item.getBoundingClientRect().width };
    state.disclosures.set(item, current);
    animation.finished.then(() => {
        if (state.disclosures.get(item) === current) finishFaqDisclosure(state, item);
    }, () => {});
}

function updateFaqLanguage(region) {
    const state = initFaqResources();
    if (!state) return;
    const requested = region === 'ae' ? 'en' : region;
    const language = state.translations.has(requested) ? requested : 'ko';
    if (state.language === language) return;
    state.disclosures.forEach((_, item) => finishFaqDisclosure(state, item));
    finishFaqTransition(state);
    const translation = state.translations.get(language);
    translation.panels.forEach(source => {
        const panel = state.panels.find(item => item.dataset.resourcePanel === source.name);
        panel.querySelectorAll('details').forEach((item, index) => {
            const content = source.items[index];
            // open·초점 대상 summary·본문 컨테이너를 보존하고 번역된 인라인 내용만 교체한다.
            item.querySelector('summary > span').replaceChildren(...Array.from(content.title.childNodes, node => node.cloneNode(true)));
            item.querySelector('.ui-disclosure__body').replaceChildren(...Array.from(content.body.childNodes, node => node.cloneNode(true)));
        });
    });
    state.container.lang = translation.lang;
    state.container.dataset.lang = language;
    state.language = language;
}

window.switchFaqTab = function(tabName) {
    if (tabName !== 'faq' && tabName !== 'tips') return;
    const state = initFaqResources();
    if (!state) return;
    ['faq', 'tips'].forEach(name => {
        const radio = document.getElementById(`faq-radio-${name}`);
        if (radio) radio.checked = name === tabName;
    });
    if (state.selected === tabName) return;
    state.disclosures.forEach((_, item) => finishFaqDisclosure(state, item));
    const fromHeight = state.container.getBoundingClientRect().height;
    finishFaqTransition(state);
    const outgoing = state.panels.find(panel => panel.dataset.resourcePanel === state.selected);
    const incoming = state.panels.find(panel => panel.dataset.resourcePanel === tabName);
    if (outgoing.contains(document.activeElement)) {
        document.getElementById(`faq-radio-${tabName}`)?.focus({ preventScroll: true });
    }
    state.selected = tabName;
    incoming.hidden = false;
    incoming.inert = false;
    outgoing.inert = true;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reducedMotion || !state.container.animate || fromHeight === 0) {
        finishFaqTransition(state);
        return;
    }
    state.container.classList.add('home-resources__language--switching');
    outgoing.classList.add('home-resources__panel--leaving');
    const height = incoming.getBoundingClientRect().height;
    const width = state.container.getBoundingClientRect().width;
    const direction = tabName === 'tips' ? 1 : -1;
    const timing = { duration: 300, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' };
    const animations = [
        outgoing.animate([{ transform: 'translateX(0)' }, { transform: `translateX(calc(${-direction * 100}% - ${direction} * var(--resource-panel-gap)))` }], timing),
        incoming.animate([{ transform: `translateX(calc(${direction * 100}% + ${direction} * var(--resource-panel-gap)))` }, { transform: 'translateX(0)' }], timing),
        state.container.animate([{ height: `${fromHeight}px` }, { height: `${height}px` }], timing),
    ];
    const running = { animations, height, width };
    state.transition = running;
    Promise.allSettled(animations.map(animation => animation.finished)).then(() => {
        if (state.transition === running) finishFaqTransition(state);
    });
};

// 일반 화면·카드 캐시 준비와 독립적으로 인증/가입 조회를 시작한다.
if (typeof firebase !== 'undefined' && firebase.auth) initFirebaseAuth();
