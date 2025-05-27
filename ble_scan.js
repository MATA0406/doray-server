const { spawn } = require("child_process");
const { startCheckIn, startCheckOut } = require('./doray');

const TARGET_MAC = "60:06:E3:97:04:E5";  // 감지할 Apple Watch MAC 주소
let lastRSSI = null;
let logProcess = null;

// ✅ RSSI 강도 해석 함수
function getSignalStrength(rssi) {
    if (rssi >= -50) return "🟢 매우 강함";
    if (rssi >= -60) return "🟡 강함";
    if (rssi >= -70) return "🟠 보통";
    return "🔴 약함";
}

// ✅ `log stream` 실행 함수 (주기적 재시작)
function startLogStream() {
    console.log(`🚀 실시간 Bluetooth 감지 시작... (감지 대상: ${TARGET_MAC})`);

    logProcess = spawn("sudo", ["log", "stream", "--predicate", 'process == "nearbyd"', "--info"], {
        stdio: ["inherit", "pipe", "pipe"]
    });

    logProcess.stdout.on("data", async (data) => {
        const output = data.toString();
        if (output.includes(TARGET_MAC)) {
            const timestamp = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });

            // ✅ RSSI 값 추출
            const matchRSSI = output.match(/RSSI (-?\d+)/);
            const rssi = matchRSSI ? parseInt(matchRSSI[1]) : null;

            if (rssi !== lastRSSI) {
                const signalStrength = getSignalStrength(rssi);
                console.log(`[${timestamp}] ✅ 대상 기기 감지됨! 🔥`);
                console.log(`📡 Bluetooth Address: ${TARGET_MAC}`);
                console.log(`📶 RSSI 값: ${rssi} (${signalStrength})`);
                console.log("🚀 출근 자동화 트리거 실행!");
                console.log("----------------------------------------------------");

                // ✅ MacBook 알림 보내기
                spawn("osascript", ["-e", `display notification "Apple Watch 감지됨 - 출근 기록" with title "Auto Check-in" subtitle "RSSI: ${rssi} (${signalStrength})"`]);

                lastRSSI = rssi;

                // Trigger automatic check-in
                startCheckIn().catch(err => console.error("자동 출근 처리 중 오류:", err));
            }
        }
    });

    logProcess.stderr.on("data", (data) => {
        console.error(`❌ 오류 발생: ${data.toString()}`);
    });

    logProcess.on("close", (code) => {
        console.log(`⚠️ log stream 종료됨 (코드: ${code}) - 자동 재시작`);
        setTimeout(startLogStream, 2000); // 2초 후 재시작
    });

    // ✅ **10분마다 log stream 강제 종료 후 재시작 (메모리 누수 방지)**
    setTimeout(() => {
        console.log("♻️ 10분 지남 - log stream 강제 재시작");
        logProcess.kill(); // 프로세스 종료
    }, 10 * 60 * 1000); // 10분 (600,000ms)
}

// ✅ 실행
startLogStream();