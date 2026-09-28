/**
 * Core chunker module for Cloudflare cloud-index Worker.
 *
 * NOTE: Parity with the Rust RecursiveSplitter is NOT required.
 * Reason: the local embed cache is an optional seed only. The cloud-first
 * Vectorize index pipeline uses this deterministic TypeScript chunker
 * as the source of truth for chunk boundaries and chunk IDs.
 */

import { computeChunkId } from "./ids.ts";
import { detectLanguage } from "./languages.ts";

export interface Chunk {
  id: string;
  path: string;
  start_line: number;
  end_line: number;
  text: string;
  lang: string;
  truncated: boolean;
}

export interface ChunkerConfig {
  chunkSize: number;
  minChunkSize: number;
  overlap: number;
  maxMetaTextBytes: number;
  lang?: string;
}

export const DEFAULT_CHUNK_CONFIG: ChunkerConfig = {
  chunkSize: 1000,
  minChunkSize: 250,
  overlap: 150,
  maxMetaTextBytes: 8192,
};

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function adjustBoundary(text: string, index: number): number {
  if (index <= 0 || index >= text.length) return index;
  // Never split CRLF (\r\n)
  if (text[index - 1] === "\r" && text[index] === "\n") {
    return index + 1 <= text.length ? index + 1 : index - 1;
  }
  // Never split surrogate pair
  if (isHighSurrogate(text.charCodeAt(index - 1)) && isLowSurrogate(text.charCodeAt(index))) {
    return index - 1;
  }
  return index;
}

export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(text);
  if (encoded.byteLength <= maxBytes) {
    return { text, truncated: false };
  }
  const slice = encoded.subarray(0, maxBytes);
  const decoder = new TextDecoder("utf-8");
  let truncatedStr = decoder.decode(slice);
  if (truncatedStr.length > 0 && isHighSurrogate(truncatedStr.charCodeAt(truncatedStr.length - 1))) {
    truncatedStr = truncatedStr.slice(0, -1);
  }
  return { text: truncatedStr, truncated: true };
}

function countLines(text: string): { startLine: number; endLine: number } {
  return { startLine: 1, endLine: Math.max(1, (text.match(/\n/g) || []).length + (text.endsWith("\n") ? 0 : 1)) };
}

function computeLineRange(fullText: string, startIdx: number, endIdx: number): { start_line: number; end_line: number } {
  const prefix = fullText.slice(0, startIdx);
  const start_line = 1 + (prefix.match(/\n/g) || []).length;
  const chunkSlice = fullText.slice(startIdx, endIdx);
  const chunkNewlines = (chunkSlice.match(/\n/g) || []).length;
  let end_line = start_line + chunkNewlines;
  if (chunkSlice.endsWith("\n")) {
    end_line = Math.max(start_line, end_line - 1);
  }
  return { start_line, end_line };
}

/**
 * Recursive splitter separator levels:
 * 1. Paragraph / markdown heading
 * 2. Line breaks
 * 3. Sentences / punctuation / space
 */
function findSplitPoint(text: string, minPos: number, maxPos: number): number {
  const windowText = text.slice(0, maxPos);

  // Level 1: Paragraphs (\n\n or \r\n\r\n) or markdown headings (\n#)
  const p1 = windowText.lastIndexOf("\n\n");
  if (p1 >= minPos) return p1 + 2;
  const p1Crlf = windowText.lastIndexOf("\r\n\r\n");
  if (p1Crlf >= minPos) return p1Crlf + 4;
  const heading = windowText.search(/\n#{1,6}\s[^\n]*$/);
  if (heading >= minPos) return heading + 1;

  // Level 2: Line breaks
  const lineBreak = windowText.lastIndexOf("\n");
  if (lineBreak >= minPos) return lineBreak + 1;

  // Level 3: Sentence or space
  const sentence = windowText.search(/(\.\s|;\s|\?\s|!\s)[^\.\?!;]*$/);
  if (sentence >= minPos) return sentence + 2;

  const space = windowText.lastIndexOf(" ");
  if (space >= minPos) return space + 1;

  // Level 4: Hard cut
  return maxPos;
}

/**
 * Splits text into chunks.
 *
 * NOTE: Chunk text length is measured in UTF-16 code units (JS string length).
 * Every chunk.text length is at most cfg.chunkSize + cfg.overlap.
 * No chunk splits a surrogate pair or CRLF.
 * Only a whole-file chunk may be smaller than minChunkSize.
 */
export async function chunkFile(
  path: string,
  text: string,
  options?: Partial<ChunkerConfig>
): Promise<Chunk[]> {
  if (!text || text.length === 0) {
    return [];
  }

  const cfg: ChunkerConfig = { ...DEFAULT_CHUNK_CONFIG, ...options };
  const lang = cfg.lang || detectLanguage(path);
  const maxChunkLength = cfg.chunkSize + cfg.overlap;

  if (text.length <= maxChunkLength) {
    const { startLine, endLine } = countLines(text);
    const { text: metaText, truncated } = truncateUtf8(text, cfg.maxMetaTextBytes);
    const id = await computeChunkId(path, startLine, endLine, metaText);
    return [
      {
        id,
        path,
        start_line: startLine,
        end_line: endLine,
        text: metaText,
        lang,
        truncated,
      },
    ];
  }

  const rawSlices: { start: number; end: number }[] = [];
  let curStart = 0;

  while (curStart < text.length) {
    const remaining = text.length - curStart;

    if (remaining <= maxChunkLength) {
      let finalStart = curStart;
      if (rawSlices.length > 0 && remaining < cfg.minChunkSize) {
        finalStart = Math.max(0, text.length - cfg.minChunkSize);
        finalStart = adjustBoundary(text, finalStart);
      }
      rawSlices.push({ start: finalStart, end: text.length });
      break;
    }

    const minPos = curStart + Math.min(cfg.minChunkSize, remaining);
    const targetPos = curStart + cfg.chunkSize;
    let cutPoint = findSplitPoint(text.slice(0, curStart + maxChunkLength), targetPos, curStart + maxChunkLength);

    if (cutPoint > curStart + maxChunkLength || cutPoint <= curStart) {
      cutPoint = findSplitPoint(text.slice(0, targetPos), minPos, targetPos);
    }

    if (cutPoint <= curStart || cutPoint < minPos) {
      cutPoint = Math.min(targetPos, curStart + maxChunkLength);
    }

    cutPoint = adjustBoundary(text, cutPoint);
    if (cutPoint <= curStart) {
      cutPoint = curStart + Math.min(cfg.chunkSize, remaining);
      cutPoint = adjustBoundary(text, cutPoint);
    }

    rawSlices.push({ start: curStart, end: cutPoint });

    let nextStart = cutPoint - cfg.overlap;
    const windowBefore = text.slice(Math.max(curStart, nextStart - 80), Math.min(cutPoint, nextStart + 80));
    const nl = windowBefore.lastIndexOf("\n");
    if (nl !== -1) {
      const aligned = Math.max(curStart, nextStart - 80) + nl + 1;
      if (aligned > curStart && aligned < cutPoint) {
        nextStart = aligned;
      }
    }

    nextStart = adjustBoundary(text, nextStart);
    if (nextStart <= curStart) {
      nextStart = curStart + 1;
    }
    curStart = nextStart;
  }

  if (rawSlices.length > 1) {
    for (let i = 0; i < rawSlices.length; i++) {
      const slice = rawSlices[i];
      if (slice.end - slice.start < cfg.minChunkSize) {
        if (i === rawSlices.length - 1) {
          slice.start = Math.max(0, slice.end - cfg.minChunkSize);
          slice.start = adjustBoundary(text, slice.start);
        } else {
          slice.end = Math.min(text.length, slice.start + cfg.minChunkSize);
          slice.end = adjustBoundary(text, slice.end);
        }
      }
    }
  }

  const chunks: Chunk[] = [];
  for (const s of rawSlices) {
    const rawChunkText = text.slice(s.start, s.end);
    const { start_line, end_line } = computeLineRange(text, s.start, s.end);
    const { text: metaText, truncated } = truncateUtf8(rawChunkText, cfg.maxMetaTextBytes);
    const id = await computeChunkId(path, start_line, end_line, metaText);

    chunks.push({
      id,
      path,
      start_line,
      end_line,
      text: metaText,
      lang,
      truncated,
    });
  }

  return chunks;
}
export { detectLanguage };
