# SysTify Chat Modes — Multi-Plan Implementation

## Context

SysTify 的 chat 對使用者開放三種模式：`discuss`（自由聊）、`docs`（文件問答）、`sandbox`（live code）。經查證：

- ✅ `discuss` 與 `docs` 的後端行為符合設計
- ❌ `sandbox` **沒有真正接 Daytona**——`convex/chat/generation.ts:61-65` 的 `streamText` 沒帶 `tools`，整個 `convex/chat/` 目錄 grep 不到 Daytona 呼叫；`convex/chat/context.ts:170-194` 在 sandbox 模式只多塞 RAG chunks
- 三種模式的差異對使用者也不直觀，且生產級必備的 cost cap、redaction、cancel、ticker、metrics 全部未實作

這份文件把整體規劃**拆成 14 個小 plan**，每個都是：

- 工作量 0.5–3 天
- 完工即可 ship（不留半成品阻擋下個 plan）
- 對既有功能向後相容

---

## Mode Summary（一覽表，作為持續參考）


| 維度               | `discuss` | `docs`           | `sandbox`                                |
| ---------------- | --------- | ---------------- | ---------------------------------------- |
| 需要 attached repo | ❌         | ✅                | ✅ + sandbox `ready`                      |
| Repo metadata    | ❌         | ✅                | ✅                                        |
| Artifacts        | ❌         | ✅ 9 種 kind 各 ≤12 | ✅ 只放 deep_analysis                       |
| Indexed chunks   | ❌         | ❌                | ❌（v2 改為 LLM 用工具自取）                       |
| LLM 工具           | ❌         | ❌                | ✅ `read_file` / `list_dir` / `run_shell` |
| Cost category    | `chat`    | `chat`           | `deep_analysis`                          |
| 預期延遲             | 秒級        | 秒級               | 10–60 秒                                  |


---

## Plan Index


| #   | 名稱                                            | 工作量  | 依賴     | Sandbox flag 狀態           |
| --- | --------------------------------------------- | ---- | ------ | ------------------------- |
| 01  | Mode 命名 + Per-Mode System Prompt              | 0.5d | —      | off                       |
| 02  | Docs `[A1]` 引用 + UI Mode Badge                | 1d   | 01     | off                       |
| 03  | 跨模式對話歷史過濾                                     | 0.5d | —      | off                       |
| 04  | Sandbox 工具骨架（read_file + list_dir）            | 3d   | 01     | **flag 引入**，預設 off，僅白名單   |
| 05  | 安全護欄（Clone-Time Token Scrub + Output Redaction） | 1d   | 04     | 內部白名單仍 on                 |
| 06  | Live Tool-Call Ticker                         | 2d   | 04     | 同                         |
| 07  | Cancel In-Flight Reply                        | 1.5d | 04     | 同                         |
| 08  | `run_shell` 工具                                | 1.5d | 05     | 同                         |
| 09  | Daytona 失效降級到 docs                            | 1.5d | 04, 08 | 同                         |
| 10  | 成本可見性 + Daily Cap                             | 2d   | 04     | 同                         |
| 11  | 答案品質（Step Budget + Citation + Per-Mode Model） | 1.5d | 04     | 同                         |
| 12  | Audit Log + 90 天 Retention                    | 1d   | 08     | 同                         |
| 13  | Feature Flag Rollout + Metrics + Runbook      | 1.5d | 11     | **開始灰度**：10% → 50% → 100% |
| 14  | Mode Onboarding + Auto-Suggest                | 1.5d | 13     | 100%（公開）                  |


**總工作量**：~20 天，可接段切換、不必連續做

**Rollout 里程碑**：

- 完成 01-03 → discuss / docs 體驗立即提升（不影響 sandbox）
- 完成 04-12 → sandbox 在內部白名單可用
- 完成 13 → sandbox 進入灰度
- 完成 14 → sandbox 對全體使用者公開

---

## Cross-Plan Conventions

每個 plan 共用以下慣例：

1. **測試**：用 vitest + convex-test 跑單元/整合測試（`bun test`）；新增的 Daytona 行為沿用 `convex/daytona.test.ts` 的 `vi.hoisted` + `vi.mock("@daytona/sdk", ...)` 模式
2. **Schema migration**：本 plan 中的 schema 變更全為**新增 optional 欄位 / 新表**，向後相容，無需 backfill；參考 `convex-migration-helper` skill 的 widen-migrate-narrow 流程
3. **Feature flag**：Plan 04 引入 `SANDBOX_MODE_ENABLED` env var，後續 plan 都應在 flag off 時保持原行為
4. **DB literal 不改**：`mode: "sandbox" | "docs" | "discuss"` 的型別字串永遠保留（避免動到既有 messages.mode 資料）；只改 UI 顯示文字
5. **依賴新增**：整個 plan 系列只新增一個 npm 依賴 `zod`（Plan 04），其它都用 repo 既有設施

---

# Plan 01 — Mode 命名 + Per-Mode System Prompt

## 目標

把三模式 UI 標籤改成更直觀的名字，並讓 LLM 收到的 system prompt 隨模式不同而不同（避免 discuss 模式胡謅「你的 repo」）。

## Done 標準（產品狀態）

- UI 三個模式分別顯示：**General Chat** / **Design Docs** / **Sandbox**（DB 內部值不變；`Sandbox` label 沿用工程團隊共同用語）
- discuss 模式 LLM 不會出現「你的 repo」「your codebase」之類臆測語
- docs 模式 LLM 明確被指示「以 artifact 為唯一依據」
- sandbox 模式 LLM 明確被告知「下個 plan 會給你工具」（佔位 prompt，先不開工具）
- `bun test` 全綠

## 改動檔案


| 檔案                              | 變更                                                                            |
| ------------------------------- | ----------------------------------------------------------------------------- |
| `src/components/chat-panel.tsx` | `MODE_CATALOG` 的 `label` 與 `caption` 文案更新（lines 49-73）                        |
| `convex/chat/prompting.ts`      | `buildSystemPrompt()` 改為 `buildSystemPrompt(mode: ChatMode)`，三段 system prompt |
| `convex/chat/generation.ts`     | call site 傳入 mode（line 63）                                                    |
| `convex/chatModeResolver.ts`    | `disabledReasons` 文案沿用新名字（lines 40-46）                                        |
| `convex/chat.test.ts`           | 斷言 prompt 有 mode-specific 內容                                                  |


## 工作項目

1. 在 `convex/chat/prompting.ts` 加 `buildSystemPrompt(mode)`，以 switch 分三段（discuss / docs / sandbox 各自的 prompt 字串保留在常數）
2. `generation.ts` 改 call site 從 queued user message（即 `userMessageId` anchor，而非「視窗中最新的 user message」）推得 `effectiveMode`，避免 send 與 generation 之間插隊的 user message 搶走 mode
3. UI label 更新；保留現有 icons（`ChatCircleIcon` / `FileTextIcon` / `CubeIcon`）
4. 既有測試 `convex/chatModeResolver.test.ts:1-156` 全部要綠（測 disabledReasons 文案的部分要更新）
5. 新增 `convex/chat-prompting.test.ts`：assert `buildSystemPrompt("discuss")` 不含 "repository"、`buildSystemPrompt("docs")` 含 "artifact"

## Verification

- 跑 `bun test convex/chat-prompting.test.ts convex/chatModeResolver.test.ts convex/chat.test.ts`
- 手動：開三種模式各問同一句話，看 LLM 行為差異

## 依賴

無

---

# Plan 02 — Docs `[A1]` 引用 + UI Mode Badge

## 目標

讓 docs 模式的回答**可信**：每篇 artifact 給編號，LLM 必須用 `[A1]` 引用，前端把 `[A1]` 變成可點擊連結。同時為所有 assistant message 加上模式 badge，讓使用者一眼看出來源。

## Done 標準（產品狀態）

- Docs 模式回應時，每個事實宣稱後出現 `[A1]`、`[A2]` 引用標記
- 點擊 `[A1]` 跳到對應 artifact 詳情（既有 artifact panel 路由）
- 所有 assistant message 顯示一個小 chip：「General」/「Design Docs」/「Sandbox」

## 改動檔案


| 檔案                                   | 變更                                                                         |
| ------------------------------------ | -------------------------------------------------------------------------- |
| `convex/chat/prompting.ts`           | `buildUserPrompt` artifact section 每篇前綴 `[A1]`：標題；docs system prompt 加引用合約 |
| `src/components/chat-panel.tsx`      | `MessageBubble` 加 mode chip；render `[A1]` 為連結（regex match + JSX 替換）        |
| `src/components/chat-panel.test.tsx` | 新增 mode badge 與 [A1] 連結 render 測試                                          |
| `convex/chat-context.test.ts` 或新檔    | 斷言 docs prompt 包含 `[A1]` 標記                                                |


## 工作項目

1. `buildUserPrompt` 的 artifact section 改用 `${context.artifacts.map((a, i) => \`## [A${i+1}] ${a.title}n${a.summary}...)}`；維持` MAX_CONTEXT_ARTIFACTS = 6` 限制
2. docs system prompt 加：「Cite every claim using `[A#]` referring to the numbered artifacts. If artifacts are silent on the question, say so explicitly.」
3. 前端：抓 `\[A(\d+)\]` regex，render 為 `<button onClick=jumpToArtifact(idx)>[A1]</button>`
4. 把 artifactId list 從 reply context 透出到 message metadata（這樣前端才知道 [A1] 對應哪個 artifactId）——加在 `messages.toolCalls` 之外的新欄位 `messages.citationMap?: Array<{ index: number; artifactId: Id<"artifacts"> }>`
5. Mode chip：`<Badge variant="secondary">General Chat</Badge>` 等，根據 message.mode 顯示

## Verification

- `bun test convex/chat-context.test.ts src/components/chat-panel.test.tsx`
- 手動：docs 模式問題，按連結要跳到正確 artifact

## 依賴

- Plan 01（system prompt 已是 mode-aware 的 `buildSystemPrompt(mode)`）

---

# Plan 03 — 跨模式對話歷史過濾

## 目標

使用者切換模式時，前一個模式的 assistant 回答不應污染新模式的 context。

## Done 標準（產品狀態）

- 在 sandbox 模式問問題，LLM 看不到先前 discuss 模式的 hypothetical 回答
- 使用者問題（user role）跨模式仍保留（連續對話需要）
- 既有 `MAX_CONTEXT_MESSAGES = 20` 視窗不變，只是 assistant 訊息會被 mode 過濾

## 改動檔案


| 檔案                            | 變更                                                                    |
| ----------------------------- | --------------------------------------------------------------------- |
| `convex/chat/context.ts`      | `loadRecentMessages` 增加 `effectiveMode` 參數，過濾不同 mode 的 assistant role |
| `convex/chat-context.test.ts` | 新增測試 case                                                             |


## 工作項目

1. 在 `loadRecentMessages` 之後（`convex/chat/context.ts:67-75`）加一個 filter：`if (m.role === "assistant" && m.mode !== effectiveMode) return false`
2. 從 `getReplyContext` 把 effectiveMode 傳進去（line 137 已算過 effectiveMode）
3. 測試：seed 一個 thread，前 3 訊息 mode=discuss，後 3 訊息 mode=sandbox，呼叫 getReplyContext mode=sandbox，斷言 assistant 訊息只剩 sandbox 那 3 個

## Verification

- `bun test convex/chat-context.test.ts`

## 依賴

無（與 Plan 01/02 平行）

---

# Plan 04 — Sandbox 工具骨架（read_file + list_dir，feature flag 後）

## 目標

讓 sandbox 模式**真正運作**：LLM 收到工具能自主讀檔/列目錄。引入 `SANDBOX_MODE_ENABLED` feature flag 包住，預設 off，僅白名單使用者可用。**不含 shell（Plan 08 才加）**。

## Done 標準（產品狀態）

- `SANDBOX_MODE_ENABLED=false`：sandbox 模式選擇器顯示為 disabled，tooltip「Sandbox mode is in private beta」
- `SANDBOX_MODE_ENABLED=true` + 白名單使用者：sandbox 模式可用，問「`convex/chat/send.ts:80` 那段 lease 邏輯」會看到 LLM 至少呼叫一次 `read_file: convex/chat/send.ts`，回答引用真實 line 範圍
- 沒 `OPENAI_API_KEY` 時 sandbox 模式回明確降級訊息（不假裝跑工具）
- sandbox 模式不再預載 RAG chunks（artifacts 仍保留 deep_analysis kind）
- `bun test convex/chat/sandboxTools.test.ts` 綠

## 改動檔案


| 檔案                                 | 變更                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `package.json`                     | 新增 `zod` 依賴                                                                                             |
| `env.ts`                           | 新增 `SANDBOX_MODE_ENABLED` 與 `SANDBOX_BETA_ALLOWLIST`（comma-separated tokenIdentifier）env vars           |
| `convex/chat/sandboxTools.ts`      | **新檔**：`read_file` + `list_dir` 兩個 tool，含路徑越界檢查、64KB truncation                                         |
| `convex/chat/sandboxTools.test.ts` | **新檔**：tool 邊界測試                                                                                        |
| `convex/chat/generation.ts`        | 取得 sandbox handle、構造 tools、改用 `streamText({ tools, stopWhen: stepCountIs(8) })` 與 `response.fullStream` |
| `convex/chat/context.ts`           | sandbox 分支移除 `loadCandidateChunks`（lines 170-194）；artifacts 只取 deep_analysis kind                       |
| `convex/chat/prompting.ts`         | sandbox system prompt 加「使用工具驗證」段；`buildHeuristicAnswer` 加 sandbox 分支                                    |
| `convex/chatModeResolver.ts`       | flag off 時 sandbox 永遠不在 availableModes                                                                  |


## 工作項目

1. `bun add zod`
2. 新建 `sandboxTools.ts`：用 AI SDK `tool({ description, inputSchema: z.object(...), execute })`；execute 內呼叫既有 `convex/daytona.ts` 的 `sandbox.fs.downloadFile` / `listFiles`；錯誤回 `{ error: "..."}` 而非 throw
3. 路徑驗證：`if (!normalize(path).startsWith(repoPath)) return { error: "path_outside_repo" }`
4. `generation.ts`：mode === sandbox 時取得 sandbox 物件、產 tools、傳給 streamText；改用 `for await (const part of response.fullStream)` 分流 `text-delta` 與 `tool-call`/`tool-result`
5. `context.ts` sandbox 分支簡化：artifacts 只取 deep_analysis；chunks 設 `[]`
6. `chatModeResolver.ts`：在 `resolveChatModes` 開頭檢查 `SANDBOX_MODE_ENABLED` 與 allowlist；若 off，把 sandbox 從 availableModes 移除、加入 disabledReasons
7. 測試：mock `@daytona/sdk` 回固定檔案內容，驗證 read_file 工具呼叫返回正確結構；驗證路徑越界 reject

## Verification

- `bun test convex/chat/sandboxTools.test.ts convex/chat-generation.test.ts`（後者新增）
- 手動：自己加進白名單，掛 ready sandbox，問檔案內容相關問題，看 message metadata 裡 `toolCalls` 確實有 read_file entries

## 依賴

- Plan 01（per-mode system prompt 基礎設施）

---

# Plan 05 — 安全護欄（Clone-Time Token Scrub + Output Redaction）

> 完整威脅模型與設計依據見 `docs/sandbox-mode-security-system-design.md`。本節是該設計的執行清單。

## 目標

在 sandbox 工具對更多人開放前，修掉**兩個會把 secret 寫進 `messages` 表**的洩露點：

1. **`cloneRepositoryInSandbox` 把 GitHub App installation token 嵌入 `.git/config`**（已驗證：`convex/daytona.ts:211-218` 走 HTTPS clone 帶 `x-access-token:<token>` 進 URL，無 post-clone scrub）。一旦 Plan 08 的 `run_shell` 開放，LLM 跑 `cat .git/config` 就能把 token 寫進回應、進而進 message DB。
2. **原始碼裡硬寫的 secret**（如 `const STRIPE_KEY = "sk_live_…"`）。路徑長得無辜，path-based blocklist 擋不到；唯一可行的是內容掃描。

> **設計上明確不做 path blocklist**（`.env` / `.aws/credentials` / `secrets/`）：在 SysTify 的 sandbox 模型下這些檔案要不在 repo（`.env`）、要不在 home 不在 repo 內（`.aws/credentials`），blocklist 提供的是錯誤的安心感。完整論述見 design doc。

## Done 標準（產品狀態）

- `cloneRepositoryInSandbox` 完成後，`.git/config` 的 remote URL 不再含 `x-access-token` 或 token 字串（grep 應為 0）
- 後續 `git fetch` / `git pull` 在 sandbox 內無憑證，預期失敗（read-only sandbox 期望行為）
- `read_file` / `list_dir` / `run_shell` 結果含 GitHub token / JWT / Bearer 時，被替換為 `[REDACTED:github_token]` 等標記，再進 LLM 與寫入 message
- redaction 是雙向：送進 LLM 前 redact，寫進 trace metadata（`messages.toolCalls`、`messageToolCallEvents`、`sandboxToolCallLog`）前也 redact
- redact 的回傳同時帶 `matchedTypes: string[]`，讓 LLM 知道有東西被遮（不揭露內容）

## 改動檔案


| 檔案                                 | 變更                                                                                                              |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `convex/daytona.ts`                | `cloneRepositoryInSandbox` 在 `sandbox.git.clone` 之後加 `git remote set-url origin <url-without-credentials>` |
| `convex/daytona.test.ts`           | 擴充：mock clone 後驗證有跑 `git remote set-url`、且最終 URL 不含 token                                                       |
| `convex/chat/redaction.ts`         | **新檔**：`redact(text: string): { redacted: string; matchedTypes: string[] }`                                     |
| `convex/chat/redaction.test.ts`    | **新檔**：給定含 GitHub token / JWT / Bearer 字串，redact 後 grep 不到原 token；matchedTypes 正確                              |
| `convex/chat/sandboxTools.ts`      | 每個 tool execute 的 return 路徑強制過 `redact()`；不另設 path blocklist                                                    |
| `convex/chat/sandboxTools.test.ts` | 擴充：含 secret 的 mock 檔案內容經 redact 後才回 LLM                                                                         |


## 工作項目

1. **Clone-time scrub**（`convex/daytona.ts`）：在 `cloneRepositoryInSandbox` 內，於現有的 `sandbox.git.clone(...)` 之後、現有 `git branch --show-current` 之前，插入：
   ```ts
   await sandbox.process.executeCommand(
     `git remote set-url origin ${shellQuote(args.url)}`,
     "repo",
   );
   ```
   注意：`args.url` 應為**不含憑證的 canonical HTTPS URL**（既有呼叫端 `importsNode.ts:201-206` 已是這個形式，token 是另一個參數）。需要對 url 做 shell-escape 以防特殊字元。
2. **此 scrub 在 `SANDBOX_MODE_ENABLED=false` 時也照跑**——這是 hardening 不是 feature，不該綁 flag。在 plan 文末「Cross-Plan Conventions」第 3 條的例外，需在程式碼註解標明。
3. **Redaction module**（`convex/chat/redaction.ts`）：核心 3 個 pattern（必加）：
   - GitHub token: `/gh[pousr]_[A-Za-z0-9]{36,}/`
   - JWT: `/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/`
   - Generic Bearer: `/Bearer\s+[A-Za-z0-9._-]{20,}/i`
   
   選配 2 個（可加可不加，不影響設計）：
   - AWS access key: `/AKIA[0-9A-Z]{16}/`
   - Slack token: `/xox[baprs]-[A-Za-z0-9-]+/`
4. **Tool integration**：`sandboxTools.ts` 每個 tool 的 execute 在 return 前都過 `redact()`；把 `matchedTypes` 也回給 LLM。**沒有** `BLOCKED_PATH_PATTERNS` 入口檢查。
5. **Trace 寫入路徑**：Plan 06 / Plan 12 寫入 message metadata 與 audit log 前要過 `redact()`——這 plan 先把 module 建好、tool 端先用，下游 plan 沿用同一個函式。

## Verification

- `bun test convex/daytona.test.ts convex/chat/redaction.test.ts convex/chat/sandboxTools.test.ts`
- 手動 1（clone scrub）：跑一次 import，SSH 進 sandbox 跑 `cat .git/config`，確認 URL 是 `https://github.com/owner/repo.git` 而非 `https://x-access-token:ghs_xxx@...`
- 手動 2（redaction）：sandbox 對話中要求 LLM `cat` 一個含假 GitHub token（`ghp_` + 36 chars）的測試檔，確認回應與 message DB 的 `toolCalls` 都顯示 `[REDACTED:github_token]`，原始 token 字串完全 grep 不到

## 依賴

- Plan 04（要有 sandbox tools 才能驗 redaction 流程）

---

# Plan 06 — Live Tool-Call Ticker

## 目標

Sandbox 跑工具期間 UI 顯示 live ticker（`Reading X.ts...`），取代靜態 spinner。同時把每個 tool call 持久化到 message metadata，作為 Plan 08 / Plan 14 的 trace UI 基礎。

## Done 標準（產品狀態）

- Sandbox 對話中，tool 執行時前端即時顯示如：
  ```text
  🔍 Reading convex/chat/send.ts (1.2 KB)…
  📂 Listing convex/lib/…
  ```
- 訊息結束後，這個 ticker 變成可摺疊的「Tool calls (3)」段落，列出工具名 + 輸入摘要 + 結果 status
- 重新整理頁面後 trace 還在（已持久化）
- mid-stream 中斷（cancel / sandbox 失效 / job 過 lease）時，partial trace（只有 `start` 沒 `end` 的工具）會 fold 為 `endedAt === startedAt` 的 entry，UI 標示為「interrupted」，事件表不留孤兒
- 同回覆中**多次呼叫同一工具**（例如連讀兩個檔）保持為兩筆獨立 entry，不被合併

## 改動檔案


| 檔案                                          | 變更                                                                                                                                                                |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `convex/schema.ts`                          | `messages` 加 optional `toolCalls`；新表 `messageToolCallEvents`，索引 `by_messageId_and_sequence`                                                                       |
| `convex/lib/constants.ts`                   | 新增 `MAX_TOOL_CALL_EVENTS_PER_MESSAGE = 64`、`TOOL_CALL_EVENT_SUMMARY_MAX_CHARS = 600`                                                                              |
| `convex/chat/toolCallEventStore.ts`         | **新檔**：純 helpers — `loadAllToolCallEventsByMessage`、`drainMessageToolCallEvents`、`nextToolCallEventSequence`、`foldToolCallEvents`                                |
| `convex/chat/streaming.ts`                  | 新 mutation `appendAssistantToolCallEvent`、新 query `getMessageToolCallEvents`；`finalize` / `fail` / `recoverStaleChatJob` 共用 `foldAndDrainToolCallEvents` helper |
| `convex/chat/generation.ts`                 | `fullStream` 攔截 `tool-call` / `tool-result` / `tool-error` 即刻寫入 events，`inputSummary` / `outputSummary` 走 Plan 05 的 `redact()`                                  |
| `convex/chat/threads.ts` + `repositories.ts` | thread / repository cascade-delete 與 `cleanupOrphanedMessages` 都呼叫 `drainMessageToolCallEvents`                                                                  |
| `src/components/tool-call-trace.tsx`        | **新檔**：`<ToolCallTrace>` 元件（live + persisted 共用一個 renderer），歷史訊息透過 `"skip"` sentinel 防止每個 bubble 都開訂閱                                                            |
| `src/components/chat-panel.tsx`             | `MessageBubble` 在 assistant message 下渲染 `<ToolCallTrace>`                                                                                                        |
| `convex/chat-streaming.test.ts`             | 擴充：fold/drain、multi-call same toolName、partial trace、stale recovery、cap truncation、cross-tenant fence、cascade drain（共 7 個 case）                                |
| `src/components/tool-call-trace.test.tsx`   | **新檔**：streaming + finalized 兩種 state 渲染、ticker label（含 `run_shell` JSON 抽 command）、collapsible 行為                                                              |


## 工作項目

1. **Schema**：`messages.toolCalls?: Array<{ toolCallId, toolName, inputSummary, outputSummary, startedAt, endedAt, errorCode? }>`；events 表 `{ messageId, toolCallId, sequence, type: "start" | "end", toolName, inputSummary, outputSummary?, errorCode?, occurredAt }`。`occurredAt` 來自 action 端的 `Date.now()`（不是 `_creationTime`），這樣 `endedAt - startedAt` 反映真正的工具延遲，而非 mutation dispatch 抖動
2. **以 `toolCallId` 配對**（不是 `toolName`）：`toolCallId` 是 AI SDK 在 `fullStream` 上對應 `tool-call` ↔ `tool-result` / `tool-error` 的唯一 key。用 `toolName` 配對會把同一回覆中兩個 `read_file` 合併成一筆，破壞 trace 完整性
3. **Streaming**：執行工具前 append `{type: "start"}`；result 或 error 到時 append `{type: "end"}`。finalize / fail / `recoverStaleChatJob` **三條路徑都共用 `foldAndDrainToolCallEvents` helper**（讀 events → fold by `toolCallId` → 寫 `messages.toolCalls` → drain events，全部在同一 transaction 內），確保前端絕不會看到「事件還在但 message 已 completed」的中介狀態
4. **使用 Plan 05 的 `redact()`** 對 `inputSummary` / `outputSummary` 過濾後再寫入 events 表
5. **Caps + 觀測信號**：events 讀取上限 `MAX_TOOL_CALL_EVENTS_PER_MESSAGE = 64`（防止 buggy AI SDK 重複事件造成 fold 爆量）、每欄字元上限 `TOOL_CALL_EVENT_SUMMARY_MAX_CHARS = 600`（防止 message doc 衝破 Convex 1MB row limit），命中即附 `…[truncated]` marker；finalize / fail / recover 在讀到 cap 時 `logWarn("chat", "tool_event_fold_truncated", { foldedEventCount, drainedEventCount, cap, … })`，使 truncation 可觀測。drain step 用 while-loop 確保即使讀超 cap 仍排乾，避免孤兒事件殘留
6. **Lease refresh half-window heuristic**：`appendAssistantToolCallEvent` 與 `appendAssistantStreamChunk` 共用「上次 append 過半 lease 窗才 patch lease」的判斷，避免 cold-sandbox 慢工具步驟（例如 15s 的 archived sandbox 讀檔）被 `recoverStaleChatJob` 誤判 stale。沒有這個 refresh，工具呼叫期間若 model 沒發 text delta，lease 會悄悄過期
7. **Cascade-delete 整合**：`drainMessageToolCallEvents` 在 thread cascade-delete、repository cascade-delete、`cleanupOrphanedMessages` 三條路徑都被呼叫，順序是「先 drain 子表事件、後刪父 message」，確保 partial-failed cascade 不留下指向不存在 `messageId` 的事件
8. **UI**：`<ToolCallTrace>` 一個元件吃 streaming 與 finalized 兩種 state — streaming 時 subscribe live events 並從 `state === "running"` 找出 ticker 主角；終態時讀 `messages.toolCalls`。歷史訊息透過 `useQuery(..., "skip")` sentinel 避免每個 assistant bubble 都開訂閱（一條 thread 100 則訊息只有 in-flight 的那則訂閱）。`run_shell` 的 ticker 從 redacted JSON 抽 `command` 欄位顯示，避免 `Running {"command":"…"}` 的醜畫面

## Verification

- `bun test convex/chat-streaming.test.ts`（含 fold/drain、multi-call、partial、stale、cap、fence、cascade 共 7 個 case）
- `bun test src/components/tool-call-trace.test.tsx`（含 production-shape JSON、長指令截斷、raw-string fallback）
- 手動：sandbox 對話，肉眼確認 ticker 即時更新；F5 重整後 trace 仍存在；mid-stream cancel 後 partial trace 顯示為「interrupted」

## 依賴

- Plan 04（要有工具才有 events）
- Plan 05（redaction 必須先就位，避免 trace 寫入未遮罩內容）

---

# Plan 07 — Cancel In-Flight Reply

## 目標

使用者可主動中斷正在跑的 sandbox 對話。

## Done 標準（產品狀態）

- 訊息 streaming 期間，Send 按鈕變成 Stop 按鈕
- 按 Stop 後 5 秒內：assistant message status 改 `cancelled`，UI 顯示「Cancelled by user」與目前已收集到的部分回答
- 同時間 Daytona 上的 shell 若還沒結束會繼續跑完（Daytona SDK 不支援 mid-flight kill）；UI 在這段顯示「Stopping…」

## 改動檔案


| 檔案                              | 變更                                                                       |
| ------------------------------- | ------------------------------------------------------------------------ |
| `convex/chat/cancel.ts`         | **新檔**：`cancelInFlightReply(threadId)` mutation                          |
| `convex/chat/generation.ts`     | stream loop 每 N 步檢查 job.status === "cancelled"，是則 break out of tool loop |
| `convex/chat/streaming.ts`      | 新增 `markAssistantReplyCancelled`（finalize 變體）                            |
| `src/components/chat-panel.tsx` | Send 按鈕在 streaming 期間切換為 Stop                                            |
| `convex/chat-cancel.test.ts`    | **新檔**：cancel mid-stream 後 message status 與 job status 正確                |


## 工作項目

1. `cancel.ts`：mutation 把 job.status 設 `"cancelled"`、message.status 設 `"cancelled"`（無 lease 檢查，因為 owner 自己主動）
2. `generation.ts`：tool loop 開頭與每次 tool call 後 `await ctx.runQuery(getJobStatus)` 檢查 cancelled；hit 則用 `markAssistantReplyCancelled` 收尾、跳出 try block
3. UI：useMutation cancel；button label 跟 streaming 狀態（`message.status === "streaming"`）綁定
4. Daytona shell 不能殺：在 stop 期間 UI 顯示「Stopping… (waiting for current operation)」

## Verification

- `bun test convex/chat-cancel.test.ts`
- 手動：跑一場 sandbox，3 秒後按 Stop，看是否在 ~5 秒內結束

## 依賴

- Plan 04

---

# Plan 08 — `run_shell` 工具

## 目標

給 LLM 完整 sandbox 能力：grep / find / git log / tree 都能組合。在 redaction（Plan 05）就位後加。

## Done 標準（產品狀態）

- LLM 可呼叫 `run_shell({ command, workdir?, timeout_seconds? })`，stdout 上限 32KB（超過截斷）
- 預設 timeout 30 秒、最大 60 秒
- 明顯破壞性指令在工具層擋下：`rm -rf /`、`:(){ :|:& };:`、`mkfs`、`dd if=` 等
- stdout 走 Plan 05 的 redaction
- LLM 不會試圖跑外網（透過 system prompt 強調 + workdir 鎖在 repoPath 內）

## 改動檔案


| 檔案                                   | 變更                                                            |
| ------------------------------------ | ------------------------------------------------------------- |
| `convex/chat/sandboxTools.ts`        | 新增 `run_shell` tool，含 deny list 與 truncation                  |
| `convex/chat/sandboxTools.test.ts`   | 擴充：deny list、timeout、truncation                               |
| `convex/chat/prompting.ts`           | sandbox system prompt 加 `run_shell` 說明、強調 read-only 任務優先      |
| `docs/sandbox-mode-system-design.md` | **新檔**：紀錄 Daytona 預設 isolation（network egress、process limits） |


## 工作項目

1. `run_shell` execute：包 `sandbox.process.executeCommand(cmd, workdir, env, timeout)`；workdir 預設 `repoPath`，傳入 workdir 必須在 repoPath 子樹
2. `COMMAND_DENY_LIST`：用簡單 regex（不做完整 parse）擋明顯模式
3. stdout / stderr 各截 16KB（合計 32KB），超過附 `[truncated]` 標記
4. 結果走 `redact()`
5. system prompt 加：「Use `run_shell` for read-only inspection commands like `grep`, `find`, `git log`. Avoid commands that modify state.」
6. design doc 文件化 Daytona 預設網路與資源限制（先實測再寫）

## Verification

- `bun test convex/chat/sandboxTools.test.ts`
- 手動：問「列出 convex/chat/ 所有 .ts 並顯示行數」，看 LLM 用 `find ... | xargs wc -l`

## 依賴

- Plan 05（redaction 必先）

---

# Plan 09 — Daytona 失效降級到 docs

## 目標

Daytona 整體掛掉、quota 用完、sandbox 突然 archived 時，sandbox 模式優雅降級到 docs 模式答題，而不是直接 throw。

## Done 標準（產品狀態）

- 第一個 tool call 失敗 → 工具層自動 retry 一次
- 連續第二次失敗 → 標記 sandbox 此 session degraded，後續 prompt 改為「以已收集到的工具結果 + artifacts 回答」+ UI 顯示「Sandbox degraded mid-session」橫幅
- 還沒成功跑過任何 tool 就連續失敗 → 直接降級到 docs 模式（套 docs system prompt + artifacts），UI 顯示「Sandbox unavailable, answered from docs」標籤
- 所有降級事件都記到 metrics（Plan 13）的 `sandbox_session.fallback_to_docs_total`

## 改動檔案


| 檔案                              | 變更                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------ |
| `convex/chat/sandboxTools.ts`   | tool execute 包 retry + circuit breaker；`SANDBOX_TOOL_FAIL_THRESHOLD` 環境變數            |
| `convex/chat/generation.ts`     | 接到 circuit-open signal 時：1) 若已有結果 → 改 prompt 繼續；2) 若無結果 → 切到 docs path 重新 streamText |
| `convex/chat/prompting.ts`      | 加 `buildSandboxFallbackPrompt(replyContext, partialToolResults)`                     |
| `src/components/chat-panel.tsx` | 顯示降級 banner：用既有 `<AppNotice>` 元件                                                     |


## 工作項目

1. retry 策略：transient error（network、5xx、timeout）retry 一次、間隔 1 秒；non-transient（400、auth）直接 fail
2. Circuit breaker：同一 session 連續 N 次失敗（N=2）即視為 broken
3. `generation.ts`：`let degraded = false; let toolResults: any[] = [];` 累積；degraded 後在下個 prompt 補 system note 並把 tools 移除（直接退出 tool loop）
4. UI banner：mode mismatch（傳入 sandbox、回應實際是 docs）時 render banner

## Verification

- `bun test convex/chat-generation.test.ts`（mock Daytona 第一次回 500、第二次回 500，斷言走 docs 降級）
- 手動：暫時把 `DAYTONA_API_URL` env 改錯，發問，看 UI 出現降級 banner

## 依賴

- Plan 04（要有 sandbox flow）
- Plan 08（要有完整工具集才能完整測 fallback）

---

# Plan 10 — 成本可見性 + Daily Cap

## 目標

給使用者即時看得到 sandbox 對話花多少錢，並設 per-user / per-workspace 每日上限以防 bill 爆炸。

## Done 標準（產品狀態）

- 每則 sandbox 訊息底下顯示 `~$0.03 (1.2k tokens, 5 tool calls)`
- 使用者當日 sandbox 消費達 `$5` → mode selector 把 Sandbox 顯示為 disabled，tooltip「Daily quota reached, resets at midnight UTC」
- Workspace 級當日 `$50` → 整個 workspace 的 sandbox 都 disabled
- 上限可從 env 調整：`SANDBOX_DAILY_CAP_PER_USER_USD`、`SANDBOX_DAILY_CAP_PER_WORKSPACE_USD`

## 改動檔案


| 檔案                                     | 變更                                                                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `convex/lib/openaiPricing.ts`          | 擴充以涵蓋 sandbox 模式可能用的所有模型                                                                                        |
| `convex/lib/rateLimit.ts`              | 新增 `sandboxCostUsdPerUserDaily`、`sandboxCostUsdPerWorkspaceDaily` 兩個桶（用既有 `rateLimit` component 的 token bucket） |
| `convex/chat/send.ts`                  | sendMessage 前先 check 兩個桶；超過 throw structured error                                                              |
| `convex/chat/streaming.ts`             | finalize 時把實際 cost 加進桶                                                                                          |
| `convex/chatModeResolver.ts`           | 把當日剩餘額度信號（從 hook 拿）作為 disable reason 之一                                                                         |
| `src/hooks/use-thread-capabilities.ts` | 透出 `dailyCapRemainingUsd`                                                                                       |
| `src/components/chat-panel.tsx`        | 訊息底下加 cost ticker、selector tooltip 顯示 quota                                                                     |
| `convex/rateLimit.test.ts`             | 擴充測試                                                                                                            |


## 工作項目

1. `rateLimit.ts`：token bucket capacity = `dailyCapUsd * 100`（用 cents 為粒度），rate = capacity / 24h
2. send.ts pre-check：peek 桶剩餘額度 ≥ 預估成本（用 user prompt token 數 × 平均 sandbox session 倍數估算，先用固定 $0.10 假設）
3. finalize 把 `costUsd * 100` 從桶扣除
4. UI：cost ticker 從 message 的 `inputTokens`/`outputTokens`（已有）+ `costUsd` 算出（見 generation.ts:79-94）

## Verification

- `bun test convex/rateLimit.test.ts`
- 手動：把 cap 調到 $0.05，連續發 3 個 sandbox 訊息，第 2 或 3 個應被擋、UI 顯示 quota tooltip

## 依賴

- Plan 04

---

# Plan 11 — 答案品質（Step Budget + Citation Lint + Per-Mode Model）

## 目標

三個都是小調整，組合起來大幅提升 sandbox 答案品質：LLM 知道自己剩幾步、被強制引用 file:line、不同模式用不同強度模型。

## Done 標準（產品狀態）

- Sandbox 用 `OPENAI_MODEL_SANDBOX`（default `gpt-5`），discuss/docs 用 `OPENAI_MODEL_DISCUSS` / `OPENAI_MODEL_DOCS`（default `gpt-5-mini`）
- LLM 每輪 tool call 後在 system 看到「You have N tool calls remaining」
- 沒引用 `[path:line-N]` 的事實宣稱在前端被加底色標記（不阻擋輸出）

## 改動檔案


| 檔案                              | 變更                                                                                                                                                                     |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `env.ts`                        | `OPENAI_MODEL_DISCUSS`、`OPENAI_MODEL_DOCS`、`OPENAI_MODEL_SANDBOX` env vars                                                                                             |
| `convex/chat/generation.ts`     | 讀對應 env；用 AI SDK `prepareStep` callback 動態插入 step budget 進 system                                                                                                      |
| `convex/chat/prompting.ts`      | sandbox system prompt 加 citation 合約：「Every factual claim about this codebase MUST be followed by `[path:line-line]`. If you cannot cite, say 'I did not verify this'.」 |
| `convex/chat/citationLint.ts`   | **新檔**：scan finalized message，回 unverified sentence ranges                                                                                                             |
| `convex/chat/streaming.ts`      | finalize 時呼叫 lint 並寫 `messages.unverifiedClaims?: Array<{ start, end }>`                                                                                               |
| `src/components/chat-panel.tsx` | 把 `unverifiedClaims` range 渲染為底色                                                                                                                                       |


## 工作項目

1. `generation.ts`：
  ```ts
   const modelName = mode === "sandbox" ? process.env.OPENAI_MODEL_SANDBOX : ...;
  ```
2. `prepareStep`：把 `current step / max steps` 注入 system prompt 修飾段
3. citation lint：簡單實作——split sentences by `.\s`、對每個 sentence regex match `\[\S+:\d+(-\d+)?\]`；找不到的給 range（先實作 90% case）
4. UI：按 range 加 `<span className="bg-yellow-100">...`

## Verification

- `bun test convex/chat/citationLint.test.ts`
- 手動：sandbox 問題刻意要求「不要引用」，看回應底色是否標記

## 依賴

- Plan 04

---

# Plan 12 — Audit Log + 90 天 Retention

## 目標

所有 tool call 記到獨立 audit table，與使用者可見的 trace 分離，供合規 / 內部除錯查詢。90 天後自動清理。

## Done 標準（產品狀態）

- 每次 sandbox tool call 寫入 `sandboxToolCallLog` 表
- 表 by `ownerTokenIdentifier + _creationTime` indexed，可查「使用者 X 在 Y 時段讀過哪些檔案」
- Cron job 每天清掉 90 天前的紀錄

## 改動檔案


| 檔案                                  | 變更                                     |
| ----------------------------------- | -------------------------------------- |
| `convex/schema.ts`                  | 新表 `sandboxToolCallLog`                |
| `convex/chat/sandboxTools.ts`       | 每個 tool execute 完寫 log（包含 redacted 標記） |
| `convex/crons.ts`                   | 加每日清理 job                              |
| `convex/sandboxToolCallLog.test.ts` | **新檔**                                 |


## 工作項目

1. Schema：
  ```ts
   sandboxToolCallLog: defineTable({
     ownerTokenIdentifier: v.string(),
     threadId: v.id("threads"),
     messageId: v.id("messages"),
     sandboxId: v.id("sandboxes"),
     toolName: v.string(),
     inputJson: v.string(),
     outputBytes: v.number(),
     durationMs: v.number(),
     errorCode: v.optional(v.string()),
     redactedFields: v.array(v.string()),
   }).index("by_owner_and_time", ["ownerTokenIdentifier"])
     .index("by_message", ["messageId"]),
  ```
2. tool execute 完用 internal mutation 寫 log
3. crons.ts 加 daily job：刪除 `_creationTime < now - 90d` 的紀錄

## Verification

- `bun test convex/sandboxToolCallLog.test.ts`
- 手動跑一場對話、查 dashboard 看紀錄齊全

## 依賴

- Plan 08（要先有完整工具集才完整測）

---

# Plan 13 — Feature Flag Rollout + Metrics + Runbook

## 目標

從白名單擴展到灰度 rollout，並把 production 觀察性建好。

## Done 標準（產品狀態）

- `SANDBOX_ROLLOUT_PERCENT` env var 控制百分比（0–100），按 `tokenIdentifier` hash 分配
- Metrics 流到既有 logging：`sandbox_session.tool_calls.count` 等
- Runbook 文件就位：故障時的查詢路徑、rollback 步驟（`SANDBOX_MODE_ENABLED=false`）
- Rollout 流程：白名單 → 10% → 50% → 100%，每段觀察 alerts ≥ 1 週

## 改動檔案


| 檔案                             | 變更                                                     |
| ------------------------------ | ------------------------------------------------------ |
| `env.ts`                       | `SANDBOX_ROLLOUT_PERCENT`                              |
| `convex/chatModeResolver.ts`   | 從 allowlist-only 改為「allowlist OR hash% < rollout%」     |
| `convex/lib/observability.ts`  | 擴充 emit metrics 函式（若沒有則新增）                             |
| `convex/chat/generation.ts`    | 在 finalize / fail 時 emit metrics                       |
| `convex/chat/sandboxTools.ts`  | 每次 tool call 後 emit `sandbox_tool.{name}.errors_total` |
| `docs/sandbox-mode-runbook.md` | **新檔**                                                 |
| `docs/sandbox-mode-rollout.md` | **新檔**                                                 |


## 工作項目

1. Hash 函式：`(crc32(tokenIdentifier) % 100) < rolloutPercent`
2. Metrics 用既有 `logWarn` / `logInfo` 模式 emit JSON：`{ event: "sandbox_session_done", duration_ms, tool_calls, cost_usd }`，後端透過既有 telemetry 蒐集
3. Runbook：列出常見故障（Daytona down、cost spike、tool error spike）的查詢 query 與處置步驟
4. Rollout doc：列灰度 SLO 與 abort 條件

## Verification

- `bun test convex/chatModeResolver.test.ts`（新增 rollout% case）
- 手動：把 `SANDBOX_ROLLOUT_PERCENT=10` 推上去，用不同 tokenIdentifier 試，約 1/10 應被啟用

## 依賴

- Plan 11（產品品質要先就位才開放更多人）

---

# Plan 14 — Mode Onboarding + Auto-Suggest

## 目標

最後一哩 UX：第一次使用者有引導、輸入時有智慧建議切換模式。

## Done 標準（產品狀態）

- 第一次切到任何模式，跳一次性 popover 解釋三種模式差異 + 各自一個範例提問；點「Got it」後不再跳（localStorage 記錄）
- 使用者在 docs/discuss 模式輸入含具體檔案路徑的問題（regex `\b[\w/-]+\.(ts|tsx|js|jsx|py|rs|go)\b`），輸入框下方顯示 inline hint「This question references a specific file. Sandbox mode would give a more accurate answer. [Switch]」
- 開頭含 `how should I` / `what's the best way to` 的提問顯示「This sounds open-ended; General Chat might be better.」
- 兩種 hint 都可手動 dismiss 且本 session 不再顯示

## 改動檔案


| 檔案                                   | 變更                         |
| ------------------------------------ | -------------------------- |
| `src/components/mode-onboarding.tsx` | **新檔**：popover 元件          |
| `src/components/chat-panel.tsx`      | 整合 popover；輸入即時跑 heuristic |
| `src/components/chat-panel.test.tsx` | 擴充 hint 渲染測試               |


## 工作項目

1. localStorage key：`systify.onboarding.modes.dismissed`
2. Heuristic 函式 `suggestMode(input, currentMode): { suggested: ChatMode | null; reason: string }`
3. Inline hint 用既有 `<AppNotice>` variant

## Verification

- `bun test src/components/chat-panel.test.tsx`
- 手動：清掉 localStorage 後切模式，看 popover；輸入「請看 convex/chat/send.ts 第 80 行」，看是否提示切到 sandbox

## 依賴

- Plan 13（sandbox 已對全體公開，建議切換才有意義）

---

# Out of Scope（明確不涵蓋，避免 scope creep）

- ❌ `write_file` / `edit_file`（v2 才考慮，需 diff approval flow）
- ❌ Multi-sandbox（同 thread 跨 repo）
- ❌ Cross-thread artifact 借用
- ❌ Background sandbox（thread 結束後仍跑）
- ❌ Self-improving prompts

---

# Open Design Questions（執行任一 plan 前要決定的）


| #   | 問題                      | 預設建議                                                         | 影響 plan    |
| --- | ----------------------- | ------------------------------------------------------------ | ---------- |
| Q1  | Mode 命名候選               | A：General Chat / Design Docs / Sandbox（`Sandbox` 沿用工程團隊既有用語） | 01, 02, 14 |
| Q2  | 每日 cost cap             | per-user $5/day, per-workspace $50/day                       | 10         |
| Q3  | Sandbox 失敗時降級到？         | docs 模式（標 banner）                                            | 09         |
| Q4  | RAG chunks 在 sandbox 模式 | 完全去除（純 tool-driven）                                          | 04         |
| Q5  | tool-call trace 存哪      | messages.toolCalls + messageToolCallEvents 表                 | 06         |
| Q6  | run_shell 是否進 v1        | 進，但有 deny list + timeout                                     | 08         |


---

# Verification Strategy（跨 plan）

- **每個 plan PR 必跑**：`bun test`、`bunx tsc --noEmit`、相關手動驗證 case
- **Plan 04 完成後**：邀請 3-5 個內部使用者跑 ≥ 20 場真實對話，收 feedback 才進 Plan 05
- **Plan 12 完成後**：合規/安全 review，確認 audit log 與 redaction 覆蓋符合需求
- **Plan 13 灰度**：每段 rollout 觀察至少一週，metrics 健康才進下個段

