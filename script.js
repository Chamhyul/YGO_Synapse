const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwjQsBUkgocGqttOrK-37HVETri_NpSc53vD4C9uciTbhSdXBXmRFRAW1tQn0AjQ-DUPw/exec";
const STORAGE_KEY = 'yugioh_spreadsheet_id';
const RECENT_KEY = 'recent_card_searches';
const THEME_KEY = 'yugioh_theme_mode';
const REGION_KEY = 'yugioh_region_setting';

let allProcessingTypes = [];
let allNames = [];
let allLocations = [];
let localCardDatabase = [];
let clientCache = {};
let nameDb = {};

let rarityMappingRaw = []; 
let rarityColMap = {}; 
let rarityRows = []; 
let rarityReverseMap = {}; 
let rarityOrderMap = {}; 

let cidLookup = {}; 
let isAppConfigured = false;
let acInstance = null;
let isLoading = false;
let validationTimeout = null;
let hasRegisteredInSession = false;
let isContinuingRegistration = false;
let pendingBlurFn = null; 
let ownedCardNumbers = []; 
let nameToNosMap = {}; 
let currentSheetName = ""; 

let currentRegion = 'ko';
let currentMode = 'home'; 

let isAutoCopyEnabled = false;
let rowAddCount = 1; 

let rowMoveCount = 1;
let rowDiscardCount = 1;

let currentFocus = -1;

let activeDropdownInput = null;
let currentToastInstance = null;
let currentToastMessage = null;

let syncCounter = 0;

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
    updates.forEach(item => {
        const idx = localCardDatabase.findIndex(row =>
            String(row[1]).toUpperCase() === String(item.cardNo).toUpperCase() &&
            String(row[2]) === String(item.proc) &&
            String(row[4]) === String(item.loc) &&
            String(row[5]) === String(item.another)
        );

        if (item.isDeleted) {
            if (idx > -1) localCardDatabase.splice(idx, 1);
        } else {
            if (idx > -1) {
                localCardDatabase[idx][3] = item.qty; 
            } else {
                localCardDatabase.push([item.name, item.cardNo, item.proc, item.qty, item.loc, item.another]);
            }
        }
        
        if (item.name && !allNames.includes(item.name)) {
            allNames.push(item.name);
            allNames.sort();
        }
    });
    refreshLocalLookups(); 
}

function refreshLocalLookups() {
    const distinctNos = new Set(localCardDatabase.map(r => String(r[1]).trim().toUpperCase())); 
    ownedCardNumbers = Array.from(distinctNos).sort();
    
    nameToNosMap = {}; 
    localCardDatabase.forEach(r => { 
        const name = String(r[0]).trim(); 
        const no = String(r[1]).trim().toUpperCase(); 
        if(!nameToNosMap[name]) nameToNosMap[name] = new Set(); 
        nameToNosMap[name].add(no); 
    }); 
    for(let key in nameToNosMap) { nameToNosMap[key] = Array.from(nameToNosMap[key]).sort(); }
    
    const locSet = new Set(localCardDatabase.map(r => String(r[4])).filter(l => l));
    allLocations = Array.from(locSet).sort();
    
    const datalist = document.getElementById('loc-datalist'); 
    if(datalist) datalist.innerHTML = allLocations.map(l => `<option value="${l}">`).join('');
    
    if (currentMode === 'search') {
        const searchInput = document.getElementById('card-search');
        if (searchInput && searchInput.value) {
            startSearch();
        }
    }
}

function getLocalizedRarity(key) {
    var idx = rarityReverseMap[key];
    if (idx === undefined) {
        return key; 
    }

    var row = rarityRows[idx];
    if (!row) return key;

    var colIdx = rarityColMap[currentRegion];
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

document.addEventListener('DOMContentLoaded', function() {
  loadTheme();
  loadRegion();
  checkClearBtn(); 
  updateActiveNav('home');
  initPageAdd();

  const modals = document.querySelectorAll('.modal');
  modals.forEach(modal => {
      let options = {
          onCloseEnd: function(el) { 
              if(el.id === 'add-card-modal') {
                  if(!el.dataset.keepData) resetAddModal();
                  else delete el.dataset.keepData; 
              }
              if(el.id === 'add-result-modal') {
                 handleContinueRegistration();
              }
              if(el.id === 'discard-result-modal') {
                 handleContinueDiscard();
              }
          } 
      };
      if (modal.id === 'add-result-modal' || modal.id === 'move-result-modal' || modal.id === 'discard-result-modal') {
          options.dismissible = false; 
      }
      M.Modal.init(modal, options);
  });

  M.Tooltip.init(document.querySelectorAll('.tooltipped'));
  
  const searchInput = document.getElementById('card-search');
  const handleFocusOrClick = () => {
      if (!localStorage.getItem(STORAGE_KEY)) {
          searchInput.blur();
          switchToMode('settings'); 
          showToast('구글 시트 연결이 필요합니다.', 'warning-yellow black-text');
          toggleGuide(true);
          return;
      }
      const val = searchInput.value.trim();
      if (!val) { showRecentInDropdown(); } else { filterAndShowDropdown(searchInput.value); }
  };
  searchInput.addEventListener('click', handleFocusOrClick);
  searchInput.addEventListener('focus', handleFocusOrClick);
  searchInput.addEventListener('input', (e) => {
      const val = e.target.value;
      if (!val) { showRecentInDropdown(); }
      else filterAndShowDropdown(val);
      checkClearBtn(); 
  });
  
  const dropdown = document.getElementById('custom-dropdown');
  dropdown.addEventListener('mousedown', function(e) {
      e.preventDefault(); 
      const target = e.target;
      if (target.classList.contains('clear-all-btn')) {
          localStorage.removeItem(RECENT_KEY);
          showRecentInDropdown();
          return;
      }
      if (target.classList.contains('item-delete-btn') || target.closest('.item-delete-btn')) {
          const delBtn = target.classList.contains('item-delete-btn') ? target : target.closest('.item-delete-btn');
          const li = delBtn.closest('li');
          if (li && li.dataset.val) deleteRecentItem(li.dataset.val);
          return;
      }
      const li = target.closest('li');
      if (li && !li.classList.contains('recent-header-item') && !li.classList.contains('no-result-item')) {
          const val = li.dataset.val;
          if (val) {
              document.getElementById('card-search').value = val;
              checkClearBtn();
              startSearch();
          }
      }
  });

  searchInput.addEventListener('keydown', function(e) { 
      let list = document.getElementById('custom-dropdown');
      if (list.style.display === 'none') return;
      let items = list.querySelectorAll('li:not(.recent-header-item):not(.no-result-item)');
      if (e.keyCode == 40) { 
          currentFocus++;
          addActive(items);
      } else if (e.keyCode == 38) { 
          currentFocus--;
          addActive(items);
      } else if (e.keyCode == 13) { 
          e.preventDefault();
          let targetVal = this.value; 
          if (list.style.display !== 'none' && items.length > 0) {
              let activeIndex = currentFocus > -1 ? currentFocus : 0; 
              if (items[activeIndex]) targetVal = items[activeIndex].dataset.val;
          }
          if (targetVal) this.value = targetVal;
          this.blur();
          startSearch();
      }
  });

  function addActive(items) {
      if (!items) return false;
      removeActive(items);
      if (currentFocus >= items.length) currentFocus = 0;
      if (currentFocus < 0) currentFocus = items.length - 1;
      items[currentFocus].classList.add("selected"); 
      items[currentFocus].scrollIntoView({ block: 'nearest', inline: 'start' });
  }

  function removeActive(items) {
      for (let i = 0; i < items.length; i++) items[i].classList.remove("selected"); 
  }
  
  searchInput.addEventListener('blur', () => {
      setTimeout(() => {
          document.getElementById('custom-dropdown').style.display = 'none';
          toggleSearchWrapper(false); 
      }, 200);
  });

  document.getElementById('clear-btn').addEventListener('click', function() { 
      searchInput.value = ''; 
      this.style.display = 'none'; 
      searchInput.focus(); 
      showRecentInDropdown();
  });
  
  document.addEventListener('click', function(e) {
      const regionContainer = document.querySelector('.region-container');
      if (regionContainer && !regionContainer.contains(e.target)) {
          document.getElementById('region-dropdown').style.display = 'none';
          document.getElementById('region-capsule').classList.remove('active');
      }

      // [신규] 팩 추가 팝업 외부 클릭 감지
      const packAddContainer = document.getElementById('pack-add-container');
      if (packAddContainer && !packAddContainer.contains(e.target)) {
          togglePackAddPopup(e, false);
      }
  });
  
  document.addEventListener('scroll', function(e) {
      if(e.target.classList && e.target.classList.contains('custom-options')) return;
      if(activeDropdownInput) {
          const wrapper = activeDropdownInput.closest('.custom-select-wrapper');
          if (wrapper && wrapper.classList.contains('active')) {
              const globalDropdown = document.getElementById('global-custom-options');
              const rect = wrapper.getBoundingClientRect();
              globalDropdown.style.top = (rect.bottom + window.scrollY) + 'px';
              globalDropdown.style.left = (rect.left + window.scrollX) + 'px';
              globalDropdown.style.width = rect.width + 'px';
          }
      }
  }, true); 

  updateDisconnectBtn(); 
  refreshInitialData();

  // [신규] 캡슐형 자동 입력란 드롭다운 핸들러 설정
  const autoLocWrap = document.getElementById('wrap-auto-loc');
  if(autoLocWrap) {
      setupCustomDropdown(autoLocWrap, (input) => handleAutoLocInput(input));
  }
});

function updateActiveNav(mode) {
    document.querySelectorAll('.nav-item, .mobile-nav-item').forEach(el => el.classList.remove('active'));
    const targets = document.querySelectorAll(`[data-mode="${mode}"]`);
    targets.forEach(el => el.classList.add('active'));
}

function updateMetaThemeColor(mode) {
    const meta = document.getElementById('meta-theme-color');
    if (meta) {
      if (mode === 'light') { meta.setAttribute('content', '#F0F0F0'); } else { meta.setAttribute('content', '#000000'); }
    }
}

function toggleBackgroundInert(isActive) {
    const targets = [ document.getElementById('dynamic-header-wrapper'), document.querySelector('.app-sidebar'), document.querySelector('.mobile-nav-container'), document.querySelector('.container') ];
    targets.forEach(el => { if(el) { if(isActive) el.setAttribute('inert', ''); else el.removeAttribute('inert'); } });
}

let transitionTimer = null;
function switchToMode(mode) {
    if (currentToastInstance && currentToastMessage !== '구글 시트 연결이 필요합니다.') {
        currentToastInstance.dismiss();
        currentToastInstance = null;
        currentToastMessage = null;
    }

    if (['add', 'move', 'discard'].includes(mode) && !localStorage.getItem(STORAGE_KEY)) {
          showToast('구글 시트 연결이 필요합니다.', 'warning-yellow black-text');
          switchToMode('settings'); 
          toggleGuide(true); 
          return;
    }
    if (currentMode === mode) return; 
    const previousMode = currentMode;
    currentMode = mode;
    updateActiveNav(mode);
    const body = document.body;
    const searchInput = document.getElementById('card-search');
    if (document.activeElement) { document.activeElement.blur(); }
    
    if (mode === 'home') {
        searchInput.value = ''; document.getElementById('clear-btn').style.display = 'none';
        document.getElementById('custom-dropdown').style.display = 'none'; toggleSearchWrapper(false); searchInput.placeholder = ""; 
    } else if (mode === 'search') { searchInput.placeholder = ""; } 
    else {
        searchInput.value = ''; document.getElementById('clear-btn').style.display = 'none';
        document.getElementById('custom-dropdown').style.display = 'none'; toggleSearchWrapper(false); searchInput.placeholder = "카드 검색"; 
    }
    
    if (mode === 'home') { body.classList.remove('mode-compact'); } else { body.classList.add('mode-compact'); }

    const wrapper = document.getElementById('content-slider-wrapper');
    if (transitionTimer) {
        clearTimeout(transitionTimer); transitionTimer = null;
        wrapper.style.height = wrapper.offsetHeight + 'px';
        const sections = wrapper.querySelectorAll('.content-section');
        sections.forEach(sec => { sec.style.display = 'none'; sec.style.opacity = '0'; sec.style.position = ''; sec.style.width = ''; sec.style.top = ''; sec.style.left = ''; sec.classList.remove('active'); });
        const ghost = document.getElementById('result-ghost'); if(ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost);
    }

    let targetContentId = '';
    if (mode === 'home') targetContentId = 'intro-area';
    else if (mode === 'search') targetContentId = 'result-content-wrapper'; 
    else if (mode === 'discard') { targetContentId = 'discard-content-area'; initPageDiscard(); }
    else if (mode === 'add') targetContentId = 'add-content-area';
    else if (mode === 'move') { targetContentId = 'move-content-area'; initPageMove(); }
    else if (mode === 'settings') targetContentId = 'settings-content-area'; 

    const currentEl = wrapper.querySelector('.content-section.active');
    const nextEl = document.getElementById(targetContentId);
    if (!wrapper.style.height) { wrapper.style.height = wrapper.offsetHeight + 'px'; }
    if(currentEl) { currentEl.style.position = 'absolute'; currentEl.style.top = '0'; currentEl.style.left = '0'; currentEl.style.width = '100%'; }

    nextEl.style.display = 'block'; nextEl.style.position = 'absolute'; nextEl.style.opacity = '0'; nextEl.style.top = '0'; nextEl.style.left = '0'; nextEl.style.width = '100%';
    const targetHeight = nextEl.scrollHeight;

    requestAnimationFrame(() => {
        wrapper.style.height = targetHeight + 'px'; 
        if(currentEl) currentEl.style.opacity = '0'; 
        nextEl.style.opacity = '1'; 
    });

    transitionTimer = setTimeout(() => {
        wrapper.style.height = ''; 
        if(currentEl) { currentEl.style.display = 'none'; currentEl.classList.remove('active'); currentEl.style.position = ''; currentEl.style.width = ''; }
        nextEl.classList.add('active'); nextEl.style.position = 'relative'; nextEl.style.opacity = ''; nextEl.style.width = ''; nextEl.style.top = ''; nextEl.style.left = '';
        const ghost = document.getElementById('result-ghost'); if(ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost);
        if ((mode === 'home' || mode === 'discard' || mode === 'add' || mode === 'move' || mode === 'settings') && previousMode === 'search') {
            document.getElementById('result-area').innerHTML = '';
        }
        transitionTimer = null;
    }, 400); 
}

function checkClearBtn() { const val = document.getElementById('card-search').value; const btn = document.getElementById('clear-btn'); if(btn) btn.style.display = val ? 'block' : 'none'; }
function toggleSearchWrapper(isOpen) { const wrapper = document.getElementById('search-wrapper'); if(wrapper) { if(isOpen) wrapper.classList.add('active'); else wrapper.classList.remove('active'); } }
function toggleAutoCopy() { isAutoCopyEnabled = document.getElementById('auto-copy-switch') ? document.getElementById('auto-copy-switch').checked : false; }

function initPageAdd() {
    const tbody = document.getElementById('page-add-tbody');
    if(tbody) {
      tbody.innerHTML = '';
      addPageEntry();
    }
}

function adjustAddCount(delta) {
    rowAddCount += delta;
    if(rowAddCount < 1) rowAddCount = 1;
    document.getElementById('add-row-count').innerText = rowAddCount + "장";
}

function addMultipleRows(e) {
    let firstNewRow = null;
    for(let i=0; i<rowAddCount; i++) {
        const row = addPageEntry();
        if(i === 0) firstNewRow = row;
    }
    if(firstNewRow && e && e.detail === 0) {
        const input = firstNewRow.querySelector('.page-card-no');
        if(input) input.focus();
    }
}

function addMultipleMoveRows(e) {
    let firstNewRow = null;
    for(let i=0; i<rowMoveCount; i++) {
        const row = addMoveEntry();
        if(i === 0) firstNewRow = row;
    }
    if(firstNewRow && e && e.detail === 0) {
        const input = firstNewRow.querySelector('.card-name-input');
        if(input) input.focus();
    }
}

function initPageDiscard() {
    const tbody = document.getElementById('page-discard-tbody');
    if(tbody && tbody.children.length === 0) {
        addDiscardEntry();
    }
}

function adjustDiscardCount(delta) {
    rowDiscardCount += delta;
    if(rowDiscardCount < 1) rowDiscardCount = 1;
    document.getElementById('add-discard-count').innerText = rowDiscardCount + "장";
}

function addMultipleDiscardRows(e) {
    let firstNewRow = null;
    for(let i=0; i<rowDiscardCount; i++) {
        const row = addDiscardEntry();
        if(i === 0) firstNewRow = row;
    }
    if(firstNewRow && e && e.detail === 0) {
        const input = firstNewRow.querySelector('.card-name-input');
        if(input) input.focus();
    }
}

function handleAddButtonKey(e, type) {
    if (e.key === 'ArrowUp') {
        e.preventDefault();
        if(type === 'add') adjustAddCount(1);
        else if(type === 'move') adjustMoveCount(1);
        else if(type === 'discard') adjustDiscardCount(1);
    } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if(type === 'add') adjustAddCount(-1);
        else if(type === 'move') adjustMoveCount(-1);
        else if(type === 'discard') adjustDiscardCount(-1);
    }
}

function addPageEntry(initialData = null, insertAfterRow = null) {
    const tbody = document.getElementById('page-add-tbody');
    const currentCount = tbody.querySelectorAll('tr').length;
    const nextNum = currentCount + 1;
    const isOdd = nextNum % 2 !== 0;
    const groupClass = isOdd ? 'odd' : 'even';

    const tr = document.createElement('tr');
    tr.className = `entry-row entry-group ${groupClass}`;
    
    tr.innerHTML = `
        <td class="no-cell">${nextNum}</td>
        <td class="content-cell">
            <div class="content-wrapper">
                <div class="tri-row-top">
                    <div class="name-area"><div class="card-name-disp">카드 번호 입력</div></div>
                    <div class="no-area"><input type="text" class="page-card-no" oninput="handleCardNoInput(this)" onblur="fetchCardNameForPage(this)" onkeydown="if(event.key==='Enter') fetchCardNameForPage(this)" placeholder="카드 번호"></div>
                </div>
                <div class="tri-row-mid">
                    <div class="input-wrap w-half">
                        <div class="custom-select-wrapper no-option" id="wrap-add-illust-${nextNum}" data-type="strict">
                          <input type="text" class="custom-input page-card-another" placeholder="일러스트" readonly>
                          <i class="material-icons arrow-icon">arrow_drop_down</i>
                        </div>
                    </div>
                    <div class="input-wrap w-half">
                        <div class="custom-select-wrapper no-option" id="wrap-add-rare-${nextNum}" data-type="strict">
                          <input type="text" class="custom-input page-card-proc" placeholder="레어도" readonly>
                          <i class="material-icons arrow-icon">arrow_drop_down</i>
                        </div>
                    </div>
                </div>
                <div class="tri-row-bot">
                    <div class="input-wrap w-half">
                        <div class="custom-select-wrapper no-option" id="wrap-add-loc-${nextNum}" data-type="free">
                          <input type="text" class="custom-input page-card-loc" placeholder="보관위치" readonly>
                          <i class="material-icons arrow-icon">arrow_drop_down</i>
                        </div>
                    </div>
                    <div class="input-wrap w-half"><input type="number" class="page-card-qty" min="1" readonly placeholder="수량"></div>
                </div>
            </div>
        </td>
        <td class="col-delete">
            <div class="row-action-wrapper">
                <i class="material-icons action-btn copy-btn" onclick="copyPageEntry(this)" tabindex="0">content_copy</i>
                <i class="material-icons action-btn delete-btn" onclick="deletePageEntry(this)" tabindex="0">delete</i>
            </div>
        </td>
    `;

    if (insertAfterRow && insertAfterRow.nextSibling) {
        tbody.insertBefore(tr, insertAfterRow.nextSibling);
    } else {
        tbody.appendChild(tr);
    }

    reindexRows();
    setupCustomDropdown(tr.querySelector(`#wrap-add-illust-${nextNum}`), null);
    setupCustomDropdown(tr.querySelector(`#wrap-add-rare-${nextNum}`), null);
    setupCustomDropdown(tr.querySelector(`#wrap-add-loc-${nextNum}`), handleAddLocChange);

    const locWrap = tr.querySelector(`#wrap-add-loc-${nextNum}`);
    if(locWrap && typeof allLocations !== 'undefined') {
        locWrap.dataset.options = JSON.stringify(allLocations.map(l => ({ val: l, text: l })));
        if (allLocations.length > 0) locWrap.classList.remove('no-option'); 
    }

    const autoLocValue = document.getElementById('auto-location-input').value.trim();
    if (autoLocValue) {
        const locInp = tr.querySelector('.page-card-loc');
        locInp.value = autoLocValue;
        locInp.removeAttribute('readonly');
        const qtyInp = tr.querySelector('.page-card-qty');
        qtyInp.removeAttribute('readonly');
        if (!qtyInp.value) qtyInp.value = "1";
    }

    if (initialData) {
        const noInp = tr.querySelector('.page-card-no');
        noInp.value = initialData.cardNo || "";
        if (initialData.qty) tr.querySelector('.page-card-qty').value = initialData.qty;
        if (initialData.loc) tr.querySelector('.page-card-loc').value = initialData.loc;
        
        if (initialData.cardNo) {
            fetchCardNameForPage(noInp).then(() => {
                if (initialData.another) tr.querySelector('.page-card-another').value = initialData.another;
                if (initialData.proc) {
                    const procInp = tr.querySelector('.page-card-proc');
                    procInp.value = getLocalizedRarity(initialData.proc);
                    procInp.dataset.raw = initialData.proc;
                }
            });
        }
    }

    return tr;
}

function copyPageEntry(btn) {
    const sourceRow = btn.closest('tr');
    const procInp = sourceRow.querySelector('.page-card-proc');
    const data = {
        cardNo: sourceRow.querySelector('.page-card-no').value,
        another: sourceRow.querySelector('.page-card-another').value,
        proc: procInp.dataset.raw || procInp.value,
        loc: sourceRow.querySelector('.page-card-loc').value,
        qty: sourceRow.querySelector('.page-card-qty').value
    };
    
    const newRow = addPageEntry(data, sourceRow);
    const focusInp = newRow.querySelector('.page-card-no');
    if (focusInp) focusInp.focus();
}

function togglePackAddPopup(e, force) {
    if (e) e.stopPropagation();
    const popup = document.getElementById('pack-add-popup');
    const isVisible = popup.classList.contains('active');
    const targetState = (force !== undefined) ? force : !isVisible;
    
    if (targetState) {
        popup.classList.add('active');
        document.getElementById('pack-start-no').focus();
    } else {
        popup.classList.remove('active');
        document.getElementById('pack-start-no').value = "";
        document.getElementById('pack-end-no').value = "";
        validatePackInputs();
    }
}

function validatePackInputs() {
    const startVal = document.getElementById('pack-start-no').value.trim().toUpperCase();
    const endVal = document.getElementById('pack-end-no').value.trim().toUpperCase();
    const submitBtn = document.getElementById('pack-submit-btn');
    
    const splitRegex = /^(.*?)(\d+)$/;
    const startMatch = startVal.match(splitRegex);
    const endMatch = endVal.match(splitRegex);
    
    let isValid = false;
    if (startMatch && endMatch && startMatch[1] === endMatch[1]) {
        const startNum = parseInt(startMatch[2]);
        const endNum = parseInt(endMatch[2]);
        if (endNum >= startNum) isValid = true;
    }
    
    if (isValid) {
        submitBtn.classList.remove('disabled');
        const inst = M.Tooltip.getInstance(submitBtn);
        if(inst) inst.destroy();
    } else {
        submitBtn.classList.add('disabled');
        if (!M.Tooltip.getInstance(submitBtn)) {
            M.Tooltip.init(submitBtn);
        }
    }
}

function generatePackRows() {
    const startVal = document.getElementById('pack-start-no').value.trim().toUpperCase();
    const endVal = document.getElementById('pack-end-no').value.trim().toUpperCase();
    
    const splitRegex = /^(.*?)(\d+)$/;
    const startMatch = startVal.match(splitRegex);
    const prefix = startMatch[1];
    const startNum = parseInt(startMatch[2]);
    const endNum = parseInt(endVal.match(splitRegex)[2]);
    const padLen = startMatch[2].length;
    
    togglePackAddPopup(null, false);
    showLoading(true, "등록표 생성 중...");
    
    setTimeout(() => {
        for (let i = startNum; i <= endNum; i++) {
            const cardNo = prefix + String(i).padStart(padLen, '0');
            addPageEntry({ cardNo: cardNo, qty: 1 });
        }
        showLoading(false);
        showToast(`${endNum - startNum + 1}개의 행이 생성되었습니다.`, 'cyan-theme');
    }, 100);
}

function handleAutoLocInput(input) {
    const wrapper = input.closest('.custom-select-wrapper');
    if (input.value.trim().length > 0) {
        wrapper.classList.add('active-highlight');
    } else {
        wrapper.classList.remove('active-highlight');
    }
}

function addDiscardEntry() {
    const tbody = document.getElementById('page-discard-tbody');
    const currentCount = tbody.querySelectorAll('tr').length;
    const nextNum = currentCount + 1;
    const isOdd = nextNum % 2 !== 0;
    const groupClass = isOdd ? 'odd' : 'even';

    const tr = document.createElement('tr');
    tr.className = `entry-row entry-group ${groupClass}`;
    
    tr.innerHTML = `
        <td class="no-cell">${nextNum}</td>
        <td class="content-cell">
            <div class="content-wrapper">
                <div class="tri-row-top">
                    <div class="name-area">
                      <div class="custom-select-wrapper no-arrow" id="wrap-discard-name-${nextNum}">
                          <input type="text" class="custom-input card-name-input" placeholder="카드 이름" oninput="handleDiscardNameInput(this)" autocomplete="off">
                          <i class="material-icons arrow-icon">arrow_drop_down</i>
                      </div>
                    </div>
                    <div class="no-area">
                      <div class="custom-select-wrapper no-arrow" id="wrap-discard-no-${nextNum}">
                          <input type="text" class="custom-input discard-card-no" oninput="handleDiscardNoInput(this)" onblur="validateDiscardNoInput(this)" onkeydown="if(event.key==='Enter') validateDiscardNoInput(this)" placeholder="카드 번호" autocomplete="off">
                          <i class="material-icons arrow-icon">arrow_drop_down</i>
                      </div>
                    </div>
                </div>
                <div class="tri-row-mid">
                    <div class="input-wrap w-half">
                        <div class="custom-select-wrapper no-option" id="wrap-discard-illust-${nextNum}" data-type="strict">
                          <input type="text" class="custom-input discard-card-another" placeholder="일러스트" readonly>
                          <i class="material-icons arrow-icon">arrow_drop_down</i>
                        </div>
                    </div>
                    <div class="input-wrap w-half">
                        <div class="custom-select-wrapper no-option" id="wrap-discard-rare-${nextNum}" data-type="strict">
                          <input type="text" class="custom-input discard-card-proc" placeholder="레어도" readonly>
                          <i class="material-icons arrow-icon">arrow_drop_down</i>
                        </div>
                    </div>
                </div>
                <div class="tri-row-bot">
                    <div class="input-wrap w-half">
                        <div class="custom-select-wrapper no-option" id="wrap-discard-loc-${nextNum}" data-type="strict">
                          <input type="text" class="custom-input discard-card-loc" placeholder="보관위치">
                          <i class="material-icons arrow-icon">arrow_drop_down</i>
                        </div>
                    </div>
                    <div class="input-wrap w-half"><input type="number" class="discard-card-qty" min="1" placeholder="수량"></div>
                </div>
            </div>
        </td>
        <td class="col-delete" tabindex="0" onclick="deleteDiscardEntry(this)" onkeydown="if(event.key==='Enter') deleteDiscardEntry(this)"><i class="material-icons">delete</i></td>
    `;

    tbody.appendChild(tr);
    reindexDiscardRows();
    setupCustomDropdown(tr.querySelector(`#wrap-discard-illust-${nextNum}`), handleDiscardIllustChange);
    setupCustomDropdown(tr.querySelector(`#wrap-discard-rare-${nextNum}`), handleDiscardRareChange);
    setupCustomDropdown(tr.querySelector(`#wrap-discard-loc-${nextNum}`), handleDiscardLocChange);
    setupCardNoAutocomplete(tr.querySelector(`#wrap-discard-no-${nextNum}`));
    setupCardNameAutocomplete(tr.querySelector(`#wrap-discard-name-${nextNum}`));
    
    const qtyInput = tr.querySelector('.discard-card-qty');
    qtyInput.addEventListener('input', function() {
        const locVal = tr.querySelector('.discard-card-loc').value;
        if(!locVal) { this.value = ""; return; }
        const max = parseInt(this.max);
        const current = parseInt(this.value);
        if(!isNaN(max) && current > max) { this.value = max; }
    });

    return tr;
}

function handleDiscardNameInput(input) {
    const row = input.closest('tr');
    const noInput = row.querySelector('.discard-card-no');
    const nameVal = input.value.trim();
    if (!input.dataset.programmatic) { noInput.dataset.programmatic = "true"; noInput.value = ""; handleDiscardNoInput(noInput); delete noInput.dataset.programmatic; }
    if (nameToNosMap[nameVal]) { const matchedNos = nameToNosMap[nameVal]; if (matchedNos.length === 1) { noInput.value = matchedNos[0]; noInput.dataset.programmatic = "true"; handleDiscardNoInput(noInput); validateDiscardNoInput(noInput); delete noInput.dataset.programmatic; } }
}

function validateDiscardNoInput(input) {
    const val = input.value.trim().toUpperCase();
    const row = input.closest('tr');
    const nameInput = row.querySelector('.card-name-input');
    if (!val) { resetDiscardRow(row, 'no'); return; }
    if (!ownedCardNumbers.includes(val)) { 
        input.value = ""; input.placeholder = "번호 확인!"; input.classList.add('error-placeholder'); 
        setTimeout(() => { input.placeholder = "카드 번호"; input.classList.remove('error-placeholder'); }, 5000); 
        resetDiscardRow(row, 'no'); 
    } else {
        if(isCardDepleted(val, row)) {
            input.value = ""; input.placeholder = "모두 선택됨"; input.classList.add('error-placeholder');
            setTimeout(() => { input.placeholder = "카드 번호"; input.classList.remove('error-placeholder'); }, 5000);
            resetDiscardRow(row, 'no');
            return;
        }
        const matches = localCardDatabase.filter(r => String(r[1]).trim().toUpperCase() === val); 
        if (matches.length > 0) { 
            const name = matches[0][0]; 
            nameInput.dataset.programmatic = "true"; 
            nameInput.value = name; 
            delete nameInput.dataset.programmatic; 
            updateDiscardIllusts(row, matches); 
        } 
    }
}

function handleDiscardNoInput(input) {
    const row = input.closest('tr'); const start = input.selectionStart; input.value = input.value.replace(/[ㄱ-ㅎ|ㅏ-ㅣ|가-힣]/g, '').toUpperCase(); input.setSelectionRange(start, start);
    if (!input.dataset.programmatic) { const nameInput = row.querySelector('.card-name-input'); nameInput.value = ""; }
    const cardNo = input.value.trim().toUpperCase();
    if (!cardNo) { resetDiscardRow(row, 'no'); return; }
    const matches = localCardDatabase.filter(r => String(r[1]).trim().toUpperCase() === cardNo);
    if (matches.length > 0) { updateDiscardIllusts(row, matches); } else { resetDiscardRow(row, 'no'); }
}

function resetDiscardRow(row, level) {
    const illustInp = row.querySelector('.discard-card-another'); const rareInp = row.querySelector('.discard-card-proc'); const locInp = row.querySelector('.discard-card-loc'); const qtyInput = row.querySelector('.discard-card-qty');
    const illustWrap = row.querySelector('[id^="wrap-discard-illust"]'); const rareWrap = row.querySelector('[id^="wrap-discard-rare"]'); const locWrap = row.querySelector('[id^="wrap-discard-loc"]');
    illustWrap.classList.remove('single-option'); rareWrap.classList.remove('single-option'); locWrap.classList.remove('single-option');
    illustWrap.classList.add('no-option'); rareWrap.classList.add('no-option'); locWrap.classList.add('no-option');
    if (level === 'no') { 
        illustInp.value = ""; illustInp.setAttribute('readonly', true); illustWrap.dataset.options = "[]"; 
        rareInp.value = ""; rareInp.setAttribute('readonly', true); rareWrap.dataset.options = "[]"; 
        locInp.value = ""; locWrap.dataset.options = "[]"; qtyInput.value = ''; 
    }
}

function updateDiscardIllusts(row, matches) {
    const illustInp = row.querySelector('.discard-card-another'); const illustWrap = row.querySelector('[id^="wrap-discard-illust"]');
    const cardNo = row.querySelector('.discard-card-no').value.trim();
    const uniqueIllusts = [...new Set(matches.map(r => String(r[5] || "기본").trim()))].sort();
    
    const validIllusts = uniqueIllusts.filter(illust => checkDiscardIllustAvailability(cardNo, illust, row));
    const options = validIllusts.map(i => ({ val: i, text: i }));
    illustWrap.dataset.options = JSON.stringify(options);
    illustInp.removeAttribute('readonly'); illustWrap.classList.remove('no-option'); 
    const currentVal = illustInp.value; const isValid = options.some(o => o.val === currentVal);
    if (isValid) { handleDiscardIllustChange(illustInp); } else { 
        if (options.length === 1) { illustWrap.classList.add('single-option'); illustInp.value = options[0].val; handleDiscardIllustChange(illustInp); } 
        else if(options.length === 0) { illustInp.value = ""; illustWrap.classList.add('no-option'); resetDiscardRow(row, 'no'); }
        else { illustInp.value = ""; illustWrap.classList.remove('single-option'); handleDiscardIllustChange(illustInp); } 
    }
}

function updateDiscardIllustsDynamic(wrap) {
    const row = wrap.closest('tr');
    const cardNo = row.querySelector('.discard-card-no').value.trim().toUpperCase();
    if(!cardNo) return;
    const matches = localCardDatabase.filter(r => String(r[1]).trim().toUpperCase() === cardNo);
    
    const uniqueIllusts = [...new Set(matches.map(r => String(r[5] || "기본").trim()))].sort();
    const validIllusts = uniqueIllusts.filter(illust => checkDiscardIllustAvailability(cardNo, illust, row));
    const options = validIllusts.map(i => ({ val: i, text: i }));
    wrap.dataset.options = JSON.stringify(options);
    
    if(options.length <= 1) wrap.classList.add('single-option');
    else wrap.classList.remove('single-option');
}

function handleDiscardIllustChange(input) {
    const row = input.closest('tr'); const cardNo = row.querySelector('.discard-card-no').value.trim(); const selectedIllust = input.value;
    if (!selectedIllust) { const rareInp = row.querySelector('.discard-card-proc'); rareInp.value = ""; handleDiscardRareChange(rareInp); return; }
    const dbIllust = selectedIllust;
    const matches = localCardDatabase.filter(r => String(r[1]).trim().toUpperCase() === cardNo && String(r[5] || "기본").trim() === dbIllust);
    updateDiscardRarities(row, matches);
}

function updateDiscardRarities(row, matches) {
    const rareInp = row.querySelector('.discard-card-proc'); const rareWrap = row.querySelector('[id^="wrap-discard-rare"]'); 
    const cardNo = row.querySelector('.discard-card-no').value.trim();
    const illust = row.querySelector('.discard-card-another').value.trim();
    
    const uniqueRares = [...new Set(matches.map(r => String(r[2]).trim()))].sort(compareRarity);
    const validRares = uniqueRares.filter(rare => checkDiscardRareAvailability(cardNo, illust, rare, row));

    const options = validRares.map(r => ({ val: r, text: getLocalizedRarity(r) }));
    rareWrap.dataset.options = JSON.stringify(options);
    rareInp.removeAttribute('readonly'); rareWrap.classList.remove('no-option'); 
    const currentVal = rareInp.value; 
    const currentRaw = rareInp.dataset.raw || currentVal;
    const isValid = options.some(o => o.val === currentRaw);
    
    if (isValid) { handleDiscardRareChange(rareInp); } else { 
        if (options.length === 1) { rareWrap.classList.add('single-option'); rareInp.value = options[0].text; rareInp.dataset.raw = options[0].val; handleDiscardRareChange(rareInp); } 
        else if(options.length === 0) { rareInp.value = ""; rareWrap.classList.add('no-option'); }
        else { rareInp.value = ""; delete rareInp.dataset.raw; rareWrap.classList.remove('single-option'); handleDiscardRareChange(rareInp); } 
    }
}

function updateDiscardRaritiesDynamic(wrap) {
    const row = wrap.closest('tr');
    const cardNo = row.querySelector('.discard-card-no').value.trim().toUpperCase();
    const illust = row.querySelector('.discard-card-another').value;
    if(!cardNo || !illust) return;
    
    const matches = localCardDatabase.filter(r => String(r[1]).trim().toUpperCase() === cardNo && String(r[5] || "기본").trim() === illust);
    const uniqueRares = [...new Set(matches.map(r => String(r[2]).trim()))].sort(compareRarity);
    const validRares = uniqueRares.filter(rare => checkDiscardRareAvailability(cardNo, illust, rare, row));
    const options = validRares.map(r => ({ val: r, text: getLocalizedRarity(r) }));
    
    wrap.dataset.options = JSON.stringify(options);
    if(options.length <= 1) wrap.classList.add('single-option');
    else wrap.classList.remove('single-option');
}

function handleDiscardRareChange(input) {
    const row = input.closest('tr'); const cardNo = row.querySelector('.discard-card-no').value.trim(); const selectedIllust = row.querySelector('.discard-card-another').value; const selectedRare = input.dataset.raw || input.value; 
    if (!input.value) { const locInp = row.querySelector('.discard-card-loc'); locInp.value = ""; handleDiscardLocChange(locInp); return; }
    const dbIllust = selectedIllust;
    const matches = localCardDatabase.filter(r => String(r[1]).trim().toUpperCase() === cardNo && String(r[5] || "기본").trim() === dbIllust && String(r[2]).trim() === selectedRare);
    updateDiscardLocations(row, matches);
}

function updateDiscardLocations(row, matches) {
    const locInp = row.querySelector('.discard-card-loc'); const locWrap = row.querySelector('[id^="wrap-discard-loc"]'); locInp.removeAttribute('readonly'); locWrap.classList.remove('no-option'); 
    const cardNo = row.querySelector('.discard-card-no').value.trim(); const illust = row.querySelector('.discard-card-another').value; 
    
    const rareInput = row.querySelector('.discard-card-proc');
    const rare = rareInput.dataset.raw || rareInput.value; 
    
    const locMap = {};
    matches.forEach(r => { const loc = String(r[4]).trim(); const qty = parseInt(r[3]) || 0; if (qty > 0) locMap[loc] = (locMap[loc] || 0) + qty; });
    
    const globalUsage = getGlobalUsageMap(row); 
    let usedLocs = new Set();
    if(globalUsage[cardNo] && globalUsage[cardNo][illust] && globalUsage[cardNo][illust][rare]) {
        usedLocs = globalUsage[cardNo][illust][rare];
    }

    const validLocs = []; 
    Object.keys(locMap).forEach(loc => { 
        if(!usedLocs.has(loc)) {
            validLocs.push({ val: loc, text: `${loc} (보유: ${locMap[loc]})`, max: locMap[loc] }); 
        }
    });
    validLocs.sort((a,b) => a.val.localeCompare(b.val));
    locWrap.dataset.options = JSON.stringify(validLocs);
    
    const currentVal = locInp.value; const validOption = validLocs.find(o => o.val === currentVal);
    if (validOption) { locInp.dataset.maxQty = validOption.max; handleDiscardLocChange(locInp); } else { 
        if (validLocs.length === 1) { locWrap.classList.add('single-option'); locInp.value = validLocs[0].val; locInp.dataset.maxQty = validLocs[0].max; handleDiscardLocChange(locInp); } 
        else { locInp.value = ""; locWrap.classList.remove('single-option'); handleDiscardLocChange(locInp); } 
    }
    if (validLocs.length === 0) locWrap.classList.add('no-option');
}

function updateDiscardLocationsDynamic(wrap) {
    const row = wrap.closest('tr');
    const cardNo = row.querySelector('.discard-card-no').value.trim();
    const illust = row.querySelector('.discard-card-another').value;
    const rareInput = row.querySelector('.discard-card-proc');
    const rare = rareInput.dataset.raw || rareInput.value;
    if(!cardNo || !illust || !rare) return;
    
    const matches = localCardDatabase.filter(r => String(r[1]).trim().toUpperCase() === cardNo && String(r[5] || "기본").trim() === illust && String(r[2]).trim() === rare);
    
    const locMap = {};
    matches.forEach(r => { const loc = String(r[4]).trim(); const qty = parseInt(r[3]) || 0; if (qty > 0) locMap[loc] = (locMap[loc] || 0) + qty; });
    
    const globalUsage = getGlobalUsageMap(row);
    let usedLocs = new Set();
    if(globalUsage[cardNo] && globalUsage[cardNo][illust] && globalUsage[cardNo][illust][rare]) {
        usedLocs = globalUsage[cardNo][illust][rare];
    }
    
    const validLocs = [];
    Object.keys(locMap).forEach(loc => {
        if(!usedLocs.has(loc)) {
            validLocs.push({ val: loc, text: `${loc} (보유: ${locMap[loc]})`, max: locMap[loc] });
        }
    });
    validLocs.sort((a,b) => a.val.localeCompare(b.val));
    wrap.dataset.options = JSON.stringify(validLocs);
    
    if(validLocs.length <= 1) wrap.classList.add('single-option');
    else wrap.classList.remove('single-option');
}

function handleDiscardLocChange(input) {
    const row = input.closest('tr'); const qtyInput = row.querySelector('.discard-card-qty'); const maxQty = parseInt(input.dataset.maxQty) || 0;
    if (!input.value) { qtyInput.value = ""; return; }
    if (maxQty > 0) { qtyInput.max = maxQty; qtyInput.placeholder = `최대 ${maxQty}`; const currentQty = parseInt(qtyInput.value); if (!isNaN(currentQty) && currentQty > maxQty) { qtyInput.value = maxQty; } } else { qtyInput.value = ""; qtyInput.placeholder = "재고 없음"; }
}

function getGlobalUsageMap(excludeRow) {
    const usage = {};
    const rows = document.getElementById('page-discard-tbody').querySelectorAll('tr');
    rows.forEach(r => {
        if (r === excludeRow) return;
        const no = r.querySelector('.discard-card-no').value.trim().toUpperCase();
        if(!no) return;
        const illust = r.querySelector('.discard-card-another').value;
        const rareInp = r.querySelector('.discard-card-proc');
        const rare = rareInp.dataset.raw || rareInp.value;
        const loc = r.querySelector('.discard-card-loc').value;
        
        if(no && illust && rare && loc) {
            if(!usage[no]) usage[no] = {};
            if(!usage[no][illust]) usage[no][illust] = {};
            if(!usage[no][illust][rare]) usage[no][illust][rare] = new Set();
            usage[no][illust][rare].add(loc);
        }
    });
    return usage;
}

function checkDiscardIllustAvailability(cardNo, illust, excludeRow) {
    const matches = localCardDatabase.filter(r => String(r[1]).trim().toUpperCase() === cardNo && String(r[5] || "기본").trim() === illust);
    const uniqueRares = [...new Set(matches.map(r => String(r[2]).trim()))];
    return uniqueRares.some(rare => checkDiscardRareAvailability(cardNo, illust, rare, excludeRow));
}

function checkDiscardRareAvailability(cardNo, illust, rare, currentRow) {
    const dbMatches = localCardDatabase.filter(r => String(r[1]).trim().toUpperCase() === cardNo && String(r[5] || "기본").trim() === illust && String(r[2]).trim() === rare);
    const dbLocs = new Set(dbMatches.map(r => String(r[4]).trim()));
    
    const globalUsage = getGlobalUsageMap(currentRow);
    let usedLocs = new Set();
    if(globalUsage[cardNo] && globalUsage[cardNo][illust] && globalUsage[cardNo][illust][rare]) {
        usedLocs = globalUsage[cardNo][illust][rare];
    }
    
    for (let loc of dbLocs) {
        if (!usedLocs.has(loc)) return true;
    }
    return false;
}

function isCardDepleted(cardNo, excludeRow) {
    const matches = localCardDatabase.filter(r => String(r[1]).trim().toUpperCase() === cardNo);
    if(matches.length === 0) return true; 
    
    const uniqueIllusts = [...new Set(matches.map(r => String(r[5] || "기본").trim()))];
    return !uniqueIllusts.some(illust => checkDiscardIllustAvailability(cardNo, illust, excludeRow));
}

function handleAddLocChange(input) {
    const row = input.closest('tr');
    const qtyInp = row.querySelector('.page-card-qty');
    
    if(input.value.trim().length > 0) {
        qtyInp.removeAttribute('readonly');
        if(!qtyInp.value) qtyInp.value = "1";
    } else {
        qtyInp.setAttribute('readonly', true);
        qtyInp.value = "";
    }

    if (!isAutoCopyEnabled) return;
    
    const val = input.value;
    const rows = document.getElementById('page-add-tbody').querySelectorAll('tr');
    let startCopy = false;
    
    rows.forEach(r => {
        if (r === row) { startCopy = true; return; }
        if (startCopy) {
            const nextLocInput = r.querySelector('.page-card-loc');
            const nextQtyInput = r.querySelector('.page-card-qty');
            const wrapper = nextLocInput.closest('.custom-select-wrapper');
            if (!wrapper.classList.contains('no-option')) {
                nextLocInput.value = val;
                nextLocInput.removeAttribute('readonly'); 
                if (val.trim().length > 0) {
                    nextQtyInput.removeAttribute('readonly');
                    if (!nextQtyInput.value) nextQtyInput.value = "1";
                } else {
                    nextQtyInput.setAttribute('readonly', true);
                    nextQtyInput.value = "";
                }
            }
        }
    });
}

function deletePageEntry(btn) {
    const row = btn.closest('tr');
    const tbody = document.getElementById('page-add-tbody');
    if (tbody.querySelectorAll('tr').length <= 1) return;
    tbody.removeChild(row);
    reindexRows();
}

function reindexRows() {
    const tbody = document.getElementById('page-add-tbody');
    const rows = tbody.querySelectorAll('tr');
    rows.forEach((row, index) => {
        const num = index + 1;
        const noCell = row.querySelector('.no-cell');
        if (noCell) noCell.innerText = num;
        row.classList.remove('odd', 'even');
        const groupClass = (num % 2 !== 0) ? 'odd' : 'even';
        row.classList.add(groupClass);
        const delBtn = row.querySelector('.col-delete');
        if (rows.length <= 1) { delBtn.classList.add('disabled'); } else { delBtn.classList.remove('disabled'); }
    });
}

function deleteDiscardEntry(btn) {
    const row = btn.closest('tr');
    const tbody = document.getElementById('page-discard-tbody');
    if (tbody.querySelectorAll('tr').length <= 1) return;
    tbody.removeChild(row);
    reindexDiscardRows();
}

function reindexDiscardRows() {
    const tbody = document.getElementById('page-discard-tbody');
    const rows = tbody.querySelectorAll('tr');
    rows.forEach((row, index) => {
        const num = index + 1;
        const noCell = row.querySelector('.no-cell');
        if (noCell) noCell.innerText = num;
        row.classList.remove('odd', 'even');
        const groupClass = (num % 2 !== 0) ? 'odd' : 'even';
        row.classList.add(groupClass);
        const delBtn = row.querySelector('.col-delete');
        if (rows.length <= 1) { delBtn.classList.add('disabled'); } else { delBtn.classList.remove('disabled'); }
    });
}

function handleCardNoInput(input) {
    const start = input.selectionStart;
    input.value = input.value.replace(/[ㄱ-ㅎ|ㅏ-ㅣ|가-힣]/g, '').toUpperCase();
    input.setSelectionRange(start, start);
}

async function fetchCardNameForPage(input) {
    const row = input.closest('tr');
    const cardNo = input.value.trim();
    const prevCardNo = input.dataset.prevCardNo;

    if (prevCardNo === cardNo) return; 
    input.dataset.prevCardNo = cardNo; 

    const nameDiv = row.querySelector('.card-name-disp'); 
    const anotherInp = row.querySelector('.page-card-another');
    const anotherWrap = anotherInp.closest('.custom-select-wrapper');
    const procInp = row.querySelector('.page-card-proc');
    const procWrap = procInp.closest('.custom-select-wrapper');
    const locInp = row.querySelector('.page-card-loc'); 
    const locWrap = locInp.closest('.custom-select-wrapper');
    const qtyInput = row.querySelector('.page-card-qty');

    procInp.value = ""; procInp.setAttribute('readonly', true); 
    procWrap.dataset.options = "[]"; procWrap.classList.remove('single-option'); procWrap.classList.add('no-option');
    
    const autoLocValue = document.getElementById('auto-location-input').value.trim();
    if (!autoLocValue) {
        locInp.value = ""; locInp.setAttribute('readonly', true);
        qtyInput.value = ""; qtyInput.setAttribute('readonly', true);
    }
    
    anotherInp.value = ""; anotherInp.setAttribute('readonly', true); 
    anotherWrap.dataset.options = "[]"; anotherWrap.classList.remove('single-option'); anotherWrap.classList.add('no-option');

    if (!cardNo) { nameDiv.innerText = "카드 번호 입력"; return; }

    if (clientCache[cardNo]) {
        const cached = clientCache[cardNo];
        if (cached.linkData) {
            const linkId = (cached.linkData.id) ? cached.linkData.id : "/MISSING_CID";
            const linkLocale = (cached.linkData.locale) ? cached.linkData.locale : currentRegion;
            const url = "https://www.db.yugioh-card.com" + linkId + "&request_locale=" + linkLocale;
            nameDiv.innerHTML = `<a href="${url}" target="_blank" class="card-link" onclick="event.stopPropagation()">${cached.name}</a>`;
        } else { nameDiv.innerText = cached.name; }
        applyPageCardDataToRows(cached, row);
        return;
    }

    nameDiv.innerText = "조회 중...";
    try {
        const res = await callApi('getCardNameFromDb', { cardNo });
        if (input.value.trim() !== cardNo) return;

        // [v0.23.21 지시 사항 삽입] 에러 식별 및 자동 재시도 로직
        if (res.isError) {
            nameDiv.innerText = res.name;
            if (res.name.includes("서버가 바쁩니다")) {
                nameDiv.innerText = "서버 과부하: 3초 후 자동 재시도...";
                input.dataset.prevCardNo = ""; // 재시도 차단 방지를 위한 초기화
                setTimeout(() => {
                    fetchCardNameForPage(input);
                }, 3000);
            }
            return; // 에러 응답은 clientCache에 저장하지 않고 종료
        }

        // 정상 데이터 처리 로직 (원본 보존)
        if (res.name.includes("오류") || res.name.includes("확인하세요")) {
            nameDiv.innerText = res.name;
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
                    if(id) {
                        rarityOrderMap[id] = index; 
                        row.forEach(cellVal => {
                            if(cellVal) rarityReverseMap[cellVal] = index;
                        });
                    }
                });
                allProcessingTypes = rarityRows.map(r => r[0]).filter(Boolean);
            }

            clientCache[cardNo] = { name: res.name, anotherCount: res.anotherCount, rarities: res.rarities, linkData: res.linkData };
            if (res.name) {
                if (!allNames.includes(res.name)) {
                    allNames.push(res.name);
                    allNames.sort();
                    if(!nameDb[res.name]) nameDb[res.name] = { id: "/MISSING_CID" };
                }
            }
            
            const linkId = (res.linkData && res.linkData.id) ? res.linkData.id : "/MISSING_CID";
            const linkLocale = (res.linkData && res.linkData.locale) ? res.linkData.locale : currentRegion;
            const url = "https://www.db.yugioh-card.com" + linkId + "&request_locale=" + linkLocale;
            nameDiv.innerHTML = `<a href="${url}" target="_blank" class="card-link" onclick="event.stopPropagation()">${res.name}</a>`;
            applyPageCardDataToRows(res, row);
        }
    } catch (e) {
        if (input.value.trim() !== cardNo) return;
        nameDiv.innerText = "접속 오류";
    }
}

function applyPageCardDataToRows(data, row) {
    const anotherInp = row.querySelector('.page-card-another');
    const anotherWrap = anotherInp.closest('.custom-select-wrapper');
    const procInp = row.querySelector('.page-card-proc');
    const procWrap = procInp.closest('.custom-select-wrapper');
    const locInp = row.querySelector('.page-card-loc'); 
    const locWrap = locInp.closest('.custom-select-wrapper');

    const count = data.anotherCount || 1;
    let illustOptions = [];
    
    if (count > 1) {
        illustOptions.push({ val: "기본", text: "기본" });
        for(let i=2; i<=count; i++) {
            let suffix = "th"; if(i===2) suffix="nd"; if(i===3) suffix="rd";
            illustOptions.push({ val: `${i}${suffix}`, text: `${i}${suffix}` });
        }
        anotherWrap.dataset.options = JSON.stringify(illustOptions);
        anotherWrap.classList.remove('single-option');
        anotherWrap.classList.remove('no-option');
    } else {
        anotherInp.value = "기본";
        anotherWrap.classList.add('single-option');
        anotherWrap.classList.remove('no-option');
        anotherWrap.dataset.options = JSON.stringify([{ val: "기본", text: "기본" }]);
    }

    let rareOptions = [];
    let sources = [];
    if (!data.isFallback && data.rarities && data.rarities.length > 0) {
        sources = [...data.rarities].sort(compareRarity);
    } else {
        sources = [...allProcessingTypes].sort(compareRarity);
    }
    
    rareOptions = sources.map(r => ({ val: r, text: getLocalizedRarity(r) }));
    
    procWrap.dataset.options = JSON.stringify(rareOptions);
    procWrap.classList.remove('no-option');

    if (rareOptions.length === 1) {
        procInp.value = rareOptions[0].text; 
        procInp.dataset.raw = rareOptions[0].val; 
        procWrap.classList.add('single-option');
    } else {
        procInp.value = ""; 
        procWrap.classList.remove('single-option');
    }
    locInp.removeAttribute('readonly'); 
    locWrap.classList.remove('no-option');
}

function saveRecentSearch(keyword) {
    if (!keyword) return;
    let recent = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    recent = recent.filter(r => r !== keyword);
    recent.unshift(keyword);
    if (recent.length > 5) recent.pop();
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
}

function toggleResultDetail_Add() { 
    const box = document.getElementById('result-detail-box'); 
    const icon = document.getElementById('toggle-icon'); 
    if (box.style.display !== 'block') { box.style.display = 'block'; icon.innerText = 'keyboard_arrow_up'; } else { box.style.display = 'none'; icon.innerText = 'keyboard_arrow_down'; }
}

function toggleResultDetail_Move() { 
    const box = document.getElementById('move-result-detail-box'); 
    const icon = document.getElementById('move-toggle-icon'); 
    if (box.style.display !== 'block') { box.style.display = 'block'; icon.innerText = 'keyboard_arrow_up'; } else { box.style.display = 'none'; icon.innerText = 'keyboard_arrow_down'; }
}

function toggleResultDetail_Discard() { 
    const box = document.getElementById('discard-result-detail-box'); 
    const icon = document.getElementById('discard-toggle-icon'); 
    if (box.style.display !== 'block') { box.style.display = 'block'; icon.innerText = 'keyboard_arrow_up'; } else { box.style.display = 'none'; icon.innerText = 'keyboard_arrow_down'; }
}

function showResultModal(successCount, successQty, detailLog, errorMsg) {
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
    document.getElementById('result-detail-box').style.display = 'none';
    document.getElementById('toggle-icon').innerText = 'keyboard_arrow_down';

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

         const successLogs = detailLog.filter(l => l.status === 'success');
         if (successLogs.length > 0) {
             const nameAgg = {};
             successLogs.forEach(l => { if(!nameAgg[l.name]) nameAgg[l.name] = 0; nameAgg[l.name] += l.qty; });
             for(const [name, qty] of Object.entries(nameAgg)) {
                 summaryBody.innerHTML += `<tr style="background-color: var(--bg-success);"><td>${name}</td><td style="color:var(--success-green); font-weight:700;">${qty}장</td></tr>`;
             }
         }
         const failLogs = detailLog.filter(l => l.status === 'fail');
         if (failLogs.length > 0) {
             const failAgg = {};
             failLogs.forEach(l => {
                 let reason = l.failReason;
                 if(reason === 'empty_no' || reason === 'invalid_no') reason = "카드 번호 오류";
                 else if(reason === 'no_another') reason = "일러스트 오류";
                 else if(reason === 'no_proc') reason = "레어도 오류";
                 else if(reason === 'invalid_qty') reason = "수량 오류";
                 else if(reason === 'no_loc') reason = "위치 오류";
                 else if(reason === 'loading') reason = "번호 검색 중";

                 if(!failAgg[reason]) failAgg[reason] = 0;
                 failAgg[reason]++;
             });
             for(const [reason, count] of Object.entries(failAgg)) {
                 summaryBody.innerHTML += `<tr style="background-color: var(--bg-fail);"><td style="color:var(--error-red);">${reason}</td><td style="color:var(--error-red); font-weight:700;">${count}건</td></tr>`;
             }
         }
         
         detailLog.forEach((log, idx) => {
             const tr = document.createElement('tr');
             let procTxt = log.proc; let locTxt = log.loc; let qtyTxt = log.qty;
             let anotherTxt = log.another;
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
             tr.innerHTML = `<td>${log.no}</td><td>${log.name}</td><td style="${cardNoStyle}">${log.cardNo}</td><td style="${anotherStyle}">${anotherTxt}</td><td style="${procStyle}">${getLocalizedRarity(procTxt) || "-"}</td><td style="${locStyle}">${locTxt}</td><td style="${qtyStyle}">${qtyTxt}</td>`;
             detailBody.appendChild(tr);
         });
    }
    
    toggleBackgroundInert(true);
    M.Modal.getInstance(modal).open();
}

function showDiscardResultModal(successCount, successQty, detailLog, errorMsg) {
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
    document.getElementById('discard-result-detail-box').style.display = 'none';
    document.getElementById('discard-toggle-icon').innerText = 'keyboard_arrow_down';

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

         const successLogs = detailLog.filter(l => l.status === 'success');
         if (successLogs.length > 0) {
             const nameAgg = {};
             successLogs.forEach(l => { if(!nameAgg[l.name]) nameAgg[l.name] = 0; nameAgg[l.name] += l.qty; });
             for(const [name, qty] of Object.entries(nameAgg)) {
                 summaryBody.innerHTML += `<tr style="background-color: var(--bg-success);"><td>${name}</td><td style="color:var(--success-green); font-weight:700;">${qty}장</td></tr>`;
             }
         }
         const failLogs = detailLog.filter(l => l.status === 'fail');
         if (failLogs.length > 0) {
             const failAgg = {};
             failLogs.forEach(l => {
                 let reason = l.failReason;
                 if(reason === 'empty_no' || reason === 'invalid_no') reason = "카드 번호 오류";
                 else if(reason === 'no_another') reason = "일러스트 미선택";
                 else if(reason === 'no_proc') reason = "레어도 미선택";
                 else if(reason === 'no_loc') reason = "보관 위치 미선택";
                 else if(reason === 'invalid_qty') reason = "수량 오류";

                 if(!failAgg[reason]) failAgg[reason] = 0;
                 failAgg[reason]++;
             });
             for(const [reason, count] of Object.entries(failAgg)) {
                 summaryBody.innerHTML += `<tr style="background-color: var(--bg-fail);"><td style="color:var(--error-red);">${reason}</td><td style="color:var(--error-red); font-weight:700;">${count}건</td></tr>`;
             }
         }
         
         detailLog.forEach((log, idx) => {
             const tr = document.createElement('tr');
             let procTxt = log.proc; let locTxt = log.loc; let qtyTxt = log.qty;
             let anotherTxt = log.another;
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
             tr.innerHTML = `<td>${idx+1}</td><td>${log.name}</td><td style="${cardNoStyle}">${log.cardNo}</td><td style="${anotherStyle}">${anotherTxt}</td><td style="${procStyle}">${getLocalizedRarity(procTxt) || "-"}</td><td style="${locStyle}">${locTxt}</td><td style="${qtyStyle}">${qtyTxt}</td>`;
             detailBody.appendChild(tr);
         });
    }
    
    toggleBackgroundInert(true);
    M.Modal.getInstance(modal).open();
}

async function handleContinueDiscard() { 
    M.Modal.getInstance(document.getElementById('discard-result-modal')).close(); 
    toggleBackgroundInert(false);
    const tbody = document.getElementById('page-discard-tbody'); 
    const rows = Array.from(tbody.children); 
    let hasFailures = false; let hasSuccess = false; 
    for (let i = rows.length - 1; i >= 0; i--) { 
        const row = rows[i]; 
        if (row.dataset.status === 'success') { 
            tbody.removeChild(row); hasSuccess = true; 
        } else { 
            hasFailures = true; delete row.dataset.status; 
        } 
    }
    if (!hasFailures || tbody.children.length === 0) { addDiscardEntry(); } reindexDiscardRows();
    
    if (hasSuccess) {
        if (syncCounter >= 9) {
            syncCounter = 0;
            await refreshInitialData();
        }
    }
}

async function submitPageEntries() {
    const submitBtn = document.getElementById('add-submit-main-btn');
    if(submitBtn && submitBtn.classList.contains('disabled')) return;
    const tbody = document.getElementById('page-add-tbody');
    const rows = tbody.querySelectorAll('tr'); 
    
    let hasInput = false;
    rows.forEach(r => {
        if(r.querySelector('.page-card-no').value.trim()) hasInput = true;
    });

    if (!hasInput) {
        showToast('등록할 카드가 없습니다.', 'warning-yellow black-text');
        return;
    }

    const validRows = [];
    const detailLog = [];
    let successCount = 0; let successQty = 0;

    rows.forEach(row => {
        const no = row.querySelector('.no-cell').innerText;
        const cardNo = row.querySelector('.page-card-no').value.trim();
        let nameText = row.querySelector('.card-name-disp').innerText;
        
        if (!cardNo) {
            detailLog.push({ no, name: "", cardNo: "", another: "", proc: "", loc: "", qty: 0, status: 'fail', failReason: 'empty_no' });
            row.dataset.status = 'fail'; return; 
        }

        let another = row.querySelector('.page-card-another').value;
        let procRaw = row.querySelector('.page-card-proc').dataset.raw || row.querySelector('.page-card-proc').value; 
        let loc = row.querySelector('.page-card-loc').value.trim();
        const qtyVal = row.querySelector('.page-card-qty').value;
        const qty = parseInt(qtyVal);

        let failReason = null;
        if (nameText === "조회 중...") {
            failReason = "loading";
        } else if (nameText.includes("입력") || nameText.includes("오류") || nameText.includes("확인")) {
            failReason = "invalid_no"; nameText = "유효하지 않은 카드";
        } else if (!another) {
            failReason = "no_another"; another = "미선택";
        } else if (!procRaw) failReason = "no_proc"; 
        else if (!loc) failReason = "no_loc";
        else if (!qty || qty < 1) failReason = "invalid_qty";

        if (failReason) {
            let procDisp = row.querySelector('.page-card-proc').value;
            detailLog.push({ no, name: nameText, cardNo, another, proc: procDisp||"미선택", loc: loc||"미선택", qty: qty||0, status: 'fail', failReason });
            row.dataset.status = 'fail'; 
        } else {
            validRows.push([nameText, cardNo, procRaw, qty, loc, another]);
            detailLog.push({ no, name: nameText, cardNo, another, proc: procRaw, loc, qty, status: 'success' }); 
            successCount++; successQty += qty;
            row.dataset.status = 'success'; 
        }
    });

    if (validRows.length > 0) {
        showLoading(true, "등록 중...");
        try {
            const res = await callApi('addCards', {}, validRows);
            showLoading(false);
            
            if (res.success) {
                updateLocalInventory(res.updatedItems);
                syncCounter++;
                showResultModal(successCount, successQty, detailLog);
            } else {
                showToast('등록 실패: ' + (res.message || '오류 발생'), 'red darken-1');
                showResultModal(0, 0, [], res.message || '오류 발생');
            }
        } catch (e) {
            showLoading(false);
            showToast('등록 실패: ' + e.toString(), 'red darken-1'); 
            showResultModal(0, 0, [], e.toString());
        }
    } else if (detailLog.length > 0) { 
        showResultModal(0, 0, detailLog); 
    } else {
        showToast('등록 실패: 유효한 데이터가 없습니다.', 'red darken-1');
    }
}

async function submitDiscardEntries() {
    const submitBtn = document.getElementById('discard-submit-main-btn');
    if(submitBtn && submitBtn.classList.contains('disabled')) return;
    const tbody = document.getElementById('page-discard-tbody');
    const rows = tbody.querySelectorAll('tr'); 
    
    const validRows = [];
    const detailLog = []; 
    let successCount = 0; let successQty = 0;
    let hasFail = false;

    rows.forEach(row => {
        const no = row.querySelector('.no-cell').innerText;
        const cardNo = row.querySelector('.discard-card-no').value.trim();
        let nameText = row.querySelector('.card-name-input').value.trim();
        
        if (!cardNo) return; 

        let another = row.querySelector('.discard-card-another').value;
        let procInput = row.querySelector('.discard-card-proc');
        let proc = procInput.dataset.raw || procInput.value; 
        let loc = row.querySelector('.discard-card-loc').value.trim();
        const qtyVal = row.querySelector('.discard-card-qty').value;
        const qty = parseInt(qtyVal);

        let failReason = null;
        if (!cardNo || !nameText) {
            failReason = "invalid_no";
        } else if (!another) {
            failReason = "no_another";
        } else if (!proc) {
            failReason = "no_proc";
        } else if (!loc) {
            failReason = "no_loc";
        } else if (!qty || qty < 1) {
            failReason = "invalid_qty";
        }

        if (failReason) {
            hasFail = true;
            row.dataset.status = 'fail'; 
            detailLog.push({ no, name: nameText, cardNo, another: another||"-", proc: proc||"-", loc: loc||"-", qty: qty||0, status: 'fail', failReason });
        } else {
            validRows.push({ cardNo, name: nameText, proc, another, loc, qty });
            detailLog.push({ no, name: nameText, cardNo, another, proc, loc, qty, status: 'success' });
            successCount++; successQty += qty;
            row.dataset.status = 'success'; 
        }
    });

    if (validRows.length === 0 && !hasFail) {
        showToast('제거할 카드가 없습니다.', 'warning-yellow black-text');
        return;
    }
    
    if (validRows.length === 0 && hasFail) {
         showDiscardResultModal(0, 0, detailLog); 
         return;
    }

    showLoading(true, "카드 제거 중...");
    try {
        const res = await callApi('discardCards', {}, validRows);
        showLoading(false);
        
        if (res.success) {
            updateLocalInventory(res.updatedItems);
            syncCounter++;
            showDiscardResultModal(successCount, successQty, detailLog);
        } else {
            showToast('제거 실패: ' + (res.message || '오류 발생'), 'red darken-1');
            showDiscardResultModal(0, 0, detailLog, res.message || '오류 발생');
        }
    } catch (e) {
        showLoading(false);
        showToast('제거 실패: ' + e.toString(), 'red darken-1'); 
        showDiscardResultModal(0, 0, detailLog, e.toString());
    }
}

function decomposeHangul(str) { 
  if (!str) return "";
  return str.normalize('NFD');
}

function normalizeStr(str) { return str.replace(/\s+/g, '').toLowerCase(); }
function showRecentInDropdown() { const recent = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); const list = document.getElementById('custom-dropdown'); currentFocus = -1; Array.from(list.children).forEach(child => { if (!child.classList.contains('recent-header-item')) { child.remove(); } }); let header = list.querySelector('.recent-header-item'); if (!header) { header = document.createElement('li'); header.className = 'recent-header-item'; header.innerHTML = `<span class="recent-title">최근 검색</span><span class="clear-all-btn">전체 제거</span>`; list.prepend(header); } if (recent.length === 0) { const noResultLi = document.createElement('li'); noResultLi.className = 'no-result-item'; noResultLi.innerText = '검색 기록이 없습니다.'; list.appendChild(noResultLi); } else { recent.slice(0, 5).forEach(r => { const li = document.createElement('li'); li.className = 'recent-item-row'; li.dataset.val = r; li.innerHTML = `<span class="recent-text text-suggest">${r}</span><i class="material-icons item-delete-btn">close</i>`; list.appendChild(li); }); } list.style.display = 'block'; toggleSearchWrapper(true); }

function filterAndShowDropdown(val) { 
    if(!isAppConfigured) return; 
    const list = document.getElementById('custom-dropdown'); 
    const normalizedInput = normalizeStr(val); 
    const decomposedInput = decomposeHangul(normalizedInput); 
    currentFocus = -1; 
    
    const ownedNames = new Set(localCardDatabase.filter(r => (parseInt(r[3]) || 0) > 0).map(r => String(r[0])));
    
    let matches = allNames.filter(name => { 
        if (!ownedNames.has(name)) return false;
        const normName = normalizeStr(name); 
        const decompName = decomposeHangul(normName); 
        return decompName.includes(decomposedInput); 
    }); 
    
    matches.sort((a, b) => { 
        const normVal = normalizedInput; 
        const normA = normalizeStr(a); 
        const normB = normalizeStr(b); 
        if (normA === normVal) return -1; 
        if (normB === normVal) return 1; 
        const aStarts = normA.startsWith(normVal); 
        const bStarts = normB.startsWith(normVal); 
        if (aStarts && !bStarts) return -1; 
        if (!aStarts && bStarts) return 1; 
        return a.length - b.length || a.localeCompare(b); 
    }); 
    
    list.innerHTML = ''; 
    if (matches.length === 0) { 
        list.innerHTML = '<li class="no-result-item">등록되지 않은 카드</li>'; 
        list.style.display = 'block'; 
        toggleSearchWrapper(true); 
        return; 
    } 
    
    matches.slice(0, 10).forEach(m => { 
        const li = document.createElement('li'); 
        li.className = 'text-suggest'; 
        li.dataset.val = m; 
        let html = ""; 
        let searchIdx = 0; 
        const lowerM = m.toLowerCase(); 
        const lowerVal = val.toLowerCase().replace(/\s+/g, ''); 
        for(let i=0; i<m.length; i++) { 
            if(searchIdx < lowerVal.length && lowerM[i] === lowerVal[searchIdx]) { 
                html += `<span class="text-match">${m[i]}</span>`; 
                searchIdx++; 
            } else { 
                html += m[i]; 
            } 
        } 
        li.innerHTML = html; 
        list.appendChild(li); 
    }); 
    list.style.display = 'block'; 
    toggleSearchWrapper(true); 
}

function deleteRecentItem(name) { let recent = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); recent = recent.filter(r => r !== name); localStorage.setItem(RECENT_KEY, JSON.stringify(recent)); showRecentInDropdown(); }
function updateDisconnectBtn() { const btn = document.getElementById('disconnect-btn'); if(btn) { if (localStorage.getItem(STORAGE_KEY)) { btn.classList.remove('disabled'); } else { btn.classList.add('disabled'); } } }
function disconnectSheet() { localStorage.removeItem(STORAGE_KEY); updateDisconnectBtn(); isAppConfigured = false; currentSheetName = ""; document.getElementById('sheet-url').placeholder = "주소 입력 (예 : https://docs.google.com/spreadsheets/...)"; cancelSettings(); showToast('연결이 해제되었습니다.', 'red darken-1'); }
function saveSettings() { const url = document.getElementById('sheet-url').value.trim(); const match = url.match(/[-\w]{25,}/); if(match) { localStorage.setItem(STORAGE_KEY, match[0]); refreshInitialData(); cancelSettings(); } }
function cancelSettings() { clearTimeout(validationTimeout); const input = document.getElementById('sheet-url'); const mark = document.getElementById('valid-mark'); const msg = document.getElementById('status-msg'); const confirmBtn = document.getElementById('confirm-btn'); input.value = ''; input.classList.remove('state-error', 'state-warning', 'state-success'); mark.style.display = 'none'; msg.innerText = ''; confirmBtn.classList.add('disabled'); if (currentSheetName) { input.placeholder = "연결됨 : " + currentSheetName; } else { input.placeholder = "주소 입력 (예 : https://docs.google.com/spreadsheets/...)"; } }

function validateSheetLink() { 
    clearTimeout(validationTimeout); 
    const input = document.getElementById('sheet-url'); 
    const url = input.value.trim(); 
    const mark = document.getElementById('valid-mark'), msg = document.getElementById('status-msg'), confirmBtn = document.getElementById('confirm-btn'); 
    input.classList.remove('state-error', 'state-warning', 'state-success'); 
    
    if (!url) { mark.style.display = 'none'; msg.innerText = ''; confirmBtn.classList.add('disabled'); return; } 
    const match = url.match(/[-\w]{25,}/); 
    
    if (!match) { 
        mark.innerHTML = '<i class="material-icons" style="color: var(--error-red)">cancel</i>'; 
        mark.style.display = 'block'; 
        msg.innerText = '구글 시트 링크를 적어주세요.'; 
        msg.style.color = 'var(--error-red)'; 
        input.classList.add('state-error'); 
        confirmBtn.classList.add('disabled'); 
        return; 
    } 
    
    mark.innerHTML = '<div class="loading-spinner"></div>'; 
    mark.style.display = 'block'; 
    msg.innerText = '확인 중...'; 
    msg.style.color = 'var(--text-secondary)'; 
    
    validationTimeout = setTimeout(async () => { 
        try { 
            const res = await callApi('checkSheet', { targetId: match[0] }); 
            input.classList.remove('state-error', 'state-warning', 'state-success'); 
            if (res.status === 'OK') { 
                mark.innerHTML = '<i class="material-icons" style="color: var(--success-green)">check_circle</i>'; 
                msg.innerText = '유효한 시트입니다.'; 
                msg.style.color = 'var(--success-green)'; 
                input.classList.add('state-success'); 
                confirmBtn.classList.remove('disabled'); 
            } else { 
                mark.innerHTML = '<i class="material-icons" style="color: var(--warning-yellow)">warning</i>'; 
                msg.innerText = (res.status === 'NO_EDIT_ACCESS') ? '공유 설정을 링크를 가진 모든 사용자 / 편집자로 설정해주세요.' : '접근할 수 없거나 형식이 잘못되었습니다.'; 
                msg.style.color = 'var(--warning-yellow)'; 
                input.classList.add('state-warning'); 
                confirmBtn.classList.add('disabled'); 
            } 
            mark.style.display = 'block'; 
        } catch (e) { 
            input.classList.remove('state-error', 'state-warning', 'state-success'); 
            mark.innerHTML = '<i class="material-icons" style="color: var(--error-red)">error</i>'; 
            msg.innerText = '확인 실패'; 
            msg.style.color = 'var(--error-red)'; 
            input.classList.add('state-error'); 
        } 
    }, 500); 
}

function toggleGuide(forceOpen = null) { const btn = document.getElementById('guide-accordion-btn'); const box = document.getElementById('guide-box'); const isOpen = (forceOpen !== null) ? forceOpen : box.style.display === 'none'; box.style.display = isOpen ? 'block' : 'none'; if (isOpen) btn.classList.add('active'); else btn.classList.remove('active'); }
function loadTheme() { const savedTheme = localStorage.getItem(THEME_KEY); if (savedTheme === 'dark') { document.documentElement.classList.add('dark-mode'); const chk = document.getElementById('checkbox-theme'); if(chk) chk.checked = true; updateMetaThemeColor('dark'); } else { updateMetaThemeColor('light'); } }
function toggleTheme() { if (document.getElementById('checkbox-theme').checked) { document.documentElement.classList.add('dark-mode'); localStorage.setItem(THEME_KEY, 'dark'); updateMetaThemeColor('dark'); } else { document.documentElement.classList.remove('dark-mode'); localStorage.setItem(THEME_KEY, 'light'); updateMetaThemeColor('light'); } }
const regionMap = { 'ko': '한국', 'ja': '일본', 'ae': '아시아', 'cn': '중국', 'en': '영미', 'de': '독일', 'fr': '프랑스', 'it': '이탈리아', 'es': '스페인', 'pt': '포르투갈' };
function loadRegion() { const savedRegion = localStorage.getItem(REGION_KEY) || 'ko'; currentRegion = savedRegion; document.getElementById('region-text').innerText = regionMap[savedRegion]; }
function toggleRegionDropdown(event) { event.stopPropagation(); const list = document.getElementById('region-dropdown'); const capsule = document.getElementById('region-capsule'); if (list.style.display === 'block') { list.style.display = 'none'; capsule.classList.remove('active'); } else { list.style.display = 'block'; capsule.classList.add('active'); } }

function selectRegion(code, text) { 
    currentRegion = code; 
    localStorage.setItem(REGION_KEY, code); 
    document.getElementById('region-text').innerText = text; 
    document.getElementById('region-dropdown').style.display = 'none'; 
    document.getElementById('region-capsule').classList.remove('active');
    
    updateTooltipsOnly();
    updateRarityInputs(); 
}

function updateTooltipsOnly() {
    const headers = document.querySelectorAll('th.sp-col.tooltipped');
    if(headers.length === 0) return;

    headers.forEach(th => {
        const key = th.dataset.key; 
        const idx = th.dataset.index;
        
        let newTooltip = key;

        if(idx !== undefined && idx !== "undefined" && idx !== "") {
            const row = rarityRows[idx];
            if(row && rarityColMap[currentRegion] !== undefined) {
                const val = row[rarityColMap[currentRegion]];
                if(val && val !== "") newTooltip = val;
            }
        }
        
        newTooltip = String(newTooltip).replace(/\(/g, '<br>(');
        th.setAttribute('data-tooltip', newTooltip);
    });

    const resultArea = document.getElementById('result-area');
    if(resultArea) {
         M.Tooltip.init(resultArea.querySelectorAll('.tooltipped'), { html: true, margin: 3 });
    }
}

function updateRarityInputs() {
    const inputs = document.querySelectorAll('.page-card-proc, .move-card-proc, .discard-card-proc');
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
            } catch(e) { console.error(e); }
        }
    });
}

async function callApi(action, params = {}, postData = null) { const url = new URL(SCRIPT_URL); url.searchParams.append("action", action); const savedId = localStorage.getItem(STORAGE_KEY); if (savedId) url.searchParams.append("ssId", savedId); for (const key in params) { url.searchParams.append(key, params[key]); } const options = { method: postData ? 'POST' : 'GET' }; if (postData) options.body = JSON.stringify(postData); const response = await fetch(url, options); return await response.json(); }
function resetAddModal() { const tbody = document.getElementById('add-card-tbody'); if(tbody) tbody.innerHTML = ''; }

async function refreshInitialData() { 
    const savedId = localStorage.getItem(STORAGE_KEY); if (!savedId) return; 
    showLoading(true, "데이터 동기화 중..."); 
    try { 
        const res = await callApi('getInitialData'); 
        showLoading(false); 
        isAppConfigured = res.isConfigured; 
        if (res.isConfigured) { 
            allNames = res.names; 
            allProcessingTypes = res.processingTypes; 
            allLocations = res.locations.sort(); 
            localCardDatabase = res.allCards; 
            
            rarityMappingRaw = res.rarityMappingRaw || [];
            if (rarityMappingRaw.length > 0) {
                const headers = rarityMappingRaw[0];
                rarityColMap = {};
                headers.forEach((h, i) => rarityColMap[h] = i);

                rarityRows = rarityMappingRaw.slice(1);
                rarityReverseMap = {};
                rarityOrderMap = {}; 

                rarityRows.forEach((row, index) => {
                    const id = row[0]; 
                    if(id) {
                        rarityOrderMap[id] = index; 
                        row.forEach(cellVal => {
                            if(cellVal) rarityReverseMap[cellVal] = index;
                        });
                    }
                });
            }
            
            clientCache = res.clientCache || {}; 
            nameDb = res.nameDb || {}; 
            if (res.sheetName) { currentSheetName = res.sheetName; document.getElementById('sheet-url').placeholder = "연결됨 : " + currentSheetName; } else { currentSheetName = ""; }
            const datalist = document.getElementById('loc-datalist'); datalist.innerHTML = allLocations.map(l => `<option value="${l}">`).join('');
            const distinctNos = new Set(localCardDatabase.map(r => String(r[1]).trim().toUpperCase())); ownedCardNumbers = Array.from(distinctNos).sort();
            nameToNosMap = {}; localCardDatabase.forEach(r => { const name = String(r[0]).trim(); const no = String(r[1]).trim().toUpperCase(); if(!nameToNosMap[name]) nameToNosMap[name] = new Set(); nameToNosMap[name].add(no); }); for(let key in nameToNosMap) { nameToNosMap[key] = Array.from(nameToNosMap[key]).sort(); }
            cidLookup = {}; Object.keys(nameDb).forEach(nameKey => { const entry = nameDb[nameKey]; if (entry && entry.id) { if (!cidLookup[entry.id]) cidLookup[entry.id] = new Set(); cidLookup[entry.id].add(nameKey); } }); 
            const expandedSet = new Set(allNames); allNames.forEach(name => { const entry = nameDb[name]; if (entry && entry.id) { const siblings = cidLookup[entry.id]; if (siblings) { siblings.forEach(sName => expandedSet.add(sName)); } } }); allNames = Array.from(expandedSet).sort(); 
            
            const moveRows = document.getElementById('page-move-tbody').querySelectorAll('tr'); moveRows.forEach(row => { const toWrap = row.querySelector('.input-wrap.w-move-to .custom-select-wrapper'); if(toWrap) { toWrap.dataset.options = JSON.stringify(allLocations.map(l => ({ val: l, text: l }))); } });
            
            const autoLocWrap = document.getElementById('wrap-auto-loc');
            if(autoLocWrap) {
                autoLocWrap.dataset.options = JSON.stringify(allLocations.map(l => ({ val: l, text: l })));
            }

            const addRows = document.getElementById('page-add-tbody').querySelectorAll('tr'); 
            addRows.forEach(row => { 
                const locInput = row.querySelector('.page-card-loc');
                if(locInput) {
                    const locWrap = locInput.closest('.custom-select-wrapper');
                    if(locWrap) { 
                        locWrap.dataset.options = JSON.stringify(allLocations.map(l => ({ val: l, text: l }))); 
                        if (allLocations.length > 0) locWrap.classList.remove('no-option'); 
                    }
                }
            });
            updateDisconnectBtn();
            updateRarityInputs(); 
        } 
    } catch (e) { showLoading(false); } 
}

function startSearch() { 
    if (!localStorage.getItem(STORAGE_KEY)) { showToast('구글 시트 연결이 필요합니다.', 'warning-yellow black-text'); switchToMode('settings'); toggleGuide(true); return; } 
    const name = document.getElementById('card-search').value; if(!name || !isAppConfigured) return; 
    saveRecentSearch(name); 
    let targetNames = new Set(); if (nameDb[name] && nameDb[name].id) { const cid = nameDb[name].id; if (cidLookup[cid]) { targetNames = cidLookup[cid]; } else { targetNames.add(name); } } else { targetNames.add(name); } 
    const filteredRows = localCardDatabase.filter(row => targetNames.has(String(row[0]))); 
    if (currentMode === 'search') {
        const wrapper = document.getElementById('content-slider-wrapper'); const resultArea = document.getElementById('result-area'); const oldHeight = wrapper.offsetHeight; wrapper.style.height = oldHeight + 'px';
        const ghost = resultArea.cloneNode(true); ghost.id = 'result-ghost'; ghost.style.position = 'absolute'; ghost.style.top = '0'; ghost.style.left = '0'; ghost.style.right = '0'; ghost.style.marginLeft = 'auto'; ghost.style.marginRight = 'auto'; ghost.style.marginTop = '0'; ghost.style.paddingTop = '30px'; ghost.style.width = '100%'; ghost.style.maxWidth = '700px'; ghost.style.zIndex = '5'; ghost.style.transition = 'opacity 0.4s ease';
        wrapper.appendChild(ghost); renderTable(filteredRows); resultArea.style.opacity = '0'; resultArea.style.transition = 'opacity 0.4s ease';
        const newHeight = resultArea.offsetHeight; requestAnimationFrame(() => { wrapper.style.height = newHeight + 'px'; ghost.style.opacity = '0'; resultArea.style.opacity = '1'; });
        setTimeout(() => { if(ghost.parentNode) ghost.parentNode.removeChild(ghost); wrapper.style.height = ''; resultArea.style.opacity = ''; resultArea.style.transition = ''; }, 400);
    } else { renderTable(filteredRows); switchToMode('search'); }
    document.getElementById('custom-dropdown').style.display = 'none'; toggleSearchWrapper(false); checkClearBtn(); showLoading(false); 
}

function renderTable(rows) { 
    const resultArea = document.getElementById('result-area'); 
    if (rows.length === 0) { resultArea.innerHTML = "<p class='center'>결과 없음</p>"; return; } 
    const groups = {}; 
    rows.forEach(r => { 
        const cardNo = String(r[1]), proc = String(r[2]), qty = parseInt(r[3]) || 0, loc = String(r[4]);
        const another = String(r[5] || "기본").trim(); 
        if (!groups[cardNo]) groups[cardNo] = { locations: {}, anotherGroups: {} }; 
        if (!groups[cardNo].locations[loc]) groups[cardNo].locations[loc] = { total: 0, procs: {} }; 
        groups[cardNo].locations[loc].total += qty; groups[cardNo].locations[loc].procs[proc] = (groups[cardNo].locations[loc].procs[proc] || 0) + qty; 
        const aKey = `${another}|${loc}`; 
        if (!groups[cardNo].anotherGroups[aKey]) groups[cardNo].anotherGroups[aKey] = { another, loc, total: 0, procs: {} }; 
        groups[cardNo].anotherGroups[aKey].total += qty; groups[cardNo].anotherGroups[aKey].procs[proc] = (groups[cardNo].anotherGroups[aKey].procs[proc] || 0) + qty; 
    }); 
    
    let newHtml = ""; 
    Object.keys(groups).forEach(cardNo => { 
        const rowId = `row-${cardNo}`.replace(/[^a-zA-Z0-9]/g, ''); 
        const cardRows = rows.filter(r => String(r[1]) === cardNo); 
        const totalQty = cardRows.reduce((sum, r) => sum + (parseInt(r[3]) || 0), 0); 
        const locSet = new Set(cardRows.map(r => String(r[4])).filter(l => l)); 
        const distinctKeys = [...new Set(cardRows.map(r => String(r[2]).trim()).filter(k => k))]; 
        
        distinctKeys.sort(compareRarity); 
        
        const displayNamesForSummary = [...new Set(distinctKeys.map(k => {
             let idx = rarityReverseMap[k];
             let row = (idx !== undefined) ? rarityRows[idx] : null;
             return (row && row[rarityColMap['display']]) ? row[rarityColMap['display']] : k;
        }))];
        
        const procStr = displayNamesForSummary.join(", "); 
        const locStr = [...locSet].join(", "); 
        
        const anotherGroups = {}; 
        cardRows.forEach(r => { 
            const another = String(r[5] || "기본").trim(); 
            if(!anotherGroups[another]) anotherGroups[another] = []; 
            anotherGroups[another].push(r); 
        }); 
        
        let leftTableHtml = `<table class="split-table"><thead><tr><th class="fp-col-1">일러스트</th><th class="fp-col-2">보관 위치</th><th class="fp-col-3">총 수량</th></tr></thead><tbody>`; 
        let rightTableHtml = `<table class="split-table"><thead><tr>`; 
        
        distinctKeys.forEach(key => { 
            let displayName = key;
            let tooltipContent = key;
            let idx = rarityReverseMap[key];
            
            if (idx !== undefined) {
                let row = rarityRows[idx];
                if(row) {
                    displayName = row[rarityColMap['display']] || key;
                    let localName = row[rarityColMap[currentRegion]];
                    if(localName && localName !== "") {
                        tooltipContent = localName;
                    } else {
                        tooltipContent = key;
                    }
                }
            }
            
            tooltipContent = String(tooltipContent).replace(/\(/g, '<br>('); 
            rightTableHtml += `<th class="sp-col tooltipped" data-key="${key}" data-index="${idx !== undefined ? idx : ''}" data-position="top" data-tooltip="${tooltipContent}">${displayName}</th>`; 
        }); 
        rightTableHtml += `</tr></thead><tbody>`; 
        
        const anotherKeys = Object.keys(anotherGroups).sort((a, b) => { if (a === "기본") return -1; if (b === "기본") return 1; return a.localeCompare(b, undefined, { numeric: true }); }); 
        anotherKeys.forEach(another => { 
            const grpRows = anotherGroups[another]; const locGroups = {}; 
            grpRows.forEach(r => { const loc = String(r[4]); const proc = String(r[2]); const qty = parseInt(r[3]) || 0; if(!locGroups[loc]) locGroups[loc] = { total: 0, procs: {} }; locGroups[loc].total += qty; locGroups[loc].procs[proc] = (locGroups[loc].procs[proc] || 0) + qty; }); 
            const locKeys = Object.keys(locGroups); 
            locKeys.forEach((loc, idx) => { const d = locGroups[loc]; leftTableHtml += `<tr>`; if(idx === 0) leftTableHtml += `<td rowspan="${locKeys.length}">${another}</td>`; leftTableHtml += `<td>${loc}</td><td>${d.total}</td></tr>`; rightTableHtml += `<tr>`; distinctKeys.forEach(key => { const val = d.procs[key] || 0; rightTableHtml += `<td>${val}</td>`; }); rightTableHtml += `</tr>`; }); 
        }); 
        leftTableHtml += `</tbody></table>`; rightTableHtml += `</tbody></table>`; 
        newHtml += ` <div class="new-card-box"> <div class="summary-split-wrapper"> <div class="summary-left">${cardNo}</div> <div class="summary-right"> <table class="summary-table"> <tr><td class="summary-label-cell">보관 위치</td><td class="summary-label-cell">수량</td></tr> <tr><td class="summary-value-cell">${locStr}</td><td class="summary-value-cell">${totalQty}</td></tr> <tr><td class="summary-label-cell border-double-top">보유 레어도</td><td class="summary-value-cell border-double-top">${procStr}</td></tr> </table> </div> </div> <div id="detail-${rowId}" class="detail-slide-wrapper"> <div class="split-table-wrapper"> <div class="fixed-side">${leftTableHtml}</div> <div class="scroll-side">${rightTableHtml}</div> </div> </div> <button class="show-more-btn" onclick="toggleNewDetail('detail-${rowId}')"><span>자세히 보기</span><i class="material-icons tiny">keyboard_arrow_down</i></button> </div> `; 
    }); 
    resultArea.innerHTML = newHtml; 
    M.Tooltip.init(resultArea.querySelectorAll('.tooltipped'), { html: true, margin: 3 }); 
}

function toggleNewDetail(detailId) {
    const content = document.getElementById(detailId);
    const btn = content.nextElementSibling;
    const textSpan = btn.querySelector('span');
    const icon = btn.querySelector('i');
    if (content.style.maxHeight) { content.style.maxHeight = null; textSpan.innerText = '자세히 보기'; icon.innerText = 'keyboard_arrow_down'; } else { content.style.maxHeight = content.scrollHeight + "px"; textSpan.innerText = '간략히 보기'; icon.innerText = 'keyboard_arrow_up'; }
}

function showLoading(show, text) { const overlay = document.getElementById('loading-overlay'); const loadingText = document.getElementById('loading-text'); if(overlay) { if (show) { overlay.style.display = 'flex'; loadingText.innerText = text; document.body.classList.add('is-loading'); } else { overlay.style.display = 'none'; document.body.classList.remove('is-loading'); } } }

async function handleContinueRegistration() { 
    M.Modal.getInstance(document.getElementById('add-result-modal')).close(); 
    toggleBackgroundInert(false);
    const tbody = document.getElementById('page-add-tbody'); 
    const rows = Array.from(tbody.children); 
    let hasFailures = false; let hasSuccess = false; 
    for (let i = rows.length - 1; i >= 0; i--) { 
        const row = rows[i]; 
        const cardNoVal = row.querySelector('.page-card-no').value.trim();
        if (row.dataset.status === 'success' || !cardNoVal) { 
            tbody.removeChild(row); hasSuccess = true; 
        } else { 
            hasFailures = true; delete row.dataset.status; 
        } 
    }
    if (!hasFailures || tbody.children.length === 0) { addPageEntry(); } reindexRows();
    
    if (hasSuccess) {
        if (syncCounter >= 9) {
            syncCounter = 0;
            await refreshInitialData();
        }
    }
}

function initPageMove() { const tbody = document.getElementById('page-move-tbody'); if(tbody && tbody.children.length === 0) { addMoveEntry(); } }
function adjustMoveCount(delta) { rowMoveCount += delta; if(rowMoveCount < 1) rowMoveCount = 1; document.getElementById('add-move-count').innerText = rowMoveCount + "건"; }

function addMoveEntry() {
    const tbody = document.getElementById('page-move-tbody');
    const currentCount = tbody.querySelectorAll('tr').length;
    const nextNum = currentCount + 1;
    const isOdd = nextNum % 2 !== 0;
    const groupClass = isOdd ? 'odd' : 'even';

    const tr = document.createElement('tr');
    tr.className = `entry-row entry-group ${groupClass}`;
    
    tr.innerHTML = `
        <td class="no-cell">${nextNum}</td>
        <td class="content-cell">
            <div class="content-wrapper">
                <div class="move-row-top">
                    <div class="name-area">
                      <div class="custom-select-wrapper no-arrow" id="wrap-move-name-${nextNum}">
                          <input type="text" class="custom-input card-name-input" placeholder="카드 이름" oninput="handleMoveNameInput(this)" autocomplete="off">
                          <i class="material-icons arrow-icon">arrow_drop_down</i>
                      </div>
                    </div>
                    <div class="no-area">
                      <div class="custom-select-wrapper no-arrow" id="wrap-move-no-${nextNum}">
                          <input type="text" class="custom-input move-card-no" oninput="handleMoveNoInput(this)" onblur="validateMoveNoInput(this)" onkeydown="if(event.key==='Enter') validateMoveNoInput(this)" placeholder="카드 번호" autocomplete="off">
                          <i class="material-icons arrow-icon">arrow_drop_down</i>
                      </div>
                    </div>
                </div>
                <div class="move-row-mid">
                    <div class="input-wrap w-move-illust">
                        <div class="custom-select-wrapper no-option" id="wrap-illust-${nextNum}" data-type="strict">
                            <input type="text" class="custom-input move-card-another" placeholder="일러스트" readonly>
                            <i class="material-icons arrow-icon">arrow_drop_down</i>
                        </div>
                    </div>
                    <div class="input-wrap w-move-rare">
                        <div class="custom-select-wrapper no-option" id="wrap-rare-${nextNum}" data-type="strict">
                            <input type="text" class="custom-input move-card-proc" placeholder="레어도" readonly>
                            <i class="material-icons arrow-icon">arrow_drop_down</i>
                        </div>
                    </div>
                </div>
                <div class="move-row-bot">
                    <div class="input-wrap w-move-from">
                        <div class="custom-select-wrapper no-option" id="wrap-from-${nextNum}" data-type="strict">
                            <input type="text" class="custom-input move-card-from" placeholder="보관위치">
                            <i class="material-icons arrow-icon">arrow_drop_down</i>
                        </div>
                    </div>
                    <div class="arrow-cell">►</div>
                    <div class="input-wrap w-move-qty"><input type="number" class="move-card-qty" min="1" placeholder="수량"></div>
                    <div class="arrow-cell">►</div>
                    <div class="input-wrap w-move-to">
                        <div class="custom-select-wrapper" id="wrap-to-${nextNum}" data-type="free">
                            <input type="text" class="custom-input move-card-to" placeholder="이동위치">
                            <i class="material-icons arrow-icon">arrow_drop_down</i>
                        </div>
                    </div>
                </div>
            </div>
        </td>
        <td class="col-delete" tabindex="0" onclick="deleteMoveEntry(this)" onkeydown="if(event.key==='Enter') deleteMoveEntry(this)"><i class="material-icons">delete</i></td>
    `;

    tbody.appendChild(tr);
    setupCustomDropdown(tr.querySelector(`#wrap-illust-${nextNum}`), handleMoveIllustChange);
    setupCustomDropdown(tr.querySelector(`#wrap-rare-${nextNum}`), handleMoveRareChange);
    setupCustomDropdown(tr.querySelector(`#wrap-from-${nextNum}`), handleMoveLocChange);
    setupCustomDropdown(tr.querySelector(`#wrap-to-${nextNum}`), null);
    setupCardNoAutocomplete(tr.querySelector(`#wrap-move-no-${nextNum}`));
    setupCardNameAutocomplete(tr.querySelector(`#wrap-move-name-${nextNum}`));

    const toWrap = tr.querySelector(`#wrap-to-${nextNum}`);
    if(toWrap && typeof allLocations !== 'undefined') { toWrap.dataset.options = JSON.stringify(allLocations.map(l => ({ val: l, text: l }))); }

    const fromInput = tr.querySelector('.move-card-from');
    fromInput.addEventListener('input', function() { const rareVal = tr.querySelector('.move-card-proc').value; if (!rareVal) { this.value = ""; return; } });

    const qtyInput = tr.querySelector('.move-card-qty');
    qtyInput.addEventListener('input', function() { const fromVal = tr.querySelector('.move-card-from').value; if (!fromVal) { this.value = ""; return; } const max = parseInt(this.max); const current = parseInt(this.value); if (!isNaN(max) && current > max) { this.value = max; } });

    reindexMoveRows();
    return tr;
}

function handleMoveNameInput(input) {
    const row = input.closest('tr');
    const noInput = row.querySelector('.move-card-no');
    const nameVal = input.value.trim();
    if (!input.dataset.programmatic) { noInput.dataset.programmatic = "true"; noInput.value = ""; handleMoveNoInput(noInput); delete noInput.dataset.programmatic; }
    if (nameToNosMap[nameVal]) { const matchedNos = nameToNosMap[nameVal]; if (matchedNos.length === 1) { noInput.value = matchedNos[0]; noInput.dataset.programmatic = "true"; handleMoveNoInput(noInput); validateMoveNoInput(noInput); delete noInput.dataset.programmatic; } }
}

function validateMoveNoInput(input) {
    const val = input.value.trim().toUpperCase();
    const row = input.closest('tr');
    const nameInput = row.querySelector('.card-name-input');
    if (!val) { resetMoveRow(row, 'no'); return; }
    if (!ownedCardNumbers.includes(val)) { input.value = ""; input.placeholder = "번호 확인!"; input.classList.add('error-placeholder'); setTimeout(() => { input.placeholder = "카드 번호"; input.classList.remove('error-placeholder'); }, 5000); resetMoveRow(row, 'no'); } 
    else { const matches = localCardDatabase.filter(r => String(r[1]).trim().toUpperCase() === val); if (matches.length > 0) { const name = matches[0][0]; nameInput.dataset.programmatic = "true"; nameInput.value = name; delete nameInput.dataset.programmatic; updateMoveIllusts(row, matches); } }
}

function setupCardNameAutocomplete(wrapper) {
    const input = wrapper.querySelector('input');
    const globalDropdown = document.getElementById('global-custom-options');
    let currentFocusIdx = -1;
    const closeDropdown = () => { wrapper.classList.remove('active'); globalDropdown.style.display = 'none'; currentFocusIdx = -1; };
    
    const renderDropdown = (filtered) => {
        if (filtered.length === 0) { closeDropdown(); return; }
        wrapper.classList.add('active');
        const rect = wrapper.getBoundingClientRect(); globalDropdown.style.top = (rect.bottom + window.scrollY) + 'px'; globalDropdown.style.left = (rect.left + window.scrollX) + 'px'; globalDropdown.style.width = rect.width + 'px';
        globalDropdown.innerHTML = "";
        filtered.forEach(name => { const li = document.createElement('li'); li.className = 'custom-option'; li.innerText = name; li.onmousedown = (e) => e.preventDefault(); li.onclick = () => { input.value = name; closeDropdown(); 
            if(input.classList.contains('card-name-input') && input.closest('tr').querySelector('.discard-card-no')) {
                handleDiscardNameInput(input);
            } else if(input.classList.contains('card-name-input')) {
                handleMoveNameInput(input);
            }
        }; globalDropdown.appendChild(li); });
        globalDropdown.style.display = 'block';
    };

    input.addEventListener('input', () => { 
        const val = input.value.trim(); 
        if (!val) { closeDropdown(); return; } 
        const normalized = normalizeStr(val); 
        const decomposed = decomposeHangul(normalized); 

        const ownedNamesSet = new Set(localCardDatabase.filter(r => (parseInt(r[3]) || 0) > 0).map(r => String(r[0])));
        
        let matches = allNames.filter(name => { 
            if (!ownedNamesSet.has(name)) return false;
            const normName = normalizeStr(name); 
            const decompName = decomposeHangul(normName); 
            return decompName.includes(decomposed); 
        });
        
        matches = matches.slice(0, 5); 
        renderDropdown(matches); 
    });
    
    input.addEventListener('focus', () => { 
        if (pendingBlurFn) { clearTimeout(pendingBlurFn); pendingBlurFn = null; } 
        const val = input.value.trim(); 
        if (val) { 
            const normalized = normalizeStr(val); 
            const decomposed = decomposeHangul(normalized); 
            
            const ownedNamesSet = new Set(localCardDatabase.filter(r => (parseInt(r[3]) || 0) > 0).map(r => String(r[0])));
            
            let matches = allNames.filter(name => { 
                if (!ownedNamesSet.has(name)) return false;
                const normName = normalizeStr(name); 
                const decompName = decomposeHangul(normName); 
                return decompName.includes(decomposed); 
            });
            
            matches = matches.slice(0, 5); 
            renderDropdown(matches); 
        } else { 
            const ownedNamesSet = new Set(localCardDatabase.filter(r => (parseInt(r[3]) || 0) > 0).map(r => String(r[0])));
            let source = allNames.filter(name => ownedNamesSet.has(name));
            if(source.length > 0) renderDropdown(source.slice(0, 5)); 
        } 
    });
    input.addEventListener('blur', () => { const logic = () => closeDropdown(); pendingBlurFn = setTimeout(logic, 200); });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') {
            if (globalDropdown.style.display === 'block') {
                 let selectedVal = null; const items = globalDropdown.querySelectorAll('li');
                 if (currentFocusIdx > -1 && items[currentFocusIdx]) { selectedVal = items[currentFocusIdx].innerText; } else if (items.length > 0) { selectedVal = items[0].innerText; }
                 if (selectedVal) { 
                     input.value = selectedVal; 
                     if(input.closest('tr').querySelector('.discard-card-no')) handleDiscardNameInput(input);
                     else handleMoveNameInput(input); 
                 }
                 closeDropdown();
            } return; 
        }
        if (globalDropdown.style.display === 'none') return;
        const items = globalDropdown.querySelectorAll('li');
        if (e.key === 'ArrowDown') { e.preventDefault(); currentFocusIdx++; if (currentFocusIdx >= items.length) currentFocusIdx = 0; updateHighlight(items); } 
        else if (e.key === 'ArrowUp') { e.preventDefault(); currentFocusIdx--; if (currentFocusIdx < 0) currentFocusIdx = items.length - 1; updateHighlight(items); } 
        else if (e.key === 'Enter') { if (currentFocusIdx > -1 && items[currentFocusIdx]) { e.preventDefault(); items[currentFocusIdx].click(); } } 
        else if (e.key === 'Escape') { closeDropdown(); }
    });
    function updateHighlight(items) { items.forEach(i => i.classList.remove('selected')); if (items[currentFocusIdx]) { items[currentFocusIdx].classList.add('selected'); items[currentFocusIdx].scrollIntoView({ block: 'nearest' }); } }
}

function setupCardNoAutocomplete(wrapper) {
    const input = wrapper.querySelector('input');
    const globalDropdown = document.getElementById('global-custom-options');
    let currentFocusIdx = -1;
    const closeDropdown = () => { wrapper.classList.remove('active'); globalDropdown.style.display = 'none'; currentFocusIdx = -1; };
    const renderDropdown = (filtered) => {
        if (filtered.length === 0) { closeDropdown(); return; }
        wrapper.classList.add('active');
        const rect = wrapper.getBoundingClientRect(); globalDropdown.style.top = (rect.bottom + window.scrollY) + 'px'; globalDropdown.style.left = (rect.left + window.scrollX) + 'px'; globalDropdown.style.width = rect.width + 'px';
        globalDropdown.innerHTML = "";
        filtered.forEach(no => { const li = document.createElement('li'); li.className = 'custom-option'; li.innerText = no; li.onmousedown = (e) => e.preventDefault(); li.onclick = () => { input.value = no; closeDropdown(); 
            if(input.classList.contains('discard-card-no')) validateDiscardNoInput(input);
            else validateMoveNoInput(input); 
        }; globalDropdown.appendChild(li); });
        globalDropdown.style.display = 'block';
    };
    
    const isDiscard = wrapper.id && wrapper.id.startsWith('wrap-discard');

    input.addEventListener('input', () => { 
        const val = input.value.trim(); const row = input.closest('tr'); const nameVal = row.querySelector('.card-name-input') ? row.querySelector('.card-name-input').value.trim() : ""; 
        let source = ownedCardNumbers; 
        if (nameVal && nameToNosMap[nameVal]) { source = nameToNosMap[nameVal]; } 
        
        if(isDiscard) {
            source = source.filter(no => !isCardDepleted(no, null)); 
        }

        if (!val && !nameVal) { closeDropdown(); return; } 
        const matches = source.filter(no => no.includes(val.toUpperCase())).slice(0, 5); renderDropdown(matches); 
    });
    
    input.addEventListener('focus', () => { 
        if (pendingBlurFn) { clearTimeout(pendingBlurFn); pendingBlurFn = null; } 
        const val = input.value.trim().toUpperCase(); const row = input.closest('tr'); const nameVal = row.querySelector('.card-name-input') ? row.querySelector('.card-name-input').value.trim() : ""; 
        let source = ownedCardNumbers; 
        if (nameVal && nameToNosMap[nameVal]) { source = nameToNosMap[nameVal]; } 
        
        if(isDiscard) {
            source = source.filter(no => !isCardDepleted(no, null));
        }

        if (val || nameVal) { const matches = source.filter(no => no.includes(val)).slice(0, 5); renderDropdown(matches); } 
        else { if(source.length > 0) renderDropdown(source.slice(0, 5)); } 
    });
    input.addEventListener('blur', () => { const logic = () => { closeDropdown(); 
        if(input.classList.contains('discard-card-no')) validateDiscardNoInput(input);
        else if(input.classList.contains('move-card-no')) validateMoveNoInput(input); 
    }; pendingBlurFn = setTimeout(logic, 200); });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') {
            if (globalDropdown.style.display === 'block') {
                 let selectedVal = null; const items = globalDropdown.querySelectorAll('li');
                 if (currentFocusIdx > -1 && items[currentFocusIdx]) { selectedVal = items[currentFocusIdx].innerText; } else if (items.length > 0) { selectedVal = items[0].innerText; }
                 if (selectedVal) { 
                     input.value = selectedVal; 
                     if(input.classList.contains('discard-card-no')) validateDiscardNoInput(input);
                     else if(input.classList.contains('move-card-no')) validateMoveNoInput(input); 
                 }
                 closeDropdown();
            } return; 
        }
        if (globalDropdown.style.display === 'none') return;
        const items = globalDropdown.querySelectorAll('li');
        if (e.key === 'ArrowDown') { e.preventDefault(); currentFocusIdx++; if (currentFocusIdx >= items.length) currentFocusIdx = 0; updateHighlight(items); } 
        else if (e.key === 'ArrowUp') { e.preventDefault(); currentFocusIdx--; if (currentFocusIdx < 0) currentFocusIdx = items.length - 1; updateHighlight(items); } 
        else if (e.key === 'Enter') { if (currentFocusIdx > -1 && items[currentFocusIdx]) { e.preventDefault(); items[currentFocusIdx].click(); } } 
        else if (e.key === 'Escape') { closeDropdown(); }
    });
    function updateHighlight(items) { items.forEach(i => i.classList.remove('selected')); if (items[currentFocusIdx]) { items[currentFocusIdx].classList.add('selected'); items[currentFocusIdx].scrollIntoView({ block: 'nearest' }); } }
}

function setupCustomDropdown(wrapper, changeCallback) {
    const input = wrapper.querySelector('.custom-input');
    const isFreeType = wrapper.dataset.type === 'free';
    let currentFocusIdx = -1;
    const globalDropdown = document.getElementById('global-custom-options');
    const closeDropdown = () => { wrapper.classList.remove('active'); globalDropdown.style.display = 'none'; currentFocusIdx = -1; activeDropdownInput = null; };
    const openDropdown = () => {
        if (pendingBlurFn) { clearTimeout(pendingBlurFn); pendingBlurFn = null; }
        if (input.hasAttribute('readonly') && !input.value && (!wrapper.dataset.options || wrapper.dataset.options === "[]") && !isFreeType) return; 
        if (input.disabled) return;
        if (activeDropdownInput && activeDropdownInput !== input) { activeDropdownInput.blur(); }
        activeDropdownInput = input;
        
        if (input.classList.contains('move-card-from')) { updateFromLocOptionsDynamic(wrapper); }
        else if (input.classList.contains('discard-card-another')) { updateDiscardIllustsDynamic(wrapper); }
        else if (input.classList.contains('discard-card-proc')) { updateDiscardRaritiesDynamic(wrapper); }
        else if (input.classList.contains('discard-card-loc')) { updateDiscardLocationsDynamic(wrapper); } 

        const rawData = JSON.parse(wrapper.dataset.options || "[]");
        if (!isFreeType && rawData.length === 0) return;
        if (rawData.length === 1 && !isFreeType) { return; }
        wrapper.classList.add('active'); renderGlobalDropdown(false); 
    };
    const renderGlobalDropdown = (useFilter = true) => {
        if (!wrapper.classList.contains('active')) return;
        const rawData = JSON.parse(wrapper.dataset.options || "[]");
        const query = input.value;
        const normalized = normalizeStr(query);
        const decomposed = decomposeHangul(normalized);
        let filtered = rawData;
        if (input.classList.contains('move-card-to')) {
            const row = input.closest('tr'); const fromInput = row.querySelector('.move-card-from'); const fromVal = fromInput ? fromInput.value : "";
            if (fromVal) { filtered = filtered.filter(opt => opt.val !== fromVal); }
        }
        if (useFilter && query) { filtered = filtered.filter(opt => decomposeHangul(normalizeStr(opt.text)).includes(decomposed)); }
        const rect = wrapper.getBoundingClientRect(); globalDropdown.style.top = (rect.bottom + window.scrollY) + 'px'; globalDropdown.style.left = (rect.left + window.scrollX) + 'px'; globalDropdown.style.width = rect.width + 'px';
        globalDropdown.innerHTML = "";
        if (filtered.length === 0) { const li = document.createElement('li'); li.className = 'custom-option'; li.style.color = 'var(--text-muted)'; li.style.cursor = 'default'; li.innerText = '일치하는 항목 없음'; globalDropdown.appendChild(li); } 
        else { filtered.forEach((opt, idx) => { const li = document.createElement('li'); li.className = 'custom-option'; if (opt.text === input.value) li.classList.add('selected'); li.innerText = opt.text; li.dataset.val = opt.val; if (opt.max) li.dataset.max = opt.max; li.onmousedown = (e) => e.preventDefault(); li.onclick = () => selectOption(opt); globalDropdown.appendChild(li); }); }
        globalDropdown.style.display = 'block';
    };
    const selectOption = (optData) => { 
        if (input.classList.contains('move-card-from') || input.classList.contains('discard-card-loc')) {
            input.value = optData.val; 
        } else {
            input.value = optData.text; 
        }

        input.dataset.raw = optData.val; 
        if (optData.max) { input.dataset.maxQty = optData.max; } 
        closeDropdown(); 
        if (changeCallback) changeCallback(input); 
    };
    const updateFromLocOptionsDynamic = (wrap) => {
        const row = wrap.closest('tr'); const cardNo = row.querySelector('.move-card-no').value.trim(); const illust = row.querySelector('.move-card-another').value; 
        
        const rareInput = row.querySelector('.move-card-proc');
        let rareRaw = rareInput.dataset.raw;
        
        if (!rareRaw && rareInput.value) {
            const currentVal = rareInput.value;
            const potentialMatches = localCardDatabase.filter(r => String(r[1]).trim().toUpperCase() === cardNo && String(r[5] || "기본").trim() === illust);
            const matchedRow = potentialMatches.find(r => getLocalizedRarity(r[2]) === currentVal);
            if (matchedRow) rareRaw = matchedRow[2];
        }
        
        const rare = rareRaw; 

        const matches = localCardDatabase.filter(r => String(r[1]).trim().toUpperCase() === cardNo && String(r[5] || "기본").trim() === illust && String(r[2]).trim() === rare);
        const locMap = {};
        matches.forEach(r => { const loc = String(r[4]).trim(); const qty = parseInt(r[3]) || 0; if (qty > 0) locMap[loc] = (locMap[loc] || 0) + qty; });
        const validLocs = [];
        Object.keys(locMap).forEach(loc => { const avail = getAvailableQty(cardNo, illust, rare, loc, row); if (avail > 0) { validLocs.push({ val: loc, text: `${loc} (잔여: ${avail})`, max: avail }); } });
        validLocs.sort((a,b) => a.val.localeCompare(b.val));
        wrap.dataset.options = JSON.stringify(validLocs);
        if (validLocs.length === 1) wrap.classList.add('single-option'); else wrap.classList.remove('single-option');
        if (validLocs.length === 0) wrap.classList.add('no-option'); else wrap.classList.remove('no-option');
    };

    input.addEventListener('focus', openDropdown); input.addEventListener('click', openDropdown);
    input.addEventListener('blur', () => {
        const logic = () => {
            if (input.classList.contains('move-card-to')) {
                const row = input.closest('tr'); const fromInput = row.querySelector('.move-card-from');
                if (fromInput) { const val = input.value.trim(); const fromVal = fromInput.value.trim(); if (val && fromVal && normalizeStr(val) === normalizeStr(fromVal)) { input.value = ""; } }
            }
            const rawData = JSON.parse(wrapper.dataset.options || "[]"); const query = input.value.trim();
            if (!query) { if (rawData.length === 1 && !isFreeType) { selectOption(rawData[0]); } else if (!isFreeType) { input.value = ""; if (changeCallback) changeCallback(input); } closeDropdown(); return; }
            const normalized = normalizeStr(query); const decomposed = decomposeHangul(normalized);
            let filtered = rawData;
            if (input.classList.contains('move-card-to')) { const row = input.closest('tr'); const fromInput = row.querySelector('.move-card-from'); const fromVal = fromInput ? fromInput.value : ""; if (fromVal) { filtered = filtered.filter(opt => opt.val !== fromVal); } }
            filtered = filtered.filter(opt => decomposeHangul(normalizeStr(opt.text)).includes(decomposed));
            if (filtered.length > 0) { selectOption(filtered[0]); } else { if (rawData.length === 1 && !isFreeType) { selectOption(rawData[0]); } else if (!isFreeType) { input.value = ""; if (changeCallback) changeCallback(input); } closeDropdown(); }
        }; pendingBlurFn = setTimeout(logic, 200);
    });
    input.addEventListener('input', (e) => { 
        delete input.dataset.raw;
        const rawData = JSON.parse(wrapper.dataset.options || "[]"); if (rawData.length === 1 && !isFreeType) { input.value = rawData[0].val; return; } if (!wrapper.classList.contains('active')) wrapper.classList.add('active'); currentFocusIdx = -1; renderGlobalDropdown(true); 
    });
    input.addEventListener('keydown', (e) => {
        if (!wrapper.classList.contains('active')) { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { openDropdown(); return; } }
        const items = globalDropdown.querySelectorAll('li:not([style*="default"])');
        if (e.key === 'ArrowDown') { e.preventDefault(); currentFocusIdx++; if (currentFocusIdx >= items.length) currentFocusIdx = 0; updateHighlight(items); } 
        else if (e.key === 'ArrowUp') { e.preventDefault(); currentFocusIdx--; if (currentFocusIdx < 0) currentFocusIdx = items.length - 1; updateHighlight(items); } 
        else if (e.key === 'Enter') { e.preventDefault(); if (currentFocusIdx > -1 && items[currentFocusIdx]) { items[currentFocusIdx].click(); } else { input.blur(); } } 
        else if (e.key === 'Escape') { e.preventDefault(); input.value = ""; input.blur(); closeDropdown(); } 
        else if (e.key === 'Tab') {
             const rawData = JSON.parse(wrapper.dataset.options || "[]"); const query = input.value.trim(); const normalized = normalizeStr(query); const decomposed = decomposeHangul(normalized);
             let filtered = rawData;
             if (input.classList.contains('move-card-to')) { const row = input.closest('tr'); const fromInput = row.querySelector('.move-card-from'); const fromVal = fromInput ? fromInput.value : ""; if (fromVal) { filtered = filtered.filter(opt => opt.val !== fromVal); } }
             if(query) { filtered = filtered.filter(opt => decomposeHangul(normalizeStr(opt.text)).includes(decomposed)); }
             if (currentFocusIdx > -1 && items[currentFocusIdx]) { const opt = { val: items[currentFocusIdx].dataset.val, text: items[currentFocusIdx].innerText, max: items[currentFocusIdx].dataset.max }; selectOption(opt); } else if (filtered.length > 0) { selectOption(filtered[0]); } else if (!isFreeType && rawData.length === 1) { selectOption(rawData[0]); } else if (!isFreeType) { input.value = ""; if (changeCallback) changeCallback(input); }
             if(pendingBlurFn) { clearTimeout(pendingBlurFn); pendingBlurFn = null; } closeDropdown();
        }
    });
    function updateHighlight(items) { items.forEach(i => i.classList.remove('selected')); if (items[currentFocusIdx]) { items[currentFocusIdx].classList.add('selected'); items[currentFocusIdx].scrollIntoView({ block: 'nearest' }); } }
}

function deleteMoveEntry(btn) { const row = btn.closest('tr'); const tbody = document.getElementById('page-move-tbody'); if (tbody.querySelectorAll('tr').length <= 1) return; tbody.removeChild(row); reindexMoveRows(); }
function reindexMoveRows() { const tbody = document.getElementById('page-move-tbody'); const rows = tbody.querySelectorAll('tr'); rows.forEach((row, index) => { const num = index + 1; row.querySelector('.no-cell').innerText = num; row.classList.remove('odd', 'even'); row.classList.add((num % 2 !== 0) ? 'odd' : 'even'); const delBtn = row.querySelector('.col-delete'); if (rows.length <= 1) delBtn.classList.add('disabled'); else delBtn.classList.remove('disabled'); }); }
function handleMoveNoInput(input) {
    const row = input.closest('tr'); const start = input.selectionStart; input.value = input.value.replace(/[ㄱ-ㅎ|ㅏ-ㅣ|가-힣]/g, '').toUpperCase(); input.setSelectionRange(start, start);
    if (!input.dataset.programmatic) { const nameInput = row.querySelector('.card-name-input'); nameInput.value = ""; }
    const cardNo = input.value.trim().toUpperCase();
    if (!cardNo) { resetMoveRow(row, 'no'); return; }
    const matches = localCardDatabase.filter(r => String(r[1]).trim().toUpperCase() === cardNo);
    if (matches.length > 0) { updateMoveIllusts(row, matches); } else { resetMoveRow(row, 'no'); }
}
function resetMoveRow(row, level) {
    const illustInp = row.querySelector('.move-card-another'); const rareInp = row.querySelector('.move-card-proc'); const fromInp = row.querySelector('.move-card-from'); const qtyInput = row.querySelector('.move-card-qty');
    const illustWrap = row.querySelector('[id^="wrap-illust"]'); const rareWrap = row.querySelector('[id^="wrap-rare"]'); const fromWrap = row.querySelector('[id^="wrap-from"]');
    illustWrap.classList.remove('single-option'); rareWrap.classList.remove('single-option'); fromWrap.classList.remove('single-option');
    illustWrap.classList.add('no-option'); rareWrap.classList.add('no-option'); fromWrap.classList.add('no-option');
    if (level === 'no') { illustInp.value = ""; illustInp.setAttribute('readonly', true); illustWrap.dataset.options = "[]"; rareInp.value = ""; rareInp.setAttribute('readonly', true); rareWrap.dataset.options = "[]"; fromInp.value = ""; fromWrap.dataset.options = "[]"; qtyInput.value = ''; }
}
function updateMoveIllusts(row, matches) {
    const illustInp = row.querySelector('.move-card-another'); const illustWrap = row.querySelector('[id^="wrap-illust"]');
    const uniqueIllusts = [...new Set(matches.map(r => String(r[5] || "기본").trim()))].sort();
    const options = uniqueIllusts.map(i => ({ val: i, text: i }));
    illustWrap.dataset.options = JSON.stringify(options);
    illustInp.removeAttribute('readonly'); illustWrap.classList.remove('no-option'); 
    const currentVal = illustInp.value; const isValid = options.some(o => o.val === currentVal);
    if (isValid) { handleMoveIllustChange(illustInp); } else { if (options.length === 1) { illustWrap.classList.add('single-option'); illustInp.value = options[0].val; handleMoveIllustChange(illustInp); } else { illustInp.value = ""; illustWrap.classList.remove('single-option'); handleMoveIllustChange(illustInp); } }
}
function handleMoveIllustChange(input) {
    const row = input.closest('tr'); const cardNo = row.querySelector('.move-card-no').value.trim(); const selectedIllust = input.value;
    if (!selectedIllust) { const rareInp = row.querySelector('.move-card-proc'); rareInp.value = ""; handleMoveRareChange(rareInp); return; }
    const dbIllust = selectedIllust;
    const matches = localCardDatabase.filter(r => String(r[1]).trim().toUpperCase() === cardNo && String(r[5] || "기본").trim() === dbIllust);
    updateMoveRarities(row, matches);
}
function updateMoveRarities(row, matches) {
    const rareInp = row.querySelector('.move-card-proc'); const rareWrap = row.querySelector('[id^="wrap-rare"]'); const uniqueRares = [...new Set(matches.map(r => String(r[2]).trim()))].sort(compareRarity); 
    const options = uniqueRares.map(r => ({ val: r, text: getLocalizedRarity(r) }));
    rareWrap.dataset.options = JSON.stringify(options);
    rareInp.removeAttribute('readonly'); rareWrap.classList.remove('no-option'); 
    const currentVal = rareInp.value; const isValid = options.some(o => o.val === currentVal);
    if (isValid) { handleMoveRareChange(rareInp); } else { if (options.length === 1) { rareWrap.classList.add('single-option'); rareInp.value = options[0].text; rareInp.dataset.raw = options[0].val; handleMoveRareChange(rareInp); } else { rareInp.value = ""; delete rareInp.dataset.raw; rareWrap.classList.remove('single-option'); handleMoveRareChange(rareInp); } }
}
function handleMoveRareChange(input) {
    const row = input.closest('tr'); const cardNo = row.querySelector('.move-card-no').value.trim(); const selectedIllust = row.querySelector('.move-card-another').value; const selectedRare = input.dataset.raw || input.value; 
    if (!input.value) { const fromInp = row.querySelector('.move-card-from'); fromInp.value = ""; handleMoveLocChange(fromInp); return; }
    const dbIllust = selectedIllust;
    const matches = localCardDatabase.filter(r => String(r[1]).trim().toUpperCase() === cardNo && String(r[5] || "기본").trim() === dbIllust && String(r[2]).trim() === selectedRare);
    updateMoveLocations(row, matches);
}
function getAvailableQty(cardNo, illust, rare, loc, currentRow) {
    const dbMatches = localCardDatabase.filter(r => String(r[1]).trim().toUpperCase() === cardNo && String(r[5] || "기본").trim() === illust && String(r[2]).trim() === rare && String(r[4]).trim() === loc);
    const totalDbQty = dbMatches.reduce((sum, r) => sum + (parseInt(r[3])||0), 0);
    const allRows = document.getElementById('page-move-tbody').querySelectorAll('tr'); let usedQty = 0;
    allRows.forEach(r => { 
        if (r === currentRow) return; 
        const rNo = r.querySelector('.move-card-no').value.trim().toUpperCase(); 
        const rIllust = r.querySelector('.move-card-another').value; 
        const rRareInput = r.querySelector('.move-card-proc');
        const rRare = rRareInput.dataset.raw || rRareInput.value; 
        const rLoc = r.querySelector('.move-card-from').value; 
        const rQty = parseInt(r.querySelector('.move-card-qty').value) || 0; 
        if (rNo === cardNo && rIllust === illust && rRare === rare && rLoc === loc) { usedQty += rQty; } 
    });
    return Math.max(0, totalDbQty - usedQty);
}
function updateMoveLocations(row, matches) {
    const fromInp = row.querySelector('.move-card-from'); const fromWrap = row.querySelector('[id^="wrap-from"]'); fromInp.removeAttribute('readonly'); fromWrap.classList.remove('no-option'); 
    const cardNo = row.querySelector('.move-card-no').value.trim(); const illust = row.querySelector('.move-card-another').value; 
    
    const rareInput = row.querySelector('.move-card-proc');
    const rare = rareInput.dataset.raw || rareInput.value; 
    
    const locMap = {};
    matches.forEach(r => { const loc = String(r[4]).trim(); const qty = parseInt(r[3]) || 0; if (qty > 0) locMap[loc] = (locMap[loc] || 0) + qty; });
    const validLocs = []; Object.keys(locMap).forEach(loc => { const avail = getAvailableQty(cardNo, illust, rare, loc, row); if (avail > 0) { validLocs.push({ val: loc, text: `${loc} (잔여: ${avail})`, max: avail }); } });
    fromWrap.dataset.options = JSON.stringify(validLocs);
    const currentVal = fromInp.value; const validOption = validLocs.find(o => o.val === currentVal);
    if (validOption) { fromInp.dataset.maxQty = validOption.max; handleMoveLocChange(fromInp); } else { if (validLocs.length === 1) { fromWrap.classList.add('single-option'); fromInp.value = validLocs[0].val; fromInp.dataset.maxQty = validLocs[0].max; handleMoveLocChange(fromInp); } else { fromInp.value = ""; fromWrap.classList.remove('single-option'); handleMoveLocChange(fromInp); } }
    if (validLocs.length === 0) fromWrap.classList.add('no-option');
}
function handleMoveLocChange(input) {
    const row = input.closest('tr'); const qtyInput = row.querySelector('.move-card-qty'); const maxQty = parseInt(input.dataset.maxQty) || 0;
    const toInput = row.querySelector('.move-card-to'); if (toInput && toInput.value) { const fromVal = input.value.trim(); const toVal = toInput.value.trim(); if (fromVal && normalizeStr(fromVal) === normalizeStr(toVal)) { toInput.value = ""; } }
    if (!input.value) { qtyInput.value = ""; return; }
    if (maxQty > 0) { qtyInput.max = maxQty; qtyInput.placeholder = `최대 ${maxQty}`; const currentQty = parseInt(qtyInput.value); if (!isNaN(currentQty) && currentQty > maxQty) { qtyInput.value = maxQty; } } else { qtyInput.value = ""; qtyInput.placeholder = "재고 없음"; }
}
function showMoveResultModal(moves) {
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
    
    const successMoves = moves.filter(m => m.status !== 'fail');
    if (successMoves.length > 0) { const nameAgg = {}; successMoves.forEach(m => { if(!nameAgg[m.cardName]) nameAgg[m.cardName] = 0; nameAgg[m.cardName] += m.moveQty; }); for(const [name, qty] of Object.entries(nameAgg)) { summaryBody.innerHTML += `<tr style="background-color: var(--bg-success);"><td>${name}</td><td style="color:var(--success-green); font-weight:700;">${qty}장</td></tr>`; } }
    
    const failMoves = moves.filter(m => m.status === 'fail');
    if (failMoves.length > 0) { const failAgg = {}; failMoves.forEach(m => { 
        let reason = "알 수 없는 오류"; const maxQty = m.maxQty || 0; 
        if (!m.cardName) reason = "카드 이름 오류"; 
        else if (!m.cardNo || !ownedCardNumbers.includes(m.cardNo)) reason = "카드 번호 오류"; 
        else if (!m.another) reason = "일러스트 오류"; 
        else if (!m.proc) reason = "레어도 오류"; 
        else if (!m.currentLoc) reason = "보관 위치 오류"; 
        else if (!m.targetLoc) reason = "이동 위치 오류"; 
        else if (!m.moveQty || m.moveQty < 1 || m.moveQty > maxQty) reason = "수량 오류"; 
        
        if(!failAgg[reason]) failAgg[reason] = 0; failAgg[reason]++; 
    }); 
    for(const [reason, count] of Object.entries(failAgg)) { summaryBody.innerHTML += `<tr style="background-color: var(--bg-fail);"><td style="color:var(--error-red);">${reason}</td><td style="color:var(--error-red); font-weight:700;">${count}건</td></tr>`; } }
    
    moves.forEach((move, idx) => { 
        const tr = document.createElement('tr'); 
        let locTxt = `${move.currentLoc} ► ${move.targetLoc}`;
        let qtyTxt = move.moveQty;
        let anotherTxt = move.another;
        let procTxt = getLocalizedRarity(move.proc); 
        let cardNoStyle = ''; let nameStyle = ''; let anotherStyle = ''; let procStyle = ''; let locStyle = ''; let qtyStyle = '';

        if (!move.cardNo || !ownedCardNumbers.includes(move.cardNo)) {
            move.cardNo = "오류"; cardNoStyle = 'color:var(--error-red); font-weight:700;';
            anotherTxt = "-"; procTxt = "-"; locTxt = "-"; qtyTxt = "-";
        } 
        else if (!move.another) { 
            anotherTxt = "미선택"; anotherStyle = 'color:var(--error-red); font-weight:700;';
            procTxt = "-"; locTxt = "-"; qtyTxt = "-";
        }
        else if (!move.proc) {
            procTxt = "미선택"; procStyle = 'color:var(--error-red); font-weight:700;';
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

        tr.innerHTML = `<td>${idx + 1}</td><td style="${nameStyle}">${move.cardName}</td><td style="${cardNoStyle}">${move.cardNo}</td><td style="${anotherStyle}">${anotherTxt}</td><td style="${procStyle}">${procTxt}</td><td style="${locStyle}">${locTxt}</td><td style="${qtyStyle}">${qtyTxt}</td>`; 
        detailBody.appendChild(tr); 
    });
    
    const box = document.getElementById('move-result-detail-box'); const icon = document.getElementById('move-toggle-icon'); if(box) box.style.display = 'none'; if(icon) icon.innerText = 'keyboard_arrow_down';
    toggleBackgroundInert(true); M.Modal.getInstance(modal).open();
}

async function finishMoveProcess() { 
    const modal = document.getElementById('move-result-modal');
    const hasSuccess = modal.dataset.hasSuccess === "true"; 
    
    M.Modal.getInstance(modal).close(); 
    toggleBackgroundInert(false); 
    
    const tbody = document.getElementById('page-move-tbody');
    const rows = Array.from(tbody.children);
    
    rows.forEach(row => {
        const cardNoVal = row.querySelector('.move-card-no').value.trim();
        if (row.dataset.moveStatus === 'success' || !cardNoVal) {
            row.remove();
        } else {
            delete row.dataset.moveStatus;
        }
    });
    
    if (tbody.children.length === 0) {
        addMoveEntry();
    } else {
        reindexMoveRows();
    }
    
    if(hasSuccess) { 
        if (syncCounter >= 9) {
            syncCounter = 0;
            await refreshInitialData();
        }
    } 
}

async function submitMoveEntries() {
    const submitBtn = document.getElementById('move-submit-main-btn');
    if(submitBtn && submitBtn.classList.contains('disabled')) return;
    const tbody = document.getElementById('page-move-tbody'); const rows = tbody.querySelectorAll('tr'); const moves = []; let failCount = 0;
    rows.forEach(row => {
        const cardNo = row.querySelector('.move-card-no').value.trim(); const cardName = row.querySelector('.card-name-input').value.trim(); 
        const procInput = row.querySelector('.move-card-proc');
        const proc = procInput.dataset.raw || procInput.value; 
        
        const another = row.querySelector('.move-card-another').value; const currentLoc = row.querySelector('.move-card-from').value; const moveQty = parseInt(row.querySelector('.move-card-qty').value); const targetLoc = row.querySelector('.move-card-to').value.trim();
        if (!cardNo) return; 
        const maxQty = parseInt(row.querySelector('.move-card-qty').max) || 0; let isValid = true;
        if (!proc || !currentLoc || !targetLoc || !moveQty || moveQty < 1) isValid = false; if (moveQty > maxQty) isValid = false; 
        
        if (!isValid) {
            failCount++;
            row.dataset.moveStatus = 'fail';
        } else {
            row.dataset.moveStatus = 'pending';
        }
        const submitAnother = another;
        moves.push({ cardNo, cardName, proc, another: submitAnother, currentLoc, targetLoc, moveQty, maxQty, status: isValid ? 'pending' : 'fail' });
    });

    if (moves.length === 0) { showToast('이동할 카드가 없습니다.', 'warning-yellow black-text'); return; }
    if (failCount === moves.length) { showMoveResultModal(moves); return; }

    showLoading(true, "카드 이동 중...");
    const pendingMoves = moves.filter(m => m.status === 'pending');
    try { 
        const res = await callApi('moveCards', {}, pendingMoves); 
        showLoading(false); 
        if (res.success) { 
            updateLocalInventory(res.updatedItems);
            syncCounter++;
            
            rows.forEach(r => { if(r.dataset.moveStatus === 'pending') r.dataset.moveStatus = 'success'; });
            moves.forEach(m => { if(m.status === 'pending') m.status = 'success'; });
            showMoveResultModal(moves); 
        } else { 
            rows.forEach(r => { if(r.dataset.moveStatus === 'pending') r.dataset.moveStatus = 'fail'; });
            showToast('이동 실패: ' + (res.message || '오류 발생'), 'red darken-1'); 
        } 
    } catch (e) { 
        showLoading(false); 
        rows.forEach(r => { if(r.dataset.moveStatus === 'pending') r.dataset.moveStatus = 'fail'; });
        showToast('서버 통신 오류', 'red darken-1'); 
    }
}
