# Windows x64 可攜版

解壓整個資料夾即可使用。Human Input 與官方原版 Touch 各自選版、啟動及更新；所有命令以套件位置解析，不需要系統 Node、npm、Rust 或編譯器。請保留 `runtime`、`manager`、`versions`、授權及檔案清單。搬移後重新產生設定；命令只輸出設定，不會修改現用 MCP 設定。

```powershell
.\launch.ps1 version human
.\launch.ps1 version touch
.\launch.ps1 verify human
.\launch.ps1 verify human --boot
.\launch.ps1 verify touch --boot
.\launch.ps1 config human
.\launch.ps1 config touch
.\launch.ps1 config human --format json
```

`verify` 只核對完整檔案雜湊與系統需求；`--boot` 會 initialize、列出工具、關閉傳輸並等待整棵子程序樹結束。Human 另做 worker hello，並透過 MCP 實際的 Node WorkerClient 呼叫 `human_observe`，只傳入超出 Windows HWND 範圍的 `18446744073709551616`，要求原生回覆 `invalid_hwnd`；輸入模式維持關閉。官方啟動本身會出現暫時的系統匣及背景監看程序；官方探測不呼叫輸入、視窗、截圖、剪貼簿或探索工具。探測會移除 docking／dogfood 環境設定、關閉記憶持久化並將診斷記錄放在套件的 `mutable`。正常啟動保留官方原有功能與設定行為。

將 `config` 輸出貼入 MCP 主程式設定。設定直接執行預編譯監督程式以保留原始 stdio。命令列便利啟動器為 `launch.cmd launch human`／`launch.cmd launch touch`，Windows PowerShell 5 亦可執行 `launch.ps1`。官方原生模組仍需 Microsoft VC++ x64 v14 Runtime；缺少時啟動器會顯示 [Microsoft 安裝程式](https://aka.ms/vc14/vc_redist.x64.exe) 及[官方說明](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist?view=msvc-170)。不會自動安裝。官方子程序會從 Windows 內建 PowerShell 路徑啟動系統匣與輔助功能；不依賴 PATH Node。套件已內附官方 Node 24.22.1、.NET 10.0.13 core／Windows Desktop Runtime；Human worker／監督程式使用 static CRT。

```powershell
# SHA256 必須由另一個可信管道取得；套件旁的 .sha256 只提供一致性資料。
.\launch.ps1 update human --bundle 'D:\下載\human-input-0.2.0.zip' --sha256 '可信的64字元雜湊'
.\launch.ps1 update human --url 'https://你的明確來源/release.zip' --sha256 '可信的64字元雜湊'
# 僅在明確執行時向官方 npm 查詢，使用原版 finalized launcher 的 ensureRelease 校驗流程。
.\launch.ps1 update touch --version 2.3.2
.\launch.ps1 update touch --version latest
.\launch.ps1 rollback human
.\launch.ps1 rollback touch
```

首次安裝元件使用同樣的 `install human|touch --bundle ... --sha256 ...`。更新只接受根目錄含 `manifest.json` 的元件 ZIP，不能拿完整可攜版 ZIP 當元件 ZIP。安裝先校驗可信 SHA256、所有 ZIP 路徑與大小、完整檔案清單及雜湊，再執行有期限的唯讀握手；成功後才以同磁碟 `File.Replace` 切換選版，保留前版。失敗保留原選版。回退完全離線，重驗前版後交換選版記錄；沒有自動更新、啟動時版本查詢或自動刪除前版。

Human 更新以已驗證 manifest 的產品版本核對 MCP server 名稱／版本及 native hello 的版本／Windows 平台，要求 manifest 與 worker 的 protocol 2，並核對 MCP 協定協商結果。實際 Node→worker 唯讀探測會拒絕內部 WorkerClient 版本不一致、傳輸錯誤與非預期工具錯誤；只更新 serverInfo 不能通過。啟動前也直接檢查內附 Node 的 AMD64 PE 機器類型，不只相信 manifest 的 x64 標示。每次探測使用同一 Rust 監督程式建立獨立 Windows Job；整棵探測子程序樹退出後才允許切版或刪除 staging。探測期限到而無法確認清理時，回報 `cleanup_unconfirmed`、拒絕切版並保留 staging。外層監督程式仍持有執行鎖並等待子程序自然退出，因此整個命令的退出時間不承諾同一期限。

每個元件有獨立 OS 檔案鎖，允許另一元件繼續使用。元件執行中更新／回退會顯示 busy，請先停止 Human 工作，再由 MCP 主程式正常停止該伺服器。監督程式先以 suspended 啟動、加入 Windows Job，再開始執行；監督程式持有實際鎖與 Job，直到所有子程序退出。監督程式或主 Node 崩潰時，仍以 Job／檔案控制代碼保護子程序清理，不依 PID 年齡刪鎖，也不強制結束 worker。具名 Job 的持久記錄可在監督程式崩潰後確認仍存活的子程序；無法承諾外部強制終止產品程序後的輸入清理。意外中斷留下的 staging 永遠不會被選用；沒有自動清除或剪除命令。

`home/current.json`、`mutable` 是官方可寫狀態，其他 manifest 宣告的檔案必須完全一致。原版 Touch 的憑證、使用者記憶與部分設定仍依上游採每使用者路徑；搬移套件不代表搬移所有個人資料。正常官方功能未經修改。更新新官方版本若 npm 結構、原版安裝 API、封存函式庫或輔助執行階段需求變更，會要求相容性審核。此版接受 Windows x64；未宣稱已通過全新 Windows VM 的 DLL 相容性測試。

開發機重建需要先備妥已校驗的輸入：`work/downloads/` 放 Node 24.22.1 Windows x64 ZIP、官方 `desktop-touch-mcp-2.3.2.tgz` 與 .NET 10.0.13 封存；`work/prerequisites/` 放解壓後的 Node、`dotnet-10.0.13-provenance.json` 與官方 runtime v2.3.2（含 `verified-files.json`）。所有預期雜湊寫在 `scripts/portable/build-package.mjs`，不符即中止。備妥後執行 `scripts/build.ps1`、`scripts/package.ps1`。官方 Touch 安裝目錄預設為 repo 上一層的 `official/installation`，可用環境變數 `HUMAN_INPUT_OFFICIAL_INSTALL` 指定其他位置。編譯工具只用於開發機；不要在一般安裝機執行建置腳本。完整保留 Human、Node、官方 Touch、.NET 及套件相依的原有授權文字。
