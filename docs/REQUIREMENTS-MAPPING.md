# 需求對照 — Human Input 0.2.0

基準為目前產品規格 `docs/PLAN.md`（原始碼 repo）。本表區分已實作的契約與驗證證據；實作存在不等於所有驗收已通過。

| 需求 | 實作與限制 | 證據位置 |
|---|---|---|
| 官方 Touch 獨立完整功能 | 原版官方套件及獨立 launcher、runtime、選版、更新與回退；不改舊安裝或現用 MCP 設定 | PORTABLE.md、Task 3 報告與 VERIFICATION.md |
| 單一明確語意輸入 | 移動／點擊／拖曳／逐字輸入／捲動／按鍵與專用複製／剪下／貼上；嚴格 schema、忙碌拒絕、無佇列 | TOOLS-V2.md、Node／native tests |
| 預設正確文字 | typo_rate 預設零，刻意 ASCII 錯字須明確啟用，Unicode 不虛構修正；不暗中貼上 | planners tests；可見接收驗收另列 |
| 安全前景取得 | human_activate 單獨對已確認 neutral area 點擊，再觀察；沒有焦點 API 或視窗重排 | native activation／guard tests；可見接收驗收另列 |
| 實體座標與原生檢查 | 程序建立身分、前景、可見、遮擋、幾何、DPI、焦點、鍵盤與游標 | NATIVE-PROTOCOL-V2.md；非所有實機組合認證 |
| 背景多區域掃讀 | 有順序／目的／方向／預算，只含純移動與停留，最多 60 秒，立即回傳 ID | planners／service tests；可見接收驗收另列 |
| 唯讀不中斷／新輸入取消 | 狀態、觀察、事件、倒數不取消；新輸入／目標／模式／停止先確認取消屏障；replace 明確指定 | service race tests、唯讀 MCP；可見接收驗收另列 |
| 所有工作保留接續進度 | 暫停清理屏障、revision、semantic journal、已送出不重播；未知效果須外部解決，拖曳 hold 另定 remaining gesture | native deterministic interruption tests；live mid-hold 仍需證據 |
| 指標異常與接管 | 立即暫停、最多 3000 ms 有界觀察，小幅穩定後安全自動恢復，持續大幅提前事件與人工恢復 | native trajectory tests；需人工可見驗收與後續門檻校正 |
| 即時 Agent 通知 | 原生事件、Node poll、bounded pending queue、可選 diagnostic transport、MCP caller ACK 分開記錄；agent_push_supported:false | MCP synthetic notification harness 通過，實際 Agent 思考中送達未驗證／不支援 |
| 倒數估算 | 外部 prepare／calibrate 時間範圍、單調估計、觀察值分開、超齡／暫停／恢復失效，歸零不輸入 | timer tests、readonly MCP |
| 多實例與斷線清理 | Human 共用具名輸入鎖、EOF／父租約取消、未證實清理禁止接續；不約束官方 Touch／其他軟體 | native／worker-client tests |
| 可攜式與交易更新 | 內附 Node／static worker／dependencies／官方 .NET，可信來源與雜湊、staging、程序樹清理、原子選版、前版回退 | portable tests 與實際 relocated acceptance |
| 可見接收端 | 本次 nonce、雙視窗、實體 geometry、manual Ready、已知文字比對、鍵盤／拖曳／wheel 計數、保守 clipboard lease、正常 close | LIVE-ACCEPTANCE.md；逐次結果以 VERIFICATION.md 為準 |

不含 OCR、頁面內容理解、同視窗換頁偵測、任意聊天訊息自動取消、GRE workflow、分數策略或遠端送達保證。沒有 P95、token 節省比例、全 Windows／鍵盤／DPI 組合或全新 VM 相容性承諾。0.1 的單次略過只屬歷史，不豁免目前與未來的可見驗收。
