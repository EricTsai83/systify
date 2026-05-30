"use node";

/**
 * Thread title autogeneration — the Node-only half.
 *
 * Vercel-AI-Chatbot pattern: when the user sends the first message on a new
 * thread, `insertChatTurn` schedules this internal action in parallel with
 * the assistant streaming action. A single non-streaming `generateText` call
 * on a cheap model produces a 3–8 word summary, which a follow-up internal
 * mutation patches onto the thread row — but only if the title is still the
 * shared `NEW_THREAD_DEFAULT_TITLE` literal. Any manual rename mid-flight
 * wins because the patch sees a non-default title and silently skips the
 * write.
 *
 * The action is best-effort: any failure (LLM 5xx, sanitizer rejects the
 * output, thread deleted under us) is logged with an error id and swallowed.
 * The thread keeps the default title; the user can rename manually via the
 * sidebar inline-edit affordance.
 *
 * The query and mutation that bookend the LLM call live in {@link ./titles}
 * — Convex disallows queries / mutations inside a `"use node"` module.
 */

import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";
import { isDefaultTitle } from "../lib/threadDefaults";
import { sanitizeTitle } from "../lib/titleSanitization";
import { logErrorWithId } from "../lib/observability";
import type { TitleGenContext } from "./titles";

/**
 * Cheapest tier that can still follow a "3–8 words, match the user's
 * language" instruction reliably. Single env knob colocated with the prompt
 * so a future swap to a smaller model is a one-line change.
 */
const TITLE_MODEL = "gpt-5-mini";

/**
 * Minimum trimmed length of the user's first message before we bother
 * calling the LLM. `"hi"` / `"test"` / `"ok"` lack the signal to produce a
 * better title than `NEW_THREAD_DEFAULT_TITLE`, so we skip the network round
 * trip entirely and leave the default in place.
 */
const MIN_USER_MESSAGE_LENGTH = 6;

/**
 * Slice cap on the user-message preview fed into the prompt. Long enough to
 * capture the question's intent, short enough that the title pass stays
 * single-digit-cents even on a wall-of-text first message.
 */
const USER_MESSAGE_PREVIEW_CHARS = 800;

const TITLE_SYSTEM_PROMPT = [
  "You will generate a short title based on the user's first message in a conversation.",
  "Output ONLY the title text, nothing else.",
  "3 to 8 words maximum.",
  "No quotes, no colons, no trailing punctuation.",
  "Match the language of the user's message (Traditional Chinese in → Traditional Chinese out).",
].join("\n");

function buildTitlePrompt(context: TitleGenContext): string {
  const preview = context.userMessage.content.slice(0, USER_MESSAGE_PREVIEW_CHARS);
  if (context.thread.mode === "library" && context.artifactTitles.length > 0) {
    return [
      `Context: User is asking about library artifact(s): ${context.artifactTitles.join(", ")}`,
      `Question: ${preview}`,
    ].join("\n");
  }
  return preview;
}

export const generateThreadTitle = internalAction({
  args: {
    threadId: v.id("threads"),
    userMessageId: v.id("messages"),
  },
  handler: async (ctx, args) => {
    try {
      const titleContext = (await ctx.runQuery(internal.chat.titles.loadTitleGenContext, {
        threadId: args.threadId,
        userMessageId: args.userMessageId,
      })) as TitleGenContext | null;
      if (!titleContext) {
        return;
      }
      if (titleContext.userMessage.content.trim().length < MIN_USER_MESSAGE_LENGTH) {
        return;
      }
      // Skip the LLM call entirely if the thread has already been renamed
      // (either by the user or — in an unlikely double-schedule — by us).
      // Saves the round trip in the common "user typed a real first
      // message then immediately renamed" case.
      if (!isDefaultTitle(titleContext.thread)) {
        return;
      }
      if (!process.env.OPENAI_API_KEY) {
        return;
      }

      const { text } = await generateText({
        model: openai(TITLE_MODEL),
        system: TITLE_SYSTEM_PROMPT,
        prompt: buildTitlePrompt(titleContext),
      });

      const sanitized = sanitizeTitle(text);
      if (!sanitized) {
        return;
      }

      await ctx.runMutation(internal.chat.titles.patchThreadTitle, {
        threadId: args.threadId,
        title: sanitized,
      });
    } catch (err) {
      logErrorWithId("chat", "title_generation_failed", err, {
        threadId: args.threadId,
        userMessageId: args.userMessageId,
      });
    }
  },
});
