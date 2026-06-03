# [BUG] Failed first send can leave an empty Library Ask thread

**File:** [`src/components/library-ask-panel.tsx`](https://github.com/EricTsai83/systify/blob/main/src/components/library-ask-panel.tsx#L307-L336) (lines 307, 308, 324, 336)
**Project:** systify
**Severity:** BUG  •  **Confidence:** high  •  **Slug:** `other-orphaned-record`

## Owners

**Suggested assignee:** `eric492718@gmail.com` _(via last-committer)_

## Finding

When there is no active thread, the panel first calls createLibraryAskThread and only afterward calls sendMessage. If sendMessage fails after the thread is created, for example because of rate limiting, an archived repository, model validation, or mode eligibility, the catch block only stores the error and does not remove the newly created thread. This can leave empty 'Library Ask' threads in history and allows repeated failed sends to create persistent empty rows.

## Recommendation

Make Library Ask first-message send atomic on the backend, mirroring sendMessageStartingNewThread: validate, rate-limit, create the thread, and insert the first turn in one mutation. Avoid client-side create-then-send orchestration for the first message.

## Recent committers (`git log`)

- Eric Tsai <eric492718@gmail.com> (2026-06-02)
