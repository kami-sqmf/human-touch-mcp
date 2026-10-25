# 驗證紀錄 — 2026-10-24

版本：Human Input MCP 0.1.0。環境：Windows 10.0.26300.0 x64、Node.js 25.8.1、Rust 1.94.0、MSVC 14.44。Node 20 是套件宣告的最低版本，本次並未逐一驗證所有 Node／Windows 版本。

| 驗證 | 結果與範圍 |
|---|---|
| `npm.cmd test` | 52/52 通過：曲線／停留、文字重播、計時不確定性、模式與取消競態、IPC 上限、唯讀不中斷、EOF 清理及無強制終止。 |
| `cargo test --locked --manifest-path native/Cargo.toml` | 18/18 通過：完整計畫驗證、分數毫秒、身分／幾何、取消屏障、無佇列、租約／EOF、清理失敗、延遲停止及實際按下時間。使用隔離 fake platform，不表示已測所有真實 Windows 狀態。 |
| `node --test native/tests/ipc-readonly.mjs` | 1/1 通過：真實 release worker 的握手、格式／大小限制、未知目標、分數時間接收、取消及 EOF 結束。不注入輸入。 |
| `npm.cmd run test:integration` | 19 個工具經真實 MCP SDK stdio 初始化／列出／呼叫；預設關閉、計畫預覽、倒數、拒絕輸入，以及真實 Rust 無效 HWND 錯誤皆通過。 |
| Rust fmt／Clippy | 子代理完成 `cargo fmt --check` 與 `cargo clippy --all-targets -- -D warnings`，皆通過。 |
| 獨立審查 | 發現並修復分數時間 IPC、零距離 NaN、倒數取整、焦點子樹、強制終止清理與延遲補送問題。複審在此範圍沒有未解決發現。 |
| 發行 DLL 相依 | dumpbin 確認 Windows 系統 DLL 與 VCRUNTIME140.dll／UCRT；新電腦需安裝 Microsoft Visual C++ v14 x64 執行階段。 |

## 本次略過實際桌面輸入驗證

使用者明確要求「跳過驗證，僅本次跳過」。停止本次可見 WinForms 測試，不再重試。測試程式保留，下次仍可執行，這不是永久停用驗證的偏好。

最初啟動使用隱藏設定，未向使用者成功顯示測試視窗；後來改為正常互動視窗，Windows 可見狀態與標題確認成功。最後一次嘗試由 native 回報 `pointer_takeover`，訊息為「Tool detected pointer takeover」，狀態 `failed`，`injected_events:0`、`inputInjected:false`。只描述工具偵測結果，不認定操作者或誤報原因。

因此未取得逐字輸入、點擊、掃讀與取消在真實接收視窗的完整端到端成功證據，不能宣稱已通過實際輸入驗收。也未宣稱已驗證 Unicode／IME／所有鍵盤配置、跨程序 mutex 的實機競爭、混合 DPI／多螢幕、遠端桌面送達，或 P95 延遲門檻。

## 產物與界線

`bin/human-input-worker.exe` SHA-256：

`3cc0c7e47b726541edd1f00e4ca84485b4944d480a8199a7cb369482324a9567`

官方 Touch 2.3.2 的下載校驗在工作資料夾 `docs/DOWNLOADS.json`。新產品沒有 Python、hooks、畫面擷取、OCR 或官方 runtime 匯入。沒有更改現用 Codex MCP 設定，沒有連到真實考試視窗或提交任何內容。
