# 驗證紀錄 — Human Input 0.2.0

最後更新：2026-10-25（Asia/Taipei）。0.1 的紀錄保留在 [history/VERIFICATION-0.1.0.md](history/VERIFICATION-0.1.0.md)。

驗證分三層，每層證明的東西不同，不能互相替代：

| 層級 | 證明什麼 | 不證明什麼 |
|---|---|---|
| 單元／契約測試（Node、Rust） | 規劃器、service 狀態機、取消屏障、暫停／接續、wire 驗證、可攜版交易更新的邏輯 | 真的有輸入送到 Windows 視窗 |
| 可見驗收（`scripts/live-verify.mjs`） | 真實 worker 對本次新建的 WinForms 接收視窗送出輸入，接收端收到的結果與預期完全一致 | 其他應用程式、所有 DPI／鍵盤／IME 組合、遠端送達 |
| 可攜版驗收 | 搬移到含空格／Unicode 路徑、限制 PATH、內附 Node、更新／回退 | 全新 VM、其他 Windows 版本 |

## 目前結果

| 項目 | 結果 |
|---|---|
| Node 測試 `node --test tests/*.test.mjs` | 129/129 通過 |
| Rust 測試 `cargo test --locked` | worker 57/57、supervisor 1/1 通過；clippy all-targets 無警告 |
| 可見驗收（自動案例，含剪貼簿） | 14/14 通過，剪貼簿已還原，cleanup ok，無實體干擾、無遮擋 |
| 可見驗收 — 人工移動滑鼠 | 未執行：需要人配合，`--manual-motion` |
| 按鍵／拖曳／剪貼簿「按住中途」中斷 | 只有 Rust deterministic 測試覆蓋，沒有可見驗收 |
| Agent 思考中即時收到事件 | 不支援（`agent_push_supported:false`） |

可見驗收環境：Windows 11、DPI 168（175%）、繁體中文 IME（以 `force_ime_off:true` 暫時關閉）、worker SHA256 `775eb49bf54472aa34129a6022dbcf8d7ca8fc3c604a31ac9da0836d5e7a7715`。證據在 `work/live-v2-<時間>-<nonce>/verification.json`（不進版控）。

通過的自動案例：

| 案例 | 檢查內容 |
|---|---|
| `visible_launch` | 兩個新視窗可見、Normal、程序身分與實體幾何一致 |
| `safe_foreground_activation` | 前景先在停放視窗，`human_activate` 一次中性點擊取回前景；pad 恰好 down/up 各 +1，其他內容不變 |
| `typing_unicode_and_full_status_wire` | 逐字輸入 `Hi 4!字`，接收文字完全相符，回傳完整 status／progress |
| `explicit_keys_selection_navigation_enter` | Ctrl+A 選取 6 字、End 取消選取、Enter 換行、Backspace 還原 |
| `canvas_click_and_drag` | 點擊恰好 1 次；拖曳 down/up/drop 各 1 次且有拖曳移動 |
| `wheel_vertical_240`／`wheel_horizontal_120`／`wheel_vertical_-120` | 接收端 wheel 封包數與 delta 精確相符 |
| `clipboard_copy_cut_paste` | 從畫布移入 editor 點擊；copy／paste／cut／paste 後 A、B 文字完全符合本次 token；原剪貼簿已還原 |
| `reading_readonly_cancel_barrier` | 掃讀期間呼叫 7 種唯讀工具不會取消；取消屏障後沒有新的 worker 輸入 |
| `reading_explicit_pause_resume` | 暫停後沒有新輸入、暫停中拒絕新輸入、恢復後繼續移動 |
| `new_input_cancels_reading` | 新點擊先取消掃讀（`cancelled`＋cleanup），再點擊恰好 1 次 |
| `stop_while_paused`／`mode_off_while_paused` | 暫停中停止／關閉模式都到 `cancelled`，兩道屏障後都沒有新的 worker 輸入 |

「屏障後沒有新輸入」的判定：worker 的每個 `SendInput` 都帶 `dwExtraInfo = 0x48494d43`，接收端以 `GetMessageExtraInfo` 辨識，並記錄最後一個 worker 輸入的 `GetMessageTime`。以屏障回應之後取得的快照時間為基準，之後若出現時間更晚的 worker 輸入就判失敗。屏障前已送出、還在訊息佇列中的輸入不算違規。沒有帶標記的輸入計為實體輸入；案例期間若出現實體輸入，失敗會改列為 inconclusive（`physical_interference`）。接收端也記錄蓋住各控制項中心的外部視窗（只記 class 與程序名稱）；有遮擋時失敗改列 `occluded_by_other_window`。

## 本次驗收修正的問題

舊版可見驗收從未跑到任何輸入案例：兩次執行都停在「請使用者 300 秒內手動點 Ready」。改為全自動後，實際跑出以下問題並已修正：

| 問題 | 性質 | 修正 |
|---|---|---|
| 接收視窗以 `ShowDialog` 執行，模態迴圈把停放視窗停用，`human_activate` 對它回 `target_not_ready`；快照卻回報 WinForms 的 `Enabled=true`，掩蓋了問題 | 驗收工具缺陷 | 改用 `Application.Run`；快照改回報原生 `IsWindowEnabled` |
| **原生層對路徑上每個移動點都要求落在「游標下子控制項」的 client 區且 `WM_NCHITTEST` 回 `HTCLIENT`。** 移進帶邊框的控制項（文字框、清單）時路徑必經其邊框（`HTBORDER`），回 `point_occluded`。實際影響：無法從外面移入並點擊任何帶邊框的控制項 | 產品缺陷 | 純移動只要求游標下的視窗屬於目標本身或其子孫（外部視窗仍會遮擋）；按下／放開／滾輪維持嚴格檢查。新增 Rust 單元測試，可見驗收的 editor 點擊與剪貼簿案例通過 |
| 游標在目標 client 外時，`human_mouse_move`／`click`／`reading_start` 回傳難以理解的 `operation_failed (Point outside allowed bounds)` | 產品錯誤訊息與文件缺漏。安全模型本來就要求指標路徑全程在 client 內，只有 `human_activate` 能從外面進入 | service 先檢查並回傳 `cursor_outside_client`，說明要先用 `human_activate`；[工具契約](TOOLS-V2.md) 補上規則 |
| 讀取接收端計數時沒等訊息處理完，點擊／拖曳偶發判定為 0 次 | 驗收工具競態 | 等計數到達預期後再重讀一次確認精確值 |
| 屏障前已注入的佇列訊息被算成「屏障後輸入」；Windows 在游標沒動時也會送 `WM_MOUSEMOVE` | 驗收工具判定錯誤 | 改用訊息時間戳與注入標記判定；只計位置有變的移動 |
| 有人移動實體滑鼠時，產品正確暫停（`pointer_takeover`），驗收卻判為失敗 | 驗收工具判定錯誤 | 以注入標記區分實體輸入，改列 inconclusive |
| Node 置換 `command.json` 時接收端剛好在讀取，Windows 回 `EPERM` | 驗收工具競態 | 置換與讀取 ACK 遇到檔案忙碌時有界重試 |

## 尚未驗證

- **剪貼簿案例的前提**：驗收前必須能完整備份並還原使用者剪貼簿，只支援純文字格式。剪貼簿含圖片、HTML 等格式時該案例會略過；可以先複製一段純文字再執行，或加 `--discard-clipboard` 同意結束後清空剪貼簿。
- **已知小問題**：`human_activate` 接近途中游標被實體滑鼠推開時，回報的是 `unsafe_route`（路徑步距超過 8 px），而不是 `pointer_anomaly`。行為正確（停止、不點擊），只是分類不夠精確。
- **人工小幅偏移自動接續、持續大幅接管**：需要人依提示移動滑鼠，執行 `--manual-motion`。門檻值是工程預設，尚未校正。
- **按住中途中斷**：按鍵、拖曳、剪貼簿 hold 期間的中斷邊界只有 Rust deterministic 測試。
- 混合 DPI、多螢幕、其他鍵盤配置、遠端桌面接收、全新 VM、P95 延遲都未認證。強制終止或系統故障時無法保證輸入或剪貼簿清理。
- 事件發現、transport 寫入與 MCP caller ACK 都不等於 Agent 實際即時收到。

## 可攜版驗收（先前紀錄）

先前來源版本已完成：搬移到含空格的 Unicode 路徑、PATH 只含 System32、清除惡意 `NODE_OPTIONS`、內附 Node 24.22.1／.NET 10.0.13、Human 30 tools／protocol 2、官方 Touch 32 tools、可信 ZIP 更新、拒絕錯誤 checksum、忙碌鎖定、前版回退、探測程序樹 Job 退出。worker 與 supervisor 為 AMD64、static CRT，只匯入 Windows 系統 DLL。這些結果對應當時的來源版本；本次修改了原生命中測試、service 錯誤處理與驗收工具，沒有重新封裝或重跑可攜版驗收；下次封裝需重跑。每次封裝的精確雜湊以該次 `build-provenance`／manifest 為準。
