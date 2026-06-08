export interface MermaidCodeBlock {
  blockIndex: number;
  code: string;
  startLine: number;
  startLineIndex: number;
  endLineIndex: number;
}

const OPENING_MERMAID_FENCE = /^[ \t]*(`{3,}|~{3,})[ \t]*mermaid\b.*$/i;

export function extractMermaidCodeBlocks(markdown: string): MermaidCodeBlock[] {
  const lines = markdown.split(/\r?\n/);
  const blocks: MermaidCodeBlock[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const opening = OPENING_MERMAID_FENCE.exec(lines[index]);
    if (!opening) {
      continue;
    }

    const fence = opening[1];
    if (!fence) {
      continue;
    }

    const closingFence = new RegExp(`^[ \\t]*${escapeRegExp(fence)}[ \\t]*$`);
    for (let closeIndex = index + 1; closeIndex < lines.length; closeIndex += 1) {
      if (!closingFence.test(lines[closeIndex])) {
        continue;
      }

      blocks.push({
        blockIndex: blocks.length,
        code: lines.slice(index + 1, closeIndex).join("\n"),
        startLine: index + 2,
        startLineIndex: index + 1,
        endLineIndex: closeIndex,
      });
      index = closeIndex;
      break;
    }
  }

  return blocks;
}

export function replaceMermaidCodeBlocks(markdown: string, replacements: ReadonlyMap<number, string>): string {
  if (replacements.size === 0) {
    return markdown;
  }

  const lines = markdown.split(/\r?\n/);
  const blocks = extractMermaidCodeBlocks(markdown);

  for (const block of [...blocks].reverse()) {
    const replacement = replacements.get(block.blockIndex);
    if (replacement === undefined || replacement === block.code) {
      continue;
    }

    lines.splice(block.startLineIndex, block.endLineIndex - block.startLineIndex, ...replacement.split(/\r?\n/));
  }

  return lines.join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
