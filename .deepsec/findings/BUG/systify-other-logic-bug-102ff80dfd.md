# [BUG] Chat replies omit prior conversation history

**File:** [`convex/chat/prompting.ts`](https://github.com/EricTsai83/systify/blob/main/convex/chat/prompting.ts#L195-L238) (lines 195, 222, 238)
**Project:** systify
**Severity:** BUG  •  **Confidence:** high  •  **Slug:** `other-logic-bug`

## Owners

**Suggested assignee:** `eric492718@gmail.com` _(via last-committer)_

## Finding

buildUserPrompt receives the full ReplyContext but only serializes repository metadata, artifacts, relevant chunks, and the current user question. The recent message window loaded by getReplyContext is not included in the prompt or otherwise passed to the gateway, so multi-turn chat replies can ignore earlier user and assistant messages despite the context loader maintaining MAX_CONTEXT_MESSAGES.

## Recommendation

Include a bounded, role-labeled conversation-history section in the prompt, or change the gateway call to use a structured messages array containing the prior turns plus the current grounded prompt.

## Recent committers (`git log`)

- Eric Tsai <eric492718@gmail.com> (2026-05-29)
