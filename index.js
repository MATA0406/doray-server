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
    
    // 페이지 로딩 대기 (work-schedule-panel 대신 더 일반적인 대기)
    console.log("⏳ 페이지 로딩 대기 중...");
    await new Promise(resolve => setTimeout(resolve, 3000));

    let checkInButton = null;
    
    // 방법 1: 텍스트 기반으로 '출근하기' 버튼 찾기
    try {
      console.log("📝 방법 1: '출근하기' 텍스트로 버튼 찾는 중...");
      checkInButton = await page.evaluateHandle(() => {
        const buttons = Array.from(document.querySelectorAll('button, .btn, [role="button"]'));
        return buttons.find(btn => 
          btn.textContent && 
          btn.textContent.trim().includes('출근하기') &&
          !btn.disabled &&
          !btn.classList.contains('disabled')
        );
      });
      
      if (checkInButton && await checkInButton.evaluate(el => el)) {
        console.log("✅ 방법 1 성공: '출근하기' 텍스트 버튼 발견!");
      } else {
        checkInButton = null;
      }
    } catch (error) {
      console.log("⚠️ 방법 1 실패:", error.message);
    }
    
    // 방법 2: 클래스 기반으로 첫 번째 check-button 찾기 (백업)
    if (!checkInButton) {
      try {
        console.log("📝 방법 2: 첫 번째 'check-button' 클래스로 버튼 찾는 중...");
        const checkButtons = await page.$$(".check-button");
        if (checkButtons.length >= 1) {
          checkInButton = checkButtons[0];
          console.log("✅ 방법 2 성공: 첫 번째 check-button 발견!");
        }
      } catch (error) {
        console.log("⚠️ 방법 2 실패:", error.message);
      }
    }
    
    // 방법 3: 기존 클래스 방식 (하위 호환성)
    if (!checkInButton) {
      try {
        console.log("📝 방법 3: 기존 'check-in-button' 클래스로 버튼 찾는 중...");
        checkInButton = await page.$(".check-in-button:not(.disabled)");
        if (checkInButton) {
          console.log("✅ 방법 3 성공: 기존 check-in-button 발견!");
        }
      } catch (error) {
        console.log("⚠️ 방법 3 실패:", error.message);
      }
    }
    
    // 방법 4: 더 넓은 범위로 '출근' 포함 버튼 찾기
    if (!checkInButton) {
      try {
        console.log("📝 방법 4: '출근' 텍스트 포함 모든 요소 찾는 중...");
        checkInButton = await page.evaluateHandle(() => {
          const elements = Array.from(document.querySelectorAll('*'));
          return elements.find(el => 
            el.textContent && 
            el.textContent.trim().includes('출근') &&
            (el.tagName === 'BUTTON' || el.onclick || el.getAttribute('role') === 'button' || 
             el.style.cursor === 'pointer' || el.classList.contains('btn')) &&
            !el.disabled &&
            !el.classList.contains('disabled')
          );
        });
        
        if (checkInButton && await checkInButton.evaluate(el => el)) {
          console.log("✅ 방법 4 성공: '출근' 포함 클릭 가능 요소 발견!");
        } else {
          checkInButton = null;
        }
      } catch (error) {
        console.log("⚠️ 방법 4 실패:", error.message);
      }
    }
    
    // 방법 5: Spread operator로 button.check-button에서 출근 텍스트 찾기 (사용자 제안 로직)
    if (!checkInButton) {
      try {
        console.log("📝 방법 5: button.check-button 클래스에서 '출근' 텍스트 찾는 중...");
        checkInButton = await page.evaluateHandle(() => {
          return [...document.querySelectorAll("button.check-button")].find((btn) =>
            btn.textContent.includes("출근")
          );
        });
        
        if (checkInButton && await checkInButton.evaluate(el => el)) {
          console.log("✅ 방법 5 성공: button.check-button에서 '출근' 텍스트 버튼 발견!");
        } else {
          checkInButton = null;
        }
      } catch (error) {
        console.log("⚠️ 방법 5 실패:", error.message);
      }
    }

    if (!checkInButton) {
      throw new Error("출근 버튼을 찾을 수 없거나 이미 출근했습니다. (모든 방법 실패)");
    }

    console.log("✅ 출근 버튼 발견! 클릭 시도 중...");
    
    // 클릭 전 버튼 상태 확인
    try {
      const buttonInfo = await checkInButton.evaluate(el => ({
        text: el.textContent?.trim() || '',
        disabled: el.disabled,
        visible: el.offsetWidth > 0 && el.offsetHeight > 0,
        className: el.className || ''
      }));
      
      console.log(`🔍 클릭 대상 버튼 정보: 텍스트="${buttonInfo.text}", 비활성화=${buttonInfo.disabled}, 보임=${buttonInfo.visible}`);
      
      if (buttonInfo.disabled) {
        throw new Error(`출근 버튼이 비활성화 상태입니다: ${buttonInfo.text}`);
      }
      
      if (!buttonInfo.visible) {
        throw new Error(`출근 버튼이 화면에 보이지 않습니다: ${buttonInfo.text}`);
      }
      
    } catch (error) {
      console.error("⚠️ 버튼 상태 확인 실패:", error.message);
    }
    
    // 안정적인 클릭 시도 (여러 방법)
    let clickSuccess = false;
    
    // 방법 1: 일반 클릭
    try {
      console.log("🖱️ 방법 1: 일반 클릭 시도...");
      await checkInButton.click();
      clickSuccess = true;
      console.log("✅ 방법 1 성공: 일반 클릭 완료!");
    } catch (error) {
      console.log("⚠️ 방법 1 실패:", error.message);
    }
    
    // 방법 2: JavaScript 클릭 (백업)
    if (!clickSuccess) {
      try {
        console.log("🖱️ 방법 2: JavaScript 클릭 시도...");
        await checkInButton.evaluate(btn => btn.click());
        clickSuccess = true;
        console.log("✅ 방법 2 성공: JavaScript 클릭 완료!");
      } catch (error) {
        console.log("⚠️ 방법 2 실패:", error.message);
      }
    }
    
    // 방법 3: 마우스 클릭 (마지막 수단)
    if (!clickSuccess) {
      try {
        console.log("🖱️ 방법 3: 마우스 포커스 후 클릭 시도...");
        await checkInButton.hover();
        await new Promise(resolve => setTimeout(resolve, 500));
        await checkInButton.click();
        clickSuccess = true;
        console.log("✅ 방법 3 성공: 마우스 클릭 완료!");
      } catch (error) {
        console.log("⚠️ 방법 3 실패:", error.message);
      }
    }
    
    if (!clickSuccess) {
      throw new Error("모든 클릭 방법이 실패했습니다. 출근 버튼을 클릭할 수 없습니다.");
    }
    
    console.log("⏳ 클릭 후 페이지 반응 대기 중...");
    await new Promise(resolve => setTimeout(resolve, 3000));

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
    
    // 페이지 로딩 대기 (work-schedule-panel 대신 더 일반적인 대기)
    console.log("⏳ 페이지 로딩 대기 중...");
    await new Promise(resolve => setTimeout(resolve, 3000));

    let checkOutButton = null;
    
    // 방법 1: 텍스트 기반으로 '퇴근하기' 버튼 찾기 (가장 확실한 방법)
    try {
      console.log("📝 방법 1: '퇴근하기' 텍스트로 버튼 찾는 중...");
      
      // XPath를 사용해서 더 정확하게 찾기
      const checkOutButtons = await page.$x("//button[contains(text(), '퇴근하기') and not(@disabled)]");
      if (checkOutButtons.length > 0) {
        checkOutButton = checkOutButtons[0];
        console.log("✅ 방법 1 성공: XPath로 '퇴근하기' 버튼 발견!");
      } else {
        // 백업: evaluateHandle 방식
        checkOutButton = await page.evaluateHandle(() => {
          const buttons = Array.from(document.querySelectorAll('button, .btn, [role="button"]'));
          return buttons.find(btn => 
            btn.textContent && 
            btn.textContent.trim().includes('퇴근하기') &&
            !btn.disabled &&
            !btn.classList.contains('disabled')
          );
        });
        
        if (checkOutButton && await checkOutButton.evaluate(el => el)) {
          console.log("✅ 방법 1 백업 성공: evaluateHandle로 '퇴근하기' 버튼 발견!");
        } else {
          checkOutButton = null;
        }
      }
    } catch (error) {
      console.log("⚠️ 방법 1 실패:", error.message);
    }
    
    // 방법 2: 클래스와 텍스트 조합으로 정확히 찾기
    if (!checkOutButton) {
      try {
        console.log("📝 방법 2: check-button 클래스 + '퇴근' 텍스트 조합으로 찾는 중...");
        
        // XPath로 정확한 조건 설정
        const buttons = await page.$x("//button[contains(@class, 'check-button') and contains(text(), '퇴근') and not(@disabled)]");
        if (buttons.length > 0) {
          checkOutButton = buttons[0];
          console.log("✅ 방법 2 성공: XPath로 check-button + 퇴근 텍스트 버튼 발견!");
        } else {
          // 백업: 순서 기반 (두 번째 check-button)
          const checkButtons = await page.$$(".check-button");
          if (checkButtons.length >= 2) {
            // 두 번째 버튼이 퇴근 버튼인지 텍스트로 확인
            const buttonText = await page.evaluate(el => el.textContent?.trim() || '', checkButtons[1]);
            if (buttonText.includes('퇴근')) {
              checkOutButton = checkButtons[1];
              console.log("✅ 방법 2 백업 성공: 두 번째 check-button이 퇴근 버튼 확인됨!");
            }
          }
        }
      } catch (error) {
        console.log("⚠️ 방법 2 실패:", error.message);
      }
    }
    
    // 방법 3: 기존 클래스 방식 (하위 호환성)
    if (!checkOutButton) {
      try {
        console.log("📝 방법 3: 기존 'check-out-button' 클래스로 버튼 찾는 중...");
        checkOutButton = await page.$(".check-out-button:not(.disabled)");
        if (checkOutButton) {
          console.log("✅ 방법 3 성공: 기존 check-out-button 발견!");
        }
      } catch (error) {
        console.log("⚠️ 방법 3 실패:", error.message);
      }
    }
    
    // 방법 4: 더 넓은 범위로 '퇴근' 포함 버튼 찾기
    if (!checkOutButton) {
      try {
        console.log("📝 방법 4: '퇴근' 텍스트 포함 모든 클릭 가능 요소 찾는 중...");
        
        // XPath로 클릭 가능한 모든 퇴근 요소 찾기
        const elements = await page.$x("//*[contains(text(), '퇴근') and (self::button or @onclick or @role='button' or contains(@class, 'btn')) and not(@disabled)]");
        if (elements.length > 0) {
          checkOutButton = elements[0];
          console.log("✅ 방법 4 성공: XPath로 '퇴근' 포함 클릭 가능 요소 발견!");
        }
      } catch (error) {
        console.log("⚠️ 방법 4 실패:", error.message);
      }
    }
    
    // 방법 5: Spread operator로 button.check-button에서 퇴근 텍스트 찾기 (사용자 제안 로직)
    if (!checkOutButton) {
      try {
        console.log("📝 방법 5: button.check-button 클래스에서 '퇴근' 텍스트 찾는 중...");
        checkOutButton = await page.evaluateHandle(() => {
          return [...document.querySelectorAll("button.check-button")].find((btn) =>
            btn.textContent.includes("퇴근")
          );
        });
        
        if (checkOutButton && await checkOutButton.evaluate(el => el)) {
          console.log("✅ 방법 5 성공: button.check-button에서 '퇴근' 텍스트 버튼 발견!");
        } else {
          checkOutButton = null;
        }
      } catch (error) {
        console.log("⚠️ 방법 5 실패:", error.message);
      }
    }

    // 버튼을 찾았는지 체크하고 상태 분석
    if (!checkOutButton) {
      console.log("🔍 퇴근 버튼 상태 분석 중...");
      
      // 모든 버튼을 확인해서 상황 파악
      const buttonAnalysis = await page.evaluate(() => {
        const allButtons = Array.from(document.querySelectorAll('button, .btn, [role="button"]'));
        const result = {
          totalButtons: allButtons.length,
          checkoutButtons: [],
          disabledCheckoutButtons: []
        };
        
        allButtons.forEach((btn, index) => {
          const text = btn.textContent?.trim() || '';
          if (text.includes('퇴근')) {
            const buttonInfo = {
              index,
              text,
              disabled: btn.disabled || btn.classList.contains('disabled'),
              visible: btn.offsetWidth > 0 && btn.offsetHeight > 0,
              className: btn.className || ''
            };
            
            if (buttonInfo.disabled) {
              result.disabledCheckoutButtons.push(buttonInfo);
            } else {
              result.checkoutButtons.push(buttonInfo);
            }
          }
        });
        
        return result;
      });
      
      console.log("📊 버튼 분석 결과:", JSON.stringify(buttonAnalysis, null, 2));
      
      if (buttonAnalysis.disabledCheckoutButtons.length > 0) {
        console.log("⚠️ 퇴근 버튼이 존재하지만 비활성화 상태입니다:");
        buttonAnalysis.disabledCheckoutButtons.forEach((btn, idx) => {
          console.log(`   ${idx + 1}. "${btn.text}" (클래스: ${btn.className})`);
        });
        throw new Error("이미 퇴근 처리가 완료되었습니다 (퇴근 버튼이 비활성화됨)");
      } else if (buttonAnalysis.checkoutButtons.length === 0 && buttonAnalysis.disabledCheckoutButtons.length === 0) {
        console.log("❌ 퇴근 버튼을 전혀 찾을 수 없습니다");
        throw new Error("페이지에서 퇴근 버튼을 찾을 수 없습니다 (DOM에 퇴근 버튼 없음)");
      } else {
        console.log("🤔 예상치 못한 상황입니다");
        throw new Error("퇴근 버튼 상태를 파악할 수 없습니다");
      }
    }

    console.log("✅ 퇴근 버튼 발견! 클릭 시도 중...");
    
    // 클릭 전 버튼 상태 확인
    try {
      const buttonInfo = await checkOutButton.evaluate(el => ({
        text: el.textContent?.trim() || '',
        disabled: el.disabled,
        visible: el.offsetWidth > 0 && el.offsetHeight > 0,
        className: el.className || ''
      }));
      
      console.log(`🔍 클릭 대상 버튼 정보: 텍스트="${buttonInfo.text}", 비활성화=${buttonInfo.disabled}, 보임=${buttonInfo.visible}`);
      
      if (buttonInfo.disabled) {
        throw new Error(`퇴근 버튼이 비활성화 상태입니다: ${buttonInfo.text}`);
      }
      
      if (!buttonInfo.visible) {
        throw new Error(`퇴근 버튼이 화면에 보이지 않습니다: ${buttonInfo.text}`);
      }
      
    } catch (error) {
      console.error("⚠️ 버튼 상태 확인 실패:", error.message);
    }
    
    // 안정적인 클릭 시도 (여러 방법)
    let clickSuccess = false;
    
    // 방법 1: 일반 클릭
    try {
      console.log("🖱️ 방법 1: 일반 클릭 시도...");
      await checkOutButton.click();
      clickSuccess = true;
      console.log("✅ 방법 1 성공: 일반 클릭 완료!");
    } catch (error) {
      console.log("⚠️ 방법 1 실패:", error.message);
    }
    
    // 방법 2: JavaScript 클릭 (백업)
    if (!clickSuccess) {
      try {
        console.log("🖱️ 방법 2: JavaScript 클릭 시도...");
        await checkOutButton.evaluate(btn => btn.click());
        clickSuccess = true;
        console.log("✅ 방법 2 성공: JavaScript 클릭 완료!");
      } catch (error) {
        console.log("⚠️ 방법 2 실패:", error.message);
      }
    }
    
    // 방법 3: 마우스 클릭 (마지막 수단)
    if (!clickSuccess) {
      try {
        console.log("🖱️ 방법 3: 마우스 포커스 후 클릭 시도...");
        await checkOutButton.hover();
        await new Promise(resolve => setTimeout(resolve, 500));
        await checkOutButton.click();
        clickSuccess = true;
        console.log("✅ 방법 3 성공: 마우스 클릭 완료!");
      } catch (error) {
        console.log("⚠️ 방법 3 실패:", error.message);
      }
    }
    
    if (!clickSuccess) {
      throw new Error("모든 클릭 방법이 실패했습니다. 퇴근 버튼을 클릭할 수 없습니다.");
    }
    
    console.log("⏳ 클릭 후 페이지 반응 대기 중...");
    await new Promise(resolve => setTimeout(resolve, 3000));

    // 퇴근 시간 추출 (개선된 방식)
    console.log("🕐 [실제조회] 출퇴근 시간 추출 시도...");
    
    let checkInTime = '미등록';
    let checkOutTime = '미등록';
    
    try {
      // 개선된 시간 추출 로직
      console.log('📊 [실제조회] 개선된 시간 추출 방식 적용...');
      
      // 방법 1: 출근/퇴근 텍스트 주변에서 시간 찾기
      const timesByContext = await page.evaluate(() => {
        const result = { checkIn: null, checkOut: null };
        
        // 출근 시간 찾기
        const checkinElement = Array.from(document.querySelectorAll('*')).find(el => 
          el.textContent && el.textContent.includes('출근')
        );
        
        if (checkinElement) {
          const parent = checkinElement.closest('.attendance-check__item') || 
                        checkinElement.closest('.check-item') ||
                        checkinElement.parentElement;
          if (parent) {
            const timeElement = parent.querySelector('.check-time');
            if (timeElement) {
              result.checkIn = timeElement.textContent.trim();
            }
          }
        }
        
        // 퇴근 시간 찾기
        const checkoutElement = Array.from(document.querySelectorAll('*')).find(el => 
          el.textContent && el.textContent.includes('퇴근')
        );
        
        if (checkoutElement) {
          const parent = checkoutElement.closest('.attendance-check__item') || 
                        checkoutElement.closest('.check-item') ||
                        checkoutElement.parentElement;
          if (parent) {
            const timeElement = parent.querySelector('.check-time');
            if (timeElement) {
              result.checkOut = timeElement.textContent.trim();
            }
          }
        }
        
        return result;
      });
      
      if (timesByContext.checkIn) {
        checkInTime = timesByContext.checkIn;
        console.log('✅ [실제조회] 출근 시간 추출 성공 (방법 1):', checkInTime);
      }
      
      if (timesByContext.checkOut) {
        checkOutTime = timesByContext.checkOut;
        console.log('✅ [실제조회] 퇴근 시간 추출 성공 (방법 1):', checkOutTime);
      }
      
      // 방법 2: 기존 방식 (백업)
      if (!timesByContext.checkIn || !timesByContext.checkOut) {
        console.log('📝 [실제조회] 방법 2: 기존 순서 기반 방식 시도...');
        const timeElements = await page.$$('.check-time');
        console.log(`📊 [실제조회] check-time 클래스 요소: ${timeElements.length}개 발견`);
        
        if (timeElements.length >= 1 && !timesByContext.checkIn) {
          checkInTime = await page.evaluate(el => el.textContent.trim(), timeElements[0]);
          console.log('✅ [실제조회] 출근 시간 추출 성공 (방법 2):', checkInTime);
        }
        
        if (timeElements.length >= 2 && !timesByContext.checkOut) {
          checkOutTime = await page.evaluate(el => el.textContent.trim(), timeElements[1]);
          console.log('✅ [실제조회] 퇴근 시간 추출 성공 (방법 2):', checkOutTime);
        } else if (timeElements.length === 1 && !timesByContext.checkOut) {
          checkOutTime = '미등록';
          console.log('📝 [실제조회] 퇴근 시간: 아직 퇴근 안 함');
        }
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
      // 개선된 시간 추출 로직
      console.log('📊 [실제조회] 개선된 시간 추출 방식 적용...');
      
      // 방법 1: 출근/퇴근 텍스트 주변에서 시간 찾기
      const timesByContext = await page.evaluate(() => {
        const result = { checkIn: null, checkOut: null };
        
        // 출근 시간 찾기
        const checkinElement = Array.from(document.querySelectorAll('*')).find(el => 
          el.textContent && el.textContent.includes('출근')
        );
        
        if (checkinElement) {
          const parent = checkinElement.closest('.attendance-check__item') || 
                        checkinElement.closest('.check-item') ||
                        checkinElement.parentElement;
          if (parent) {
            const timeElement = parent.querySelector('.check-time');
            if (timeElement) {
              result.checkIn = timeElement.textContent.trim();
            }
          }
        }
        
        // 퇴근 시간 찾기
        const checkoutElement = Array.from(document.querySelectorAll('*')).find(el => 
          el.textContent && el.textContent.includes('퇴근')
        );
        
        if (checkoutElement) {
          const parent = checkoutElement.closest('.attendance-check__item') || 
                        checkoutElement.closest('.check-item') ||
                        checkoutElement.parentElement;
          if (parent) {
            const timeElement = parent.querySelector('.check-time');
            if (timeElement) {
              result.checkOut = timeElement.textContent.trim();
            }
          }
        }
        
        return result;
      });
      
      if (timesByContext.checkIn) {
        checkInTime = timesByContext.checkIn;
        console.log('✅ [실제조회] 출근 시간 추출 성공 (방법 1):', checkInTime);
      }
      
      if (timesByContext.checkOut) {
        checkOutTime = timesByContext.checkOut;
        console.log('✅ [실제조회] 퇴근 시간 추출 성공 (방법 1):', checkOutTime);
      }
      
      // 방법 2: 기존 방식 (백업)
      if (!timesByContext.checkIn || !timesByContext.checkOut) {
        console.log('📝 [실제조회] 방법 2: 기존 순서 기반 방식 시도...');
        const timeElements = await page.$$('.check-time');
        console.log(`📊 [실제조회] check-time 클래스 요소: ${timeElements.length}개 발견`);
        
        if (timeElements.length >= 1 && !timesByContext.checkIn) {
          checkInTime = await page.evaluate(el => el.textContent.trim(), timeElements[0]);
          console.log('✅ [실제조회] 출근 시간 추출 성공 (방법 2):', checkInTime);
        }
        
        if (timeElements.length >= 2 && !timesByContext.checkOut) {
          checkOutTime = await page.evaluate(el => el.textContent.trim(), timeElements[1]);
          console.log('✅ [실제조회] 퇴근 시간 추출 성공 (방법 2):', checkOutTime);
        } else if (timeElements.length === 1 && !timesByContext.checkOut) {
          checkOutTime = '미등록';
          console.log('📝 [실제조회] 퇴근 시간: 아직 퇴근 안 함');
        }
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

// ===== 디버깅 함수 (페이지 구조 확인용) =====
async function debugPageStructure() {
  console.log("🔍 [디버그] 두레이 페이지 구조 분석 시작...");
  const browser = await createBrowser(false); // headless false로 브라우저 보이게
  const page = await browser.newPage();

  try {
    await doLogin(page);
    
    console.log("🔍 [디버그] 로그인 완료, 페이지 분석 중...");
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // 1. 페이지 전체 클래스들 확인
    const allClasses = await page.evaluate(() => {
      const elements = document.querySelectorAll('*[class]');
      const classes = new Set();
      elements.forEach(el => {
        el.className.split(' ').forEach(cls => {
          if (cls.trim()) classes.add(cls.trim());
        });
      });
      return Array.from(classes).sort();
    });
    
    console.log("📋 [디버그] 페이지에 있는 모든 클래스들:");
    allClasses.forEach(cls => {
      if (cls.includes('work') || cls.includes('schedule') || cls.includes('panel') || 
          cls.includes('check') || cls.includes('button')) {
        console.log(`  🎯 관련 클래스: ${cls}`);
      }
    });
    
    // 2. 버튼 요소들 확인  
    const buttons = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, .btn, [role="button"]'));
      return btns.map(btn => ({
        text: btn.textContent?.trim() || '',
        className: btn.className || '',
        id: btn.id || '',
        disabled: btn.disabled,
        tagName: btn.tagName
      })).filter(btn => 
        btn.text.includes('출근') || btn.text.includes('퇴근') || 
        btn.className.includes('check') || btn.text.includes('등록')
      );
    });
    
    console.log("🔘 [디버그] 출퇴근 관련 버튼들:");
    buttons.forEach((btn, idx) => {
      console.log(`  ${idx + 1}. 텍스트: "${btn.text}"`);
      console.log(`     클래스: "${btn.className}"`);
      console.log(`     ID: "${btn.id}"`);
      console.log(`     비활성화: ${btn.disabled}`);
      console.log(`     태그: ${btn.tagName}`);
      console.log("");
    });
    
    // 3. 시간 표시 요소들 확인
    const timeElements = await page.evaluate(() => {
      const times = Array.from(document.querySelectorAll('*'));
      return times.filter(el => {
        const text = el.textContent?.trim() || '';
        return /\d{2}:\d{2}:\d{2}/.test(text) || text.includes('시간') || text.includes('등록');
      }).map(el => ({
        text: el.textContent?.trim() || '',
        className: el.className || '',
        tagName: el.tagName
      })).slice(0, 10); // 최대 10개만
    });
    
    console.log("⏰ [디버그] 시간 관련 요소들:");
    timeElements.forEach((time, idx) => {
      console.log(`  ${idx + 1}. 텍스트: "${time.text}"`);
      console.log(`     클래스: "${time.className}"`);
      console.log(`     태그: ${time.tagName}`);
      console.log("");
    });
    
    console.log("🎯 [디버그] 분석 완료!");
    
  } catch (error) {
    console.error("❌ [디버그] 분석 실패:", error.message);
  } finally {
    // 5초 후 브라우저 닫기
    setTimeout(async () => {
      await browser.close();
    }, 5000);
  }
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

// 디버깅 API (페이지 구조 분석)
app.get('/debug', async (req, res) => {
  console.log('▶︎ [API] GET /debug 호출됨 - 페이지 구조 분석 시작');
  try {
    // 비동기로 디버깅 실행 (응답은 바로 보냄)
    debugPageStructure().catch(err => {
      console.error('❌ [디버그] 비동기 분석 실패:', err.message);
    });
    
    sendSuccess(res, { 
      message: '디버깅 시작됨', 
      note: '브라우저가 열리고 로그에서 결과 확인 가능' 
    }, '페이지 구조 분석 시작');
  } catch (error) {
    sendError(res, error);
  }
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
      'GET /health',
      'GET /debug'
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
    console.log('   GET  /debug       - 페이지 구조 분석');
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