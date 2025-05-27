/**
 * 두레이 자동 출퇴근 통합 시스템
 * 
 * 기능:
 * - Bluetooth 감지를 통한 자동 출근/퇴근
 * - REST API 서버 (수동 출퇴근, 상태 조회)
 * - 실제 두레이 시간 조회
 * - 웹 인터페이스 및 모바일 앱 지원
 */

require('dotenv').config();

const os = require("os");
const express = require('express');
const puppeteer = require("puppeteer");
const { spawn } = require("child_process");

// ===== 설정 =====
const CONFIG = {
  TARGET_MAC: process.env.TARGET_MAC_ADDRESS || "60:06:E3:97:04:E5",
  WORK_START_HOUR: parseInt(process.env.WORK_START_HOUR) || 8,
  WORK_START_END_HOUR: parseInt(process.env.WORK_START_END_HOUR) || 9,
  WORK_START_END_MINUTE: parseInt(process.env.WORK_START_END_MINUTE) || 30,
  WORK_END_HOUR: parseInt(process.env.WORK_END_HOUR) || 18,
  FORCED_CHECKOUT_HOUR: parseInt(process.env.FORCED_CHECKOUT_HOUR) || 21,
  BT_CHECK_INTERVAL: parseInt(process.env.BT_CHECK_INTERVAL) || 15 * 60 * 1000,
  LOG_RESTART_INTERVAL: parseInt(process.env.LOG_RESTART_INTERVAL) || 60 * 60 * 1000,
  RETRY_COUNT: parseInt(process.env.RETRY_COUNT) || 3,
  RETRY_DELAY: parseInt(process.env.RETRY_DELAY) || 2000,
  SERVER_PORT: parseInt(process.env.SERVER_PORT) || 3001,
  LOGIN: {
    USERNAME: process.env.DOORAY_USERNAME || "jhjung",
    PASSWORD: process.env.DOORAY_PASSWORD || "sodlfmadms0!",
    URL: process.env.DOORAY_URL || "https://monthlykitchen.dooray.com/work-schedule/user/register-month"
  },
  PUPPETEER: {
    HEADLESS: process.env.NODE_ENV === 'production',
    ARGS: ['--no-sandbox', '--disable-setuid-sandbox']
  }
};

// ===== 전역 상태 =====
const state = {
  lastRSSI: null,
  lastDetectedTime: null,
  logProcess: null,
  isWorkStarted: false,
  workEndInterval: null,
  forcedCheckOutDone: false,
  isCheckoutInProgress: false,
  isLogStreamRunning: false,
  todaysCheckInTime: null,
  todaysCheckOutTime: null
};

// ===== Express 앱 설정 =====
const app = express();

// ===== 유틸리티 함수 =====
async function retryOperation(operation, retries = CONFIG.RETRY_COUNT, delay = CONFIG.RETRY_DELAY) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await operation();
    } catch (err) {
      console.error(`작업 실패 (시도 ${attempt}/${retries}): ${err.message}`);
      if (attempt < retries) {
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        throw err;
      }
    }
  }
}

function getSignalStrength(rssi) {
  if (rssi >= -50) return "🟢 매우 강함";
  if (rssi >= -60) return "🟡 강함";
  if (rssi >= -70) return "🟠 보통";
  return "🔴 약함";
}

function isWorkTime() {
  const now = new Date();
  const hour = now.getHours();
  const minute = now.getMinutes();
  return hour === CONFIG.WORK_START_HOUR || 
         (hour === CONFIG.WORK_START_END_HOUR && minute <= CONFIG.WORK_START_END_MINUTE);
}

function showNotification(title, subtitle, message) {
  spawn("osascript", [
    "-e",
    `display notification "${message}" with title "${title}" subtitle "${subtitle}"`
  ]);
}

function sendSuccess(res, data = null, message = 'Success') {
  res.json({ success: true, data, message });
}

function sendError(res, error, statusCode = 500) {
  console.error(`❌ [API] ${error.message || error}`);
  res.status(statusCode).json({ 
    success: false, 
    error: error.message || error 
  });
}

// ===== Puppeteer 공통 설정 =====
async function createBrowser(headless = CONFIG.PUPPETEER.HEADLESS) {
  const profileDir = `/tmp/puppeteer_${Date.now()}`;
  return await puppeteer.launch({
    headless,
    userDataDir: profileDir,
    args: CONFIG.PUPPETEER.ARGS
  });
}

async function doLogin(page) {
  console.log("🌐 로그인 페이지 이동 중...");
  await page.goto(CONFIG.LOGIN.URL, { waitUntil: "networkidle2" });
  
  console.log("🔍 로그인 요소 확인 중...");
  await page.waitForSelector('input[title="아이디"]', { timeout: 8000 });
  await page.waitForSelector('input[title="비밀번호"]', { timeout: 8000 });

  console.log("📝 로그인 정보 입력 중...");
  await page.type('.input-box input[type="text"]', CONFIG.LOGIN.USERNAME, { delay: 100 });
  await page.type('.input-box input[type="password"]', CONFIG.LOGIN.PASSWORD, { delay: 100 });

  console.log("🚀 로그인 시도...");
  await page.click(".submit-button.blue");
  await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 8000 });
  
  console.log("✅ 로그인 성공!");
}

// ===== 출근 처리 =====
async function startCheckIn() {
  console.log("🚀 출근 자동화 시작...");
  const browser = await createBrowser();
  const page = await browser.newPage();

  try {
    await doLogin(page);

    console.log("🔍 출근 버튼 탐색 중...");
    await page.waitForSelector(".work-schedule-panel", { timeout: 8000 });

    const checkInButton = await page.$(".check-in-button:not(.disabled)");
    if (!checkInButton) {
      throw new Error("출근 버튼을 찾을 수 없거나 이미 출근했습니다.");
    }

    console.log("✅ 출근 버튼 발견! 클릭 중...");
    await checkInButton.click();
    await new Promise(resolve => setTimeout(resolve, 2000));

    // 출근 시간 추출
    const checkInTimeElement = await page.$(".check-time");
    if (checkInTimeElement) {
      state.todaysCheckInTime = await page.evaluate(el => el.textContent.trim(), checkInTimeElement);
      console.log(`⏰ 출근 시간: ${state.todaysCheckInTime}`);
    }

    console.log("🎉 출근 완료!");
    showNotification("출근 완료", "두레이 자동 출근", `출근 시간: ${state.todaysCheckInTime || '확인 중'}`);

  } catch (error) {
    console.error("❌ 출근 자동화 실패:", error.message);
    throw error;
  } finally {
    await browser.close();
  }
}

// ===== 퇴근 처리 =====
async function startCheckOut() {
  if (state.isCheckoutInProgress) {
    console.log("⚠️ 퇴근 처리가 이미 진행 중입니다.");
    return;
  }

  state.isCheckoutInProgress = true;
  console.log("🚀 퇴근 자동화 시작...");
  const browser = await createBrowser();
  const page = await browser.newPage();

  try {
    await doLogin(page);

    console.log("🔍 퇴근 버튼 탐색 중...");
    await page.waitForSelector(".work-schedule-panel", { timeout: 8000 });

    const checkOutButton = await page.$(".check-out-button:not(.disabled)");
    if (!checkOutButton) {
      throw new Error("퇴근 버튼을 찾을 수 없거나 이미 퇴근했습니다.");
    }

    console.log("✅ 퇴근 버튼 발견! 클릭 중...");
    await checkOutButton.click();
    await new Promise(resolve => setTimeout(resolve, 2000));

    // 퇴근 시간 추출
    const checkOutTimeElements = await page.$$(".check-time");
    if (checkOutTimeElements.length >= 2) {
      state.todaysCheckOutTime = await page.evaluate(el => el.textContent.trim(), checkOutTimeElements[1]);
      console.log(`⏰ 퇴근 시간: ${state.todaysCheckOutTime}`);
    }

    console.log("🎉 퇴근 완료!");
    showNotification("퇴근 완료", "두레이 자동 퇴근", `퇴근 시간: ${state.todaysCheckOutTime || '확인 중'}`);

  } catch (error) {
    console.error("❌ 퇴근 자동화 실패:", error.message);
    throw error;
  } finally {
    await browser.close();
    state.isCheckoutInProgress = false;
  }
}

// ===== 실제 두레이 출퇴근 시간 조회 =====
async function getActualTimes() {
  let browser;
  try {
    console.log('🔍 [실제조회] 두레이 출퇴근 시간 조회 시작');
    
    browser = await createBrowser();
    const page = await browser.newPage();
    
    await doLogin(page);
    
    console.log('⏳ [실제조회] 페이지 로딩 대기...');
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    console.log('🕐 [실제조회] 출퇴근 시간 추출 시도...');
    
    let checkInTime = '미등록';
    let checkOutTime = '미등록';
    
    try {
      const timeElements = await page.$$('.check-time');
      console.log(`📊 [실제조회] check-time 클래스 요소: ${timeElements.length}개 발견`);
      
      if (timeElements.length >= 1) {
        checkInTime = await page.evaluate(el => el.textContent.trim(), timeElements[0]);
        console.log('✅ [실제조회] 출근 시간 추출 성공:', checkInTime);
      }
      
      if (timeElements.length >= 2) {
        checkOutTime = await page.evaluate(el => el.textContent.trim(), timeElements[1]);
        console.log('✅ [실제조회] 퇴근 시간 추출 성공:', checkOutTime);
      }
      
    } catch (error) {
      console.log('❌ [실제조회] 시간 추출 실패:', error.message);
    }
    
    console.log(`🎯 [실제조회] 최종 결과 - 출근: ${checkInTime}, 퇴근: ${checkOutTime}`);
    
    return { checkInTime, checkOutTime };
    
  } catch (error) {
    console.error('❌ [실제조회] 전체 실패:', error.message);
    throw error;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// ===== 상태 조회 =====
function getTodayStatus() {
  return {
    isWorkStarted: state.isWorkStarted,
    checkInTime: state.todaysCheckInTime || "미등록",
    checkOutTime: state.todaysCheckOutTime || "미등록",
    lastDetected: state.lastDetectedTime ? 
      state.lastDetectedTime.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) : "없음",
    lastRSSI: state.lastRSSI
  };
}

// ===== Bluetooth 감지 (자동 출퇴근용) =====
function startLogStream() {
  if (state.isLogStreamRunning) {
    console.log("⚠️ Bluetooth 감지가 이미 실행 중입니다.");
    return;
  }
  
  state.isLogStreamRunning = true;
  console.log(`🚀 Bluetooth 감지 시작... (대상: ${CONFIG.TARGET_MAC})`);

  state.logProcess = spawn("sudo", ["log", "stream", "--predicate", 'process == "nearbyd"', "--info"], {
    stdio: ["inherit", "pipe", "pipe"]
  });

  state.logProcess.stdout.on("data", handleBluetoothData);
  state.logProcess.stderr.on("data", data => {
    console.error(`❌ Bluetooth 감지 오류: ${data.toString()}`);
  });
  state.logProcess.on("close", handleLogStreamClose);

  // 주기적 재시작
  setTimeout(() => {
    console.log("♻️ Bluetooth 감지 재시작 중...");
    if (state.logProcess) {
      state.logProcess.kill();
      state.isLogStreamRunning = false;
    }
  }, CONFIG.LOG_RESTART_INTERVAL);
}

function handleBluetoothData(data) {
  try {
    const output = data.toString();
    if (!output.includes(CONFIG.TARGET_MAC)) return;

    const timestamp = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
    const matchRSSI = output.match(/RSSI (-?\d+)/);
    const rssi = matchRSSI ? parseInt(matchRSSI[1]) : null;

    state.lastDetectedTime = new Date();

    if (!state.isWorkStarted && isWorkTime() && rssi !== state.lastRSSI) {
      console.log(`[${timestamp}] ✅ Apple Watch 감지! 출근 처리 시작`);
      console.log(`📡 Bluetooth: ${CONFIG.TARGET_MAC}`);
      console.log(`📶 RSSI: ${rssi} (${getSignalStrength(rssi)})`);

      showNotification("출근 감지", `RSSI: ${rssi} (${getSignalStrength(rssi)})`, "Apple Watch 감지됨 - 출근 기록");

      state.lastRSSI = rssi;
      state.isWorkStarted = true;

      retryOperation(startCheckIn, CONFIG.RETRY_COUNT, CONFIG.RETRY_DELAY)
        .then(() => startWorkEndInterval())
        .catch(err => console.error("출근 자동화 실패:", err));
    } else {
      state.lastRSSI = rssi;
    }
  } catch (error) {
    console.error("Bluetooth 데이터 처리 오류:", error);
  }
}

function handleLogStreamClose() {
  console.log("⚠️ Bluetooth 감지 종료됨 - 자동 재시작 대기");
  state.isLogStreamRunning = false;
  setTimeout(startLogStream, 2000);
}

// ===== 퇴근 감지 =====
function startWorkEndInterval() {
  if (state.workEndInterval) {
    clearInterval(state.workEndInterval);
  }

  console.log("🕐 퇴근 감지 모니터링 시작 (15분 간격)");
  state.workEndInterval = setInterval(() => {
    const now = new Date();
    const currentHour = now.getHours();
    
    if (currentHour >= CONFIG.WORK_END_HOUR) {
      checkWorkEnd(now, currentHour);
    }
  }, CONFIG.BT_CHECK_INTERVAL);
}

function checkWorkEnd(now, currentHour) {
  const timeSinceLastDetection = state.lastDetectedTime ? 
    (now - state.lastDetectedTime) / (1000 * 60) : Infinity;

  console.log(`🕐 퇴근 체크 - 현재: ${now.getHours()}:${now.getMinutes()}, 마지막 감지: ${timeSinceLastDetection.toFixed(1)}분 전`);

  // 21시 이후 강제 퇴근 (1회만)
  if (currentHour >= CONFIG.FORCED_CHECKOUT_HOUR && !state.forcedCheckOutDone) {
    console.log("🕘 21시 경과 - 강제 퇴근 실행");
    state.forcedCheckOutDone = true;
    retryOperation(startCheckOut, CONFIG.RETRY_COUNT, CONFIG.RETRY_DELAY)
      .catch(err => console.error("강제 퇴근 실패:", err));
    return;
  }

  // 15분 이상 미감지 시 퇴근
  if (timeSinceLastDetection >= 15) {
    console.log(`📱 15분 이상 미감지 - 자동 퇴근 실행 (${timeSinceLastDetection.toFixed(1)}분)`);
    retryOperation(startCheckOut, CONFIG.RETRY_COUNT, CONFIG.RETRY_DELAY)
      .catch(err => console.error("자동 퇴근 실패:", err));
  }
}

// ===== 자정 리셋 =====
function scheduleMidnightReset() {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  
  const timeUntilMidnight = tomorrow - now;
  
  setTimeout(() => {
    console.log("🌅 자정 리셋 - 상태 초기화");
    Object.assign(state, {
      isWorkStarted: false,
      forcedCheckOutDone: false,
      todaysCheckInTime: null,
      todaysCheckOutTime: null,
      lastRSSI: null,
      lastDetectedTime: null
    });
    
    if (state.workEndInterval) {
      clearInterval(state.workEndInterval);
      state.workEndInterval = null;
    }
    
    scheduleMidnightReset(); // 다음 자정 예약
  }, timeUntilMidnight);
  
  console.log(`⏰ 다음 자정 리셋 예약됨: ${tomorrow.toLocaleString("ko-KR")}`);
}

// ===== API 라우트 =====

// 미들웨어
app.use((req, res, next) => {
  const timestamp = new Date().toLocaleTimeString('ko-KR');
  const clientIP = req.ip || req.connection.remoteAddress;
  console.log(`🌐 [${timestamp}] ${req.method} ${req.url} - IP: ${clientIP}`);
  next();
});

// 출근 API
app.post('/check-in', async (req, res) => {
  console.log('▶︎ [API] POST /check-in 호출됨');
  try {
    await startCheckIn();
    console.log('🚀 [API] 출근 자동화 완료');
    sendSuccess(res, null, '출근 처리 완료');
  } catch (error) {
    sendError(res, error);
  }
});

// 퇴근 API
app.post('/check-out', async (req, res) => {
  console.log('▶︎ [API] POST /check-out 호출됨');
  try { 
    await startCheckOut(); 
    console.log('🚀 [API] 퇴근 자동화 완료');
    sendSuccess(res, null, '퇴근 처리 완료');
  } catch (error) { 
    sendError(res, error);
  }
});

// 상태 조회 API (캐시된 정보)
app.get('/status', async (req, res) => {
  console.log('▶︎ [API] GET /status 호출됨');
  try {
    const data = getTodayStatus();
    console.log('✅ [API] 상태 조회 완료:', data);
    sendSuccess(res, data, '상태 조회 완료');
  } catch (error) {
    sendError(res, error);
  }
});

// 실제 두레이 출퇴근 시간 조회 API
app.get('/actual-times', async (req, res) => {
  console.log('▶︎ [API] GET /actual-times 호출됨');
  try {
    const times = await getActualTimes();
    console.log('✅ [API] 실제 출퇴근 시간 조회 완료:', times);
    sendSuccess(res, times, '실제 출퇴근 시간 조회 완료');
  } catch (error) {
    sendError(res, error);
  }
});

// 헬스체크 API
app.get('/health', (req, res) => {
  sendSuccess(res, { 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    autoSystem: state.isLogStreamRunning,
    workStarted: state.isWorkStarted
  }, 'Server is running');
});

// 404 핸들러
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'API 엔드포인트를 찾을 수 없습니다.',
    availableEndpoints: [
      'POST /check-in',
      'POST /check-out', 
      'GET /status',
      'GET /actual-times',
      'GET /health'
    ]
  });
});

// ===== 메인 실행 =====
function startAutoSystem() {
  console.log("🤖 자동 출퇴근 시스템 시작");
  console.log(`📱 대상 기기: ${CONFIG.TARGET_MAC}`);
  console.log(`⏰ 출근 시간: ${CONFIG.WORK_START_HOUR}:00~${CONFIG.WORK_START_END_HOUR}:${CONFIG.WORK_START_END_MINUTE.toString().padStart(2, '0')}`);
  console.log(`🏠 퇴근 감지: ${CONFIG.WORK_END_HOUR}시 이후 15분 미감지 시`);
  console.log(`🔄 강제 퇴근: ${CONFIG.FORCED_CHECKOUT_HOUR}시 이후`);
  
  startLogStream();
  scheduleMidnightReset();
}

function startApiServer() {
  app.listen(CONFIG.SERVER_PORT, () => {
    console.log('🌐 두레이 API 서버 시작');
    console.log(`📡 포트: ${CONFIG.SERVER_PORT}`);
    console.log('📋 사용 가능한 API:');
    console.log('   POST /check-in    - 출근 처리');
    console.log('   POST /check-out   - 퇴근 처리');
    console.log('   GET  /status      - 상태 조회 (캐시)');
    console.log('   GET  /actual-times - 실제 출퇴근 시간 조회');
    console.log('   GET  /health      - 헬스체크');
  });
}

function main() {
  console.log("🚀 두레이 통합 시스템 시작");
  console.log("=" .repeat(50));
  
  // API 서버 시작
  startApiServer();
  
  // 자동 출퇴근 시스템 시작 (sudo 권한 확인)
  if (process.getuid && process.getuid() === 0) {
    startAutoSystem();
  } else {
    console.log("⚠️ sudo 권한이 없어 자동 출퇴근 시스템은 비활성화됩니다.");
    console.log("💡 전체 기능을 사용하려면 'sudo node index.js'로 실행하세요.");
    console.log("📡 현재는 API 서버만 실행됩니다.");
  }
}

// 직접 실행 시에만 main 함수 호출
if (require.main === module) {
  main();
}

// 모듈 내보내기 (하위 호환성을 위해)
module.exports = {
  startCheckIn,
  startCheckOut,
  getTodayStatus,
  getActualTimes
}; 