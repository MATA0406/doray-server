# 🚀 Doray 자동 출퇴근 시스템 프로젝트

## 📋 프로젝트 개요

이 프로젝트는 **Apple Watch의 Bluetooth 신호를 감지해서 자동으로 Dooray 출퇴근을 처리하는 macOS용 자동화 시스템**이야.

## 🏗️ 기술 스택

- **Node.js** + Express (API 서버)
- **Puppeteer** (웹 자동화)
- **macOS log stream** (Bluetooth 감지)
- **sudo 권한** 필요 (시스템 로그 접근)

## 📁 파일 구조

```
doray-server/
├── server.js          # Express API 서버 (포트 3001)
├── doray.js           # 메인 로직 (BT 감지 + Puppeteer 자동화)
├── ble_scan.js        # Bluetooth 스캔 전용 스크립트
├── package.json       # 의존성 (express, puppeteer)
└── PROJECT_PROMPT.md  # 이 파일
```

## 🔧 핵심 기능

### 1. Bluetooth 감지 시스템

- **대상**: Apple Watch MAC 주소 `60:06:E3:97:04:E5`
- **방식**: `sudo log stream --predicate 'process == "nearbyd"'` 실시간 감시
- **RSSI 강도 분석**: -50 이상(매우강함) ~ -70 이하(약함)
- **메모리 누수 방지**: 60분마다 log stream 자동 재시작

### 2. 자동 출근 로직

- **시간 조건**: 오전 8:00 ~ 9:30
- **트리거**: Apple Watch 감지 + RSSI 값 변경
- **처리**: Puppeteer로 Dooray 로그인 → 출근 버튼 클릭
- **알림**: macOS 시스템 알림 발송

### 3. 자동 퇴근 로직

- **조건 1**: 18시 이후 15분간 Bluetooth 미감지
- **조건 2**: 21시 이후 강제 퇴근 (1회)
- **처리**: Puppeteer로 퇴근 버튼 클릭
- **상태 관리**: 동시 실행 방지 플래그

### 4. Express API 엔드포인트

```javascript
POST /check-in     # 수동 출근
POST /check-out    # 수동 퇴근
GET  /status       # 오늘 출퇴근 현황
```

## 🔐 인증 정보

- **Dooray URL**: `https://monthlykitchen.dooray.com/work-schedule/user/register-month`
- **계정**: `jhjung` / `sodlfmadms0!`
- **Puppeteer 프로필**: `/tmp/puppeteer_profile` (세션 유지)

## ⚙️ 주요 설정값

```javascript
const TARGET_MAC = "60:06:E3:97:04:E5"; // Apple Watch MAC
const WORK_START_TIME = "8:00-9:30"; // 출근 시간대
const CHECKOUT_DELAY = 15; // 퇴근 감지 지연(분)
const LOG_RESTART_INTERVAL = 60; // log stream 재시작(분)
```

## 🚨 중요 특징

1. **재시도 로직**: 모든 Puppeteer 작업에 3회 재시도
2. **상태 관리**: 중복 실행 방지 + 일일 상태 초기화
3. **에러 핸들링**: 네트워크/DOM 대기 타임아웃 처리
4. **메모리 최적화**: 정기적 프로세스 재시작
5. **macOS 전용**: sudo 권한 + nearbyd 프로세스 의존

## 🎯 사용 시나리오

1. **아침**: Apple Watch 착용하고 출근 → 자동 출근 처리
2. **저녁**: 퇴근 후 15분 지나면 → 자동 퇴근 처리
3. **수동**: API 호출로 언제든 출퇴근 가능
4. **모니터링**: `/status`로 오늘 출퇴근 현황 확인

## 🔧 실행 방법

```bash
# 의존성 설치
npm install

# API 서버만 실행
npm start

# Bluetooth 감지 + 자동화 실행
sudo node doray.js

# Bluetooth 스캔만 실행
sudo node ble_scan.js
```

## 🐛 디버깅 팁

- `DEBUG=true` 환경변수로 Puppeteer 헤드리스 모드 해제
- `console.log`로 상세한 실행 로그 출력
- macOS 시스템 알림으로 실시간 상태 확인
- `/tmp/puppeteer_profile` 삭제 시 재로그인 필요

---

**이 프로젝트는 개인용 자동화 도구로, macOS 환경에서만 동작하며 sudo 권한이 필요해.**
