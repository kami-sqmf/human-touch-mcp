# 實作契約 — Human Input 0.2.0 / protocol 2

產品規格為原始碼 repo 的 `docs/PLAN.md`。公開 MCP 介面以 [TOOLS-V2.md](TOOLS-V2.md) 與 `lib/tools.mjs` 的嚴格 schema 為準；原生 wire、狀態、進度、事件、取消屏障及接續規則以 [NATIVE-PROTOCOL-V2.md](NATIVE-PROTOCOL-V2.md) 為準。本文整理共同約束，不複製另一份可能過期的 schema。

- Windows x64、Node MCP 與獨立 Rust worker。30 個工具，版本 0.2.0、protocol 2。每個新程序 human mode 關閉，不重播舊工作。
- 只有背景掃讀允許多個純移動。其他公開輸入每次一個明確語意操作；不得隱藏剪下／貼上、提交、多步輸入或自動重試。預設錯字率為零。
- 全部座標為實體螢幕像素。輸入前／期間檢查程序建立身分、前景、可見性、遮擋、幾何、DPI、游標、焦點及鍵盤。輸入與檢查不是 Windows 原子交易。
- 安全前景取得只透過獨立 `human_activate` 的明確安全區域點擊。沒有焦點 API、快捷鍵切窗或視窗重排。
- 系統剪貼簿複製／剪下／貼上只送出專用 Ctrl+C/X/V；產品不讀取剪貼簿內容。測試用 STA 備份輔助程式位於 `scripts/fixture`，不屬於產品 worker。
- 暫停／取消回應是清理屏障。保留精確 revision、已送出與未送出效果；不重播已送出效果。暫停拒絕新輸入，不明效果要求外部證據與明確 resolution。清理未證實則禁止後續輸入。
- 游標異常立即暫停，最多觀察 3000 ms；短暫穩定的小幅移動可在安全重檢後自動接續。持續大範圍移動成立即發事件並維持人工暫停。預設門檻可設定，尚未宣稱校正。
- 狀態／觀察／事件／倒數等唯讀工具不取消掃讀。新輸入、目標／模式變更及停止必須先確認舊工作的取消屏障。停止／斷線／重啟不自動恢復。
- 事件偵測、Node 發現、通知傳輸寫入、呼叫者 ACK 與 Agent 實際收到是不同證據。`agent_push_supported:false`；ACK 不恢復輸入。實際主程式的 Agent 即時送達未驗證。
- `completed` 不代表應用程式成功；原生 `deliveryVerified` 恆為 false。所有接收結果由外部觀察或隔離接收端另行核對。
- 沒有畫面取樣、OCR、hooks、網路輸入伺服器、驅動程式、官方 Touch runtime 匯入或 Python 執行需求。明確更新命令可取得使用者指定 HTTPS 來源；這不等於輸入 worker 具備網路行為。
- 兩套 MCP 分開安裝、啟動、選版、更新及回退；不修改現用 MCP 設定或原安裝。可攜版完整性、原子選版、鎖定與程序樹清理契約見 [PORTABLE.md](PORTABLE.md)。

舊 [protocol 1 契約](history/CONTRACT-0.1.0.md) 僅供歷史參考，其禁止按鍵、剪貼簿、安全啟動及恢復的敘述不適用 0.2.0。測試證據及未完成項目見 [VERIFICATION.md](VERIFICATION.md)。
