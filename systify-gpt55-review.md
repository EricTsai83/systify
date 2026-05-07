# Systify 架構審查改善計畫

## 優先方向
- 先集中長任務狀態機：在 [convex/chat/streaming.ts](convex/chat/streaming.ts)、[convex/analysis.ts](convex/analysis.ts)、[convex/designArtifacts.ts](convex/designArtifacts.ts)、[convex/ops.ts](convex/ops.ts) 統一 queued/running/terminal transition，避免 late action 把 cancelled/failed job 改回 running/completed。
- 再收斂 Repository 存取規則：把 owner + `deletionRequestedAt` 檢查抽成共用 active-repository helper，套到 [convex/repositories.ts](convex/repositories.ts)、[convex/chat/send.ts](convex/chat/send.ts)、[convex/analysis.ts](convex/analysis.ts)、[convex/architectureDiagram.ts](convex/architectureDiagram.ts)、[convex/designArtifacts.ts](convex/designArtifacts.ts)。
- 接著修 Sandbox/Import 生命周期：調整 [convex/importsNode.ts](convex/importsNode.ts) 與 [convex/imports.ts](convex/imports.ts)，讓 sync 成功前不要破壞前一個可用 sandbox，並讓 cleanup failed sandbox 可重試。
- 最後處理前端 hot path：把 streaming 訂閱從 [src/components/repository-shell.tsx](src/components/repository-shell.tsx) 下移到 chat 區域，並降低 [src/components/chat-panel.tsx](src/components/chat-panel.tsx)、[src/components/chat-message.tsx](src/components/chat-message.tsx)、[src/components/artifact-panel.tsx](src/components/artifact-panel.tsx) 的重渲染成本。

## 架構判斷
目前專案不是亂，而是功能快速長大後，幾個核心 Module 的 Interface 變淺了：Repository、Job、Sandbox、Chat Thread 的 invariants 分散在許多 public/internal functions 裡。這讓每個 caller 都要知道「是否刪除中」、「sandbox 是否 ready」、「job lease 是否有效」、「terminal 狀態能不能再 patch」等細節，降低本地性，也讓測試必須追很多跨檔案 race。

## 建議階段
1. 建立 `JobLifecycle` 這類深一點的 Module，讓所有 job transition 經過同一個 Interface，加入 lease owner/run token 與 conditional terminal patch。
2. 建立 `RepositoryAccess` helper，統一 active repo 驗證與 tombstone 行為，並補 public mutation/query 測試。
3. 將 import sandbox 改為 import-scoped 成功切換：新 sandbox ready + import finalized 後才更新 `repositories.latestSandboxId`，舊 sandbox 之後非同步清理。
4. 調整 Convex index 與讀取策略：針對 stale interactive jobs、failure-mode jobs、active repository list、docs artifacts context 建立更精準的查詢或輕量 metadata/digest。
5. 切分前端 container：Workspace shell 只管 workspace/navigation，Chat container 管 messages/streaming，Artifact rail 只在 visible 時掛載重內容。

## 驗證策略
- 每個 lifecycle/refactor 都補 race 測試：cancel vs action start、stale recovery vs late complete、repo delete vs send/analyze、sync failure vs previous sandbox availability。
- Convex 變更跑 `bun run test`、`bun run lint`、`bun run typecheck`；前端 hot path 變更補 React 渲染/互動測試。
- 若要做 index/schema 調整，先用 migration/helper 規劃 widen-migrate-narrow，避免部署期間讀不到新欄位。
