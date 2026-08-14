/**
 * YGO Synapse - 온보딩 가이드 시스템
 * SVG Mask 기반 하이라이트 + 가이드 툴팁
 */

/* ─── 뷰포트/설정 감지 및 동적 타겟팅 헬퍼 ─── */
function getActiveViewMode() {
    if (window.innerWidth <= 768) {
        return 'mobile-card';
    } else {
        return 'desktop-card';
    }
}

function getOnboardingTarget(type, index = 0) {
    const viewMode = getActiveViewMode();
    const mode = typeof currentMode !== 'undefined' ? currentMode : 'add';
    const subMode = typeof addSubMode !== 'undefined' ? addSubMode : 'general';
    
    if (type === 'container') {
        if (viewMode === 'desktop-card') {
            let containerId = 'desktop-cards-list-general';
            if (mode === 'move') containerId = 'desktop-cards-list-move';
            else if (mode === 'discard') containerId = 'desktop-cards-list-discard';
            else if (mode === 'add') {
                if (subMode === 'pack') containerId = 'desktop-cards-list-pack';
                else if (subMode === 'deck') containerId = 'desktop-cards-list-deck';
            }
            return '#' + containerId;
        }
        // mobile-card인 경우
        let containerId = 'mobile-cards-list-general';
        if (mode === 'move') containerId = 'mobile-cards-list-move';
        else if (mode === 'discard') containerId = 'mobile-cards-list-discard';
        else if (mode === 'add') {
            if (subMode === 'pack') containerId = 'mobile-cards-list-pack';
            else if (subMode === 'deck') containerId = 'mobile-cards-list-deck';
        }
        return '#' + containerId;
    }
    
    let root = null;
    const containerSelector = getOnboardingTarget('container');
    if (containerSelector) {
        const container = document.querySelector(containerSelector);
        const cardClass = (viewMode === 'desktop-card') ? '.desktop-info-card' : '.mobile-info-card';
        root = container ? container.querySelector(`${cardClass}[data-index="${index}"]`) : null;
    }
    
    if (!root) return null;
    if (type === 'row_or_card') return root;
    
    switch (type) {
        case 'name':
            if (viewMode === 'desktop-card') return root.querySelector('.desktop-card-name') ? root.querySelector('.desktop-card-name').closest('.custom-select-wrapper') : null;
            return document.getElementById('sheet-card-name') ? document.getElementById('sheet-card-name').closest('.sheet-input-box') : null;
        case 'no':
            if (viewMode === 'desktop-card') return root.querySelector('.desktop-card-no') ? root.querySelector('.desktop-card-no').closest('.custom-select-wrapper') : null;
            return document.getElementById('sheet-card-no') ? document.getElementById('sheet-card-no').closest('.sheet-input-box') : null;
        case 'loc':
            if (viewMode === 'desktop-card') return root.querySelector('.desktop-card-loc') ? root.querySelector('.desktop-card-loc').closest('.custom-select-wrapper') : null;
            return document.getElementById('sheet-card-loc') ? document.getElementById('sheet-card-loc').closest('.sheet-input-box') : null;
        case 'action':
            return root.querySelector('.card-actions');
    }
    return null;
}

/* ─── 페이지별 온보딩 시나리오 데이터 ─── */

function getMobileSearchBtn() {
    return document.querySelector('.mobile-nav-item[data-mode="search"]');
}

const ONBOARDING_STEPS = {
    home: [
        {
            target: '#auth-capsule-btn',
            title: '로그인',
            content: 'SNS 로그인을 통해 카드 정보를 저장할 수 있습니다.',
            position: 'bottom'
        },
        {
            target: () => {
                const mobileSearchBtn = getMobileSearchBtn();
                if (mobileSearchBtn && mobileSearchBtn.offsetParent !== null) {
                    return mobileSearchBtn;
                }
                return '.search-box';
            },
            title: '카드 검색',
            content: '카드 이름을 입력하여 본인이 등록한 카드의 정보를 검색할 수 있습니다.',
            position: () => {
                const mobileSearchBtn = getMobileSearchBtn();
                if (mobileSearchBtn && mobileSearchBtn.offsetParent !== null) {
                    return 'top';
                }
                return 'bottom';
            }
        },
        {
            target: '#home-auth-section',
            title: '대시보드',
            content: '본인이 등록한 카드 정보를 요약해서 확인할 수 있습니다.',
            position: 'top'
        },
        {
            target: () => window.innerWidth > 768 ? '.app-sidebar' : '.mobile-nav-container',
            title: '페이지 이동',
            content: '클릭하여 원하는 페이지로 이동할 수 있습니다.',
            position: () => window.innerWidth > 768 ? 'right' : 'top'
        }
    ],
    add: [
        {
            target: '#manage-top-segment',
            title: '모드 선택',
            content: '3가지 모드(등록, 이동, 제거) 중 하나를 선택하여 카드 정보를 관리할 수 있습니다.',
            position: 'bottom',
            onEnter: () => {
                if (typeof switchManageTab === 'function') switchManageTab('add');
            }
        },
        {
            target: () => getOnboardingTarget('row_or_card', 0) || getOnboardingTarget('container'),
            title: '등록 카드 소개',
            content: '카드 정보를 입력하는 공간입니다. 올바른 카드 정보가 입력된 경우 일러스트와 레어도, 보관 위치, 수량을 선택할 수 있습니다. (*일러스트는 임의로 선택해야 합니다.)',
            position: 'bottom',
            onEnter: () => {
                if (typeof switchAddSubMode === 'function') switchAddSubMode('general');
                
                // 첫 번째 카드의 데이터 채우기 (데모) - 보관위치 '온보딩', 수량 '1' 반영
                const viewMode = getActiveViewMode();
                if (viewMode === 'desktop-card') {
                    if (typeof renderDesktopCardsFromData === 'function') {
                        renderDesktopCardsFromData([{
                            name: '푸른 눈의 백룡',
                            cardNo: 'LOB-K001',
                            illustration: '기본',
                            rarity: 'Ultra Rare',
                            loc: '온보딩',
                            qty: 1
                        }]);
                    }
                } else if (viewMode === 'mobile-card') {
                    if (typeof renderMobileCards === 'function') {
                        renderMobileCards();
                    }
                }
            }
        },
        {
            multiTarget: () => {
                const targets = [];
                const viewMode = getActiveViewMode();
                if (viewMode === 'desktop-card') {
                    const card = document.querySelector('.desktop-cards-list .desktop-info-card[data-index="0"]');
                    if (card) targets.push(card.querySelector('.card-actions'));
                    const addBtn = document.querySelector('.desktop-add-dashed-card-container');
                    if (addBtn) targets.push(addBtn);
                } else if (viewMode === 'mobile-card') {
                    const card = document.querySelector('.mobile-cards-list .mobile-info-card[data-index="0"]');
                    if (card) targets.push(card.querySelector('.card-actions'));
                }
                return targets;
            },
            mergeMask: false,
            title: '목록 복제 / 제거',
            content: '작성 중인 카드를 복제하거나 목록에서 삭제할 수 있으며, 하단 버튼을 통해 새로운 등록 카드를 추가할 수 있습니다.',
            position: 'top'
        },
        {
            target: () => document.getElementById('mobile-entry-bottom-sheet'),
            title: '모바일 편집 & 바텀시트',
            content: '모바일에서는 편집 버튼을 누르거나 카드를 터치하면 상세 정보를 입력할 수 있는 바텀 시트가 노출됩니다.',
            position: 'top',
            skipCondition: () => window.innerWidth > 768,
            onEnter: () => {
                if (typeof openEditBottomSheet === 'function') {
                    openEditBottomSheet(0);
                }
            },
            onLeave: () => {
                if (typeof closeEntryBottomSheet === 'function') {
                    closeEntryBottomSheet();
                }
            }
        },
        {
            multiTarget: () => {
                const footerBtns = document.querySelectorAll('#manage-footer-left .btn-manage-action');
                return Array.from(footerBtns).filter(btn => !btn.classList.contains('btn-hidden'));
            },
            mergeMask: true,
            title: '전용 등록 모드 전환',
            content: '하단 버튼을 누르면 일반 개별 등록 외에 팩 추가 또는 덱 불러오기 등 카드 대량 등록을 위한 전용 모드로 전환됩니다.',
            position: 'top'
        },
        {
            target: () => {
                return '#pack-search-box';
            },
            title: '팩 등록 및 국가 선택',
            content: '팩 등록 모드에서는 팩 이름을 검색하여 수록 카드를 원클릭으로 일괄 생성합니다. 중복 팩 발매 시 국가 라디오 버튼을 선택할 수 있습니다.',
            position: 'top',
            onEnter: () => {
                if (typeof switchAddSubMode === 'function') switchAddSubMode('pack');
                const inp = document.getElementById('pack-search-input');
                if (inp) inp.value = 'EXCLUSIVE PACK';
                
                const status = document.getElementById('pack-status-msg');
                const genBtn = document.getElementById('pack-gen-btn');
                if (status) {
                    status.style.display = 'flex';
                    status.style.flexDirection = 'row';
                    status.style.alignItems = 'center';
                    status.style.justifyContent = 'center';
                    status.style.flexWrap = 'wrap';
                    status.style.marginTop = '4px';
                    status.style.color = "var(--success-green)";
                    status.classList.add('status-success');

                    status.innerHTML = `
                        <span class="status-msg-text" style="font-size: 0.85rem; font-weight: 500; display: inline-flex; align-items: center; height: 20px; margin: 0; padding: 0;">발매 국가 선택 :</span>
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
                        <div id="pack-lang-options" style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-left: 8px; margin-top: 0px;">
                            <label style="cursor: pointer; display: inline-flex; align-items: center; margin: 0; padding: 0; height: 20px;">
                                <input class="with-gap small-radio" name="ob-lang" type="radio" value="ko" checked />
                                <span style="font-size: 0.85rem; color: var(--text-primary); white-space: nowrap;">한국</span>
                            </label>
                            <label style="cursor: pointer; display: inline-flex; align-items: center; margin: 0; padding: 0; height: 20px;">
                                <input class="with-gap small-radio" name="ob-lang" type="radio" value="en" />
                                <span style="font-size: 0.85rem; color: var(--text-primary); white-space: nowrap;">영미</span>
                            </label>
                            <label style="cursor: pointer; display: inline-flex; align-items: center; margin: 0; padding: 0; height: 20px;">
                                <input class="with-gap small-radio" name="ob-lang" type="radio" value="de" />
                                <span style="font-size: 0.85rem; color: var(--text-primary); white-space: nowrap;">독일</span>
                            </label>
                        </div>
                    `;
                }
                if (genBtn) genBtn.classList.remove('disabled');
            },
            onLeave: () => {
                const status = document.getElementById('pack-status-msg');
                if (status) {
                    status.innerHTML = '';
                    status.style.display = 'none';
                }
            }
        },
        {
            target: '#deck-search-box',
            title: '덱 불러오기 가이드',
            content: '덱 코드를 입력하여 뉴런에 등록한 덱의 데이터를 가져올 수 있습니다.',
            position: 'top',
            onEnter: () => {
                if (typeof switchAddSubMode === 'function') switchAddSubMode('deck');
                const codeInp = document.getElementById('deck-code-input');
                if (codeInp) codeInp.value = '123-456-789';
            },
            onLeave: () => {
                if (typeof switchAddSubMode === 'function') switchAddSubMode('general');
                if (typeof initPageAdd === 'function') initPageAdd();
            }
        }
    ],
    move: [
        {
            target: () => getOnboardingTarget('container'),
            title: '카드 이동 폼',
            content: '소장한 카드 리스트에서 이동할 카드를 불러온 뒤, 기존 보관 위치와 새로 이동할 보관 위치를 각각 입력합니다.',
            position: 'top',
            onEnter: () => {
                if (typeof switchManageTab === 'function') switchManageTab('move');
            },
            onLeave: () => {
                if (typeof isRenameMode !== 'undefined' && isRenameMode && typeof toggleRenameMode === 'function') {
                    toggleRenameMode();
                }
            }
        },
        {
            target: '#manage-footer-left',
            title: '일괄 이동 기능 안내',
            content: '선택한 보관위치의 카드들을 지정한 보관위치로 한 번에 이동하고 싶을 때는 하단의 일괄 이동 기능을 활용합니다.',
            position: 'top',
            onEnter: () => {
                if (typeof isRenameMode !== 'undefined' && !isRenameMode && typeof toggleRenameMode === 'function') {
                    toggleRenameMode();
                }
            }
        },
        {
            target: () => document.getElementById('manage-primary-btn') || getOnboardingTarget('container'),
            title: '최종 실행 및 단축키',
            content: '입력 완료 후 버튼을 클릭하거나, 데스크톱의 경우 Cmd/Ctrl + Enter 단축키를 눌러 카드 위치 변경을 즉시 실행합니다.',
            position: 'top',
            skipCondition: () => window.innerWidth <= 768,
            onLeave: () => {
                if (typeof isRenameMode !== 'undefined' && isRenameMode && typeof toggleRenameMode === 'function') {
                    toggleRenameMode();
                }
            }
        }
    ],
    discard: [
        {
            target: () => getOnboardingTarget('container'),
            title: '카드 제거 폼',
            content: '소장 목록에서 정보를 삭제할 카드 이름/카드 번호를 지정하고, 차감할 수량(장수)을 조절합니다.',
            position: 'top',
            onEnter: () => {
                if (typeof switchManageTab === 'function') switchManageTab('discard');
            },
            onLeave: () => {
                if (typeof isDeleteLocationMode !== 'undefined' && isDeleteLocationMode && typeof toggleDeleteLocationMode === 'function') {
                    toggleDeleteLocationMode();
                }
            }
        },
        {
            target: '#manage-footer-left',
            title: '위치 삭제 기능 안내',
            content: '특정 보관 위치와 그 위치에 등록된 모든 카드 정보를 한 번에 통째로 삭제하고 싶을 때는 하단의 위치 삭제 기능을 활용합니다.',
            position: 'top',
            onEnter: () => {
                if (typeof isDeleteLocationMode !== 'undefined' && !isDeleteLocationMode && typeof toggleDeleteLocationMode === 'function') {
                    toggleDeleteLocationMode();
                }
            }
        },
        {
            target: '#manage-footer-left',
            title: '일괄 실행 및 재확인',
            content: '입력 완료 후 일괄 삭제 버튼을 누르면, 실수로 카드가 지워지는 것을 방지하기 위해 경고 모달창을 통한 최종 재확인 단계를 거치게 됩니다.',
            position: 'top'
        },
        {
            target: () => document.getElementById('manage-primary-btn') || getOnboardingTarget('container'),
            title: '빠른 실행 단축키',
            content: '데스크톱 환경에서는 Cmd/Ctrl + Enter 단축키를 누르면 재확인 단계로 즉시 진입할 수 있어 빠른 작업이 가능합니다.',
            position: 'top',
            skipCondition: () => window.innerWidth <= 768,
            onLeave: () => {
                if (typeof isDeleteLocationMode !== 'undefined' && isDeleteLocationMode && typeof toggleDeleteLocationMode === 'function') {
                    toggleDeleteLocationMode();
                }
            }
        }
    ],
    inventory: [
        {
            target: '#inventory-content-area .segment-control',
            title: '보유 현황 페이지',
            content: '카드 보관 현황을 확인할 수 있는 페이지입니다. 대시보드에서는 요약된 정보를 확인할 수 있으며, 전체 목록 역시 확인 가능합니다.',
            position: 'bottom',
            onEnter: () => {
                if (typeof switchToMode === 'function') {
                    switchToMode('inventory', false, 'dashboard');
                }
            }
        },
        {
            target: '#form-inventory-dashboard .mode-form-content',
            title: '대시보드 모드',
            content: '대시보드에서는 소장하고 있는 카드의 총 수량, 종류 수, 보관 위치별 및 레어도별 카드 통계를 한눈에 시각적으로 파악할 수 있습니다.',
            position: 'top'
        },
        {
            target: 'label[for="inv-mode-list"]',
            title: '목록 탭 전환 및 정렬 안내',
            content: '목록 탭에서는 각 열의 헤더를 클릭하여 데이터를 오름차순 또는 내림차순으로 자유롭게 정렬할 수 있습니다.',
            position: 'bottom',
            onEnter: () => {
                if (typeof switchToMode === 'function') {
                    switchToMode('inventory', false, 'list');
                }
            }
        },
        {
            target: () => {
                return document.querySelector('.inventory-table thead tr');
            },
            title: '정렬(Sort) 안내',
            content: '각 열의 헤더(카드 이름, 카드 번호 등)를 클릭하여 데이터를 오름차순 또는 내림차순으로 정렬할 수 있습니다.',
            position: 'bottom'
        },
        {
            multiTarget: () => {
                const viewMode = getActiveViewMode();
                const targets = [];
                if (viewMode === 'mobile-card') {
                    targets.push(document.getElementById('mobile-grid-filter-sheet'));
                } else {
                    targets.push(document.getElementById('inventory-filter-popup'));
                }
                targets.push(document.querySelector('.inventory-table thead th.col-card-no'));
                return targets.filter(Boolean);
            },
            mergeMask: false,
            title: '필터링(Filter) 안내',
            content: '깔때기 모양의 필터 아이콘을 클릭하면 특정 카드 이름, 카드 번호, 레어도, 보관 위치만 골라서 볼 수 있는 필터 옵션이 열립니다.',
            position: 'bottom',
            onEnter: () => {
                const btn = document.querySelector('.inventory-table thead th.col-card-no .filter-trigger-btn');
                if (btn) btn.click();
            },
            onLeave: () => {
                if (typeof closeGridFilter === 'function') {
                    closeGridFilter();
                }
                if (typeof closeGridFilterSheet === 'function') {
                    closeGridFilterSheet();
                }
                if (typeof switchToMode === 'function') {
                    switchToMode('inventory', false, 'dashboard');
                }
            }
        }
    ]
};

/* ─── 온보딩 매니저 ─── */
const OnboardingManager = (() => {
    const STORAGE_KEY = 'ygo_onboarding_done';
    let overlay = null;
    let tooltip = null;
    let currentPage = null;
    let currentStepIndex = 0;
    let steps = [];
    let resizeHandler = null;
    let isActive = false;

    /* --- localStorage 관리 --- */
    function getDonePages() {
        try {
            return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
        } catch { return {}; }
    }

    function markPageDone(page) {
        const done = getDonePages();
        done[page] = true;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(done));
        
        // 서버 동기화 함수가 존재하면 호출
        if (typeof saveUserSetting === 'function') {
            saveUserSetting('onboarding', done);
        }
    }

    function isPageDone(page) {
        return getDonePages()[page] === true;
    }

    function resetAllPages() {
        localStorage.removeItem(STORAGE_KEY);
    }

    /* --- DOM 요소 생성/제거 --- */
    function createOverlay() {
        if (overlay) return;

        // SVG 오버레이
        const svgNS = 'http://www.w3.org/2000/svg';
        overlay = document.createElementNS(svgNS, 'svg');
        overlay.setAttribute('class', 'onboarding-overlay');
        overlay.innerHTML = `
            <defs>
                <mask id="onboarding-mask">
                    <rect x="0" y="0" width="100%" height="100%" fill="white"/>
                    <g id="onboarding-holes-container"></g>
                </mask>
            </defs>
            <rect class="onboarding-dim" x="0" y="0" width="100%" height="100%" mask="url(#onboarding-mask)"/>
        `;
        document.body.appendChild(overlay);

        // 툴팁
        tooltip = document.createElement('div');
        tooltip.className = 'onboarding-tooltip';
        tooltip.innerHTML = `
            <div class="onboarding-tooltip-header">
                <span class="onboarding-tooltip-title"></span>
                <span class="onboarding-step-counter"></span>
            </div>
            <p class="onboarding-tooltip-content"></p>
            <div class="onboarding-tooltip-footer">
                <button class="onboarding-btn-skip">건너뛰기</button>
                <div class="onboarding-btn-group">
                    <button class="onboarding-btn-prev" disabled>이전</button>
                    <button class="onboarding-btn-next">다음</button>
                </div>
            </div>
        `;
        document.body.appendChild(tooltip);

        // 이벤트 바인딩
        // 툴팁 내부 버튼 이벤트 위임 처리
        tooltip.addEventListener('click', (e) => {
            if (e.target.closest('.onboarding-btn-skip')) { stop(true); return; }
            if (e.target.closest('.onboarding-btn-prev')) { prev(); return; }
            if (e.target.closest('.onboarding-btn-next')) { next(); return; }
        });

        // 딤 클릭 시 다음 단계
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay || e.target.classList.contains('onboarding-dim')) {
                next();
            }
        });
    }

    function destroyOverlay() {
        if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
        if (tooltip && tooltip.parentNode) tooltip.parentNode.removeChild(tooltip);
        overlay = null;
        tooltip = null;
    }

    /* --- 하이라이트 위치 계산 --- */
    function getTargetElement(target) {
        if (typeof target === 'function') {
            const result = target();
            if (result instanceof Element) return result;
            return document.querySelector(result);
        }
        if (target instanceof Element) return target;
        return document.querySelector(target);
    }

    function getPosition(step) {
        const p = step.position;
        return typeof p === 'function' ? p() : p;
    }

    function updateOverlayHighlight() {
        if (!isActive || !overlay) return;
        const step = steps[currentStepIndex];
        if (!step) return;

        // 타겟 목록화 (단일 타겟도 배열로 처리)
        let targets = step.multiTarget ? step.multiTarget() : [step.target];
        const holesContainer = document.getElementById('onboarding-holes-container');
        if (!holesContainer) return;
        
        holesContainer.innerHTML = ''; // 기존 구멍 제거
        const svgNS = 'http://www.w3.org/2000/svg';
        const padding = 8;
        const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;
        const scrollTop = window.pageYOffset || document.documentElement.scrollTop;

        let combinedRect = null;
        const targetElements = [];

        targets.forEach(t => {
            const el = getTargetElement(t);
            if (!el) return;
            targetElements.push(el);

            const rect = el.getBoundingClientRect();
            
            // 전체 영역 박스 계산 (툴팁 위치 및 통합 마스킹용)
            if (!combinedRect) {
                combinedRect = { 
                    top: rect.top, left: rect.left, 
                    right: rect.right, bottom: rect.bottom,
                    width: rect.width, height: rect.height
                };
            } else {
                combinedRect.top = Math.min(combinedRect.top, rect.top);
                combinedRect.left = Math.min(combinedRect.left, rect.left);
                combinedRect.right = Math.max(combinedRect.right, rect.right);
                combinedRect.bottom = Math.max(combinedRect.bottom, rect.bottom);
                combinedRect.width = combinedRect.right - combinedRect.left;
                combinedRect.height = combinedRect.bottom - combinedRect.top;
            }

            // 개별 구멍 생성 (mergeMask가 아닐 때만)
            if (!step.mergeMask) {
                const hole = document.createElementNS(svgNS, 'rect');
                hole.setAttribute('x', rect.left + scrollLeft - padding);
                hole.setAttribute('y', rect.top + scrollTop - padding);
                hole.setAttribute('width', rect.width + padding * 2);
                hole.setAttribute('height', rect.height + padding * 2);
                hole.setAttribute('rx', '8');
                hole.setAttribute('fill', 'black');
                holesContainer.appendChild(hole);
            }
        });

        // 수동 모의 드롭다운 처리
        const mockDd = document.querySelector('.onboarding-mock-dropdown.active');
        if (mockDd) {
            const ddRect = mockDd.getBoundingClientRect();
            
            // 드롭다운 전용 구멍 생성 (mergeMask가 아닐 때만)
            if (!step.mergeMask) {
                const hole = document.createElementNS(svgNS, 'rect');
                hole.setAttribute('x', ddRect.left + scrollLeft - padding);
                hole.setAttribute('y', ddRect.top + scrollTop - padding);
                hole.setAttribute('width', ddRect.width + padding * 2);
                hole.setAttribute('height', ddRect.height + padding * 2);
                hole.setAttribute('rx', '8');
                hole.setAttribute('fill', 'black');
                holesContainer.appendChild(hole);
            }
            
            if (combinedRect) {
                combinedRect.left = Math.min(combinedRect.left, ddRect.left);
                combinedRect.right = Math.max(combinedRect.right, ddRect.right);
                combinedRect.bottom = Math.max(combinedRect.bottom, ddRect.bottom);
                combinedRect.width = combinedRect.right - combinedRect.left;
                combinedRect.height = combinedRect.bottom - combinedRect.top;
            }
        }

        // [통합 마스킹] mergeMask가 활성화된 경우 전체를 아우르는 구멍 하나를 생성
        if (step.mergeMask && combinedRect) {
            const hole = document.createElementNS(svgNS, 'rect');
            hole.setAttribute('x', combinedRect.left + scrollLeft - padding);
            hole.setAttribute('y', combinedRect.top + scrollTop - padding);
            hole.setAttribute('width', combinedRect.width + padding * 2);
            hole.setAttribute('height', combinedRect.height + padding * 2);
            hole.setAttribute('rx', '8');
            hole.setAttribute('fill', 'black');
            holesContainer.appendChild(hole);
        }

        if (!combinedRect) {
            // 타겟 요소를 찾지 못하면 하이라이트 구멍을 지우고 툴팁을 숨깁니다.
            holesContainer.innerHTML = '';
            if (tooltip) tooltip.style.opacity = '0';
            return;
        }

        if (tooltip) tooltip.style.opacity = '1';

        // SVG 전체 크기를 문서 크기로 설정
        const docW = Math.max(document.documentElement.scrollWidth, window.innerWidth);
        const docH = Math.max(document.documentElement.scrollHeight, window.innerHeight);
        overlay.setAttribute('width', docW);
        overlay.setAttribute('height', docH);
        overlay.style.width = docW + 'px';
        overlay.style.height = docH + 'px';

        // 툴팁 위치 계산 (확장된 rect 기준)
        positionTooltip(combinedRect, scrollTop, scrollLeft, getPosition(step));
    }

    function positionTooltip(rect, scrollTop, scrollLeft, position) {
        const gap = 16;
        const tooltipWidth = tooltip.offsetWidth;
        const tooltipHeight = tooltip.offsetHeight;
        const viewportW = window.innerWidth;
        const viewportH = window.innerHeight;

        let top, left;
        const combinedWidth = rect.right - rect.left;
        const combinedHeight = rect.bottom - rect.top;

        // 지정된 위치가 없거나 하단 공간이 넉넉하면 기본 'bottom'
        let finalPos = position || 'bottom';
        if (finalPos === 'bottom' && rect.bottom + 100 > viewportH) {
            if (rect.top > 150) finalPos = 'top';
        }

        switch (finalPos) {
            case 'top':
                top = rect.top + scrollTop - tooltipHeight - gap;
                left = rect.left + scrollLeft + (combinedWidth / 2) - (tooltipWidth / 2);
                break;
            case 'bottom':
                top = rect.bottom + scrollTop + gap;
                left = rect.left + scrollLeft + (combinedWidth / 2) - (tooltipWidth / 2);
                break;
            case 'left':
                top = rect.top + scrollTop + (combinedHeight / 2) - (tooltipHeight / 2);
                left = rect.left + scrollLeft - tooltipWidth - gap;
                break;
            case 'right':
                top = rect.top + scrollTop + (combinedHeight / 2) - (tooltipHeight / 2);
                left = rect.right + scrollLeft + gap;
                break;
            default:
                top = rect.bottom + scrollTop + gap;
                left = rect.left + scrollLeft + (combinedWidth / 2) - (tooltipWidth / 2);
        }

        // 화면 밖 방지
        if (left < 10) left = 10;
        if (left + tooltipWidth > viewportW - 10) left = viewportW - tooltipWidth - 10;
        
        if (top < scrollTop + 10) {
            top = rect.bottom + scrollTop + gap;
        }

        tooltip.style.top = top + 'px';
        tooltip.style.left = left + 'px';

        // 스크롤 동심원 방지 및 가시성 확보
        const viewportMargin = 60;
        if (rect.top < viewportMargin || rect.bottom > viewportH - viewportMargin) {
            const targetScroll = rect.top + scrollTop - (viewportH / 4);
            window.scrollTo({ top: Math.max(0, targetScroll), behavior: 'smooth' });
        }
    }


    /* --- 단계 이동 --- */
    function showStep(index) {
        const prevStep = steps[currentStepIndex];
        if (prevStep && prevStep.onLeave && index !== currentStepIndex) {
            prevStep.onLeave();
        }

        currentStepIndex = index;
        const step = steps[currentStepIndex];
        if (!step) return;

        createOverlay();
        
        // 텍스트 및 정보는 함수형도 지원하도록 처리
        tooltip.querySelector('.onboarding-tooltip-title').textContent = step.title;
        tooltip.querySelector('.onboarding-tooltip-content').textContent = typeof step.content === 'function' ? step.content() : step.content;

        // 동적 스텝 카운터 (스킵된 단계 제외)
        const visibleSteps = steps.filter(s => !(s.skipCondition && s.skipCondition()));
        const currentIndexInVisible = visibleSteps.indexOf(step);
        tooltip.querySelector('.onboarding-step-counter').textContent = `${currentIndexInVisible !== -1 ? currentIndexInVisible + 1 : 1} / ${visibleSteps.length}`;

        const prevBtn = tooltip.querySelector('.onboarding-btn-prev');
        const nextBtn = tooltip.querySelector('.onboarding-btn-next');
        
        const prevIndex = getValidStepIndex(currentStepIndex - 1, -1);
        const nextIndex = getValidStepIndex(currentStepIndex + 1, 1);
        
        prevBtn.disabled = prevIndex === -1;
        nextBtn.textContent = nextIndex === -1 ? '완료' : '다음';
        
        // 단계 진입 콜백 실행 (모드 전환 등)
        if (step.onEnter) {
            step.onEnter();
        }

        // 돔 레이아웃 확정 및 애니메이션 대기를 위해 반응형으로 갱신
        requestAnimationFrame(() => {
            updateOverlayHighlight();
            
            // 모드 전환 애니메이션 등으로 인한 레이아웃 지연에 대응 (점진적 보정)
            // 지연이 발생하는 50ms, 150ms, 350ms, 500ms, 700ms 시점에 맞춰 하이라이트를 재정렬합니다.
            const syncDelays = [50, 150, 350, 500, 700];
            syncDelays.forEach(ms => {
                setTimeout(() => { if (isActive) updateOverlayHighlight(); }, ms);
            });

            // 가시성 처리
            tooltip.classList.remove('visible');
            void tooltip.offsetHeight;
            tooltip.classList.add('visible');
        });
    }

    function getValidStepIndex(startIndex, direction) {
        let index = startIndex;
        while (index >= 0 && index < steps.length) {
            if (!steps[index].skipCondition || !steps[index].skipCondition()) {
                return index;
            }
            index += direction;
        }
        return -1;
    }

    function next() {
        if (!steps) return;
        const nextIndex = getValidStepIndex(currentStepIndex + 1, 1);
        if (nextIndex !== -1) {
            showStep(nextIndex);
        } else {
            stop(true);
        }
    }

    function prev() {
        if (!steps) return;
        const prevIndex = getValidStepIndex(currentStepIndex - 1, -1);
        if (prevIndex !== -1) {
            showStep(prevIndex);
        }
    }

    /* --- 시작 / 중지 --- */
    function start(page, force = false) {
        // 로그인 상태인 경우에만 온보딩 진행
        const isLoggedIn = (typeof currentUser !== 'undefined' && currentUser !== null) || 
                           (typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser !== null);
        if (!isLoggedIn) return;

        if (isActive) stop(); 

        if (!force && isPageDone(page)) return;
        if (!ONBOARDING_STEPS[page] || ONBOARDING_STEPS[page].length === 0) return;

        currentPage = page;
        steps = ONBOARDING_STEPS[page];
        currentStepIndex = 0;
        isActive = true;

        createOverlay();
        document.body.classList.add('onboarding-active');

        // 초기 단계 탐색 및 표시
        const initialIndex = getValidStepIndex(0, 1);
        if (initialIndex !== -1) {
            showStep(initialIndex);
        } else {
            stop();
            return;
        }

        resizeHandler = () => { if (isActive) updateOverlayHighlight(); };
        window.addEventListener('resize', resizeHandler);
        window.addEventListener('scroll', resizeHandler, true);
    }

    function stop(completed = false) {
        if (!isActive) return;

        const lastStep = steps[currentStepIndex];
        if (lastStep && lastStep.onLeave) {
            lastStep.onLeave();
        }

        isActive = false;

        // 등록 온보딩 모의 행 데이터 완전 청소
        if (typeof initPageAdd === 'function') {
            initPageAdd();
        }

        // 모든 모의 드롭다운 강제 제거
        const mockDds = document.querySelectorAll('.onboarding-mock-dropdown');
        mockDds.forEach(dd => dd.remove());

        if (completed) {
            markPageDone(currentPage);
        }

        document.body.classList.remove('onboarding-active');
        destroyOverlay();

        if (resizeHandler) {
            window.removeEventListener('resize', resizeHandler);
            window.removeEventListener('scroll', resizeHandler, true);
            resizeHandler = null;
        }

        currentPage = null;
        steps = [];
        currentStepIndex = 0;
    }

    /* --- Public API --- */
    return {
        start,
        stop,
        resetAllPages,
        isPageDone,
        updateHighlight: updateOverlayHighlight,
        isActive: () => isActive
    };
})();
