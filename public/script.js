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
    "updateUserSettings",
    "updateNickname",
    "checkMembershipDiscord",
    "checkMembershipCsv",
    "uploadMembershipCsv",
    "searchDeck",
    "searchCard",
    "suggestCardNames",
    "getDeckCards",
    "migrateFromSheet",
    "migrateFromData",
    "clearUserData",
    "migrateCardNumbersField",
    "manageNotice",
    "manageAdminRole"
];
const FUNCTION_BASE_URL = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? 'http://127.0.0.1:5001/ygo-synapse/asia-northeast3'
    : 'https://asia-northeast3-ygo-synapse.cloudfunctions.net';
const FIREBASE_CONFIG = {
    ENDPOINTS: Object.fromEntries(HTTP_FUNCTION_NAMES.map(name => [name, `${FUNCTION_BASE_URL}/${name}`]))
};
// Safari 최적화: callApi에서 await 없이 토큰을 동기적으로 사용하기 위한 캐시
// AppCheck onTokenChanged가 즉시 호출될 수 있으므로 TDZ 방지를 위해 선언을 본 블록 앞에 위치
let _cachedAuthToken = null;
let _cachedAppCheckToken = null;

// Firebase App Check 즉시 초기화
if (typeof firebase !== 'undefined' && firebase.appCheck &&
    location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    const appCheck = firebase.appCheck();
    const provider = new firebase.appCheck.ReCaptchaEnterpriseProvider('6Le3FaksAAAAAFE9lMsuyGfgTkvNaVzrThMUthe3');
    appCheck.activate(provider, true);
    // Safari 최적화: AppCheck 토큰이 갱신될 때마다 캐시 변수에 저장
    appCheck.onTokenChanged((tokenResult) => {
        _cachedAppCheckToken = tokenResult.token;
    });
}

const CLIENT_VERSION = "ver. 0.31.2";

const STORAGE_KEY = 'yugioh_spreadsheet_id';
const RECENT_KEY = 'recent_card_searches';
const THEME_KEY = 'yugioh_theme_mode';
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
    isUserDataSyncDone: false
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
    crawledPacksCache: {},
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
    const TIMEOUT_MS = 30 * 60 * 1000; // 30분 미활동 시 자동 로그아웃
    let timer = null;
    let isTracking = false;

    function resetTimer() {
        if (timer) clearTimeout(timer);
        if (!UserStore.user) return;

        timer = setTimeout(() => {
            if (UserStore.user) {
                console.warn("[AutoLogout] 30분간 활동이 없어 자동 로그아웃되었습니다.");
                showToast('일정 시간 동안 활동이 없어 자동 로그아웃되었습니다.', 'toast-warn');
                if (typeof signOutCurrentUser === 'function') {
                    signOutCurrentUser();
                }
            }
        }, TIMEOUT_MS);
    }

    function handleUserActivity() {
        if (UserStore.user && isTracking) {
            resetTimer();
        }
    }

    return {
        start: function () {
            if (isTracking) return;
            isTracking = true;
            const events = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'];
            events.forEach(evt => window.addEventListener(evt, handleUserActivity, { passive: true }));
            resetTimer();
        },
        stop: function () {
            isTracking = false;
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            const events = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'];
            events.forEach(evt => window.removeEventListener(evt, handleUserActivity));
        },
        reset: resetTimer
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

// 유튜브 채널 ID 조회 API 공통화
async function fetchYoutubeChannelId(accessToken) {
    const response = await fetch('https://www.googleapis.com/youtube/v3/channels?part=id&mine=true', {
        headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    if (data.items && data.items.length > 0) {
        return data.items[0].id;
    }
    return null;
}

// 프리-정규화된 카드 이름 동기화 함수
function updateNormalizedNames() {
    CardDataStore.allCardNamesNormalized = CardDataStore.allCardNames.map(name => {
        const normalized = name.replace(/\s+/g, '').toLowerCase();
        return {
            original: name,
            normalized: normalized,
            chosung: getChosung(normalized)
        };
    });
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

/**
 * 팩 및 덱 검색/크롤링/수록카드 생성 전역 스토어
 */
const PackDeckStore = {
    isSearching: false,
    isPackTableGenerated: false,
    isDeckTableGenerated: false,
    currentPackInfo: null,
    currentDeckDetailUrl: '',
    currentDeckName: '',
    packCardResults: [],
    isPackCrawlDone: false
};
let migrationValidationTimeout = null; // 마이그레이션 링크 검증용 타임아웃

// Master JSON 원형 저장 및 관리를 위한 IndexedDB 유틸리티
const MasterDB = {
    DB_NAME: 'YgoSynapseDB',
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
                const keys = ['cardNames', 'cardNumbers', 'cidIndex', 'packData', 'rarity'];
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
        } catch (e) { }
    }
};

/**
 * 통합 캐시 클래스 - Phase 1 (Master JSON 연동)
 */
class ClientCache {
    constructor() {
        this._inventory = [];
        this._allKnownNames = new Set();
        this._indexes = {
            names: new Set(),
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
    static _nameToCid = {};
    static _rawCidIndex = null; // 원본 CID 인덱스 매핑 객체
    static _cidToNames = {}; // { cid: Set(names) }
    static _nameToNos = {};  // { name: Set(nos) }
    static _noToName = {};   // { cardNo: name }
    static _noToPack = {};   // { cardNo: packName }
    static _packToNos = {};  // { packName: Set(nos) }
    static _noToRarities = {}; // { cardNo: Set(rarities) }
    static _nameToAnother = {}; // { name: illustrationCount }

    /**
     * CID 인덱스 JSON 수신 및 역방향 매핑 구축
     */
    static loadCidIndex(cidData) {
        if (!cidData) return;
        this._rawCidIndex = cidData;
        const nameMap = {};

        for (const cid in cidData) {
            const item = cidData[cid];
            if (!item) continue;

            const names = (item && Array.isArray(item.names))
                ? item.names
                : (Array.isArray(item) ? item : []);

            names.forEach(n => {
                if (n && typeof n === 'string') {
                    nameMap[n] = cid;
                    const norm = normalizeStr(n);
                    if (norm) nameMap[norm] = cid;
                }
            });
        }

        this._nameToCid = Object.assign(this._nameToCid || {}, nameMap);
    }



    /**
     * 런타임 신규 CID 발견 시 실시간 증분 업데이트 (Incremental Update)
     */
    static registerCid(cid, names = []) {
        if (!cid || cid === "null" || cid === "undefined") return;
        cid = String(cid);

        if (!this._nameToCid) this._nameToCid = {};
        if (!this._rawCidIndex) this._rawCidIndex = {};

        // idx_cid.json 표준 객체 구조 ({ names: [...] }) 보장
        if (!this._rawCidIndex[cid]) {
            this._rawCidIndex[cid] = { names: [] };
        } else if (Array.isArray(this._rawCidIndex[cid])) {
            this._rawCidIndex[cid] = { names: [...this._rawCidIndex[cid]] };
        } else if (!this._rawCidIndex[cid].names || !Array.isArray(this._rawCidIndex[cid].names)) {
            this._rawCidIndex[cid].names = [];
        }

        const nameArr = Array.isArray(names) ? names : (names ? [names] : []);
        let updated = false;

        nameArr.forEach(n => {
            if (n && typeof n === 'string') {
                this._nameToCid[n] = cid;
                const norm = normalizeStr(n);
                if (norm) this._nameToCid[norm] = cid;

                if (!this._rawCidIndex[cid].names.includes(n)) {
                    this._rawCidIndex[cid].names.push(n);
                    updated = true;
                }
            }
        });

        if (updated) {
            MasterDB.set('cidIndex', this._rawCidIndex).catch(e => console.warn('[CidIndex] Save error:', e));
        }
    }

    /**
     * CID로 대표 카드명 반환
     */
    static getCardNameByCid(cid, region = 'ko') {
        if (!cid || !this._rawCidIndex || !this._rawCidIndex[cid]) return null;
        const item = this._rawCidIndex[cid];
        const names = (item && Array.isArray(item.names)) ? item.names : (Array.isArray(item) ? item : []);
        return names.length > 0 ? names[0] : null;
    }

    /**
     * 앱 시작 시 IndexedDB에서 마스터 캐시 로드
     */
    /**
     * 앱 시작 시 IndexedDB에서 마스터 캐시 1회 일괄 로드 (Single Batch Read)
     */
    static async init() {
        const data = await MasterDB.loadAllMasterData();

        if (data.cardNames) {
            CardDataStore.allCardNames = data.cardNames;
            updateNormalizedNames();
        }

        if (data.cardNumbers) {
            CardDataStore.allCardNumbers = data.cardNumbers;
        }

        if (data.cidIndex) {
            this.loadCidIndex(data.cidIndex);
        }

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
        if (!this._nameToCid) this._nameToCid = {};
        this._cidToNames = {};
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

        const cid = this._nameToCid[name];
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
    setInventory(data) {
        this._inventory = data || [];
        this.refreshIndexes();
    }

    /**
     * [Phase 2] 전체 알려진 카드 이름 저장 및 동기화
     */
    setAllKnownNames(names) {
        if (!names || !Array.isArray(names)) return;
        this._allKnownNames.clear(); // [중요] 기존 데이터를 비우고 서버의 최신 데이터로 교체
        names.forEach(n => this._allKnownNames.add(n));
        this.refreshIndexes();
    }


    /**
     * [Phase 2] 인벤토리 부분 업데이트
     */
    updateInventory(updates) {
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
                } else {
                    this._inventory.push([item.name, item.cardNo, item.rarity, item.qty, item.loc, item.illustration]);
                }
            }
        });
        this.refreshIndexes();
    }

    /**
     * [Phase 2] 인덱스 및 전역 룩업 변수 자동 동기화
     */
    refreshIndexes() {
        const names = new Set(this._allKnownNames); // 전체 이름에서 시작
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

        this._indexes.names = names;
        this._indexes.ownedNumbers = nos;
        this._indexes.locations = locations;

        this._indexes.nameToNos = {};
        for (let key in nameToNos) {
            this._indexes.nameToNos[key] = Array.from(nameToNos[key]).sort();
        }

        // [Phase 3] 정렬된 배열 미리 계산 및 캐싱 (성능 최적화)
        this._sortedNames = Array.from(names).sort();
        this._sortedLocations = Array.from(locations).sort();
        this._sortedOwnedNumbers = Array.from(nos).sort();

        // 보유 카드 이름 정규화 캐시 배열 생성
        this._sortedNamesNormalized = this._sortedNames.map(name => {
            const normalized = name.replace(/\s+/g, '').toLowerCase();
            return {
                original: name,
                normalized: normalized,
                chosung: getChosung(normalized)
            };
        });

        // 로컬 인벤토리 데이터를 바탕으로 대시보드 요약 통계 강제 동기화
        this.rebuildSummaryFromInventory();
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
        if (!this._cachedOwnedNamesSet) {
            this.rebuildOwnedSets();
        }
        return this._cachedOwnedNamesSet;
    }

    getOwnedNumbersSet() {
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

    getInventory() { return this._inventory; }
    getAllNames() { return this._sortedNames; }
    getAllNamesNormalized() { return this._sortedNamesNormalized; }
    getOwnedNumbers() { return this._sortedOwnedNumbers; }
    getAllLocations() { return this._sortedLocations; }

    /**
     * 서버 요약 통계 설정
     */
    setSummary(amount, locations, rarities) {
        this._summary.amount = amount || 0;
        this._summary.locations = locations || {};
        this._summary.rarities = rarities || {};

        // 위치 목록 업데이트 (매핑의 키값들)
        const locSet = new Set(Object.keys(this._summary.locations));
        this._indexes.locations = locSet;
        this._sortedLocations = Array.from(locSet).sort();

        if (typeof refreshLocalLookups === 'function') refreshLocalLookups();
    }

    getAmount() { return this._summary.amount; }
    getLocationsMap() { return this._summary.locations; }
    getRaritiesMap() { return this._summary.rarities; }

    getNosByName(name) { return this._indexes.nameToNos[name] || []; }

    /**
     * 모든 데이터 초기화 (데이터 삭제 시 사용)
     */
    clearAll() {
        this._inventory = [];
        this._indexes.ownedNumbers = new Set();
        this._indexes.locations = new Set();
        this._indexes.names = new Set();
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
    chipState: { add: 'general', move: 'card', discard: 'card' },
    pendingBlurFn: null,
    dropdownFocus: -1,
    activeDropdownInput: null,
    lastHashBeforeModal: "",
    currentRegion: 'ko',
    isMobileSearchInProgress: false,
    activeLocaleTooltip: null
};

/**
 * [유틸리티] 유희왕 공식 DB 카드 상세 페이지 URL 조합
 */
function getCardDetailUrl(cid, locale) {
    if (!cid) return "";
    // 입력값이 URL이든 숫자든 상관없이 숫자 ID(CID)만 추출하여 조합
    const cidOnly = String(cid).match(/cid=(\d+)/) ? String(cid).match(/cid=(\d+)/)[1] : String(cid).replace(/[^0-9]/g, '');
    const loc = locale || UIStore.currentRegion || 'ko';
    return "https://www.db.yugioh-card.com/yugiohdb/card_search.action?ope=2&cid=" + cidOnly + "&request_locale=" + loc;
}

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

/**
 * 카드 로케일 선택 툴팁 표시
 */
function showCardLocaleTooltip(target, locales, cid) {
    if (UIStore.activeLocaleTooltip) {
        UIStore.activeLocaleTooltip.remove();
        UIStore.activeLocaleTooltip = null;
    }

    const tooltip = document.createElement('div');
    tooltip.className = 'card-locale-tooltip';

    // 로케일 코드 -> 한글 명칭 매핑
    const localeMap = {
        'ko': '한국', 'ja': '일본', 'ae': '아시아', 'cn': '중국',
        'en': '영미', 'de': '독일', 'fr': '프랑스', 'it': '이탈리아',
        'es': '스페인', 'pt': '포르투갈'
    };

    locales.forEach(loc => {
        const btn = document.createElement('button');
        btn.className = 'locale-capsule';
        btn.textContent = localeMap[loc] || loc.toUpperCase();
        btn.onclick = (e) => {
            e.stopPropagation();
            window.open(getCardDetailUrl(cid, loc), '_blank');
            tooltip.classList.remove('active');
            setTimeout(() => tooltip.remove(), 300);
            UIStore.activeLocaleTooltip = null;
        };
        tooltip.appendChild(btn);
    });

    document.body.appendChild(tooltip);
    UIStore.activeLocaleTooltip = tooltip;

    // 위치 계산 (대상 엘리먼트 하단 중앙)
    const rect = target.getBoundingClientRect();
    const tooltipWidth = tooltip.offsetWidth || (locales.length * 60); // 근사치 계산

    tooltip.style.left = (rect.left + rect.width / 2 - tooltipWidth / 2) + 'px';
    tooltip.style.top = (rect.bottom + 10) + 'px';

    // 화면 밖으로 나가는지 체크
    requestAnimationFrame(() => {
        const finalRect = tooltip.getBoundingClientRect();
        if (finalRect.left < 10) tooltip.style.left = '10px';
        if (finalRect.right > window.innerWidth - 10) tooltip.style.left = (window.innerWidth - finalRect.width - 10) + 'px';
        tooltip.classList.add('active');
    });

    // 외부 클릭 시 닫기
    const closeHandler = (e) => {
        if (!tooltip.contains(e.target) && e.target !== target) {
            tooltip.classList.remove('active');
            setTimeout(() => tooltip.remove(), 300);
            document.removeEventListener('click', closeHandler);
            if (UIStore.activeLocaleTooltip === tooltip) UIStore.activeLocaleTooltip = null;
        }
    };
    setTimeout(() => document.addEventListener('click', closeHandler), 10);
}


let currentSheetLastUpdated = 0;
let currentCacheSeq = 0; // JSON 캐시 동기화용 시퀀스 번호

/**
 * 인벤토리 변경 API 호출 시 필요한 공통 동기화 페이로드 생성
 */
function buildAuthPayload() {
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
    }

    if (metaData) {
        if (metaData.name && typeof metaData.name === 'string') {
            existing.name = metaData.name;
        }
        if (Array.isArray(metaData.numbers) && metaData.numbers.length > 0) existing.numbers = metaData.numbers;
        if (metaData.raritiesByNo && Object.keys(metaData.raritiesByNo).length > 0) existing.raritiesByNo = metaData.raritiesByNo;

        // 백엔드의 단일 통합 맵 규격(info)을 단 1줄로 깔끔하고 안전하게 누적 병합
        if (metaData.info && typeof metaData.info === 'object') {
            Object.assign(existing.info, metaData.info);
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

    cidMetaMemoryCache.set(cidStr, existing);
    return existing;
}

/**
 * 카드 메타데이터에서 카드 종류 (몬스터 0, 마법 1, 함정 2) 판별
 */
function parseMetaKind(cardMeta) {
    if (!cardMeta || !cardMeta.info) return { kind: 0, kindStr: "몬스터" };
    const info = cardMeta.info;
    const k = info[10] !== undefined ? info[10] : (info["10"] !== undefined ? info["10"] : 0);
    const etcList = Array.isArray(info[11] || info["11"]) ? (info[11] || info["11"]) : [];

    if (k === 1 || etcList.some(e => e >= 15 && e <= 20)) return { kind: 1, kindStr: "마법" };
    if (k === 2 || etcList.some(e => e >= 21 && e <= 23)) return { kind: 2, kindStr: "함정" };
    return { kind: 0, kindStr: "몬스터" };
}

/**
 * 단일 카드 상세 메타 캐시 조회 (isFull 미달 시 langOnly 증분 요청 연동)
 */
async function fetchCardMetaWithCache(cid, cardName = '', cardNo = '') {
    const cidStr = cid ? String(cid) : '';

    if (cidStr && cidMetaMemoryCache.has(cidStr)) {
        const cached = cidMetaMemoryCache.get(cidStr);
        if (cached && cached.isFull) {
            return cached;
        }
        
        // 메모리에 스탯(rawSlot 10번 이상) 데이터가 이미 존재하는 경우에만 langOnly=true (일부 조회)
        const hasStatsInCache = cached && cached.info && (cached.info[10] !== undefined || cached.info["10"] !== undefined);
        if (hasStatsInCache) {
            const langRes = await callApi('getCardMetadata', { cid: cidStr, name: cardName || '', cardNo: cardNo || '', langOnly: true });
            if (langRes && !langRes.isError && langRes.cid) {
                return mergeCardMetaToCache(langRes.cid, langRes, true);
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
async function fetchCardsMetaBatch(cids = []) {
    if (!Array.isArray(cids) || cids.length === 0) return {};

    const cidStrs = [...new Set(cids.map(c => String(c)).filter(Boolean))];
    const needed = cidStrs.filter(cid => {
        if (!cidMetaMemoryCache.has(cid)) return true;
        const cached = cidMetaMemoryCache.get(cid);
        const raw = cached ? (cached.rawSlot || cached.info) : null;
        return !raw || (Array.isArray(raw) ? raw.length <= 10 : Object.keys(raw).length === 0);
    });

    if (needed.length > 0) {
        try {
            const res = await callApi('getCardsMetaBatch', { cids: needed });
            if (res && res.success && res.results) {
                Object.keys(res.results).forEach(cid => {
                    mergeCardMetaToCache(cid, { rawSlot: res.results[cid] }, false);
                });
            }
        } catch (e) {
            console.warn("fetchCardsMetaBatch error:", e);
        }
    }

    const resultMap = {};
    cidStrs.forEach(cid => {
        if (cidMetaMemoryCache.has(cid)) {
            resultMap[cid] = cidMetaMemoryCache.get(cid);
        }
    });
    return resultMap;
}

/**
 * 입력폼 수량/행 카운트 전역 스토어
 */
const FormRowStore = {
    addCounts: { general: 1, pack: 1, deck: 1 },
    moveCount: 1,
    discardCount: 1
};

let currentToastInstance = null;
let currentToastMessage = null;

let syncCounter = 0;


let deckCardsPromise = null;     // 덱 카드 상세 검색 promise 저장 (미리 로딩)

// 카드이름 기반 팩 등록 메커니즘 상태 변수
let _packCrawlNewRunning = false; // 신규 배경 크롤링 실행 플래그 (기존과 분리)
let _currentDisplayCrawlCount = 0; // 화면에 표시 중인 현재 크롤링 수량 (애니메이션용)
let _crawlIntervalId = null;       // 애니메이션 인터벌 ID



/* --- AD Units Refresh Logic --- */

let adLastRefreshTime = {}; // { slotId: timestamp }
const AD_REFRESH_INTERVAL = 45000; // 정책 준수를 위해 안전하게 45초 간격 유지

/**
 * 특정 광고 슬롯을 갱신합니다. (디자인 보호를 위해 페이드 전환 적용)
 * @param {string} slotId 광고 컨테이너 ID
 */
function refreshAdUnit(slotId) {
    const container = document.getElementById(slotId);
    if (!container || !container.offsetParent) return; // 미노출 상태면 무시

    const now = Date.now();
    if (adLastRefreshTime[slotId] && (now - adLastRefreshTime[slotId] < AD_REFRESH_INTERVAL)) {
        return;
    }

    container.style.transition = 'opacity 0.4s ease';
    container.style.opacity = '0.2';

    setTimeout(() => {
        // [주의] 실제 광고 코드가 삽입되는 지점입니다. 
        // 광고주와의 계약 및 정책에 따라 수동 갱신 방식을 결정해야 합니다.
        // container.innerHTML = '<ins class="adsbygoogle" ...></ins>';

        try {
            if (window.adsbygoogle) {
                (adsbygoogle = window.adsbygoogle || []).push({});
            }
        } catch (e) { }

        container.style.opacity = '1';
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

function showToast(html, classes) {

    if (currentToastMessage === html) return;

    if (currentToastInstance) {
        currentToastInstance.dismiss();
    }

    const instance = M.toast({
        html: html,
        classes: classes,
        completeCallback: () => {
            if (currentToastMessage === html) {
                currentToastMessage = null;
                currentToastInstance = null;
            }
        }
    });

    currentToastInstance = instance;
    currentToastMessage = html;

    const toastContainer = document.getElementById('toast-container');
    const mainContainer = document.querySelector('.container');
    if (toastContainer && mainContainer && toastContainer.parentNode !== mainContainer) {
        mainContainer.appendChild(toastContainer);
    }
}

function updateLocalInventory(updates) {
    if (!updates || !Array.isArray(updates)) return;
    cardCacheInstance.updateInventory(updates);
    refreshLocalLookups();
}

function refreshLocalLookups() {
    // [Phase 2] 데이터 계산은 이제 cardCacheInstance.refreshIndexes()에서 자동 수행됨
    // 여기서는 UI 갱신 로직만 담당합니다.

    const datalist = document.getElementById('loc-datalist');
    if (datalist) datalist.innerHTML = cardCacheInstance.getAllLocations().map(l => `<option value="${l}">`).join('');

    const autoLocWrap = document.getElementById('wrap-auto-loc');
    const autoLocInput = document.getElementById('auto-location-input');
    if (autoLocWrap && autoLocInput) {
        autoLocWrap.dataset.options = JSON.stringify(cardCacheInstance.getAllLocations().map(l => ({ val: l, text: l })));
        setupDropdownForField(autoLocInput, autoLocWrap);
    }

    // [데스크톱 카드 뷰 대응] 모든 데스크톱 카드를 돌며 보관 위치(loc) 및 이동 위치(to) 드롭다운 갱신
    const allDesktopCards = document.querySelectorAll('.desktop-info-card');
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
    if (isInternalHashChange) return;
    const hash = window.location.hash.substring(1);

    // 해시 변경에 의한 즉시 전환 시 애니메이션 차단
    document.body.classList.add('no-transition');

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

            if (cid) {
                renderTargetByCid(cid, code, true);
            } else if (key !== null || q !== null) {
                const searchKey = key !== null ? decodeURIComponent(key) : decodeURIComponent(q);
                let searchType = 'auto';
                if (m === '1') searchType = 'name';
                else if (m === '2') searchType = 'number';

                const inputEl = document.getElementById('card-search');
                if (inputEl) inputEl.value = searchKey;
                checkClearBtn();
                switchToMode('search', true, null, null, skipAutomation);
                if (!skipAutomation) {
                    startSearch(true, searchType, null, searchKey);
                }
            } else {
                switchToMode('search', true, null, null, skipAutomation);
            }
        } else {
            switchToMode('search', true, null, null, skipAutomation);
        }
    } else {
        // 해시를 슬래시(/) 기준으로 분리하고 쿼리 파라미터 파싱
        const mainParts = hash.split('?');
        const pathParts = mainParts[0].split('/');
        const mainMode = pathParts[0];
        const subMode = pathParts[1] || null;

        // 쿼리 파라미터 추출 (name, loc, code 등)
        const params = new URLSearchParams(mainParts[1] || "");
        const targetName = params.get('name');
        const targetLoc = params.get('loc');
        const targetCode = params.get('code');

        const validModes = ['home', 'inventory', 'add', 'move', 'discard', 'settings', 'manage'];
        if (validModes.includes(mainMode)) {
            const targetParams = (targetName || targetLoc || targetCode) ? { name: targetName, loc: targetLoc, code: targetCode } : null;
            if (mainMode === 'manage') {
                // #manage/탭모드/칩모드
                const targetTab = pathParts[1] || 'add';
                const targetChip = pathParts[2] || null;
                // 기존 add/move/discard 로직 수행
                switchToMode(targetTab, true, targetChip, targetParams, skipAutomation);
            } else {
                switchToMode(mainMode, true, subMode, targetParams, skipAutomation);
            }
        } else {
            switchToMode('home', true, null, null, skipAutomation);
        }
    }

    // 애니메이션 차단 해제 (레이아웃 반영 후)
    requestAnimationFrame(() => {
        document.body.classList.remove('no-transition');
    });
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
            const inst = M.Modal.init(modal, {
                opacity: 0.4,
                startingTop: '10%',
                endingTop: '10%',
                onCloseEnd: function () {
                    // 세션 스토리지 상태 제거
                    sessionStorage.removeItem('ygo_redirect_legacy');
                    // 모달이 완전히 화면에서 사라진 후 안전하게 파라미터 소거
                    const cleanUrl = window.location.protocol + "//" + window.location.host + window.location.pathname;
                    window.history.replaceState({ path: cleanUrl }, '', cleanUrl);
                }
            });
            
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
    const footerVer = document.getElementById('footer-version');
    if (footerVer) footerVer.textContent = CLIENT_VERSION;

    // 로컬 DB 초기화
    await ClientCache.init();

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
    initFirebaseAuth();
    if (typeof handleDiscordOAuthCallback === 'function') handleDiscordOAuthCallback();
    if (typeof initSearchButtonBlurListeners === 'function') initSearchButtonBlurListeners();
    if (typeof initMobileSearchListeners === 'function') initMobileSearchListeners();
    if (typeof initOverlaySearchListeners === 'function') initOverlaySearchListeners();
    if (document.documentElement.classList.contains('is-mobile-device')) {
        renderMobileCards();
    } else {
        renderDesktopCards();
    }
    initPackSearch(); // [이동] 초기화 시점에 함께 실행

    // 구 버전에서 유입된 사용자 온보딩 처리
    startOnboarding();

    // [중요] 동기화 시작 전에 URL 해시를 먼저 분석하여 UI를 즉시 설정하되, 자동 검색은 로컬 캐시 로드 후로 미룸 (skipAutomation=true)
    handleHashChange(true);

    const modals = document.querySelectorAll('.modal');
    const isMobile = document.documentElement.classList.contains('is-mobile-device');
    modals.forEach(modal => {
        let options = {
            opacity: 0.4,           // 배경 오버레이를 더 투명하고 고급스럽게 조정
            startingTop: '10%',     // 시작 위치와 종료 위치를 동일하게 설정하여 이중 이동 방지
            endingTop: '10%',
            inDuration: isMobile ? 350 : 300,   // CSS 애니메이션 시간과 동기화
            outDuration: isMobile ? 250 : 200,
            onOpenStart: function (el) {
                // 모달 오픈 시 하단 요소 숨김을 위해 클래스 추가
                if (isMobile) document.documentElement.classList.add('modal-open');
            },
            onOpenEnd: function (el) {
                // [모바일] Materialize가 강제 지정하는 style.top을 초기화하여 bottom: 0 배치 유지
                if (isMobile) el.style.top = '';
            },
            onCloseStart: function (el) {
                // 모달이 닫히기 시작할 때 클래스 제거
                if (isMobile) document.documentElement.classList.remove('modal-open');
                // 헤더 직접 열기 모달 닫힐 때 inert 해제
                if (el.id === 'auth-modal' || el.id === 'mobile-auth-modal' || el.id === 'membership-auth-modal' || el.id === 'notice-modal' || el.id === 'notice-list-modal' || el.id === 'notice-detail-modal') {
                    toggleBackgroundInert(false);
                }
            },
            onCloseEnd: function (el) {

                // 약관/개인정보 모달을 닫을 때 이전의 URL 해시(예: #add)로 복구
                if (el.id === 'terms-modal' || el.id === 'privacy-modal') {
                    const currentHash = window.location.hash;
                    if (currentHash === '#terms' || currentHash === '#privacy') {
                        // 저장해둔 이전 해시가 있다면 그것으로, 없으면 빈 값으로 복구
                        const targetHash = UIStore.lastHashBeforeModal || "";
                        window.history.pushState(null, null, window.location.pathname + window.location.search + targetHash);
                        // 복구 후 변수 초기화
                        UIStore.lastHashBeforeModal = "";
                    }
                }


                if (el.id === 'add-result-modal') {
                    handleContinueRegistration();
                }
                if (el.id === 'discard-result-modal') {
                    handleContinueDiscard();
                }
            }
        };
        if (modal.id === 'add-result-modal' || modal.id === 'move-result-modal' || modal.id === 'discard-result-modal') {
            options.dismissible = false;
        }
        M.Modal.init(modal, options);
    });

    checkLegacyMigrationQuery();

    M.Tooltip.init(document.querySelectorAll('.tooltipped'));

    const searchInput = document.getElementById('card-search');
    if (searchInput && !searchInput._isInputBound) {
        searchInput._isInputBound = true;
        const handleFocusOrClick = () => {
            const val = searchInput.value.trim();
            if (!val) { showRecentInDropdown(); } else { filterAndShowDropdown(searchInput.value); }
        };
        searchInput.addEventListener('click', handleFocusOrClick);
        searchInput.addEventListener('focus', handleFocusOrClick);
        const debouncedFilter = debounce((val) => {
            filterAndShowDropdown(val);
        }, 50);

        searchInput.addEventListener('input', (e) => {
            const val = e.target.value;
            if (!val) {
                debouncedFilter.cancel && debouncedFilter.cancel();
                showRecentInDropdown();
            }
            else debouncedFilter(val);
            checkClearBtn();
        });

        const dropdown = document.getElementById('custom-dropdown');
        if (dropdown) {
            dropdown.addEventListener('mousedown', function (e) {
                e.preventDefault();
                const searchBtn = e.target.closest('.dropdown-search-btn');
                if (searchBtn) {
                    const searchType = searchBtn.textContent.includes('이름으로') ? 'name' : 'number';
                    startSearchWithOption(e, searchType);
                    return;
                }
                const target = e.target;
                if (target.classList.contains('clear-all-btn')) {
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
                if (li && !li.classList.contains('recent-header-item') && !li.classList.contains('no-result-item') && !li.classList.contains('dropdown-search-btn-row')) {
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
            let list = document.getElementById('custom-dropdown');
            if (list.style.display === 'none') return;
            let items = list.querySelectorAll('li:not(.recent-header-item):not(.no-result-item):not(.dropdown-search-btn-row)');
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
                let targetVal = this.value.trim();
                let searchType = 'auto';
                let isTarget = null;
                if (list.style.display !== 'none' && items.length > 0) {
                    if (UIStore.dropdownFocus > -1) {
                        if (items[UIStore.dropdownFocus]) {
                            targetVal = items[UIStore.dropdownFocus].dataset.val;
                            searchType = items[UIStore.dropdownFocus].dataset.type || 'auto';
                            isTarget = items[UIStore.dropdownFocus].dataset.isTarget === 'true';
                        }
                    }
                }
                if (targetVal) this.value = targetVal;
                this.blur();
                startSearch(false, searchType, isTarget);
            }
        });

        searchInput.addEventListener('blur', () => {
            if (debouncedFilter.cancel) debouncedFilter.cancel();
            setTimeout(() => {
                const list = document.getElementById('custom-dropdown');
                list.classList.remove('active');
                toggleSearchWrapper(false);
            }, 75);
        });
    }

    document.getElementById('clear-btn').addEventListener('click', function () {
        searchInput.value = '';
        this.style.display = 'none';
        searchInput.focus();
        showRecentInDropdown();
    });

    document.addEventListener('click', function (e) {
        // 지역 설정 드롭다운 외부 클릭 감지 (새로운 구조 대응)
        const regionWrapper = document.getElementById('region-wrapper');
        if (regionWrapper && !regionWrapper.contains(e.target)) {
            // 이미 닫혀있다면 closeDropdowns() 호출 불필요 (성능 최적화)
            if (regionWrapper.classList.contains('active')) {
                closeDropdowns();
            }
        }

        // 팩 추가 팝업 외부 클릭 감지
        const packAddContainer = document.getElementById('pack-add-container');
        if (packAddContainer && !packAddContainer.contains(e.target)) {
            togglePackAddPopup(e, false);
        }
    });

    document.addEventListener('scroll', function (e) {
        if (e.target.classList && e.target.classList.contains('custom-options')) return;
        if (UIStore.activeDropdownInput) {
            // [근본 해결] 검색바 드롭다운은 CSS 중첩 구조이므로 JS 포지셔닝이 개입하면 클리핑이 깨짐
            if (UIStore.activeDropdownInput.id === 'card-search') return;

            const wrapper = UIStore.activeDropdownInput.closest('.custom-select-wrapper') || UIStore.activeDropdownInput.closest('.search-input-wrapper');
            if (wrapper) {
                const globalDropdown = wrapper._dropdown || document.getElementById('custom-dropdown');
                if (globalDropdown && globalDropdown.classList.contains('active')) {
                    const rect = wrapper.getBoundingClientRect();
                    const isAutoLoc = (wrapper.id === 'wrap-auto-loc');
                    const offset = isAutoLoc ? -1 : 0;

                    const scrollTop = window.pageYOffset || document.documentElement.scrollTop || document.body.scrollTop || 0;
                    const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft || document.body.scrollLeft || 0;

                    globalDropdown.style.top = (rect.bottom + scrollTop + offset) + 'px';
                    globalDropdown.style.left = (rect.left + scrollLeft) + 'px';
                    globalDropdown.style.width = rect.width + 'px';
                }
            }
        }
    }, true);

    updateDisconnectBtn();

    // 초기 로드 시 트랜지션 차단 (이미 index.html에서 추가되었을 수 있음)
    document.body.classList.remove('no-transition');
    document.body.classList.add('no-transition');

    // 위에서 UI는 먼저 잡았으므로, 동기화 후 로컬 캐시가 준비된 시점에 자동 검색(automation)을 실행함
    await refreshInitialData();

    // 동기화 완료 후 자동화 로직만 별도로 추출하여 트리거 (캐시된 데이터 활용 보장)
    const currentHash = window.location.hash.substring(1);
    if (currentHash) {
        const hParts = currentHash.split('?');
        // URL path에서 서브모드를 직접 추출하여 강제 동기화
        const pathParts = hParts[0].split('/');
        if (pathParts[0] === 'add' && pathParts[1]) {
            UIStore.chipState.add = pathParts[1];
        }
        if (hParts[1]) {
            const hParams = new URLSearchParams(hParts[1]);
            const pObj = {
                name: hParams.get('name'),
                loc: hParams.get('loc'),
                code: hParams.get('code')
            };
            handleAutomationParams(pObj);
        }
    }

    const autoLocWrap = document.getElementById('wrap-auto-loc');
    if (autoLocWrap) {
        setupCustomDropdown(autoLocWrap, null);
    }

    window.addEventListener('hashchange', handleHashChange);

    // 모든 초기화 완료 후 트랜지션 차단 해제 및 FODC 방지 클래스 제거
    requestAnimationFrame(() => {
        document.body.classList.remove('no-transition');
        document.documentElement.classList.remove('route-add-pack', 'route-add-deck');
    });

    // 단축키(Ctrl+Enter / Cmd+Enter)를 통한 작업 실행 기능 추가
    document.addEventListener('keydown', function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
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
}

// 애플리케이션 단일 초기화 이벤트 바인딩
document.addEventListener('DOMContentLoaded', initApp);



function updateActiveNav(mode) {
    document.querySelectorAll('.nav-item, .mobile-nav-item').forEach(el => el.classList.remove('active'));
    let searchMode = mode;
    if (['add', 'move', 'discard'].includes(mode)) searchMode = 'manage';
    const targets = document.querySelectorAll(`[data-mode="${searchMode}"]`);
    targets.forEach(el => el.classList.add('active'));
}

function updateMetaThemeColor(mode) {
    const meta = document.getElementById('meta-theme-color');
    if (meta) {
        if (mode === 'light') { meta.setAttribute('content', '#F0F0F0'); } else { meta.setAttribute('content', '#000000'); }
    }
}

function toggleBackgroundInert(isActive) {
    const targets = [document.getElementById('dynamic-header-wrapper'), document.querySelector('.global-top-nav'), document.querySelector('.app-sidebar'), document.querySelector('.mobile-nav-container'), document.querySelector('.container')];
    targets.forEach(el => { if (el) { if (isActive) el.setAttribute('inert', ''); else el.removeAttribute('inert'); } });
}

let transitionTimer = null;
let isInternalHashChange = false;

/**
 * URL 해시 및 쿼리 파라미터 업데이트 공통 유틸리티
 */
function setHashQuery(subPath, urlParams) {
    const qs = urlParams ? urlParams.toString() : '';
    const finalHash = subPath + (qs ? '?' + qs : '');
    if (window.location.hash !== '#' + finalHash) {
        isInternalHashChange = true;
        window.history.replaceState(null, '', window.location.pathname + window.location.search + '#' + finalHash);
        setTimeout(() => { isInternalHashChange = false; }, 100);
    }
}

/**
 * 팩 모드에서 상태 변경 시 현재 상태에 맞는 URL 해시를 동기화합니다.
 */
function updatePackUrl() {
    if (UIStore.mode !== 'add' || UIStore.chipState.add !== 'pack') return;

    const urlParams = new URLSearchParams();
    if (typeof PackDeckStore.currentPackInfo !== 'undefined' && PackDeckStore.currentPackInfo && PackDeckStore.currentPackInfo.packName) {
        urlParams.set('name', PackDeckStore.currentPackInfo.packName);
        if (typeof PackDeckStore.isPackTableGenerated !== 'undefined' && PackDeckStore.isPackTableGenerated && PackDeckStore.currentPackInfo.validLocale) {
            urlParams.set('loc', PackDeckStore.currentPackInfo.validLocale);
        }
    }
    setHashQuery('add/pack', urlParams);
}

/**
 * 덱 모드에서 상태 변경 시 현재 상태에 맞는 URL 해시를 동기화합니다.
 */
function updateDeckUrl() {
    if (UIStore.mode !== 'add' || UIStore.chipState.add !== 'deck') return;

    const urlParams = new URLSearchParams();
    const input = document.getElementById('deck-code-input');
    const code = input ? input.value.trim() : "";
    if (code) {
        urlParams.set('code', code);
    }
    setHashQuery('add/deck', urlParams);
}
/**
 * 앱의 메인 모드(페이지)를 전환합니다.
 * @param {string} mode - 전환할 모드 ('home', 'add', 'move' 등)
 * @param {boolean} isInstant - 애니메이션 없이 즉시 전환할지 여부
 * @param {string|null} subMode - 세부 상태 (예: 'add' 모드의 'pack', 'deck' 등)
 * @param {Object|null} params - 추가적인 쿼리 파라미터 (name, loc 등)
 */
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

    // [중요] 새로고침 시 최초 동기화(UserStore.isInitialSyncDone)와 사용자 데이터(UserStore.isUserDataSyncDone)가 완료될 때까지 대기
    if ((!UserStore.isInitialSyncDone || !UserStore.isUserDataSyncDone) && !forceSync) {
        if (window._inventorySyncWaitInterval) return;

        // 대기 중임을 알리는 로딩 UI 표시
        const statusArea = document.getElementById('grid-status-area');
        if (statusArea) {
            statusArea.innerHTML = `
                <div class="grid-loader-overlay">
                    <div class="preloader-wrapper active">
                        <div class="spinner-layer spinner-teal-only">
                            <div class="circle-clipper left"><div class="circle"></div></div>
                            <div class="gap-patch"><div class="circle"></div></div>
                            <div class="circle-clipper right"><div class="circle"></div></div>
                        </div>
                    </div>
                    <div class="grid-loader-text">정보 가져오는 중</div>
                </div>
            `;
            statusArea.style.display = 'flex';
        }

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

/**
 * 사용자 데이터 동기화 확인 및 진행
 */
async function checkAndSyncInventoryData(force = false) {
    const statusArea = document.getElementById('grid-status-area');
    const tbody = document.getElementById('inventory-grid-body');
    if (tbody) tbody.innerHTML = '';

    if (statusArea) {
        statusArea.innerHTML = `
            <div class="grid-loader-overlay">
                <div class="preloader-wrapper active">
                    <div class="spinner-layer spinner-teal-only">
                        <div class="circle-clipper left"><div class="circle"></div></div>
                        <div class="gap-patch"><div class="circle"></div></div>
                        <div class="circle-clipper right"><div class="circle"></div></div>
                    </div>
                </div>
                <div class="grid-loader-text">정보 가져오는 중</div>
            </div>
        `;
        statusArea.style.display = 'flex';
    }

    try {
        if (!UserStore.isInitialSyncDone || force) {
            await loadUserData(); // 정의되지 않은 syncUserData 대신 loadUserData 호출
        }

        inventoryGridState.allData = cardCacheInstance.getInventory();
        inventoryGridState.lastSyncTime = Date.now();

        const loaderText = statusArea ? statusArea.querySelector('.grid-loader-text') : null;
        if (loaderText) loaderText.textContent = "리스트 생성 중";

        setTimeout(() => {
            startGridRendering();
            // 로딩 종료 후 높이 재조정
            setTimeout(updateInventoryContainerHeight, 50);
        }, 300);

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
            <button class="btn cyan-theme waves-effect waves-light" onclick="manualSyncInventory()">불러오기</button>
        </div>
    `;
    statusArea.style.display = 'flex';
}

function renderInventoryLoginRequiredState() {
    const tbody = document.getElementById('inventory-grid-body');
    if (tbody) tbody.innerHTML = '';

    const statusArea = document.getElementById('grid-status-area');
    if (!statusArea) return;

    statusArea.innerHTML = `
        <div class="grid-ready-view">
            <div class="grid-ready-text">로그인 후 보유 현황을 확인하고 관리할 수 있습니다.</div>
            <button class="btn cyan-theme waves-effect waves-light" onclick="toggleAuthModal()">로그인하기</button>
        </div>
    `;
    statusArea.style.display = 'flex';
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
            if (filter.size > 0) {
                data = data.filter(row => filter.has(String(row[idx])));
            }
        } else if (typeof filter === 'string' && filter.trim() !== '') {
            // 입력형 필터 (Type 1)
            const keyword = filter.toLowerCase();
            data = data.filter(row => String(row[idx]).toLowerCase().includes(keyword));
        }
    });

    // 2. 정렬 적용
    const { colIndex, dir } = inventoryGridState.sort;
    data.sort((a, b) => {
        let valA = a[colIndex];
        let valB = b[colIndex];

        // 수량 정렬 처리
        if (colIndex === 3) {
            valA = parseInt(valA) || 0;
            valB = parseInt(valB) || 0;
        }

        if (valA < valB) return dir === 'asc' ? -1 : 1;
        if (valA > valB) return dir === 'asc' ? 1 : -1;
        return 0;
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
    if (statusArea) statusArea.style.display = 'none';

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
                (inventoryGridState.filters[idx] instanceof Set ? inventoryGridState.filters[idx].size > 0 : inventoryGridState.filters[idx] !== "");
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

    if (isInitial) tbody.innerHTML = '';

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
        sensor.style.display = end >= inventoryGridState.filteredData.length ? 'none' : 'block';
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
        if (loader) loader.style.display = 'flex';

        setTimeout(() => {
            inventoryGridState.displayLimit += 50;
            renderInventoryBatch(false);
            if (loader) loader.style.display = 'none';
            inventoryGridState.isRendering = false;
            // 추가 렌더링 후 높이 재조정
            updateInventoryContainerHeight();
        }, 300);
    }
}

/**
 * 정렬 버튼 핸들러
 */
function handleGridSort(colIdx) {
    const isMobile = document.documentElement.classList.contains('is-mobile-device');
    if (isMobile) {
        openGridFilterMobile(colIdx);
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
function openGridFilter(event, colIdx, type) {
    if (event && typeof event.stopPropagation === 'function') {
        event.stopPropagation(); // 헤더 정렬 이벤트 방지
    }
    const isMobile = document.documentElement.classList.contains('is-mobile-device');
    if (isMobile) {
        openGridFilterMobile(colIdx);
        return;
    }

    let btn = (event && event.currentTarget) ? event.currentTarget : null;
    if (btn && !(btn.classList && btn.classList.contains('filter-trigger-btn'))) {
        btn = null;
    }
    if (!btn && event && event.target && typeof event.target.closest === 'function') {
        btn = event.target.closest('.filter-trigger-btn');
    }
    if (!btn || !(btn instanceof HTMLElement) || (btn.getBoundingClientRect && btn.getBoundingClientRect().left === 0)) {
        btn = document.querySelector(`.inventory-table thead th:nth-child(${colIdx + 1}) .filter-trigger-btn`) || 
              document.querySelector('.inventory-table thead th.col-card-no .filter-trigger-btn');
    }
    if (!btn || !(btn instanceof HTMLElement)) return;

    const popup = document.getElementById('inventory-filter-popup');

    // 팝업 표시 및 내용 생성 (너비 측정을 위해 먼저 표시)
    popup.style.display = 'flex';
    if (type === 'type1') renderFilterType1(colIdx);
    else renderFilterType2(colIdx);

    const th = document.querySelector(`.inventory-table thead th:nth-child(${colIdx + 1})`) || 
               document.querySelector('.inventory-table thead th.col-card-no');
    let rect = th ? th.getBoundingClientRect() : btn.getBoundingClientRect();

    // 강제 리플로우를 통해 정확한 팝업 너비 획득
    const popupWidth = popup.getBoundingClientRect().width || 280;

    // th 셀의 중앙 X 좌표에서 팝업의 절반을 뺌
    let left = rect.left + (rect.width / 2) - (popupWidth / 2);

    // 화면 우측 경계 보정
    if (left + popupWidth > window.innerWidth - 10) {
        left = window.innerWidth - popupWidth - 10;
    }
    // 화면 좌측 경계 보정
    if (left < 10) left = 10;

    popup.style.left = Math.round(left) + 'px';
    popup.style.top = Math.round(rect.bottom + 8) + 'px';

    if (typeof OnboardingManager !== 'undefined' && OnboardingManager.isActive()) {
        OnboardingManager.updateHighlight();
    }

    // 외부 클릭 시 닫기
    const closeHandler = (e) => {
        if (!popup.contains(e.target) && !btn.contains(e.target)) {
            popup.style.display = 'none';
            document.removeEventListener('click', closeHandler);
        }
    };
    setTimeout(() => document.addEventListener('click', closeHandler), 10);
}

/**
 * 통합 필터 렌더링 래퍼 함수
 */
function renderFilter(colIdx, type) {
    if (type === 'type1') renderFilterType1(colIdx);
    else renderFilterType2(colIdx);
}

/**
 * 통합 필터 적용 래퍼 함수
 */
function applyGridFilter(colIdx, type) {
    if (type === 'type1') applyGridFilterType1(colIdx);
    else applyGridFilterType2(colIdx);
}

/**
 * 필터 Type 1: 입력형 (이름, 카드 번호)
 */
function renderFilterType1(colIdx) {
    const popup = DOM.inventoryFilterPopup;
    if (!popup) return;
    const currentVal = inventoryGridState.filters[colIdx] || "";

    popup.innerHTML = `
        <input type="text" id="grid-filter-input" class="filter-input-field" placeholder="검색어 입력..." value="${currentVal}">
        <div class="filter-popup-footer">
            <button class="filter-btn filter-btn-close" onclick="closeGridFilter()">닫기</button>
            <button class="filter-btn filter-btn-apply" onclick="applyGridFilterType1(${colIdx})">적용</button>
        </div>
    `;

    const input = document.getElementById('grid-filter-input');
    if (input) {
        input.focus();
        input.onkeydown = (e) => { if (e.key === 'Enter') applyGridFilterType1(colIdx); };
    }
}

function applyGridFilterType1(colIdx) {
    const input = document.getElementById('grid-filter-input');
    const val = input ? input.value.trim() : "";
    if (val === "") delete inventoryGridState.filters[colIdx];
    else inventoryGridState.filters[colIdx] = val;

    closeGridFilter();
    startGridRendering();
}

/**
 * 필터 Type 2: 선택형 (레어도, 수량, 보관 위치, 일러스트)
 */
function renderFilterType2(colIdx) {
    const popup = DOM.inventoryFilterPopup;
    if (!popup) return;

    // 현재 열의 유니크한 값들 추출
    const allValues = [...new Set(inventoryGridState.allData.map(row => String(row[colIdx])))];
    allValues.sort((a, b) => {
        if (colIdx === 3) return parseInt(a) - parseInt(b); // 수량은 숫자 정렬
        return a.localeCompare(b);
    });

    const currentFilters = inventoryGridState.filters[colIdx] || new Set();
    const isAllSelected = currentFilters.size === 0; // 아무것도 없으면 "모두 선택" 상태로 간주 (필터링 안 함)

    let optionsHtml = '';
    allValues.forEach(val => {
        const displayVal = (colIdx === 2) ? getLocalizedRarity(val) : val;
        const checked = currentFilters.has(val) || isAllSelected ? 'checked' : '';
        optionsHtml += `
            <div class="filter-option-item">
                <label>
                    <input type="checkbox" class="filled-in grid-filter-checkbox" value="${val}" ${checked} onchange="handleFilterCheckboxChange(this)" />
                    <span>${displayVal}</span>
                </label>
            </div>
        `;
    });

    popup.innerHTML = `
        <input type="text" class="filter-input-field filter-search-box" placeholder="내부 검색..." oninput="searchFilterOptions(this)">
        <div class="filter-select-toggle" onclick="toggleAllFilterCheckboxes(this)">모두 해제</div>
        <div class="filter-option-list">
            ${optionsHtml}
        </div>
        <div class="filter-popup-footer">
            <button class="filter-btn filter-btn-close" onclick="closeGridFilter()">닫기</button>
            <button class="filter-btn filter-btn-apply" onclick="applyGridFilterType2(${colIdx})">적용</button>
        </div>
    `;
    updateSelectToggleLabel(popup.querySelector('.filter-select-toggle'));
}

function searchFilterOptions(input) {
    const keyword = input.value.toLowerCase();
    const items = input.parentNode.querySelectorAll('.filter-option-item');
    items.forEach(item => {
        const text = item.querySelector('span').textContent.toLowerCase();
        item.style.display = text.includes(keyword) ? 'flex' : 'none';
    });
}

function handleFilterCheckboxChange(cb) {
    updateSelectToggleLabel(cb.closest('.filter-popup').querySelector('.filter-select-toggle'));
}

function toggleAllFilterCheckboxes(btn) {
    const popup = btn.closest('.filter-popup');
    const cbs = Array.from(popup.querySelectorAll('.grid-filter-checkbox')).filter(cb => cb.closest('.filter-option-item').style.display !== 'none');
    const isAnyChecked = cbs.some(cb => cb.checked);

    cbs.forEach(cb => cb.checked = !isAnyChecked);
    updateSelectToggleLabel(btn);
}

function updateSelectToggleLabel(btn) {
    const popup = btn.closest('.filter-popup');
    const cbs = Array.from(popup.querySelectorAll('.grid-filter-checkbox')).filter(cb => cb.closest('.filter-option-item').style.display !== 'none');
    const isAnyChecked = cbs.some(cb => cb.checked);
    btn.textContent = isAnyChecked ? "모두 해제" : "모두 선택";
}

function applyGridFilterType2(colIdx) {
    const popup = DOM.inventoryFilterPopup;
    if (!popup) return;
    const cbs = popup.querySelectorAll('.grid-filter-checkbox');
    const selected = new Set();
    let allCount = 0;

    cbs.forEach(cb => {
        allCount++;
        if (cb.checked) selected.add(cb.value);
    });

    // 모두 선택된 경우 필터 해제
    if (selected.size === allCount || selected.size === 0) {
        delete inventoryGridState.filters[colIdx];
    } else {
        inventoryGridState.filters[colIdx] = selected;
    }

    closeGridFilter();
    startGridRendering();
}

function closeGridFilter() {
    const popup = DOM.inventoryFilterPopup;
    if (popup) popup.style.display = 'none';
}

/* ==========================================================================
   [모바일 개편] 보유현황 목록 정렬 및 필터 바텀시트 동작 구현
   ========================================================================== */

let mobileFilterSheetState = {
    colIndex: -1,
    sortDir: 'asc',
    filterValue: null
};

function openGridFilterMobile(colIdx) {
    const ths = document.querySelectorAll('.inventory-table th');
    const th = ths[colIdx];
    const headerText = th ? th.querySelector('.header-text').textContent.trim() : '';

    mobileFilterSheetState.colIndex = colIdx;
    
    // 현재 적용된 정렬 상태 가져오기
    if (inventoryGridState.sort.colIndex === colIdx) {
        mobileFilterSheetState.sortDir = inventoryGridState.sort.dir || 'asc';
    } else {
        mobileFilterSheetState.sortDir = null; // 정렬 미적용 상태
    }

    // 현재 적용된 필터 상태 복제
    const currentFilter = inventoryGridState.filters[colIdx];
    if (currentFilter instanceof Set) {
        mobileFilterSheetState.filterValue = new Set(currentFilter);
    } else if (typeof currentFilter === 'string') {
        mobileFilterSheetState.filterValue = currentFilter;
    } else {
        if (colIdx === 0 || colIdx === 1) {
            mobileFilterSheetState.filterValue = '';
        } else {
            mobileFilterSheetState.filterValue = new Set();
        }
    }

    // 타이틀 지정
    document.getElementById('grid-filter-sheet-title').textContent = `${headerText} 정렬 및 필터`;

    // 바디 영역 UI 렌더링
    renderMobileFilterSheetBody(colIdx);

    // 바텀시트 표시 애니메이션
    const overlay = document.getElementById('grid-filter-sheet-overlay');
    const sheet = document.getElementById('mobile-grid-filter-sheet');
    overlay.style.display = 'block';
    sheet.style.display = 'flex';
    document.documentElement.classList.add('nav-hidden');
    requestAnimationFrame(() => {
        overlay.classList.add('active');
        sheet.classList.add('active');
    });
}

function renderMobileFilterSheetBody(colIdx) {
    const container = document.getElementById('grid-filter-sheet-body');
    let html = '';

    // 1. 정렬 영역 (colIdx 5: 일러스트는 정렬 제외)
    if (colIdx !== 5) {
        const sortDir = mobileFilterSheetState.sortDir;
        const isAscActive = sortDir === 'asc';
        const isDescActive = sortDir === 'desc';
        html += `
            <div class="mobile-sheet-section">
                <div class="section-title">정렬</div>
                <div class="capsule-button-group">
                    <button type="button" class="capsule-btn ${isAscActive ? 'active' : ''}" onclick="setMobileSortDir('asc')">오름차순</button>
                    <button type="button" class="capsule-btn ${isDescActive ? 'active' : ''}" onclick="setMobileSortDir('desc')">내림차순</button>
                </div>
            </div>
        `;
    }

    // 2. 필터 영역 (수량 colIdx: 3 은 필터링 기능 없이 정렬만 존재)
    if (colIdx !== 3) {
        const isType1 = (colIdx === 0 || colIdx === 1);
        html += `
            <div class="mobile-sheet-section" style="margin-top: 20px;">
                <div class="section-title">필터</div>
        `;

        if (isType1) {
            // type1: 검색어 입력
            const val = mobileFilterSheetState.filterValue || '';
            html += `
                <input type="text" id="mobile-grid-filter-input" class="filter-input-field" placeholder="검색어 입력..." value="${val}" style="width: 100%; box-sizing: border-box;">
            `;
        } else {
            // type2: 체크박스형 필터 목록
            const allValues = [...new Set(inventoryGridState.allData.map(row => String(row[colIdx])))];
            allValues.sort((a, b) => {
                return a.localeCompare(b);
            });

            const currentFilters = mobileFilterSheetState.filterValue || new Set();
            const isAllSelected = currentFilters.size === 0;

            let optionsHtml = '';
            allValues.forEach(val => {
                const displayVal = (colIdx === 2) ? getLocalizedRarity(val) : val;
                const checked = currentFilters.has(val) || isAllSelected ? 'checked' : '';
                optionsHtml += `
                    <div class="filter-option-item">
                        <label>
                            <input type="checkbox" class="filled-in mobile-grid-filter-checkbox" value="${val}" ${checked} onchange="handleMobileFilterCheckboxChange(this)" />
                            <span>${displayVal}</span>
                        </label>
                    </div>
                `;
            });

            // 모두 해제/선택 라벨 결정
            const isAnyChecked = Array.from(currentFilters).length > 0;
            const toggleLabel = (isAnyChecked && !isAllSelected) ? '모두 해제' : '모두 선택';

            html += `
                <input type="text" class="filter-input-field filter-search-box" placeholder="내부 검색..." oninput="searchMobileFilterOptions(this)" style="width: 100%; box-sizing: border-box; margin-bottom: 8px;">
                <div class="filter-select-toggle" onclick="toggleAllMobileFilterCheckboxes(this)" style="margin-bottom: 12px; font-weight: 600; color: var(--primary-color); cursor: pointer; text-align: right; font-size: 0.9rem;">${toggleLabel}</div>
                <div class="filter-option-list" style="max-height: 200px; overflow-y: auto;">
                    ${optionsHtml}
                </div>
            `;
        }
        html += `</div>`;
    }

    html += ``;
    container.innerHTML = html;

    // 적용 버튼 이벤트 연동
    const applyBtn = document.getElementById('grid-filter-sheet-apply-btn');
    applyBtn.onclick = () => applyMobileGridFilterAndSort(colIdx);
}

function setMobileSortDir(dir) {
    mobileFilterSheetState.sortDir = dir;
    const btns = document.querySelectorAll('.capsule-button-group .capsule-btn');
    btns.forEach(btn => {
        if ((dir === 'asc' && btn.textContent === '오름차순') || (dir === 'desc' && btn.textContent === '내림차순')) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
}

function handleMobileFilterCheckboxChange(cb) {
    const parent = cb.closest('.mobile-bottom-sheet');
    if (parent) {
        updateMobileSelectToggleLabel(parent.querySelector('.filter-select-toggle'));
    }
}

function searchMobileFilterOptions(input) {
    const keyword = input.value.toLowerCase();
    const items = input.parentNode.querySelectorAll('.filter-option-item');
    items.forEach(item => {
        const text = item.querySelector('span').textContent.toLowerCase();
        item.style.display = text.includes(keyword) ? 'flex' : 'none';
    });
}

function toggleAllMobileFilterCheckboxes(btn) {
    const sheet = btn.closest('.mobile-bottom-sheet');
    if (!sheet) return;
    const cbs = Array.from(sheet.querySelectorAll('.mobile-grid-filter-checkbox')).filter(cb => cb.closest('.filter-option-item').style.display !== 'none');
    const isAnyChecked = cbs.some(cb => cb.checked);

    cbs.forEach(cb => cb.checked = !isAnyChecked);
    updateMobileSelectToggleLabel(btn);
}

function updateMobileSelectToggleLabel(btn) {
    if (!btn) return;
    const sheet = btn.closest('.mobile-bottom-sheet');
    if (!sheet) return;
    const cbs = Array.from(sheet.querySelectorAll('.mobile-grid-filter-checkbox')).filter(cb => cb.closest('.filter-option-item').style.display !== 'none');
    const isAnyChecked = cbs.some(cb => cb.checked);
    btn.textContent = isAnyChecked ? "모두 해제" : "모두 선택";
}

function applyMobileGridFilterAndSort(colIdx) {
    // 1. 정렬 임시 상태를 원본 상태에 저장 (선택된 값이 있는 경우에만)
    if (colIdx !== 5 && mobileFilterSheetState.sortDir !== null) {
        inventoryGridState.sort.colIndex = colIdx;
        inventoryGridState.sort.dir = mobileFilterSheetState.sortDir;
    }

    // 2. 필터 임시 상태를 원본 상태에 저장 (수량 colIdx: 3 은 필터 적용 없음)
    if (colIdx === 3) {
        delete inventoryGridState.filters[colIdx];
    } else {
        const isType1 = (colIdx === 0 || colIdx === 1);
        if (isType1) {
            const input = document.getElementById('mobile-grid-filter-input');
            const val = input ? input.value.trim() : '';
            if (val === "") {
                delete inventoryGridState.filters[colIdx];
            } else {
                inventoryGridState.filters[colIdx] = val;
            }
        } else {
            const sheet = document.getElementById('mobile-grid-filter-sheet');
            const cbs = sheet.querySelectorAll('.mobile-grid-filter-checkbox');
            const selected = new Set();
            let allCount = 0;

            cbs.forEach(cb => {
                allCount++;
                if (cb.checked) selected.add(cb.value);
            });

            if (selected.size === allCount || selected.size === 0) {
                delete inventoryGridState.filters[colIdx];
            } else {
                inventoryGridState.filters[colIdx] = selected;
            }
        }
    }

    closeGridFilterSheet();
    startGridRendering();
}

function closeGridFilterSheet() {
    const overlay = document.getElementById('grid-filter-sheet-overlay');
    const sheet = document.getElementById('mobile-grid-filter-sheet');
    document.documentElement.classList.remove('nav-hidden');

    if (overlay && sheet) {
        overlay.classList.remove('active');
        sheet.classList.remove('active');
        setTimeout(() => {
            overlay.style.display = 'none';
            sheet.style.display = 'none';
        }, 350);
    }
}

function switchToMode(mode, isInstant = false, subMode = null, params = null, skipAutomation = false) {
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

    if (currentToastInstance) {
        currentToastInstance.dismiss();
        currentToastInstance = null;
        currentToastMessage = null;
    }

    // 'manage' 모드로 진입 시 실제 내부 모드로 매핑
    if (mode === 'manage') {
        mode = UIStore.lastManageMode;
    }

    // 새로고침 시 인증 세션 복원이 완료될 때까지 라우팅 및 렌더링을 안전하게 대기
    if (['add', 'move', 'discard', 'inventory', 'settings'].includes(mode)) {
        if (['add', 'move', 'discard'].includes(mode)) UIStore.lastManageMode = mode;
        if (!window.isAuthInitialized) {
            waitForAuthInit().then(() => {
                switchToMode(mode, isInstant, subMode, params, skipAutomation);
            });
            return;
        }
    }

    // subMode가 명시되지 않은 경우, 현재 저장된 상태를 복원하여 가드 로직 및 UI에 반영
    if (mode === 'add' && !subMode) {
        subMode = UIStore.chipState.add || 'general';
    }

    // [중요] 가드 로직 고도화: 메인 모드, 세부 모드, 그리고 쿼리 파라미터가 모두 현재와 동일하면 중단 (무한 루프 방지)
    const isSameMode = (UIStore.mode === mode);
    const isSameSubMode = (
        (mode !== 'add' && mode !== 'inventory') ||
        (mode === 'add' && (subMode === UIStore.chipState.add)) ||
        (mode === 'inventory' && (!subMode || subMode === UIStore.inventoryMode))
    );

    // 현재 URL의 파라미터 추출 및 비교용 헬퍼
    const getCurrentParamsString = () => {
        const hash = window.location.hash;
        const qIdx = hash.indexOf('?');
        return qIdx !== -1 ? hash.substring(qIdx + 1) : '';
    };

    const getNewParamsString = (p) => {
        if (!p) return '';
        const sp = new URLSearchParams();
        Object.keys(p).forEach(k => { if (p[k]) sp.set(k, p[k]); });
        return sp.toString();
    };

    const isSameParams = (getCurrentParamsString() === getNewParamsString(params));

    if (isSameMode && isSameSubMode && isSameParams && mode !== 'search') return;

    // 세부 모드 상태 즉시 동기화 (가드 통과 시 가장 먼저 수행)
    if (mode === 'add' && subMode) {
        UIStore.chipState.add = subMode;
        if (typeof addSubMode !== 'undefined') addSubMode = subMode;
    } else if (mode === 'inventory') {
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
    if (document.activeElement) { document.activeElement.blur(); }

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
        } else {
            if (mode === 'inventory') {
                subMode = subMode || UIStore.inventoryMode;
            }
            // 세부 모드가 있다면 슬래시(/)를 사용하여 URL 구성
            finalHash = subMode ? `${mode}/${subMode}` : mode;

            // 팩 모드로 명시적 파라미터 없이 진입 시 저장된 상태 복원
            if (mode === 'add' && subMode === 'pack') {
                if (!params || Object.keys(params).length === 0) {
                    if (typeof PackDeckStore.currentPackInfo !== 'undefined' && PackDeckStore.currentPackInfo && PackDeckStore.currentPackInfo.packName) {
                        params = { name: PackDeckStore.currentPackInfo.packName };
                        if (typeof PackDeckStore.isPackTableGenerated !== 'undefined' && PackDeckStore.isPackTableGenerated && PackDeckStore.currentPackInfo.validLocale) {
                            params.loc = PackDeckStore.currentPackInfo.validLocale;
                        }
                    }
                }
            }

            // 파라미터가 있다면 쿼리 스트링 추가
            if (params && Object.keys(params).length > 0) {
                const searchParams = new URLSearchParams();
                for (const key in params) {
                    if (params[key]) searchParams.set(key, params[key]);
                }
                const qs = searchParams.toString();
                if (qs) finalHash += `?${qs}`;
            }
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
        searchInput.value = ''; document.getElementById('clear-btn').style.display = 'none';
        document.getElementById('custom-dropdown').classList.remove('active'); toggleSearchWrapper(false); searchInput.placeholder = "";
        window.scrollTo(0, 0);
    } else if (mode === 'search') { searchInput.placeholder = ""; }
    else {
        searchInput.value = ''; document.getElementById('clear-btn').style.display = 'none';
        document.getElementById('custom-dropdown').classList.remove('active'); toggleSearchWrapper(false); searchInput.placeholder = "카드 검색";
    }

    if (mode === 'home') { body.classList.remove('mode-compact'); } else { body.classList.add('mode-compact'); }

    const wrapper = document.getElementById('content-slider-wrapper');
    if (transitionTimer) {
        clearTimeout(transitionTimer); transitionTimer = null;
        const sections = wrapper.querySelectorAll('.content-section');
        sections.forEach(sec => { sec.classList.remove('active'); });
        const ghost = document.getElementById('result-ghost'); if (ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost);
    }

    let targetContentId = '';
    if (mode === 'home') targetContentId = 'intro-area';
    else if (mode === 'inventory') targetContentId = 'inventory-content-area';
    else if (mode === 'search') targetContentId = 'result-content-wrapper';
    else if (mode === 'discard') { targetContentId = 'manage-content-area'; initPageDiscard(); }
    else if (mode === 'add') { targetContentId = 'manage-content-area'; }
    else if (mode === 'move') { targetContentId = 'manage-content-area'; initPageMove(); }
    else if (mode === 'settings') targetContentId = 'settings-content-area';

    const currentEl = wrapper.querySelector('.content-section.active');
    const nextEl = document.getElementById(targetContentId);

    // [버그 수정] 동일 페이지 내에서 세부 모드(탭)만 바뀌는 경우 애니메이션을 생략함
    if (currentEl === nextEl) {
        if (['add', 'move', 'discard'].includes(mode)) {
            handleManageUI(mode);
            if (mode === 'add' && !skipAutomation) {
                handleAutomationParams(params);
            }
        } else if (mode === 'inventory') {
            switchInventoryMode(UIStore.inventoryMode, true);
        }
        if (typeof OnboardingManager !== 'undefined' && !OnboardingManager.isActive() && (typeof UserStore.user !== 'undefined' && UserStore.user || typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser)) {
            setTimeout(() => OnboardingManager.start(mode), 300);
        }
        return;
    }

    if (isInstant) {
        document.body.classList.add('no-transition');

        if (currentEl) {
            currentEl.classList.remove('active');
        }
        nextEl.classList.add('active');

        if (['add', 'move', 'discard'].includes(mode)) {
            handleManageUI(mode);
            // skipAutomation 옵션에 따라 자동화 처리 수행
            if (mode === 'add' && !skipAutomation) {
                handleAutomationParams(params);
            }
        } else if (mode === 'inventory') {
            switchInventoryMode(UIStore.inventoryMode, true);
        }

        if ((mode === 'home' || mode === 'inventory' || mode === 'discard' || mode === 'add' || mode === 'move' || mode === 'settings') && previousMode === 'search') {
            document.getElementById('result-area').innerHTML = '';
        }



        requestAnimationFrame(() => {
            document.body.classList.remove('no-transition');
        });
        return;
    }

    // 절대 위치 배치 제거: 문서 흐름을 유지하여 높이 붕괴 방지

    if (['add', 'move', 'discard'].includes(mode)) {
        handleManageUI(mode);
        const innerContainer = document.getElementById('manage-mode-forms');
        if (innerContainer) void innerContainer.offsetHeight;
        if (mode === 'add' && !skipAutomation) {
            handleAutomationParams(params);
        }
    } else if (mode === 'inventory') {
        switchInventoryMode(UIStore.inventoryMode, true);
        const innerContainer = document.getElementById('inventory-mode-forms');
        if (innerContainer) void innerContainer.offsetHeight;
    }

    // [최종 안정화] JS가 높이에 개입하지 않도록 모든 인라인 스타일 지정을 배제함
    requestAnimationFrame(() => {
        // 모든 섹션에서 active 제거하여 중복 활성화로 인한 order 충돌 방지
        wrapper.querySelectorAll('.content-section').forEach(sec => {
            sec.classList.remove('active');
        });
        nextEl.classList.add('active');
    });

    transitionTimer = setTimeout(() => {
        // 모든 비활성 섹션 강제 숨김 및 인라인 스타일 청소
        const sections = wrapper.querySelectorAll('.content-section');
        sections.forEach(sec => {
            if (sec.id !== targetContentId) {
                sec.classList.remove('active');
            }
        });

        nextEl.classList.add('active');

        const ghost = document.getElementById('result-ghost');
        if (ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost);

        if ((mode === 'home' || mode === 'discard' || mode === 'add' || mode === 'move' || mode === 'settings') && previousMode === 'search') {
            document.getElementById('result-area').innerHTML = '';
        }

        // 온보딩 가이드 트리거 (로그인 상태일 때만)
        if (typeof OnboardingManager !== 'undefined' && !OnboardingManager.isActive() && (typeof UserStore.user !== 'undefined' && UserStore.user || typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser)) {
            setTimeout(() => OnboardingManager.start(mode), 300);
        }

        transitionTimer = null;
    }, 400);
}

function checkClearBtn() { const val = document.getElementById('card-search').value; const btn = document.getElementById('clear-btn'); if (btn) btn.style.display = val ? 'block' : 'none'; }
function toggleSearchWrapper(isOpen) {
    const wrapper = document.getElementById('search-wrapper');
    const list = document.getElementById('custom-dropdown');
    if (wrapper && list) {
        if (isOpen) {
            wrapper.classList.add('active');
            // DOM 업데이트 후 높이 측정
            setTimeout(() => {
                const scrollHeight = list.scrollHeight;
                // scrollHeight에 이미 CSS의 padding-bottom(15px)이 포함되어 있으므로 추가 합산 제거
                // CSS max-height: 250px와 일치하도록 보정
                const finalHeight = Math.min(scrollHeight, 250);
                wrapper.style.setProperty('--dropdown-height', finalHeight + 'px');
            }, 50); // 약간의 지연으로 레이아웃 안정화 보장
        } else {
            wrapper.classList.remove('active');
            wrapper.style.setProperty('--dropdown-height', '0px');
        }
    }
}


function initPageAdd() {
    const isMobile = document.documentElement.classList.contains('is-mobile-device');
    const subMode = UIStore.chipState.add || addSubMode;
    if (isMobile) {
        let listContainerId = (subMode === 'pack') ? 'mobile-cards-list-pack' : (subMode === 'deck') ? 'mobile-cards-list-deck' : 'mobile-cards-list-general';
        const listContainer = document.getElementById(listContainerId);
        if (listContainer) {
            listContainer.innerHTML = '';
            mobileAddEntry('add', subMode);
        }
    } else {
        let listContainerId = (subMode === 'pack') ? 'desktop-cards-list-pack' : (subMode === 'deck') ? 'desktop-cards-list-deck' : 'desktop-cards-list-general';
        const listContainer = document.getElementById(listContainerId);
        if (listContainer) {
            listContainer.innerHTML = '';
            desktopAddEntry('add', subMode);
        }
    }
}

function adjustAddCount(delta) {
    if (!FormRowStore.addCounts[UIStore.chipState.add]) FormRowStore.addCounts[UIStore.chipState.add] = 1;
    FormRowStore.addCounts[UIStore.chipState.add] += delta;
    if (FormRowStore.addCounts[UIStore.chipState.add] < 1) FormRowStore.addCounts[UIStore.chipState.add] = 1;

    let targetId = 'add-count';
    if (UIStore.chipState.add === 'pack') targetId = 'pack-add-count';
    else if (UIStore.chipState.add === 'deck') targetId = 'deck-add-count';

    const el = document.getElementById(targetId);
    if (el) el.innerText = FormRowStore.addCounts[UIStore.chipState.add] + "장";
    
    const elDesktop = document.getElementById(targetId + "-desktop");
    if (elDesktop) elDesktop.innerText = FormRowStore.addCounts[UIStore.chipState.add] + "장";
}

function addMultipleRows(e, targetTbodyId) {
    if (e && e.target) e.target.blur();
    const count = FormRowStore.addCounts[UIStore.chipState.add] || 1;

    let firstNewCard = null;
    for (let i = 0; i < count; i++) {
        const card = desktopAddEntry('add', UIStore.chipState.add);
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
        const card = desktopAddEntry('move', null);
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
        if (listContainer && listContainer.querySelectorAll('.mobile-info-card').length === 0) {
            listContainer.innerHTML = '';
            mobileAddEntry('discard');
        }
    } else {
        const listContainer = document.getElementById('desktop-cards-list-discard');
        if (listContainer && listContainer.querySelectorAll('.desktop-info-card').length === 0) {
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
        const card = desktopAddEntry('discard', null);
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

function manageAddEntry(initialData = null, insertAfterRow = null, subMode = 'general') {
    const isMobile = document.documentElement.classList.contains('is-mobile-device');
    if (isMobile) {
        return mobileAddEntry('add', subMode, initialData);
    } else {
        return desktopAddEntry('add', subMode, initialData);
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
    const subMode = UIStore.chipState.add || 'general';
    const containerId = isMobile 
        ? `mobile-cards-list-${subMode}` 
        : `desktop-cards-list-${subMode}`;

    const container = document.getElementById(containerId);
    if (!container) return;
    
    const cardClass = isMobile ? '.mobile-info-card' : '.desktop-info-card';
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
    const target = getQueryTarget(row);
    const illustInp = target.querySelector('.discard-card-illustration, .desktop-card-illust, [data-field="illust"]'); const rareInp = target.querySelector('.discard-card-rarity, .desktop-card-rare, [data-field="rare"]'); const locInp = target.querySelector('.discard-card-loc, .desktop-card-loc, [data-field="loc"]'); const qtyInput = target.querySelector('.discard-card-qty, .desktop-card-qty, [data-field="qty"]');
    const illustWrap = illustInp ? illustInp.closest('.custom-select-wrapper') : null; const rareWrap = rareInp ? rareInp.closest('.custom-select-wrapper') : null; const locWrap = locInp ? locInp.closest('.custom-select-wrapper') : null;
    if (illustWrap) { illustWrap.classList.remove('single-option'); illustWrap.classList.add('no-option'); }
    if (rareWrap) { rareWrap.classList.remove('single-option'); rareWrap.classList.add('no-option'); }
    if (locWrap) { locWrap.classList.remove('single-option'); locWrap.classList.add('no-option'); }
    if (level === 'no') {
        illustInp.value = ""; illustInp.setAttribute('readonly', true); if (illustWrap) illustWrap.dataset.options = "[]";
        rareInp.value = ""; rareInp.setAttribute('readonly', true); if (rareWrap) rareWrap.dataset.options = "[]"; delete rareInp.dataset.raw;
        locInp.value = ""; if (locWrap) locWrap.dataset.options = "[]"; delete locInp.dataset.raw; qtyInput.value = '';
    }

    if (document.documentElement.classList.contains('is-mobile-device')) {
        renderMobileCards();
    }
}

function updateDiscardIllusts(row, matches) {
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
    illustInp.removeAttribute('readonly'); illustWrap.classList.remove('no-option');
    setupDropdownForField(illustInp, illustWrap);
    const currentVal = illustInp.value; const isValid = options.some(o => o.val === currentVal);
    if (isValid) { handleDiscardIllustChange(illustInp); } else {
        if (options.length === 1) { illustWrap.classList.add('single-option'); illustInp.value = options[0].val; handleDiscardIllustChange(illustInp); }
        else if (options.length === 0) { illustInp.value = ""; illustWrap.classList.add('no-option'); resetDiscardRow(row, 'no'); }
        else { illustInp.value = ""; illustWrap.classList.remove('single-option'); handleDiscardIllustChange(illustInp); }
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
    const selectedIllust = input.value;
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
    const illust = illustInp ? illustInp.value : "";
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
    const illust = illustInp ? illustInp.value : "";
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
    const selectedIllust = illustInp ? illustInp.value : "";
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
    const illust = illustInp ? illustInp.value : "";
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
    const illust = illustInp ? illustInp.value : "";
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
    const cardClass = isMobile ? '.mobile-info-card' : '.desktop-info-card';

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

    if (nameVal && clearBtn) clearBtn.style.display = 'block';
    else if (clearBtn) clearBtn.style.display = 'none';

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
    input.value = input.value.replace(/[ㄱ-ㅎ|ㅏ-ㅣ|가-힣]/g, '').toUpperCase();
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
    }
    if (row) {
        delete row.dataset.searchMode;
        delete row.dataset.cardData;
    }

    if (nameInput) {
        nameInput.dataset.programmatic = "true";
        nameInput.value = "";
        nameInput.removeAttribute('readonly');
        nameInput.classList.remove('hyperlink-style', 'error-placeholder');
        nameInput.style.cursor = '';
        nameInput.style.textDecoration = '';
        nameInput.placeholder = "카드 이름";
        nameInput.onclick = null;
        nameInput.dataset.prevName = "";
        delete nameInput.dataset.programmatic;
    }

    if (noInput) {
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
        if (arrow) arrow.style.display = 'none';
        noWrap.classList.add('no-option');
        noWrap.classList.remove('single-option');
    }

    if (isMove) {
        resetMoveRow(row || container, 'no');
    } else if (isDiscard) {
        resetDiscardRow(row || container, 'no');
    }

    const clearBtn = container.querySelector('.clear-name-btn') || (btn_or_input.classList && btn_or_input.classList.contains('clear-name-btn') ? btn_or_input : null);
    if (clearBtn) {
        clearBtn.style.display = 'none';
    }


}

async function fetchCardByName(input, force = false) {
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
        illustInp.value = ""; 
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
            if (arrow) arrow.style.display = 'none';
        }

        let res = null;

        if (mode === 'add') {
            res = await callApi('searchCardByName', { name: nameVal });
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
                    const cid = ClientCache._nameToCid[nameVal] || "LOCAL_CID";
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
            input.style.cursor = '';
            input.style.textDecoration = '';

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
            illustrationCount: res.illustrationCount,
            raritiesByNo: res.raritiesByNo,
            linkData: res.linkData
        };

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
    if (anotherInp) { anotherInp.value = ""; anotherInp.setAttribute('readonly', true); }
    if (illustrationWrap) { illustrationWrap.dataset.options = "[]"; illustrationWrap.classList.remove('single-option'); illustrationWrap.classList.add('no-option'); }
}

function lockNameInputAndSetLink(nameInput, name, container, linkData = null) {
    if (!nameInput) return;
    resetNameInputForSearchFunc(nameInput, container);
    nameInput.dataset.programmatic = "true";
    nameInput.value = name;
    
    let finalLinkId = null;
    let finalLocale = UIStore.currentRegion;
    let finalLocales = [];
    
    if (linkData) {
        finalLinkId = linkData.id;
        finalLocale = linkData.locale || UIStore.currentRegion;
        finalLocales = linkData.locales || [];
    } else {
        const cid = ClientCache._nameToCid[name];
        if (cid) {
            finalLinkId = cid;
        }
    }
    
    if (finalLinkId && finalLinkId !== "MISSING_CID") {
        nameInput.classList.add('hyperlink-style');
        nameInput.style.cursor = 'pointer';
        nameInput.style.textDecoration = 'underline';
        nameInput.onclick = function() {
            if (finalLocales.length > 1) {
                showCardLocaleTooltip(this, finalLocales, finalLinkId);
            } else {
                window.open(getCardDetailUrl(finalLinkId, finalLocale), '_blank');
            }
        };
    }
    
    nameInput.setAttribute('readonly', true);
    delete nameInput.dataset.programmatic;
    
    const clearBtn = container.querySelector('.clear-name-btn');
    if (clearBtn) clearBtn.style.display = 'block';
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
            if (arrow) {
                arrow.style.display = '';
                arrow.style.pointerEvents = '';
            }
        } else {
            noWrap.classList.add('no-arrow');
            const arrow = noWrap.querySelector('.arrow-icon');
            if (arrow) {
                arrow.style.display = 'none';
                arrow.style.pointerEvents = 'none';
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
    nameInput.style.cursor = '';
    nameInput.style.textDecoration = '';
    nameInput.onclick = null;
    delete nameInput.dataset.programmatic;
    const clearBtn = container.querySelector('.clear-name-btn');
    if (clearBtn) clearBtn.style.display = 'none';
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
        if (clearBtn && nameInput && nameInput.value) clearBtn.style.display = 'block';
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

                nameInput.style.cursor = "pointer";
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
                nameInput.style.cursor = "pointer";
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
            input.style.cursor = "pointer";
            input.onclick = () => {
                if (input.dataset.errorRetry) {
                    input.dataset.prevCardNo = "";
                    input.dataset.programmatic = "true";
                    input.placeholder = "카드 번호";
                    input.classList.remove('error-placeholder');
                    input.style.cursor = "";
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
                illustrationCount: res.illustrationCount,
                rarities: rarities,
                raritiesByNo: res.raritiesByNo || {},
                cardNo: cardNo,
                isFallback: false,
                linkData: res.linkData
            }, container);
            const clearBtn = container.querySelector('.clear-name-btn');
            if (clearBtn && nameInput && nameInput.value) clearBtn.style.display = 'block';
        }
    } catch (e) {
        if (input.value.trim() !== cardNo) return;
        resetNameInputForSearchFunc(nameInput, container);
        if (nameInput) {
            nameInput.dataset.programmatic = "true";
            nameInput.placeholder = "접속 오류(클릭재시도)";
            nameInput.classList.add('error-placeholder');
            nameInput.setAttribute('readonly', true);
            nameInput.style.cursor = "pointer";
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

    container.dataset.cardData = JSON.stringify(data);

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

    const count = data.illustrationCount || 1;
    let illustOptions = [];

    const isMobileDevice = document.documentElement.classList.contains('is-mobile-device');

    if (illustrationWrap) {
        if (count > 1) {
            illustOptions.push({ val: "기본", text: "기본" });
            for (let i = 2; i <= count; i++) {
                let suffix = "th"; if (i === 2) suffix = "nd"; if (i === 3) suffix = "rd";
                illustOptions.push({ val: `${i}${suffix}`, text: `${i}${suffix}` });
            }
            illustrationWrap.dataset.options = JSON.stringify(illustOptions);
            illustrationWrap.classList.remove('single-option');
            illustrationWrap.classList.remove('no-option');
        } else {
            if (anotherInp) {
                anotherInp.value = "기본";
                anotherInp.dataset.raw = "기본";
            }
            illustrationWrap.classList.add('single-option');
            illustrationWrap.classList.remove('no-option');
            illustrationWrap.dataset.options = JSON.stringify([{ val: "기본", text: "기본" }]);
        }
        if (!isMobileDevice && anotherInp) {
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
        rarityWrap.classList.remove('no-option');

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



function showResultModal(successCount, successQty, detailLog, errorMsg, isFullSynced) {
    const modal = document.getElementById('add-result-modal');
    const iconArea = document.getElementById('result-icon-area');
    const successText = document.getElementById('result-success-text');
    const failText = document.getElementById('result-fail-text');
    const summaryBody = document.getElementById('result-summary-body');
    const detailBody = document.getElementById('result-detail-body');

    const titleEl = document.getElementById('add-modal-title');
    if (successCount > 0) { titleEl.innerText = "카드 등록 완료!"; }
    else { titleEl.innerText = "카드 등록 실패!"; }

    summaryBody.innerHTML = ''; detailBody.innerHTML = '';
    successText.innerHTML = ""; failText.innerHTML = "";
    // applyModalDetailUI에서 레이아웃을 결정하므로 개별 display 설정 제거

    if (errorMsg) {
        iconArea.innerHTML = '<i class="material-icons" style="color: var(--error-red);">error</i>';
        failText.innerText = "오류 발생: " + errorMsg;
        failText.style.color = 'var(--error-red)';
    } else {
        const failCount = detailLog.length - successCount;
        if (failCount === 0) { iconArea.innerHTML = '<i class="material-icons" style="color: var(--success-green);">check_circle</i>'; }
        else if (successCount === 0) { iconArea.innerHTML = '<i class="material-icons" style="color: var(--error-red);">cancel</i>'; }
        else { iconArea.innerHTML = '<i class="material-icons" style="color: var(--warning-yellow);">warning</i>'; }

        if (successCount > 0) { successText.innerHTML = `<div style="margin-bottom:4px;">${successQty}장 성공, ${failCount}건 실패</div>`; }
        else if (failCount > 0) { successText.innerHTML = `<div style="margin-bottom:4px; color:var(--error-red);">${successQty}장 성공, ${failCount}건 실패</div>`; }

        if (isFullSynced) {
            successText.innerHTML += `<div style="margin-top:8px; color:var(--warning-yellow); font-weight:bold;">외부 수정이 감지되어 전체 동기화가 진행되었습니다.</div>`;
        }

        const successLogs = detailLog.filter(l => l.status === 'success');
        if (successLogs.length > 0) {
            const nameAgg = {};
            successLogs.forEach(l => { if (!nameAgg[l.name]) nameAgg[l.name] = 0; nameAgg[l.name] += l.qty; });
            for (const [name, qty] of Object.entries(nameAgg)) {
                summaryBody.innerHTML += `<tr class="result-summary-row-success"><td>${escapeHTML(name)}</td><td>${escapeHTML(qty)}장</td></tr>`;
            }
        }
        const failLogs = detailLog.filter(l => l.status === 'fail');
        if (failLogs.length > 0) {
            const failAgg = {};
            failLogs.forEach(l => {
                let reason = l.failReason;
                if (reason === 'empty_no' || reason === 'invalid_no') reason = "카드 번호 오류";
                else if (reason === 'no_another') reason = "일러스트 오류";
                else if (reason === 'no_proc') reason = "레어도 오류";
                else if (reason === 'invalid_qty') reason = "수량 오류";
                else if (reason === 'no_loc') reason = "위치 오류";
                else if (reason === 'loading') reason = "번호 검색 중";

                if (!failAgg[reason]) failAgg[reason] = 0;
                failAgg[reason]++;
            });
            for (const [reason, count] of Object.entries(failAgg)) {
                summaryBody.innerHTML += `<tr class="result-summary-row-fail"><td>${escapeHTML(reason)}</td><td>${escapeHTML(count)}건</td></tr>`;
            }
        }

        detailLog.forEach((log, idx) => {
            const tr = document.createElement('tr');
            let procTxt = log.proc || log.rarity;
            let locTxt = log.loc;
            let qtyTxt = log.qty;
            let anotherTxt = log.another || log.illustration;
            let cardNoStyle = ''; let anotherStyle = ''; let procStyle = ''; let locStyle = ''; let qtyStyle = '';

            if (log.status === 'fail') {
                if (log.failReason === 'empty_no') {
                    log.cardNo = "미입력"; log.name = "-"; anotherTxt = "-"; procTxt = ""; locTxt = "-"; qtyTxt = "-";
                    cardNoStyle = 'color:var(--error-red); font-weight:700;';
                } else if (log.failReason === 'invalid_no') {
                    log.cardNo = "카드번호 오류"; log.name = "-"; procTxt = "-"; locTxt = "-"; qtyTxt = "-"; anotherTxt = "-";
                    cardNoStyle = 'color:var(--error-red); font-weight:700;';
                } else if (log.failReason === 'no_proc') {
                    procTxt = "미선택"; locTxt = "-"; qtyTxt = "-"; procStyle = 'color:var(--error-red); font-weight:700;';
                } else if (log.failReason === 'no_loc') {
                    locTxt = "미선택"; qtyTxt = "-"; locStyle = 'color:var(--error-red); font-weight:700;';
                } else if (log.failReason === 'no_another') {
                    anotherTxt = "미선택"; procTxt = "-"; locTxt = "-"; qtyTxt = "-"; anotherStyle = 'color:var(--error-red); font-weight:700;';
                } else if (log.failReason === 'invalid_qty') {
                    qtyStyle = 'color:var(--error-red); font-weight:700;';
                } else if (log.failReason === 'loading') {
                    log.cardNo = "검색 중"; log.name = "-"; anotherTxt = "-"; procTxt = "-"; locTxt = "-"; qtyTxt = "-";
                    cardNoStyle = 'color:var(--error-red); font-weight:700;';
                }
            }
            // 인라인 스타일 최소화 (github version 대조 복구)
            tr.innerHTML = `<td>${idx + 1}</td><td>${escapeHTML(log.name)}</td><td style="${cardNoStyle}">${escapeHTML(log.cardNo)}</td><td style="${anotherStyle}">${escapeHTML(anotherTxt)}</td><td style="${procStyle}">${escapeHTML(getLocalizedRarity(procTxt) || "-")}</td><td style="${locStyle}">${escapeHTML(locTxt)}</td><td style="${qtyStyle}">${escapeHTML(qtyTxt)}</td>`;
            detailBody.appendChild(tr);
        });
    }

    toggleBackgroundInert(true);
    M.Modal.getInstance(modal).open();
    // 사용자 설정에 맞게 상세/요약 레이아웃 초기화
    setTimeout(() => applyModalDetailUI(UserStore.settings.isDetailMode), 50);
}

function showDiscardResultModal(successCount, successQty, detailLog, errorMsg, isFullSynced) {
    const modal = document.getElementById('discard-result-modal');
    const iconArea = document.getElementById('discard-result-icon-area');
    const successText = document.getElementById('discard-success-text');
    const failText = document.getElementById('discard-fail-text');
    const summaryBody = document.getElementById('discard-summary-body');
    const detailBody = document.getElementById('discard-result-detail-body');

    const titleEl = document.getElementById('discard-modal-title');
    if (successCount > 0) { titleEl.innerText = "카드 제거 완료!"; }
    else { titleEl.innerText = "카드 제거 실패!"; }

    summaryBody.innerHTML = ''; detailBody.innerHTML = '';
    successText.innerHTML = ""; failText.innerHTML = "";
    // applyModalDetailUI에서 레이아웃을 결정하므로 개별 display 설정 제거

    if (errorMsg) {
        iconArea.innerHTML = '<i class="material-icons" style="color: var(--error-red);">error</i>';
        failText.innerText = "오류 발생: " + errorMsg;
        failText.style.color = 'var(--error-red)';
    } else {
        const failCount = detailLog.length - successCount;
        if (failCount === 0) { iconArea.innerHTML = '<i class="material-icons" style="color: var(--success-green);">check_circle</i>'; }
        else if (successCount === 0) { iconArea.innerHTML = '<i class="material-icons" style="color: var(--error-red);">cancel</i>'; }
        else { iconArea.innerHTML = '<i class="material-icons" style="color: var(--warning-yellow);">warning</i>'; }

        if (successCount > 0) { successText.innerHTML = `<div style="margin-bottom:4px;">${successQty}장 성공, ${failCount}건 실패</div>`; }
        else if (failCount > 0) { successText.innerHTML = `<div style="margin-bottom:4px; color:var(--error-red);">${successQty}장 성공, ${failCount}건 실패</div>`; }

        if (isFullSynced) {
            successText.innerHTML += `<div style="margin-top:8px; color:var(--warning-yellow); font-weight:bold;">외부 수정이 감지되어 전체 동기화가 진행되었습니다.</div>`;
        }

        const successLogs = detailLog.filter(l => l.status === 'success');
        if (successLogs.length > 0) {
            const nameAgg = {};
            successLogs.forEach(l => { if (!nameAgg[l.name]) nameAgg[l.name] = 0; nameAgg[l.name] += l.qty; });
            for (const [name, qty] of Object.entries(nameAgg)) {
                summaryBody.innerHTML += `<tr class="result-summary-row-success"><td>${escapeHTML(name)}</td><td>${escapeHTML(qty)}장</td></tr>`;
            }
        }
        const failLogs = detailLog.filter(l => l.status === 'fail');
        if (failLogs.length > 0) {
            const failAgg = {};
            failLogs.forEach(l => {
                let reason = l.failReason;
                if (reason === 'empty_no' || reason === 'invalid_no') reason = "카드 번호 오류";
                else if (reason === 'no_another') reason = "일러스트 미선택";
                else if (reason === 'no_proc') reason = "레어도 미선택";
                else if (reason === 'no_loc') reason = "보관 위치 미선택";
                else if (reason === 'invalid_qty') reason = "수량 오류";

                if (!failAgg[reason]) failAgg[reason] = 0;
                failAgg[reason]++;
            });
            for (const [reason, count] of Object.entries(failAgg)) {
                summaryBody.innerHTML += `<tr class="result-summary-row-fail"><td>${escapeHTML(reason)}</td><td>${escapeHTML(count)}건</td></tr>`;
            }
        }

        detailLog.forEach((log, idx) => {
            const tr = document.createElement('tr');
            let procTxt = log.proc || log.rarity;
            let locTxt = log.loc;
            let qtyTxt = log.qty;
            let anotherTxt = log.another || log.illustration;
            let cardNoStyle = ''; let anotherStyle = ''; let procStyle = ''; let locStyle = ''; let qtyStyle = '';

            if (log.status === 'fail') {
                if (log.failReason === 'empty_no') {
                    log.cardNo = "미입력"; log.name = "-"; anotherTxt = "-"; procTxt = ""; locTxt = "-"; qtyTxt = "-";
                    cardNoStyle = 'color:var(--error-red); font-weight:700;';
                } else if (log.failReason === 'invalid_no') {
                    log.cardNo = "오류"; log.name = "-"; procTxt = "-"; locTxt = "-"; qtyTxt = "-"; anotherTxt = "-";
                    cardNoStyle = 'color:var(--error-red); font-weight:700;';
                } else if (log.failReason === 'no_another') {
                    anotherTxt = "미선택"; procTxt = "-"; locTxt = "-"; qtyTxt = "-"; anotherStyle = 'color:var(--error-red); font-weight:700;';
                } else if (log.failReason === 'no_proc') {
                    procTxt = "미선택"; locTxt = "-"; qtyTxt = "-"; procStyle = 'color:var(--error-red); font-weight:700;';
                } else if (log.failReason === 'no_loc') {
                    locTxt = "미선택"; qtyTxt = "-"; locStyle = 'color:var(--error-red); font-weight:700;';
                } else if (log.failReason === 'invalid_qty') {
                    qtyStyle = 'color:var(--error-red); font-weight:700;';
                }
            }
            tr.innerHTML = `<td>${idx + 1}</td><td>${escapeHTML(log.name)}</td><td style="${cardNoStyle}">${escapeHTML(log.cardNo)}</td><td style="${anotherStyle}">${escapeHTML(anotherTxt)}</td><td style="${procStyle}">${escapeHTML(getLocalizedRarity(procTxt) || "-")}</td><td style="${locStyle}">${escapeHTML(locTxt)}</td><td style="${qtyStyle}">${escapeHTML(qtyTxt)}</td>`;
            detailBody.appendChild(tr);
        });
    }

    toggleBackgroundInert(true);
    M.Modal.getInstance(modal).open();
    // 사용자 설정에 맞게 상세/요약 레이아웃 초기화
    setTimeout(() => applyModalDetailUI(UserStore.settings.isDetailMode), 50);
}

async function handleContinueDiscard() {
    M.Modal.getInstance(document.getElementById('discard-result-modal')).close();
    toggleBackgroundInert(false);

    const isMobile = document.documentElement.classList.contains('is-mobile-device');
    const containerId = isMobile ? 'mobile-cards-list-discard' : 'desktop-cards-list-discard';
    const cardClass = isMobile ? '.mobile-info-card' : '.desktop-info-card';
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
    const submitBtn = document.getElementById('add-submit-main-btn');
    if (submitBtn && submitBtn.classList.contains('disabled')) return;

    const entries = [];
    const isMobile = document.documentElement.classList.contains('is-mobile-device');

    if (isMobile) {
        const listContainerId = (UIStore.chipState.add === 'pack') ? 'mobile-cards-list-pack' : (UIStore.chipState.add === 'deck') ? 'mobile-cards-list-deck' : 'mobile-cards-list-general';
        const listContainer = document.getElementById(listContainerId);
        if (listContainer) {
            const cards = listContainer.querySelectorAll('.mobile-info-card');
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
        const listContainerId = (UIStore.chipState.add === 'pack') ? 'desktop-cards-list-pack' : (UIStore.chipState.add === 'deck') ? 'desktop-cards-list-deck' : 'desktop-cards-list-general';
        const listContainer = document.getElementById(listContainerId);
        if (listContainer) {
            const cards = listContainer.querySelectorAll('.desktop-info-card');
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
        else if (!loc) failReason = "no_loc";
        else if (!qty || qty < 1) failReason = "invalid_qty";

        if (failReason) {
            detailLog.push({ no, name: nameText, cardNo, illustration: illustrationRaw, rarity: item.rawRarityVal || "미선택", loc: loc || "미선택", qty: qty || 0, status: 'fail', failReason });
            el.dataset.status = 'fail';
        } else {
            validRows.push([nameText, cardNo, procRaw, qty, loc, illustrationRaw]);
            detailLog.push({ no, name: nameText, cardNo, illustration: illustrationRaw, rarity: procRaw, loc, qty, status: 'success' });
            successCount++; successQty += qty;
            el.dataset.status = 'success';
        }
    });

    if (validRows.length > 0) {
        showLoading(true, "등록 중...");
        try {
            const reqData = { rows: validRows };
            const res = await callApi('addCards', buildAuthPayload(), reqData);
            showLoading(false);

            if (res.success) {
                updateLocalInventory(res.updatedItems);
                // 서버에서 받은 통계 업데이트
                if (res.locations !== undefined) {
                    cardCacheInstance.setSummary(res.amount, res.locations, res.rarities);
                    updateTotals();
                    renderHomeDash();
                }
                syncCounter++;
                showResultModal(successCount, successQty, detailLog, null);
            } else {
                // [토스트 삭제] UI 모달에서 안내되므로 제거
                showResultModal(0, 0, [], res.message || '오류 발생');
            }
        } catch (e) {
            showLoading(false);
            // [토스트 삭제] UI 모달에서 안내되므로 제거
            showResultModal(0, 0, [], e.toString());
        }
    } else if (detailLog.length > 0) {
        showResultModal(0, 0, detailLog);
    } else {
        // [토스트 삭제] UI 모달에서 안내되므로 제거
    }
}

async function submitDiscardEntries() {
    const submitBtn = document.getElementById('discard-submit-main-btn');
    if (submitBtn && submitBtn.classList.contains('disabled')) return;

    const entries = [];
    const isMobile = document.documentElement.classList.contains('is-mobile-device');

    if (isMobile) {
        const listContainer = document.getElementById('mobile-cards-list-discard');
        if (listContainer) {
            const cards = listContainer.querySelectorAll('.mobile-info-card');
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
            const cards = listContainer.querySelectorAll('.desktop-info-card');
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
        } else if (!qty || qty < 1) {
            failReason = "invalid_qty";
        }

        if (failReason) {
            hasFail = true;
            el.dataset.status = 'fail';
            detailLog.push({ no, name: nameText, cardNo, illustration: illustration || "-", rarity: rarity || "-", loc: loc || "-", qty: qty || 0, status: 'fail', failReason });
        } else {
            validRows.push({ cardNo, name: nameText, rarity, illustration, loc, qty });
            detailLog.push({ no, name: nameText, cardNo, illustration, rarity, loc, qty, status: 'success' });
            successCount++; successQty += qty;
            el.dataset.status = 'success';
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

    showLoading(true, "카드 제거 중...");
    try {
        const res = await callApi('discardCards', buildAuthPayload(), { discards: validRows });
        showLoading(false);

        if (res.success) {
            updateLocalInventory(res.updatedItems);
            // 서버에서 받은 통계 업데이트
            if (res.locations !== undefined) {
                cardCacheInstance.setSummary(res.amount, res.locations, res.rarities);
                updateTotals();
                renderHomeDash();
            }
            syncCounter++;
            showDiscardResultModal(successCount, successQty, detailLog, null);
        } else {
            // [토스트 삭제] UI 모달에서 안내되므로 제거
            showDiscardResultModal(0, 0, detailLog, res.message || '오류 발생');
        }
    } catch (e) {
        showLoading(false);
        // [토스트 삭제] UI 모달에서 안내되므로 제거
        showDiscardResultModal(0, 0, detailLog, e.toString());
    }
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

function showRecentInDropdown() {
    const recent = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    const list = document.getElementById('custom-dropdown');
    UIStore.dropdownFocus = -1;
    Array.from(list.children).forEach(child => { if (!child.classList.contains('recent-header-item')) { child.remove(); } });
    let header = document.getElementById('recent-header');
    if (!header) {
        header = document.createElement('li');
        header.id = 'recent-header';
        header.className = 'recent-header-item';
        header.innerHTML = `<span class="recent-title">최근 검색</span><span class="clear-all-btn">전체 제거</span>`;
        list.prepend(header);
    }
    if (recent.length === 0) {
        const noResultLi = document.createElement('li');
        noResultLi.className = 'no-result-item';
        noResultLi.innerText = '검색 기록이 없습니다.';
        list.appendChild(noResultLi);
    } else {
        recent.slice(0, 5).forEach(r => {
            const li = document.createElement('li');
            li.className = 'recent-item-row';
            const keyword = typeof r === 'string' ? r : r.keyword;
            const searchType = typeof r === 'string' ? 'auto' : (r.searchType || 'auto');
            const isTarget = typeof r === 'string' ? false : !!r.isTarget;

            li.dataset.val = keyword;
            li.dataset.type = searchType;
            li.dataset.isTarget = isTarget ? 'true' : 'false';

            let tagHtml = '';
            if (isTarget) {
                if (searchType === 'number') {
                    tagHtml = `<span class="no-badge">[번호]</span>`;
                } else {
                    tagHtml = `<span class="name-badge">[이름]</span>`;
                }
            }

            li.innerHTML = `<span class="recent-text text-suggest">${tagHtml}${escapeHTML(keyword)}</span><i class="material-icons item-delete-btn">close</i>`;
            list.appendChild(li);
        });
    }
    list.style.display = 'block'; // 명시적 표시 보장
    list.classList.add('active');
    toggleSearchWrapper(true);
}

function filterAndShowDropdown(val, isMobile = false) {
    const listId = isMobile ? 'mobile-custom-dropdown' : 'custom-dropdown';
    if (!val) {
        if (isMobile) showMobileRecentInDropdown(); else showRecentInDropdown();
        return;
    }
    const list = document.getElementById(listId);
    if (!list) return;
    const query = val.trim().replace(/\s+/g, '').toLowerCase();
    if (!query) {
        if (isMobile) showMobileRecentInDropdown(); else showRecentInDropdown();
        return;
    }
    UIStore.dropdownFocus = -1;

    const hasGlobal = typeof CardDataStore.allCardNamesNormalized !== 'undefined' && CardDataStore.allCardNamesNormalized.length > 0;
    const ownedNames = typeof cardCacheInstance !== 'undefined' ? cardCacheInstance.getOwnedNamesSet() : new Set();
    const ownedNumbers = typeof cardCacheInstance !== 'undefined' ? cardCacheInstance.getOwnedNumbersSet() : new Set();

    // 1. 이름 검색 매칭
    let matches = [];
    if (hasGlobal) {
        for (let i = 0; i < CardDataStore.allCardNamesNormalized.length; i++) {
            const item = CardDataStore.allCardNamesNormalized[i];
            if (matchKorean(item, query)) {
                matches.push({ 
                    type: 'name', 
                    val: item.original, 
                    normalized: item.normalized,
                    isOwned: ownedNames.has(item.original)
                });
                if (matches.length >= 100) break;
            }
        }
    } else if (typeof cardCacheInstance !== 'undefined') {
        const localNamesNormalized = cardCacheInstance.getAllNamesNormalized();
        for (let i = 0; i < localNamesNormalized.length; i++) {
            const item = localNamesNormalized[i];
            if (ownedNames.has(item.original)) {
                if (matchKorean(item, query)) {
                    matches.push({ 
                        type: 'name', 
                        val: item.original, 
                        normalized: item.normalized,
                        isOwned: true
                    });
                    if (matches.length >= 100) break;
                }
            }
        }
    }

    // 2. 카드 번호 검색 매칭
    let numberMatches = [];
    const searchNumberPool = (hasGlobal && typeof CardDataStore.allCardNumbers !== 'undefined') ? CardDataStore.allCardNumbers : (typeof cardCacheInstance !== 'undefined' ? cardCacheInstance.getOwnedNumbers() : []);
    for (let i = 0; i < searchNumberPool.length; i++) {
        const no = String(searchNumberPool[i]);
        const lowerNo = no.toLowerCase();
        if (lowerNo.includes(query)) {
            numberMatches.push({ 
                type: 'number', 
                val: no, 
                normalized: lowerNo,
                isOwned: ownedNumbers.has(no)
            });
            if (numberMatches.length >= 50) break;
        }
    }

    // 3. 통합 매칭 배열 생성
    const combinedMatches = [...matches, ...numberMatches];

    // 4. 정렬 로직 (보유 여부 최우선 정렬 후, 이름/번호 통합 정렬)
    combinedMatches.sort((a, b) => {
        if (a.isOwned !== b.isOwned) {
            return a.isOwned ? -1 : 1;
        }
        
        const normVal = query;
        const normA = a.normalized;
        const normB = b.normalized;
        if (normA === normVal) return -1;
        if (normB === normVal) return 1;

        const aStarts = normA.startsWith(normVal) || (a.type === 'name' && matchKorean(a, normVal));
        const bStarts = normB.startsWith(normVal) || (b.type === 'name' && matchKorean(b, normVal));

        if (aStarts && !bStarts) return -1;
        if (!aStarts && bStarts) return 1;
        return a.val.length - b.val.length || a.val.localeCompare(b.val);
    });

    list.innerHTML = '';

    // 맞춤 검색 버튼 2개 추가
    const btnRow = document.createElement('li');
    btnRow.className = 'dropdown-search-btn-row';

    const nameBtn = document.createElement('button');
    nameBtn.type = 'button';
    nameBtn.className = 'dropdown-search-btn';
    nameBtn.textContent = `"${val}"을 이름으로 검색`;
    nameBtn.addEventListener('click', (e) => {
        if (isMobile) executeMobileSearchWithOption(e, 'name');
        else startSearchWithOption(e, 'name');
    });

    const noBtn = document.createElement('button');
    noBtn.type = 'button';
    noBtn.className = 'dropdown-search-btn';
    noBtn.textContent = `"${val}"을 번호로 검색`;
    noBtn.addEventListener('click', (e) => {
        if (isMobile) executeMobileSearchWithOption(e, 'number');
        else startSearchWithOption(e, 'number');
    });

    btnRow.appendChild(nameBtn);
    btnRow.appendChild(noBtn);

    const recent = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    if (isMobile) {
        appendMobileRecentHistory(list, recent);
    }

    list.appendChild(btnRow);

    if (combinedMatches.length === 0) {
        const noResult = document.createElement('li');
        noResult.className = 'no-result-item';
        noResult.innerText = '등록되지 않은 카드';
        list.appendChild(noResult);
        list.classList.add('active');
        if (!isMobile) {
            list.style.display = 'block';
            toggleSearchWrapper(true);
        }
        return;
    }

    combinedMatches.slice(0, 10).forEach(m => {
        const li = document.createElement('li');
        li.className = 'text-suggest';
        if (!m.isOwned) {
            li.classList.add('not-owned');
        }
        li.dataset.val = m.val;
        li.dataset.type = m.type;
        li.dataset.isTarget = 'true';

        let html = "";
        const escapedVal = escapeHTML(m.val);
        const escapedQuery = escapeHTML(val);
        if (m.type === 'name') {
            let range = null;
            if (typeof Hangul !== 'undefined' && typeof Hangul.rangeSearch === 'function') {
                try { range = Hangul.rangeSearch(escapedVal, escapedQuery); } catch(e){}
            }
            if (range && range.length > 0) {
                const start = range[0][0];
                const end = range[0][1] + 1;
                html = escapedVal.substring(0, start) +
                    `<span class="text-match">${escapedVal.substring(start, end)}</span>` +
                    escapedVal.substring(end);
            } else {
                html = escapedVal;
            }
            html = `<span class="name-badge">[이름]</span>${html}`;
        } else {
            const idx = escapedVal.toLowerCase().indexOf(escapedQuery.toLowerCase());
            if (idx !== -1) {
                const len = escapedQuery.length;
                html = escapedVal.substring(0, idx) +
                    `<span class="text-match">${escapedVal.substring(idx, idx + len)}</span>` +
                    escapedVal.substring(idx + len);
            } else {
                html = escapedVal;
            }
            const cardName = getCardNameByNumber(m.val);
            const subHtml = cardName ? `<span class="no-card-name-sub">${escapeHTML(cardName)}</span>` : '';
            html = `<span class="no-badge">[번호]</span>${html}${subHtml}`;
        }

        li.innerHTML = html;
        if (isMobile) {
            li.addEventListener('click', () => {
                executeMobileSearch(m.val, m.type, true);
            });
        }
        list.appendChild(li);
    });
    list.classList.add('active');
    if (!isMobile) {
        list.style.display = 'block';
        toggleSearchWrapper(true);
    }
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
function updateDisconnectBtn() { const btn = document.getElementById('disconnect-btn'); if (btn) { if (localStorage.getItem(STORAGE_KEY)) { btn.classList.remove('disabled'); } else { btn.classList.add('disabled'); } } }

function handleHelpClick() {
    if (typeof UIStore.mode !== 'undefined' && UIStore.mode === 'home') {
        if (typeof OnboardingManager !== 'undefined') {
            OnboardingManager.start('home', true);
        }
    } else {
        switchToMode('settings');
        toggleGuide(true);
    }
}

function toggleGuide(forceOpen = null) { const btn = document.getElementById('guide-accordion-btn'); const box = document.getElementById('guide-box'); const isOpen = (forceOpen !== null) ? forceOpen : box.style.display === 'none'; box.style.display = isOpen ? 'block' : 'none'; if (isOpen) btn.classList.add('active'); else btn.classList.remove('active'); }
/**
 * 사용자 설정을 저장 (DB + LocalStorage)
 */
async function saveUserSetting(field, value) {
    UserStore.settings[field] = value;

    // 로컬 스토리지 호환성 유지
    if (field === 'theme') {
        localStorage.setItem(THEME_KEY, value);
    } else if (field === 'isDetailMode') {
        localStorage.setItem(IS_DETAIL_MODE_KEY, value ? 'true' : 'false');
    }

    // 로그인 상태라면 DB 동기화
    if (UserStore.user) {
        try {
            const settings = {};
            settings[field] = value;
            // 2번째 인자는 URL 쿼리(params), 3번째 인자가 POST 본문(postData)입니다.
            await callApi('updateUserSettings', {}, { settings });
        } catch (e) {
            console.error("Settings sync failed:", e);
        }
    }
}

/**
 * 저장된 설정을 로드하여 UI에 적용
 */
function loadUserSettings(settingsFromServer) {
    // 1. 초기값 설정 (DB 우선, 없으면 LocalStorage)
    const savedTheme = (settingsFromServer && settingsFromServer.theme) || localStorage.getItem(THEME_KEY) || 'light';
    const savedDetailMode = (settingsFromServer && settingsFromServer.isDetailMode !== undefined)
        ? settingsFromServer.isDetailMode
        : (localStorage.getItem(IS_DETAIL_MODE_KEY) === 'true');

    UserStore.settings.theme = savedTheme;
    UserStore.settings.isDetailMode = savedDetailMode;

    // 온보딩 정보 동기화 (DB -> LocalStorage)
    if (settingsFromServer && settingsFromServer.onboarding) {
        const localOnboarding = JSON.parse(localStorage.getItem('ygo_onboarding_done') || '{}');
        const mergedOnboarding = { ...localOnboarding, ...settingsFromServer.onboarding };
        localStorage.setItem('ygo_onboarding_done', JSON.stringify(mergedOnboarding));
    }

    // 공지사항 읽음 정보 동기화 (DB -> LocalStorage)
    if (settingsFromServer && Array.isArray(settingsFromServer.readNotices)) {
        let localNotices = JSON.parse(localStorage.getItem('ygo_synapse_read_notices') || '[]');
        let mergedNotices = [...new Set([...localNotices, ...settingsFromServer.readNotices])];
        localStorage.setItem('ygo_synapse_read_notices', JSON.stringify(mergedNotices));
    }

    // 2. 테마 적용
    if (savedTheme === 'dark') {
        document.documentElement.classList.add('dark-mode');
        const chk = document.getElementById('checkbox-theme');
        if (chk) chk.checked = true;
        updateMetaThemeColor('dark');
    } else {
        document.documentElement.classList.remove('dark-mode');
        const chk = document.getElementById('checkbox-theme');
        if (chk) chk.checked = false;
        updateMetaThemeColor('light');
    }
}

/**
 * 모달 상세/요약 토글 핸들러
 */
function handleToggleDetail() {
    const nextMode = !UserStore.settings.isDetailMode;
    saveUserSetting('isDetailMode', nextMode);
    applyModalDetailUI(nextMode);
}

/**
 * 현재 열린 모달에 상세/요약 UI 반영 (페이드인 지원)
 */
function applyModalDetailUI(isDetail) {
    const activeModal = document.querySelector('.modal.open');
    if (!activeModal) return;

    const summaryBox = activeModal.querySelector('.js-summary-box');
    const detailBox = activeModal.querySelector('.js-detail-box');
    const toggleBtn = activeModal.querySelector('.js-modal-detail-toggle');

    if (!summaryBox || !detailBox) return;

    // 공통 애니메이션 클래스 제거 (재발동을 위해)
    summaryBox.classList.remove('fade-in');
    detailBox.classList.remove('fade-in');

    if (isDetail) {
        summaryBox.style.display = 'none';
        detailBox.style.display = 'block';
        detailBox.classList.add('fade-in');
        if (toggleBtn) toggleBtn.innerText = '간략히 보기';
    } else {
        summaryBox.style.display = 'block';
        detailBox.style.display = 'none';
        summaryBox.classList.add('fade-in');
        if (toggleBtn) toggleBtn.innerText = '자세히 보기';
    }
}

function loadTheme() { loadUserSettings(); }
function toggleTheme() {
    document.documentElement.classList.add('theme-transitioning');
    const isDark = document.getElementById('checkbox-theme').checked;

    // [Fix] requestAnimationFrame을 사용하여 브라우저의 렌더링 프레임을 강제로 분리:
    // 확실하게 theme-transitioning 규칙이 적용된 프레임 이후에 다크모드 속성을 칠하도록 하여
    // transition 엔진이 누락되는 현상을 100% 방지합니다.
    requestAnimationFrame(() => {
        if (isDark) {
            document.documentElement.classList.add('dark-mode');
            saveUserSetting('theme', 'dark');
            updateMetaThemeColor('dark');
        } else {
            document.documentElement.classList.remove('dark-mode');
            saveUserSetting('theme', 'light');
            updateMetaThemeColor('light');
        }
    });

    setTimeout(() => {
        document.documentElement.classList.remove('theme-transitioning');
    }, 350); // 안전 마진 50ms 추가
}
const regionMap = { 'ko': '한국', 'ja': '일본', 'ae': '아시아', 'cn': '중국', 'en': '영미', 'de': '독일', 'fr': '프랑스', 'it': '이탈리아', 'es': '스페인', 'pt': '포르투갈' };
function loadRegion() { const savedRegion = localStorage.getItem(REGION_KEY) || 'ko'; UIStore.currentRegion = savedRegion; document.getElementById('region-text').innerText = regionMap[savedRegion]; document.documentElement.setAttribute('data-region', savedRegion); }
// 모든 드롭다운 닫기 (현재는 지역 설정만 및 검색바 등)
function closeDropdowns() {
    // 지역 설정 닫기
    const regionWrapper = document.getElementById('region-wrapper');
    if (regionWrapper && regionWrapper.classList.contains('active')) {
        regionWrapper.classList.remove('active');
        // 높이 변수 초기화 (애니메이션 종료 후 자연스럽게 무시되지만 명시적 초기화)
        regionWrapper.style.setProperty('--region-dropdown-height', '0px');
    }

    // 필요 시 다른 드롭다운 닫기 로직 추가
}

// 지역 설정 드롭다운 토글 (물리적 확장 애니메이션 적용)
function toggleRegionDropdown(event) {
    event.stopPropagation();
    const wrapper = document.getElementById('region-wrapper');
    const dropdown = document.getElementById('region-dropdown');

    // 이미 열려있는지 확인
    const isActive = wrapper.classList.contains('active');

    // 모든 드롭다운 닫기 (자신 포함)
    closeDropdowns();

    if (!isActive) {
        wrapper.classList.add('active');

        // 높이 계산 및 애니메이션 시작
        requestAnimationFrame(() => {
            const scrollHeight = dropdown.scrollHeight;
            // 드롭다운의 실제 높이만큼 배경 확장
            wrapper.style.setProperty('--region-dropdown-height', scrollHeight + 'px');
        });
    }
}

let lastSearchState = null;

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

    // 포괄 검색 뱃지 갱신
    const broadLabels = resultArea.querySelectorAll('.broad-type-label');
    broadLabels.forEach(lbl => {
        const text = lbl.textContent.trim();
        if (text === "몬스터" || text === "モンスター" || text === "Monster") {
            lbl.textContent = DECODE_KIND[0] || "몬스터";
        } else if (text === "마법" || text === "魔法" || text === "Spell" || text === "Magic") {
            lbl.textContent = DECODE_KIND[1] || "마법";
        } else if (text === "함정" || text === "罠" || text === "Trap") {
            lbl.textContent = DECODE_KIND[2] || "함정";
        }
    });

    // 대상 카드 뷰 테이블 갱신 (속성/종족)
    const monsterTable = resultArea.querySelector('.target-info-table.monster-table');
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
        if (ClientCache._nameToCid) {
            for (const k in ClientCache._nameToCid) {
                if (String(ClientCache._nameToCid[k]) === String(targetCid)) {
                    relatedNames.add(k);
                }
            }
        }
    }

    const normRelatedSet = new Set([...relatedNames].map(n => normalizeStr(n)));

    let rows = cardCacheInstance.getInventory().filter(row => {
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
                if (updatedTargetRows.length === 0 && lastSearchState.targetRows) {
                    updatedTargetRows = lastSearchState.targetRows;
                }

                renderTargetSearchResult(
                    targetCardName,
                    updatedTargetRows,
                    prioritizeNumber,
                    null,
                    targetCid
                );
            } else if (lastSearchState.type === 'broad') {
                renderBroadSearchResults(
                    lastSearchState.nameRows,
                    lastSearchState.numberRows,
                    lastSearchState.searchType
                );
            }
        } else {
            const inputEl = document.getElementById('card-search');
            if (inputEl && inputEl.value.trim()) {
                startSearch(true);
            }
        }
    }
}

function updateTooltipsOnly() {
    const headers = document.querySelectorAll('th.sp-col.tooltipped');
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

        newTooltip = String(newTooltip).replace(/\(/g, '<br>(');
        th.setAttribute('data-tooltip', newTooltip);
    });

    const resultArea = document.getElementById('result-area');
    if (resultArea) {
        M.Tooltip.init(resultArea.querySelectorAll('.tooltipped'), { html: true, margin: 3 });
    }
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

async function callApi(action, params = {}, postData = null) {
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

    // 최신 Firebase ID Token을 즉시 가져와 Authorization 헤더에 설정 (오래된 캐시 토큰으로 인한 403 거부 방지)
    if (UserStore.user) {
        try {
            const token = await UserStore.user.getIdToken();
            _cachedAuthToken = token;
            options.headers['Authorization'] = `Bearer ${token}`;
        } catch (authErr) {
            console.error("Auth token fetch failed:", authErr);
        }
    }

    if (location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
        if (_cachedAppCheckToken) {
            options.headers['X-Firebase-AppCheck'] = _cachedAppCheckToken;
        } else if (typeof firebase !== 'undefined' && firebase.appCheck) {
            // 캐시 미스 폴백
            try {
                const appCheckTokenResponse = await firebase.appCheck().getToken();
                _cachedAppCheckToken = appCheckTokenResponse.token;
                options.headers['X-Firebase-AppCheck'] = _cachedAppCheckToken;
            } catch (err) {
                console.warn("Failed to get App Check token:", err);
            }
        }
    }

    if (postData) {
        // POST 요청 시 ssId를 본문에 포함
        const body = {
            ...postData,
            ssId: savedId
        };
        options.body = JSON.stringify(body);
    }

    try {
        const response = await fetch(url.toString(), options);
        if (!response.ok) {
            const errBody = await response.json().catch(() => ({}));
            console.error(`[API Error Details] Action: ${action}, Status: ${response.status}`, errBody);
            const detailMsg = errBody.message || errBody.name || (Object.keys(errBody).length ? JSON.stringify(errBody) : "");
            throw new Error(detailMsg ? `HTTP ${response.status}: ${detailMsg}` : `HTTP error! status: ${response.status}`);
        }

        const res = await response.json();

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
    if (!UserStore.isInitialSyncDone || document.hidden) return;
    if (_publicRefreshPromise) return _publicRefreshPromise;
    if (Date.now() - _lastPublicRefreshAt < 60000) return;
    _publicRefreshPromise = (async () => {
        const res = await callApi('getInitialData', {
            rarityUpdatedAt: localStorage.getItem('rarityUpdatedAt') || '0',
            packUpdatedAt: localStorage.getItem('packUpdatedAt') || '0',
            cardListUpdatedAt: localStorage.getItem('cardListUpdatedAt') || '0'
        });
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

        const localRarityUpdate = parseInt(localStorage.getItem('rarityUpdatedAt') || '0');
        const localPackUpdate = parseInt(localStorage.getItem('packUpdatedAt') || '0');
        const localCardListUpdate = parseInt(localStorage.getItem('cardListUpdatedAt') || '0');

        // [스마트 온디맨드 웜업] getInitialData와 동시에 getCardMetadata 컨테이너를 선제 깨우기
        // → 사용자가 UI를 보는 사이 백엔드 RAM 캐시(_fullMetaMemoryMap)가 백그라운드에서 완성됨
        callApi('getCardMetadata', { warmup: 'true' }).catch(() => {});

        const res = await callApi('getInitialData', {
            rarityUpdatedAt: localRarityUpdate,
            packUpdatedAt: localPackUpdate,
            cardListUpdatedAt: localCardListUpdate
        }, {
            lastUpdated: lastSync
        });

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

async function startSearch(isInstant = false, searchType = 'auto', forcedIsTarget = null) {
    // [AD] 검색 시 결과 하단 광고 갱신
    if (typeof refreshAdUnit === 'function') refreshAdUnit('search-result-ad');

    const inputEl = document.getElementById('card-search');
    if (!inputEl) return;
    const name = inputEl.value.trim();
    if (!name) return;
    await refreshPublicDataQuietly();

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

        const targetCid = fetchedCid || findCidByNameOrNo(targetCardName, prioritizeNumber);
        updateSearchHash('target', { cid: targetCid, code: prioritizeNumber }, true);

        // CID 기반 다국어 보유 카드 수집 및 언어권 상단 정렬
        let targetRows = getInventoryRowsByCidOrName(targetCid, targetCardName, prioritizeNumber);

        // animateVerticalExpand의 old 접기 애니메이션(0.4s)과 API 호출을 병렬 실행 — Safari 딜레이 해소
        const metaPromise = fetchCardMetaWithCache(targetCid, targetCardName);

        const renderTargetFunc = async (mountContainer) => {
            await renderTargetSearchResult(targetCardName, targetRows, prioritizeNumber, mountContainer, targetCid, metaPromise);
        };

        if (UIStore.mode === 'search') {
            if (isInstant) { await renderTargetFunc(); return; }
            await animateVerticalExpand(renderTargetFunc);
        } else {
            await renderTargetFunc();
            switchToMode('search', isInstant);
        }

    } else {
        // [포괄 검색]
        updateSearchHash('broad', { searchType, key: name }, true);

        let nameRows = [];
        let numberRows = [];

        // 이름 검색 수행 (searchType !== 'number')
        if (searchType !== 'number') {
            let targetNames = new Set();
            const useGlobal = typeof CardDataStore.allCardNames !== 'undefined' && CardDataStore.allCardNames.length > 0;
            let matchedNames = [];
            if (useGlobal) {
                matchedNames = CardDataStore.allCardNamesNormalized
                    .filter(item => Hangul.search(item.normalized, queryNorm) !== -1)
                    .map(item => item.original);
            } else if (typeof cardCacheInstance !== 'undefined') {
                const ownedNames = new Set(cardCacheInstance.getInventory().filter(r => (parseInt(r[3]) || 0) > 0).map(r => String(r[0])));
                const localNames = cardCacheInstance.getAllNames().filter(n => ownedNames.has(n));
                matchedNames = localNames
                    .map(n => ({ original: n, normalized: n.replace(/\s+/g, '').toLowerCase() }))
                    .filter(item => Hangul.search(item.normalized, queryNorm) !== -1)
                    .map(item => item.original);
            }
            matchedNames.forEach(n => targetNames.add(n));

            if (targetNames.size === 0) {
                try {
                    const searchRes = await callApi('searchCard', { query: name });
                    if (searchRes && searchRes.success && Array.isArray(searchRes.names)) {
                        searchRes.names.forEach(n => targetNames.add(n));
                    }
                } catch (searchErr) {
                    console.warn('[Search] 백엔드 검색 API 호출 실패, 입력값만으로 검색:', searchErr.message);
                    targetNames.add(name);
                }
            }
            nameRows = typeof cardCacheInstance !== 'undefined' ? cardCacheInstance.getInventory().filter(row => targetNames.has(String(row[0]))) : [];
        }

        // 번호 검색 수행 (searchType !== 'name')
        if (searchType !== 'name') {
            const queryLower = name.toLowerCase();
            numberRows = typeof cardCacheInstance !== 'undefined' ? cardCacheInstance.getInventory().filter(row => String(row[1]).toLowerCase().includes(queryLower)) : [];
        }

        const renderBroadFunc = (mountContainer) => {
            renderBroadSearchResults(nameRows, numberRows, searchType, mountContainer);
        };

        if (UIStore.mode === 'search') {
            if (isInstant) { renderBroadFunc(); return; }
            animateVerticalExpand(renderBroadFunc);
        } else {
            renderBroadFunc();
            switchToMode('search', isInstant);
        }
    }

    document.getElementById('custom-dropdown').style.display = 'none';
    toggleSearchWrapper(false);
    checkClearBtn();
    showLoading(false);
}

// 1. 포괄 검색 리스트 항목 클릭 ➔ 대상 검색 전용 좌우 슬라이드 밀어내기 애니메이션
function animatePushSlide(renderFunc) {
    const resultArea = document.getElementById('result-area');
    if (!resultArea) { renderFunc(); return; }

    const parentContainer = resultArea.parentNode || document.getElementById('result-content-wrapper');
    if (!parentContainer) { renderFunc(); return; }

    // [핵심] 상/하 마진(30px + 30px = 60px) 오프셋 측정
    const resStyle = getComputedStyle(resultArea);
    const marginOffset = (parseFloat(resStyle.marginTop) || 0) + (parseFloat(resStyle.marginBottom) || 0);

    const oldHeight = resultArea.offsetHeight > 0 ? (resultArea.offsetHeight + marginOffset) : 0;

    parentContainer.classList.add('slide-push-container');

    // 1. 기존 화면 복제
    const ghost = resultArea.cloneNode(true);
    ghost.id = 'result-ghost';
    ghost.className = 'slide-push-ghost-exit';
    ghost.style.top = '0px';
    parentContainer.appendChild(ghost);

    // 2. 새 대상 검색 화면 렌더링
    renderFunc();

    // 3. 목표 높이(newHeight + marginOffset) 측정 및 부모 컨테이너 연속 높이 준비
    resultArea.classList.remove('slide-push-area-enter', 'active');
    resultArea.style.transition = 'none';
    resultArea.style.position = 'relative';
    let curContentHeight = resultArea.scrollHeight || resultArea.offsetHeight;
    let newHeight = curContentHeight > 0 ? (curContentHeight + marginOffset) : 0;
    resultArea.style.position = '';

    resultArea.classList.add('slide-push-area-enter');

    let isTransitionStarted = false;

    if (oldHeight > 0 && newHeight > 0) {
        parentContainer.style.transition = 'none';
        parentContainer.style.height = oldHeight + 'px';
    }

    void resultArea.offsetHeight;

    // 4. ResizeObserver 부착: 20ms 트랜지션 시작 후 resultArea 내부 비동기 카드 데이터 수신으로 높이가 늘어나면 즉시 부모 높이 실시간 반영!
    let slideResizeObserver = null;
    if (typeof ResizeObserver !== 'undefined') {
        slideResizeObserver = new ResizeObserver(() => {
            let liveContentHeight = resultArea.scrollHeight || resultArea.offsetHeight;
            if (resultArea.children.length > 0) {
                let childrenHeightSum = 0;
                for (let i = 0; i < resultArea.children.length; i++) {
                    childrenHeightSum += resultArea.children[i].scrollHeight || resultArea.children[i].offsetHeight;
                }
                if (childrenHeightSum > liveContentHeight) liveContentHeight = childrenHeightSum;
            }

            if (liveContentHeight > 0) {
                const liveTotal = liveContentHeight + marginOffset;
                if (liveTotal !== newHeight) {
                    newHeight = liveTotal;
                    if (isTransitionStarted && oldHeight > 0) {
                        parentContainer.style.height = newHeight + 'px';
                    }
                }
            }
        });
        slideResizeObserver.observe(resultArea);
        for (let i = 0; i < resultArea.children.length; i++) {
            slideResizeObserver.observe(resultArea.children[i]);
        }
    }

    // 5. 동시 트랜지션 시작 (마진 포함 oldHeight ➔ newHeight 연속 높이 변형)
    setTimeout(() => {
        isTransitionStarted = true;
        resultArea.style.transition = '';
        if (oldHeight > 0 && newHeight > 0) {
            parentContainer.style.transition = 'height 0.4s cubic-bezier(0.25, 1, 0.5, 1)';
            parentContainer.style.height = newHeight + 'px';
        }
        ghost.classList.add('active');
        resultArea.classList.add('active');
    }, 20);

    // 6. 완료 후 ResizeObserver 해제, 수동 고정 해제 및 정규 흐름 원복
    setTimeout(() => {
        if (slideResizeObserver) {
            slideResizeObserver.disconnect();
            slideResizeObserver = null;
        }

        if (ghost.parentNode) ghost.parentNode.removeChild(ghost);
        resultArea.classList.remove('slide-push-area-enter', 'active');
        resultArea.style.transition = '';
        parentContainer.classList.remove('slide-push-container');
        parentContainer.style.transition = '';
        parentContainer.style.height = '';
    }, 420);
}

// 2. 상단 검색바를 통한 새로운 검색 전용 수직 높이 펼침 애니메이션 (Y축 높이 보존 1:1 대칭 밀어내기)
async function animateVerticalExpand(renderFunc) {
    const resultArea = document.getElementById('result-area');
    if (!resultArea) { if (renderFunc) await renderFunc(); return; }

    const parentContainer = resultArea.parentNode || document.getElementById('result-content-wrapper');
    if (!parentContainer) { if (renderFunc) await renderFunc(); return; }

    const resStyle = getComputedStyle(resultArea);
    const marginOffset = (parseFloat(resStyle.marginTop) || 0) + (parseFloat(resStyle.marginBottom) || 0);

    const oldHeight = resultArea.offsetHeight;
    const oldTotalHeight = oldHeight > 0 ? (oldHeight + marginOffset) : 0;

    // 1. [OLD 컨테이너] 기존 검색 결과를 old-search-container로 감싸기
    const oldContainer = document.createElement('div');
    oldContainer.className = 'old-search-container';
    if (oldHeight > 0) {
        oldContainer.style.maxHeight = oldHeight + 'px';
    }

    while (resultArea.firstChild) {
        oldContainer.appendChild(resultArea.firstChild);
    }
    resultArea.appendChild(oldContainer);

    // 2. [NEW 컨테이너] 새 결과를 담을 독립적인 new-search-container 생성 (oldContainer보다 Y축 상단 위치!)
    const newContainer = document.createElement('div');
    newContainer.className = 'new-search-container';
    newContainer.style.visibility = 'hidden';
    resultArea.insertBefore(newContainer, oldContainer);

    // 새 결과 화면 렌더링 (Target & Inventory 100% 완성!)
    if (renderFunc) {
        await renderFunc(newContainer);
    }

    // 3. newContainer 목표 높이 측정
    newContainer.style.transition = 'none';
    newContainer.style.maxHeight = 'none';
    let newHeight = newContainer.offsetHeight;
    let newTotalHeight = newHeight > 0 ? (newHeight + marginOffset) : 0;

    newContainer.style.maxHeight = '0px';
    newContainer.style.visibility = ''; // 높이가 0px로 세팅된 후 보이기 복원

    if (oldTotalHeight > 0 && newTotalHeight > 0) {
        parentContainer.style.transition = 'none';
        parentContainer.style.height = oldTotalHeight + 'px';
    }

    void oldContainer.offsetHeight;
    void newContainer.offsetHeight;

    // 4. ResizeObserver 부착: 애니메이션 도중 newContainer 내부 비동기 렌더링으로 높이가 변하더라도 실시간 목표 높이 갱신!
    let resizeObserver = null;
    if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(() => {
            const liveHeight = newContainer.scrollHeight || newContainer.offsetHeight;
            if (liveHeight > 0 && liveHeight !== newHeight) {
                newHeight = liveHeight;
                newTotalHeight = newHeight + marginOffset;
                newContainer.style.maxHeight = newHeight + 'px';
                if (oldTotalHeight > 0) {
                    parentContainer.style.height = newTotalHeight + 'px';
                }
            }
        });
        resizeObserver.observe(newContainer);
    }

    // 5. 이중 컨테이너 동시 트랜지션 (old 0.4초 축소 + new 0.4초 팽창 등장!)
    setTimeout(() => {
        if (oldTotalHeight > 0 && newTotalHeight > 0) {
            parentContainer.style.transition = 'height 0.4s cubic-bezier(0.4, 0, 0.2, 1)';
            parentContainer.style.height = newTotalHeight + 'px';
        }

        oldContainer.style.transition = 'max-height 0.4s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.4s ease';
        oldContainer.style.maxHeight = '0px';
        oldContainer.classList.add('collapse-active');

        newContainer.style.transition = 'max-height 0.4s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.4s ease';
        newContainer.style.maxHeight = newHeight + 'px';
        newContainer.classList.add('expand-active');
    }, 20);

    // 6. 완료 후 ResizeObserver 해제, oldContainer 제거 및 newContainer 정상 원복
    setTimeout(() => {
        if (resizeObserver) {
            resizeObserver.disconnect();
            resizeObserver = null;
        }

        if (oldContainer.parentNode) oldContainer.parentNode.removeChild(oldContainer);

        while (newContainer.firstChild) {
            resultArea.appendChild(newContainer.firstChild);
        }
        if (newContainer.parentNode) newContainer.parentNode.removeChild(newContainer);

        resultArea.style.transition = '';
        resultArea.style.maxHeight = '';
        parentContainer.style.transition = '';
        parentContainer.style.height = '';
    }, 420);
}

const DECODE_KIND = { 0: "몬스터", 1: "마법", 2: "함정" };

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
    if (cardMeta.info) {
        const langArr = extractLangData(cardMeta);
        if (langArr && Array.isArray(langArr) && langArr[1]) {
            return langArr[1];
        }
    }
    return null;
}

function getCardMetaType(cardName, cardNo = null) {
    if (!cardName && !cardNo) return { kind: 0, kindStr: "몬스터" };
    const cid = findCidByNameOrNo(cardName, cardNo);
    if (cid && typeof cidMetaMemoryCache !== 'undefined' && cidMetaMemoryCache.has(String(cid))) {
        return parseMetaKind(cidMetaMemoryCache.get(String(cid)));
    }
    if (typeof cardCacheInstance !== 'undefined' && cardCacheInstance._mergedMeta && cardCacheInstance._mergedMeta[cardName]) {
        return parseMetaKind(cardCacheInstance._mergedMeta[cardName]);
    }
    return { kind: 0, kindStr: "몬스터" };
}

function renderBroadSearchResults(nameRows, numberRows, searchType, mountContainer = null) {
    if (!mountContainer) {
        lastSearchState = { type: 'broad', nameRows, numberRows, searchType };
        const inputEl = document.getElementById('card-search');
        const key = inputEl ? inputEl.value.trim() : '';
        if (key) {
            updateSearchHash('broad', { searchType, key });
        }
    }
    const resultArea = mountContainer || document.getElementById('result-area');
    resultArea.innerHTML = '';

    const showName = (searchType !== 'number') && nameRows.length > 0;
    const showNumber = (searchType !== 'name') && numberRows.length > 0;

    if (!showName && !showNumber) {
        resultArea.innerHTML = "<p class='center' style='padding: 40px 0;'>검색 결과가 없습니다.</p>";
        return;
    }

    let nameSec = null, numSec = null;
    let nameGroups = {}, numberGroups = {};

    // 1. 이름 검색 결과 구역
    if (showName) {
        nameRows.forEach(r => {
            const cardName = String(r[0] || "이름 없음").trim();
            if (!nameGroups[cardName]) nameGroups[cardName] = 0;
            nameGroups[cardName] += (parseInt(r[3]) || 0);
        });

        const nameKeys = Object.keys(nameGroups);

        nameSec = document.createElement('div');
        nameSec.className = 'search-result-section';
        nameSec.innerHTML = `<div class="search-section-header"><i class="material-icons">font_download</i>이름 검색 결과 (${nameKeys.length})</div><div class="broad-search-list"></div>`;
        resultArea.appendChild(nameSec);

        const listContainer = nameSec.querySelector('.broad-search-list');
        nameKeys.forEach(cardName => {
            const totalQty = nameGroups[cardName];
            const metaType = getCardMetaType(cardName);
            const rowEl = document.createElement('div');
            rowEl.className = 'broad-search-row';
            rowEl.innerHTML = `
                <div class="broad-search-left">${escapeHTML(cardName)}</div>
                <div class="broad-search-right">
                    <span class="broad-type-label broad-type-${metaType.kind}">${metaType.kindStr}</span>
                    <span class="broad-divider">|</span>
                    <span>${totalQty}장</span>
                </div>
            `;
            rowEl.addEventListener('click', () => {
                const searchInput = document.getElementById('card-search');
                if (searchInput) searchInput.value = cardName;

                const targetNorm = normalizeStr(cardName);
                const targetRows = typeof cardCacheInstance !== 'undefined' ? cardCacheInstance.getInventory().filter(row => normalizeStr(String(row[0])) === targetNorm) : [];
                saveRecentSearch(cardName, 'name', true);

                const cid = findCidByNameOrNo(cardName);
                updateSearchHash('target', { cid: cid, code: null });

                // 클릭과 동시에 API 선제 호출 시작 — 애니메이션 병렬화로 Safari 파일디레이 해소
                const metaPromise = fetchCardMetaWithCache(cid, cardName);

                animatePushSlide(() => {
                    renderTargetSearchResult(cardName, targetRows, null, null, cid, metaPromise);
                });
            });
            listContainer.appendChild(rowEl);
        });
    }

    // 2. 번호 검색 결과 구역
    if (showNumber) {
        numberRows.forEach(r => {
            const cardNo = String(r[1] || "").trim();
            const cardName = String(r[0] || "").trim();
            const qty = parseInt(r[3]) || 0;
            if (!numberGroups[cardNo]) {
                numberGroups[cardNo] = { name: cardName, total: 0 };
            }
            numberGroups[cardNo].total += qty;
        });

        const numberKeys = Object.keys(numberGroups);

        numSec = document.createElement('div');
        numSec.className = 'search-result-section';
        numSec.innerHTML = `<div class="search-section-header"><i class="material-icons">numbers</i>번호 검색 결과 (${numberKeys.length})</div><div class="broad-search-list"></div>`;
        resultArea.appendChild(numSec);

        const listContainer = numSec.querySelector('.broad-search-list');
        numberKeys.forEach(cardNo => {
            const item = numberGroups[cardNo];
            const cardName = item.name || getCardNameByNumber(cardNo);
            const subNameHtml = cardName ? `<span class="broad-card-name-sub">${escapeHTML(cardName)}</span>` : '';
            const metaType = getCardMetaType(cardName, cardNo);

            const rowEl = document.createElement('div');
            rowEl.className = 'broad-search-row';
            rowEl.innerHTML = `
                <div class="broad-search-left">
                    <span>${escapeHTML(cardNo)}</span>
                    ${subNameHtml}
                </div>
                <div class="broad-search-right">
                    <span class="broad-type-label broad-type-${metaType.kind}">${metaType.kindStr}</span>
                    <span class="broad-divider">|</span>
                    <span>${item.total}장</span>
                </div>
            `;
            rowEl.addEventListener('click', () => {
                const searchInput = document.getElementById('card-search');
                if (searchInput) searchInput.value = cardNo;

                const targetCardName = cardName || cardNo;
                const targetNorm = normalizeStr(targetCardName);
                let targetRows = typeof cardCacheInstance !== 'undefined' ? cardCacheInstance.getInventory().filter(row => normalizeStr(String(row[0])) === targetNorm) : [];

                if (cardNo && targetRows.length > 0) {
                    const prioNorm = normalizeStr(cardNo);
                    targetRows.sort((a, b) => {
                        const aMatch = normalizeStr(String(a[1])) === prioNorm ? -1 : 1;
                        const bMatch = normalizeStr(String(b[1])) === prioNorm ? -1 : 1;
                        return aMatch - bMatch;
                    });
                }
                saveRecentSearch(cardNo, 'number', true);

                const cid = findCidByNameOrNo(targetCardName, cardNo);
                updateSearchHash('target', { cid: cid, code: cardNo });

                // 클릭과 동시에 API 선제 호출 시작 — 애니메이션 병렬화로 Safari 파일디레이 해소
                const metaPromise = fetchCardMetaWithCache(cid, targetCardName);

                animatePushSlide(() => {
                    renderTargetSearchResult(targetCardName, targetRows, cardNo, null, cid, metaPromise);
                });
            });
            listContainer.appendChild(rowEl);
        });
    }

    // 3. 포괄 검색 목록 전체 CID 수집 후 배치(Batch) 메타데이터 1회 연동 및 라벨 일괄 갱신
    const allCidsToFetch = [];
    if (showName) {
        Object.keys(nameGroups).forEach(nameKey => {
            const cid = findCidByNameOrNo(nameKey);
            if (cid) allCidsToFetch.push(cid);
        });
    }
    if (showNumber) {
        Object.keys(numberGroups).forEach(noKey => {
            const item = numberGroups[noKey];
            const nameKey = item.name || getCardNameByNumber(noKey);
            const cid = findCidByNameOrNo(nameKey, noKey);
            if (cid) allCidsToFetch.push(cid);
        });
    }

    if (allCidsToFetch.length > 0) {
        fetchCardsMetaBatch(allCidsToFetch).then(() => {
            if (showName && nameSec) {
                const rows = nameSec.querySelectorAll('.broad-search-row');
                const nameKeys = Object.keys(nameGroups);
                rows.forEach((rowEl, idx) => {
                    const cardName = nameKeys[idx];
                    if (cardName) {
                        const metaType = getCardMetaType(cardName);
                        const labelEl = rowEl.querySelector('.broad-type-label');
                        if (labelEl) {
                            labelEl.className = `broad-type-label broad-type-${metaType.kind}`;
                            labelEl.textContent = metaType.kindStr;
                        }
                    }
                });
            }
            if (showNumber && numSec) {
                const rows = numSec.querySelectorAll('.broad-search-row');
                const numberKeys = Object.keys(numberGroups);
                rows.forEach((rowEl, idx) => {
                    const cardNo = numberKeys[idx];
                    if (cardNo) {
                        const item = numberGroups[cardNo];
                        const cardName = item.name || getCardNameByNumber(cardNo);
                        const metaType = getCardMetaType(cardName, cardNo);
                        const labelEl = rowEl.querySelector('.broad-type-label');
                        if (labelEl) {
                            labelEl.className = `broad-type-label broad-type-${metaType.kind}`;
                            labelEl.textContent = metaType.kindStr;
                        }
                    }
                });
            }
        }).catch(() => {});
    }

    M.Tooltip.init(document.querySelectorAll('.tooltipped'));
}

function findCidByNameOrNo(cardName, cardNo = null) {
    if (typeof ClientCache !== 'undefined' && ClientCache._nameToCid) {
        if (cardName && ClientCache._nameToCid[cardName]) {
            return ClientCache._nameToCid[cardName];
        }
        if (cardName) {
            const normName = normalizeStr(cardName);
            if (normName && ClientCache._nameToCid[normName]) {
                return ClientCache._nameToCid[normName];
            }
        }
    }
    if (typeof cardCacheInstance !== 'undefined') {
        if (cardCacheInstance._mergedMeta && cardName && cardCacheInstance._mergedMeta[cardName]) {
            return cardCacheInstance._mergedMeta[cardName][1];
        }
        if (typeof cardCacheInstance.getInventory === 'function' && cardNo) {
            const inv = cardCacheInstance.getInventory();
            const normNo = normalizeStr(cardNo);
            const row = inv.find(r => normalizeStr(String(r[1])) === normNo);
            if (row && row[0]) {
                const nameOfNo = String(row[0]);
                if (ClientCache && ClientCache._nameToCid && ClientCache._nameToCid[nameOfNo]) {
                    return ClientCache._nameToCid[nameOfNo];
                }
                if (cardCacheInstance._mergedMeta && cardCacheInstance._mergedMeta[nameOfNo]) {
                    return cardCacheInstance._mergedMeta[nameOfNo][1];
                }
            }
        }
    }
    return null;
}

async function renderTargetByCid(cid, code = null, isInstant = false) {
    if (!cid) return;
    switchToMode('search', isInstant);

    let cardName = typeof ClientCache !== 'undefined' ? ClientCache.getCardNameByCid(cid, UIStore.currentRegion) : null;
    let targetMeta = null;

    const relatedNames = new Set();
    if (cardName) relatedNames.add(cardName);

    try {
        const res = await fetchCardMetaWithCache(cid, cardName || '');
        if (res && res.success && res.info) {
            targetMeta = res;
            const langArr = extractLangData(res);
            if (langArr && langArr[0]) {
                cardName = langArr[0];
                relatedNames.add(cardName);
            }

            // res.info (0~9 언어 객체)에 들어있는 모든 언어권 카드 이름을 추출하여 relatedNames에 추가
            if (res.info && typeof res.info === 'object' && !Array.isArray(res.info)) {
                Object.keys(res.info).forEach(k => {
                    const infoItem = res.info[k];
                    if (Array.isArray(infoItem) && infoItem[0] && typeof infoItem[0] === 'string') {
                        const nameStr = infoItem[0].trim();
                        if (nameStr && nameStr.length < 150) relatedNames.add(nameStr);
                    }
                });
            }
        }
    } catch (e) {
        console.warn("[renderTargetByCid] getCardMetadata error:", e.message);
    }

    if (!cardName) cardName = code || `CID: ${cid}`;
    relatedNames.add(cardName);

    if (cid && typeof ClientCache !== 'undefined') {
        ClientCache.registerCid(cid, Array.from(relatedNames));
    }

    let targetRows = getInventoryRowsByCidOrName(cid, cardName, code);

    // 이미 획득한 targetMeta를 그대로 전달하여 renderTargetSearchResult 내부의 중복 API 호출 방지
    const preFetchedMeta = targetMeta ? Promise.resolve(targetMeta) : null;

    const renderFunc = async (mountContainer) => {
        await renderTargetSearchResult(cardName, targetRows, code, mountContainer, cid, preFetchedMeta);
    };

    if (isInstant) {
        await renderFunc();
    } else {
        await animateVerticalExpand(renderFunc);
    }
}

async function renderTargetSearchResult(targetCardName, targetRows, prioritizeNumber = null, mountContainer = null, forcedCid = null, preFetchedMetaPromise = null) {
    let targetCid = forcedCid || findCidByNameOrNo(targetCardName, prioritizeNumber);

    const previousCardName = (typeof lastSearchState !== 'undefined' && lastSearchState) ? lastSearchState.targetCardName : null;
    const previousCid = (typeof lastSearchState !== 'undefined' && lastSearchState) ? lastSearchState.targetCid : null;

    const targetArea = mountContainer || document.getElementById('result-area');

    // 튀는 현상 원천 차단: 동일한 카드의 보유 목록 수정 시 기존 상단 메타데이터(tempBox) 유지 및 In-Place 갱신
    const existingTempBox = targetArea.querySelector('.target-card-temp-box');
    const existingBottomSec = targetArea.querySelector('.target-inventory-section');

    const isSameCard = (previousCid && targetCid && String(previousCid) === String(targetCid)) || 
                       (previousCardName && targetCardName && previousCardName === targetCardName);

    if (existingTempBox && existingBottomSec && !mountContainer && isSameCard) {
        existingBottomSec.innerHTML = '';
        if (targetRows.length === 0) {
            existingBottomSec.innerHTML = `<p class="center" style="padding: 20px 0; color: var(--text-secondary);">등록되지 않은 카드입니다.</p>`;
        } else {
            renderTableToContainer(targetRows, existingBottomSec);
        }
        return;
    }

    targetArea.innerHTML = '';

    const tempBox = document.createElement('div');
    tempBox.className = 'target-card-temp-box';
    targetArea.appendChild(tempBox);

    // 2. 하단 보유 카드 검색 결과 영역
    const bottomSec = document.createElement('div');
    bottomSec.className = 'target-inventory-section';

    if (targetRows.length === 0) {
        bottomSec.innerHTML = `<p class="center" style="padding: 20px 0; color: var(--text-secondary);">등록되지 않은 카드입니다.</p>`;
    } else {
        renderTableToContainer(targetRows, bottomSec);
    }
    targetArea.appendChild(bottomSec);

    // [상단 4개 수직 구역 렌더링 로직]
    // Safari 최적화: innerHTML 파싱 제거 → createElement + textContent + DocumentFragment
    // innerHTML은 HTML 파서를 실행하지만 createElement + textContent는 파싱 없이 직접 DOM 노드 생성
    // DocumentFragment로 모든 노드를 조립 후 한 번에 삽입하여 Reflow를 4회→1회로 감소
    const renderFourSections = (cardMeta) => {
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
        const sec1 = document.createElement('div');
        sec1.className = 'target-sec-name';
        const nameTitle = document.createElement('div');
        nameTitle.className = 'target-name-title';
        nameTitle.textContent = nameVal;
        sec1.appendChild(nameTitle);
        if (prioritizeNumber) {
            const nameSub = document.createElement('div');
            nameSub.className = 'target-name-sub';
            nameSub.textContent = `(검색 번호: ${prioritizeNumber})`;
            sec1.appendChild(nameSub);
        }
        fragment.appendChild(sec1);

        // 2. [정보] 구역
        const sec2 = document.createElement('div');
        sec2.className = 'target-sec-info';

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
            stTable.className = 'target-info-table spell-trap-table';
            const stTbody = document.createElement('tbody');
            const stTr = document.createElement('tr');
            const stTd = document.createElement('td');
            stTd.className = 'spell-trap-single-cell';
            stTd.textContent = spellTrapText;
            stTr.appendChild(stTd); stTbody.appendChild(stTr); stTable.appendChild(stTbody);
            sec2.appendChild(stTable);
        } else {
            // 몬스터 ➔ 3행 테이블 구도
            const attrText = (attrVal !== null && attrVal !== undefined && DECODE_ATTR[locIdx]?.[attrVal]) ? DECODE_ATTR[locIdx][attrVal] : "-";
            const speciesText = (speciesVal !== null && speciesVal !== undefined && DECODE_SPECIES[locIdx]?.[speciesVal]) ? DECODE_SPECIES[locIdx][speciesVal] : "-";
            let levelLabel = "레벨";
            if (etcList.includes(5)) levelLabel = "랭크";
            else if (etcList.includes(13)) levelLabel = "LINK";
            const levelDisplay = levelVal !== null && levelVal !== undefined ? (levelLabel === "LINK" ? `LINK-${levelVal}` : `★ ${levelVal}`) : "-";
            const atkDisplay = atkVal !== null && atkVal !== undefined ? (atkVal === -1 ? "?" : String(atkVal)) : "-";
            const defDisplay = defVal !== null && defVal !== undefined ? (defVal === -1 ? "?" : String(defVal)) : "-";
            const showDef = !etcList.includes(13);

            const mTable = document.createElement('table');
            mTable.className = 'target-info-table monster-table';
            const mTbody = document.createElement('tbody');

            // 행 1: 속성 / 종족 / 레벨
            const mkThTd = (label, value) => {
                const th = document.createElement('th'); th.textContent = label;
                const td = document.createElement('td'); td.textContent = value;
                return [th, td];
            };
            const tr1 = document.createElement('tr');
            tr1.append(...mkThTd('속성', attrText), ...mkThTd('종족', speciesText), ...mkThTd(levelLabel, levelDisplay));
            mTbody.appendChild(tr1);

            // 행 2: 공격력 / 수비력
            const tr2 = document.createElement('tr');
            const thAtk = document.createElement('th'); thAtk.textContent = '공격력';
            const tdAtk = document.createElement('td'); tdAtk.colSpan = 2; tdAtk.textContent = atkDisplay;
            tr2.append(thAtk, tdAtk);
            if (showDef) {
                const thDef = document.createElement('th'); thDef.textContent = '수비력';
                const tdDef = document.createElement('td'); tdDef.colSpan = 2; tdDef.textContent = defDisplay;
                tr2.append(thDef, tdDef);
            } else {
                const tdEmpty = document.createElement('td'); tdEmpty.colSpan = 3;
                tr2.appendChild(tdEmpty);
            }
            mTbody.appendChild(tr2);

            // 행 3: 분류 배지 (조건부)
            const monsterEtcList = etcList.filter(e => e >= 0 && e <= 14);
            if (monsterEtcList.length > 0) {
                const tr3 = document.createElement('tr');
                const thBadge = document.createElement('th'); thBadge.textContent = '분류';
                const tdBadge = document.createElement('td'); tdBadge.colSpan = 5; tdBadge.className = 'badge-cell';
                monsterEtcList.forEach(e => {
                    const label = DECODE_ETC[locIdx]?.[e] || "";
                    if (label) {
                        const span = document.createElement('span');
                        span.className = 'pill-badge';
                        span.textContent = label;
                        tdBadge.appendChild(span);
                    }
                });
                tr3.append(thBadge, tdBadge);
                mTbody.appendChild(tr3);
            }
            mTable.appendChild(mTbody);
            sec2.appendChild(mTable);
        }
        fragment.appendChild(sec2);

        // 3. [펜듈럼] 구역 (조건부)
        if (etcList.includes(6)) {
            const sec3 = document.createElement('div');
            sec3.className = 'target-sec-pendulum';
            const pTable = document.createElement('table');
            pTable.className = 'target-info-table pendulum-table';
            const pTbody = document.createElement('tbody');
            const pTr1 = document.createElement('tr');
            const pTdText = document.createElement('td');
            pTdText.className = 'pen-text-cell'; pTdText.rowSpan = 2;
            pTdText.textContent = penTextVal || "-";
            const pThScale = document.createElement('th');
            pThScale.className = 'pen-scale-header'; pThScale.textContent = '스케일';
            pTr1.append(pTdText, pThScale);
            pTbody.appendChild(pTr1);
            const pTr2 = document.createElement('tr');
            const pTdVal = document.createElement('td');
            pTdVal.className = 'pen-scale-val';
            pTdVal.textContent = (scaleVal !== null && scaleVal !== undefined) ? String(scaleVal) : "-";
            pTr2.appendChild(pTdVal);
            pTbody.appendChild(pTr2);
            pTable.appendChild(pTbody); sec3.appendChild(pTable);
            fragment.appendChild(sec3);
        }

        // 4. [텍스트] 구역
        const sec4 = document.createElement('div');
        sec4.className = 'target-sec-text';
        const cardTextDiv = document.createElement('div');
        cardTextDiv.className = 'target-card-text';
        cardTextDiv.textContent = cardTextVal || "카드 텍스트 정보가 없습니다.";
        sec4.appendChild(cardTextDiv);
        fragment.appendChild(sec4);

        // tempBox 초기화 후 Fragment를 한 번에 삽입 (Reflow 1회)
        tempBox.innerHTML = '';
        tempBox.appendChild(fragment);
    };

    if (!targetCid && typeof ClientCache !== 'undefined' && ClientCache._nameToCid && ClientCache._nameToCid[targetCardName]) {
        targetCid = ClientCache._nameToCid[targetCardName];
    }

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
    renderFourSections(targetMeta);

    // 3순위: API 완료 대기 (preFetchedMetaPromise는 이미 RAM에서 거의 즉시 resolve)
    try {
        const res = await (preFetchedMetaPromise || fetchCardMetaWithCache(targetCid, targetCardName));
        if (res && (res.info || res.rawSlot)) {
            targetMeta = res;
            // [방안 B - 2차 렌더링] 완전한 API 데이터로 갱신
            renderFourSections(targetMeta);
        }
    } catch (e) {
        console.warn("[TargetBox] getCardMetadata 연동 실패, 기본 캐시 유지:", e.message);
    }

    const realCid = extractCidFromMeta(targetMeta) || targetCid;
    if (realCid && realCid !== "null" && realCid !== "undefined") {
        targetCid = realCid;
        ClientCache.registerCid(targetCid, [targetCardName], [prioritizeNumber]);
    }

    if (!mountContainer) {
        lastSearchState = { type: 'target', targetCardName, targetRows, prioritizeNumber, targetCid, targetMeta };
        if (targetCid && targetCid !== "null" && targetCid !== "undefined") {
            updateSearchHash('target', { cid: targetCid, code: prioritizeNumber }, true);
        }
    }

    // [핵심] 2차 렌더링에서 이미 최종 메타데이터로 완성됨 (lastSearchState 갱신 후 추가 호출 불필요)

    M.Tooltip.init(document.querySelectorAll('.tooltipped'));
}

function renderTableToContainer(rows, container) {
    if (!container) return;
    if (rows.length === 0) { container.innerHTML = "<p class='center'>결과 없음</p>"; return; }

    // 카드 이름별 그룹화
    const nameGroups = {};
    rows.forEach(r => {
        const cardName = String(r[0] || "이름 없음").trim();
        if (!nameGroups[cardName]) {
            nameGroups[cardName] = [];
        }
        nameGroups[cardName].push(r);
    });

    let newHtml = "";
    const nameKeys = Object.keys(nameGroups);

    nameKeys.forEach(cardName => {
        const nameRows = nameGroups[cardName];

        // 카드 번호별 그룹화
        const groups = {};
        nameRows.forEach(r => {
            const cardNo = String(r[1]), rarity = String(r[2]), qty = parseInt(r[3]) || 0, loc = String(r[4]);
            const illustration = String(r[5] || "기본").trim();
            if (!groups[cardNo]) groups[cardNo] = { locations: {}, illustrationGroups: {} };
            if (!groups[cardNo].locations[loc]) groups[cardNo].locations[loc] = { total: 0, rarities: {} };
            groups[cardNo].locations[loc].total += qty; groups[cardNo].locations[loc].rarities[rarity] = (groups[cardNo].locations[loc].rarities[rarity] || 0) + qty;

            const aKey = `${illustration}|${loc}`;
            if (!groups[cardNo].illustrationGroups[aKey]) groups[cardNo].illustrationGroups[aKey] = { illustration, loc, total: 0, rarities: {} };
            groups[cardNo].illustrationGroups[aKey].total += qty; groups[cardNo].illustrationGroups[aKey].rarities[rarity] = (groups[cardNo].illustrationGroups[aKey].rarities[rarity] || 0) + qty;
        });

        let innerHtml = "";
        Object.keys(groups).forEach(cardNo => {
            const rowId = `row-${cardNo}`.replace(/[^a-zA-Z0-9]/g, '');
            const cardRows = nameRows.filter(r => String(r[1]) === cardNo);
            const totalQty = cardRows.reduce((sum, r) => sum + (parseInt(r[3]) || 0), 0);
            const locSet = new Set(cardRows.map(r => String(r[4])).filter(l => l));
            const distinctKeys = [...new Set(cardRows.map(r => String(r[2]).trim()).filter(k => k))];

            distinctKeys.sort(compareRarity);

            const displayNamesForSummary = [...new Set(distinctKeys.map(k => {
                let idx = rarityReverseMap[k];
                let row = (idx !== undefined) ? rarityRows[idx] : null;
                return (row && row[rarityColMap['display']]) ? row[rarityColMap['display']] : k;
            }))];

            const procStr = displayNamesForSummary.map(p => escapeHTML(p)).join(", ");
            const locStr = [...locSet].map(l => escapeHTML(l)).join(", ");

            const anotherGroups = {};
            cardRows.forEach(r => {
                const illustration = String(r[5] || "기본").trim();
                if (!anotherGroups[illustration]) anotherGroups[illustration] = [];
                anotherGroups[illustration].push(r);
            });

            let leftTableHtml = `<table class="split-table"><thead><tr><th class="fp-col-1">일러스트</th><th class="fp-col-2">보관 위치</th><th class="fp-col-3">총 수량</th></tr></thead><tbody>`;
            let rightTableHtml = `<table class="split-table"><thead><tr>`;

            distinctKeys.forEach(key => {
                let displayName = key;
                let tooltipContent = key;
                let idx = rarityReverseMap[key];

                if (idx !== undefined) {
                    let row = rarityRows[idx];
                    if (row) {
                        displayName = row[rarityColMap['display']] || key;
                        let localName = row[rarityColMap[UIStore.currentRegion]];
                        if (localName && localName !== "") {
                            tooltipContent = localName;
                        } else {
                            tooltipContent = key;
                        }
                    }
                }

                const escapedDisplayName = escapeHTML(displayName);
                const escapedTooltip = escapeHTML(tooltipContent).replace(/\(/g, '<br>(');
                rightTableHtml += `<th class="sp-col tooltipped" data-key="${escapeHTML(key)}" data-index="${idx !== undefined ? idx : ''}" data-position="top" data-tooltip="${escapedTooltip}">${escapedDisplayName}</th>`;
            });
            rightTableHtml += `</tr></thead><tbody>`;

            const anotherKeys = Object.keys(anotherGroups).sort((a, b) => { if (a === "기본") return -1; if (b === "기본") return 1; return a.localeCompare(b, undefined, { numeric: true }); });
            anotherKeys.forEach(illustration => {
                const grpRows = anotherGroups[illustration]; const locGroups = {};
                grpRows.forEach(r => { const loc = String(r[4]); const rarity = String(r[2]); const qty = parseInt(r[3]) || 0; if (!locGroups[loc]) locGroups[loc] = { total: 0, procs: {} }; locGroups[loc].total += qty; locGroups[loc].procs[rarity] = (locGroups[loc].procs[rarity] || 0) + qty; });
                const locKeys = Object.keys(locGroups);
                locKeys.forEach((loc, idx) => { const d = locGroups[loc]; leftTableHtml += `<tr>`; if (idx === 0) leftTableHtml += `<td rowspan="${locKeys.length}">${escapeHTML(illustration)}</td>`; leftTableHtml += `<td>${escapeHTML(loc)}</td><td>${escapeHTML(d.total)}</td></tr>`; rightTableHtml += `<tr>`; distinctKeys.forEach(key => { const val = d.procs[key] || 0; rightTableHtml += `<td>${escapeHTML(val)}</td>`; }); rightTableHtml += `</tr>`; });
            });
            leftTableHtml += `</tbody></table>`; rightTableHtml += `</tbody></table>`;
            innerHtml += ` <div class="new-card-box"> <div class="summary-split-wrapper"> <div class="summary-left">${escapeHTML(cardNo)}</div> <div class="summary-right"> <table class="summary-table"> <tr><td class="summary-label-cell">보관 위치</td><td class="summary-label-cell">수량</td></tr> <tr><td class="summary-value-cell">${locStr}</td><td class="summary-value-cell">${escapeHTML(totalQty)}</td></tr> <tr><td class="summary-label-cell border-double-top">보유 레어도</td><td class="summary-value-cell border-double-top">${procStr}</td></tr> </table> </div> </div> <div id="detail-${rowId}" class="detail-slide-wrapper"> <div class="split-table-wrapper"> <div class="fixed-side">${leftTableHtml}</div> <div class="scroll-side">${rightTableHtml}</div> </div> </div> <button class="show-more-btn" onclick="toggleNewDetail('detail-${rowId}')"><span>자세히 보기</span><i class="material-icons tiny">keyboard_arrow_down</i></button> </div> `;
        });

        newHtml += `<div class="target-card-group-content">${innerHtml}</div>`;
    });

    container.innerHTML = newHtml;
    M.Tooltip.init(container.querySelectorAll('.tooltipped'), { html: true, margin: 3 });
}

async function loadUserData() {
    if (!UserStore.user) {
        UserStore.isUserDataSyncDone = true;
        return;
    }
    UserStore.isUserDataSyncDone = false; // [추가] 동기화 시작 시 플래그 초기화
    showLoading(true, "내 인벤토리 로딩 중...");
    try {
        const res = await callApi('getUserData');
        showLoading(false);

        // 멤버십 정보가 없더라도 기본 UI 렌더링을 위해 초기화 호출
        const membership = (res && res.settings && res.settings.membership) ? res.settings.membership : null;

        // 기타 사용자 설정 및 멤버십 동기화
        if (res && res.settings) {
            if (res.settings.theme) UserStore.settings.theme = res.settings.theme;
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

        if (res && res.success) {
            applyUserData(res);
        }
    } catch (e) {
        console.error("[Sync] getUserData Error:", e);
        showLoading(false);
    } finally {
        UserStore.isUserDataSyncDone = true; // 사용자 동기화 완료 플래그 설정
        checkAndHideInitialLoading();

        // [추가] 사용자가 현재 보유 현황 페이지의 목록 모드를 보고 있다면, 로그인 성공 후 자동으로 목록을 갱신합니다.
        if (typeof UIStore.mode !== 'undefined' && UIStore.mode === 'inventory' && 
            typeof UIStore.inventoryMode !== 'undefined' && UIStore.inventoryMode === 'list') {
            renderInventoryGrid();
        }

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
    const verifyBtn = document.getElementById('membership-verify-btn');
    if (verifyBtn) {
        const isHidden = UserStore.settings && UserStore.settings.hideMembershipVerify === true;
        const isMobileDevice = document.documentElement.classList.contains('is-mobile-device');
        const shouldShowVerify = !isPremium && !isHidden && !!UserStore.user;
        verifyBtn.style.display = (shouldShowVerify && !isMobileDevice) ? 'flex' : 'none';
    }

    // 환경설정 페이지 UI 갱신 (데이터가 없어도 기본 버튼 노출을 위해 항상 호출)
    renderMembershipSettings(mem);
}

/**
 * 환경설정 페이지 멤버십 섹션 렌더링
 */
function renderMembershipSettings(membership) {
    const container = document.getElementById('membership-status-container');
    if (!container) return;

    const isPremium = (membership && membership.status === 'active');
    let levelName = membership ? (membership.levelName || '일반 사용자') : '일반 사용자';

    // [보정] 구버전 구문 보정
    if (levelName === '디스코드 멤버십 회원') {
        levelName = '유튜브 멤버십';
    }

    const lastChecked = membership ? new Date(membership.lastChecked).toLocaleString() : '-';

    let html = `
        <div class="management-row" style="margin-top: 15px; padding-top: 15px; border-top: 1px dotted var(--border-color);">
            <div class="management-desc">
                <div style="font-weight: 700; color: var(--text-primary); display: flex; align-items: center; gap: 6px;">
                    멤버십 상태: ${isPremium ? '<span style="color: #00bcd4;">프리미엄 (💎)</span>' : '일반'}
                </div>
                <div style="font-size: 0.85rem; color: var(--text-muted); margin-top: 4px;">
                    현재 등급: ${levelName} <br>
                    마지막 확인: ${lastChecked}
                </div>
            </div>
            <button class="btn waves-effect management-btn" 
                    id="sync-membership-btn"
                    onclick="syncYoutubeMembership()"
                    style="background-color: var(--bg-header); color: var(--text-primary); border: 1px solid var(--border-color); box-shadow: none;">
                상태 갱신
            </button>
        </div>
    `;
    container.innerHTML = html;
}

/**
 * 설정 페이지 멤버십 상태 갱신 버튼 클릭 핸들러
 */
async function syncYoutubeMembership() {
    if (!UserStore.user) {
        showToast('로그인이 필요합니다.', 'toast-warn');
        return;
    }
    openMembershipAuthModal();
}

/**
 * 서버 인벤토리 데이터 적용
 */
function applyUserData(res) {
    if (!res) return;

    // 서버로부터 받은 설정 적용 (테마, 상세 모드 등)
    if (res.settings) {
        loadUserSettings(res.settings);
    }

    // 1. 인벤토리 목록 저장
    if (res.allCards) {
        cardCacheInstance.setInventory(res.allCards);
    }

    // 2. 통계 및 매핑 저장 (초기 로딩 및 로컬 데이터를 바탕으로 통계 강제 동기화 보정)
    cardCacheInstance.setSummary(res.amount, res.locations, res.rarities);
    cardCacheInstance.rebuildSummaryFromInventory();

    // 3. UI 갱신
    updateTotals();
    renderHomeDash();

    // 환경 설정 페이지 UI 갱신 (위치 목록 등)
    updateRarityInputs();

    // 유저 데이터 세팅 완료 후 단 1회 정밀 결과 갱신
    refreshCurrentSearchResult();
}

async function applyPublicData(res) {
    if (res.masterCache) {
        // syncType 식별을 캐시 계층으로 전달
        res.masterCache.syncType = res.syncType;
        await ClientCache.setMasterData(res.masterCache);
    } else {
        console.warn("[Sync] No masterCache found in response.");
    }

    // [Storage 최적화] 카드 이름 및 번호 목록 지능형 다운로드 및 영구 캐싱
    const localLastUpdate = parseInt(localStorage.getItem('cardListUpdatedAt') || '0');
    const cacheSize = cardCacheInstance ? cardCacheInstance._allKnownNames.size : 0;
    const numberCount = CardDataStore.allCardNumbers ? CardDataStore.allCardNumbers.length : 0;
    const shouldUpdateCardList = (res.cardListInfo && res.cardListInfo.updatedAt > localLastUpdate) || cacheSize === 0 || numberCount === 0;

    if (res.rarityUpdatedAt) {
        localStorage.setItem('rarityUpdatedAt', res.rarityUpdatedAt);
    }

    const saveBatch = {};

    // [Single-Flight 최적화] 카드 목록 매니페스트 본문(names, numbers, cids)이 동봉되어 온 경우
    const cardManifestData = res.cardNames || res.cardListData;
    if (cardManifestData && typeof cardManifestData === 'object') {
        try {
            const data = cardManifestData;
            let cidsData = data.cids || null;
            if (Array.isArray(data.names)) {
                const names = data.names;
                const numbers = data.numbers || [];
                cardCacheInstance.setAllKnownNames(names);
                CardDataStore.allCardNames = names;
                updateNormalizedNames();
                CardDataStore.allCardNumbers = numbers;

                saveBatch.cardNames = names;
                saveBatch.cardNumbers = numbers;
            }
            if (cidsData) {
                ClientCache.loadCidIndex(cidsData);
                saveBatch.cidIndex = cidsData;
            }
            if (res.cardListUpdatedAt) {
                localStorage.setItem('cardListUpdatedAt', res.cardListUpdatedAt);
            }
        } catch (manifestErr) {
            console.warn("[Single-Flight] Apply cardNames error:", manifestErr);
        }
    }

    // [Single-Flight 최적화] 팩 목록 본문이 동봉되어 온 경우
    if (res.packData && typeof res.packData === 'object') {
        CardDataStore.masterJSON.pack = res.packData;
        if (res.packUpdatedAt) {
            localStorage.setItem('packUpdatedAt', res.packUpdatedAt);
        }
        saveBatch.packData = res.packData;
        updatePackNamesCache();
    } else if (res.packListInfo && res.packListInfo.url) {
        const localPackUpdate = parseInt(localStorage.getItem('packUpdatedAt') || '0');
        const packCount = (CardDataStore.masterJSON && CardDataStore.masterJSON.pack) ? Object.keys(CardDataStore.masterJSON.pack).length : 0;

        if (localPackUpdate < res.packListInfo.updatedAt || packCount === 0) {
            try {
                const packsUrl = `${res.packListInfo.url}?t=${res.packListInfo.updatedAt}`;
                const response = await fetch(packsUrl);
                if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
                const packsData = await response.json();

                if (packsData && typeof packsData === 'object') {
                    CardDataStore.masterJSON.pack = packsData;
                    localStorage.setItem('packUpdatedAt', res.packListInfo.updatedAt);
                    saveBatch.packData = packsData;
                    updatePackNamesCache();
                }
            } catch (e) {
                console.error("[Sync] Failed to download packs.json from Storage:", e);
            }
        }
    }

    // 수집된 동기화 데이터를 1회 일괄 저장 (Single Batch Write)
    if (Object.keys(saveBatch).length > 0) {
        await MasterDB.saveMasterDataBatch(saveBatch);
    }

    currentSheetLastUpdated = res.lastUpdated || 0;
    localStorage.setItem('masterSyncUpdatedAt', currentSheetLastUpdated);

    rarityMappingRaw = res.rarityData || res.rarityMappingRaw || CardDataStore.masterJSON.rarity || [];
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

function rebuildPackDatabase() {
    packDatabase = (CardDataStore.masterJSON && CardDataStore.masterJSON.pack) ? Object.keys(CardDataStore.masterJSON.pack).map(compositeId => {
        const p = CardDataStore.masterJSON.pack[compositeId];
        // [변경] 복합키 "PID_locale"에서 PID와 locale 파싱
        const lastUnderscore = compositeId.lastIndexOf('_');
        const purePid = lastUnderscore !== -1 ? compositeId.slice(0, lastUnderscore) : compositeId;
        const locale = lastUnderscore !== -1 ? compositeId.slice(lastUnderscore + 1) : '';
        return {
            id: purePid,            // API 호출에 사용할 순수 PID
            compositeId,            // 캐시 룩업용 복합키
            name: p ? p.name : compositeId,
            total: p ? p.totalCards : 0,
            locales: locale ? [locale] : [],
            cids: []
        };
    }) : [];
}

    // [Storage 전환] CardDataStore.masterJSON.pack에서 packDatabase 구성
    rebuildPackDatabase();

    // [On-Demand 전환] 팩별 카드 사전 캐시 구축 로직 제거
    // 팩 카드 정보는 crawlPackCardsBatch API를 통해 On-Demand 조회

    refreshLocalLookups();
    updateRarityInputs();

    // 공통 로드 완료 후 렌더링
    isAppConfigured = true;
    renderHomeDash();

    // Pack Search 페이지 자동 검색 플래그 확인
    if (typeof checkAutoSearchAfterInitialLoad === 'function') {
        checkAutoSearchAfterInitialLoad();
    }
}




function startSearchWithOption(e, searchType) {
    if (e) {
        e.preventDefault();
        e.stopPropagation();
    }
    startSearch(false, searchType);
}

function executeMobileSearchWithOption(e, searchType) {
    if (e) {
        e.preventDefault();
        e.stopPropagation();
    }
    const mSearchInput = document.getElementById('mobile-card-search');
    const query = mSearchInput ? mSearchInput.value.trim() : '';
    if (query) {
        executeMobileSearch(query, searchType);
    }
}

async function handleContinueRegistration() {
    M.Modal.getInstance(document.getElementById('add-result-modal')).close();
    toggleBackgroundInert(false);

    const isMobile = document.documentElement.classList.contains('is-mobile-device');
    const subMode = UIStore.chipState.add || addSubMode;
    const containerId = isMobile 
        ? ((subMode === 'pack') ? 'mobile-cards-list-pack' : (subMode === 'deck') ? 'mobile-cards-list-deck' : 'mobile-cards-list-general')
        : ((subMode === 'pack') ? 'desktop-cards-list-pack' : (subMode === 'deck') ? 'desktop-cards-list-deck' : 'desktop-cards-list-general');
    const cardClass = isMobile ? '.mobile-info-card' : '.desktop-info-card';
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
            if (isMobile) mobileAddEntry('add', subMode);
            else desktopAddEntry('add', subMode);
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
        showLoading(true, "로그인 중...");
    } else {
        // Firebase Auth 검증까지 완전히 종료된 경우
        if (!UserStore.user) {
            // 비로그인 사용자의 경우 로딩 오버레이 즉시 닫기
            showLoading(false);
        }
    }
}



function toggleNewDetail(detailId) {
    const content = document.getElementById(detailId);
    if (!content) return;
    const btn = content.nextElementSibling;
    const textSpan = btn.querySelector('span');
    const icon = btn.querySelector('i');

    if (content.style.maxHeight) {
        content.style.maxHeight = null;
        textSpan.innerText = '자세히 보기';
        icon.innerText = 'keyboard_arrow_down';
    } else {
        content.style.maxHeight = content.scrollHeight + "px";
        textSpan.innerText = '간략히 보기';
        icon.innerText = 'keyboard_arrow_up';
    }
}

function showLoading(show, html) {
    const overlay = document.getElementById('loading-overlay');
    const loadingText = document.getElementById('loading-text');
    if (overlay && loadingText) {
        if (show) {
            overlay.style.display = 'flex';
            loadingText.innerHTML = html;
            document.body.classList.add('is-loading');

            // 제작 중단 링크가 포함된 경우 이벤트 바인딩
            const cancelLink = document.getElementById('cancel-gen-link');
            if (cancelLink) {
                cancelLink.onclick = (e) => {
                    e.preventDefault();
                    handleCancelGeneration();
                };
            }
        } else {
            overlay.style.display = 'none';
            document.body.classList.remove('is-loading');
        }
    }
}

/**
 * 팩 등록표 제작 중단 핸들러
 */
function handleCancelGeneration() {
    stopPackCrawlNew();       // 크롤링 중단
    resetPackMode();          // 표 초기화 및 UI 복구
    showLoading(false);       // 오버레이 제거
}

/**
 * 크롤링 수치를 1개 단위로 부드럽게 업데이트하는 애니메이션 함수
 */
function updateSmoothCrawlCount(target, total) {
    if (_crawlIntervalId) clearInterval(_crawlIntervalId);

    _crawlIntervalId = setInterval(() => {
        if (_currentDisplayCrawlCount < target) {
            _currentDisplayCrawlCount++;

            // 테이블이 아직 생성되지 않았거나, 이미 모든 행이 채워졌다면 로딩 표시 생략
            const isMobile = document.documentElement.classList.contains('is-mobile-device');
            const containerId = isMobile ? 'mobile-cards-list-pack' : 'desktop-cards-list-pack';
            const container = document.getElementById(containerId);
            const cardClass = isMobile ? '.mobile-info-card' : '.desktop-info-card';
            const cards = container ? container.querySelectorAll(cardClass) : [];
            const allFilled = cards.length > 0 && Array.from(cards).every(card => {
                const nameInp = card.querySelector('[data-field="name"]');
                const noInp = card.querySelector('[data-field="no"]');
                return nameInp && nameInp.value && noInp && noInp.value;
            });

            if (PackDeckStore.isPackTableGenerated && !PackDeckStore.isPackCrawlDone && !allFilled) {
                showLoading(true, `카드 검색 중<br>(${_currentDisplayCrawlCount}/${total})<br><a id="cancel-gen-link" class="link-style-btn">제작 중단</a>`);
            }
        } else {
            clearInterval(_crawlIntervalId);
            _crawlIntervalId = null;
        }
    }, 20); // 20ms 간격으로 1개씩 상승
}



function initPageMove() {
    const isMobile = document.documentElement.classList.contains('is-mobile-device');
    if (isMobile) {
        const listContainer = document.getElementById('mobile-cards-list-move');
        if (listContainer && listContainer.querySelectorAll('.mobile-info-card').length === 0) {
            listContainer.innerHTML = '';
            mobileAddEntry('move');
        }
    } else {
        const listContainer = document.getElementById('desktop-cards-list-move');
        if (listContainer && listContainer.querySelectorAll('.desktop-info-card').length === 0) {
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

function setupCardNameAutocomplete(wrapper) {
    const input = wrapper.querySelector('input');
    let currentFocusIdx = -1;

    // 이미 드롭다운 이벤트가 바인딩된 경우 중복 바인딩 방지
    if (input._isDropdownBound && wrapper._dropdown) {
        return;
    }
    input._isDropdownBound = true;

    // 개별 드롭다운 요소 생성 또는 찾기 후 Body에 부착 및 참조 보관
    let localDropdown = wrapper._dropdown;
    if (!localDropdown) {
        localDropdown = document.createElement('ul');
        localDropdown.className = 'global-dropdown custom-options';
        document.body.appendChild(localDropdown);
        wrapper._dropdown = localDropdown;
    }

    const closeDropdown = () => {
        wrapper.classList.remove('active');
        input.classList.remove('active');
        localDropdown.classList.remove('active');
        if (UIStore.activeDropdownInput === input) {
            currentFocusIdx = -1;
            UIStore.activeDropdownInput = null;
        }
    };

    const renderDropdown = (filtered) => {
        if (document.activeElement !== input) {
            closeDropdown();
            return;
        }
        wrapper.classList.add('active');
        input.classList.add('active');
        localDropdown.classList.add('active');
        localDropdown.innerHTML = "";

        if (filtered.length === 0) {
            const li = document.createElement('li');
            li.className = 'custom-option item-no-match';
            li.innerText = '카드 이름 확인';
            localDropdown.appendChild(li);
        } else {
            filtered.forEach(name => {
                const li = document.createElement('li');
                li.className = 'custom-option';
                li.innerText = name;
                li.onmousedown = (e) => e.preventDefault();
                li.onclick = () => {
                    input.value = name;
                    closeDropdown();
                    input.dispatchEvent(new Event('input'));
                    input.dispatchEvent(new Event('change'));
                    fetchCardByName(input);
                };
                localDropdown.appendChild(li);
            });
        }

        positionDropdown(localDropdown, wrapper);
    };

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
        renderDropdown(filteredNames);
    };

    const handleInput = () => {
        UIStore.activeDropdownInput = input;
        const query = input.value.replace(/\s+/g, '').toLowerCase();
        if (!query) {
            showAllOwnedNames();
            return;
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
                    matches.push(item.original);
                    if (matches.length >= 8) break;
                }
            }
        }

        renderDropdown(matches);
    };

    const debouncedHandleInput = debounce(handleInput, 100);
    input.addEventListener('input', debouncedHandleInput);

    input.addEventListener('focus', () => {
        UIStore.activeDropdownInput = input;
        if (UIStore.pendingBlurFn && UIStore.activeDropdownInput === input) { clearTimeout(UIStore.pendingBlurFn); UIStore.pendingBlurFn = null; }
        const query = input.value.replace(/\s+/g, '').toLowerCase();
        if (query) {
            handleInput();
        } else {
            showAllOwnedNames();
        }
    });
    input.addEventListener('blur', () => {
        if (debouncedHandleInput.cancel) debouncedHandleInput.cancel();
        closeDropdown();
    });
    input.addEventListener('keydown', (e) => {
        if (!localDropdown.classList.contains('active')) return;

        const items = localDropdown.querySelectorAll('li');
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            currentFocusIdx++;
            if (currentFocusIdx >= items.length) currentFocusIdx = 0;
            updateHighlight(items, currentFocusIdx);
        }
        else if (e.key === 'ArrowUp') {
            e.preventDefault();
            currentFocusIdx--;
            if (currentFocusIdx < 0) currentFocusIdx = items.length - 1;
            updateHighlight(items, currentFocusIdx);
        }
        else if (e.key === 'Enter') {
            if (e.isComposing) return;
            e.preventDefault();
            if (currentFocusIdx > -1 && items[currentFocusIdx]) {
                items[currentFocusIdx].click();
            } else {
                input.blur();
            }
        }
        else if (e.key === 'Escape') {
            e.preventDefault();
            closeDropdown();
        }
        else if (e.key === 'Tab') {
            if (e.isComposing) return;
            let selectedVal = null;
            if (currentFocusIdx > -1 && items[currentFocusIdx]) {
                selectedVal = items[currentFocusIdx].innerText;
            } else if (items.length > 0) {
                selectedVal = items[0].innerText;
            }
            if (selectedVal) {
                input.value = selectedVal;
                input.dispatchEvent(new Event('input'));
                input.dispatchEvent(new Event('change'));
                fetchCardByName(input);
            }
            closeDropdown();
        }
    });
}

/**
 * 전체 카드 DB 대상 로컬 캐시 자동 완성 (일반 등록 모드용)
 */
function setupGlobalCardNameAutocomplete(wrapper) {
    const input = wrapper.querySelector('input');
    let currentFocusIdx = -1;

    let localDropdown = wrapper._dropdown;
    if (!localDropdown) {
        localDropdown = document.createElement('ul');
        localDropdown.className = 'global-dropdown custom-options';
        document.body.appendChild(localDropdown);
        wrapper._dropdown = localDropdown;
    }

    const closeDropdown = () => {
        wrapper.classList.remove('active');
        localDropdown.classList.remove('active');
        if (UIStore.activeDropdownInput === input) {
            currentFocusIdx = -1;
            UIStore.activeDropdownInput = null;
        }
    };

    const renderDropdown = (filtered) => {
        // 포커스 상태가 아니면 렌더링하지 않음
        if (document.activeElement !== input) {
            closeDropdown();
            return;
        }

        wrapper.classList.add('active');
        localDropdown.classList.add('active');
        localDropdown.innerHTML = "";

        if (filtered.length === 0) {
            const li = document.createElement('li');
            li.className = 'custom-option item-no-match';
            li.innerText = '카드 이름 확인';
            localDropdown.appendChild(li);
        } else {
            filtered.forEach(name => {
                const li = document.createElement('li');
                li.className = 'custom-option';
                li.innerText = name;
                li.onmousedown = (e) => e.preventDefault();
                li.onclick = () => {
                    input.value = name;
                    closeDropdown();
                    input.dispatchEvent(new Event('input'));
                    input.dispatchEvent(new Event('change'));
                    fetchCardByName(input);
                };
                localDropdown.appendChild(li);
            });
        }

        positionDropdown(localDropdown, wrapper);
    };

    const handleInput = () => {
        UIStore.activeDropdownInput = input;
        const query = input.value.trim().toLowerCase();

        if (!query) {
            closeDropdown();
            return;
        }

        const normalizedQuery = query.replace(/\s+/g, '');
        const queryChosung = getChosung(normalizedQuery);
        let matches = [];
        if (typeof CardDataStore.allCardNamesNormalized !== 'undefined' && CardDataStore.allCardNamesNormalized.length > 0) {
            for (let i = 0; i < CardDataStore.allCardNamesNormalized.length; i++) {
                const item = CardDataStore.allCardNamesNormalized[i];
                if (item.chosung.includes(queryChosung)) {
                    if (Hangul.search(item.normalized, normalizedQuery) !== -1) {
                        matches.push(item.original);
                        if (matches.length >= 8) break; // 8개 매칭 충족 시 조기 종료
                    }
                }
            }
        } else {
            const localNamesNormalized = cardCacheInstance.getAllNamesNormalized();
            for (let i = 0; i < localNamesNormalized.length; i++) {
                const item = localNamesNormalized[i];
                if (item.chosung.includes(queryChosung)) {
                    if (Hangul.search(item.normalized, normalizedQuery) !== -1) {
                        matches.push(item.original);
                        if (matches.length >= 8) break;
                    }
                }
            }
        }

        renderDropdown(matches);
    };

    const debouncedHandleInput = debounce(handleInput, 100);
    input.addEventListener('input', debouncedHandleInput);

    // 포커스 시 드롭다운 즉시 표시
    input.addEventListener('focus', () => {
        if (input.value.trim()) {
            handleInput();
        }
    });

    input.addEventListener('blur', () => {
        if (debouncedHandleInput.cancel) debouncedHandleInput.cancel();
        closeDropdown();
    });

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') {
            if (e.isComposing) return; // 한글 입력 조합 중 탭 키 중복 처리 방지
            if (localDropdown.classList.contains('active')) {
                const items = localDropdown.querySelectorAll('li:not(.item-no-match)');
                let selectedVal = null;

                if (currentFocusIdx > -1 && items[currentFocusIdx]) {
                    selectedVal = items[currentFocusIdx].innerText;
                } else if (items.length > 0) {
                    selectedVal = items[0].innerText;
                }

                if (selectedVal) {
                    input.value = selectedVal;
                    input.dispatchEvent(new Event('input'));
                    input.dispatchEvent(new Event('change'));
                    fetchCardByName(input);
                }
                closeDropdown();
            }
            // e.preventDefault() 없음 → 브라우저 기본 Tab/Shift+Tab 동작 그대로 수행
            return;
        }

        if (!localDropdown.classList.contains('active')) return;

        const items = localDropdown.querySelectorAll('li:not(.item-no-match)');
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            currentFocusIdx++;
            if (currentFocusIdx >= items.length) currentFocusIdx = 0;
            updateHighlight(items, currentFocusIdx);
        }
        else if (e.key === 'ArrowUp') {
            e.preventDefault();
            currentFocusIdx--;
            if (currentFocusIdx < 0) currentFocusIdx = items.length - 1;
            updateHighlight(items, currentFocusIdx);
        }
        else if (e.key === 'Enter') {
            if (e.isComposing) return;
            if (currentFocusIdx > -1 && items[currentFocusIdx]) {
                e.preventDefault();
                items[currentFocusIdx].click();
            } else {
                // 선택된 항목이 없을 때 Enter를 치면 드롭다운 닫고 blur 처리
                closeDropdown();
                input.blur();
            }
        }
        else if (e.key === 'Escape') {
            e.preventDefault();
            closeDropdown();
        }
    });
}

function setupCardNoAutocomplete(wrapper) {
    const input = wrapper.querySelector('input');
    let currentFocusIdx = -1;

    // 개별 드롭다운 요소 생성 또는 찾기 후 Body에 부착 및 참조 보관
    let localDropdown = wrapper._dropdown;
    if (!localDropdown) {
        localDropdown = document.createElement('ul');
        localDropdown.className = 'global-dropdown custom-options';
        document.body.appendChild(localDropdown);
        wrapper._dropdown = localDropdown;
    }

    const closeDropdown = () => {
        wrapper.classList.remove('active');
        localDropdown.classList.remove('active');
        if (UIStore.activeDropdownInput === input) {
            currentFocusIdx = -1;
            UIStore.activeDropdownInput = null;
        }
    };
    const renderDropdown = (filtered) => {
        if (document.activeElement !== input) {
            closeDropdown();
            return;
        }
        wrapper.classList.add('active');
        localDropdown.classList.add('active');
        localDropdown.innerHTML = "";

        if (filtered.length === 0) {
            const li = document.createElement('li');
            li.className = 'custom-option item-no-match';
            li.innerText = '번호 확인';
            localDropdown.appendChild(li);
        } else {
            filtered.forEach(no => {
                const li = document.createElement('li'); li.className = 'custom-option'; li.innerText = no; li.onmousedown = (e) => e.preventDefault(); li.onclick = () => {
                    input.dataset.programmatic = "true"; // blur 검증 방지
                    input.value = no; closeDropdown();
                    input.dispatchEvent(new Event('input'));
                    input.dispatchEvent(new Event('change'));
                    
                    // 드롭다운 번호 선택 즉시 fetchCardByNumber(input, true)를 통해 전체 셋업 및 하이퍼링크 매핑 완료
                    fetchCardByNumber(input, true);
                    
                    setTimeout(() => { delete input.dataset.programmatic; }, 200); // 검증 완료 후 플래그 해제
                }; localDropdown.appendChild(li);
            });
        }

        positionDropdown(localDropdown, wrapper);
        if (!localDropdown.parentNode) document.body.appendChild(localDropdown);
    };

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
        if (input.hasAttribute('readonly') || wrapper.classList.contains('no-option')) { closeDropdown(); return; }
        UIStore.activeDropdownInput = input;
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
        renderDropdown(matches);
    };

    const debouncedHandleInput = debounce(handleInput, 100);
    input.addEventListener('input', debouncedHandleInput);

    input.addEventListener('focus', () => {
        if (input.hasAttribute('readonly') || wrapper.classList.contains('no-option')) { closeDropdown(); return; }
        activeDropdownInput = input;
        if (UIStore.pendingBlurFn && activeDropdownInput === input) { clearTimeout(UIStore.pendingBlurFn); UIStore.pendingBlurFn = null; }
        const val = input.value.trim().toUpperCase();
        const source = getSourceList();
        const nameVal = getNameVal();

        if (val || nameVal) {
            let matches = [];
            for (let i = 0; i < source.length; i++) {
                const no = source[i];
                if (no.toUpperCase().includes(val)) {
                    matches.push(no);
                    if (matches.length >= 8) break;
                }
            }
            renderDropdown(matches);
        } else {
            if (source.length > 0) renderDropdown(source.slice(0, 8)); // 8개로 제한하여 렌더링
        }
    });
    input.addEventListener('blur', () => {
        if (debouncedHandleInput.cancel) debouncedHandleInput.cancel();
        closeDropdown();
    });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') {
            if (localDropdown.classList.contains('active')) {
                let selectedVal = null; const items = localDropdown.querySelectorAll('li:not(.item-no-match)');
                if (currentFocusIdx > -1 && items[currentFocusIdx]) { selectedVal = items[currentFocusIdx].innerText; } else if (items.length > 0) { selectedVal = items[0].innerText; }
                if (selectedVal) {
                    input.dataset.programmatic = "true";
                    input.value = selectedVal;
                    input.dispatchEvent(new Event('input'));
                    input.dispatchEvent(new Event('change'));
                    
                    // 탭 선택 즉시 fetchCardByNumber(input, true)를 통해 전체 셋업 및 하이퍼링크 매핑 완료
                    fetchCardByNumber(input, true);
                    
                    setTimeout(() => { delete input.dataset.programmatic; }, 200);
                }
                closeDropdown();
            } return;
        }
        if (!localDropdown.classList.contains('active')) return;
        const items = localDropdown.querySelectorAll('li:not(.item-no-match)');
        if (e.key === 'ArrowDown') { e.preventDefault(); currentFocusIdx++; if (currentFocusIdx >= items.length) currentFocusIdx = 0; updateHighlight(items, currentFocusIdx); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); currentFocusIdx--; if (currentFocusIdx < 0) currentFocusIdx = items.length - 1; updateHighlight(items, currentFocusIdx); }
        else if (e.key === 'Enter') { if (currentFocusIdx > -1 && items[currentFocusIdx]) { e.preventDefault(); items[currentFocusIdx].click(); } }
        else if (e.key === 'Escape') { closeDropdown(); }
    });
}

/**
 * 드롭다운의 위치 및 데스크톱 카드 스타일을 공통으로 설정하는 헬퍼 함수.
 * setupCardNameAutocomplete, setupGlobalCardNameAutocomplete,
 * setupCardNoAutocomplete, setupCustomDropdown에서 공통 호출됩니다.
 */
function positionDropdown(localDropdown, wrapper) {
    const rect = wrapper.getBoundingClientRect();
    const isDesktopCard = !!wrapper.closest('.desktop-info-card');
    const offset = isDesktopCard ? 6 : 0;
    const scrollTop = window.pageYOffset || document.documentElement.scrollTop || 0;
    const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft || 0;
    localDropdown.style.top = (rect.bottom + scrollTop + offset) + 'px';
    localDropdown.style.left = (rect.left + scrollLeft) + 'px';
    if (isDesktopCard) {
        localDropdown.classList.add('desktop-card-dropdown');
        localDropdown.style.width = 'max-content';
        localDropdown.style.minWidth = rect.width + 'px';
    } else {
        localDropdown.classList.remove('desktop-card-dropdown');
        localDropdown.style.width = rect.width + 'px';
        localDropdown.style.minWidth = '';
    }
}

function updateInputAutoWidth(inputEl) {
    if (!inputEl) return;
    const field = inputEl.dataset.field;
    if (field !== 'rare' && field !== 'loc' && field !== 'to' && field !== 'illust') return;
    if (!inputEl.classList.contains('desktop-card-input')) return;
    const wrapper = inputEl.closest('.custom-select-wrapper');
    if (!wrapper) return;

    let span = document.getElementById('input-width-tester');
    if (!span) {
        span = document.createElement('span');
        span.id = 'input-width-tester';
        span.style.position = 'absolute';
        span.style.visibility = 'hidden';
        span.style.whiteSpace = 'pre';
        span.style.height = '0';
        span.style.overflow = 'hidden';
        document.body.appendChild(span);
    }

    const styles = window.getComputedStyle(inputEl);
    span.style.fontSize = styles.fontSize;
    span.style.fontFamily = styles.fontFamily;
    span.style.fontWeight = styles.fontWeight;
    span.style.letterSpacing = styles.letterSpacing;

    const textVal = inputEl.value || inputEl.placeholder || '';
    span.textContent = textVal;

    const paddingLeft = parseFloat(styles.paddingLeft) || 0;
    const paddingRight = parseFloat(styles.paddingRight) || 0;

    let extraSpace = paddingLeft + paddingRight;
    const arrow = wrapper.querySelector('.arrow-icon');
    const hasArrow = arrow && window.getComputedStyle(arrow).display !== 'none';
    if (hasArrow) {
        extraSpace += 15;
    } else {
        extraSpace += 8;
    }

    const textWidth = span.getBoundingClientRect().width;
    let minWidth = 50;
    if (field === 'rare') minWidth = 70;
    else if (field === 'illust') minWidth = 80;
    else if (field === 'loc' || field === 'to') minWidth = 120;

    const finalWidth = Math.max(textWidth + extraSpace + 10, minWidth);

    wrapper.style.width = finalWidth + 'px';
    wrapper.style.flex = 'none';
}

function getQueryTarget(row) {
    if (row && row.classList.contains('mobile-info-card')) {
        if (currentEditingRowIndex !== -1) {
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
        let listContainerId = 'mobile-cards-list-general';
        if (UIStore.mode === 'add') {
            if (addSubMode === 'pack') listContainerId = 'mobile-cards-list-pack';
            else if (addSubMode === 'deck') listContainerId = 'mobile-cards-list-deck';
        } else if (UIStore.mode === 'move') {
            listContainerId = 'mobile-cards-list-move';
        } else if (UIStore.mode === 'discard') {
            listContainerId = 'mobile-cards-list-discard';
        }
        const listContainer = document.getElementById(listContainerId);
        if (listContainer && currentEditingRowIndex !== -1) {
            const cards = listContainer.querySelectorAll('.mobile-info-card');
            return cards[currentEditingRowIndex] || null;
        }
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

    if (wrapper.classList.contains('no-arrow')) {
        const arrow = wrapper.querySelector('.arrow-icon');
        if (arrow) {
            arrow.style.display = 'none';
            arrow.style.pointerEvents = 'none';
        }
        return;
    }

    const arrow = wrapper.querySelector('.arrow-icon');
    if (arrow) {
        if (isFree || count >= 2) {
            arrow.style.display = '';
            arrow.style.pointerEvents = '';
        } else {
            arrow.style.display = 'none';
            arrow.style.pointerEvents = 'none';
        }
    }
}

function setupCustomDropdown(wrapper, changeCallback) {
    const input = wrapper.querySelector('.custom-input');
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
        localDropdown.className = 'global-dropdown custom-options';
        const expansionBg = wrapper.querySelector('.search-expansion-bg');
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
        if (wrapper.id === 'wrap-auto-loc') {
            wrapper.style.setProperty('--dropdown-height', '0px');
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
    const clearBtn = wrapper.querySelector('.clear-btn');
    if (clearBtn) {
        // mousedown 시 e.preventDefault()로 blur 방지
        clearBtn.onmousedown = (e) => {
            e.preventDefault();
        };
        clearBtn.onclick = (e) => {
            e.stopPropagation();
            input.value = "";
            input.dataset.confirmed = "false";
            delete input.dataset.raw;
            wrapper.classList.remove('has-value', 'active-highlight', 'error-highlight');
            if (wrapper.id === 'wrap-auto-loc') wrapper.style.setProperty('--dropdown-height', '0px');
            updateInputAutoWidth(input);
            if (wrapper._changeCallback) wrapper._changeCallback(input);
            input.focus();
            closeDropdown();
        };
    }

    const openDropdown = () => {
        if (UIStore.pendingBlurFn && UIStore.activeDropdownInput === input) { clearTimeout(UIStore.pendingBlurFn); UIStore.pendingBlurFn = null; }
        if (input.hasAttribute('readonly') && !input.value && (!wrapper.dataset.options || wrapper.dataset.options === "[]") && !isFreeType) return;
        if (input.disabled) return;

        // 옵션이 2개 미만(0~1개)인 경우 드롭다운UI 노출 차단
        const rawData = JSON.parse(wrapper.dataset.options || "[]");
        if (input.classList.contains('page-card-no') && rawData.length < 2) return;

        if (UIStore.activeDropdownInput && UIStore.activeDropdownInput !== input) { UIStore.activeDropdownInput.blur(); }
        UIStore.activeDropdownInput = input;

        // [격리 로직] 자동 입력란인 경우에만 전용 클래스 부여 및 강조 제거
        const isAutoLoc = (wrapper.id === 'wrap-auto-loc');
        if (isAutoLoc) {
            localDropdown.classList.add('auto-loc-mode');
        } else {
            localDropdown.classList.remove('auto-loc-mode');
        }

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

        // 보관 위치 자동 입력란용 확장 배경 높이 연동
        if (wrapper.id === 'wrap-auto-loc') {
            // 구조 변경으로 인해 렌더링 딜레이가 있을 수 있으므로 약간의 지연 유지 혹은 높이 강제 재계산
            requestAnimationFrame(() => {
                const itemsCount = localDropdown.querySelectorAll('li').length;
                if (itemsCount > 0) {
                    // 아이템 높이(약 33px) * 개수 + 패딩(상5+하15=20px). 최대 5개(약 185px)
                    const itemHeight = 33;
                    const padding = 20;
                    // 5개 넘어가면 스크롤이 생기도록 함. 
                    const calculatedHeight = Math.min(itemsCount * itemHeight + padding, 5.5 * itemHeight);
                    wrapper.style.setProperty('--dropdown-height', calculatedHeight + 'px');
                }
            });
        }
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
            li.className = 'custom-option item-no-match';

            let noResultText = '존재하지 않는 데이터';
            if (wrapper.id === 'wrap-auto-loc' ||
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
                li.className = 'custom-option';
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
        if (wrapper.id !== 'wrap-auto-loc') {
            positionDropdown(localDropdown, wrapper);
            if (!localDropdown.parentNode) document.body.appendChild(localDropdown);
        }

        localDropdown.classList.add('active');

        // [2단계 지시] 드롭다운 내용이 바뀔 때마다 높이 실시간 재계산
        if (wrapper.id === 'wrap-auto-loc') {
            requestAnimationFrame(() => {
                const itemsCount = localDropdown.querySelectorAll('li').length;
                if (itemsCount > 0) {
                    const itemHeight = 33;
                    const padding = 20;
                    const calculatedHeight = Math.min(itemsCount * itemHeight + padding, 5.5 * itemHeight);
                    wrapper.style.setProperty('--dropdown-height', calculatedHeight + 'px');
                } else {
                    wrapper.style.setProperty('--dropdown-height', '0px');
                }
            });
        }
    };
    const selectOption = (optData) => {
        if (input.classList.contains('move-card-from') || input.classList.contains('discard-card-loc') || input.classList.contains('desktop-card-loc')) {
            input.value = optData.val;
        } else {
            input.value = optData.text;
        }

        input.dataset.raw = optData.val;
        if (optData.max) { input.dataset.maxQty = optData.max; }
        if (wrapper.id === 'wrap-auto-loc') {
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
        const illust = illustInp ? illustInp.value : "";

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
                    input.placeholder = "일러스트 선택";
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
        // [핵심] 타자 도중에 즉각 렌더링되는 현상 방지 (번호 입력란 전용)
        if (wrapper._changeCallback && !input.classList.contains('page-card-no')) {
            wrapper._changeCallback(input);
        }
        delete input.dataset.raw;
        updateInputAutoWidth(input);
        const rawData = JSON.parse(wrapper.dataset.options || "[]"); if (rawData.length === 1 && !isFreeType) { input.value = rawData[0].val; updateInputAutoWidth(input); return; } if (!wrapper.classList.contains('active')) wrapper.classList.add('active'); currentFocusIdx = -1; renderGlobalDropdown(true);
    });
    input.addEventListener('keydown', (e) => {
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
                if (wrapper.id === 'wrap-auto-loc' && input.value.trim().length > 0) {
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
            if (wrapper.id === 'wrap-auto-loc') {
                input.value = "";
                input.dataset.confirmed = "false";
                wrapper.classList.remove('has-value', 'active-highlight', 'error-highlight');
                wrapper.style.setProperty('--dropdown-height', '0px');
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
                        input.placeholder = "일러스트 선택";
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
    const target = getQueryTarget(row);
    const illustInp = target.querySelector('.move-card-illustration, .desktop-card-illust, [data-field="illust"]'); const rareInp = target.querySelector('.move-card-rarity, .desktop-card-rare, [data-field="rare"]'); const fromInp = target.querySelector('.move-card-from, .desktop-card-loc, [data-field="loc"]'); const qtyInput = target.querySelector('.move-card-qty, .desktop-card-qty, [data-field="qty"]');
    const illustWrap = illustInp ? illustInp.closest('.custom-select-wrapper') : null; const rareWrap = rareInp ? rareInp.closest('.custom-select-wrapper') : null; const fromWrap = fromInp ? fromInp.closest('.custom-select-wrapper') : null;
    if (illustWrap) { illustWrap.classList.remove('single-option'); illustWrap.classList.add('no-option'); }
    if (rareWrap) { rareWrap.classList.remove('single-option'); rareWrap.classList.add('no-option'); }
    if (fromWrap) { fromWrap.classList.remove('single-option'); fromWrap.classList.add('no-option'); }

    if (qtyInput) qtyInput.setAttribute('readonly', true);
    if (level === 'no') { 
        illustInp.value = ""; illustInp.setAttribute('readonly', true); if (illustWrap) illustWrap.dataset.options = "[]"; 
        rareInp.value = ""; rareInp.setAttribute('readonly', true); if (rareWrap) rareWrap.dataset.options = "[]"; delete rareInp.dataset.raw; 
        fromInp.value = ""; if (fromWrap) fromWrap.dataset.options = "[]"; delete fromInp.dataset.raw; qtyInput.value = ''; 
    }

    if (document.documentElement.classList.contains('is-mobile-device')) {
        renderMobileCards();
    }
}
function updateMoveIllusts(row, matches) {
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
    illustInp.removeAttribute('readonly'); illustWrap.classList.remove('no-option');
    setupDropdownForField(illustInp, illustWrap);
    const currentVal = illustInp.value; const isValid = options.some(o => o.val === currentVal);
    if (isValid) { handleMoveIllustChange(illustInp); } else { if (options.length === 0) { illustInp.value = ""; illustWrap.classList.add('no-option'); } else if (options.length === 1) { illustWrap.classList.add('single-option'); illustInp.value = options[0].val; handleMoveIllustChange(illustInp); } else { illustInp.value = ""; illustWrap.classList.remove('single-option'); handleMoveIllustChange(illustInp); } }

    if (document.documentElement.classList.contains('is-mobile-device')) {
        renderMobileCards();
    }
}
function handleMoveIllustChange(input) {
    const row = getRowFromInput(input);
    const target = getQueryTarget(row);
    const cardNoInp = target.querySelector('.move-card-no, [data-field="no"]');
    const cardNo = cardNoInp ? cardNoInp.value.trim() : "";
    const selectedIllust = input.value;
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
    const illust = illustInp ? illustInp.value : "";
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
    const selectedIllust = illustInp ? illustInp.value : "";
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
    const cardClass = isMobile ? '.mobile-info-card' : '.desktop-info-card';
    
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
    const illust = illustInp ? illustInp.value.trim() : '';
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
    const illust = illustInp ? illustInp.value : "";
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
    const modal = document.getElementById('move-result-modal'); const iconArea = document.getElementById('move-icon-area'); const successText = document.getElementById('move-success-text'); const summaryBody = document.getElementById('move-summary-body'); const detailBody = document.getElementById('move-result-body');

    const titleEl = document.getElementById('move-modal-title');

    summaryBody.innerHTML = ''; detailBody.innerHTML = ''; let successCount = 0; let failCount = 0; let successQty = 0;

    moves.forEach(m => {
        if (m.status === 'fail') { failCount++; }
        else { successCount++; successQty += m.moveQty; }
    });

    if (successCount > 0) { titleEl.innerText = "카드 이동 완료!"; }
    else { titleEl.innerText = "카드 이동 실패!"; }

    modal.dataset.hasSuccess = (successCount > 0) ? "true" : "false";

    if (failCount === 0 && successCount > 0) { iconArea.innerHTML = '<i class="material-icons" style="color: var(--success-green);">check_circle</i>'; successText.innerHTML = `<span style="color:var(--text-primary);">${successQty}장 성공, ${failCount}건 실패</span>`; }
    else if (successCount === 0 && failCount > 0) { iconArea.innerHTML = '<i class="material-icons" style="color: var(--error-red);">cancel</i>'; successText.innerHTML = `<span style="color:var(--error-red);">${successQty}장 성공, ${failCount}건 실패</span>`; }
    else if (successCount > 0 && failCount > 0) { iconArea.innerHTML = '<i class="material-icons" style="color: var(--warning-yellow);">warning</i>'; successText.innerHTML = `<span>${successQty}장 성공, ${failCount}건 실패</span>`; }

    if (isFullSynced) {
        successText.innerHTML += `<div style="margin-top:8px; color:var(--warning-yellow); font-weight:bold; display:block;">외부 수정이 감지되어 전체 동기화가 진행되었습니다.</div>`;
    }

    const successMoves = moves.filter(m => m.status !== 'fail');
    if (successMoves.length > 0) { const nameAgg = {}; successMoves.forEach(m => { if (!nameAgg[m.cardName]) nameAgg[m.cardName] = 0; nameAgg[m.cardName] += m.moveQty; }); for (const [name, qty] of Object.entries(nameAgg)) { summaryBody.innerHTML += `<tr style="background-color: var(--bg-success);"><td>${escapeHTML(name)}</td><td style="color:var(--success-green); font-weight:700;">${escapeHTML(qty)}장</td></tr>`; } }

    const failMoves = moves.filter(m => m.status === 'fail');
    if (failMoves.length > 0) {
        const failAgg = {}; failMoves.forEach(m => {
            let reason = "알 수 없는 오류"; const maxQty = m.maxQty || 0;
            if (!m.cardName) reason = "카드 이름 오류";
            else if (!m.cardNo || !cardCacheInstance.getOwnedNumbers().includes(m.cardNo)) reason = "카드 번호 오류";
            else if (!m.illustration) reason = "일러스트 오류";
            else if (!m.rarity) reason = "레어도 오류";
            else if (!m.currentLoc) reason = "보관 위치 오류";
            else if (!m.targetLoc) reason = "이동 위치 오류";
            else if (!m.moveQty || m.moveQty < 1 || m.moveQty > maxQty) reason = "수량 오류";

            if (!failAgg[reason]) failAgg[reason] = 0; failAgg[reason]++;
        });
        for (const [reason, count] of Object.entries(failAgg)) { summaryBody.innerHTML += `<tr style="background-color: var(--bg-fail);"><td style="color:var(--error-red);">${escapeHTML(reason)}</td><td style="color:var(--error-red); font-weight:700;">${escapeHTML(count)}건</td></tr>`; }
    }

    moves.forEach((move, idx) => {
        const tr = document.createElement('tr');
        let locTxt = `${move.currentLoc} ► ${move.targetLoc}`;
        let qtyTxt = move.moveQty;
        let illustrationTxt = move.illustration;
        let rarityTxt = getLocalizedRarity(move.rarity);
        let cardNoStyle = ''; let nameStyle = ''; let illustrationStyle = ''; let rarityStyle = ''; let locStyle = ''; let qtyStyle = '';

        if (!move.cardNo || !cardCacheInstance.getOwnedNumbers().includes(move.cardNo)) {
            move.cardNo = "오류"; cardNoStyle = 'color:var(--error-red); font-weight:700;';
            illustrationTxt = "-"; rarityTxt = "-"; locTxt = "-"; qtyTxt = "-";
        }
        else if (!move.illustration) {
            illustrationTxt = "미선택"; illustrationStyle = 'color:var(--error-red); font-weight:700;';
            rarityTxt = "-"; locTxt = "-"; qtyTxt = "-";
        }
        else if (!move.rarity) {
            rarityTxt = "미선택"; rarityStyle = 'color:var(--error-red); font-weight:700;';
            locTxt = "-"; qtyTxt = "-";
        }
        else if (!move.currentLoc) {
            locTxt = "보관 위치 오류"; locStyle = 'color:var(--error-red); font-weight:700;';
            qtyTxt = "-";
        }
        else if (!move.targetLoc) {
            locTxt = "이동 위치 오류"; locStyle = 'color:var(--error-red); font-weight:700;';
            qtyTxt = "-";
        }
        else if (!move.moveQty || move.moveQty < 1) {
            qtyTxt = "오류"; qtyStyle = 'color:var(--error-red); font-weight:700;';
        }

        tr.innerHTML = `<td>${idx + 1}</td><td style="${nameStyle}">${escapeHTML(move.cardName)}</td><td style="${cardNoStyle}">${escapeHTML(move.cardNo)}</td><td style="${illustrationStyle}">${escapeHTML(illustrationTxt)}</td><td style="${rarityStyle}">${escapeHTML(rarityTxt)}</td><td style="${locStyle}">${escapeHTML(locTxt)}</td><td style="${qtyStyle}">${escapeHTML(qtyTxt)}</td>`;
        detailBody.appendChild(tr);
    });

    // applyModalDetailUI에서 레이아웃을 결정하므로 개별 display 및 icon 설정 제거
    toggleBackgroundInert(true); M.Modal.getInstance(modal).open();
    // 사용자 설정에 맞게 상세/요약 레이아웃 초기화
    setTimeout(() => applyModalDetailUI(UserStore.settings.isDetailMode), 50);
}

async function finishMoveProcess() {
    const modal = document.getElementById('move-result-modal');
    const hasSuccess = modal.dataset.hasSuccess === "true";

    M.Modal.getInstance(modal).close();
    toggleBackgroundInert(false);

    const isMobile = document.documentElement.classList.contains('is-mobile-device');
    const containerId = isMobile ? 'mobile-cards-list-move' : 'desktop-cards-list-move';
    const cardClass = isMobile ? '.mobile-info-card' : '.desktop-info-card';
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
    const submitBtn = document.getElementById('move-submit-main-btn');
    if (submitBtn && submitBtn.classList.contains('disabled')) return;

    const entries = [];
    const isMobile = document.documentElement.classList.contains('is-mobile-device');

    if (isMobile) {
        const listContainer = document.getElementById('mobile-cards-list-move');
        if (listContainer) {
            const cards = listContainer.querySelectorAll('.mobile-info-card');
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
            const cards = listContainer.querySelectorAll('.desktop-info-card');
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
        if (!rarity || !currentLoc || !targetLoc || !moveQty || moveQty < 1) isValid = false;
        if (moveQty > maxQty) isValid = false;

        if (!isValid) {
            failCount++;
            el.dataset.moveStatus = 'fail';
        } else {
            el.dataset.moveStatus = 'pending';
        }
        moves.push({ cardNo, cardName, rarity, illustration: illustration, currentLoc, targetLoc, moveQty, maxQty, status: isValid ? 'pending' : 'fail' });
    });

    if (moves.length === 0) { showToast('이동할 카드가 없습니다.', 'toast-warn'); return; }

    if (!UserStore.user) {
        savePendingFormData();
        toggleAuthModal(true);
        return;
    }
    if (failCount === moves.length) { showMoveResultModal(moves); return; }

    showLoading(true, "카드 이동 중...");
    const pendingMoves = moves.filter(m => m.status === 'pending');
    try {
        const res = await callApi('moveCards', buildAuthPayload(), { moves: pendingMoves });
        showLoading(false);
        if (res.success) {
            updateLocalInventory(res.updatedItems);
            if (res.locations !== undefined) {
                cardCacheInstance.setSummary(res.amount, res.locations, res.rarities);
                updateTotals();
                renderHomeDash();
            }
            syncCounter++;

            entries.forEach(item => { if (item.el.dataset.moveStatus === 'pending') item.el.dataset.moveStatus = 'success'; });
            moves.forEach(m => { if (m.status === 'pending') m.status = 'success'; });
            showMoveResultModal(moves);
        } else {
            entries.forEach(item => { if (item.el.dataset.moveStatus === 'pending') item.el.dataset.moveStatus = 'fail'; });
        }
    } catch (e) {
        showLoading(false);
        entries.forEach(item => { if (item.el.dataset.moveStatus === 'pending') item.el.dataset.moveStatus = 'fail'; });
    }
}

async function submitBulkMoveEntries() {
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

    showLoading(true, "일괄 이동 대상 조회 중...");
    const moves = [];

    try {
        // Firestore 직접 조회 대신 이미 클라이언트 캐시에 로드된 inventory 인메모리 캐시 데이터를 즉시 활용
        const inventory = cardCacheInstance._inventory || [];
        
        inventory.forEach(row => {
            const cardName = row[0];
            const cardNo = row[1];
            const rarity = row[2];
            const qty = row[3];
            const loc = row[4];
            const illustration = row[5];

            if (loc === fromLoc && qty > 0) {
                moves.push({
                    cardNo: cardNo,
                    cardName: cardName || "Unknown",
                    rarity: rarity || "",
                    illustration: illustration || "",
                    currentLoc: fromLoc,
                    targetLoc: toLoc,
                    moveQty: qty,
                    maxQty: qty,
                    status: 'pending'
                });
            }
        });

        if (moves.length === 0) {
            showLoading(false);
            showToast('이동할 카드가 없습니다.', 'toast-warn');
            return;
        }

        // 3. API 전송
        showLoading(true, "카드 일괄 이동 중...");
        const res = await callApi('moveCards', buildAuthPayload(), { moves });

        showLoading(false);
        if (res.success) {
            updateLocalInventory(res.updatedItems);
            if (res.locations !== undefined) {
                cardCacheInstance.setSummary(res.amount, res.locations, res.rarities);
                updateTotals();
                renderHomeDash();
            }
            syncCounter++;

            moves.forEach(m => { m.status = 'success'; });

            // 모드 해제
            toggleRenameMode();

            // 결과 창 표시
            showMoveResultModal(moves);
        } else {
            moves.forEach(m => { m.status = 'fail'; });
            showMoveResultModal(moves);
        }
    } catch (error) {
        console.error("Bulk move error:", error);
        showLoading(false);
        showToast('일괄 이동 중 오류가 발생했습니다.', 'toast-error');
    }
}

function adjustStepQty(btn, delta) {
    const container = btn.closest('.qty-stepper-container, .desktop-qty-wrapper');
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

/**
 * URL 파라미터 기반 자동 검색 및 주입 기능을 수행합니다.
 */
function handleAutomationParams(params) {
    if (!params) return;
    const { name, loc, code } = params;

    // [보완] 이미 해당 파라미터로 검색이 완료되었거나 표가 제작된 상태라면 중복 실행 방지
    if (UIStore.chipState.add === 'pack' && name) {
        const packInput = document.getElementById('pack-search-input');
        const isAlreadyProcessed = (PackDeckStore.isPackTableGenerated && PackDeckStore.currentPackInfo && PackDeckStore.currentPackInfo.packName === name);
        // [버그 수정] 검색 결과만 있고 표는 없는 상태에서도 같은 팩이면 검색 재실행 방지
        const isSearchAlreadyDone = (!PackDeckStore.isPackTableGenerated && PackDeckStore.currentPackInfo && PackDeckStore.currentPackInfo.packName === name && !loc);
        if (packInput && !isAlreadyProcessed && !isSearchAlreadyDone) {
            packInput.value = name;
            // loc이 있을 때만 즉시 실행(표 제작까지), 없으면 검색만 수행
            handlePackSearch(!!loc, name, loc);
        }
    } else if (UIStore.chipState.add === 'deck' && code) {
        const deckInput = document.getElementById('deck-code-input');
        const isSearchAlreadyDone = (PackDeckStore.currentDeckName === code && typeof PackDeckStore.isDeckTableGenerated !== 'undefined' && PackDeckStore.isDeckTableGenerated);
        if (deckInput && !isSearchAlreadyDone) {
            deckInput.value = code;
            const clearBtn = document.getElementById('deck-clear-btn');
            if (clearBtn) clearBtn.style.display = 'block';
            // UI 렌더링 및 애니메이션 대기 후 검색 실행
            setTimeout(() => {
                handleDeckSearch();
            }, 300);
        }
    }
}

/**
 * 보유 현황 대시보드 통계를 업데이트합니다.
 */
function updateDashboardStats() {

    // 1. 기본 통계 (수량, 종류)
    const totalCount = cardCacheInstance.getAmount();
    const kindCount = cardCacheInstance.getOwnedNumbers().length;

    const invTotalElem = document.getElementById('inv-total-cards');
    const invKindElem = document.getElementById('inv-kind-cards');
    if (invTotalElem) invTotalElem.innerText = totalCount;
    if (invKindElem) invKindElem.innerText = kindCount;

    // 2. 상세 통계 (위치별, 레어도별)
    const locations = cardCacheInstance.getLocationsMap();
    const rarities = cardCacheInstance.getRaritiesMap();

    const locStats = document.getElementById('inv-location-stats');
    const rareStats = document.getElementById('inv-rarity-stats');

    if (locStats) {
        let locHtml = "";
        const locKeys = Object.keys(locations).sort((a, b) => locations[b].length - locations[a].length);
        if (locKeys.length === 0) {
            locHtml = '<div style="width:100%; padding:20px; text-align:center; color:var(--text-muted); border-bottom:1px solid var(--border-color);">데이터가 없습니다.</div>';
        } else {
            locKeys.forEach((loc, idx) => {
                const count = locations[loc].length;
                const hiddenClass = idx >= 3 ? "is-hidden" : "";
                locHtml += `<div class="stat-item ${hiddenClass}"><span class="stat-name">${loc}</span><span class="stat-cnt">${count}종</span></div>`;
            });
            if (locKeys.length > 3) {
                locHtml += `<button class="stat-more-btn" onclick="toggleStatSection(this)"><span>더보기</span><i class="material-icons">expand_more</i></button>`;
            }
        }
        locStats.innerHTML = locHtml;
    }

    if (rareStats) {
        let rareHtml = "";
        const rareKeys = Object.keys(rarities).sort((a, b) => compareRarity(b, a));
        if (rareKeys.length === 0) {
            rareHtml = '<div style="width:100%; padding:20px; text-align:center; color:var(--text-muted); border-bottom:1px solid var(--border-color);">데이터가 없습니다.</div>';
        } else {
            rareKeys.forEach((rare, idx) => {
                const count = rarities[rare];
                const hiddenClass = idx >= 3 ? "is-hidden" : "";
                rareHtml += `<div class="stat-item ${hiddenClass}"><span class="stat-name">${getLocalizedRarity(rare)}</span><span class="stat-cnt">${count}장</span></div>`;
            });
            if (rareKeys.length > 3) {
                rareHtml += `<button class="stat-more-btn" onclick="toggleStatSection(this)"><span>더보기</span><i class="material-icons">expand_more</i></button>`;
            }
        }
        rareStats.innerHTML = rareHtml;
    }

    // [삭제] 수동 높이 제어 로직 (CSS Grid 애니메이션으로 대체)
    /*
    if (UIStore.mode === 'inventory' && UIStore.inventoryMode === 'dashboard') {
        const wrapper = document.getElementById('inventory-mode-forms');
        const targetEl = document.getElementById('form-inventory-dashboard');
        if (wrapper && targetEl) {
            requestAnimationFrame(() => {
                const height = targetEl.scrollHeight + 5;
                wrapper.style.height = height + 'px';
            });
        }
    }
    */
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
    const segmentControl = document.querySelector('#inventory-content-area .segment-control');
    if (!wrapper) return;

    if (instant && segmentControl) {
        segmentControl.classList.add('no-transition');
    }

    forms.forEach(f => {
        const el = document.getElementById(`form-inventory-${f}`);
        if (!el) return;

        if (f === mode) {
            el.classList.remove('anim-hidden');
            el.classList.add('anim-active');
        } else {
            el.classList.remove('anim-active');
            el.classList.add('anim-hidden');
        }
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



// Initialize Search Button Blur Listeners
function initSearchButtonBlurListeners() {
    // [추가] 검색 버튼 클릭 시 포커스 자동 해제 (정적 요소)
    const buttonsToBlur = [
        'pack-search-btn', 'deck-search-btn'
    ];
    buttonsToBlur.forEach(id => {
        const btn = document.getElementById(id);
        if (btn) {
            btn.addEventListener('click', () => btn.blur());
        }
    });

    // [이벤트 위임] 공통 하단 푸터 내 동적 생성 버튼들의 포커스 해제
    const footer = document.getElementById('manage-common-footer');
    if (footer) {
        footer.addEventListener('click', (e) => {
            if (e.target && e.target.tagName === 'BUTTON') {
                e.target.blur();
            }
        });
    }
}

// -----------------------------------------------------------------------------
// 팩 검색 자동 완성 로직
// -----------------------------------------------------------------------------
function setupPackNameAutocomplete(wrapper) {
    const input = wrapper.querySelector('input');
    let currentFocusIdx = -1;
    let pendingBlurFn = null;
    let activeDropdownInput = null;

    let localDropdown = wrapper._dropdown;
    if (!localDropdown) {
        localDropdown = document.createElement('ul');
        localDropdown.className = 'global-dropdown custom-options';
        document.body.appendChild(localDropdown);
        wrapper._dropdown = localDropdown;
    }

    const closeDropdown = () => {
        wrapper.classList.remove('active');
        input.classList.remove('active');
        localDropdown.classList.remove('active');
        if (activeDropdownInput === input) {
            currentFocusIdx = -1;
            activeDropdownInput = null;
        }
    };

    const renderDropdown = (filtered) => {
        wrapper.classList.add('active');
        input.classList.add('active');
        localDropdown.classList.add('active');
        localDropdown.innerHTML = "";

        if (filtered.length === 0) {
            const li = document.createElement('li');
            li.className = 'custom-option item-no-match';
            li.innerText = '팩 이름 확인';
            localDropdown.appendChild(li);
        } else {
            filtered.forEach(name => {
                const li = document.createElement('li');
                li.className = 'custom-option';
                li.innerText = name;
                li.onmousedown = (e) => e.preventDefault();
                li.onclick = () => {
                    input.value = name;
                    closeDropdown();
                    const clearBtn = document.getElementById('pack-clear-btn');
                    if (clearBtn) clearBtn.style.display = 'block';
                    handlePackSearch(false);
                };
                localDropdown.appendChild(li);
            });
        }

        const rect = input.getBoundingClientRect();
        localDropdown.style.top = (rect.bottom + window.scrollY) + 'px';
        localDropdown.style.left = (rect.left + window.scrollX) + 'px';
        localDropdown.style.width = rect.width + 'px';

        localDropdown.classList.add('active');
    };

    input.addEventListener('input', () => {
        activeDropdownInput = input;
        const query = input.value.replace(/\s+/g, '').toLowerCase();
        if (!query) {
            closeDropdown();
            return;
        }

        const allPackNames = getAllPackNames();
        let matches = allPackNames.filter(name => {
            if (!name || typeof name !== 'string') return false;
            return Hangul.search(name.replace(/\s+/g, '').toLowerCase(), query) !== -1;
        });

        matches = matches.slice(0, 10);
        renderDropdown(matches);
    });

    input.addEventListener('focus', () => {
        activeDropdownInput = input;
        if (pendingBlurFn && activeDropdownInput === input) { clearTimeout(pendingBlurFn); pendingBlurFn = null; }
        const allPackNames = getAllPackNames();

        const query = input.value.replace(/\s+/g, '').toLowerCase();
        let matches = [];
        if (query) {
            matches = allPackNames.filter(name => {
                if (!name || typeof name !== 'string') return false;
                return Hangul.search(name.replace(/\s+/g, '').toLowerCase(), query) !== -1;
            });
        } else {
            matches = allPackNames;
        }
        matches = matches.slice(0, 10);
        renderDropdown(matches);
    });

    input.addEventListener('blur', () => { closeDropdown(); });
    input.addEventListener('keydown', (e) => {
        if (!localDropdown.classList.contains('active')) return;

        const items = localDropdown.querySelectorAll('li');
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
            e.preventDefault();
            if (currentFocusIdx >= 0 && currentFocusIdx < items.length) {
                items[currentFocusIdx].click();
            } else if (items.length > 0 && !items[0].classList.contains('item-no-match')) {
                items[0].click();
            } else {
                input.blur();
            }
        } else if (e.key === 'Escape') {
            closeDropdown();
        } else if (e.key === 'Tab') {
            if (e.isComposing) return;
            let selectedVal = null;
            if (currentFocusIdx > -1 && items[currentFocusIdx]) {
                selectedVal = items[currentFocusIdx].innerText;
            } else if (items.length > 0 && !items[0].classList.contains('item-no-match')) {
                selectedVal = items[0].innerText;
            }
            if (selectedVal) {
                input.value = selectedVal;
                const clearBtn = document.getElementById('pack-clear-btn');
                if (clearBtn) clearBtn.style.display = 'block';
                handlePackSearch(false);
            }
            closeDropdown();
        }
    });

    function updateHighlight(items, index) {
        items.forEach(item => item.classList.remove('highlighted'));
        if (index >= 0 && index < items.length) {
            items[index].classList.add('highlighted');
        }
    }
}

// -----------------------------------------------------------------------------
// 팩 검색 및 등록 로직
// -----------------------------------------------------------------------------
function initPackSearch() {
    const input = document.getElementById('pack-search-input');
    const btn = document.getElementById('pack-search-btn');
    const clearBtn = document.getElementById('pack-clear-btn');

    const deckInput = document.getElementById('deck-code-input');
    const deckBtn = document.getElementById('deck-search-btn');
    const deckClearBtn = document.getElementById('deck-clear-btn');

    if (input && btn && !input._isInputBound) {
        input._isInputBound = true;
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') handlePackSearch(false);
            if (e.key === 'Escape') resetPackMode(true);
        });
        input.addEventListener('input', () => {
            if (clearBtn) clearBtn.style.display = input.value ? 'block' : 'none';
        });
        btn.addEventListener('click', () => handlePackSearch(false));
        if (clearBtn) {
            clearBtn.addEventListener('click', () => resetPackMode(true));
        }
    }

    if (deckInput && deckBtn && !deckInput._isInputBound) {
        deckInput._isInputBound = true;
        deckInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') handleDeckSearch();
            if (e.key === 'Escape') resetDeckMode(true);
        });
        deckInput.addEventListener('input', () => {
            if (deckClearBtn) deckClearBtn.style.display = deckInput.value ? 'block' : 'none';
        });
        deckBtn.addEventListener('click', () => handleDeckSearch());
        if (deckClearBtn) {
            deckClearBtn.addEventListener('click', () => resetDeckMode(true));
        }
    }



    const packWrapper = document.getElementById('pack-search-content');
    if (packWrapper) {
        setupPackNameAutocomplete(packWrapper);
    }

    // 초기 상태 설정
    if (UIStore.chipState.add === 'general') {
        resetPackMode();
        resetDeckMode();
    }
}



function togglePackTable() {
    const genBtn = document.getElementById('manage-gen-btn');
    if (genBtn) genBtn.blur();

    if (PackDeckStore.isPackTableGenerated) {
        resetPackMode();
    } else {
        if (PackDeckStore.currentPackInfo) {
            // 복수 검색기 결과를 선택한 경우
            if (PackDeckStore.currentPackInfo.isPendingSelection) {
                const selectedRadio = document.querySelector('input[name="packLangSelect"]:checked');
                if (selectedRadio) {
                    PackDeckStore.currentPackInfo.packId = selectedRadio.dataset.url;
                    PackDeckStore.currentPackInfo.validLocale = selectedRadio.value;

                    const totalFromRadio = parseInt(selectedRadio.dataset.total) || 100;
                    PackDeckStore.currentPackInfo.totalCards = totalFromRadio; // 선택한 언어 버전의 총 카드 수량 즉시 동기화
                    generatePackRowsNew(totalFromRadio, PackDeckStore.currentPackInfo.packName, PackDeckStore.currentPackInfo.packId);

                    // 필요 시 백그라운드 크롤링 병행 (데이터 보강용)
                    const count = PackDeckStore.packCardResults.filter(c => c).length;
                    showLoading(true, `카드 검색 중<br>(${count}/${totalFromRadio})<br><a id="cancel-gen-link" class="link-style-btn">제작 중단</a>`);
                    startPackCrawlNew(PackDeckStore.currentPackInfo.packId, PackDeckStore.currentPackInfo.validLocale, 0);
                }
            } else {
                generatePackRowsNew(PackDeckStore.currentPackInfo.totalCards, PackDeckStore.currentPackInfo.packName, PackDeckStore.currentPackInfo.packId);
            }
        } else {
            handlePackSearch();
        }
    }
}

function resetDeckMode(clearInput = false) {
    const wasTableVisible = PackDeckStore.isDeckTableGenerated;
    PackDeckStore.isDeckTableGenerated = false;

    // 하단 컨테이너 축소 애니메이션 트리거
    const tableContainer = document.getElementById('manage-table-container');
    if (tableContainer) {
        tableContainer.classList.remove('anim-active');
        tableContainer.classList.add('anim-hidden');
    }

    if (clearInput) {
        const input = document.getElementById('deck-code-input');
        if (input) input.value = '';
        const clearBtn = document.getElementById('deck-clear-btn');
        if (clearBtn) clearBtn.style.display = 'none';

        PackDeckStore.currentDeckName = "";
        PackDeckStore.currentDeckDetailUrl = null;
    }

    // 검색 박스 복구
    const searchBox = document.getElementById('deck-search-box');
    const searchContent = document.getElementById('deck-search-content');

    if (searchBox) {
        if (wasTableVisible) {
            // [애니메이션 모드] 표가 제거되면서 검색창이 나타날 때
            if (searchContent) {
                searchContent.style.transition = 'none';
                searchContent.style.display = '';
                searchContent.style.opacity = '1';
                searchContent.style.maxHeight = 'none';
                void searchContent.offsetHeight;
            }

            searchBox.style.display = 'flex';
            searchBox.style.opacity = '0';
            searchBox.style.margin = '0';
            searchBox.style.padding = '0';
            searchBox.style.borderWidth = '0';
            searchBox.style.maxHeight = '0';
            searchBox.style.overflow = 'hidden';

            void searchBox.offsetHeight;

            searchBox.style.opacity = '1';
            searchBox.style.margin = '0 0 12px 0';
            searchBox.style.padding = '20px';
            searchBox.style.borderWidth = '1px';
            searchBox.style.maxHeight = '300px';

            setTimeout(() => {
                if (!PackDeckStore.isDeckTableGenerated) {
                    searchBox.style.maxHeight = '';
                    searchBox.style.overflow = '';
                    if (searchContent) searchContent.style.transition = '';
                }
            }, 300);
        } else {
            // [즉시 모드] 단순히 입력값만 초기화할 때 (검색창이 이미 보이고 있음)
            searchBox.style.display = 'flex';
            searchBox.style.opacity = '1';
            searchBox.style.margin = '0 0 12px 0';
            searchBox.style.padding = '20px';
            searchBox.style.borderWidth = '1px';
            searchBox.style.maxHeight = '';
            searchBox.style.overflow = '';
            if (searchContent) {
                searchContent.style.display = '';
                searchContent.style.opacity = '1';
                searchContent.style.maxHeight = '';
            }
        }
    }

    // 버튼 및 텍스트 초기화
    // 공통 푸터 버튼 상태 동기화 (덱 모드인 경우에만 적용)
    if (typeof updateManageFooter === 'function' && addSubMode === 'deck') {
        updateManageFooter('add', 'deck');
    }

    if (clearInput) {
        const statusMsg = document.getElementById('deck-status-msg');
        if (statusMsg) {
            statusMsg.classList.remove('status-error', 'status-success');
            statusMsg.innerHTML = `<span style="font-size: 0.85rem; font-weight: 500; color: var(--text-secondary); line-height: 1.4; text-align: center;">덱 코드를 입력하여 뉴런에 등록된 덱 리스트를 가져옵니다.<br><a href="#" class="fna-link" style="color: var(--primary-color); text-decoration: underline;">덱 코드는 어떻게 확인하나요?</a></span>`;
        }
    }

    // 애니메이션 완료 시점에 맞춰 데이터 및 테이블 영역 비우기 (CSS Grid 애니메이션 0.4초 대기)
    setTimeout(() => {
        const tableArea = document.getElementById('deck-table-area');
        if (tableArea) tableArea.style.display = 'none';
    }, 400);
}

function handleDeckSearch() {
    const input = document.getElementById('deck-code-input');
    const code = input ? input.value.trim() : "";
    const genBtn = document.getElementById('manage-gen-btn');
    const statusMsg = document.getElementById('deck-status-msg');

    if (!code) {
        if (statusMsg) {
            statusMsg.style.display = 'flex';
            statusMsg.style.flexDirection = 'row';
            statusMsg.style.alignItems = 'center';
            statusMsg.style.justifyContent = 'center';
            statusMsg.style.marginTop = '4px';
            statusMsg.innerHTML = `<span style="font-size: 0.85rem; font-weight: 500; color: var(--error-red);">덱 코드를 입력하세요.</span>`;
        }
        if (genBtn) genBtn.classList.add('disabled');
        return;
    }

    // 로딩 상태
    if (statusMsg) {
        statusMsg.style.display = 'flex';
        statusMsg.style.flexDirection = 'row';
        statusMsg.style.alignItems = 'center';
        statusMsg.style.justifyContent = 'center';
        statusMsg.style.marginTop = '4px';
        statusMsg.innerHTML = `<span style="font-size: 0.85rem; font-weight: 500; color: var(--text-secondary);">확인 중...</span>`;
    }
    if (genBtn) genBtn.classList.add('disabled');


    callApi('searchDeck', { deckCode: code, locale: UIStore.currentRegion }).then(res => {
        if (statusMsg) statusMsg.classList.remove('status-error', 'status-success');

        if (!res || res.isError) {
            const msg = (res && res.message) ? res.message : "서버 통신 오류";
            if (statusMsg) {
                statusMsg.classList.add('status-error');
                statusMsg.innerHTML = `<span style="font-size: 0.85rem; font-weight: 500; text-align: center;">${escapeHTML(msg)}</span>`;
            }
            if (genBtn) genBtn.classList.add('disabled');
        } else {
            if (statusMsg) {
                statusMsg.classList.add('status-success');
                statusMsg.innerHTML = `<span style="font-size: 0.85rem; font-weight: 500; line-height: 1.6; text-align: center;">${escapeHTML(res.deckName)}<br>${escapeHTML(res.updatedAt)}</span>`;
            }
            if (genBtn) genBtn.classList.remove('disabled');

            // 전역 변수에 저장
            PackDeckStore.currentDeckDetailUrl = res.detailUrl;
            PackDeckStore.currentDeckName = res.deckName;
            updateDeckUrl();

            // 미리 상세 데이터 크롤링을 백그라운드로 실행
            deckCardsPromise = callApi('getDeckCards', { url: res.detailUrl });

            // 보관위치 자동입력
            if (PackDeckStore.currentDeckName) {
                const autoLocInput = document.getElementById('auto-location-input');
                if (autoLocInput) {
                    autoLocInput.focus();
                    autoLocInput.value = PackDeckStore.currentDeckName;
                    if (typeof M !== 'undefined' && M.updateTextFields) M.updateTextFields();
                    autoLocInput.dispatchEvent(new Event('input', { bubbles: true }));

                    setTimeout(() => {
                        const enterEvent = new KeyboardEvent('keydown', {
                            key: 'Enter',
                            code: 'Enter',
                            keyCode: 13,
                            which: 13,
                            bubbles: true,
                            cancelable: true
                        });
                        autoLocInput.dispatchEvent(enterEvent);
                        autoLocInput.blur();
                    }, 50);
                }
            }
        }

    }).catch(() => {
        if (statusMsg) {
            statusMsg.classList.remove('status-error', 'status-success');
            statusMsg.classList.add('status-error');
            statusMsg.innerHTML = `<span style="font-size: 0.85rem; font-weight: 500; text-align: center;">서버 통신 오류</span>`;
        }
        if (genBtn) genBtn.classList.add('disabled');

    });
}

function toggleDeckTable() {
    const genBtn = document.getElementById('manage-gen-btn');
    if (genBtn) genBtn.blur();

    if (PackDeckStore.isDeckTableGenerated) {
        resetDeckMode();
    } else {
        generateDeckRowsNew();
    }
}

async function generateDeckRowsNew() {
    const code = document.getElementById('deck-code-input').value.trim();
    if (!code) return;

    showLoading(true, "덱 목록을 생성하는 중...");

    // UI 준비
    const searchBox = document.getElementById('deck-search-box');
    const tableArea = document.getElementById('deck-table-area');
    const isMobile = document.documentElement.classList.contains('is-mobile-device');
    const containerId = isMobile ? 'mobile-cards-list-deck' : 'desktop-cards-list-deck';
    const container = document.getElementById(containerId);
    const genBtn = document.getElementById('manage-gen-btn');

    if (searchBox) {
        searchBox.style.maxHeight = searchBox.scrollHeight + 'px';
        void searchBox.offsetHeight;
        searchBox.style.maxHeight = '0';
        searchBox.style.opacity = '0';
        searchBox.style.margin = '0';
        searchBox.style.padding = '0';
        searchBox.style.borderWidth = '0';
        searchBox.style.overflow = 'hidden';

        setTimeout(() => {
            if (PackDeckStore.isDeckTableGenerated) {
                searchBox.style.display = 'none';
            }
        }, 300);
    }

    if (tableArea) tableArea.style.display = '';

    // 하단 컨테이너 확장 애니메이션 트리거
    const tableContainer = document.getElementById('manage-table-container');
    if (tableContainer) {
        tableContainer.classList.remove('anim-hidden');
        tableContainer.classList.add('anim-active');
    }

    if (container) {
        container.innerHTML = '';
        if (genBtn) genBtn.classList.add('disabled');

        // 상세 데이터 불러오기
        try {
            const res = deckCardsPromise ? await deckCardsPromise : await callApi('getDeckCards', { url: PackDeckStore.currentDeckDetailUrl });
            if (res && res.success && res.cards) {
                const cards = res.cards;
                const promises = [];
                cards.forEach(card => {
                    const row = manageAddEntry(null, null, 'deck');
                    const nameInput = row.querySelector('[data-field="name"], .page-card-name, .desktop-card-name');
                    if (nameInput) {
                        nameInput.value = card.name;
                        if (typeof fetchCardByName === 'function') {
                            promises.push(fetchCardByName(nameInput, true));
                        }
                    }
                    const qtyInput = row.querySelector('[data-field="qty"], .page-card-qty, .desktop-card-qty');
                    if (qtyInput) {
                        qtyInput.value = 1;
                    }
                });

                if (promises.length > 0) {
                    await Promise.all(promises);
                }
            } else {
                addMultipleRows(null); // 실패 시 1개 빈 카드 슬롯
                showToast("덱 상세 정보를 불러오지 못했습니다.", "rounded red");
            }
        } catch (e) {
            addMultipleRows(null); // 실패 시 1개 빈 카드 슬롯
            showToast("덱 상세 정보를 불러오지 못했습니다.", "rounded red");
        } finally {
            if (genBtn) genBtn.classList.remove('disabled');
            showLoading(false);
        }
    }

    PackDeckStore.isDeckTableGenerated = true;

    // 공통 푸터 버튼 상태 동기화 (덱 코드도 내부에서 처리됨)
    if (typeof updateManageFooter === 'function') {
        updateManageFooter('add', 'deck');
    }
    if (isMobile) {
        renderMobileCards();
    }
}

function resetPackMode(clearInput = false) {
    const wasTableVisible = PackDeckStore.isPackTableGenerated;
    PackDeckStore.isPackTableGenerated = false;
    stopPackCrawlNew();       // 진행 중인 크롤링 중단
    PackDeckStore.packCardResults = [];     // 누적 결과 초기화
    PackDeckStore.isPackCrawlDone = false;  // 완료 플래그 초기화
    _currentDisplayCrawlCount = 0; // 애니메이션 수치 초기화
    if (_crawlIntervalId) {
        clearInterval(_crawlIntervalId);
        _crawlIntervalId = null;
    }

    // 하단 컨테이너 축소 애니메이션 트리거
    const tableContainer = document.getElementById('manage-table-container');
    if (tableContainer) {
        tableContainer.classList.remove('anim-active');
        tableContainer.classList.add('anim-hidden');
    }

    if (clearInput) {
        const input = document.getElementById('pack-search-input');
        if (input) input.value = '';
        const clearBtn = document.getElementById('pack-clear-btn');
        if (clearBtn) clearBtn.style.display = 'none';

        PackDeckStore.currentPackInfo = null;

        const statusMsg = document.getElementById('pack-status-msg');
        if (statusMsg) {
            statusMsg.classList.remove('status-error', 'status-success');
            statusMsg.innerHTML = '';
        }
    }

    // 검색 박스 및 내용물 복구
    const searchBox = document.getElementById('pack-search-box');
    const searchContent = document.getElementById('pack-search-content');

    if (searchBox) {
        if (wasTableVisible) {
            // [애니메이션 모드] 표가 제거되면서 검색창이 나타날 때
            if (searchContent) {
                searchContent.style.transition = 'none';
                searchContent.style.display = '';
                searchContent.style.opacity = '1';
                searchContent.style.maxHeight = 'none';
                searchContent.style.margin = '';
                void searchContent.offsetHeight;
            }

            searchBox.style.display = 'flex';
            searchBox.style.opacity = '0';
            searchBox.style.margin = '0';
            searchBox.style.padding = '0';
            searchBox.style.borderWidth = '0';
            searchBox.style.maxHeight = '0';
            searchBox.style.overflow = 'hidden';

            void searchBox.offsetHeight;

            searchBox.style.opacity = '1';
            searchBox.style.margin = '0 0 12px 0';
            searchBox.style.padding = '20px';
            searchBox.style.borderWidth = '1px';
            searchBox.style.maxHeight = '300px';

            setTimeout(() => {
                if (!PackDeckStore.isPackTableGenerated) {
                    searchBox.style.maxHeight = '';
                    searchBox.style.overflow = '';
                    if (searchContent) searchContent.style.transition = '';
                }
            }, 300);
        } else {
            // [즉시 모드] 단순히 입력값만 초기화할 때
            searchBox.style.display = 'flex';
            searchBox.style.opacity = '1';
            searchBox.style.margin = '0 0 12px 0';
            searchBox.style.padding = '20px';
            searchBox.style.borderWidth = '1px';
            searchBox.style.maxHeight = '';
            searchBox.style.overflow = '';
            if (searchContent) {
                searchContent.style.display = '';
                searchContent.style.opacity = '1';
                searchContent.style.maxHeight = '';
                searchContent.style.margin = '';
            }
        }
    }

    // 공통 푸터 버튼 상태 동기화 (팩 모드인 경우에만 적용)
    if (typeof updateManageFooter === 'function' && addSubMode === 'pack') {
        updateManageFooter('add', 'pack');
    }

    // 표 제거 상태에 맞춰 URL 동기화 (검색 기록이 남아있다면 되돌아감)
    updatePackUrl();

    setTimeout(() => {
        const isMobile = document.documentElement.classList.contains('is-mobile-device');
        const containerId = isMobile ? 'mobile-cards-list-pack' : 'desktop-cards-list-pack';
        const container = document.getElementById(containerId);
        if (container) container.innerHTML = '';
        const tableArea = document.getElementById('pack-table-area');
        if (tableArea) tableArea.style.display = 'none';
    }, 400);
}

/**
 * 팩 정보 검색 및 표 제작 준비를 수행합니다.
 * @param {boolean} isInstant - 즉시 실행 여부
 * @param {string|null} targetName - 검색할 팩 이름 (URL에서 전달된 경우)
 * @param {string|null} targetLocale - 타겟 국가 코드 (URL에서 전달된 경우)
 */
async function handlePackSearch(isInstant = false, targetName = null, targetLocale = null) {
    if (PackDeckStore.isSearching) return; // 중복 클릭 방지

    const input = document.getElementById('pack-search-input');
    const query = (targetName || input.value).trim();
    if (targetName) {
        input.value = targetName;
        const clearBtn = document.getElementById('pack-clear-btn');
        if (clearBtn) clearBtn.style.display = 'block';
    }

    if (!query) {
        PackDeckStore.currentPackInfo = null;
        updatePackUrl();
        displayPackSearchStatus("팩 이름을 입력하세요.", "error");
        return;
    }

    displayPackSearchStatus("팩 정보 확인 중...", "normal");

    const genBtn = document.getElementById('manage-gen-btn');
    if (genBtn) {
        genBtn.classList.add('disabled');
        genBtn.blur();
    }

    // 이전 크롤링 중단 및 상태 초기화
    stopPackCrawlNew();
    PackDeckStore.packCardResults = [];
    PackDeckStore.isPackCrawlDone = false;
    PackDeckStore.isSearching = true;

    const normalize_ = s => (s || "").replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\s+/g, " ").trim().normalize('NFC');
    const normQuery = normalize_(query);
    const packsObj = (CardDataStore.masterJSON && CardDataStore.masterJSON.pack) ? CardDataStore.masterJSON.pack : {};
    // [변경] 복합키 "PID_locale" 형식의 키를 파싱하여 cachedPacks 구성
    let cachedPacks = Object.keys(packsObj).map(compositeId => {
        const p = packsObj[compositeId];
        const lastUnderscore = compositeId.lastIndexOf('_');
        const pid = lastUnderscore !== -1 ? compositeId.slice(0, lastUnderscore) : compositeId;
        const locale = lastUnderscore !== -1 ? compositeId.slice(lastUnderscore + 1) : '';
        return {
            id: compositeId,    // 복합키 전체
            pid,                // 순수 PID (API 호출용)
            name: p.name,
            total: p.totalCards,
            locale,             // 키에서 파싱된 locale
            locales: locale ? [locale] : []
        };
    }).filter(p => normalize_(p.name) === normQuery);

    // targetLocale이 명시된 경우 해당 국가 버전으로 즉시 필터링 (동일 이름 팩 처리용)
    if (targetLocale && cachedPacks.length > 1) {
        const matched = cachedPacks.find(p => p.locale === targetLocale);
        if (matched) cachedPacks = [matched];
    }

    let res;
    try {
        if (cachedPacks.length > 0) {
            if (cachedPacks.length === 1) {
                res = {
                    success: true,
                    packId: cachedPacks[0].pid,  // [변경] 순수 PID 사용
                    packName: cachedPacks[0].name || query,
                    totalCards: cachedPacks[0].total,
                    validLocale: cachedPacks[0].locale || 'ko',
                    message: "수록된 카드 " + cachedPacks[0].total + "장 발견",
                    isMultiple: false,
                    isCached: true
                };
            } else {
                res = {
                    success: true,
                    isMultiple: true,
                    foundLocales: cachedPacks.map(p => {
                        // [변경] targetUrl에 순수 PID 사용, locale은 파싱된 값
                        return { locale: p.locale, targetUrl: p.pid, totalCards: p.total };
                    }),
                    packName: query,
                    totalCards: Math.max(...cachedPacks.map(p => p.total || 0)),
                    message: "발매 국가 선택",
                    isCached: true
                };
            }
        } else {
            res = await callApi('searchPack', { packName: query });
        }

        PackDeckStore.isSearching = false; // 검색 완료

        if (res.isError) {
            PackDeckStore.currentPackInfo = null;
            updatePackUrl();
            displayPackSearchStatus(res.message, "error");
            if (genBtn) genBtn.classList.remove('disabled');
            return;
        }

        // [Storage 전환] 검색 성공 시 CardDataStore.masterJSON.pack 및 MasterDB에 동기화
        // [변경] 키를 PID_locale 복합키 형식으로 저장
        const packBatch = {};
        if (!res.isMultiple) {
            packBatch[`${res.packId}_${res.validLocale || 'ko'}`] = {
                name: res.packName,
                totalCards: res.totalCards,
            };
        } else if (Array.isArray(res.foundLocales)) {
            res.foundLocales.forEach(locInfo => {
                packBatch[`${locInfo.targetUrl}_${locInfo.locale || 'ko'}`] = {
                    name: res.packName,
                    totalCards: locInfo.totalCards || res.totalCards,
                };
            });
        }
        if (Object.keys(packBatch).length > 0) {
            await ClientCache.setMasterData({ pack: packBatch });
        }

        // 복수 대상이 발견된 경우 (라디오 버튼 렌더링)
        if (res.isMultiple) {
            displayPackSearchStatus(res.message, "success");

            let optionsHtml = `
            <style>
                .small-radio + span {
                    padding-left: 15px !important;
                    height: 20px !important;
                    line-height: 20px !important;
                    display: inline-block !important;
                }
                .small-radio + span::before, 
                .small-radio + span::after {
                    width: 12px !important;
                    height: 12px !important;
                    margin: 0 !important; 
                    top: 3px !important;
                    left: 0 !important;
                }
                .small-radio.with-gap:checked + span::after {
                    transform: scale(0.5) !important;
                }
            </style>
            <div id="pack-lang-options" style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-left: 8px; margin-top: 0px;">`;

            // 등록을 진행할 언어 선택 라디오 버튼 동적 생성
            const searchOrder = ['ko', 'ja', 'ae', 'cn', 'en', 'de', 'fr', 'it', 'es', 'pt'];
            const regionMapOptions = { 'ko': '한국', 'ja': '일본', 'ae': '아시아', 'cn': '중국', 'en': '영미', 'de': '독일', 'fr': '프랑스', 'it': '이탈리아', 'es': '스페인', 'pt': '포르투갈' };

            const targetReg = (typeof UIStore.currentRegion !== 'undefined') ? UIStore.currentRegion : 'ko';
            let sortedLocales = (res.foundLocales || []).sort((a, b) => {
                if (a.locale === targetReg) return -1;
                if (b.locale === targetReg) return 1;
                return searchOrder.indexOf(a.locale) - searchOrder.indexOf(b.locale);
            });

            sortedLocales.forEach((locInfo, idx) => {
                const isChecked = idx === 0 ? 'checked' : '';
                const locName = regionMapOptions[locInfo.locale] || locInfo.locale;
                optionsHtml += `
                    <label style="cursor: pointer; display: inline-flex; align-items: center; margin: 0; padding: 0; height: 20px;">
                        <input class="with-gap small-radio" name="packLangSelect" type="radio" value="${locInfo.locale}" data-url="${locInfo.targetUrl}" data-total="${locInfo.totalCards || 0}" ${isChecked} />
                        <span style="font-size: 0.85rem; color: var(--text-primary); white-space: nowrap;">${locName}</span>
                    </label>
                `;
            });
            optionsHtml += '</div>';

            const statusEl = document.getElementById('pack-status-msg');
            if (statusEl) {
                statusEl.style.display = 'flex';
                statusEl.style.flexDirection = 'row';
                statusEl.style.alignItems = 'center';
                statusEl.style.justifyContent = 'center';
                statusEl.style.flexWrap = 'wrap';
                statusEl.innerHTML += optionsHtml;
            }

            PackDeckStore.currentPackInfo = {
                packName: res.packName,
                totalCards: res.totalCards || 0,
                isPendingSelection: true
            };

            if (genBtn) genBtn.classList.remove('disabled');
            updatePackUrl();
        } else {
            // [기존] 단일 검색 성공 시 (바로 크롤링)
            displayPackSearchStatus(res.message, "success");

            PackDeckStore.currentPackInfo = {
                totalCards: res.totalCards,
                packName: res.packName,
                packId: res.packId,
                validLocale: res.validLocale
            };

            if (genBtn) genBtn.classList.remove('disabled');
            updatePackUrl();

            if (isInstant === true) {
                togglePackTable();
            } else {
                startPackCrawlNew(res.packId, PackDeckStore.currentPackInfo.validLocale, 0);
            }
        }

    } catch (e) {
        PackDeckStore.isSearching = false;
        console.error("[handlePackSearch Exception]:", e);
        displayPackSearchStatus("서버 통신 오류", "error");
        if (genBtn) genBtn.classList.remove('disabled');
    }
}



function displayPackSearchStatus(msg, type) {
    const el = document.getElementById('pack-status-msg');
    if (!el) return;

    // 텍스트를 span으로 감싸 가로 정렬이 용이하게 함 (여백/높이 지정)
    el.innerHTML = `<span class="status-msg-text" style="font-size: 0.85rem; font-weight: 500; display: inline-flex; align-items: center; height: 20px; margin: 0; padding: 0;">${escapeHTML(msg)}</span>`;

    // 외곽 컨테이너의 flex 레이아웃 강제 구성
    el.style.display = 'flex';
    el.style.flexDirection = 'row';
    el.style.alignItems = 'center';
    el.style.justifyContent = 'center'; // 중앙 정렬
    el.style.flexWrap = 'wrap';
    el.style.marginTop = '4px'; // 살짝 위로 이동하는 효과 및 안정된 여백

    // 기본 클래스 색상 초기화
    el.classList.remove('status-error', 'status-success');

    if (type === 'error') {
        el.classList.add('status-error');
        el.style.color = "var(--error-red)";
    } else if (type === 'success') {
        el.classList.add('status-success');
        el.style.color = "var(--success-green)";
    } else {
        el.style.color = "var(--text-secondary)";
    }

    // [추가] 상태 메시지 변화에 따른 높이 재동기화

}










// =============================================================================
// 카드이름 기반 팩 등록 메커니즘 - 프론트엔드 함수
// =============================================================================

/**
 * 팩 등록 테이블 생성
 * - PackDeckStore.packCardResults에 이미 있는 카드는 즉시 채워넣고
 * - 아직 크롤링 중인 카드가 있으면 로딩 화면 표시
 */
async function generatePackRowsNew(totalCards, packName, packId) {
    if (!totalCards || totalCards <= 0) {
        displayPackSearchStatus("카드 수 정보가 없습니다.", "error");
        return;
    }

    // UI 준비
    const searchArea = document.getElementById('pack-search-content');
    const tableArea = document.getElementById('pack-table-area');
    const isMobile = document.documentElement.classList.contains('is-mobile-device');
    const containerId = isMobile ? 'mobile-cards-list-pack' : 'desktop-cards-list-pack';
    const container = document.getElementById(containerId);

    const searchBox = document.getElementById('pack-search-box');
    if (searchBox) {
        // 현재 높이를 명시적으로 지정한 후 0으로 줄여 애니메이션 유도
        searchBox.style.maxHeight = searchBox.scrollHeight + 'px';
        void searchBox.offsetHeight; // 리플로우 강제
        searchBox.style.maxHeight = '0';
        searchBox.style.opacity = '0';
        searchBox.style.margin = '0';
        searchBox.style.padding = '0';
        searchBox.style.borderWidth = '0';
        searchBox.style.overflow = 'hidden';

        // 애니메이션 완료 후 완전히 제거하여 공간 차지 방지
        setTimeout(() => {
            if (PackDeckStore.isPackTableGenerated) {
                searchBox.style.display = 'none';
            }
        }, 300);
    }

    tableArea.style.display = '';

    // 하단 컨테이너 확장 애니메이션 트리거
    const tableContainer = document.getElementById('manage-table-container');
    if (tableContainer) {
        tableContainer.classList.remove('anim-hidden');
        tableContainer.classList.add('anim-active');
    }

    if (container) {
        container.innerHTML = '';
    }

    PackDeckStore.isPackTableGenerated = true;

    // 공통 푸터 버튼 상태 동기화 (팩 이름도 내부에서 처리됨)
    if (typeof updateManageFooter === 'function') {
        updateManageFooter('add', 'pack');
    }

    // 등록표 제작 완료 시점에 URL 동기화 (loc 파라미터 반영)
    updatePackUrl();

    // 표 생성 직후 크롤링 진행 중이라면 로딩 표시
    if (!PackDeckStore.isPackCrawlDone) {
        const count = PackDeckStore.packCardResults.filter(c => c).length;
        showLoading(true, `카드 검색 중<br>(${count}/${totalCards})<br><a id="cancel-gen-link" class="link-style-btn">제작 중단</a>`);
    }

    // 카드 데이터는 crawlPackCardsBatch API 응답으로 채워짐
    for (let i = 0; i < totalCards; i++) {
        const card = manageAddEntry(null, null, 'pack');
        if (card) {
            card.dataset.searchMode = 'pack'; // 팩 모드 잠금 설정
        }
    }

    if (isMobile) {
        renderMobileCards();
    }

    // 이미 수신되어 캐시된 프리 크롤링 데이터가 있을 경우 즉시 표에 적용 (0ms 히트)
    const alreadyCrawled = PackDeckStore.packCardResults.filter(c => c);
    if (alreadyCrawled.length > 0) {
        await applyPackCardResults(alreadyCrawled);
    }

    setTimeout(() => {
        if (PackDeckStore.isPackTableGenerated && searchArea) {
            searchArea.style.display = 'none';
        }
    }, 300);
}

let _silentCrawls = {}; // 조용한 백그라운드 프리크롤링 추적 객체

/**
 * 배경에서 조용히 크롤링만 수행하여 DB(Code/Name/Rarity) 시트를 채우는 프리크롤링 함수
 */


/**
 * Pack2 link 기반 배경 크롤링 시작 (2단계)
 * 다국어 파라미터(locale)를 함께 전달합니다.
 */
async function startPackCrawlNew(packId, locale, startOffset = 0, packNameParam = null) {
    const key = packId + "_" + locale;
    if (_silentCrawls[key]) _silentCrawls[key] = false;

    const total = (PackDeckStore.currentPackInfo && PackDeckStore.currentPackInfo.totalCards) ? PackDeckStore.currentPackInfo.totalCards : 0;
    const packName = packNameParam || (PackDeckStore.currentPackInfo ? PackDeckStore.currentPackInfo.packName : null);

    // 로컬 캐시 확인: 이미 이 팩의 크롤링이 완료된 경우 서버 호출 생략
    if (CardDataStore.crawledPacksCache[key] && CardDataStore.crawledPacksCache[key].isDone) {
        PackDeckStore.isPackCrawlDone = true;
        PackDeckStore.packCardResults = [...CardDataStore.crawledPacksCache[key].cards];
        if (PackDeckStore.isPackTableGenerated) {
            await applyPackCardResults(PackDeckStore.packCardResults.filter(c => c));
            showLoading(false);
        }
        return;
    }

    _packCrawlNewRunning = true;
    PackDeckStore.isPackCrawlDone = false;

    let offset = startOffset;
    if (!CardDataStore.crawledPacksCache[key]) CardDataStore.crawledPacksCache[key] = { cards: [], isDone: false };

    let retryCount = 0;
    while (_packCrawlNewRunning) {
        if (total > 0 && offset >= total) {
            PackDeckStore.isPackCrawlDone = true;
            if (CardDataStore.crawledPacksCache[key]) CardDataStore.crawledPacksCache[key].isDone = true;
            showLoading(false);
            break;
        }

        try {
            const res = await callApi('crawlPackCardsBatch', { packId, locale, offset, packName });
            if (!_packCrawlNewRunning) break;

            if (res.isQuotaError) {
                console.warn(`[Pack Crawl] 구글 서버 할당량 초과. 7초 후 재시도합니다... (offset: ${offset})`);
                if (PackDeckStore.isPackTableGenerated) {
                    showLoading(true, `할당량 초과로 잠시 대기 중 (7초)<br><a id="cancel-gen-link" class="link-style-btn">제작 중단</a>`);
                }
                await new Promise(r => setTimeout(r, 7000));
                continue;
            }

            if (res.isError) {
                console.warn('[Pack Crawl New] 오류:', res.message);

                // 최대 3회 재시도 로직
                if (retryCount < 3) {
                    retryCount++;
                    await new Promise(r => setTimeout(r, 1000)); // 1초 대기 후 재시도
                    continue;
                } else {
                    // 3회 재시도 실패 시 종료 및 초기화
                    showLoading(false);
                    resetPackMode();
                    break;
                }
            }

            // 성공 시 재시도 횟수 초기화
            retryCount = 0;

            if (res.cards && res.cards.length > 0) {
                res.cards.forEach(c => {
                    PackDeckStore.packCardResults[c.index] = c;
                    CardDataStore.crawledPacksCache[key].cards[c.index] = c; // 캐시 갱신
                });

                // 카드 처리 직후 실시간 진행률 업데이트 (수치 애니메이션 호출)
                if (PackDeckStore.isPackTableGenerated) {
                    const targetCount = PackDeckStore.packCardResults.filter(c => c).length;
                    updateSmoothCrawlCount(targetCount, total);
                    await applyPackCardResults(res.cards);
                }
            }

            if (res.isDone) {
                PackDeckStore.isPackCrawlDone = true;
                CardDataStore.crawledPacksCache[key].isDone = true; // 완료 마킹
                showLoading(false);
                break;
            }

            offset = res.nextOffset;
            await new Promise(r => setTimeout(r, 50));
        } catch (err) {
            console.warn('[Pack Crawl New] 통신 오류:', err);
            showLoading(false);
            resetPackMode();
            break;
        }
    }
    _packCrawlNewRunning = false;
}

/**
 * 배경 크롤링 중단
 */
function stopPackCrawlNew() {
    _packCrawlNewRunning = false;
}

/**
 * 크롤링 결과를 테이블 행에 반영
 * - 이름을 먼저 기입한 뒤 카드 번호 기입 (기존 등록 테이블 로직에 맞춤)
 * - 모든 행의 이름·번호가 채워지면 로딩 해제
 */
async function applyPackCardResults(cards) {
    const isMobile = document.documentElement.classList.contains('is-mobile-device');
    const containerId = isMobile ? 'mobile-cards-list-pack' : 'desktop-cards-list-pack';
    const container = document.getElementById(containerId);
    if (!container) return;
    const cardClass = isMobile ? '.mobile-info-card' : '.desktop-info-card';
    const rows = container.querySelectorAll(cardClass);

    const promises = [];

    cards.forEach((item) => {
        const { index, name, cardNo, info } = item;
        const row = rows[index];
        if (!row) return;
        const noInput = row.querySelector('[data-field="no"], .page-card-no, .desktop-card-no');
        const nameInput = row.querySelector('[data-field="name"], .page-card-name, .desktop-card-name');

        // 백엔드에서 전달받은 카드 이름이 있고 이름 칸이 비어있으면 즉시 대입
        let cardNameVal = name;
        if (!cardNameVal && info) {
            for (let k in info) {
                if (Array.isArray(info[k]) && info[k][0]) {
                    cardNameVal = info[k][0];
                    break;
                }
            }
        }
        if (nameInput && cardNameVal && !nameInput.value) {
            nameInput.dataset.programmatic = "true";
            nameInput.value = cardNameVal;
            delete nameInput.dataset.programmatic;
        }

        if (noInput && cardNo && noInput.value !== cardNo) {
            noInput.dataset.programmatic = "true";
            noInput.value = cardNo;
            promises.push(fetchCardByNumber(noInput, true));
            noInput.dataset.prevCardNo = cardNo;
            noInput.dataset.fromNameSearch = "true";
            delete noInput.dataset.programmatic;
        }

        // 지우기 아이콘 표시
        const clearBtn = row.querySelector('.clear-name-btn');
        if (clearBtn && (name || cardNameVal)) clearBtn.style.display = 'block';
    });

    if (promises.length > 0) {
        await Promise.all(promises);
    }

    // 크롤링이 완료되었거나, 테이블의 모든 행이 채워졌다면 로딩 해제 (OR 조건)
    const allFilled = Array.from(rows).every(r => {
        const nameInp = r.querySelector('[data-field="name"], .page-card-name, .desktop-card-name');
        const noInp = r.querySelector('[data-field="no"], .page-card-no, .desktop-card-no');
        return nameInp && nameInp.value && noInp && noInp.value;
    });

    if (PackDeckStore.isPackCrawlDone || allFilled) {
        showLoading(false);
    }

    if (isMobile) {
        renderMobileCards();
    }
}

// ==========================================
// Firebase Auth 연동 및 UI 동작 제어 로직
// ==========================================

function initFirebaseAuth() {
    if (typeof firebase === 'undefined' || !firebase.auth) {
        setTimeout(initFirebaseAuth, 200); // SDK 로드 대기
        return;
    }

    // [신규 웜업] 사용자 인증 진행 중 인벤토리 인스턴스를 선제 부팅(Hot-Start)시키기 위한 비동기 핑 — 대기(await)하지 않음
    if (typeof callApi === 'function') {
        callApi('getUserData', { warmup: 'true' }).catch(() => {});
    }

    // 리다이렉트 로그인 시 타사 쿠키 차단(세션 끊김)을 막기 위해 authDomain을 동적 변경 (로컬 환경 제외)
    if (firebase.app && firebase.app().options) {
        const hostname = window.location.hostname;
        if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
            firebase.app().options.authDomain = hostname;
        }
    }

    // 리다이렉트 로그인 복귀 시 발생하는 예외 처리
    firebase.auth().getRedirectResult().catch(function (error) {
        console.error("Redirect Login Error:", error);
        showToast('로그인 실패: ' + error.message, 'toast-error');
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
        window.isAuthInitialized = true;
        UserStore.user = user;
        const authNavBtn = document.getElementById('auth-nav-btn');
        const authIcon = document.getElementById('auth-icon');
        const authText = document.getElementById('auth-text');

        const homeUnauthContent = document.getElementById('home-unauth-content');
        const homeAuthContent = document.getElementById('home-auth-content');

        if (user) {
            // 비활동 자동 로그아웃 감지 시작 (30분)
            AutoLogoutManager.start();

            // 로그인 상태 UI (이미 구현됨)
            if (authIcon) authIcon.textContent = 'link';
            if (authText) authText.textContent = '로그인';
            if (authNavBtn) authNavBtn.dataset.tooltip = '로그인 완료';

            if (homeUnauthContent) homeUnauthContent.style.display = 'none';
            if (homeAuthContent) homeAuthContent.style.display = 'block';

            loadUserData();

            // 로그인 성공 시 로그인 모달/바텀시트 자동으로 닫기
            const isMobileDevice = document.documentElement.classList.contains('is-mobile-device');
            const modalId = isMobileDevice ? 'mobile-auth-modal' : 'auth-modal';
            const modalElem = document.getElementById(modalId);
            if (modalElem) {
                const instance = M.Modal.getInstance(modalElem);
                if (instance) instance.close();
            }
        } else {
            // 비활동 자동 로그아웃 감지 중단
            AutoLogoutManager.stop();

            // 비로그인 상태 UI
            if (authIcon) authIcon.textContent = 'link_off';
            if (authText) authText.textContent = '로그인';
            if (authNavBtn) authNavBtn.dataset.tooltip = '로그인 필요';

            if (homeUnauthContent) homeUnauthContent.style.display = 'block';
            if (homeAuthContent) homeAuthContent.style.display = 'none';

            // [추가] Guest 사용자는 추가 동기화 대기 없음
            UserStore.isUserDataSyncDone = true;
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

        // 인증 상태 변경 시 툴팁 표시 여부 재계산
        if (typeof handleTooltipDisplay === 'function') {
            handleTooltipDisplay();
        }

        // 인증 초기화 완료 후 통합 로딩 종료 체크
        checkAndHideInitialLoading();
    });

    // 사이드바 확장 상태일 때 인증 툴팁 제거 (데스크톱 뷰)
    window.handleTooltipDisplay = () => {
        const authBtn = document.getElementById('auth-nav-btn');
        if (!authBtn) return;

        const instance = M.Tooltip.getInstance(authBtn);
        if (window.innerWidth >= 993) {
            if (instance) {
                instance.destroy();
            }
        } else {
            // 모바일/태블릿(사이드바 축소) 상태에서만 툴팁 활성화
            if (!instance && authBtn.dataset.tooltip) {
                M.Tooltip.init(authBtn);
            }
        }
    };
    window.addEventListener('resize', handleTooltipDisplay);
    handleTooltipDisplay();
}

let currentNoticeIndex = -1; // 모바일 공지 상세 보기 인덱스

function openNoticeModal(targetDate) {
    // 알림 팝업 닫기
    const popup = document.getElementById('noti-popup');
    if (popup) popup.classList.remove('active');

    toggleBackgroundInert(true);

    // 모바일 기기인 경우 전용 모드 실행
    if (document.documentElement.classList.contains('is-mobile-device')) {
        if (targetDate) {
            // 특정 날짜가 전달된 경우 해당 날짜의 첫 번째 공지 상세 보기
            const idx = notices.findIndex(n => n.date === targetDate);
            if (idx !== -1) {
                openNoticeDetailMode(idx);
                return;
            }
        }
        openNoticeListMode();
        return;
    }

    const modalElem = document.getElementById('notice-modal');
    const instance = M.Modal.getInstance(modalElem);

    const dateListContainer = document.getElementById('notice-date-list');
    const contentArea = document.getElementById('notice-content-area');

    if (notices.length === 0) {
        dateListContainer.innerHTML = '<div style="padding:20px; color:var(--text-muted); text-align:center;">공지사항이 없습니다.</div>';
        contentArea.innerHTML = '<div style="color:var(--text-muted); text-align:center; margin-top:100px;">등록된 공지사항이 없습니다.</div>';
        instance.open();
        return;
    }

    // 날짜 유니크 추출 및 정렬 (핀 상단 고정 로직 포함)
    const dates = [...new Set(notices.map(n => n.date))].sort((a, b) => {
        const aNotices = notices.filter(n => n.date === a);
        const bNotices = notices.filter(n => n.date === b);

        // 해당 날짜 공지 중 최소 핀 번호 (0보다 큰 수 중 가장 작은 것)
        const aMinPin = Math.min(...aNotices.map(n => n.isPinned > 0 ? n.isPinned : 9999));
        const bMinPin = Math.min(...bNotices.map(n => n.isPinned > 0 ? n.isPinned : 9999));

        if (aMinPin !== bMinPin) return aMinPin - bMinPin;
        return b.localeCompare(a); // 최신 날짜 우선
    });

    dateListContainer.innerHTML = '';
    dates.forEach(date => {
        const noticesOnDate = notices.filter(n => n.date === date);
        const hasNewInDate = noticesOnDate.some(noti => isNoticeNew(noti));
        const hasPinInDate = noticesOnDate.some(noti => noti.isPinned > 0);

        const item = document.createElement('div');
        item.className = 'date-item';
        item.innerHTML = `${date}${hasPinInDate ? '<i class="material-icons pin-icon">push_pin</i>' : ''}${hasNewInDate ? '<span class="new-indicator">NEW</span>' : ''}`;
        item.onclick = (e) => renderNoticeContentByDate(date, item);
        dateListContainer.appendChild(item);
    });

    instance.open();

    // 초기 날짜 선택 로직
    if (dates.length > 0) {
        const initialDate = targetDate || dates[0];
        const initialItem = Array.from(dateListContainer.children).find(el => el.innerText.includes(initialDate));
        renderNoticeContentByDate(initialDate, initialItem);
    }
}

/**
 * 모바일: 공지 목록 모달 열기
 */
function openNoticeListMode() {
    const listModal = document.getElementById('notice-list-modal');
    const detailModal = document.getElementById('notice-detail-modal');
    if (!listModal) return;

    let listInstance = M.Modal.getInstance(listModal);
    if (!listInstance) {
        listInstance = M.Modal.init(listModal, getCommonModalOptions());
    }

    const detailInstance = M.Modal.getInstance(detailModal);

    updateMobileNoticeList();

    listInstance.open();

    // 전환 시퀀스: 목록이 다 열리면 상세 창 닫기
    listInstance.options.onOpenEnd = () => {
        if (detailInstance && detailInstance.isOpen) {
            detailInstance.close();
        }
    };
}

const NOTICE_ALLOWED_TAGS = new Set([
    'a', 'b', 'blockquote', 'br', 'code', 'del', 'div', 'em', 'h1', 'h2', 'h3',
    'h4', 'h5', 'h6', 'hr', 'i', 'li', 'ol', 'p', 'pre', 's', 'span', 'strong', 'u', 'ul'
]);
const NOTICE_DROP_WITH_CONTENT_TAGS = new Set([
    'base', 'embed', 'frame', 'iframe', 'link', 'meta', 'object', 'script', 'style', 'svg', 'template'
]);

function isSafeNoticeHref(href) {
    try {
        const url = new URL(href, window.location.origin);
        return ['http:', 'https:', 'mailto:'].includes(url.protocol);
    } catch (e) {
        return false;
    }
}

// 기존 notices.json도 안전하게 표시하기 위한 클라이언트 측 방어선입니다.
function sanitizeNoticeHtml(content) {
    const template = document.createElement('template');
    template.innerHTML = String(content || '').replace(/\r?\n/g, '<br>');

    Array.from(template.content.querySelectorAll('*')).reverse().forEach(element => {
        const tag = element.tagName.toLowerCase();
        if (!NOTICE_ALLOWED_TAGS.has(tag)) {
            if (NOTICE_DROP_WITH_CONTENT_TAGS.has(tag)) element.remove();
            else element.replaceWith(...Array.from(element.childNodes));
            return;
        }

        const href = element.getAttribute('href');
        const title = element.getAttribute('title');
        const target = element.getAttribute('target');
        Array.from(element.attributes).forEach(attr => element.removeAttribute(attr.name));

        if (tag === 'a') {
            if (href && isSafeNoticeHref(href)) element.setAttribute('href', href);
            if (title) element.setAttribute('title', title);
            if (target === '_blank') {
                element.setAttribute('target', '_blank');
                element.setAttribute('rel', 'noopener noreferrer');
            }
        }
    });

    return template.innerHTML;
}

/**
 * 모바일: 개별 공지 상세 모달 열기
 */
function openNoticeDetailMode(index) {
    if (index < 0 || index >= notices.length) return;
    currentNoticeIndex = index;

    const listModal = document.getElementById('notice-list-modal');
    const detailModal = document.getElementById('notice-detail-modal');
    if (!detailModal) return;

    let detailInstance = M.Modal.getInstance(detailModal);
    if (!detailInstance) {
        detailInstance = M.Modal.init(detailModal, getCommonModalOptions());
    }

    const listInstance = M.Modal.getInstance(listModal);

    const noti = notices[index];

    // 내용 렌더링
    document.getElementById('mobile-detail-date').innerText = noti.date;
    document.getElementById('mobile-detail-title').innerText = noti.title;
    document.getElementById('mobile-notice-content-body').innerHTML = sanitizeNoticeHtml(noti.content);

    detailInstance.open();

    // 전환 시퀀스: 상세가 다 열리면 목록 창 닫기
    detailInstance.options.onOpenEnd = () => {
        if (listInstance && listInstance.isOpen) {
            listInstance.close();
        }
        // 읽음 처리
        markNoticeAsRead(noti.date);
    };
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

async function startYoutubeMembershipVerify() {
    if (!UserStore.user) {
        showToast('로그인이 필요합니다.', 'toast-warn');
        return;
    }

    try {
        showToast('유튜브 계정을 연결하는 중입니다...', 'toast-info');

        // 보조 Firebase 앱 기반 독립 OAuth 팝업으로 accessToken 수집 (메인 로그인 세션 완전 분리)
        const accessToken = await getYoutubeAccessTokenViaSecondaryApp();

        if (accessToken) {
            // YouTube 채널 ID 조회
            const channelId = await fetchYoutubeChannelId(accessToken);

            if (channelId) {
                localStorage.setItem('ygo_youtube_channel_id', channelId);

                // 백엔드 CSV 목록 비교 API 호출
                const res = await callApi('checkMembershipCsv', {}, { userChannelId: channelId });

                if (res && res.success) {
                    if (res.isMemberActive) {
                        showToast('유튜브 멤버십 인증에 성공했습니다!', 'toast-success');
                    } else {
                        showToast('유튜브 채널 ID가 멤버십 회원 목록에 등록되어 있지 않습니다.', 'toast-warn');
                    }

                    // 전역 스토어 및 UI 즉시 갱신
                    if (res.membership) {
                        if (!UserStore.settings) UserStore.settings = {};
                        UserStore.settings.membership = res.membership;
                        if (typeof applyMembershipStatus === 'function') applyMembershipStatus(res.membership);
                        if (typeof updateAuthUI === 'function') updateAuthUI(UserStore.user);
                    }

                    // 모달 닫기
                    const modalInstance = M.Modal.getInstance(document.getElementById('membership-auth-modal'));
                    if (modalInstance) modalInstance.close();

                    resetMembershipVerifyModal();
                    if (typeof loadUserData === 'function') loadUserData();
                } else {
                    showToast(res?.message || 'CSV 멤버십 비교 검증에 실패했습니다.', 'toast-error');
                }
            } else {
                showToast('유튜브 채널 정보를 찾을 수 없습니다.', 'toast-warn');
            }
        }
    } catch (error) {
        console.error('[Auth] YouTube Verification Error:', error);
        // 사용자가 팝업창을 직접 닫은 경우 오류 메시지 미표시
        if (error.message && error.message.includes('access_denied')) {
            // 사용자가 팝업에서 거부한 경우 — 조용히 처리
        } else {
            showToast('유튜브 채널 연결 중 오류가 발생했습니다: ' + (error.message || '알 수 없는 오류'), 'toast-error');
        }
    }
}

/**
 * [유틸리티] 공통 모달 옵션 반환
 */
function getCommonModalOptions() {
    const isMobile = document.documentElement.classList.contains('is-mobile-device');
    return {
        opacity: 0.4,
        startingTop: '10%',
        endingTop: '10%',
        inDuration: isMobile ? 350 : 300,
        outDuration: isMobile ? 250 : 200,
        onOpenStart: function (el) {
            if (isMobile) document.documentElement.classList.add('modal-open');
        },
        onOpenEnd: function (el) {
            if (isMobile) el.style.top = '';
        },
        onCloseStart: function (el) {
            if (isMobile) document.documentElement.classList.remove('modal-open');
            if (el.id === 'auth-modal' || el.id === 'mobile-auth-modal' || el.id === 'membership-auth-modal' || el.id === 'notice-modal' || el.id === 'notice-list-modal' || el.id === 'notice-detail-modal') {
                toggleBackgroundInert(false);
            }
        }
    };
}

/**
 * 모바일: 공지 목록 렌더링
 */
function updateMobileNoticeList() {
    const container = document.getElementById('mobile-notice-list-container');
    if (!container) return;

    if (notices.length === 0) {
        container.innerHTML = '<div style="padding:40px; text-align:center; color:var(--text-muted);">공지사항이 없습니다.</div>';
        return;
    }

    container.innerHTML = '';
    notices.forEach((noti, idx) => {
        const item = document.createElement('div');
        item.className = 'mobile-noti-item';
        const isNew = isNoticeNew(noti);
        const pinIcon = noti.isPinned > 0 ? '<i class="material-icons" style="font-size:1rem; color:var(--primary-color); margin-right:4px;">push_pin</i>' : '';

        item.innerHTML = `
            <div class="mobile-noti-item-date">${noti.date}</div>
            <div class="mobile-noti-item-title">${pinIcon}${escapeHTML(noti.title)}${isNew ? '<span class="new-indicator" style="margin-left:6px;">NEW</span>' : ''}</div>
        `;
        item.onclick = () => openNoticeDetailMode(idx);
        container.appendChild(item);
    });
}

/**
 * 모바일: 이전/다음 공지 내비게이션
 */
function navigateNotice(direction) {
    const newIndex = currentNoticeIndex + direction;
    if (newIndex >= 0 && newIndex < notices.length) {
        currentNoticeIndex = newIndex;
        const noti = notices[newIndex];

        document.getElementById('mobile-detail-date').innerText = noti.date;
        document.getElementById('mobile-detail-title').innerText = noti.title;
        document.getElementById('mobile-notice-content-body').innerHTML = sanitizeNoticeHtml(noti.content);

        // 읽음 처리
        markNoticeAsRead(noti.date);

        // 스크롤 상단으로
        const contentBody = document.getElementById('mobile-notice-content-body');
        if (contentBody) contentBody.scrollTop = 0;
    } else {
        const msg = direction > 0 ? '마지막 공지입니다.' : '첫 번째 공지입니다.';
        M.toast({ html: msg, displayLength: 1500 });
    }
}

function renderLinkedAccounts(user) {
    // 상단 헤더 캡슐 버튼 업데이트
    const authTextElem = document.getElementById('auth-btn-text');
    const authCapsuleElem = document.getElementById('auth-capsule-btn');
    const authIconElem = authCapsuleElem ? authCapsuleElem.querySelector('.auth-icon') : null;

    if (authTextElem && authCapsuleElem) {
        const verifyBtn = document.getElementById('membership-verify-btn');
        const isMobileDevice = document.documentElement.classList.contains('is-mobile-device');

        if (user) {
            authTextElem.textContent = '로그아웃';
            authCapsuleElem.classList.add('is-logged-in');

            // 멤버십 확인 버튼 표시 제어 (프리미엄이 아니고, 숨기기 설정이 false일 때만 표시)
            const mem = UserStore.settings && UserStore.settings.membership;
            const isPremium = document.body.classList.contains('is-premium') || (mem && mem.status === 'active');
            const isHidden = UserStore.settings.hideMembershipVerify === true;
            const shouldShowVerify = !isPremium && !isHidden;

            if (verifyBtn) {
                // 모바일이 아닐 때만 버튼 노출 (CSS에서도 강제 숨김 처리됨)
                verifyBtn.style.display = (shouldShowVerify && !isMobileDevice) ? 'flex' : 'none';
            }

            // 멤버십 인증이 필요한 경우 프로필 버튼에 알림 점 표시
            authCapsuleElem.classList.toggle('has-noti', shouldShowVerify);

            // 멤버십 여부에 따른 아이콘 변경
            if (isPremium) {
                if (authIconElem) authIconElem.textContent = 'diamond';
            } else {
                if (authIconElem) authIconElem.textContent = 'account_circle';
            }
        } else {
            authTextElem.textContent = '로그인';
            authCapsuleElem.classList.remove('is-logged-in');
            authCapsuleElem.classList.remove('has-noti'); // 비로그인 시 알림 제거
            if (authIconElem) authIconElem.textContent = 'account_circle';

            // 멤버십 확인 버튼 숨김
            if (verifyBtn) verifyBtn.style.display = 'none';
        }
    }

    // 환경설정 페이지 계정 카드 표시 제어
    const infoCard = document.getElementById('user-info-card');
    if (infoCard) {
        if (user) {
            infoCard.style.display = 'block';
            // 실제 데이터 렌더링은 loadUserData 직후에 수행됨
        } else {
            infoCard.style.display = 'none';
        }
    }

    if (!user) {
        // 로그아웃 상태일 때 환경 설정 UI 초기화
        const linkedListElem = document.getElementById('linked-accounts-list');
        if (linkedListElem) linkedListElem.innerHTML = '<div style="color: var(--text-muted); text-align: center;">연결된 외부 서비스가 없습니다.</div>';
        return;
    }

    // 로그아웃 모달 내 연결 계정 리스트 갱신
    const activeProviders = user.providerData.map(p => p.providerId);
    let htmlStr = '';

    const providerMap = {
        'google.com': { name: 'GOOGLE', idField: 'email' },
        'twitter.com': { name: 'X (Twitter)', idField: 'displayName' }
    };


    user.providerData.forEach(pData => {
        const info = providerMap[pData.providerId];
        if (info) {
            let identifier = pData[info.idField] || pData.displayName || pData.uid;
            htmlStr += `<div style="display: flex; justify-content: space-between; margin-bottom: 8px; border-bottom: 1px dotted rgba(0,0,0,0.1); padding-bottom: 4px;">
                <span style="font-weight: 700; color: var(--text-secondary); width: 80px;">${info.name}</span>
                <span style="color: var(--text-primary); text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${identifier}</span>
            </div>`;
        }
    });

    const linkedListElem = document.getElementById('linked-accounts-list');
    if (linkedListElem) {
        linkedListElem.innerHTML = htmlStr || '<div style="color: var(--text-muted); text-align: center;">연결된 외부 서비스가 없습니다.</div>';
    }

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

    const infoCard = document.getElementById('user-info-card');
    const nicknameElem = document.getElementById('display-nickname');
    const joinedElem = document.getElementById('display-joined-date');

    if (!infoCard) return;

    // 멤버십 강조 (테두리)
    if (document.body.classList.contains('is-premium')) {
        infoCard.classList.add('is-premium');
    } else {
        infoCard.classList.remove('is-premium');
    }

    // 닉네임 우선순위: Nickname 필드 > 사용자 UID (계획에 따른 닉네임 기본값)
    const nickname = userData.Nickname || user.uid;
    if (nicknameElem) nicknameElem.textContent = nickname;

    // 가입일 표시
    if (joinedElem && userData.createdAt) {
        const date = userData.createdAt.toDate ? userData.createdAt.toDate() : new Date(userData.createdAt);
        const yyyy = date.getFullYear();
        const mm = String(date.getMonth() + 1).padStart(2, '0');
        const dd = String(date.getDate()).padStart(2, '0');
        const hh = String(date.getHours()).padStart(2, '0');
        const mi = String(date.getMinutes()).padStart(2, '0');
        joinedElem.textContent = `가입일: ${yyyy}-${mm}-${dd} ${hh}:${mi}`;
    }
}

/**
 * 닉네임 수정 모달 토글 (인라인 편집)
 */
function toggleNicknameEdit(isEdit) {
    if (!UserStore.user) return;

    const displayWrapper = document.getElementById('nickname-display-wrapper');
    const editWrapper = document.getElementById('nickname-edit-wrapper');
    const editInput = document.getElementById('nickname-edit-input');
    const currentName = document.getElementById('display-nickname').textContent;

    if (isEdit) {
        displayWrapper.style.display = 'none';
        editWrapper.style.display = 'flex';
        editInput.value = ''; // 입력창 비움
        editInput.placeholder = currentName; // 기존 닉네임을 플레이스홀더로
        editInput.focus();
    } else {
        displayWrapper.style.display = 'flex';
        editWrapper.style.display = 'none';
    }
}

/**
 * 닉네임 수정 확인
 */
function confirmNicknameEdit() {
    const editInput = document.getElementById('nickname-edit-input');
    const newName = editInput.value.trim();
    const currentName = document.getElementById('display-nickname').textContent;

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
    
    try {
        // Firestore 직접 조작 대신 신설된 updateNickname API 엔드포인트 호출
        const res = await callApi('updateNickname', {}, { nickname: newNickname });
        
        if (res && res.success) {
            showToast('닉네임이 성공적으로 변경되었습니다.', 'toast-main');
            toggleNicknameEdit(false);
            loadUserData();
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
        btnElem.className = 'btn red darken-1 waves-effect';
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
        btnElem.className = 'btn cyan-theme waves-effect';
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
    const isMobileDevice = document.documentElement.classList.contains('is-mobile-device');
    const modalId = isMobileDevice ? 'mobile-auth-modal' : 'auth-modal';
    const modalElem = document.getElementById(modalId);
    if (!modalElem) return;

    let instance = M.Modal.getInstance(modalElem);
    if (!instance) {
        instance = M.Modal.init(modalElem, getCommonModalOptions());
    }

    const guideMsg = document.getElementById('login-guide-msg');
    const mobileGuideMsg = document.getElementById('mobile-login-guide-msg');
    const mobileSubMsg = document.getElementById('mobile-login-sub-msg');

    if (UserStore.user) {
        if (guideMsg) guideMsg.style.display = 'none';
        if (mobileGuideMsg) mobileGuideMsg.style.display = 'none';
        if (mobileSubMsg) mobileSubMsg.style.display = 'block';

        if (isMobileDevice) {
            document.getElementById('mobile-login-view').style.display = 'none';
            document.getElementById('mobile-logout-view').style.display = 'block';
            renderMobileLinkedAccounts(UserStore.user);
        } else {
            document.getElementById('login-view').style.display = 'none';
            document.getElementById('logout-view').style.display = 'block';
            renderLinkedAccounts(UserStore.user);
        }
    } else {
        if (guideMsg) guideMsg.style.display = showGuide ? 'block' : 'none';
        if (mobileGuideMsg) mobileGuideMsg.style.display = showGuide ? 'block' : 'none';
        if (mobileSubMsg) mobileSubMsg.style.display = showGuide ? 'none' : 'block';

        if (isMobileDevice) {
            document.getElementById('mobile-login-view').style.display = 'block';
            document.getElementById('mobile-logout-view').style.display = 'none';
            document.getElementById('mobile-privacy-agree-cb').checked = false;
            document.getElementById('mobile-terms-agree-cb').checked = false;
            document.getElementById('mobile-google-login-btn').classList.add('disabled');
            const twBtn = document.getElementById('mobile-twitter-login-btn');
            if (twBtn) twBtn.classList.add('disabled');
        } else {
            document.getElementById('login-view').style.display = 'block';
            document.getElementById('logout-view').style.display = 'none';
            document.getElementById('privacy-agree-cb').checked = false;
            document.getElementById('terms-agree-cb').checked = false;
            document.getElementById('google-login-btn').classList.add('disabled');
            const twBtn = document.getElementById('twitter-login-btn');
            if (twBtn) twBtn.classList.add('disabled');
        }
    }

    toggleBackgroundInert(true);
    instance.open();
}

function renderMobileLinkedAccounts(user) {
    if (!user) return;
    
    const activeProviders = user.providerData.map(p => p.providerId);
    const isGoogleLinked = activeProviders.includes('google.com');
    
    // [상단] 계정 정보 업데이트 (가장 우선되는 provider 정보 사용)
    const providerMap = {
        'google.com': { 
            name: 'Google 계정', 
            htmlIcon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="1.5rem" height="1.5rem"><path fill="#FFC107" d="M43.611,20.083H42V20H24v8h11.303c-1.649,4.657-6.08,8-11.303,8c-6.627,0-12-5.373-12-12c0-6.627,5.373-12,12-12c3.059,0,5.842,1.154,7.961,3.039l5.657-5.657C34.046,6.053,29.268,4,24,4C12.955,4,4,12.955,4,24c0,11.045,8.955,20,20,20c11.045,0,20-8.955,20-20C44,22.659,43.862,21.35,43.611,20.083z" /><path fill="#FF3D00" d="M6.306,14.691l6.571,4.819C14.655,15.108,18.961,12,24,12c3.059,0,5.842,1.154,7.961,3.039l5.657-5.657C34.046,6.053,29.268,4,24,4C16.318,4,9.656,8.337,6.306,14.691z" /><path fill="#4CAF50" d="M24,44c5.166,0,9.86-1.977,13.409-5.192l-6.19-5.238C29.211,35.091,26.715,36,24,36c-5.202,0-9.619-3.317-11.283-7.946l-6.522,5.025C9.505,39.556,16.227,44,24,44z" /><path fill="#1976D2" d="M43.611,20.083H42V20H24v8h11.303c-0.792,2.237-2.231,4.166-4.087,5.571c0.001-0.001,0.002-0.001,0.003-0.002l6.19,5.238C36.971,39.205,44,34,44,24C44,22.659,43.862,21.35,43.611,20.083z" /></svg>`,
            idField: 'email' 
        },
        'twitter.com': { 
            name: 'X (Twitter) 계정', 
            htmlIcon: `<i class="fa-brands fa-x-twitter" style="font-size: 1.5rem; color: var(--text-primary);"></i>`,
            idField: 'displayName' 
        }
    };
    
    let mainProvider = user.providerData[0];
    const googleProvider = user.providerData.find(p => p.providerId === 'google.com');
    if (googleProvider) mainProvider = googleProvider; // 구글 우선
    
    if (mainProvider) {
        const info = providerMap[mainProvider.providerId];
        const identifier = mainProvider[info ? info.idField : 'email'] || mainProvider.displayName || mainProvider.uid;
        
        const iconElem = document.getElementById('mobile-account-icon');
        if (info && info.htmlIcon) {
            iconElem.innerHTML = info.htmlIcon;
        } else {
            iconElem.innerHTML = `<i class="material-icons" style="font-size: 1.5rem;">account_circle</i>`;
        }
        
        document.getElementById('mobile-account-provider').innerText = info ? info.name : mainProvider.providerId;
        document.getElementById('mobile-account-identifier').innerText = identifier;
    }

    // [하단] 구글 연동 상태에 따른 뷰 표시 분기
    const googlePromoView = document.getElementById('mobile-google-promo-view');
    const membershipPromoView = document.getElementById('mobile-membership-promo-view');
    
    if (isGoogleLinked) {
        googlePromoView.style.display = 'none';
        
        // 숨기기 설정 확인
        const isPremium = document.body.classList.contains('is-premium');
        const isHidden = UserStore.settings.hideMembershipVerify === true;
        
        if (isPremium || isHidden) {
            membershipPromoView.style.display = 'none';
        } else {
            membershipPromoView.style.display = 'block';
        }
    } else {
        googlePromoView.style.display = 'block';
        membershipPromoView.style.display = 'none';
    }
}

function toggleLoginBtnMobile() {
    const termsCb = document.getElementById('mobile-terms-agree-cb');
    const privacyCb = document.getElementById('mobile-privacy-agree-cb');
    const gBtn = document.getElementById('mobile-google-login-btn');
    const tBtn = document.getElementById('mobile-twitter-login-btn');

    const isAllAgreed = (termsCb && termsCb.checked) && (privacyCb && privacyCb.checked);

    if (isAllAgreed) {
        if (gBtn) gBtn.classList.remove('disabled');
        if (tBtn) tBtn.classList.remove('disabled');
    } else {
        if (gBtn) gBtn.classList.add('disabled');
        if (tBtn) tBtn.classList.add('disabled');
    }
}

function toggleLoginBtn() {
    const termsCb = document.getElementById('terms-agree-cb');
    const privacyCb = document.getElementById('privacy-agree-cb');
    const gBtn = document.getElementById('google-login-btn');
    const tBtn = document.getElementById('twitter-login-btn');

    const isAllAgreed = (termsCb && termsCb.checked) && (privacyCb && privacyCb.checked);

    if (isAllAgreed) {
        if (gBtn) gBtn.classList.remove('disabled');
        if (tBtn) tBtn.classList.remove('disabled');
    } else {
        if (gBtn) gBtn.classList.add('disabled');
        if (tBtn) tBtn.classList.add('disabled');
    }
}

function signInWithProvider(providerName) {
    const isMobileDevice = document.documentElement.classList.contains('is-mobile-device');
    const btnId = isMobileDevice
        ? (providerName === 'google' ? 'mobile-google-login-btn' : 'mobile-twitter-login-btn')
        : (providerName === 'google' ? 'google-login-btn' : 'twitter-login-btn');
    const btn = document.getElementById(btnId);
    if (!btn || btn.classList.contains('disabled')) return;

    if (typeof firebase === 'undefined' || !firebase.auth) {
        return;
    }

    const provider = getProviderInstance(providerName);
    if (!provider) return;

    const hostname = window.location.hostname;
    // 로컬 환경인 경우 세션 연동을 위해 signInWithPopup을 사용하고, 실서버 환경인 경우 COOP 경고 방지를 위해 signInWithRedirect를 사용
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
        firebase.auth().signInWithPopup(provider).then(async (result) => {
            // 로컬 팝업 로그인 성공 시 로그인 모달/바텀시트 자동 종료
            const modalId = isMobileDevice ? 'mobile-auth-modal' : 'auth-modal';
            const modalElem = document.getElementById(modalId);
            if (modalElem) {
                const instance = M.Modal.getInstance(modalElem);
                if (instance) instance.close();
            }
        }).catch((error) => {
            console.error("Login Error:", error);
            showToast('로그인 실패: ' + error.message, 'toast-error');
        });
    } else {
        firebase.auth().signInWithRedirect(provider).catch((error) => {
            console.error("Login Error:", error);
            showToast('로그인 실패: ' + error.message, 'toast-error');
        });
    }
}

/**
 * 유튜브 멤버십 인증 모달 오픈
 */
function openMembershipAuthModal() {
    if (!UserStore.user) {
        showToast('로그인이 필요합니다.', 'toast-warn');
        return;
    }

    // 현재 유저의 연동 상태 뱃지 업데이트
    const badgeContainer = document.getElementById('membership-current-status-badge');
    const discordBadge = document.getElementById('badge-discord-linked');
    const youtubeBadge = document.getElementById('badge-youtube-linked');

    if (discordBadge) discordBadge.style.display = 'none';
    if (youtubeBadge) youtubeBadge.style.display = 'none';

    const membership = UserStore.settings && UserStore.settings.membership;

    if (membership && membership.status === 'active') {
        const typeName = membership.type === 'discord' ? '멤버십 인증 완료' : '유튜브 채널 (CSV)';

        if (badgeContainer) {
            badgeContainer.innerHTML = `<span style="background: rgba(0,188,212,0.12); color: var(--primary-color); border: 1px solid var(--primary-color); padding: 4px 12px; border-radius: 20px; font-weight: 700; font-size: 0.85rem; display: inline-flex; align-items: center; gap: 4px;">
                <i class="material-icons" style="font-size: 1rem;">check_circle</i> ${typeName}
            </span>`;
        }

        if (membership.type === 'discord' && discordBadge) {
            discordBadge.style.display = 'inline-block';
        } else if (membership.type === 'csv' && youtubeBadge) {
            youtubeBadge.style.display = 'inline-block';
        }
    } else {
        if (badgeContainer) {
            badgeContainer.innerHTML = `<span style="background: var(--bg-surface); color: var(--text-muted); border: 1px solid var(--border-color); padding: 4px 12px; border-radius: 20px; font-weight: 600; font-size: 0.82rem;">
                현재 연동된 멤버십이 없습니다.
            </span>`;
        }
    }

    const modalElem = document.getElementById('membership-auth-modal');
    if (modalElem) {
        let instance = M.Modal.getInstance(modalElem);
        if (!instance) {
            instance = M.Modal.init(modalElem, typeof getCommonModalOptions === 'function' ? getCommonModalOptions() : {});
        }
        if (typeof toggleBackgroundInert === 'function') toggleBackgroundInert(true);
        instance.open();
    }
}

/**
 * 디스코드 멤버십 인증 시작
 */
async function startDiscordMembershipVerify() {
    if (!UserStore.user) {
        showToast('로그인이 필요합니다.', 'toast-warn');
        return;
    }

    const DISCORD_CLIENT_ID = "1536191827705733191";
    const redirectUri = window.location.origin + window.location.pathname;
    
    // OAuth state 저장 (보안 및 연동 구분용)
    sessionStorage.setItem('discord_oauth_pending', 'true');

    const authUrl = `https://discord.com/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&scope=identify`;
    
    // 디스코드 OAuth 인증 페이지로 이동
    window.location.href = authUrl;
}

/**
 * 디스코드 OAuth2 리다이렉트 자동 감지 및 백엔드 검증 처리
 */
async function handleDiscordOAuthCallback() {
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');
    const isPending = sessionStorage.getItem('discord_oauth_pending');

    if (code && isPending) {
        sessionStorage.removeItem('discord_oauth_pending');

        // URL 파라미터 정리
        const cleanUrl = window.location.origin + window.location.pathname;
        window.history.replaceState({}, document.title, cleanUrl);

        try {
            showToast('디스코드 멤버십 역할을 검증하는 중입니다...', 'toast-info');

            // Firebase Auth 세션 복원 완료 대기 (최대 5초)
            if (typeof waitForAuthInit === 'function') {
                await waitForAuthInit(5000);
            }

            // currentUser 토큰 최신화
            const currentUser = firebase.auth().currentUser;
            if (currentUser) {
                _cachedAuthToken = await currentUser.getIdToken(true);
            }

            const redirectUri = cleanUrl;
            const res = await callApi('checkMembershipDiscord', {}, { code, redirectUri });

            if (res && res.success) {
                if (res.isMemberActive) {
                    showToast('디스코드 멤버십 인증에 성공했습니다! 혜택이 적용됩니다.', 'toast-success');
                } else {
                    showToast(res.details || '디스코드 서버에 가입되어 있지 않거나 멤버십 역할이 없습니다.', 'toast-warn');
                }

                // 전역 스토어 및 UI 즉시 갱신
                if (res.membership) {
                    if (!UserStore.settings) UserStore.settings = {};
                    UserStore.settings.membership = res.membership;
                    if (typeof applyMembershipStatus === 'function') applyMembershipStatus(res.membership);
                    if (typeof updateAuthUI === 'function') updateAuthUI(UserStore.user);
                }

                // 프로필/유저 데이터 갱신
                if (typeof loadUserData === 'function') loadUserData();
            } else {
                showToast(res?.message || '디스코드 멤버십 연동에 실패했습니다.', 'toast-error');
            }
        } catch (err) {
            console.error('[Auth] Discord verification error:', err);
            showToast('디스코드 연동 중 오류가 발생했습니다: ' + err.message, 'toast-error');
        }
    }
}


/**
 * 멤버십 인증 메시지 숨기기 핸들러 (2단계 확인)
 */
let membershipHideClickCount = 0;
async function handleNeverShowMembership() {
    const btn = document.getElementById('never-show-membership-verify');
    if (!btn) return;

    if (membershipHideClickCount === 0) {
        // 1단계 클릭: 문구 변경
        membershipHideClickCount = 1;
        btn.innerHTML = '환경 설정에서도 멤버십 인증을 할 수 있습니다.<br>(진행하려면 한 번 더 눌러주세요.)';
        btn.style.color = 'var(--text-secondary)';
        btn.style.fontSize = '0.8rem';
        btn.style.lineHeight = '1.4';
    } else {
        // 2단계 클릭: DB 저장 및 버튼 숨김
        if (!UserStore.user) return;

        try {
            await saveUserSetting('hideMembershipVerify', true);

            // 데스크탑 모달 닫기
            const modalInstance = M.Modal.getInstance(document.getElementById('membership-auth-modal'));
            if (modalInstance) modalInstance.close();

            // 모바일 모달 닫기 추가
            const mobileModalInstance = M.Modal.getInstance(document.getElementById('mobile-auth-modal'));
            if (mobileModalInstance) mobileModalInstance.close();

            // 즉시 UI 업데이트: 버튼 숨김 및 알림 점 제거
            const verifyBtn = document.getElementById('membership-verify-btn');
            if (verifyBtn) verifyBtn.style.display = 'none';
            const authCapsuleElem = document.getElementById('auth-capsule-btn');
            if (authCapsuleElem) authCapsuleElem.classList.remove('has-noti');

            // 카운트 초기화
            resetMembershipVerifyModal();
        } catch (err) {
            console.error("Failed to save hide setting:", err);
            showToast('설정 저장에 실패했습니다.', 'toast-error');
        }
    }
}

let mobileMembershipHideClickCount = 0;
async function handleNeverShowMembershipMobile() {
    const btn = document.getElementById('mobile-never-show-membership');
    if (!btn) return;

    if (mobileMembershipHideClickCount === 0) {
        mobileMembershipHideClickCount = 1;
        btn.innerHTML = '환경 설정에서도 멤버십 인증을 할 수 있습니다.<br>(진행하려면 한 번 더 눌러주세요.)';
        btn.style.color = 'var(--text-secondary)';
    } else {
        if (!UserStore.user) return;
        try {
            await saveUserSetting('hideMembershipVerify', true);
            const mobileModalInstance = M.Modal.getInstance(document.getElementById('mobile-auth-modal'));
            if (mobileModalInstance) mobileModalInstance.close();
            
            const authCapsuleElem = document.getElementById('auth-capsule-btn');
            if (authCapsuleElem) authCapsuleElem.classList.remove('has-noti');
            
            mobileMembershipHideClickCount = 0;
            btn.textContent = '다시 표시하지 않음';
            btn.style.color = 'var(--text-secondary)';
        } catch (err) {
            showToast('설정 저장에 실패했습니다.', 'toast-error');
        }
    }
}

/**
 * 모달 상태 초기화 (닫힐 때 호출 권장)
 */
function resetMembershipVerifyModal() {
    membershipHideClickCount = 0;
    const btn = document.getElementById('never-show-membership-verify');
    if (btn) {
        btn.textContent = '다시 표시하지 않음';
        btn.style.color = ''; // 기본 스타일로 복구
        btn.style.fontSize = '';
        btn.style.lineHeight = '';
    }
}

function toggleProviderLink(providerName) {
    if (!UserStore.user) return;

    const providerId = providerName === 'google' ? 'google.com' : 'twitter.com';
    const activeProviders = UserStore.user.providerData.map(p => p.providerId);

    if (activeProviders.includes(providerId)) {
        // 이미 연결됨 -> 연결 해제
        if (activeProviders.length <= 1) {
            return;
        }
        UserStore.user.unlink(providerId).then((result) => {
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
        UserStore.user.linkWithPopup(provider).then((result) => {
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
    if (!UserStore.user) return;

    // 계정 삭제 전용 모달이 있으므로 데이터 삭제와 구분하여 처리 (기존 confirm 유지 혹은 모달 통합 가능)
    if (confirm("정말로 계정을 삭제하시겠습니까?\n모든 데이터와 연동 정보가 영구 삭제됩니다.")) {
        UserStore.user.delete().then(() => {
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
    if (!checkAuthBeforeAction()) return;
    const modalElem = document.getElementById('data-clear-confirm-modal');
    if (modalElem) M.Modal.getInstance(modalElem).open();
}

/**
 * 데이터 삭제 실행
 */
async function executeDataClear() {
    if (!UserStore.user) return;

    const execBtn = document.getElementById('data-clear-exec-btn');
    const spinner = document.getElementById('data-clear-spinner');

    try {
        // 로딩 상태 활성화
        if (execBtn) execBtn.classList.add('disabled');
        if (spinner) spinner.style.display = 'block';

        const idToken = await UserStore.user.getIdToken();
        const response = await fetch(FIREBASE_CONFIG.ENDPOINTS.clearUserData, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${idToken}`
            },
            body: JSON.stringify({})
        });

        // 응답 상태 확인
        if (!response.ok) {
            throw new Error(`HTTP Error: ${response.status}`);
        }

        const result = await response.json();
        if (result.success) {
            // 성공 시 확인 모달 닫고 결과 모달 오픈
            const confirmModal = M.Modal.getInstance(document.getElementById('data-clear-confirm-modal'));
            if (confirmModal) confirmModal.close();

            const successModal = M.Modal.getInstance(document.getElementById('data-clear-success-modal'));
            if (successModal) successModal.open();

            // 로컬 캐시 및 UI 초기화
            cardCacheInstance.clearAll();
            await loadUserData(); // getUserData -> loadUserData (ReferenceError 해결)
            renderHomeDash();
        } else {
            showToast(result.message || '데이터 삭제에 실패했습니다.', 'toast-error');
        }
    } catch (error) {
        console.error("Data Clear Error:", error);
        showToast('서버 통신 중 오류가 발생했습니다.', 'toast-error');
    } finally {
        // 로딩 상태 해제
        if (execBtn) execBtn.classList.remove('disabled');
        if (spinner) spinner.style.display = 'none';
    }
}

function signOutCurrentUser() {
    AutoLogoutManager.stop();
    if (typeof firebase !== 'undefined' && firebase.auth) {
        firebase.auth().signOut().then(() => {
            const isMobileDevice = document.documentElement.classList.contains('is-mobile-device');
            const modalId = isMobileDevice ? 'mobile-auth-modal' : 'auth-modal';
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

/**
 * [개편] Storage(notices.json)에서 공지사항 데이터를 가져옵니다.
 * JSON 파일은 이미 정렬된 상태로 저장되어 있으므로 별도 정렬 불필요.
 */
async function fetchNotices() {
    try {
        let url = 'https://storage.googleapis.com/ygo-synapse.firebasestorage.app/public%2Fnotices.json';
        if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
            url = 'http://127.0.0.1:9199/v0/b/ygo-synapse.firebasestorage.app/o/public%2Fnotices.json?alt=media';
        }
        const res = await fetch(url);
        if (!res.ok) {
            // 파일이 존재하지 않는 경우(404 등) 예외를 발생시키지 않고 빈 공지로 처리
            notices = [];
            updateNotiBadge();
            return;
        }
        const data = await res.json();

        // id 형식: "YYYY-MM-DDTHH:MM" (KST)
        // createdAt: id를 KST 기준으로 파싱하여 정확한 작성 시각 반영
        notices = (data.notices || []).map(n => ({
            ...n,
            createdAt: new Date(n.id + ':00+09:00').getTime()
        }));

        // 데이터 로드 후 초기 UI 업데이트
        updateNotiBadge();
    } catch (error) {
        notices = [];
        updateNotiBadge();
        console.warn("Notice file fetch failed or empty notices:", error.message || error);
    }
}

function getTop8NoticeUids() {
    return notices.slice(0, 8).map(n => `${n.date}-${n.title}`);
}

/**
 * 공지가 '신규' 상태인지 판별합니다 (최신 8개 이내 & 미열람).
 */
function isNoticeNew(noti) {
    const top8Uids = getTop8NoticeUids();
    const notiUid = `${noti.date}-${noti.title}`;

    // 최신 8개 이내의 공지가 아니면 무조건 읽은 것으로 간주 (새 공지 아님)
    if (!top8Uids.includes(notiUid)) return false;

    // 읽음 상태 확인
    const readList = JSON.parse(localStorage.getItem(READ_NOTICES_KEY) || '[]');
    return !readList.includes(notiUid);
}

/**
 * 특정 날짜의 모든 공지를 읽음 처리합니다 (최신 8개 제한 동기화).
 */
function markDateAsRead(date) {
    const readList = JSON.parse(localStorage.getItem(READ_NOTICES_KEY) || '[]');
    const top8Uids = getTop8NoticeUids();
    let changed = false;

    notices.filter(n => n.date === date).forEach(noti => {
        const notiUid = `${noti.date}-${noti.title}`;
        // 최신 8개 이내 공지일 때만 읽음 목록에 추가
        if (top8Uids.includes(notiUid) && !readList.includes(notiUid)) {
            readList.push(notiUid);
            changed = true;
        }
    });

    if (changed) {
        // 저장 시, 최신 8개에 해당하지 않게 된(오래된) UID들은 배열에서 정리
        const updatedReadList = readList.filter(uid => top8Uids.includes(uid));

        localStorage.setItem(READ_NOTICES_KEY, JSON.stringify(updatedReadList));
        updateNotiBadge();

        // 서버 동기화
        if (typeof saveUserSetting === 'function') {
            saveUserSetting('readNotices', updatedReadList);
        }

        // 팝업이 열려있다면 즉시 갱신
        const popup = document.getElementById('noti-popup');
        if (popup && popup.classList.contains('active')) {
            renderNotiPopup();
        }
    }
}

function toggleNotiPopup(event) {
    if (event) event.stopPropagation();
    const popup = document.getElementById('noti-popup');
    if (!popup) return;

    const isActive = popup.classList.contains('active');

    // 다른 요소를 클릭했을 때 팝업을 닫기 위한 일회성 리스너
    if (!isActive) {
        popup.classList.add('active');
        renderNotiPopup();

        const closePopup = (e) => {
            if (!popup.contains(e.target)) {
                popup.classList.remove('active');
                document.removeEventListener('click', closePopup);
            }
        };
        document.addEventListener('click', closePopup);
    } else {
        popup.classList.remove('active');
    }
}

function renderNotiPopup() {
    const listContainer = document.getElementById('noti-list-container');
    if (!listContainer) return;

    // 최대 5개 노출 (이미 정렬된 notices 사용)
    const displayNotices = notices.slice(0, 5);

    let htmlStr = '';
    displayNotices.forEach(noti => {
        const isNew = isNoticeNew(noti);
        const pinIcon = noti.isPinned > 0 ? '<i class="material-icons pin-icon">push_pin</i>' : '';
        htmlStr += `
            <div class="noti-item ${noti.isPinned > 0 ? 'is-pinned' : ''} ${isNew ? 'is-new' : ''}" onclick="openNoticeModal('${noti.date}')">
                <div class="noti-item-title">${pinIcon}${escapeHTML(noti.title)}</div>
                <div class="noti-item-date">${noti.date}</div>
            </div>
        `;
    });

    if (notices.length === 0) {
        htmlStr += `<div style="padding: 20px; text-align: center; color: var(--text-muted); font-size: 0.9rem;">공지사항이 없습니다.</div>`;
    }

    listContainer.innerHTML = htmlStr;
}

function updateNotiBadge() {
    const badge = document.getElementById('noti-badge');
    if (!badge) return;

    // 신규 공지가 하나라도 있는지 확인 (최신 8개 검사는 isNoticeNew 내에서 처리됨)
    const hasUnreadNew = notices.slice(0, 8).some(noti => isNoticeNew(noti));
    badge.style.display = hasUnreadNew ? 'block' : 'none';
}
/**
 * 데스크탑: 날짜별 공지 내용 렌더링
 */
function renderNoticeContentByDate(date, element) {
    const contentArea = document.getElementById('notice-content-area');
    const dateItems = document.querySelectorAll('.date-item');

    // 사이드바 활성화 표시 업데이트
    dateItems.forEach(item => item.classList.remove('active'));
    if (element) {
        element.classList.add('active');
    } else {
        dateItems.forEach(item => {
            if (item.textContent.trim().startsWith(date)) item.classList.add('active');
        });
    }

    const noticesOnDate = notices.filter(n => n.date === date).sort((a, b) => {
        if (a.isPinned !== b.isPinned) {
            if (a.isPinned > 0 && b.isPinned > 0) return a.isPinned - b.isPinned;
            return b.isPinned > 0 ? 1 : -1;
        }
        return b.createdAt - a.createdAt;
    });

    let contentHtml = '';
    noticesOnDate.forEach(noti => {
        const pinIcon = noti.isPinned > 0 ? '<i class="material-icons pin-icon">push_pin</i>' : '';
        contentHtml += `<div class="notice-content-item">
            <div class="notice-content-title">${pinIcon}${escapeHTML(noti.title)}</div>
            <div class="notice-content-date">등록일: ${noti.date} ${new Date(noti.createdAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}</div>
            <div class="notice-content-body">${sanitizeNoticeHtml(noti.content)}</div>
        </div>`;
    });

    contentArea.innerHTML = contentHtml;
    contentArea.scrollTop = 0;

    // 해당 날짜 읽음 처리
    markNoticeAsRead(date);

    // new 라벨 제거
    if (element) {
        const indicator = element.querySelector('.new-indicator');
        if (indicator) indicator.remove();
    } else {
        dateItems.forEach(item => {
            if (item.textContent.trim().startsWith(date)) {
                const indicator = item.querySelector('.new-indicator');
                if (indicator) indicator.remove();
            }
        });
    }
}

/**
 * 공지사항 읽음 처리 유틸리티
 */
function markNoticeAsRead(date) {
    if (typeof markDateAsRead === 'function') {
        markDateAsRead(date);
    }
}

/**
 * [공지사항 전용 도구] 콘솔용 공지사항 관리 헬퍼 (NoticeSet)
 * 사용법: NoticeSet.list(), NoticeSet.add(), NoticeSet.update(), NoticeSet.delete()
 */
window.NoticeSet = {
    url: FIREBASE_CONFIG.ENDPOINTS.manageNotice,

    storageUrl: (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
        ? "http://127.0.0.1:9199/v0/b/ygo-synapse.firebasestorage.app/o/public%2Fnotices.json?alt=media"
        : "https://storage.googleapis.com/ygo-synapse.firebasestorage.app/public/notices.json",

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
            if (res.ok && typeof fetchNotices === 'function') fetchNotices();
            return result;
        } catch (e) {
            console.error("요청 중 오류 발생:", e);
            return { success: false, error: e.toString() };
        }
    },

    async list() {
        try {
            const res = await fetch(this.storageUrl);
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

    // 🛡️ 일반 관리자 지정 / 해제 (owner 전용, DB membership 자동 동기화)
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
function toggleMigrationTab(mode) {
    const fileContent = document.getElementById('mig-content-file');
    const sheetContent = document.getElementById('mig-content-sheet');
    const statusMsg = document.getElementById('migration-status-msg');

    if (mode === 'file') {
        fileContent.style.display = 'block';
        sheetContent.style.display = 'none';
        handleMigrationFileUpload({ target: document.getElementById('migration-file-input') }); // 기존 선택 파일 체크
    } else {
        fileContent.style.display = 'none';
        sheetContent.style.display = 'block';
        validateMigrationLink(); // 기존 입력 링크 체크
    }
    statusMsg.innerHTML = '';
}

/**
 * [파일] 마이그레이션용 엑셀/CSV 파일 업로드 및 검증
 */
let pendingMigrationData = null; // 업로드된 임시 데이터 저장

function handleMigrationFileUpload(event) {
    const file = event.target.files?.[0];
    const fileNameElem = document.getElementById('mig-file-name');
    const execBtn = document.getElementById('migration-exec-btn');
    const statusMsg = document.getElementById('migration-status-msg');

    if (!file) {
        pendingMigrationData = null;
        execBtn.classList.add('disabled');
        return;
    }

    fileNameElem.textContent = file.name;
    const reader = new FileReader();
    reader.onload = function (e) {
        try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array' });

            // 1. MyCard 시트 존재 여부 확인
            if (!workbook.SheetNames.includes('MyCard')) {
                throw new Error('"MyCard" 시트를 찾을 수 없습니다.');
            }

            const sheet = workbook.Sheets['MyCard'];
            const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1 });

            if (jsonData.length < 1) throw new Error('데이터가 없는 빈 파일입니다.');

            // 2. 헤더 행 유효성 검사
            const headers = jsonData[0].map(h => String(h || "").trim());
            const requiredHeaders = ["카드 이름", "카드 번호", "레어도", "보관 위치", "일러스트"];
            const missing = requiredHeaders.filter(h => !headers.includes(h));

            if (missing.length > 0) {
                throw new Error(`필수 항목이 누락되었습니다: ${missing.join(', ')}`);
            }

            statusMsg.innerHTML = '파일 검증 완료. 이관을 진행할 수 있습니다.';
            statusMsg.className = 'status-msg success';
            statusMsg.style.color = 'var(--success-green)';
            execBtn.classList.remove('disabled');

            // 전송용 데이터 정제 (JSON 배열)
            const rows = XLSX.utils.sheet_to_json(sheet); // 객체 배열로 변환
            pendingMigrationData = rows.map(r => ({
                name: r["카드 이름"],
                no: r["카드 번호"],
                rare: r["레어도"],
                loc: r["보관 위치"],
                illust: r["일러스트"]
            }));

        } catch (error) {
            statusMsg.innerHTML = error.message;
            statusMsg.className = 'status-msg error';
            statusMsg.style.color = 'var(--error-red)';
            execBtn.classList.add('disabled');
            pendingMigrationData = null;
        }
    };
    reader.readAsArrayBuffer(file);
}

function openMigrationModal(mode = 'sheet') {
    const modalElem = document.getElementById('migration-modal');
    if (!modalElem) return;

    // [버그 수정] 모달 오픈 시 초기화 로직 보강
    document.getElementById('migration-sheet-url').value = '';
    document.getElementById('migration-file-input').value = '';
    document.getElementById('migration-valid-mark').className = 'valid-icon';
    document.getElementById('migration-status-msg').className = 'status-msg';
    document.getElementById('migration-status-msg').innerHTML = '';
    document.getElementById('migration-exec-btn').classList.add('disabled');
    document.getElementById('mig-file-name').textContent = '파일 선택 (xlsx, csv)';

    const spinner = document.getElementById('migration-spinner');
    if (spinner) spinner.style.display = 'none';

    // 전달된 모드에 따라 탭 설정 (기본: sheet)
    const isSheet = mode === 'sheet';
    document.getElementById('mig-mode-sheet').checked = isSheet;
    document.getElementById('mig-mode-file').checked = !isSheet;
    toggleMigrationTab(mode);

    M.Modal.getInstance(modalElem).open();
}

function validateMigrationLink() {
    clearTimeout(migrationValidationTimeout);
    const input = document.getElementById('migration-sheet-url');
    const url = input.value.trim();
    const mark = document.getElementById('migration-valid-mark');
    const msg = document.getElementById('migration-status-msg');
    const execBtn = document.getElementById('migration-exec-btn');

    // 초기화: 클래스 및 버튼 상태
    input.classList.remove('state-error', 'state-warning', 'state-success');
    execBtn.classList.add('disabled');

    if (!url) {
        mark.innerHTML = '';
        msg.innerHTML = '';
        return;
    }

    // 로컬 에뮬레이터 개발 환경 차단 및 안내 처리
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
        mark.innerHTML = '<i class="material-icons" style="color: var(--warning-yellow)">warning</i>';
        msg.innerHTML = '로컬 환경에선 구글 시트에 접속할 수 없습니다.';
        msg.style.color = 'var(--warning-yellow)';
        input.classList.add('state-warning');
        return;
    }

    // Google Sheets URL 패턴 검증 (/spreadsheets/d/[ID]/...)
    const match = url.match(/docs\.google\.com\/spreadsheets\/d\/([-\w]{25,})/);

    if (!match) {
        mark.innerHTML = '<i class="material-icons" style="color: var(--error-red)">cancel</i>';
        msg.innerHTML = '올바르지 않은 링크 형식입니다.';
        msg.style.color = 'var(--error-red)';
        input.classList.add('state-error');
        return;
    }

    // 검증 중 상태 (스피너 노출)
    mark.innerHTML = '<div class="loading-spinner"></div>';
    msg.innerHTML = '시트 정보 조회 중...';
    msg.style.color = 'var(--text-secondary)';

    migrationValidationTimeout = setTimeout(async () => {
        try {
            // [참고] callApi 대신 직접 fetch를 사용하여 마이그레이션 전용 검증 수행 (ssId 파라미터 제외를 위해) -- 혹은 callApi 활용
            // 여기서는 기존 callApi 로직을 재활용하되, 필요한 정보만 추출
            const res = await callApi('checkSheet', { targetId: match[1] });

            input.classList.remove('state-error', 'state-warning', 'state-success');

            if (res && res.status === 'OK') {
                // 초록: 조회 성공
                mark.innerHTML = '<i class="material-icons" style="color: var(--success-green)">check_circle</i>';
                msg.innerHTML = `조회 성공: ${res.sheetName || '구글 시트'}`;
                msg.style.color = 'var(--success-green)';
                input.classList.add('state-success');
                execBtn.classList.remove('disabled'); // 성공 시에만 활성화
            } else if (res && res.status === 'NO_ACCESS') {
                // 노랑: 읽기 권한 없음
                mark.innerHTML = '<i class="material-icons" style="color: var(--warning-yellow)">warning</i>';
                msg.innerHTML = '읽기 권한이 없습니다. 공유 설정을 확인해주세요.';
                msg.style.color = 'var(--warning-yellow)';
                input.classList.add('state-warning');
            } else {
                // 빨강: 존재하지 않거나 기타 오류
                mark.innerHTML = '<i class="material-icons" style="color: var(--error-red)">error</i>';
                msg.innerHTML = '파일을 찾을 수 없거나 접근할 수 없습니다.';
                msg.style.color = 'var(--error-red)';
                input.classList.add('state-error');
            }
        } catch (e) {
            console.error("Link validation error:", e);
            mark.innerHTML = '<i class="material-icons" style="color: var(--error-red)">error</i>';
            msg.innerHTML = '연결 확인 실패';
            msg.style.color = 'var(--error-red)';
            input.classList.add('state-error');
        }
    }, 500);
}

async function executeMigration() {
    if (!checkAuthBeforeAction()) return;

    const activeMode = document.querySelector('input[name="migration-mode"]:checked').value;
    const execBtn = document.getElementById('migration-exec-btn');
    const statusMsg = document.getElementById('migration-status-msg');
    const spinner = document.getElementById('migration-spinner');

    let payload = {};

    let action = '';
    if (activeMode === 'sheet') {
        const url = document.getElementById('migration-sheet-url').value.trim();
        const match = url.match(/docs\.google\.com\/spreadsheets\/d\/([-\w]{25,})/);
        if (!match) return;
        payload.spreadsheetId = match[1];
        action = 'migrateFromSheet';
    } else {
        if (!pendingMigrationData) return;
        payload.data = pendingMigrationData;
        action = 'migrateFromData';
    }

    try {
        execBtn.classList.add('disabled');
        if (spinner) spinner.style.display = 'block';
        statusMsg.innerHTML = '데이터 이관 중...';
        statusMsg.className = 'status-msg';

        // callApi 헬퍼 함수를 활용하여 동적으로 엔드포인트를 호출하고, 인증 토큰 및 App Check 세팅을 위임
        const result = await callApi(action, {}, payload);

        if (result && result.success) {
            const modalElem = document.getElementById('migration-modal');
            if (modalElem) M.Modal.getInstance(modalElem).close();

            showMigrationResultModal(result);

            // [버그 수정] 로컬 캐시 초기화 및 내 인벤토리 데이터 재로드
            cardCacheInstance.clearAll();
            await loadUserData();
            renderHomeDash();
        } else {
            statusMsg.innerHTML = result.message || '마이그레이션에 실패했습니다.';
            statusMsg.className = 'status-msg error';
            execBtn.classList.remove('disabled');
        }
    } catch (error) {
        console.error('Migration error:', error);
        statusMsg.innerHTML = '서버 통신 중 오류가 발생했습니다.';
        statusMsg.className = 'status-msg error';
        execBtn.classList.remove('disabled');
    } finally {
        if (spinner) spinner.style.display = 'none';
    }
}

/**
 * 마이그레이션 결과 모달 렌더링 (심플 버전: 5행 제한)
 */
function showMigrationResultModal(result) {
    const modalElem = document.getElementById('migration-result-modal');
    if (!modalElem) return;

    const summaryBody = document.getElementById('migration-summary-body');
    const successText = document.getElementById('migration-success-text');
    const iconArea = document.getElementById('migration-icon-area');

    if (!summaryBody || !successText || !iconArea) return;

    // 초기화
    summaryBody.innerHTML = '';
    iconArea.innerHTML = '<div class="success-checkmark"><div class="check-icon"><span class="icon-line line-tip"></span><span class="icon-line line-long"></span><div class="icon-circle"></div><div class="icon-fix"></div></div></div>';

    const items = result.updatedItems || [];
    const totalCount = items.length;

    successText.innerHTML = `총 <strong>${result.importedCount || totalCount}</strong>개의 데이터를 성공적으로 이관했습니다.`;

    // 상위 5개만 렌더링
    const displayItems = items.slice(0, 5);
    displayItems.forEach(item => {
        const row = `<tr>
            <td style="width:70%; text-align:left; padding:12px 15px; border-bottom:1px solid var(--border-color);">${item.name}</td>
            <td style="width:30%; text-align:right; padding:12px 15px; border-bottom:1px solid var(--border-color); color:var(--primary-color); font-weight:700;">+${item.qty}장</td>
        </tr>`;
        summaryBody.insertAdjacentHTML('beforeend', row);
    });

    // 6개째부터는 요약 표시
    if (totalCount > 5) {
        const remainingItems = items.slice(5);
        const remainingKinds = remainingItems.length;
        const remainingQty = remainingItems.reduce((acc, curr) => acc + (curr.qty || 0), 0);

        const summaryRow = `<tr class="summary-extra-row">
            <td colspan="2" style="text-align:center; padding:15px; color:var(--text-secondary); font-size:0.9rem; background:rgba(var(--primary-rgb), 0.05); border-top:1px solid var(--border-color);">
                그 외 <strong>${remainingKinds}종</strong> | <strong>${remainingQty}장</strong>
            </td>
        </tr>`;
        summaryBody.insertAdjacentHTML('beforeend', summaryRow);
    }

    M.Modal.getInstance(modalElem).open();
}

function checkAuthBeforeAction() {
    if (!UserStore.user) {
        toggleAuthModal();
        showToast('로그인이 필요합니다.', 'toast-warn');
        return false;
    }
    return true;
}



// Firebase 인증 초기화(initFirebaseAuth)는 initApp에서 통합 호출됩니다.

/**
 * 홈 화면 대시보드 렌더링
 */
function renderHomeDash() {
    const locStats = document.getElementById('location-stats');
    const rareStats = document.getElementById('rarity-stats');
    if (!locStats || !rareStats) return;

    const locations = cardCacheInstance.getLocationsMap();
    const rarities = cardCacheInstance.getRaritiesMap();

    // 1. 위치별 현황
    let locHtml = "";
    const locKeys = Object.keys(locations).sort();
    if (locKeys.length === 0) {
        locHtml = '<div style="width:100%; padding:20px; text-align:center; color:var(--text-muted); border-bottom:1px solid var(--border-color);">데이터가 없습니다.</div>';
    } else {
        locKeys.forEach((loc, idx) => {
            const list = locations[loc] || [];
            const count = list.length;
            const hiddenClass = idx >= 3 ? "is-hidden" : "";
            locHtml += `<div class="stat-item ${hiddenClass}"><span class="stat-name">${loc}</span><span class="stat-cnt">${count}종</span></div>`;
        });
        if (locKeys.length > 3) {
            locHtml += `<button class="stat-more-btn" onclick="toggleStatSection(this)">
                            <span>더보기</span><i class="material-icons">expand_more</i>
                        </button>`;
        }
    }
    locStats.innerHTML = locHtml;

    // 2. 레어도별 현황
    let rareHtml = "";
    const rareKeys = Object.keys(rarities).sort(compareRarity);
    if (rareKeys.length === 0) {
        rareHtml = '<div style="width:100%; padding:20px; text-align:center; color:var(--text-muted); border-bottom:1px solid var(--border-color);">데이터가 없습니다.</div>';
    } else {
        rareKeys.forEach((rare, idx) => {
            const count = rarities[rare];
            const hiddenClass = idx >= 3 ? "is-hidden" : "";
            rareHtml += `<div class="stat-item ${hiddenClass}"><span class="stat-name">${getLocalizedRarity(rare)}</span><span class="stat-cnt">${count}장</span></div>`;
        });
        if (rareKeys.length > 3) {
            rareHtml += `<button class="stat-more-btn" onclick="toggleStatSection(this)">
                            <span>더보기</span><i class="material-icons">expand_more</i>
                        </button>`;
        }
    }
    rareStats.innerHTML = rareHtml;

    // 3. 보유 종류 업데이트
    const kindCount = cardCacheInstance.getOwnedNumbers().length;
    const kindElem = document.getElementById('kind-cards');
    if (kindElem) kindElem.innerText = kindCount;
}



/**
 * 대시보드 통계 섹션 더보기/접기 토글
 */
function toggleStatSection(btn) {
    const parent = btn.parentElement;
    const hiddenItems = parent.querySelectorAll('.stat-item.is-hidden, .stat-item.expanded-show');
    const isExpanding = !btn.classList.contains('active');

    hiddenItems.forEach(item => {
        if (isExpanding) {
            item.classList.remove('is-hidden');
            item.classList.add('expanded-show');
        } else {
            item.classList.add('is-hidden');
            item.classList.remove('expanded-show');
        }
    });

    if (isExpanding) {
        btn.classList.add('active');
        btn.querySelector('span').innerText = '접기';
    } else {
        btn.classList.remove('active');
        btn.querySelector('span').innerText = '더보기';
    }
}

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
    if (!checkAuthBeforeAction()) return;
    const qtyElem = document.getElementById('export-total-qty');
    if (qtyElem) {
        const totalAmount = cardCacheInstance.getAmount() || 0;
        qtyElem.textContent = totalAmount.toLocaleString() + '장';
    }
    const modalElem = document.getElementById('export-modal');
    if (modalElem) M.Modal.getInstance(modalElem).open();
}

/**
 * 보유 인벤토리 데이터를 CSV 파일로 내보내기
 */
function exportInventoryToCSV() {
    const data = cardCacheInstance.getInventory();
    if (!data || data.length === 0) {
        showToast('내보낼 데이터가 없습니다.', 'toast-warn');
        return;
    }

    // CSV 헤더
    const headers = ['카드 이름', '카드 번호', '레어도', '수량', '보관 위치', '일러스트'];

    // 데이터 행 변환
    const csvRows = data.map(row => {
        const rarity = typeof getLocalizedRarity === 'function' ? getLocalizedRarity(row[2]) : row[2];
        const illust = row[5] || '기본';

        const formattedRow = [
            row[0], // 이름
            row[1], // 번호
            rarity, // 레어도
            row[3], // 수량
            row[4], // 위치
            illust  // 일러스트
        ];

        return formattedRow.map(field => {
            const str = String(field).replace(/"/g, '""');
            return `"${str}"`;
        }).join(',');
    });

    const csvContent = '\uFEFF' + headers.join(',') + '\n' + csvRows.join('\n');

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
    a.style.display = 'none';

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

let addSubMode = 'general'; // 등록 탭 내부 서브 모드 상태 (general, pack, deck)
let isRenameMode = false; // 보관 위치 이름 변경 모드 상태
let isDeleteLocationMode = false; // 보관 위치 삭제 모드 상태
let isDeleteLocationConfirmPending = false; // 보관 위치 삭제 복구 불가 확인 대기 상태

function switchAddSubMode(subMode) {
    if (addSubMode === subMode) return;
    addSubMode = subMode;
    switchToMode('add', true, subMode);
}

function handleManageUI(mode) {
    const radioEl = document.getElementById('tab-mode-' + mode);
    if (radioEl) radioEl.checked = true;

    const forms = [
        document.getElementById('general-mode-wrapper'),
        document.getElementById('form-pack-add'),
        document.getElementById('form-deck-add'),
        document.getElementById('manage-move-wrapper'),
        document.getElementById('manage-discard-wrapper')
    ];

    let targetId = '';
    const autoLocInfo = document.getElementById('manage-auto-loc-container');

    if (mode === 'add') {
        if (autoLocInfo) {
            autoLocInfo.classList.remove('anim-hidden');
            autoLocInfo.classList.add('anim-active');
        }
        if (addSubMode === 'general') targetId = 'general-mode-wrapper';
        else if (addSubMode === 'pack') targetId = 'form-pack-add';
        else if (addSubMode === 'deck') targetId = 'form-deck-add';
    } else if (mode === 'move') {
        if (autoLocInfo) {
            autoLocInfo.classList.remove('anim-active');
            autoLocInfo.classList.add('anim-hidden');
        }
        targetId = 'manage-move-wrapper';
    } else if (mode === 'discard') {
        if (autoLocInfo) {
            autoLocInfo.classList.remove('anim-active');
            autoLocInfo.classList.add('anim-hidden');
        }
        targetId = 'manage-discard-wrapper';
    }

    // 크로스페이드 처리 (CSS transition: height에 맡김)
    forms.forEach(f => {
        if (!f) return;
        if (f.id === targetId) {
            f.classList.remove('anim-hidden');
            f.classList.add('anim-active');
        } else {
            f.classList.remove('anim-active');
            f.classList.add('anim-hidden');
        }
    });

    // 탭 전환 시 표 상태 보존 및 하단 컨테이너 연동
    const tableContainer = document.getElementById('manage-table-container');
    const packArea = document.getElementById('pack-table-area');
    const deckArea = document.getElementById('deck-table-area');

    if (tableContainer) {
        if (packArea) packArea.style.display = 'none';
        if (deckArea) deckArea.style.display = 'none';

        if (mode === 'add') {
            if (addSubMode === 'pack' && typeof PackDeckStore.isPackTableGenerated !== 'undefined' && PackDeckStore.isPackTableGenerated) {
                if (packArea) packArea.style.display = '';
                tableContainer.classList.remove('anim-hidden');
                tableContainer.classList.add('anim-active');
            } else if (addSubMode === 'deck' && typeof PackDeckStore.isDeckTableGenerated !== 'undefined' && PackDeckStore.isDeckTableGenerated) {
                if (deckArea) deckArea.style.display = '';
                tableContainer.classList.remove('anim-hidden');
                tableContainer.classList.add('anim-active');
            } else {
                tableContainer.classList.remove('anim-active');
                tableContainer.classList.add('anim-hidden');
            }
        } else {
            tableContainer.classList.remove('anim-active');
            tableContainer.classList.add('anim-hidden');
        }
    }

    // [통합] 공통 하단 푸터 업데이트
    updateManageFooter(mode);

    if (typeof resizeGrid === 'function') resizeGrid();

    // 관리 페이지 진입 및 탭 전환 시 신버전 카드 렌더링 및 올바른 모드로 바인딩
    if (document.documentElement.classList.contains('is-mobile-device')) {
        if (typeof renderMobileCards === 'function') renderMobileCards();
    } else {
        if (typeof renderDesktopCards === 'function') renderDesktopCards();
    }
}



function updateManageFooter(mode, subModeOverride) {
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

    const currentSubMode = subModeOverride || addSubMode;

    // 1. 좌측 버튼 설정 정의 (버튼 2개 기준)
    let leftButtons = [];
    if (mode === 'add') {
        if (currentSubMode === 'general') {
            leftButtons = [
                { text: '팩 추가', onclick: "switchAddSubMode('pack')" },
                { text: '덱 불러오기', onclick: "switchAddSubMode('deck')" }
            ];
        } else if (currentSubMode === 'pack') {
            leftButtons = [
                { text: '일반', onclick: "switchAddSubMode('general')" },
                { text: '덱 불러오기', onclick: "switchAddSubMode('deck')" }
            ];
        } else if (currentSubMode === 'deck') {
            leftButtons = [
                { text: '일반', onclick: "switchAddSubMode('general')" },
                { text: '팩 추가', onclick: "switchAddSubMode('pack')" }
            ];
        }
    } else if (mode === 'move') {
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
            btnWrapper.style.display = 'flex';
            btnWrapper.style.gap = '8px';
            btnWrapper.style.width = '160px'; // 고정폭 설정하여 레이아웃 시프트 전파 방지 (160px로 조정)
            btnWrapper.style.flexShrink = '0';
            // leftEl의 맨 앞에 삽입
            leftEl.insertBefore(btnWrapper, leftEl.firstChild);
        }

        let currentBtns = btnWrapper.querySelectorAll('.btn-manage-action');

        // 버튼이 없으면 초기 생성
        if (currentBtns.length === 0) {
            btnWrapper.innerHTML = `
                <button class="btn-manage-action waves-effect"><span class="btn-text-content"></span></button>
                <button class="btn-manage-action waves-effect"><span class="btn-text-content"></span></button>
            `;
            currentBtns = btnWrapper.querySelectorAll('.btn-manage-action');
        }

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

                    // 버튼 너비 유연 전환을 위한 사전 계산
                    const measureSpan = document.createElement('span');
                    measureSpan.style.visibility = 'hidden';
                    measureSpan.style.position = 'absolute';
                    measureSpan.style.whiteSpace = 'nowrap';
                    measureSpan.style.fontSize = getComputedStyle(btn).fontSize;
                    measureSpan.style.fontWeight = getComputedStyle(btn).fontWeight;
                    measureSpan.innerText = newText;
                    document.body.appendChild(measureSpan);

                    const newWidth = measureSpan.offsetWidth;
                    document.body.removeChild(measureSpan);

                    // 패딩(28px = 14*2)을 고려한 최종 너비 설정
                    btn.style.width = (newWidth + 28) + 'px';

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
                    const measureSpan = document.createElement('span');
                    measureSpan.innerText = newText;
                    measureSpan.style.visibility = 'hidden';
                    measureSpan.style.position = 'absolute';
                    measureSpan.style.whiteSpace = 'nowrap';
                    measureSpan.style.fontSize = getComputedStyle(btn).fontSize;
                    measureSpan.style.fontWeight = getComputedStyle(btn).fontWeight;
                    document.body.appendChild(measureSpan);
                    const initialWidth = measureSpan.offsetWidth;
                    document.body.removeChild(measureSpan);
                    btn.style.width = (initialWidth + 28) + 'px';
                }

                btn.setAttribute('onclick', btnInfo.onclick);

                // 특정 타입에 따른 스타일 클래스 보정 (classList 사용하여 Transition 유지)
                if (btnInfo.type === 'primary') {
                    btn.classList.add('btn', 'cyan-theme', 'waves-light');
                    btn.classList.remove('btn-flat', 'red-theme');
                    btn.style.color = 'white';
                    btn.style.border = '';
                    btn.style.background = '';
                } else if (btnInfo.type === 'danger') {
                    btn.classList.add('btn', 'red-theme', 'waves-light');
                    btn.classList.remove('cyan-theme', 'btn-flat');
                    btn.style.color = 'white';
                    btn.style.border = '';
                    btn.style.background = '';
                } else if (btnInfo.type === 'flat') {
                    btn.classList.add('btn-flat');
                    btn.classList.remove('btn', 'cyan-theme', 'red-theme', 'waves-light');
                    btn.style.color = 'var(--text-primary)';
                    btn.style.border = 'none';
                    btn.style.background = 'transparent';
                } else {
                    // 기본 스타일 복구 (모드 전환 시 클래스 꼬임 방지)
                    btn.classList.remove('btn', 'cyan-theme', 'red-theme', 'waves-light', 'btn-flat');
                    btn.style.color = '';
                    btn.style.border = '';
                    btn.style.background = '';
                }
            }
        });

        // 일괄 이동 모드 또는 제거(위치 삭제) 모드 시 입력란을 좌측 영역 끝에 추가 (캡슐형 스타일)
        if ((mode === 'move' && isRenameMode) || (mode === 'discard' && isDeleteLocationMode)) {
            const inputContainerId = 'rename-inputs-container';
            let inputContainer = document.getElementById(inputContainerId);
            if (!inputContainer) {
                inputContainer = document.createElement('div');
                inputContainer.id = inputContainerId;
                inputContainer.className = 'capsule-input-container anim-active';
                inputContainer.style.display = 'flex';
                inputContainer.style.gap = '8px';
                inputContainer.style.width = 'auto'; // 내용에 맞춰 조절
                inputContainer.style.padding = '0';
                leftEl.appendChild(inputContainer);
            }
            inputContainer.style.marginLeft = ''; // 인라인 마진 완전 제거 (flex gap 8px 의존)

            if (mode === 'move') {
                inputContainer.innerHTML = `
                    <div class="custom-select-wrapper no-arrow rename-capsule-wrap" id="wrap-rename-from" data-type="strict" style="width: 130px; height: 36px;">
                        <input type="text" id="rename-from-input" class="custom-input capsule-input" placeholder="대상 위치" autocomplete="off" style="height: 36px !important; font-size: 0.8rem !important; padding: 0 12px !important;">
                        <i class="material-icons arrow-icon" style="line-height: 36px;">arrow_drop_down</i>
                    </div>
                    <div class="custom-select-wrapper no-arrow rename-capsule-wrap" id="wrap-rename-to" data-type="free" style="width: 130px; height: 36px;">
                        <input type="text" id="rename-to-input" class="custom-input capsule-input" placeholder="이동할 위치" autocomplete="off" disabled style="height: 36px !important; font-size: 0.8rem !important; padding: 0 12px !important;">
                        <i class="material-icons arrow-icon" style="line-height: 36px;">arrow_drop_down</i>
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
                        <div class="custom-select-wrapper no-arrow rename-capsule-wrap" id="wrap-delete-location" data-type="strict" style="width: 130px; height: 36px;">
                            <input type="text" id="delete-location-input" class="custom-input capsule-input" placeholder="삭제할 위치" autocomplete="off" style="height: 36px !important; font-size: 0.8rem !important; padding: 0 12px !important;">
                            <i class="material-icons arrow-icon" style="line-height: 36px;">arrow_drop_down</i>
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
                    const locations = cardCacheInstance.getAllLocations().map(l => ({ val: l, text: l }));
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
            if (currentSubMode === 'general') {
                rightEl.innerHTML = `<button id="manage-primary-btn" class="btn cyan-theme waves-effect waves-light" onclick="submitPageEntries()" tabindex="0">등록</button>`;
            } else if (currentSubMode === 'pack') {
                const isReady = (typeof PackDeckStore.currentPackInfo !== 'undefined' && PackDeckStore.currentPackInfo !== null);
                const genDisabled = PackDeckStore.isPackTableGenerated ? '' : (isReady ? '' : 'disabled');
                const genText = PackDeckStore.isPackTableGenerated ? '목록 제거' : '목록 생성';
                const genTheme = PackDeckStore.isPackTableGenerated ? 'red-theme' : 'cyan-theme';
                rightEl.innerHTML = `
                    <span id="manage-working-name" class="working-info-text"></span>
                    <button id="manage-gen-btn" class="btn ${genTheme} waves-effect waves-light ${genDisabled}" onclick="togglePackTable()">${genText}</button>
                `;
                if (PackDeckStore.isPackTableGenerated && typeof PackDeckStore.currentPackInfo !== 'undefined' && PackDeckStore.currentPackInfo) {
                    const wn = document.getElementById('manage-working-name');
                    if (wn) wn.innerText = PackDeckStore.currentPackInfo.packName || '';
                }
            } else if (currentSubMode === 'deck') {
                const isReady = (typeof PackDeckStore.currentDeckName !== 'undefined' && PackDeckStore.currentDeckName !== null && PackDeckStore.currentDeckName !== '');
                const genDisabled = PackDeckStore.isDeckTableGenerated ? '' : (isReady ? '' : 'disabled');
                const genText = PackDeckStore.isDeckTableGenerated ? '목록 제거' : '목록 생성';
                const genTheme = PackDeckStore.isDeckTableGenerated ? 'red-theme' : 'cyan-theme';
                rightEl.innerHTML = `
                    <span id="manage-working-name" class="working-info-text"></span>
                    <button id="manage-gen-btn" class="btn ${genTheme} waves-effect waves-light ${genDisabled}" onclick="toggleDeckTable()">${genText}</button>
                `;
                if (PackDeckStore.isDeckTableGenerated) {
                    const code = document.getElementById('deck-code-input');
                    const wn = document.getElementById('manage-working-name');
                    if (wn && code) wn.innerText = '덱 코드: ' + code.value;
                }
            }
        } else if (mode === 'move') {
            rightEl.innerHTML = `<button id="manage-primary-btn" class="btn cyan-theme waves-effect waves-light" onclick="submitMoveEntries()" tabindex="0">이동</button>`;
        } else if (mode === 'discard') {
            rightEl.innerHTML = `<button id="manage-primary-btn" class="btn cyan-theme waves-effect waves-light" onclick="submitDiscardEntries()" tabindex="0">제거</button>`;
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
    const illust = data.illustration || '';
    const rarity = data.rarity ? getLocalizedRarity(data.rarity) : '';
    const loc = data.loc || '';
    const to = data.to || '';
    const qty = (data.qty && parseInt(data.qty) > 0) ? parseInt(data.qty) : null;

    const actionsHtml = isDiscard ? `
        <button class="btn-card-action delete" onclick="triggerMobileDelete(${idx})" title="제거"><i class="material-icons">delete</i></button>
    ` : `
        <button class="btn-card-action copy" onclick="triggerMobileCopy(${idx})" title="복제"><i class="material-icons">library_add</i></button>
        <button class="btn-card-action delete" onclick="triggerMobileDelete(${idx})" title="제거"><i class="material-icons">delete</i></button>
    `;

    const bottomBadges = isMove ? `
        <span class="card-info-badge illust">${illust || '미선택'}</span>
        <span class="card-info-badge rarity">${rarity || '미선택'}</span>
        <span class="card-info-badge location">${loc || '보관 위치'}</span>
        <i class="material-icons loc-arrow" style="font-size:0.8rem; color:var(--text-muted); align-self:center; margin:0 -2px;">arrow_forward</i>
        <span class="card-info-badge location to-loc">${to || '이동 위치'}</span>
        <span class="card-info-badge qty">${qty !== null ? qty + '장' : '수량'}</span>
    ` : `
        <span class="card-info-badge illust">${illust || '미선택'}</span>
        <span class="card-info-badge rarity">${rarity || '미선택'}</span>
        <span class="card-info-badge location">${loc || '보관 위치'}</span>
        <span class="card-info-badge qty">${qty !== null ? qty + '장' : '수량'}</span>
    `;

    return `
        <div class="mobile-info-card" data-index="${idx}">
            <div class="card-row-top">
                <span class="card-num-badge">${nextNum}</span>
                <span class="card-num-divider">|</span>
                <span class="card-title-text" onclick="openEditBottomSheet(${idx})">${displayName}</span>
                <span class="card-code-text" onclick="openEditBottomSheet(${idx})">${cardNo || '미입력'}</span>
                <div class="card-actions">
                    <button class="btn-card-action edit" onclick="openEditBottomSheet(${idx})" title="수정"><i class="material-icons">edit</i></button>
                    ${actionsHtml}
                </div>
            </div>
            <div class="card-row-bottom" onclick="openEditBottomSheet(${idx})">
                ${bottomBadges}
            </div>

            <div class="mobile-card-fields" style="display: none;">
                <!-- 카드 이름 -->
                <div class="sheet-form-field">
                    <label>카드 이름</label>
                    <div class="custom-select-wrapper sheet-input-box no-arrow" style="position:relative;" onclick="openSheetOverlay('name')">
                        <input type="text" class="custom-input ${nameClass}" data-field="name" value="${data.name || ''}" placeholder="카드 이름 입력" oninput="handleCardNameInput(this)" onblur="fetchCardByName(this)" onkeydown="if(event.isComposing && (event.key==='Enter' || event.key==='Tab')) { event.preventDefault(); return; } if(this.hasAttribute('readonly') && (event.key==='Escape' || event.key==='Backspace' || event.key==='Delete')) { clearPageNameAndNo(this); event.preventDefault(); return; } if(event.key==='Enter') { this.blur(); }" autocomplete="off" readonly>
                        <i class="material-icons clear-name-btn clear-btn" onclick="clearBottomSheetField('name', event)" style="display:none; position:absolute; right:12px; top:50%; transform:translateY(-50%); cursor:pointer; font-size:1.25rem; color:var(--text-muted);">cancel</i>
                    </div>
                </div>
                <!-- 카드 번호 -->
                <div class="sheet-form-field">
                    <label>카드 번호</label>
                    <div class="custom-select-wrapper sheet-input-box no-arrow" style="position:relative;" onclick="openSheetOverlay('no')">
                        <input type="text" class="custom-input ${noClass}" data-field="no" value="${cardNo}" placeholder="카드 번호 입력" oninput="handleCardNoInput(this)" onblur="fetchCardByNumber(this)" onkeydown="if(event.key==='Enter' && !this.closest('.custom-select-wrapper').classList.contains('active')) fetchCardByNumber(this)" autocomplete="off" readonly>
                        <i class="material-icons arrow-icon" style="font-size:1.4rem; right:12px; line-height:44px; display:none;">arrow_drop_down</i>
                        <i class="material-icons clear-btn" onclick="clearBottomSheetField('no', event)" style="display:none; position:absolute; right:12px; top:50%; transform:translateY(-50%); cursor:pointer; font-size:1.25rem; color:var(--text-muted);">cancel</i>
                    </div>
                </div>
                <!-- 일러스트 & 레어도 -->
                <div class="sheet-form-row">
                    <div class="sheet-form-field half">
                        <label>일러스트</label>
                        <div class="custom-select-wrapper sheet-input-box no-option" data-field-wrap="illust" data-type="strict" style="position:relative;" onclick="openSheetDropdownOverlay('illust')">
                            <input type="text" class="custom-input ${illustClass}" data-field="illust" value="${illust}" placeholder="일러스트" readonly>
                            <i class="material-icons arrow-icon" style="font-size:1.4rem; right:12px; line-height:44px;">arrow_drop_down</i>
                        </div>
                    </div>
                    <div class="sheet-form-field half">
                        <label>레어도</label>
                        <div class="custom-select-wrapper sheet-input-box no-option" data-field-wrap="rare" data-type="strict" style="position:relative;" onclick="openSheetDropdownOverlay('rare')">
                            <input type="text" class="custom-input ${rareClass}" data-field="rare" value="${data.rarity || ''}" placeholder="레어도" readonly>
                            <i class="material-icons arrow-icon" style="font-size:1.4rem; right:12px; line-height:44px;">arrow_drop_down</i>
                        </div>
                    </div>
                </div>
                <!-- 보관 위치 & 이동 위치 & 수량 -->
                <div class="sheet-form-row">
                    <div class="sheet-form-field" style="flex: 1;">
                        <label>보관 위치</label>
                        <div class="custom-select-wrapper sheet-input-box no-option" data-field-wrap="loc" data-type="${isMove || isDiscard ? 'strict' : 'free'}" style="position:relative;" onclick="openSheetOverlay('loc')">
                            <input type="text" class="custom-input ${locClass}" data-field="loc" value="${loc}" placeholder="보관 위치" readonly>
                            <i class="material-icons arrow-icon" style="font-size:1.4rem; right:12px; line-height:44px;">arrow_drop_down</i>
                        </div>
                    </div>
                    <div class="sheet-form-field" style="flex: 1; display: ${isMove ? 'block' : 'none'};">
                        <label>이동 위치</label>
                        <div class="custom-select-wrapper sheet-input-box" data-field-wrap="to" data-type="free" style="position:relative;" onclick="openSheetOverlay('to')">
                            <input type="text" class="custom-input move-card-to" data-field="to" value="${to}" placeholder="이동 위치" readonly>
                            <i class="material-icons arrow-icon" style="font-size:1.4rem; right:12px; line-height:44px;">arrow_drop_down</i>
                        </div>
                    </div>
                    <div class="sheet-form-field" style="flex: 1;">
                        <label>수량</label>
                        <div class="custom-select-wrapper sheet-input-box no-arrow" data-field-wrap="qty" style="position:relative;" onclick="openSheetOverlay('qty')">
                            <input type="number" class="custom-input ${qtyClass} qty-input" data-field="qty" value="${qty !== null ? qty : ''}" placeholder="수량" min="1" readonly style="flex:1; border:none !important; background:transparent !important; outline:none !important; font-size:0.9rem; text-align:left;" oninput="handleCardQtyInput(this)">
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
    const illust = illustInp ? illustInp.value.trim() : '';
    const rarity = rareInp ? getLocalizedRarity(rareInp.dataset.raw || rareInp.value) : '';
    const loc = locInp ? locInp.value.trim() : '';
    const to = toInp ? toInp.value.trim() : '';
    const qty = qtyInp ? (parseInt(qtyInp.value) > 0 ? parseInt(qtyInp.value) : null) : null;

    const titleEl = cardEl.querySelector('.card-title-text');
    if (titleEl) titleEl.innerText = displayName;

    const codeEl = cardEl.querySelector('.card-code-text');
    if (codeEl) codeEl.innerText = cardNo || '미입력';

    const badgeIllust = cardEl.querySelector('.card-info-badge.illust');
    if (badgeIllust) badgeIllust.innerText = illust || '미선택';

    const badgeRarity = cardEl.querySelector('.card-info-badge.rarity');
    if (badgeRarity) badgeRarity.innerText = rarity || '미선택';

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

function renderMobileCardsFromData(dataArray) {
    let listContainerId = 'mobile-cards-list-general';
    if (UIStore.mode === 'add') {
        if (addSubMode === 'pack') listContainerId = 'mobile-cards-list-pack';
        else if (addSubMode === 'deck') listContainerId = 'mobile-cards-list-deck';
    } else if (UIStore.mode === 'move') {
        listContainerId = 'mobile-cards-list-move';
    } else if (UIStore.mode === 'discard') {
        listContainerId = 'mobile-cards-list-discard';
    }

    const listContainer = document.getElementById(listContainerId);
    if (!listContainer) return;
    if (currentEditingRowIndex !== -1) return;

    listContainer.innerHTML = '';
    const wrapper = listContainer.closest('.mobile-cards-wrapper');

    if (dataArray.length === 0) {
        if (wrapper) wrapper.style.display = 'none';
        return;
    }

    if (wrapper) {
        listContainer.style.display = 'block';
        wrapper.style.display = 'block';
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
        }
    });
}

function renderMobileCards() {
    const isMobile = document.documentElement.classList.contains('is-mobile-device');
    if (!isMobile) return;
    
    let listContainerId = 'mobile-cards-list-general';
    if (UIStore.mode === 'add') {
        if (addSubMode === 'pack') listContainerId = 'mobile-cards-list-pack';
        else if (addSubMode === 'deck') listContainerId = 'mobile-cards-list-deck';
    } else if (UIStore.mode === 'move') {
        listContainerId = 'mobile-cards-list-move';
    } else if (UIStore.mode === 'discard') {
        listContainerId = 'mobile-cards-list-discard';
    }
    const listContainer = document.getElementById(listContainerId);
    if (!listContainer) return;
    
    const cards = listContainer.querySelectorAll('.mobile-info-card');
    const collectedData = [];
    cards.forEach(c => {
        collectedData.push(getDesktopCardData(c));
    });
    
    renderMobileCardsFromData(collectedData);
}

function mobileAddEntry(mode, subMode, initialData = null) {
    let listContainerId = 'mobile-cards-list-general';
    if (mode === 'add') {
        if (subMode === 'pack') listContainerId = 'mobile-cards-list-pack';
        else if (subMode === 'deck') listContainerId = 'mobile-cards-list-deck';
    } else if (mode === 'move') {
        listContainerId = 'mobile-cards-list-move';
    } else if (mode === 'discard') {
        listContainerId = 'mobile-cards-list-discard';
    }

    const listContainer = document.getElementById(listContainerId);
    if (!listContainer) return null;

    const currentCount = listContainer.querySelectorAll('.mobile-info-card').length;
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
    return cardEl;
}

function reindexMobileCards(listContainer) {
    if (!listContainer) return;
    const cards = listContainer.querySelectorAll('.mobile-info-card');
    cards.forEach((card, idx) => {
        card.dataset.index = idx;
        const badge = card.querySelector('.card-num-badge');
        if (badge) badge.innerText = idx + 1;
        
        const editBtn = card.querySelector('.btn-card-action.edit');
        if (editBtn) editBtn.setAttribute('onclick', `openEditBottomSheet(${idx})`);
        
        const copyBtn = card.querySelector('.btn-card-action.copy');
        if (copyBtn) copyBtn.setAttribute('onclick', `triggerMobileCopy(${idx})`);

        const deleteBtn = card.querySelector('.btn-card-action.delete');
        if (deleteBtn) {
            if (UIStore.mode === 'move') deleteBtn.setAttribute('onclick', `triggerMobileMoveDelete(${idx})`);
            else if (UIStore.mode === 'discard') deleteBtn.setAttribute('onclick', `triggerMobileDiscardDelete(${idx})`);
            else deleteBtn.setAttribute('onclick', `triggerMobileDelete(${idx})`);
        }
        
        const titleText = card.querySelector('.card-title-text');
        if (titleText) titleText.setAttribute('onclick', `openEditBottomSheet(${idx})`);

        const codeText = card.querySelector('.card-code-text');
        if (codeText) codeText.setAttribute('onclick', `openEditBottomSheet(${idx})`);

        const rowBot = card.querySelector('.card-row-bottom');
        if (rowBot) rowBot.setAttribute('onclick', `openEditBottomSheet(${idx})`);
    });
}

function handleMobileAddCardClick() {
    let listContainerId = 'mobile-cards-list-general';
    if (addSubMode === 'pack') listContainerId = 'mobile-cards-list-pack';
    else if (addSubMode === 'deck') listContainerId = 'mobile-cards-list-deck';
    const listContainer = document.getElementById(listContainerId);

    mobileAddEntry(UIStore.mode, addSubMode);
    if (listContainer) {
        reindexMobileCards(listContainer);
        const cards = listContainer.querySelectorAll('.mobile-info-card');
        if (cards.length > 0) {
            openEditBottomSheet(cards.length - 1);
        }
    }
}

function handleMobileAddMoveCardClick() {
    const listContainer = document.getElementById('mobile-cards-list-move');
    mobileAddEntry('move', null);
    if (listContainer) {
        reindexMobileCards(listContainer);
        const cards = listContainer.querySelectorAll('.mobile-info-card');
        if (cards.length > 0) {
            openEditBottomSheet(cards.length - 1);
        }
    }
}

function handleMobileAddDiscardCardClick() {
    const listContainer = document.getElementById('mobile-cards-list-discard');
    mobileAddEntry('discard', null);
    if (listContainer) {
        reindexMobileCards(listContainer);
        const cards = listContainer.querySelectorAll('.mobile-info-card');
        if (cards.length > 0) {
            openEditBottomSheet(cards.length - 1);
        }
    }
}

function triggerMobileCopy(idx) {
    let listContainerId = 'mobile-cards-list-general';
    if (UIStore.mode === 'add') {
        if (addSubMode === 'pack') listContainerId = 'mobile-cards-list-pack';
        else if (addSubMode === 'deck') listContainerId = 'mobile-cards-list-deck';
    } else if (UIStore.mode === 'move') {
        listContainerId = 'mobile-cards-list-move';
    } else if (UIStore.mode === 'discard') {
        listContainerId = 'mobile-cards-list-discard';
    }

    const listContainer = document.getElementById(listContainerId);
    if (!listContainer) return;
    const cards = listContainer.querySelectorAll('.mobile-info-card');
    const card = cards[idx];
    if (!card) return;

    const data = getDesktopCardData(card);
    mobileAddEntry(UIStore.mode, addSubMode, data);
    reindexMobileCards(listContainer);
}

function triggerMobileDelete(idx) {
    let listContainerId = 'mobile-cards-list-general';
    if (UIStore.mode === 'add') {
        if (addSubMode === 'pack') listContainerId = 'mobile-cards-list-pack';
        else if (addSubMode === 'deck') listContainerId = 'mobile-cards-list-deck';
    }
    const listContainer = document.getElementById(listContainerId);
    if (!listContainer) return;
    const cards = listContainer.querySelectorAll('.mobile-info-card');
    if (cards[idx]) {
        cards[idx].remove();
        reindexMobileCards(listContainer);
    }
}

function triggerMobileMoveDelete(idx) {
    const listContainer = document.getElementById('mobile-cards-list-move');
    if (!listContainer) return;
    const cards = listContainer.querySelectorAll('.mobile-info-card');
    if (cards[idx]) {
        cards[idx].remove();
        reindexMobileCards(listContainer);
    }
}

function triggerMobileDiscardDelete(idx) {
    const listContainer = document.getElementById('mobile-cards-list-discard');
    if (!listContainer) return;
    const cards = listContainer.querySelectorAll('.mobile-info-card');
    if (cards[idx]) {
        cards[idx].remove();
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

async function submitDeleteLocation() {
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

    const locations = cardCacheInstance.getAllLocations();
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
    if (!isDeleteLocationConfirmPending) {
        isDeleteLocationConfirmPending = true;
        updateManageFooter('discard');
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
                renderHomeDash();
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

function openMobileSearch() {
    const overlay = document.getElementById('mobile-search-overlay');
    const input = document.getElementById('mobile-card-search');
    if (!overlay || !input) return;

    // 히스토리 추가하여 뒤로가기로 닫을 수 있게 처리
    const currentState = history.state || {};
    if (!currentState.mobileSearchOpen) {
        history.pushState({ mobileSearchOpen: true }, '');
    }

    overlay.style.display = 'flex';
    // 애니메이션 프레임 보장
    requestAnimationFrame(() => {
        overlay.classList.add('active');
    });

    // 입력값 초기화 및 포커스
    input.value = '';
    const clearBtn = document.getElementById('mobile-search-clear-btn');
    if(clearBtn) clearBtn.style.display = 'none';
    
    // 최근 검색어 먼저 표시
    showMobileRecentInDropdown();
    
    // 하단 탭바 하이라이트 변경
    document.querySelectorAll('.mobile-nav-item').forEach(el => el.classList.remove('active'));
    const searchNavItem = document.querySelector('.mobile-nav-item[data-mode="search"]');
    if (searchNavItem) searchNavItem.classList.add('active');
    
    input.focus();
}

function closeMobileSearch(fromPopState = false) {
    const overlay = document.getElementById('mobile-search-overlay');
    const input = document.getElementById('mobile-card-search');
    if (!overlay) return;

    overlay.classList.remove('active');
    
    // 하단 탭바 원래 모드에 맞게 복원
    if (typeof updateActiveNav === 'function' && typeof UIStore.mode !== 'undefined') {
        updateActiveNav(UIStore.mode);
    }
    
    setTimeout(() => {
        overlay.style.display = 'none';
        if (input) input.value = '';
        const dropdown = document.getElementById('mobile-custom-dropdown');
        if (dropdown) dropdown.classList.remove('active');
    }, 400); // CSS transition 시간 (0.4s)

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

    const li = document.createElement('li');
    li.className = 'mobile-recent-container';
    
    const chipsWrapper = document.createElement('div');
    chipsWrapper.className = 'recent-chips-wrapper';

    recent.slice(0, 10).forEach(r => {
        const keyword = typeof r === 'string' ? r : r.keyword;
        const searchType = typeof r === 'string' ? 'auto' : (r.searchType || 'auto');
        const isTarget = typeof r === 'string' ? false : !!r.isTarget;

        const chip = document.createElement('span');
        chip.className = 'recent-chip';

        let tagStr = '';
        if (isTarget) {
            if (searchType === 'number') tagStr = '[번호] ';
            else tagStr = '[이름] ';
        }

        chip.innerText = tagStr + keyword;
        chip.addEventListener('click', (e) => {
            e.stopPropagation();
            executeMobileSearch(keyword, searchType, isTarget);
        });
        chipsWrapper.appendChild(chip);
    });
    li.appendChild(chipsWrapper);

    const deleteIcon = document.createElement('i');
    deleteIcon.className = 'material-icons clear-all-icon';
    deleteIcon.innerText = 'delete';
    deleteIcon.onclick = clearMobileAllRecent;
    li.appendChild(deleteIcon);

    list.appendChild(li);
}

// 모바일 전용 최근 검색어 표시
function showMobileRecentInDropdown() {
    const recent = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    const list = document.getElementById('mobile-custom-dropdown');
    if (!list) return;

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
        await startSearch(true, searchType, forcedIsTarget);
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
    
    closeMobileSearch();
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
            mobileFilterAndShowDropdown(val);
        }, 50);

        mSearchInput.addEventListener('input', (e) => {
            const val = e.target.value.trim();
            if (val) {
                if (mClearBtn) mClearBtn.style.display = 'block';
                debouncedMobileFilter(val);
            } else {
                debouncedMobileFilter.cancel && debouncedMobileFilter.cancel();
                if (mClearBtn) mClearBtn.style.display = 'none';
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
                    executeMobileSearch(targetVal, 'name');
                }
            }
        });
    }

    if (mSearchBtn && mSearchInput) {
        mSearchBtn.addEventListener('click', (e) => {
            e.preventDefault();
            const val = mSearchInput.value.trim();
            if (val) {
                executeMobileSearch(val, 'name');
            }
        });
    }

    if (mClearBtn) {
        mClearBtn.addEventListener('click', (e) => {
            e.preventDefault();
            mSearchInput.value = '';
            mClearBtn.style.display = 'none';
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

let currentEditingRowIndex = -1; // 현재 바텀 시트에서 편집 중인 테이블 행 인덱스 (0-based)
let activeOverlayType = '';       // 현재 활성화된 오버레이 종류 ('name', 'no', 'loc', 'qty')
let qtyPickerSelectedVal = 1;     // 수량 조절 오버레이 내 선택된 임시 값



function getActiveMobileListContainer() {
    let listContainerId = 'mobile-cards-list-general';
    if (UIStore.mode === 'add') {
        if (addSubMode === 'pack') listContainerId = 'mobile-cards-list-pack';
        else if (addSubMode === 'deck') listContainerId = 'mobile-cards-list-deck';
    } else if (UIStore.mode === 'move') {
        listContainerId = 'mobile-cards-list-move';
    } else if (UIStore.mode === 'discard') {
        listContainerId = 'mobile-cards-list-discard';
    }
    return document.getElementById(listContainerId);
}

function openEditBottomSheet(idx) {
    const listContainer = getActiveMobileListContainer();
    if (!listContainer) return;

    const cards = listContainer.querySelectorAll('.mobile-info-card');
    const row = cards[idx];
    if (!row) return;

    const sheetContainer = document.getElementById('sheet-fields-container');
    if (!sheetContainer) return;

    // 1. 이미 다른 카드를 편집 중이었다면, 해당 필드 뭉치를 원래 카드로 복구
    if (currentEditingRowIndex !== -1 && currentEditingRowIndex !== idx) {
        const prevCard = cards[currentEditingRowIndex];
        const activeFields = sheetContainer.querySelector('.mobile-card-fields');
        if (prevCard && activeFields) {
            // ID 속성들 제거하여 원래 카드 내부의 DOM 격리
            const inputs = activeFields.querySelectorAll('input[id^="sheet-card-"]');
            inputs.forEach(inp => inp.removeAttribute('id'));
            const wraps = activeFields.querySelectorAll('div[id^="wrap-sheet-"]');
            wraps.forEach(w => w.removeAttribute('id'));

            prevCard.appendChild(activeFields);
            activeFields.style.display = 'none';
            updateMobileCardDisplay(prevCard);
        }
    }

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
        fields.style.display = 'block';

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

    // 5. 바텀 시트 노출 애니메이션
    const overlay = document.getElementById('bottom-sheet-overlay');
    const sheet = document.getElementById('mobile-entry-bottom-sheet');
    overlay.style.display = 'block';
    sheet.style.display = 'flex';
    document.documentElement.classList.add('nav-hidden');
    requestAnimationFrame(() => {
        overlay.classList.add('active');
        sheet.classList.add('active');
    });
}

function closeEntryBottomSheet() {
    const listContainer = getActiveMobileListContainer();
    const sheetContainer = document.getElementById('sheet-fields-container');
    const overlay = document.getElementById('bottom-sheet-overlay');
    const sheet = document.getElementById('mobile-entry-bottom-sheet');

    document.documentElement.classList.remove('nav-hidden');

    if (listContainer && sheetContainer && currentEditingRowIndex !== -1) {
        const cards = listContainer.querySelectorAll('.mobile-info-card');
        const row = cards[currentEditingRowIndex];
        const fields = sheetContainer.querySelector('.mobile-card-fields');
        if (row && fields) {
            // [동적 readonly 토글] 모바일 카드로 반환될 때는 모든 인풋들을 readonly 상태로 재잠금
            const allInputs = fields.querySelectorAll('input');
            allInputs.forEach(inp => {
                inp.setAttribute('readonly', 'true');
                // 바텀시트 닫기 시 잔류 dataset 초기화 (lockedForName 잔류 시 재오픈 후 번호 조회 차단 버그 방지)
                delete inp.dataset.lockedForName;
                delete inp.dataset.errorRetry;
                delete inp.dataset.prevCardNo;
            });

            // row의 searchMode만 초기화 (닫지 않으면 이름/번호 모드가 고정되는 버그 방지)
            // 주의: row.dataset.cardData는 재오픈 시 드롭다운 복원에 필요하므로 삭제하지 않음
            delete row.dataset.searchMode;

            // ID 속성들 제거하여 DOM 격리 유지
            const inputs = fields.querySelectorAll('input[id^="sheet-card-"]');
            inputs.forEach(inp => inp.removeAttribute('id'));
            const wraps = fields.querySelectorAll('div[id^="wrap-sheet-"]');
            wraps.forEach(w => w.removeAttribute('id'));

            // 가상 입력란을 원래 모바일 카드로 복원
            row.appendChild(fields);
            fields.style.display = 'none';
            // 카드 표기값 리액티브 업데이트
            updateMobileCardDisplay(row);
        }
    }

    currentEditingRowIndex = -1;

    // 바텀시트 자체(container 역할)의 searchMode 초기화
    if (sheet) delete sheet.dataset.searchMode;

    if (overlay && sheet) {
        overlay.classList.remove('active');
        sheet.classList.remove('active');
        setTimeout(() => {
            overlay.style.display = 'none';
            sheet.style.display = 'none';
        }, 350);
    }
}



function navigateSheetCard(direction) {
    const listContainer = getActiveMobileListContainer();
    if (!listContainer) return;

    const cards = listContainer.querySelectorAll('.mobile-info-card');
    const row = cards[currentEditingRowIndex];
    if (row) {
        delete row.dataset.searchMode;
        // 주의: row.dataset.cardData는 재오픈 시 드롭다운 복원에 필요하므로 삭제하지 않음
        const fields = row.querySelector('.mobile-card-fields');
        if (fields) {
            const allInputs = fields.querySelectorAll('input');
            allInputs.forEach(inp => {
                delete inp.dataset.lockedForName;
                delete inp.dataset.errorRetry;
                delete inp.dataset.prevCardNo;
            });
        }
    }
    const sheet = document.getElementById('mobile-entry-bottom-sheet');
    if (sheet) {
        delete sheet.dataset.searchMode;
    }

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
            mobileAddEntry(UIStore.mode, addSubMode);
            reindexMobileCards(listContainer);
            setTimeout(() => {
                const updatedCards = listContainer.querySelectorAll('.mobile-info-card');
                openEditBottomSheet(updatedCards.length - 1);
            }, 50);
        }
    }
}

// 7. 입력 오버레이 제어
function openSheetOverlay(type) {
    if (type === 'no') {
        const sheetNo = document.getElementById('sheet-card-no');
        if (sheetNo && sheetNo.dataset.lockedForName === 'true') {
            return;
        }
    }

    activeOverlayType = type;
    const overlay = document.getElementById('mobile-sheet-input-overlay');
    const input = document.getElementById('overlay-search-input');
    const clearBtn = document.getElementById('overlay-clear-btn');
    const list = document.getElementById('overlay-suggestions-list');

    if (!overlay || !input || !list) return;

    input.value = '';
    clearBtn.style.display = 'none';
    list.innerHTML = '';

    // 바텀 시트 데이터 맵핑
    const currentVal = document.getElementById('sheet-card-' + type) ? document.getElementById('sheet-card-' + type).value.trim() : '';

    if (type === 'name') {
        input.placeholder = '카드 이름 입력';
        input.type = 'text';
        input.value = currentVal;
        if (currentVal) clearBtn.style.display = 'block';
        showOverlaySuggestions(currentVal);
    } else if (type === 'no') {
        input.placeholder = '카드 번호 입력';
        input.type = 'text';
        input.value = currentVal;
        if (currentVal) clearBtn.style.display = 'block';
        showOverlaySuggestions(currentVal);
    } else if (type === 'loc') {
        input.placeholder = '보관 위치 입력';
        input.type = 'text';
        input.value = currentVal;
        if (currentVal) clearBtn.style.display = 'block';
        showOverlaySuggestions(''); // 보관 위치는 비어있어도 기존 목록 노출
    } else if (type === 'to') {
        input.placeholder = '이동 위치 입력';
        input.type = 'text';
        input.value = currentVal;
        if (currentVal) clearBtn.style.display = 'block';
        showOverlaySuggestions(''); // 이동 위치도 비어있어도 기존 목록 노출
    } else if (type === 'qty') {
        // 수량은 전용 수량 오버레이 활성화
        openQtyOverlay(currentVal);
        return;
    }

    overlay.style.display = 'flex';
    requestAnimationFrame(() => {
        overlay.classList.add('active');
        input.focus();
    });
}

function closeSheetOverlay() {
    const overlay = document.getElementById('mobile-sheet-input-overlay');
    if (overlay) {
        overlay.classList.remove('active');
        setTimeout(() => {
            overlay.style.display = 'none';
        }, 300);
    }
}

function clearOverlayInput() {
    const input = document.getElementById('overlay-search-input');
    const clearBtn = document.getElementById('overlay-clear-btn');
    if (input) {
        input.value = '';
        input.focus();
        if (clearBtn) clearBtn.style.display = 'none';
        showOverlaySuggestions('');
    }
}

// 8. 오버레이 자동완성 / 목록 추천
function showOverlaySuggestions(query) {
    const list = document.getElementById('overlay-suggestions-list');
    if (!list) return;
    list.innerHTML = '';

    const normalizedQuery = query.trim().toLowerCase().replace(/\s+/g, '');
    const isMove = (UIStore.mode === 'move');
    const isDiscard = (UIStore.mode === 'discard');

    // 현재 편집 중인 원본 행 구하기
    let editingRow = null;
    if (currentEditingRowIndex !== -1) {
        const isMobile = document.documentElement.classList.contains('is-mobile-device');
        const subMode = (UIStore.mode === 'add') ? (addSubMode || 'general') : UIStore.mode;
        const containerId = isMobile 
            ? `mobile-cards-list-${subMode}` 
            : `desktop-cards-list-${subMode}`;
        const container = document.getElementById(containerId);
        if (container) {
            const cardClass = isMobile ? '.mobile-info-card' : '.desktop-info-card';
            const cards = container.querySelectorAll(cardClass);
            editingRow = cards[currentEditingRowIndex];
        }
    }

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

        matches.forEach(name => {
            const li = document.createElement('li');
            li.innerText = name;
            li.onclick = () => selectOverlayItem(name);
            list.appendChild(li);
        });
    } else if (activeOverlayType === 'no') {
        let source = [];

        // 바텀시트의 번호 필드가 검색 중 상태이면 목록을 비우고 안내 표시
        const sheetNoEl = document.getElementById('sheet-card-no');
        if (sheetNoEl && sheetNoEl.dataset.lockedForName === 'true') {
            const li = document.createElement('li');
            li.className = 'item-no-match';
            li.innerText = '검색 중...';
            list.appendChild(li);
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
                        // 일반/팩/덱 추가 모드에서는 사용자 소장 재고에 기인한 필터링을 생략하고, 발매 번호 풀로 안전하게 폴백
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

        matches.forEach(no => {
            const li = document.createElement('li');
            li.innerText = no;
            li.onclick = () => selectOverlayItem(no);
            list.appendChild(li);
        });
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
                    li.onclick = () => selectOverlayItem(val);
                    list.appendChild(li);
                });
            } else {
                const li = document.createElement('li');
                li.className = 'item-no-match';
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
                li.onclick = () => selectOverlayItem(loc);
                list.appendChild(li);
            });
        }
    }
}

// 오버레이 아이템 선택 핸들러
function selectOverlayItem(value) {
    const listContainer = getActiveMobileListContainer();
    if (!listContainer) return;

    const cards = listContainer.querySelectorAll('.mobile-info-card');
    const row = cards[currentEditingRowIndex];
    if (!row) return;

    const isMove = (UIStore.mode === 'move');
    const isDiscard = (UIStore.mode === 'discard');

    const nameClass = (isMove || isDiscard) ? '.card-name-input' : '.page-card-name';
    const noClass = isMove ? '.move-card-no' : (isDiscard ? '.discard-card-no' : '.page-card-no');
    const locClass = isMove ? '.move-card-from' : (isDiscard ? '.discard-card-loc' : '.page-card-loc');

    if (activeOverlayType === 'name') {
        const sheetName = document.getElementById('sheet-card-name');
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
            fetchCardByName(originalName || sheetName, true);
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
        } else {
            fetchCardByNumber(originalNo || sheetNo, true);
        }
    } else if (activeOverlayType === 'loc') {
        const sheetLoc = document.getElementById('sheet-card-loc');
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
        const cards = listContainer.querySelectorAll('.mobile-info-card');
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

function openQtyOverlay(currentVal) {
    const overlay = document.getElementById('mobile-sheet-qty-overlay');
    const picker = document.getElementById('qty-picker-scroll-area');

    if (!overlay || !picker) return;

    // 카드 정보 바텀시트와 동일한 높이 적용
    const entrySheet = document.getElementById('mobile-entry-bottom-sheet');
    const qtyContent = overlay.querySelector('.qty-overlay-content');
    if (entrySheet && qtyContent) {
        const sheetHeight = entrySheet.offsetHeight;
        if (sheetHeight > 0) {
            qtyContent.style.height = `${sheetHeight}px`;
        }
    }

    let val = parseInt(currentVal) || 1;
    const maxQty = getCurrentMaxQty();
    if (val > maxQty) val = maxQty;
    
    qtyPickerSelectedVal = val;

    // 1 ~ maxQty 스크롤 휠 아이템 렌더링 (숫자 N만 표시)
    picker.innerHTML = '';
    for (let i = 1; i <= maxQty; i++) {
        const item = document.createElement('div');
        item.className = 'qty-picker-item' + (i === val ? ' selected' : '');
        item.innerText = i;
        item.dataset.val = i;
        item.onclick = () => {
            if (item.classList.contains('selected')) {
                startQtyInlineInput(item);
            } else {
                selectQtyFromPicker(i);
            }
        };
        picker.appendChild(item);
    }

    overlay.style.display = 'flex';
    requestAnimationFrame(() => {
        overlay.classList.add('active');
        // 선택된 값 스크롤 위치 이동
        setTimeout(() => {
            const selectedItem = picker.querySelector('.qty-picker-item.selected');
            if (selectedItem) {
                picker.scrollTop = selectedItem.offsetTop - picker.clientHeight / 2 + selectedItem.clientHeight / 2;
            }
        }, 50);
    });
}

function closeQtyOverlay() {
    const overlay = document.getElementById('mobile-sheet-qty-overlay');
    if (overlay) {
        // 값 확정 및 동기화
        let qtyClass = '.page-card-qty';
        if (UIStore.mode === 'move') {
            qtyClass = '.move-card-qty';
        } else if (UIStore.mode === 'discard') {
            qtyClass = '.discard-card-qty';
        }

        const listContainer = getActiveMobileListContainer();
        if (listContainer) {
            const cards = listContainer.querySelectorAll('.mobile-info-card');
            const row = cards[currentEditingRowIndex];

            if (row) {
                const qtyStr = String(qtyPickerSelectedVal);
                document.getElementById('sheet-card-qty').value = qtyStr;
                const originalQty = row.querySelector(qtyClass);
                if (originalQty) {
                    originalQty.value = qtyStr;
                    recalcSiblingRowQtys(row);
                    renderMobileCards();
                }
            }
        }

        overlay.classList.remove('active');
        setTimeout(() => {
            overlay.style.display = 'none';
        }, 300);
    }
}

function selectQtyFromPicker(i) {
    qtyPickerSelectedVal = i;
    const picker = document.getElementById('qty-picker-scroll-area');
    picker.querySelectorAll('.qty-picker-item').forEach(item => {
        if (parseInt(item.dataset.val) === i) {
            item.classList.add('selected');
        } else {
            item.classList.remove('selected');
        }
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
    picker.style.overflowY = 'hidden';

    input.value = selectedItem.dataset.val;
    input.style.display = 'block';
    input.focus();
    input.select();

    // 버튼 토글: 초기화 숨김, 체크 표시
    const resetBtn = document.getElementById('qty-reset-btn');
    const checkBtn = document.getElementById('qty-check-btn');
    if (resetBtn) resetBtn.style.display = 'none';
    if (checkBtn) checkBtn.style.display = 'flex';
}

function finishQtyInlineInput(input) {
    if (!input) return;
    let val = parseInt(input.value);
    const maxQty = getCurrentMaxQty();
    if (isNaN(val) || val < 1) val = 1;
    if (val > maxQty) val = maxQty;

    qtyPickerSelectedVal = val;
    input.style.display = 'none';

    // 스크롤 잠금 해제
    const picker = document.getElementById('qty-picker-scroll-area');
    if (picker) {
        picker.style.overflowY = 'scroll';
    }

    // 최종 선택 값으로 정렬
    selectQtyFromPicker(val);

    // 버튼 토글: 초기화 표시, 체크 숨김
    const resetBtn = document.getElementById('qty-reset-btn');
    const checkBtn = document.getElementById('qty-check-btn');
    if (resetBtn) resetBtn.style.display = 'flex';
    if (checkBtn) checkBtn.style.display = 'none';
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
            if (parseInt(item.dataset.val) === val) {
                item.classList.add('selected');
            } else {
                item.classList.remove('selected');
            }
        });
        const selectedItem = picker.querySelector(`.qty-picker-item[data-val="${val}"]`);
        if (selectedItem) {
            picker.scrollTop = selectedItem.offsetTop - picker.clientHeight / 2 + selectedItem.clientHeight / 2;
        }
    }
}

function handleQtyPickerScroll(picker) {
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
        items.forEach(it => it.classList.remove('selected'));
        closestItem.classList.add('selected');
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
        if (nameClear) nameClear.style.display = nameVal ? 'block' : 'none';
        // 카드 이름은 기본적으로 화살표가 없으므로 제어 불필요
    }

    if (noInput) {
        const noVal = noInput.value.trim();
        const wrapper = noInput.closest('.sheet-input-box');
        const noClear = wrapper ? wrapper.querySelector('.clear-btn') : null;
        const arrow = wrapper ? wrapper.querySelector('.arrow-icon') : null;
        if (noClear) {
            const showClear = !!noVal;
            noClear.style.display = showClear ? 'block' : 'none';
            if (arrow) {
                if (showClear) {
                    arrow.style.display = 'none'; // 지우기 버튼 노출 시 화살표 감춤
                } else {
                    // 지우기 버튼 제거 시 옵션이 존재하는 상황인지 체크하고 복원
                    const hasOptions = wrapper && !wrapper.classList.contains('no-arrow') && !wrapper.classList.contains('no-option');
                    arrow.style.display = hasOptions ? 'block' : 'none';
                }
            }
        }
    }
}

function updateSheetDropdownState() {
    const rareWrap = document.getElementById('wrap-sheet-rare');
    const illustWrap = document.getElementById('wrap-sheet-illust');

    if (rareWrap) {
        try {
            const options = JSON.parse(rareWrap.dataset.options || '[]');
            if (options.length <= 1) {
                rareWrap.style.pointerEvents = 'none';
                rareWrap.style.opacity = '0.6';
                const arrow = rareWrap.querySelector('.arrow-icon');
                if (arrow) arrow.style.display = 'none';
            } else {
                rareWrap.style.pointerEvents = '';
                rareWrap.style.opacity = '';
                const arrow = rareWrap.querySelector('.arrow-icon');
                if (arrow) arrow.style.display = 'block';
            }
        } catch (e) {
            console.error(e);
        }
    }

    if (illustWrap) {
        try {
            const options = JSON.parse(illustWrap.dataset.options || '[]');
            if (options.length <= 1) {
                illustWrap.style.pointerEvents = 'none';
                illustWrap.style.opacity = '0.6';
                const arrow = illustWrap.querySelector('.arrow-icon');
                if (arrow) arrow.style.display = 'none';
            } else {
                illustWrap.style.pointerEvents = '';
                illustWrap.style.opacity = '';
                const arrow = illustWrap.querySelector('.arrow-icon');
                if (arrow) arrow.style.display = 'block';
            }
        } catch (e) {
            console.error(e);
        }
    }
}

function clearBottomSheetField(type, event) {
    if (event) event.stopPropagation();
    if (currentEditingRowIndex === -1) return;

    const listContainer = getActiveMobileListContainer();
    if (!listContainer) return;

    const cards = listContainer.querySelectorAll('.mobile-info-card');
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
                    illustInp.value = "";
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
            if (displayText === currentVal || val === currentVal) {
                li.classList.add('selected');
            }
            li.onclick = () => {
                selectSheetDropdownItem(type, val, raw, displayText);
            };
            optionsList.appendChild(li);
        });

        dropdownOverlay.style.display = 'block';
        dropdownSheet.style.display = 'flex';
        requestAnimationFrame(() => {
            dropdownOverlay.classList.add('active');
            dropdownSheet.classList.add('active');
        });
    } catch (e) {
        console.error(e);
    }
}

function closeSheetDropdownSelect() {
    const dropdownSheet = document.getElementById('mobile-sheet-dropdown-select');
    const dropdownOverlay = document.getElementById('sheet-dropdown-overlay');
    if (dropdownSheet && dropdownOverlay) {
        dropdownOverlay.classList.remove('active');
        dropdownSheet.classList.remove('active');
        setTimeout(() => {
            dropdownOverlay.style.display = 'none';
            dropdownSheet.style.display = 'none';
        }, 350);
    }
}

function selectSheetDropdownItem(type, val, raw, text) {
    if (currentEditingRowIndex === -1) return;

    const listContainer = getActiveMobileListContainer();
    if (!listContainer) return;

    const cards = listContainer.querySelectorAll('.mobile-info-card');
    const row = cards[currentEditingRowIndex];
    if (!row) return;

    const isMove = (UIStore.mode === 'move');
    const isDiscard = (UIStore.mode === 'discard');

    const rarityClass = isMove ? '.move-card-rarity' : (isDiscard ? '.discard-card-rarity' : '.page-card-rarity');
    const illustClass = isMove ? '.move-card-illustration' : (isDiscard ? '.discard-card-illustration' : '.page-card-illustration');

    if (type === 'rare') {
        const sheetInput = document.getElementById('sheet-card-rarity');
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

        const debouncedShowSuggestions = debounce((val) => {
            showOverlaySuggestions(val);
        }, 100);

        overlayInput.addEventListener('input', (e) => {
            if (activeOverlayType === 'no') {
                const start = e.target.selectionStart;
                e.target.value = e.target.value.replace(/[ㄱ-ㅎ|ㅏ-ㅣ|가-힣]/g, '').toUpperCase();
                e.target.setSelectionRange(start, start);
            }
            const val = e.target.value.trim();
            if (val) {
                if (overlayClearBtn) overlayClearBtn.style.display = 'block';
                debouncedShowSuggestions(val);
            } else {
                debouncedShowSuggestions.cancel && debouncedShowSuggestions.cancel();
                if (overlayClearBtn) overlayClearBtn.style.display = 'none';
                showOverlaySuggestions('');
            }
        });

        // 입력 오버레이에서 엔터를 칠 때 입력 확정 처리
        overlayInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
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



function renderDesktopCardsFromData(dataArray) {
    let listContainerId = 'desktop-cards-list-general';
    if (UIStore.mode === 'add') {
        if (addSubMode === 'pack') listContainerId = 'desktop-cards-list-pack';
        else if (addSubMode === 'deck') listContainerId = 'desktop-cards-list-deck';
    } else if (UIStore.mode === 'move') {
        listContainerId = 'desktop-cards-list-move';
    } else if (UIStore.mode === 'discard') {
        listContainerId = 'desktop-cards-list-discard';
    }

    const listContainer = document.getElementById(listContainerId);
    if (!listContainer) return;

    listContainer.innerHTML = '';
    const wrapper = listContainer.closest('.desktop-cards-wrapper');

    if (dataArray.length === 0) {
        if (wrapper) wrapper.style.display = 'none';
        return;
    }

    if (wrapper) {
        listContainer.style.display = 'grid';
        wrapper.style.display = 'block';
    }

    dataArray.forEach((data, idx) => {
        const nextNum = idx + 1;
        const cardHtml = getDesktopCardHtml(UIStore.mode, addSubMode, idx, nextNum);
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
                illustInp.value = data.illustration;
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
        }
    });
}



function reindexDesktopCards(listContainer) {
    const cards = listContainer.querySelectorAll('.desktop-info-card');
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



function desktopAddEntry(mode, subMode, initialData = null) {
    let listContainerId = 'desktop-cards-list-general';
    if (mode === 'add') {
        if (subMode === 'pack') listContainerId = 'desktop-cards-list-pack';
        else if (subMode === 'deck') listContainerId = 'desktop-cards-list-deck';
    } else if (mode === 'move') {
        listContainerId = 'desktop-cards-list-move';
    } else if (mode === 'discard') {
        listContainerId = 'desktop-cards-list-discard';
    }

    const listContainer = document.getElementById(listContainerId);
    if (!listContainer) return null;

    const wrapper = listContainer.closest('.desktop-cards-wrapper');
    if (wrapper) {
        listContainer.style.display = 'grid';
        wrapper.style.display = 'block';
    }

    const currentCount = listContainer.querySelectorAll('.desktop-info-card').length;
    const nextNum = currentCount + 1;
    const cardHtml = getDesktopCardHtml(mode, subMode, currentCount, nextNum);
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
                illustInp.value = initialData.illustration || "";
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
    return cardEl;
}

function renderDesktopCards() {
    const isMobile = document.documentElement.classList.contains('is-mobile-device');
    if (isMobile) return;

    let listContainerId = 'desktop-cards-list-general';
    if (UIStore.mode === 'add') {
        if (addSubMode === 'pack') listContainerId = 'desktop-cards-list-pack';
        else if (addSubMode === 'deck') listContainerId = 'desktop-cards-list-deck';
    } else if (UIStore.mode === 'move') {
        listContainerId = 'desktop-cards-list-move';
    } else if (UIStore.mode === 'discard') {
        listContainerId = 'desktop-cards-list-discard';
    }

    const listContainer = document.getElementById(listContainerId);
    if (!listContainer) return;

    if (UIStore.mode === 'add') {
        if (addSubMode === 'pack' && (typeof PackDeckStore.isPackTableGenerated === 'undefined' || !PackDeckStore.isPackTableGenerated)) {
            const wrapper = listContainer.closest('.desktop-cards-wrapper');
            if (wrapper) wrapper.style.display = 'none';
            return;
        }
        if (addSubMode === 'deck' && (typeof PackDeckStore.isDeckTableGenerated === 'undefined' || !PackDeckStore.isDeckTableGenerated)) {
            const wrapper = listContainer.closest('.desktop-cards-wrapper');
            if (wrapper) wrapper.style.display = 'none';
            return;
        }
    }

    const cards = listContainer.querySelectorAll('.desktop-info-card');
    const collectedData = [];
    cards.forEach(c => {
        collectedData.push(getDesktopCardData(c));
    });

    renderDesktopCardsFromData(collectedData);
}



function getDesktopCardHtml(mode, subMode, idx, nextNum) {
    if (mode === 'move') {
        return `
            <div class="desktop-info-card" data-index="${idx}">
                <div class="card-row-top" style="display:flex; align-items:center; width:100%; gap:12px; position:relative; padding-left:30px; box-sizing:border-box;">
                    <div style="position:absolute; left:0; display:flex; align-items:center; width:30px; height:100%;">
                        <div style="position:absolute; left:0; width:14px; display:flex; align-items:center; justify-content:center;">
                            <span class="card-num-badge">${nextNum}</span>
                        </div>
                        <span class="card-num-divider" style="position:absolute; left:22px; margin:0 !important;">|</span>
                    </div>
                    <div class="custom-select-wrapper no-arrow" style="max-width:50%; flex:1; position:relative;">
                        <input type="text" class="desktop-card-input desktop-card-name custom-input" data-field="name" placeholder="카드 이름" style="font-weight:700; text-align:left !important; padding:0 24px 0 8px !important;" oninput="handleCardNameInput(this)" onblur="fetchCardByName(this)" onkeydown="if(event.isComposing && (event.key==='Enter' || event.key==='Tab')) { event.preventDefault(); return; } if(this.hasAttribute('readonly') && (event.key==='Escape' || event.key==='Backspace' || event.key==='Delete')) { clearPageNameAndNo(this); event.preventDefault(); return; } if(event.key==='Enter') { this.blur(); }" autocomplete="off">
                        <i class="material-icons clear-name-btn" onclick="clearPageNameAndNo(this)" style="display:none; position:absolute; right:6px; top:50%; transform:translateY(-50%); cursor:pointer; font-size:1.1rem; color:var(--text-muted);">cancel</i>
                    </div>
                    <div class="custom-select-wrapper no-arrow" style="margin-left:auto; width:120px; flex-shrink:0;">
                        <input type="text" class="desktop-card-input desktop-card-no custom-input" data-field="no" placeholder="카드 번호" style="font-family:monospace; text-transform:uppercase; text-align:right !important; padding:0 28px 0 8px !important;" oninput="handleCardNoInput(this)" onblur="fetchCardByNumber(this)" onkeydown="if(event.key==='Enter' && !this.closest('.custom-select-wrapper').classList.contains('active')) fetchCardByNumber(this)" autocomplete="off">
                        <i class="material-icons arrow-icon" style="font-size:1rem; right:8px; line-height:30px; display:none;">arrow_drop_down</i>
                    </div>
                    <div class="card-actions" style="display:flex; gap:6px; flex-shrink:0; width:72px;">
                        <button class="btn-card-action delete" onclick="triggerDesktopDelete(this)" title="제거"><i class="material-icons" style="font-size:1.25rem;">delete</i></button>
                    </div>
                </div>
                <div class="card-row-bottom" style="display:flex; align-items:center; gap:12px; width:100%; padding-left:30px; box-sizing:border-box;">
                    <div class="custom-select-wrapper no-option" style="width:80px; flex-shrink:0;" data-type="strict">
                        <input type="text" class="desktop-card-input desktop-card-illust custom-input" data-field="illust" placeholder="일러스트" style="text-align:left !important; padding:0 8px !important;" readonly>
                        <i class="material-icons arrow-icon" style="font-size:1rem; right:8px; line-height:30px;">arrow_drop_down</i>
                    </div>
                    <div class="custom-select-wrapper no-option" style="width:90px; flex:none;" data-type="strict">
                        <input type="text" class="desktop-card-input desktop-card-rare custom-input" data-field="rare" placeholder="레어도" style="text-align:left !important; padding:0 8px !important;" readonly>
                        <i class="material-icons arrow-icon" style="font-size:1rem; right:8px; line-height:30px;">arrow_drop_down</i>
                    </div>
                    <div style="margin-left:auto; display:flex; gap:6px; align-items:center; flex:none; max-width:320px; justify-content:flex-end;">
                        <div class="custom-select-wrapper no-option" style="width:120px; flex:none;" data-type="strict" id="desktop-wrap-move-from-${nextNum}">
                            <input type="text" class="desktop-card-input desktop-card-loc custom-input" data-field="loc" placeholder="보관 위치" style="text-align:right !important; padding:0 28px 0 8px !important;" readonly>
                            <i class="material-icons arrow-icon" style="font-size:1rem; right:8px; line-height:30px;">arrow_drop_down</i>
                        </div>
                        <i class="material-icons loc-arrow" style="font-size:1rem; color:var(--text-table); flex-shrink:0;">arrow_forward</i>
                        <div class="custom-select-wrapper" style="width:120px; flex:none;" data-type="free" id="desktop-wrap-move-to-${nextNum}">
                            <input type="text" class="desktop-card-input desktop-card-to custom-input" data-field="to" placeholder="이동 위치" style="text-align:right !important; padding:0 28px 0 8px !important;">
                            <i class="material-icons arrow-icon" style="font-size:1rem; right:8px; line-height:30px;">arrow_drop_down</i>
                        </div>
                    </div>
                    <div class="desktop-qty-wrapper" style="width:72px; height:30px; flex-shrink:0; display:flex; align-items:center; border:1px solid transparent; border-radius:16px; background:transparent; padding:0 4px; box-sizing:border-box; gap:2px;">
                        <input type="number" class="desktop-card-input desktop-card-qty qty-input" data-field="qty" placeholder="수량" min="1" readonly style="flex:1; width:0; border:none !important; background:transparent !important; text-align:right !important; padding:0 !important; outline:none !important; font-size:0.85rem;" oninput="handleCardQtyInput(this)" onfocus="updateMoveRowMaxQty(this)">
                        <span style="font-size:0.85rem; font-weight:700; color:var(--text-table); flex-shrink:0; pointer-events:none; margin-right:2px;">장</span>
                        <div class="desktop-qty-controls" style="display:flex; flex-direction:column; justify-content:center; align-items:center; height:100%; gap:1px; flex-shrink:0;">
                            <div class="qty-up-btn" onclick="adjustStepQty(this, 1)" style="cursor:pointer; display:flex; align-items:center; justify-content:center; height:12px; line-height:12px; color:var(--text-table);"><i class="material-icons" style="font-size:0.9rem;">keyboard_arrow_up</i></div>
                            <div class="qty-down-btn" onclick="adjustStepQty(this, -1)" style="cursor:pointer; display:flex; align-items:center; justify-content:center; height:12px; line-height:12px; color:var(--text-table);"><i class="material-icons" style="font-size:0.9rem;">keyboard_arrow_down</i></div>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    const isDiscard = (mode === 'discard');
    const actionsHtml = isDiscard ? `
        <button class="btn-card-action delete" onclick="triggerDesktopDelete(this)" title="제거"><i class="material-icons" style="font-size:1.25rem;">delete</i></button>
    ` : `
        <button class="btn-card-action copy" onclick="triggerDesktopCopy(this)" title="복제"><i class="material-icons" style="font-size:1.25rem;">library_add</i></button>
        <button class="btn-card-action delete" onclick="triggerDesktopDelete(this)" title="제거"><i class="material-icons" style="font-size:1.25rem;">delete</i></button>
    `;

    const locPlaceholder = "보관 위치";
    const locReadonly = isDiscard ? "readonly" : "";

    return `
        <div class="desktop-info-card" data-index="${idx}">
            <div class="card-row-top" style="display:flex; align-items:center; width:100%; gap:12px; position:relative; padding-left:30px; box-sizing:border-box;">
                <div style="position:absolute; left:0; display:flex; align-items:center; width:30px; height:100%;">
                    <div style="position:absolute; left:0; width:14px; display:flex; align-items:center; justify-content:center;">
                        <span class="card-num-badge">${nextNum}</span>
                    </div>
                    <span class="card-num-divider" style="position:absolute; left:22px; margin:0 !important;">|</span>
                </div>
                <div class="custom-select-wrapper no-arrow" style="max-width:50%; flex:1; position:relative;">
                    <input type="text" class="desktop-card-input desktop-card-name custom-input" data-field="name" placeholder="카드 이름" style="font-weight:700; text-align:left !important; padding:0 24px 0 8px !important;" oninput="handleCardNameInput(this)" onblur="fetchCardByName(this)" onkeydown="if(event.isComposing && (event.key==='Enter' || event.key==='Tab')) { event.preventDefault(); return; } if(this.hasAttribute('readonly') && (event.key==='Escape' || event.key==='Backspace' || event.key==='Delete')) { clearPageNameAndNo(this); event.preventDefault(); return; } if(event.key==='Enter') { this.blur(); }" autocomplete="off">
                    <i class="material-icons clear-name-btn" onclick="clearPageNameAndNo(this)" style="display:none; position:absolute; right:6px; top:50%; transform:translateY(-50%); cursor:pointer; font-size:1.1rem; color:var(--text-muted);">cancel</i>
                </div>
                <div class="custom-select-wrapper no-arrow" style="margin-left:auto; width:120px; flex-shrink:0;">
                    <input type="text" class="desktop-card-input desktop-card-no custom-input" data-field="no" placeholder="카드 번호" style="font-family:monospace; text-transform:uppercase; text-align:right !important; padding:0 28px 0 8px !important;" oninput="handleCardNoInput(this)" onblur="fetchCardByNumber(this)" onkeydown="if(event.key==='Enter' && !this.closest('.custom-select-wrapper').classList.contains('active')) fetchCardByNumber(this)" autocomplete="off">
                    <i class="material-icons arrow-icon" style="font-size:1rem; right:8px; line-height:30px; display:none;">arrow_drop_down</i>
                </div>
                <div class="card-actions" style="display:flex; gap:6px; flex-shrink:0; width:72px;">
                    ${actionsHtml}
                </div>
            </div>
            <div class="card-row-bottom" style="display:flex; align-items:center; gap:12px; width:100%; padding-left:30px; box-sizing:border-box;">
                <div class="custom-select-wrapper no-option" style="width:80px; flex-shrink:0;" data-type="strict">
                    <input type="text" class="desktop-card-input desktop-card-illust custom-input" data-field="illust" placeholder="일러스트" style="text-align:left !important; padding:0 8px !important;" readonly>
                    <i class="material-icons arrow-icon" style="font-size:1rem; right:8px; line-height:30px;">arrow_drop_down</i>
                </div>
                <div class="custom-select-wrapper no-option" style="width:90px; flex:none;" data-type="strict">
                    <input type="text" class="desktop-card-input desktop-card-rare custom-input" data-field="rare" placeholder="레어도" style="text-align:left !important; padding:0 8px !important;" readonly>
                    <i class="material-icons arrow-icon" style="font-size:1rem; right:8px; line-height:30px;">arrow_drop_down</i>
                </div>
                <div class="custom-select-wrapper${mode === 'discard' ? ' no-option' : ''}" style="margin-left:auto; width:120px; flex:none;" data-type="${mode === 'add' ? 'free' : 'strict'}" id="desktop-wrap-${mode}-${idx}">
                    <input type="text" class="desktop-card-input desktop-card-loc custom-input" data-field="loc" placeholder="${locPlaceholder}" style="text-align:right !important; padding:0 28px 0 8px !important;" ${locReadonly}>
                    <i class="material-icons arrow-icon" style="font-size:1rem; right:8px; line-height:30px;">arrow_drop_down</i>
                </div>
                <div class="desktop-qty-wrapper" style="width:72px; height:30px; flex-shrink:0; display:flex; align-items:center; border:1px solid transparent; border-radius:16px; background:transparent; padding:0 4px; box-sizing:border-box; gap:2px;">
                    <input type="number" class="desktop-card-input desktop-card-qty qty-input" data-field="qty" placeholder="수량" min="1" readonly style="flex:1; width:0; border:none !important; background:transparent !important; text-align:right !important; padding:0 !important; outline:none !important; font-size:0.85rem;" oninput="handleCardQtyInput(this)">
                    <span style="font-size:0.85rem; font-weight:700; color:var(--text-table); flex-shrink:0; pointer-events:none; margin-right:2px;">장</span>
                    <div class="desktop-qty-controls" style="display:flex; flex-direction:column; justify-content:center; align-items:center; height:100%; gap:1px; flex-shrink:0;">
                        <div class="qty-up-btn" onclick="adjustStepQty(this, 1)" style="cursor:pointer; display:flex; align-items:center; justify-content:center; height:12px; line-height:12px; color:var(--text-table);"><i class="material-icons" style="font-size:0.9rem;">keyboard_arrow_up</i></div>
                        <div class="qty-down-btn" onclick="adjustStepQty(this, -1)" style="cursor:pointer; display:flex; align-items:center; justify-content:center; height:12px; line-height:12px; color:var(--text-table);"><i class="material-icons" style="font-size:0.9rem;">keyboard_arrow_down</i></div>
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
        illustration: illustInp ? (illustInp.dataset.raw || illustInp.value) : "",
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
    if (UIStore.mode === 'add') {
        if (addSubMode === 'pack') listContainerId = 'desktop-cards-list-pack';
        else if (addSubMode === 'deck') listContainerId = 'desktop-cards-list-deck';
    } else if (UIStore.mode === 'move') {
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

    const newCard = desktopAddEntry(UIStore.mode, addSubMode, copyData);
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
    if (UIStore.mode === 'add') {
        if (addSubMode === 'pack') listContainerId = 'desktop-cards-list-pack';
        else if (addSubMode === 'deck') listContainerId = 'desktop-cards-list-deck';
    } else if (UIStore.mode === 'move') {
        listContainerId = 'desktop-cards-list-move';
    } else if (UIStore.mode === 'discard') {
        listContainerId = 'desktop-cards-list-discard';
    }

    const listContainer = document.getElementById(listContainerId);
    if (!listContainer) return;
    const card = btn.closest('.desktop-info-card');
    if (!card) return;

    const delBtn = card.querySelector('.btn-card-action.delete');
    if (delBtn && delBtn.hasAttribute('disabled')) return;

    card.remove();
    reindexDesktopCards(listContainer);
    
    const remainingCards = listContainer.querySelectorAll('.desktop-info-card');
    if (remainingCards.length === 0) {
        desktopAddEntry(UIStore.mode, addSubMode);
    }
}

function savePendingFormData() {
    if (typeof UIStore.mode === 'undefined') return;
    
    const payload = {
        mode: UIStore.mode,
        subMode: null,
        ts: Date.now(),
        data: {}
    };

    const isMobile = document.documentElement.classList.contains('is-mobile-device');
    const subMode = (UIStore.mode === 'add') ? (UIStore.chipState.add || 'general') : UIStore.mode;
    const containerId = isMobile 
        ? `mobile-cards-list-${subMode}` 
        : `desktop-cards-list-${subMode}`;
    const container = document.getElementById(containerId);

    if (container) {
        const cardClass = isMobile ? '.mobile-info-card' : '.desktop-info-card';
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
                    illustration: illustrationInput ? (illustrationInput.dataset.raw || illustrationInput.value || '') : ''
                });
            }
        });
        payload.data.rows = rows;
    }

    if (UIStore.mode === 'add') {
        payload.subMode = UIStore.chipState.add || 'general';
        if (payload.subMode === 'pack') {
            const packSearchInput = document.getElementById('pack-search-input');
            payload.data.packSearchVal = packSearchInput ? packSearchInput.value.trim() : '';
            payload.data.isPackTableGenerated = typeof PackDeckStore.isPackTableGenerated !== 'undefined' ? PackDeckStore.isPackTableGenerated : false;
            payload.data.currentPackInfo = typeof PackDeckStore.currentPackInfo !== 'undefined' ? PackDeckStore.currentPackInfo : null;
        } else if (payload.subMode === 'deck') {
            const deckCodeInput = document.getElementById('deck-code-input');
            payload.data.deckCodeVal = deckCodeInput ? deckCodeInput.value.trim() : '';
            payload.data.isDeckTableGenerated = typeof PackDeckStore.isDeckTableGenerated !== 'undefined' ? PackDeckStore.isDeckTableGenerated : false;
            payload.data.currentDeckName = typeof PackDeckStore.currentDeckName !== 'undefined' ? PackDeckStore.currentDeckName : '';
        }
    } else if (UIStore.mode === 'move') {
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



    switchToMode(payload.mode, true, payload.subMode, null, true);

    setTimeout(() => {
        const isMobile = document.documentElement.classList.contains('is-mobile-device');
        if (isMobile) {
            const dataArray = (payload.data.rows || []).map(r => ({
                name: r.nameText || r.cardName || "",
                cardNo: r.cardNo || "",
                illustration: r.illustrationRaw || r.illustration || "",
                rarity: r.procRaw || r.rarity || "",
                loc: r.loc || r.currentLoc || "",
                to: r.targetLoc || "",
                qty: r.qty || r.moveQty || 1,
                cardData: null
            }));
            renderMobileCardsFromData(dataArray);
            updateManageFooter(payload.mode);
            sessionStorage.removeItem('pending_action_data');
            showToast('이전 입력 데이터가 복원되었습니다.', 'toast-info');
            return;
        }

        const dataArray = (payload.data.rows || []).map(r => ({
            name: r.nameText || r.cardName || "",
            cardNo: r.cardNo || "",
            illustration: r.illustrationRaw || r.illustration || "",
            rarity: r.procRaw || r.rarity || "",
            loc: r.loc || r.currentLoc || "",
            to: r.targetLoc || "",
            qty: r.qty || r.moveQty || 1,
            cardData: null
        }));

        if (payload.mode === 'add') {
            const isPack = (payload.subMode === 'pack');
            const isDeck = (payload.subMode === 'deck');

            if (isPack) {
                const packSearchInput = document.getElementById('pack-search-input');
                if (packSearchInput && payload.data.packSearchVal) packSearchInput.value = payload.data.packSearchVal;
                if (payload.data.currentPackInfo) {
                    PackDeckStore.currentPackInfo = payload.data.currentPackInfo;
                }
                if (payload.data.isPackTableGenerated && PackDeckStore.currentPackInfo) {
                    PackDeckStore.isPackTableGenerated = true;
                    const area = document.getElementById('pack-table-area');
                    if (area) area.style.display = 'block';
                    const container = document.getElementById('manage-table-container');
                    if (container) container.classList.add('anim-active');
                }
            } else if (isDeck) {
                const deckCodeInput = document.getElementById('deck-code-input');
                if (deckCodeInput && payload.data.deckCodeVal) deckCodeInput.value = payload.data.deckCodeVal;
                if (payload.data.currentDeckName) {
                    PackDeckStore.currentDeckName = payload.data.currentDeckName;
                }
                if (payload.data.isDeckTableGenerated && PackDeckStore.currentDeckName) {
                    PackDeckStore.isDeckTableGenerated = true;
                    const area = document.getElementById('deck-table-area');
                    if (area) area.style.display = 'block';
                    const container = document.getElementById('manage-table-container');
                    if (container) container.classList.add('anim-active');
                }
            }
        } else if (payload.mode === 'move') {
            if (payload.data.isRenameMode) {
                isRenameMode = true;
                const renameFrom = document.getElementById('rename-from-input');
                const renameTo = document.getElementById('rename-to-input');
                if (renameFrom && payload.data.renameFromVal) renameFrom.value = payload.data.renameFromVal;
                if (renameTo && payload.data.renameToVal) renameTo.value = payload.data.renameToVal;
                updateManageFooter('move');
            }
        }

        renderDesktopCardsFromData(dataArray);
        updateManageFooter(payload.mode);
        sessionStorage.removeItem('pending_action_data');
        showToast('이전 입력 데이터가 복원되었습니다.', 'toast-info');
    }, 500);
}

/**
 * FAQ & 카드 보관 팁 세그먼트 탭 전환 함수 (캡슐 라디오 및 다국어 지원)
 * @param {string} tabName - 'faq' 또는 'tips'
 */
window.switchFaqTab = function(tabName) {
    const faqRadio = document.getElementById('faq-radio-faq');
    const tipsRadio = document.getElementById('faq-radio-tips');

    if (tabName === 'faq') {
        if (faqRadio) faqRadio.checked = true;
        document.querySelectorAll('.faq-tab-content-faq').forEach(el => el.style.display = 'flex');
        document.querySelectorAll('.faq-tab-content-tips').forEach(el => el.style.display = 'none');
    } else if (tabName === 'tips') {
        if (tipsRadio) tipsRadio.checked = true;
        document.querySelectorAll('.faq-tab-content-tips').forEach(el => el.style.display = 'flex');
        document.querySelectorAll('.faq-tab-content-faq').forEach(el => el.style.display = 'none');
    }
};

