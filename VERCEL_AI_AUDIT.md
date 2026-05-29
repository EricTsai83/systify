# Vercel AI SDK 審查報告

生成日期：2026-05-29

---

## 1. Vercel AI SDK 使用情況

### 已安裝
- `ai@^6.0.191` —— 已在 package.json 依賴中

### 已使用的部分
- ✅ **`ai/react` —— Message/MessageBranch 元件系統**（在 `src/components/ai-elements/message.tsx`）
  - `MessageBranch` / `MessageBranchContent` / `MessageBranchSelector` —— 多分支對話支援
  - `MessageAction` / `MessageActionProps` —— 訊息操作按鈕
  - `MessageAttachment` / `MessageAttachments` —— 檔案上傳預覽
  - `MessageResponse` —— 使用 `Streamdown` 渲染 markdown 回應
  - `UIMessage` 類型從 `ai` import，但沒有實際使用 useChat/useCompletion

### 未使用但可應用的部分

#### 1. **useChat Hook**（🟢 推薦使用）
**位置**：`src/components/chat-panel.tsx` 和相關的訊息流程

**理由**：
- 專案目前手動管理訊息狀態：`messages = useQuery(api.chat.threads.listMessages, ...)`
- 手動處理 streaming：`activeMessageStream = useQuery(api.chat.streaming.getActiveMessageStream, ...)`
- 手動處理發送/取消：`onSendMessage` 和 `onCancelInFlightReply` callbacks

**該怎麼做**：
```typescript
// 可以簡化為
const { messages, input, setInput, handleSubmit, isLoading } = useChat({
  api: "/api/chat",
  onError: (error) => console.error(error),
});
```

**好處**：
- 減少手動狀態管理
- 自動 streaming 支援
- 更小的 re-render 足跡

**風險/限制**：
- 需要後端 API endpoint（目前是 Convex 直接呼叫）
- 會改變現有的 Convex 整合架構
- 需要檢查 Convex-to-HTTP 的相容性

---

#### 2. **StreamableValue 和 useUIState**（🟡 條件使用）
**位置**：System Design 生成流程（`convex/chat/generateSystemDesign.ts` 等）

**當前狀態**：
- System Design 是背景 job，寫入到 artifacts table
- UI 透過 subscription 觀看生成進度

**可改進**：
```typescript
// 在 Convex action 中返回 StreamableValue
// 前端使用 useUIState 即時顯示部分結果
const { uiState } = useUIState();
```

**何時值得**：
- ✅ 如果想即時展示 System Design 的各個部分（而不是等全部完成）
- ✅ 如果想要更即時的反饋感

**何時不值得**：
- ❌ 目前背景 job + subscription 模式已經可用
- ❌ 需要修改 Convex 結構

---

#### 3. **useCompletion Hook**（🔴 不推薦）
**為什麼跳過**：
- 專案已經用 Convex 的 `useMutation` 處理補全
- useCompletion 是為了簡化無狀態的單一補全場景
- 你的架構需要訊息歷史和多個 assistant 回應

---

### 目前沒有使用的 AI SDK 功能

| 功能 | 位置 | 推薦 | 說明 |
|------|------|------|------|
| `useChat` | chat-panel | 🟢 | 可簡化訊息管理，但需要後端 API |
| `StreamableValue` | system-design 生成 | 🟡 | 可優化流式顯示，非必需 |
| `useCompletion` | — | 🔴 | 不適合此架構 |
| `useActions` / `useEdgeConfig` | — | ⚫ | 不相關 |
| `createAI` / `getAIState` | — | ⚫ | RSC 模式，不適合 SPA |

---

## 2. Layout Shift 盤點

### 🔴 高風險

#### 2.1 **ChatPanel 的 Stop 按鈕切換**（`src/components/chat-panel.tsx:456-515`）
**問題**：
```tsx
{canCancel && !isReadOnly ? (
  <Button type="button">Stop</Button>
) : (
  <Button type="submit">Send</Button>
)}
```

**影響**：
- 按鈕標籤長度不同："Stop" vs "Send"
- 外層容器的 `PromptInputFooter` 無固定寬度
- 組合其他元素（Artifacts toggle、Grounding toggles）時，整個 footer 會變寬或變窄

**目前有沒有修復**：✅ **已完整實現**
```tsx
// Send 按鈕（chat-panel.tsx:513-523）
<span className="grid">
  <span aria-hidden="true" className="invisible col-start-1 row-start-1">
    Sending…
  </span>
  <span aria-hidden="true" className="invisible col-start-1 row-start-1">
    Syncing…
  </span>
  <span className="col-start-1 row-start-1">
    {isSyncing ? "Syncing…" : isSending ? "Sending…" : "Send"}
  </span>
</span>

// Stop 按鈕（chat-panel.tsx:486-491）
<span className="grid">
  <span aria-hidden="true" className="invisible col-start-1 row-start-1">
    Stopping…
  </span>
  <span className="col-start-1 row-start-1">
    {isCancellingReply ? "Stopping…" : "Stop"}
  </span>
</span>
```

**修復方式**：
✅ **已實現於兩個按鈕** — `chat-panel.tsx` 第 456–525 行的 Send 和 Stop 按鈕都使用了 hidden/aria-hidden 的 grid-stack 技術，確保按鈕寬度在所有狀態下保持固定，不會因標籤文字長度變化而引起 CLS。

---

#### 2.2 **StatusPill 的動態標籤寬度**（`src/components/status-pill.tsx:90-114`）
**問題**：
```tsx
const labelText = state.tone === "idle" && lastSyncedLabel 
  ? `Synced ${lastSyncedLabel}` 
  : state.label;
// state.label 可能是 "Ready", "Working…", "Updates ready", "Sandbox error" 等
```

**可能的標籤**：
- "Ready" (5 chars)
- "Working…" (8 chars)
- "Updates ready" (13 chars)
- "Synced 5m ago" (13 chars)
- "Sandbox error" (13 chars)
- "Sandbox idle" (12 chars)

**影響**：
- `min-w-26` 只能覆蓋較短的標籤
- 較長的標籤會溢出或撐寬容器
- 位於 top-bar，會推動其他元素

**修復方式**：
```tsx
// 選項 1：增加 min-w（但這是症狀治療）
className={cn(
  "h-8 min-w-fit gap-1.5 px-3 text-xs",  // ← 改成 min-w-fit
  ...
)}

// 選項 2：固定寬度網格（更精確，但需計算）
className={cn(
  "h-8 w-32 gap-1.5 px-3 text-xs",  // ← 固定寬度
  ...
)}

// 選項 3：截斷長標籤
const labelText = state.tone === "idle" && lastSyncedLabel 
  ? `Synced ${lastSyncedLabel}` 
  : state.label;
// 在渲染時加 truncate + max-w
<span className="truncate">{labelText}</span>
```

**目前狀態**：✅ **有 `truncate`**，但沒有寬度約束
```tsx
<span className="truncate">{labelText}</span>
```
截斷是被動修復；主動修復應該設定 `min-w-fit` 或固定寬度。

---

#### 2.3 **SandboxActivityPill 的三種狀態**（`src/components/sandbox-activity-pill.tsx`）
**問題**：
```tsx
if (status.kind === "idle") {
  return <div>Live source inactive [Activate]</div>;
}
if (status.kind === "activating") {
  return <div>Activating live source… 45%</div>;
}
// status.kind === "ready" or "expiring_soon"
return <div>Live source ready (stops in 5 min)</div>;
```

**高度變化**：
- `idle` 狀態：2 行（標籤 + 可能的錯誤訊息）
  ```tsx
  <div className="flex flex-col gap-1">
    <div>Live source inactive...</div>
    {errorMessage ? <p>...</p> : null}
  </div>
  ```
- `activating` / `ready`：1 行
  ```tsx
  <div>Activating... 45%</div>
  ```

**影響**：
- 在 chat 訊息列表上方，會造成內容往下跳躍
- 尤其當進入 `activating` → `ready` 時，高度會縮

**修復方式**：
```tsx
// 方案 1：用 CSS Grid 預留空間（最推薦）
<div className="grid gap-1">
  <div className="flex items-center gap-2 ...">
    {/* idle 狀態 */}
  </div>
  {errorMessage && (
    <p className="px-1 text-[11px] text-destructive">{errorMessage}</p>
  )}
</div>

// 方案 2：固定高度容器
<div className="h-[72px]">
  {/* 各個狀態內容 */}
</div>

// 方案 3：min-h 保留空間
<div className="min-h-[72px]">
  {/* 各個狀態內容 */}
</div>
```

**目前狀態**：✅ **已修復**（commit 04b0d4f） — `sandbox-activity-pill.tsx` 三種狀態共用 `pillRowClass`（含 `min-h-7`），活躍生命週期切換時不會推動聊天訊息列表

---

### 🟡 中風險

#### 2.4 **ImportStatusBanner 的高度變化**（`src/components/import-status-banner.tsx`）
**問題**：
- Active state：有 progress bar（多行）
- Failed state：只有錯誤文字 + Retry 按鈕（1 行）
- 其他狀態：不渲染（0 高度）

**修復方式**：
```tsx
// 預留固定高度容器
<div className="min-h-[48px]">
  {isActive ? <ProgressBar /> : isFailed ? <ErrorBanner /> : null}
</div>
```

**目前狀態**：❌ **無防護**

---

#### 2.5 **AppNotice 的 Action 可選性**（`src/components/app-notice.tsx`）
**問題**：
```tsx
{hasAction || hasDismiss ? (
  <AlertAction className="flex items-center gap-1">
    {hasAction ? <Button>{actionLabel}</Button> : null}
    {hasDismiss ? <Button>×</Button> : null}
  </AlertAction>
) : null}
```

**影響**：
- 有 action 的 notice：更寬
- 沒 action 的 notice：更窄
- 在同一位置切換時會 shift

**修復方式**：
```tsx
// 預留 action 區域的固定空間
<AlertAction className="flex items-center gap-1 min-w-[64px]">
  {/* 內容 */}
</AlertAction>
```

**目前狀態**：❌ **無防護**

---

### 🟢 低風險或已修復

#### 2.6 **GroundingToggleBar 的 toggle 切換** ✅
- 使用 `min-w-8` 約束按鈕寬度
- 已穩定

#### 2.7 **Mode Examples 的網格佈局** ✅
- 使用 `grid` 且有 responsive `grid-cols-{N}`
- 不會水平 shift

#### 2.8 **Spinner vs Icon** ✅
- StatusPill 的 icon 都是 size-12，替換時不會 shift
- SandboxActivityPill 的 icon 也是固定 size-12

---

## 3. 整體改進建議

### 優先級排序

| 優先級 | 元件 | 風險 | 修復難度 | 建議行動 |
|--------|------|------|---------|---------|
| ✅ 完成 | ChatPanel Stop按鈕 | 高 | 低 | 已加 grid-stack + `min-w-[7.5rem]`（commit 04b0d4f） |
| ✅ 完成 | SandboxActivityPill | 高 | 中 | 已加 `min-h-7` 至共用 pill row（commit 04b0d4f） |
| 🟡 P1 | StatusPill 寬度 | 中 | 低 | 修復：min-w-fit |
| 🟡 P1 | ImportStatusBanner | 中 | 低 | 修復：min-h-[48px] |
| 🟡 P2 | AppNotice action | 低 | 低 | 優化：min-w reserve |

### 快速修復清單

```text
✅ chat-panel.tsx:456-525
  - CLS fixes 已實現於 Send 和 Stop 按鈕的 grid-stack 標籤

✅ sandbox-activity-pill.tsx
  - 三種狀態共用 pillRowClass（含 min-h-7）

□ status-pill.tsx:105-114
  - 改 min-w-26 為 min-w-fit

□ import-status-banner.tsx
  - 外層 div 加 min-h-[48px]

□ app-notice.tsx
  - AlertAction 加 min-w-[64px]
```

---

## 4. Vercel AI 集成建議

### 短期（無改動）
- ✅ 目前的 ai-elements 使用已足夠
- ✅ MessageBranch 和 Attachment 元件運作良好

### 中期（可選優化）
- 🟡 考慮 useChat hook 的成本效益
- 🟡 如果想要即時的 System Design 流式顯示，評估 StreamableValue

### 長期（架構考量）
- 考慮是否需要 Vercel AI 的 `useActions` 來替代 Convex mutation
- 目前 Convex 整合已足夠，不需急著遷移

---

## 5. 小結

**Vercel AI 使用率**：
- ✅ 基礎 UI 元件：完整使用
- ⚠️ 核心 Hook（useChat）：未使用，但可選
- ⚫ 其他功能：不適用此架構

**Layout Shift 風險**：
- 🔴 5 個明顯問題點（按優先級修復）
- ✅ 部分已防護（Send 按鈕、icon 尺寸）
- 💡 大多修復簡單（min-w、min-h、grid-stack）
