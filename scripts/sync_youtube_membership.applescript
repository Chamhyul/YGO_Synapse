property targetURL : "https://studio.youtube.com/channel/UCosEFmvzPgbzLWZhKYE4fkw/monetization/memberships"

-- ============================================================
-- 특정 탭(targetTab)에서 JavaScript 조건이 true가 될 때까지
-- 최대 지정 시간 동안 1초 간격으로 확인 (백그라운드/오프스크린 안전)
-- ============================================================
on waitForElement(targetTab, jsCondition, timeoutSeconds)
	set startTime to (current date)
	repeat
		tell application "Google Chrome"
			try
				set resultValue to execute targetTab javascript jsCondition
			on error
				set resultValue to "false"
			end try
		end tell
		
		if resultValue is "true" then
			return true
		end if
		
		if ((current date) - startTime) ≥ timeoutSeconds then
			return false
		end if
		
		delay 1
	end repeat
end waitForElement

-- ============================================================
-- 독립 창 생성 및 즉시 좌측 상단 화면 밖(-3000, -3000)으로 격리
-- ============================================================
set targetWindow to missing value
set targetTab to missing value

tell application "Google Chrome"
	-- 1) 독립 작업 창 생성
	set targetWindow to make new window
	
	-- 2) 메인 모니터 기준 좌측 상단 화면 밖으로 즉시 이동 (다중 모니터 간섭 0%)
	try
		set bounds of targetWindow to {-3000, -3000, -1500, -1500}
	end try
	
	set targetTab to active tab of targetWindow
	set URL of targetTab to targetURL
end tell

try
	-- ============================================================
	-- 1. [내 회원 확인] 버튼이 나타날 때까지 최대 60초 대기
	-- ============================================================
	set foundMembersButton to my waitForElement(targetTab, "
(function() {
    const btn = document.querySelector('button[aria-label=\"내 회원 확인\"]');
    if (btn && btn.getAttribute('aria-disabled') !== 'true') {
        return 'true';
    }
    return 'false';
})()
", 60)
	
	if foundMembersButton is false then
		display notification "60초 동안 '내 회원 확인' 버튼을 찾지 못했습니다." with title "YouTube Studio 자동화"
		tell application "Google Chrome" to close targetWindow
		return
	end if
	
	-- ============================================================
	-- 2. [내 회원 확인] 클릭
	-- ============================================================
	tell application "Google Chrome"
		set clickResult to execute targetTab javascript "
(function() {
    const btn = document.querySelector('button[aria-label=\"내 회원 확인\"]');
    if (btn && btn.getAttribute('aria-disabled') !== 'true') {
        btn.click();
        return 'clicked';
    }
    return 'not found';
})()
"
	end tell
	
	-- ============================================================
	-- 3. [모든 회원을 CSV 파일로 내보내기] 버튼이
	--    나타날 때까지 최대 60초 대기
	-- ============================================================
	set foundExportButton to my waitForElement(targetTab, "
(function() {
    const btn = document.querySelector('ytcp-icon-button#export-button');
    if (btn && btn.getAttribute('aria-disabled') !== 'true') {
        return 'true';
    }
    return 'false';
})()
", 60)
	
	if foundExportButton is false then
		display notification "60초 동안 '모든 회원을 CSV 파일로 내보내기' 버튼을 찾지 못했습니다." with title "YouTube Studio 자동화"
		tell application "Google Chrome" to close targetWindow
		return
	end if
	
	-- ============================================================
	-- 4. [모든 회원을 CSV 파일로 내보내기] 클릭
	-- ============================================================
	tell application "Google Chrome"
		set clickResult to execute targetTab javascript "
(function() {
    const btn = document.querySelector('ytcp-icon-button#export-button');
    if (btn && btn.getAttribute('aria-disabled') !== 'true') {
        btn.click();
        return 'clicked';
    }
    return 'not found';
})()
"
	end tell
	
	-- ============================================================
	-- 5. 새로운 CSV 생성 작업을 위해 무조건 10초 대기
	-- ============================================================
	delay 10
	
	-- ============================================================
	-- 6. 10초가 지난 뒤 [오프라인 저장] 버튼 확인 (최대 60초)
	-- ============================================================
	set foundOfflineButton to my waitForElement(targetTab, "
(function() {
    const buttons = Array.from(
        document.querySelectorAll('button[aria-label=\"오프라인 저장\"]')
    );
    const btn = buttons.find(function(b) {
        const rect = b.getBoundingClientRect();
        return rect.width > 0 &&
               rect.height > 0 &&
               b.getAttribute('aria-disabled') !== 'true';
    });
    if (btn) {
        return 'true';
    }
    return 'false';
})()
", 60)
	
	if foundOfflineButton is false then
		display notification "10초 대기 후 추가로 60초 동안 '오프라인 저장' 버튼을 찾지 못했습니다." with title "YouTube Studio 자동화"
		tell application "Google Chrome" to close targetWindow
		return
	end if
	
	-- ============================================================
	-- 7. [오프라인 저장] 클릭 직전 시각 기록 및 클릭
	-- ============================================================
	set clickTime to (current date)
	
	tell application "Google Chrome"
		set clickResult to execute targetTab javascript "
(function() {
    const buttons = Array.from(
        document.querySelectorAll('button[aria-label=\"오프라인 저장\"]')
    );
    const btn = buttons.find(function(b) {
        const rect = b.getBoundingClientRect();
        return rect.width > 0 &&
               rect.height > 0 &&
               b.getAttribute('aria-disabled') !== 'true';
    });
    if (btn) {
        btn.click();
        return 'clicked';
    }
    return 'not found';
})()
"
	end tell
	
	-- ============================================================
	-- 8. 방금 생성된 최신 CSV 파일 감지 및 다운로드 완료 대기 (Finder 기반, 최대 30초)
	-- ============================================================
	set targetCsvPath to ""
	set loopStart to (current date)
	
	repeat
		tell application "Finder"
			set dlFolder to (path to downloads folder)
			
			-- 크롬 임시 다운로드 파일(.crdownload) 확인
			set crFiles to (every file of dlFolder whose name extension is "crdownload")
			set isDownloading to ((count of crFiles) > 0)
			
			-- 클릭 시각(clickTime) 이후에 생성/수정된 .csv 파일들 조회
			set csvFiles to (every file of dlFolder whose name extension is "csv" and modification date ≥ clickTime)
			
			if (count of csvFiles) > 0 and isDownloading is false then
				-- 가장 최근 수정된 파일 1개 획득
				set sortedCsvs to (sort csvFiles by modification date)
				set latestFile to last item of sortedCsvs
				set targetCsvPath to POSIX path of (latestFile as alias)
			end if
		end tell
		
		if targetCsvPath is not "" then
			exit repeat
		end if
		
		if ((current date) - loopStart) ≥ 30 then
			display alert "오류" message "다운로드된 CSV 파일을 찾지 못했습니다." as critical
			tell application "Google Chrome" to close targetWindow
			return
		end if
		
		delay 1
	end repeat
	
	-- 다운로드 완료 후 작업용 오프스크린 창 닫기
	tell application "Google Chrome"
		try
			close targetWindow
		end try
	end tell
	
	-- ============================================================
	-- 9. Firestore 업로드 & 구글 드라이브 파일 이동 스크립트 실행
	-- ============================================================
	set nodeBinary to "/opt/homebrew/bin/node"
	set uploadScript to "/Users/ch97/YGO_Synapse/scripts/upload_membership_csv.js"
	
	try
		set shellCmd to quoted form of nodeBinary & " " & quoted form of uploadScript & " " & quoted form of targetCsvPath
		set uploadResult to do shell script shellCmd
		
		-- 10. 완료 알림 표시
		display notification uploadResult with title "YouTube Studio 자동화" subtitle "멤버십 DB 동기화 완료" sound name "Glass"
	on error errMsg
		display alert "업로드 오류" message ("Firestore 갱신 중 오류가 발생했습니다: " & errMsg) as critical
	end try

on error globalErr
	-- 예외 발생 시 오프스크린 창 닫기 정리
	tell application "Google Chrome"
		try
			if targetWindow is not missing value then close targetWindow
		end try
	end tell
	display alert "스크립트 오류" message globalErr as critical
end try
