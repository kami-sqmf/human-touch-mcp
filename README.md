# Human Input MCP 0.2.0

Windows x64 的獨立輸入 MCP。Node.js 提供 30 個工具；Rust worker 透過 Windows API 檢查視窗並執行輸入。官方 Touch MCP 保留原版，獨立安裝、啟動及更新。每個新程序的 human mode 預設關閉。

## 安裝與移機

一般使用請解壓縮完整可攜版，執行完整可攜版根目錄的 `launch.ps1`。套件內附 Node.js 24.22.1、預編譯 static CRT Human worker、監督程式、Node 相依套件，以及官方 Touch 所需的 .NET 10.0.13。正常使用不需要系統 Node、Rust 編譯器或 Python。官方原生模組仍需 Microsoft Visual C++ v14 x64 Runtime；啟動器會檢查並提供官方安裝資訊。

```powershell
.\launch.ps1 version human
.\launch.ps1 version touch
.\launch.ps1 verify human --boot
.\launch.ps1 verify touch --boot
.\launch.ps1 config human
.\launch.ps1 config touch
.\launch.ps1 launch human
# 官方 Touch 使用另一個 MCP 程序：
.\launch.ps1 launch touch
```

移到新電腦後，重新執行 `config human` 與 `config touch`，取得當地路徑的設定片段。設定輸出不會改寫現用 MCP 設定；由使用者在需要時自行登錄。完整命令與來源驗證見 [可攜版指南](docs/PORTABLE.md)。

## 操作順序

1. 外部觀察工具先確認目標用途、內容、HWND 與實體螢幕座標。
2. 查詢 `human_capabilities {}`，再明確呼叫 `human_mode {"enabled":true}`。
3. 以 `human_observe {"hwnd":"…"}` 取得最新視窗身分、前景、焦點、幾何、DPI 及游標狀態。這不代表已確認畫面內容。
4. 每次只呼叫一個明確語意操作，再由接收端或外部觀察確認結果。支援移動、點擊、拖曳、逐字輸入、捲動、允許的按鍵，以及獨立的複製／剪下／貼上。
5. 結束時呼叫 `human_stop {}`，再以 `human_mode {"enabled":false}` 關閉模式。

座標採實體螢幕像素，可為負數。移動、點擊、拖曳與掃讀的路徑全程留在目標 client 內，游標必須已在 client 內，否則回傳 `cursor_outside_client`；只有 `human_activate` 能從外面進入。輸入前及執行中檢查身分、前景、焦點、遮擋、幾何、DPI、游標與鍵盤狀態。沒有焦點切換 API 或視窗重排。`human_activate` 是獨立的安全區域點擊，必須提供最新 `safe_area` 及 `safe_area_confirmed:true`；確認區域不會編輯、導航或提交。點擊後重新觀察，再決定後續操作。

`human_type` 預設 41 WPM、`typo_rate:0`；刻意錯字須明確啟用。逐字輸入不暗中貼上，也不接受換行或 Tab；需要 Enter 時使用獨立 `human_key`。一般按鍵拒絕 Ctrl+C/X/V，剪貼簿操作必須使用 `human_copy`、`human_cut`、`human_paste`。產品只送出 Windows 快捷鍵，不讀取或保存剪貼簿內容。剪下與貼上可能更改接收端內容。

## 背景掃讀與工作控制

`reading_start` 接受有順序、目的、方向與時間預算的區域，立即回傳 `operation_id`，背景只做純游標移動與停留，總長最多 60 秒。格式與界線見 [工具契約](docs/TOOLS-V2.md)。狀態、觀察、事件及倒數查詢不會取消掃讀；新輸入、目標／模式變更或停止先經過取消屏障。另一個掃讀需要明確 `replace:true`。

游標異常立即暫停，最多觀察 3000 ms。短暫小幅且穩定的移動只有在重新檢查安全後才可自動接續；持續大範圍移動成立後回報 `pointer_takeover` 並維持暫停。數值門檻可設定，目前是工程預設值，尚未宣稱實測校正或能辨識操作者。

`human_pause` 回報清理屏障與進度；暫停時拒絕所有新輸入。手動恢復須提供目前 `operation_id`、精確 `pause_revision`、`external_checked:true` 與明確 `resolution`。已送出的效果不會重播；不明效果須依外部證據逐項解決，不能盲目 `continue`。停止、斷線、模式關閉及程序重啟後不自動恢復。詳見 [原生協定](docs/NATIVE-PROTOCOL-V2.md)。

`completed` 表示執行器完成，`inputInjected` 表示已送出原生輸入；`deliveryVerified:false` 不證明接收端結果或遠端送達。取消確認後不再送出新輸入，已送入 Windows 的事件無法撤銷。

## 事件、倒數與限制

`human_events` 保留有界事件，`human_event_ack` 只記錄 MCP 呼叫者確認，不會恢復工作。可選的診斷通知與測試接收不代表 Codex Agent 正在思考時收到即時中斷；目前 `agent_push_supported:false`，實際 Agent 即時送達仍不支援／未驗證。

倒數使用 `timer_attach` → `timer_prepare` → 外部讀取 → `timer_calibrate` → `timer_status`。單調時鐘估計與外部觀察值分開，納入讀取／傳送延遲及未知顯示取整。一般 60 秒、最後 30 秒內 10 秒超齡；換頁、暫停或恢復後須重新校正。估計歸零不觸發輸入。

Human Input 不擷取畫面、OCR、讀取頁面內容、安裝 hooks，或偵測其他 MCP 呼叫／聊天訊息；`cancel_on_user_message:false`、`page_change_detection:false`。多個 Human worker 共用輸入鎖，但無法約束官方 Touch 或其他軟體；改用其他輸入工具前先停止 Human 工作。權限、UIPI、IME、快速實體輸入及外部強制終止仍有平台限制。沒有所有 Windows／鍵盤／DPI 組合或全新 VM 相容性保證。

## 更新、回退與 0.1 遷移

先停止 Human 工作並正常關閉相關 MCP 程序，再明確執行更新。更新前校驗可信 SHA256、封存路徑及完整 manifest，使用 staging 與唯讀探測；整棵探測程序樹確認退出後才原子切版。失敗保留原選版，成功保留前版，回退離線重驗。兩個元件獨立選版與鎖定。

```powershell
.\launch.ps1 update human --bundle 'D:\下載\human-input-0.2.0.zip' --sha256 '可信的64字元SHA256'
.\launch.ps1 update human --url 'https://使用者明確指定的來源/release.zip' --sha256 '可信的64字元SHA256'
.\launch.ps1 update touch --version 2.3.2
.\launch.ps1 rollback human
.\launch.ps1 rollback touch
```

沒有自動更新或預設 Human 發行站。0.1 的 Node 與 protocol 1 worker 不可混用新版。改用完整 0.2 可攜版，正常停止舊程序，產生新路徑設定，再由使用者切換；保留舊安裝可供回退。錯字預設值改為零，按鍵、剪貼簿、安全啟動及暫停／恢復採新版契約，呼叫者須處理完整狀態與進度，不能把舊停止結果當成可恢復狀態。

## 開發與驗證

以下命令屬於原始碼 checkout 的開發／驗收流程；完整可攜版根目錄不保證包含測試工具或工作目錄。開發才需要 Rust／MSVC。準備已驗證的內附 Node 後：

```powershell
& './work/prerequisites/node-v24.22.1-win-x64/node.exe' --test 'tests/*.test.mjs'
cargo test --locked --manifest-path native/Cargo.toml
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build.ps1 -NoCopy
$env:HUMAN_INPUT_WORKER=(Resolve-Path 'native/target/portable/x86_64-pc-windows-msvc/release/human-input-worker.exe').Path
& './work/prerequisites/node-v24.22.1-win-x64/node.exe' scripts/integration.mjs
```

可見驗收 `node scripts/live-verify.mjs` 會開兩個專用 WinForms 視窗，自動對它們送出真實輸入並比對結果，約 40 秒，執行期間不要碰滑鼠鍵盤。選項與判定方式見 [可見驗收操作](docs/LIVE-ACCEPTANCE.md)，最新結果見 [驗證紀錄](docs/VERIFICATION.md)。

第三方來源與授權見 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。每次封存的來源版本、雜湊、搬移與啟動結果，以該次外部交付報告及 `build-provenance`／manifest 為準。目前自動可見驗收 14/14 通過（含剪貼簿）；人工移動滑鼠案例尚未執行，詳見驗證紀錄。
