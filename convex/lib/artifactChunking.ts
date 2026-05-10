import type { Id } from "../_generated/dataModel";

export const DEFAULT_ARTIFACT_CHUNK_SOFT_TOKEN_CAP = 500;
export const DEFAULT_ARTIFACT_CHUNK_HARD_TOKEN_CAP = 1500;
export const MAX_ARTIFACT_CHUNKS_PER_ARTIFACT = 200;

type MarkdownBlock =
  | {
      kind: "heading";
      level: number;
      text: string;
      startOffset: number;
      endOffset: number;
      raw: string;
    }
  | {
      kind: "paragraph" | "code";
      startOffset: number;
      endOffset: number;
      raw: string;
    };

export type ArtifactMarkdownChunk = {
  chunkIndex: number;
  headingPath: string[];
  startOffset: number;
  endOffset: number;
  content: string;
  summary?: string;
};

export type NewArtifactChunk = Omit<ArtifactMarkdownChunk, "chunkIndex">;

export type StoredArtifactChunk = ArtifactMarkdownChunk & {
  chunkId: Id<"artifactChunks">;
  artifactId: Id<"artifacts">;
  artifactTitle: string;
  artifactKind: string;
};

export type ChunkArtifactMarkdownOptions = {
  softTokenCap?: number;
  hardTokenCap?: number;
};

export function chunkArtifactMarkdown(
  markdown: string,
  options: ChunkArtifactMarkdownOptions = {},
): ArtifactMarkdownChunk[] {
  const softTokenCap = normalizeCap(options.softTokenCap, DEFAULT_ARTIFACT_CHUNK_SOFT_TOKEN_CAP);
  const hardTokenCap = normalizeCap(options.hardTokenCap, DEFAULT_ARTIFACT_CHUNK_HARD_TOKEN_CAP);
  const blocks = parseMarkdownBlocks(markdown);
  const chunks: NewArtifactChunk[] = [];
  let current: NewArtifactChunk | null = null;
  let headingPath: string[] = [];

  const flush = () => {
    if (!current) {
      return;
    }
    const content = normalizeChunkContent(current.content);
    if (content.length > 0) {
      chunks.push({
        ...current,
        content,
        summary: buildChunkSummary(current.headingPath, content),
      });
    }
    current = null;
  };

  for (const block of blocks) {
    if (block.kind === "heading" && block.level <= 3) {
      flush();
      headingPath = nextHeadingPath(headingPath, block.level, block.text);
      current = {
        headingPath,
        startOffset: block.startOffset,
        endOffset: block.endOffset,
        content: stripMarkdownNoise(block.raw),
      };
      continue;
    }

    if (!current) {
      current = {
        headingPath,
        startOffset: block.startOffset,
        endOffset: block.endOffset,
        content: "",
      };
    }

    const blockText = block.kind === "code" ? block.raw.trim() : stripMarkdownNoise(block.raw);
    if (blockText.length === 0) {
      continue;
    }

    const wouldExceedSoftCap =
      current.content.trim().length > 0 && estimateTokens(`${current.content}\n\n${blockText}`) > softTokenCap;
    if (wouldExceedSoftCap) {
      flush();
      current = {
        headingPath,
        startOffset: block.startOffset,
        endOffset: block.endOffset,
        content: "",
      };
    }

    if (estimateTokens(blockText) > hardTokenCap && block.kind !== "code") {
      const pieces = splitLongText(blockText, hardTokenCap);
      for (const piece of pieces) {
        current ??= {
          headingPath,
          startOffset: block.startOffset,
          endOffset: block.endOffset,
          content: "",
        };
        if (current.content.trim().length > 0 && estimateTokens(`${current.content}\n\n${piece}`) > hardTokenCap) {
          flush();
          current = {
            headingPath,
            startOffset: block.startOffset,
            endOffset: block.endOffset,
            content: "",
          };
        }
        current.content = appendBlock(current.content, piece);
        current.endOffset = block.endOffset;
        if (estimateTokens(current.content) >= hardTokenCap) {
          flush();
          current = null;
        }
      }
      continue;
    }

    current.content = appendBlock(current.content, blockText);
    current.endOffset = block.endOffset;
  }

  flush();

  return chunks.slice(0, MAX_ARTIFACT_CHUNKS_PER_ARTIFACT).map((chunk, index) => ({
    ...chunk,
    chunkIndex: index,
  }));
}

function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = markdown.split(/(\n)/);
  const logicalLines: Array<{ text: string; start: number; end: number }> = [];
  let offset = 0;
  for (let index = 0; index < lines.length; index += 2) {
    const text = lines[index] ?? "";
    const newline = lines[index + 1] ?? "";
    logicalLines.push({ text: `${text}${newline}`, start: offset, end: offset + text.length + newline.length });
    offset += text.length + newline.length;
  }

  let paragraphStart: number | null = null;
  let paragraphText = "";
  let inCode = false;
  let codeStart = 0;
  let codeText = "";

  const flushParagraph = () => {
    if (paragraphStart === null) {
      return;
    }
    const raw = paragraphText.trim();
    if (raw.length > 0) {
      blocks.push({
        kind: "paragraph",
        startOffset: paragraphStart,
        endOffset: paragraphStart + paragraphText.length,
        raw,
      });
    }
    paragraphStart = null;
    paragraphText = "";
  };

  for (const line of logicalLines) {
    const trimmed = line.text.trimEnd();
    if (trimmed.startsWith("```")) {
      if (!inCode) {
        flushParagraph();
        inCode = true;
        codeStart = line.start;
        codeText = line.text;
      } else {
        codeText += line.text;
        blocks.push({ kind: "code", startOffset: codeStart, endOffset: line.end, raw: codeText.trim() });
        inCode = false;
        codeText = "";
      }
      continue;
    }

    if (inCode) {
      codeText += line.text;
      continue;
    }

    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      blocks.push({
        kind: "heading",
        level: heading[1].length,
        text: stripInlineMarkdown(heading[2]),
        startOffset: line.start,
        endOffset: line.end,
        raw: trimmed,
      });
      continue;
    }

    if (trimmed.length === 0) {
      flushParagraph();
      continue;
    }

    paragraphStart ??= line.start;
    paragraphText += line.text;
  }

  if (inCode && codeText.trim().length > 0) {
    blocks.push({ kind: "code", startOffset: codeStart, endOffset: markdown.length, raw: codeText.trim() });
  }
  flushParagraph();

  return blocks;
}

function nextHeadingPath(previous: string[], level: number, text: string): string[] {
  const normalizedLevel = Math.min(Math.max(level, 1), 3);
  const next = previous.slice(0, normalizedLevel - 1);
  next[normalizedLevel - 1] = text;
  return next.filter((part) => part.length > 0);
}

function stripMarkdownNoise(raw: string): string {
  return raw
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}[-*+]\s+/gm, "- ")
    .replace(/^\s{0,3}\d+\.\s+/gm, "")
    .split("\n")
    .map((line) => stripInlineMarkdown(line.trim()))
    .join("\n")
    .trim();
}

function stripInlineMarkdown(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/`([^`]+)`/g, "`$1`")
    .trim();
}

function normalizeChunkContent(content: string): string {
  return content.replace(/\n{3,}/g, "\n\n").trim();
}

function appendBlock(current: string, block: string): string {
  return current.trim().length === 0 ? block : `${current.trim()}\n\n${block}`;
}

function splitLongText(text: string, hardTokenCap: number): string[] {
  const sentences = text.split(/(?<=[.!?。！？])\s+/);
  const pieces: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (estimateTokens(sentence) > hardTokenCap) {
      if (current.trim().length > 0) {
        pieces.push(current.trim());
        current = "";
      }
      pieces.push(...splitByWords(sentence, hardTokenCap));
      continue;
    }
    if (current.trim().length > 0 && estimateTokens(`${current} ${sentence}`) > hardTokenCap) {
      pieces.push(current.trim());
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current.trim().length > 0) {
    pieces.push(current.trim());
  }
  return pieces;
}

function splitByWords(text: string, hardTokenCap: number): string[] {
  const words = text.split(/\s+/);
  const pieces: string[] = [];
  let current: string[] = [];
  for (const word of words) {
    const candidate = [...current, word].join(" ");
    if (current.length > 0 && estimateTokens(candidate) > hardTokenCap) {
      pieces.push(current.join(" "));
      current = [word];
    } else {
      current.push(word);
    }
  }
  if (current.length > 0) {
    pieces.push(current.join(" "));
  }
  return pieces;
}

function buildChunkSummary(headingPath: string[], content: string): string | undefined {
  if (headingPath.length > 0) {
    return headingPath.join(" > ");
  }
  const firstLine = content.split("\n").find((line) => line.trim().length > 0);
  return firstLine ? firstLine.slice(0, 160) : undefined;
}

function estimateTokens(value: string): number {
  const asciiWords = value.match(/[A-Za-z0-9_]+/g)?.length ?? 0;
  const nonWhitespace = value.replace(/\s/g, "").length;
  return Math.max(1, Math.ceil(Math.max(asciiWords * 1.3, nonWhitespace / 3)));
}

function normalizeCap(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}
