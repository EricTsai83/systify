# Artifacts Results & Repository Status — UX 重構規劃（資料夾結構版）

## Context

使用者反映目前 artifacts Results 與 Repository status 的呈現方式想再優化閱讀體驗。經盤點與設計討論，主要痛點與改造方向如下：

1. **長篇 artifact 閱讀體驗受限**：`src/components/artifact-markdown.tsx:61` 把每個 artifact body 鎖在 `max-h-72`（288px）內捲軸，加上面板最寬 28rem（448px），deep_analysis 這種數千字長文等同於塞進小視窗瀏覽。
2. **artifacts 沒有組織結構**：目前 `ArtifactPanel` 用「Repository intelligence + Thread outputs」兩個平面 section 呈現，無法以「功能單位」分群（如「OAuth 功能」資料夾下放它的 System Design、ADR、failure_mode 一次看齊）。
3. **狀態與變更通知過度分散**：StatusPill、StatusPanel、ImportStatusBanner、WorkspaceSetupBanner、WorkspaceReadyBanner、RepoStatusIndicator 共 6 個元件處理「目前發生什麼」；artifact 變更只靠 `actionNotice` 5 秒 toast 通知。
4. **`sandbox` mode 完全沒有 repo 瀏覽 UI** — assistant 透過 tool call 讀檔但使用者看不到檔案系統。`convex/schema.ts:355-373` 的 `repoFiles` 表已備齊 `parentPath`、`fileType`、`language`、`summary` 與必要索引，前端只缺實作。

使用者已確認方向：
- Reader 與 Sandbox Explorer 採「左窄 chat + 右寬主工作區」layout（**不是 V0 iframe 模式**，artifacts 都是靜態內容無需執行）
- artifacts 改以**資料夾結構**閱讀（類 Notion 的 first-class 資料夾抽象，可自建、可移動、可巢狀）
- 一般 chat（discuss / docs 短回答）保留 chat-centric

## 設計參照

| Surface | 比較像哪個產品 | 主工作區內容 |
|---------|-------------|-----------|
| **Folder Navigator + Reader** | Notion / Obsidian 的 vault | 左：資料夾樹 + 內含 artifacts；右：選中 artifact 的全文閱讀區 |
| **Sandbox Explorer** | GitHub web 的 repo 瀏覽 | 左 file tree + 中央檔案內容預覽（唯讀） |

**資料夾分類符合產品語意**：artifact kinds 天然分兩群 — repo 級（manifest、deep_analysis、architecture_overview…）vs 功能/決策級（ADR、failure_mode_analysis、trade_off_matrix、migration_plan…）。前者適合放根目錄，後者天生想被「以功能聚集」閱讀。

---

## 設計判斷摘要

### 為什麼不全面套用「左 chat + 右工作區」
- `discuss` mode 沒 artifact，右側留空尷尬
- `docs` 一個回答常引用多個 `[A#]`，右側一次只能聚焦一個
- 探索性問答本身就是答案，沒主工作區內容可放

### Layout 由 mode / 路由決定
| 情境 | Layout |
|------|--------|
| `discuss` / `docs` 一般對話 | chat-centric（資料夾樹收進右 rail，可摺疊） |
| Reader（`/w/:wid/a/:aid`） | 左：資料夾樹 + chat sidebar 共用左欄（tabs 切換）；右：artifact 全文區 |
| `sandbox` mode（thread 路由內） | 三欄：左 file tree（~280px）+ 中央檔案 preview + 右／底部 chat |

mode 切換改變 layout — 同時順手解決「mode 不可見」問題。

---

## 推薦做法

### Pillar 1: Artifact Folders 資料模型（新基礎）

**Schema 改動（widen-migrate-narrow）**：

```ts
// convex/schema.ts 新增
artifactFolders: defineTable({
  ownerTokenIdentifier: v.string(),
  repositoryId: v.optional(v.id("repositories")), // workspace 範圍
  parentFolderId: v.optional(v.id("artifactFolders")), // 巢狀
  name: v.string(),
  description: v.optional(v.string()), // 資料夾封面說明
  sortOrder: v.optional(v.number()), // 同層排序
})
  .index("by_repositoryId_and_parentFolderId", ["repositoryId", "parentFolderId"])
  .index("by_ownerTokenIdentifier", ["ownerTokenIdentifier"])

// convex/schema.ts artifacts 表 widen
folderId: v.optional(v.id("artifactFolders")),
```

**遷移策略**：
- 既有 artifacts 的 `folderId` 為 undefined → UI 視為「未分類」，呈現於「Uncategorized」虛擬節點或根目錄
- 不需要 backfill；使用者有需要時手動移入資料夾
- 保持 widen-only — narrow（讓 `folderId` required）非必要，未分類本身是合理狀態

**新增 query / mutation**：
- `api.artifactFolders.listByRepository` — 取整個 repo 的資料夾樹（一次拉，前端建樹）
- `api.artifactFolders.create / rename / delete / move`
- `api.artifacts.moveToFolder({ artifactId, folderId | null })`
- `api.artifacts.listByFolder({ folderId })` — 樹節點展開時用
- 刪除資料夾時：選擇「artifacts 移到父層」或「連同 artifacts 一起刪」（UI 二次確認）

**生成流程整合**：
- 當 chat 觸發產生 ADR / failure_mode / 等決策級 artifact，生成 dialog 加「Folder」picker（可下拉選現有、或鍵入名稱當場建立）
- 預設值：若當前 thread 已有「活躍資料夾」（thread 的最近一個 artifact 落腳處），預填該資料夾；否則放根
- repo 級 kinds（manifest、deep_analysis、architecture_overview）一律自動放根目錄不問

### Pillar 2: Folder Navigator（取代現況平面 panel）

**功能**：在所有 artifact 出現的地方都用同一棵樹。

- 元件：`<FolderNavigator />` — 樹狀渲染，節點分 `Folder` 與 `Artifact` 兩類
- 摺疊狀態 persist 到 localStorage（per repo）
- 樹根固定兩個分區：「**Repository**」（repo 級 artifacts）+ 「**Folders**」（使用者建立的功能資料夾，含「Uncategorized」未分類虛擬節點）
- 資料夾節點顯示：名稱、子項目數量、最近更新時間
- artifact 節點顯示：title、kind 徽章、版本徽章、最近變更 pulse 點（最近 5 分鐘內更新）
- 互動：
  - 點 artifact → 進 Reader（`/w/:wid/a/:aid`）
  - 點資料夾 → 在右側展示「資料夾總覽」（description + 內含 artifacts list with summary preview）
  - hover 節點 → kebab menu：rename / move / delete / 「Ask about this folder」（chat 加全資料夾為脈絡）
  - 拖曳 artifact 到資料夾 → 呼叫 `moveToFolder`
- Search：頂部 input，按名稱、kind、folder 過濾

**Reference Panel（chat-centric mode 用的右 rail）改造**：
- 內容換成 `<FolderNavigator />` + 卡片摘要（選中 artifact 才展開卡片預覽）
- 拿掉 `src/components/artifact-markdown.tsx:61` 的 `max-h-72`（外層決定高度）
- 卡片改 summary + 前 ~150 字預覽 + Read more；標題列加 BookOpenIcon 進 Reader
- 保留 `[A#]` 跳轉、Ask about、相對時間、版本徽章

### Pillar 3: Artifact Reader（資料夾感知）

**目標**：讓 deep_analysis 等長文有真正能讀的空間，且能用 chat 迭代修改。形狀比較接近 Notion / Obsidian 的單篇閱讀模式。

**路由**：`/w/:workspaceId/a/:artifactId` — 在 `src/route-paths.ts:33-38` `PROTECTED_ROUTE_SEGMENTS` 加 `workspaceArtifact: "w/:workspaceId/a/:artifactId"`，補 `workspaceArtifactPath()` helper。

**Layout（桌機）**：
- 左 ~360px：tabs 在「Folders」（`<FolderNavigator />`）與「Chat」（縮減版 chat composer + stream）之間切換；預設開「Folders」讓使用者沿著資料夾閱讀
- 右：剩餘空間呈現 artifact 內容 — `max-w-[68ch]` 字行寬，markdown 由 `ArtifactMarkdown` 渲染、mermaid 由 `MermaidRenderer` 渲染（依 `kind` 分派）
- 浮層 / 工具列：
  - 頂端麵包屑：`Repository / OAuth feature / System Design`（資料夾路徑點擊可回上一層）
  - 頂端工具列：版本切換 dropdown、複製 Markdown、移動到資料夾、重新產生、返回 thread
  - 右上 ToC（從 H1/H2/H3 抽）
  - 底部 sibling nav：「← OAuth ADR」「Failure mode →」（同資料夾內前後 artifact）

**Layout（行動）**：
- 預設 artifact 全螢幕
- 底部三按鈕 dock：「Folders」「Ask」「ToC」分別展開對應 sheet
- chat 訊息送出後自動收合 sheet 看右側更新

**「直接改編」迭代機制**：
- chat 以 docs mode 對該 artifact 做 prompt（auto-context 把當前 artifact 餵進 prompt）
- chat 觸發重新產生 → 寫入新版 artifact（Pillar 5 版本鏈）→ 右側自動切到新版 + 高亮變動段落
- **沒有 iframe** — artifact 是靜態內容，重新渲染 React 元件即可
- 段落層級 patch（vs 整份重生）建議 Phase B 後評估，第一版先做整份重生 + diff 高亮

**進入 Reader 的入口**：
- 資料夾樹點擊
- `[A#]` 引用 hover 顯示「Open」
- StatusPanel「View analysis」
- chat inline event card（Pillar 4）

### Pillar 4: Sandbox Explorer（新 — 補洞）

**目標**：sandbox mode 下使用者第一次能直接瀏覽 repo，chat 以選定檔案為脈絡。**注意**：這是 repo 原始碼瀏覽器，與 artifact folders 是不同的東西（一個是檔案系統樹，一個是知識庫樹）。

**觸發**：當 thread `mode === "sandbox"` 時，`repository-shell.tsx` 切換為 Explorer layout（不需新路由，沿用 `/w/:wid/t/:tid`）。

**Layout（桌機）**：
- 左 ~280px：file tree
  - 資料源：`api.repoFiles.listByParent({ repositoryId, parentPath })` — 新增 query，沿著 `by_repositoryId_and_parentPath` 索引懶載入子節點
  - 折疊式目錄、icon 區分 file/dir、`isEntryPoint / isImportant` 用徽章
  - sandbox not-ready 時顯示禁用態，提示「Sandbox starting…」
- 中央：preview 區
  - 唯讀；點檔案時呼叫現有 sandbox tool 讀內容（重用 `convex/chat/sandboxTools.ts` 的 `read_file` 路徑，包成內部 query）
  - 大檔（>200KB）截斷 + download 連結
  - 語法高亮：先用 highlight.js 或 shiki（看 bundle 預算）；fallback 純文字
  - 上方麵包屑顯示路徑、複製路徑、複製為 prompt 引用
- 右側 / 底部：chat
  - ≥ xl：右側 ~420px chat panel
  - < xl：底部 ~40dvh chat panel（與 preview 上下分割）
  - composer 顯示「Context: src/components/artifact-panel.tsx」chip（選中檔案自動帶為脈絡）
  - chat 回覆若提到檔案路徑，自動在 preview 跳到對應檔/行；若觸發 artifact 生成，仍寫入 `artifacts` 表並透過 chat event card 通知（Pillar 6）

**Layout（行動）**：三 tab `Tree / Preview / Chat` 切換，chat 送訊後自動切到 Preview tab。

**檔案脈絡傳給 chat**：
- 選中檔案 → `sendMessage` 帶 `selectedFilePath`，後端 prompt 預先載入該檔內容（< token 預算）
- 不需要 schema 改動 — 走參數傳遞即可

### Pillar 5: 版本歷史與 Diff

**現況**：所有 artifact insert 硬編碼 `version: 1`（`convex/analysis.ts:308`、`convex/architectureDiagram.ts:76`、`convex/artifactStore.ts:51` 等共 30+ 處）— 無歷史。

**Schema 改動（widen）**：
- `artifacts` 表加 `previousVersionId: v.optional(v.id("artifacts"))`
- 維持每次重跑 = 新 row，但帶 `previousVersionId` 指向上一版，並把 `version` 真正自增（lookup `by_repositoryId_and_kind` 最大 version + 1）
- 新版自動繼承上一版的 `folderId`，使用者重生不會遺失分類

**新增 query**：`api.artifacts.listVersionChain({ artifactId })` 沿 `previousVersionId` 回溯 N 層（如 5）給 Reader 版本切換 dropdown 用。

**Diff 實作**：第一階段用 `ArtifactMarkdown` 的 block parser（`src/components/artifact-markdown.tsx:78-158`），把兩個版本各 parse 成 block list，做段落層級 diff（identifier 用 heading 路徑 + 內容 hash），呈現 added/removed/changed 三色。不引入 diff library。

### Pillar 6: Inline Chat Artifact Events（取代 toast）

**Schema 改動（widen）**：
- `messages` 表加 optional `eventKind: v.optional(v.union(v.literal("artifact_created"), v.literal("artifact_updated"), v.literal("artifact_failed")))` 與 `eventPayload: v.optional(v.object({ artifactId, fromVersion?, toVersion, summary?, jobId?, folderName? }))`
- `role` 用既有 `system`，事件靠 `eventKind` 區分

**寫入點**：所有目前觸發 `actionNotice` 的 mutation（artifact insert、re-generate、失敗終結）改為同時寫入一筆 `eventKind != null` 的 system message。

**渲染**：在 `src/components/chat-message.tsx` 偵測 `eventKind` render 為 `ChatArtifactEvent` 卡片：

```
┌─ 📄 Updated System Design · v2 ───────────────┐
│  Folder: OAuth feature                         │
│  Refreshed after recent indexing changes       │
│  [Read in Reader]  [See diff (v1 vs v2)]       │
└────────────────────────────────────────────────┘
```

點擊 → 進 Reader 並選定該版本，diff 對應 v(n-1)。同時 Folder Navigator 對應節點亮 pulse。`actionNotice` 改為僅短暫提示，主要事實由 chat event 持久承載。

### Pillar 7: Status 整併

**保留**：StatusPill、StatusPanel、WorkspaceSetupBanner（first-run 特例）。

**刪除**：
- `src/components/import-status-banner.tsx` → 合併進 StatusPanel Activity 區塊
- `src/components/workspace-ready-banner.tsx` → 改 chat inline event「✨ Workspace ready · First analysis complete · [Read it]」
- `src/components/repo-status-indicator.tsx` → 合進 StatusPill `reasonCode`

### Pillar 8: Mode 與 Workspace 可見性

- Mode chip 從 composer 抬到 top bar 旁，配 tooltip；切換時 chat 上方輕量 hint
- mode 切換 = layout 切換（chat-centric ↔ Sandbox Explorer），讓 mode 變得「可見且可感」
- Top bar 加 workspace breadcrumb：`Workspaces / acme-app / Thread title`

---

## 關鍵檔案

### 新增
- `src/pages/artifact-reader.tsx`（Reader 頁殼）
- `src/components/artifact-reader.tsx`（Reader 主元件：左 tabs Folders/Chat + 右 artifact 主區）
- `src/components/folder-navigator.tsx`（資料夾樹；可被 reader、ArtifactPanel、generation dialog 共用）
- `src/components/folder-overview.tsx`（資料夾總覽 — description + 內含 artifacts list）
- `src/components/folder-picker.tsx`（生成 / 移動時的資料夾選擇 dropdown，含「+ New folder」inline create）
- `src/components/artifact-diff.tsx`（block-level diff，重用 `ArtifactMarkdown` parser）
- `src/components/artifact-version-switcher.tsx`（版本切換 dropdown）
- `src/components/chat-artifact-event.tsx`（chat 內 inline event card）
- `src/components/sandbox-explorer.tsx`（三欄 layout 容器）
- `src/components/file-tree.tsx`（左欄 lazy-loaded repo tree）
- `src/components/file-preview.tsx`（中央 repo 檔案 preview）
- `src/hooks/use-selected-file.ts`（preview 選中狀態 + chat 上下文 chip）
- `convex/artifactFolders.ts`（list / create / rename / delete / move mutations + queries）
- `convex/repoFiles.ts`（`listByParent`、`getByPath` query）
- `convex/artifactVersions.ts`（`listVersionChain` query）

### 修改
- `src/route-paths.ts:33-38` — 加 `workspaceArtifact` 與 `workspaceArtifactPath()` helper
- `src/router.tsx:29-47` — 註冊 Reader 路由
- `src/components/artifact-markdown.tsx:61` — 移除 `max-h-72`，外層決定高度
- `src/components/artifact-panel.tsx` — 整支重塑為「`<FolderNavigator />` + 選中卡片預覽」；不再用兩個平面 section
- `src/components/repository-shell.tsx` — 依 `thread.mode` 切換 layout（chat-centric / Sandbox Explorer）；`actionNotice` 改短暫提示；拿掉 ImportStatusBanner / WorkspaceReadyBanner / RepoStatusIndicator 渲染
- `src/components/chat-message.tsx` — 偵測 `eventKind` render `ChatArtifactEvent`
- `src/components/chat-panel.tsx` — 抽出可在 Reader sidebar / Sandbox Explorer 重用的 chat 變體；mode chip 抬走後清理
- `src/components/top-bar.tsx` — workspace breadcrumb + Mode chip
- `src/components/deep-analysis-dialog.tsx` 與其他生成 dialog — 加入 `<FolderPicker />`，把 `folderId` 傳到後端 mutation
- `convex/schema.ts` — 新增 `artifactFolders` 表；`artifacts.folderId`、`artifacts.previousVersionId`；`messages.eventKind` + `eventPayload`
- `convex/analysis.ts:299-308`、`convex/architectureDiagram.ts:67-76`、`convex/artifactStore.ts:41-51`、`convex/designArtifacts.ts` — 所有 `db.insert("artifacts", …)` 處：(a) 接受 `folderId` 參數（決策級 kinds）或自動放根（repo 級 kinds），(b) 先 lookup 上一版以決定 `version` 與 `previousVersionId`、繼承 `folderId`，(c) 同步寫入 `messages` event row
- `convex/artifacts.ts` — 補 `getById`、`listVersionChain`、`moveToFolder`、`listByFolder`
- `convex/chat/generation.ts` / `convex/chat/sendMessage` — sandbox mode 接受 `selectedFilePath` 參數

### 刪除
- `src/components/import-status-banner.tsx`、`src/components/workspace-ready-banner.tsx`、`src/components/repo-status-indicator.tsx` 與引用 / 測試

### 重用
- `ArtifactMarkdown` block parser（`src/components/artifact-markdown.tsx:78-158`）→ Reader、Diff 共用
- `formatArtifactKind`（`src/lib/operations.ts`）→ Reader header / Folder navigator 徽章
- `MermaidRenderer`（`src/components/mermaid-renderer.tsx`）→ Reader 中 architecture_diagram body
- `messages.citationMap`（schema:457-464）→ `[A#]` 流程不變
- `convex/chat/sandboxTools.ts` 既有 `read_file` → Sandbox Explorer preview 包同樣執行路徑
- `repoFiles` 表（schema:355-373）→ 直接撐 file tree
- 既有 `onAskAboutArtifact` callback（`repository-shell.tsx:647-667`）→ 各處提問動作沿用

---

## Verification

End-to-end 場景：

1. **資料夾建立與分類**：對 chat 下「設計 OAuth 系統」→ 觸發 ADR 生成 dialog → 在 FolderPicker 鍵入「OAuth feature」當場建立資料夾 → ADR 落入該資料夾；後續再產生 failure_mode 預設選同一資料夾
2. **資料夾巡覽閱讀**：Reader 左欄展開「OAuth feature」資料夾 → 看到三份 artifacts 清單 → 點 System Design 進閱讀；底部 sibling nav 顯示「← OAuth ADR」「Failure mode →」可前後翻；麵包屑顯示完整路徑
3. **跨資料夾搬移**：右鍵某 artifact「Move to folder」→ 選另一資料夾 → 所有 panel 同步更新；已開啟的 Reader 麵包屑刷新
4. **資料夾刪除**：刪資料夾彈確認框「移到上層 / 連同 artifacts 一起刪」；移到上層後 artifacts 變未分類
5. **Reader 閱讀與迭代**：開 ~3000 字 deep_analysis：左欄 chat tab 下「擴張 testing 段落」→ 右側即時顯示 v2 並高亮變動 → ToC 更新；版本 dropdown 切回 v1；diff 視圖標示段落 added/removed/changed；新版繼承原 `folderId`
6. **chat 邊看 artifacts（chat-centric）**：docs mode 下右 rail 開啟，問會引用 `[A1]` 的問題；點 `[A1]` 跳對應節點並亮起；點 BookOpenIcon 進 Reader
7. **Sandbox Explorer**：切到 sandbox mode → layout 變三欄；點 file tree 中某檔 → preview 顯示 → chat 顯示 selected file chip → 問「summarize this」→ 回覆引用該檔
8. **變更感知**：chat 觸發重新分析；Reader 與 chat 都出現 inline event card「Updated System Design · v2 · Folder: OAuth feature」可進 Reader 看 diff
9. **Status 整併**：刪 ImportStatusBanner 後第一次匯入仍由 WorkspaceSetupBanner 驅動；後續 sync 失敗只在 StatusPill + StatusPanel + chat event 顯示
10. **Mode 切換可見**：discuss → docs → sandbox 切換，layout 立即從 chat-centric 切到 Sandbox Explorer；top bar mode chip 同步
11. **行動裝置**：
    - Reader：artifact 全螢幕，底部三按鈕 dock 展開 Folders/Ask/ToC sheet，送訊後自動收合
    - Sandbox Explorer：三 tab Tree/Preview/Chat
12. **路由穩定性**：直接 `/w/:wid/a/:aid` URL 進入能解析、render；artifact 不存在 → NotFoundRoute；workspace 不匹配 → 既有 redirect 邏輯
13. **遷移既有資料**：升 schema 後既有 artifacts 出現在「Uncategorized」節點下，可正常閱讀，可手動移入新建資料夾

自動化：
- `bun run lint`、`bun run typecheck`、`bun run format` 通過
- `bun run test`：新增 ArtifactReader、FolderNavigator、FolderPicker、ChatArtifactEvent、ArtifactDiff、SandboxExplorer、FileTree、FilePreview component test；Convex 端測試 artifactFolders CRUD、`moveToFolder`、`previousVersionId` 與 `version` 自增、`messages.eventKind` 寫入路徑、`repoFiles.listByParent` 分頁；既有 `[A#]` 跳轉與 chat-context 測試需更新

---

## 範圍與分階段建議

整體規劃為 4–6 週工作量，建議按下列順序交付：

- **Phase A — Folder 基礎建設 + Reader 核心（~2 週）**
  - schema widen：`artifactFolders` 表 + `artifacts.folderId`
  - `convex/artifactFolders.ts` CRUD + `moveToFolder`
  - `<FolderNavigator />`、`<FolderPicker />`、`<FolderOverview />`
  - 取代現有 `ArtifactPanel` 平面 section 為樹狀
  - `/w/:wid/a/:aid` 路由 + Reader 主元件（左 tabs Folders/Chat + 右 artifact）
  - Reader 麵包屑 + sibling nav
  - 拿掉 `artifact-markdown.tsx:61` 的 `max-h-72`
  - 卡片 preview + Read more + BookOpenIcon
  - 生成 dialog 接上 FolderPicker

- **Phase B — 變更感知 + 版本歷史（~1.5 週）**
  - schema widen：`messages.eventKind/eventPayload`、`artifacts.previousVersionId`
  - 改造所有 artifact 寫入點走新版本邏輯，新版繼承 `folderId`
  - Inline chat artifact events 取代 toast
  - Reader 版本切換 dropdown + Diff 視圖

- **Phase C — Sandbox Explorer（~1 週）**
  - `convex/repoFiles.ts` query + sandbox preview 連接
  - 三欄 layout（桌機）+ 三 tab（行動）
  - chat selected-file context 串接

- **Phase D — Status 整併 + Mode 可見性（~3–4 天）**
  - 刪 ImportStatusBanner、WorkspaceReadyBanner、RepoStatusIndicator
  - StatusPill 整合 reasonCode；StatusPanel activity 區承擔 sync 失敗
  - Top bar workspace breadcrumb + Mode chip

每個 phase 結束都通過 `lint + typecheck + test` 並做端到端人工驗收後才進下一階段。Phase A 最大塊，因為資料夾抽象一旦動就要動 panel、Reader、生成流程三條線；後續 phase 才能站在這個基礎上展開。
