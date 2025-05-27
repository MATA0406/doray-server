# Doray Server

Doray Server는 두레이(Dooray) 자동 출퇴근 통합 시스템입니다. Bluetooth를 통한 자동 감지와 수동 API 호출을 하나의 프로세스에서 제공합니다.

## 🚀 주요 기능

### 자동 출퇴근 시스템

- **Bluetooth 자동 감지**: Apple Watch/iPhone의 Bluetooth 신호를 감지하여 자동 출근
- **스마트 퇴근 감지**: 18시 이후 15분간 미감지 시 자동 퇴근
- **강제 퇴근**: 21시 이후 자동 퇴근 처리
- **실시간 모니터링**: 지속적인 Bluetooth 신호 감지 및 로깅

### REST API 서버

- **수동 출퇴근**: API 호출을 통한 수동 출퇴근 처리
- **상태 조회**: 현재 출퇴근 상태 및 시간 확인
- **실제 시간 조회**: 두레이에 실제 등록된 출퇴근 시간 조회
- **헬스체크**: 서버 상태 모니터링

## 📋 시스템 요구사항

- **OS**: macOS (Bluetooth 로그 접근 필요)
- **Node.js**: 16.0+
- **권한**: sudo 권한 (Bluetooth 로그 스트림 접근)
- **브라우저**: Chromium 기반 (Puppeteer)

## 🛠 설치 및 설정

### 1. 프로젝트 클론 및 의존성 설치

```bash
git clone <repository-url>
cd doray-server
npm install
```

### 2. 환경변수 설정

`.env` 파일을 생성하고 다음 내용을 설정하세요:

```env
# ===== 두레이 로그인 정보 =====
DOORAY_USERNAME=your_username
DOORAY_PASSWORD=your_password
DOORAY_URL=https://your-company.dooray.com/work-schedule/user/register-month

# ===== Bluetooth 설정 =====
TARGET_MAC_ADDRESS=60:06:E3:97:04:E5

# ===== 서버 설정 =====
SERVER_PORT=3001
SERVER_URL=https://your-domain.com

# ===== 시간 설정 =====
WORK_START_HOUR=8
WORK_START_END_HOUR=9
WORK_START_END_MINUTE=30
WORK_END_HOUR=18
FORCED_CHECKOUT_HOUR=21

# ===== 타이밍 설정 (밀리초) =====
BT_CHECK_INTERVAL=900000
LOG_RESTART_INTERVAL=3600000
RETRY_COUNT=3
RETRY_DELAY=2000

# ===== 디버그 설정 =====
DEBUG=false
NODE_ENV=production
```

### 3. Bluetooth MAC 주소 확인

자신의 Apple Watch/iPhone의 Bluetooth MAC 주소를 확인하여 `TARGET_MAC_ADDRESS`에 설정:

```bash
# Bluetooth 활동 모니터링으로 MAC 주소 확인
sudo log stream --predicate 'process == "nearbyd"' --info
```

## 🚀 실행 방법

### API 서버만 실행 (개발 모드)

```bash
npm start
# 또는
node index.js
```

### 전체 시스템 실행 (자동 출퇴근 + API 서버)

```bash
# sudo 권한 필요
npm run auto
# 또는
sudo node index.js
```

### 개발 모드 (nodemon 사용)

```bash
npm run dev
```

### PM2로 백그라운드 실행 (권장)

#### API 서버만 백그라운드 실행

```bash
# 시작
pm2 start ecosystem.config.js

# 상태 확인
pm2 status

# 정지
pm2 stop doray-server

# 재시작
pm2 restart doray-server

# 삭제
pm2 delete doray-server
```

#### 전체 시스템 백그라운드 실행 (자동 출퇴근 포함)

```bash
# 기존 프로세스 정지 (실행 중인 경우)
pm2 stop doray-server

# sudo 권한으로 시작 (Bluetooth 감지 포함)
sudo pm2 start ecosystem.config.js

# 상태 확인
sudo pm2 status

# 정지
sudo pm2 stop doray-server
```

## 🌐 API 문서

### 기본 정보

- **Base URL**: `http://localhost:3001`
- **Content-Type**: `application/json`

### 엔드포인트

#### POST /check-in

수동 출근 처리

**요청**:

```bash
curl -X POST http://localhost:3001/check-in
```

**응답**:

```json
{
  "success": true,
  "message": "출근 처리 완료"
}
```

#### POST /check-out

수동 퇴근 처리

**요청**:

```bash
curl -X POST http://localhost:3001/check-out
```

**응답**:

```json
{
  "success": true,
  "message": "퇴근 처리 완료"
}
```

#### GET /status

현재 상태 조회 (캐시된 정보)

**요청**:

```bash
curl http://localhost:3001/status
```

**응답**:

```json
{
  "success": true,
  "data": {
    "isWorkStarted": true,
    "checkInTime": "09:15",
    "checkOutTime": "미등록",
    "lastDetected": "2024-01-15 14:30:45",
    "lastRSSI": -65
  },
  "message": "상태 조회 완료"
}
```

#### GET /actual-times

실제 두레이에 등록된 출퇴근 시간 조회

**요청**:

```bash
curl http://localhost:3001/actual-times
```

**응답**:

```json
{
  "success": true,
  "data": {
    "checkInTime": "09:15",
    "checkOutTime": "18:30"
  },
  "message": "실제 출퇴근 시간 조회 완료"
}
```

#### GET /health

서버 상태 확인

**요청**:

```bash
curl http://localhost:3001/health
```

**응답**:

```json
{
  "success": true,
  "data": {
    "status": "healthy",
    "timestamp": "2024-01-15T09:30:00.000Z",
    "uptime": 3600,
    "autoSystem": true,
    "workStarted": false
  },
  "message": "Server is running"
}
```

## 🏗 프로젝트 구조

```
doray-server/
├── index.js                   # 통합 메인 파일 (자동 출퇴근 + API 서버)
├── .env                       # 환경변수 (생성 필요)
├── .env.example              # 환경변수 예제
├── package.json              # 프로젝트 설정
├── ecosystem.config.js       # PM2 설정 (선택사항)
└── README.md                 # 이 파일
```

## 🔧 주요 컴포넌트

### 통합 시스템 (index.js)

- **자동 출퇴근**: Bluetooth 신호 감지 및 자동 출퇴근 처리
- **API 서버**: Express 기반 REST API 서버
- **실제 시간 조회**: Puppeteer를 통한 두레이 웹 자동화
- **상태 관리**: 메모리 기반 상태 관리 및 자정 리셋

### 환경변수 시스템

- 민감한 정보 보호
- 환경별 설정 분리
- 쉬운 배포 및 관리

## ⚙️ 설정 옵션

### 시간 설정

```env
WORK_START_HOUR=8              # 출근 시작 시간
WORK_START_END_HOUR=9          # 출근 종료 시간
WORK_START_END_MINUTE=30       # 출근 종료 분
WORK_END_HOUR=18               # 퇴근 감지 시작 시간
FORCED_CHECKOUT_HOUR=21        # 강제 퇴근 시간
```

### Bluetooth 설정

```env
TARGET_MAC_ADDRESS=60:06:E3:97:04:E5  # 감지할 MAC 주소
BT_CHECK_INTERVAL=900000               # 퇴근 체크 간격 (15분)
LOG_RESTART_INTERVAL=3600000           # 로그 재시작 간격 (1시간)
```

### 오류 처리 설정

```env
RETRY_COUNT=3                  # 재시도 횟수
RETRY_DELAY=2000              # 재시도 간격 (2초)
```

## 🔍 문제 해결

### Bluetooth 감지가 안 되는 경우

1. **sudo 권한 확인**: `sudo node index.js`로 실행
2. **MAC 주소 확인**: 올바른 Bluetooth MAC 주소인지 확인
3. **로그 확인**: 터미널에서 Bluetooth 로그 출력 확인

### 두레이 로그인 실패

1. **자격 증명 확인**: `.env` 파일의 사용자명/비밀번호 확인
2. **URL 확인**: 회사별 두레이 URL 확인
3. **네트워크 확인**: 두레이 접속 가능한 네트워크인지 확인

### API 서버 연결 실패

1. **포트 확인**: 3001 포트가 사용 중인지 확인
2. **방화벽 설정**: 포트 3001이 열려있는지 확인
3. **프로세스 확인**: `ps aux | grep node`로 서버 실행 상태 확인

### 권한 오류

```bash
# macOS에서 터미널 접근 권한 설정 필요
시스템 환경설정 → 보안 및 개인 정보 보호 → 개인 정보 보호 → 전체 디스크 접근 권한
```

## 📊 모니터링

### 로그 확인

```bash
# 실시간 로그 확인 (가장 많이 사용)
pm2 logs doray-server

# 모든 프로세스 로그 확인
pm2 logs

# 최근 N줄만 보기
pm2 logs doray-server --lines 20

# 에러 로그만 보기
pm2 logs doray-server --err

# 출력 로그만 보기
pm2 logs doray-server --out
```

### 상태 모니터링

```bash
# 프로세스 상태 확인
pm2 status
pm2 list                      # status와 동일

# 특정 프로세스 상세 정보
pm2 show doray-server

# 실시간 CPU/메모리 모니터링
pm2 monit

# 프로세스 정보
pm2 info doray-server
```

### 외부 접속을 위한 터널링 (선택사항)

```bash
# localtunnel 사용
npm install -g localtunnel
lt --port 3001 --subdomain your-subdomain
```

## 🆕 통합의 장점

### 이전 구조 (doray.js + server.js)

- 두 개의 별도 파일로 관리
- 각각 다른 프로세스로 실행
- 코드 중복 (Puppeteer 설정, 로그인 로직 등)

### 새로운 구조 (index.js)

- **단일 파일**: 모든 기능이 하나의 파일에 통합
- **단일 프로세스**: API 서버와 자동 출퇴근이 함께 실행
- **코드 재사용**: 공통 로직 통합으로 중복 제거
- **쉬운 관리**: 하나의 프로세스만 관리하면 됨
- **스마트 실행**: 권한에 따라 자동으로 기능 활성화/비활성화

## 🔒 보안 고려사항

- `.env` 파일은 절대 버전 관리에 포함하지 마세요
- 두레이 로그인 정보는 암호화된 저장소에 보관하세요
- API 서버에 인증 시스템 추가를 권장합니다
- 외부 노출 시 HTTPS 사용을 권장합니다

## 📝 라이선스

이 프로젝트는 개인 사용을 위한 프로젝트입니다.

## 🤝 기여

버그 리포트나 기능 제안은 이슈로 등록해 주세요.

## 📊 PM2 모니터링 및 로그 관리

### 📋 로그 확인

```bash
# 실시간 로그 확인 (가장 많이 사용)
pm2 logs doray-server

# 모든 프로세스 로그 확인
pm2 logs

# 최근 N줄만 보기
pm2 logs doray-server --lines 20

# 에러 로그만 보기
pm2 logs doray-server --err

# 출력 로그만 보기
pm2 logs doray-server --out
```

### 📊 상태 및 모니터링

```bash
# 프로세스 상태 확인
pm2 status
pm2 list                      # status와 동일

# 특정 프로세스 상세 정보
pm2 show doray-server

# 실시간 CPU/메모리 모니터링
pm2 monit

# 프로세스 정보
pm2 info doray-server
```

### 🧹 로그 관리

```bash
# 모든 로그 삭제
pm2 flush

# 특정 프로세스 로그만 삭제
pm2 flush doray-server
```

### 🔄 프로세스 관리

```bash
# 재시작
pm2 restart doray-server

# 무중단 재시작 (권장)
pm2 reload doray-server

# 프로세스 정지
pm2 stop doray-server

# 프로세스 삭제
pm2 delete doray-server
```

## 📊 실행 모드 자동 감지

시스템은 실행 권한에 따라 자동으로 모드를 선택합니다:

- **일반 실행** (`node index.js` 또는 `pm2 start`): API 서버만 실행
- **sudo 실행** (`sudo node index.js` 또는 `sudo pm2 start`): API 서버 + 자동 출퇴근 시스템 실행

```bash
🚀 두레이 통합 시스템 시작
==================================================
🌐 두레이 API 서버 시작
📡 포트: 3001
⚠️ sudo 권한이 없어 자동 출퇴근 시스템은 비활성화됩니다.
💡 전체 기능을 사용하려면 'sudo pm2 start ecosystem.config.js'로 실행하세요.
📡 현재는 API 서버만 실행됩니다.
```

## 🔧 PM2 추가 팁

### 시스템 부팅 시 자동 시작

```bash
# PM2를 시스템 서비스로 등록
pm2 startup

# 현재 실행 중인 프로세스들을 저장 (부팅 시 자동 시작)
pm2 save
```

### 환경별 실행

```bash
# 개발 환경
NODE_ENV=development pm2 start ecosystem.config.js

# 프로덕션 환경
NODE_ENV=production pm2 start ecosystem.config.js
```

### 메모리 사용량 제한

```bash
# 1GB 메모리 제한으로 시작
pm2 start ecosystem.config.js --max-memory-restart 1G
```
