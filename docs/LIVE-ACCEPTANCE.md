# 可見驗收操作

可見驗收會開兩個專用視窗（`Human Input receiver <nonce>`、`Parking <nonce>`），由真實 worker 對它們送出滑鼠、鍵盤與捲動輸入，再比對接收端實際收到的結果。只操作本次新建的視窗，不碰其他應用程式。命令須在原始碼 checkout 執行；可攜版不含測試腳本。結果見 [驗證紀錄](VERIFICATION.md)。

## 執行

先建置 worker，再執行驗收。執行期間約 40 秒，**不要碰滑鼠和鍵盤**。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build.ps1 -NoCopy
node scripts/live-verify.mjs
```

開始前有 5 秒倒數。結束時印出每個案例的結果表，完整證據寫入 `work/live-v2-<時間>-<nonce>/verification.json`。有任何 failed 或清理失敗時 exit code 為 1。

| 選項 | 作用 |
|---|---|
| `--worker PATH` | 指定 worker；預設 `native/target/portable/x86_64-pc-windows-msvc/release/human-input-worker.exe`。報告記錄其 SHA256 |
| `--manual-motion` | 另跑兩個需要人配合的案例：依終端提示小幅推一下滑鼠、或大範圍來回移動，驗證自動接續與接管 |
| `--discard-clipboard` | 剪貼簿含非文字格式時，同意結束後清空剪貼簿，而不是略過剪貼簿案例 |
| `--keep-ime` | 不對 `human_type` 傳 `force_ime_off:true`（預設會傳，避免中文輸入法吃掉字元） |
| `--only a,b` | 只跑指定案例 |

## 運作方式

- **取得前景不靠焦點 API。** 接收視窗與停放視窗設為 TopMost，避免被其他程式遮住。需要前景或游標不在接收視窗內時，用產品自己的 `human_activate` 點擊中性 pad（綠色區塊或停放視窗的黃色區塊）。產品規定指標路徑全程留在目標 client 內，只有 `human_activate` 能從外面進入。
- **每個案例獨立。** 案例開始前先 `human_stop`、確認模式開啟、建立自己需要的前置狀態。一個案例失敗不會擋住後面的案例；只有清理無法確認時才中止。
- **接收端只報告比對結果。** 文字只回報是否等於已知期待值與長度，不保存自由文字。點擊、拖曳、wheel 以計數與 delta 精確比對，等計數到達後再重讀一次確認沒有多出來。
- **屏障判定用時間戳。** worker 的 `SendInput` 帶 `dwExtraInfo = 0x48494d43`。接收端以 `GetMessageExtraInfo` 區分 worker 輸入與實體輸入，記錄最後一個 worker 輸入的 `GetMessageTime`。屏障回應後若出現更晚的 worker 輸入即失敗；屏障前已在佇列中的輸入不算。
- **實體干擾另列。** 案例期間接收端收到沒有標記的輸入時，失敗改列 `inconclusive`（`physical_interference`）。產品偵測到人為移動而暫停是正確行為。接收端也回報蓋住控制項中心的外部視窗（class 與程序名稱），有遮擋時改列 `occluded_by_other_window`。
- **剪貼簿先備份。** 由接收程序在記憶體中備份原剪貼簿（只支援純文字與 locale 格式，不寫檔、不列印），測試只比對本次 token，結束時在剪貼簿未被他人改動的前提下還原。無法安全備份時略過該案例，除非加 `--discard-clipboard`。
- **清理。** 結束時停止輸入、關閉模式、還原剪貼簿、關閉 MCP，再以命令正常關閉視窗。清理無法確認時保留視窗並提示手動關閉，不強制終止。接收程序 20 分鐘後自行關閉。

## 非侵入檢查

不開視窗、不注入輸入、不存取真實剪貼簿：

```powershell
node --test tests/fixture.test.mjs tests/fixture-lifecycle.test.mjs tests/fixture-editor.test.mjs tests/fixture-clipboard.test.mjs
powershell -NoProfile -STA -ExecutionPolicy Bypass -File scripts/test-window.ps1 -CompileOnly
```
