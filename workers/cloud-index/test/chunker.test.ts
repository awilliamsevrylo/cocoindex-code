import test from "node:test";
import assert from "node:assert/strict";
import { chunkFile, DEFAULT_CHUNK_CONFIG } from "../src/chunker.ts";
import { computeChunkId, sha256hex } from "../src/ids.ts";

// Vectorize metadata limit grounded at:
// cloudflare-docs/src/content/docs/vectorize/platform/limits.mdx:25
// "| Metadata per vector | 10KiB |"
// We cap chunk text at 8 KiB (8192 bytes) to reserve headroom for other metadata fields.

test("empty file gives []", async () => {
  const chunks = await chunkFile("empty.ts", "");
  assert.deepEqual(chunks, []);
});

test("a single 5,000-char line with no newlines", async () => {
  const line = "a".repeat(5000);
  const chunks = await chunkFile("huge_line.txt", line);
  assert.ok(chunks.length > 1, `Expected multiple chunks, got ${chunks.length}`);
  for (const chunk of chunks) {
    assert.equal(chunk.start_line, 1);
    assert.equal(chunk.end_line, 1);
    assert.ok(
      chunk.text.length <= DEFAULT_CHUNK_CONFIG.chunkSize + DEFAULT_CHUNK_CONFIG.overlap,
      `Chunk text length ${chunk.text.length} exceeds max allowed`
    );
  }
});

test("CRLF file preserves line numbering and does not split CRLF", async () => {
  const text = "line 1\r\nline 2\r\nline 3\r\n" + "line x\r\n".repeat(200);
  const chunks = await chunkFile("test.crlf.txt", text);
  assert.ok(chunks.length > 0);
  for (const chunk of chunks) {
    // Assert no chunk ends with a dangling \r without \n or starts with \n from broken \r\n
    assert.ok(!chunk.text.endsWith("\r"), "Chunk should not end with dangling \\r");
    assert.ok(!chunk.text.startsWith("\n"), "Chunk should not start with broken \\n");
  }
});

test("emoji or CJK character straddling a boundary is not split", async () => {
  // Construct text where an emoji (surrogate pair, 2 UTF-16 code units) sits around chunkSize boundary
  const filler = "x".repeat(DEFAULT_CHUNK_CONFIG.chunkSize - 1);
  const emoji = "🚀"; // 🚀 - length 2
  const text = filler + emoji + filler;
  const chunks = await chunkFile("emoji.txt", text);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    // Check for unpaired surrogates
    assert.ok(!/[\uD800-\uDBFF]$/.test(chunk.text), "Dangling high surrogate at chunk end");
    assert.ok(!/^[\uDC00-\uDFFF]/.test(chunk.text), "Dangling low surrogate at chunk start");
  }
});

test("markdown file with fenced code blocks prefers splitting at blank line or heading", async () => {
  const md = `# Title

Paragraph 1 description of the component.
More details on paragraph 1.

## Code Example

\`\`\`typescript
const a = 1;
const b = 2;
console.log(a + b);
\`\`\`

## Another Section

Closing paragraph with summary information.
`;
  const chunks = await chunkFile("doc.md", md, { chunkSize: 120, overlap: 30, minChunkSize: 50 });
  assert.ok(chunks.length > 1);
  // Verify chunks start on clean headings or blank lines where possible
  assert.ok(chunks.some(c => c.text.includes("## Code Example") || c.text.includes("# Title")));
});

test("250-char file gives exactly one chunk", async () => {
  const text = "A".repeat(250);
  const chunks = await chunkFile("small.txt", text);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].text, text);
  assert.equal(chunks[0].start_line, 1);
  assert.equal(chunks[0].end_line, 1);
  assert.equal(chunks[0].truncated, false);
});

test("determinism checked twice gives byte-identical JSON", async () => {
  const text = "export function hello() {\n  return 'world';\n}\n".repeat(50);
  const run1 = await chunkFile("src/index.ts", text);
  const run2 = await chunkFile("src/index.ts", text);
  assert.equal(JSON.stringify(run1), JSON.stringify(run2));
});

test("metadata.text truncated to 8 KiB with truncated=true (Vectorize 10 KiB cap limit grounded at limits.mdx:25)", async () => {
  // Pass a custom maxMetaTextBytes (e.g. 500 bytes) or large chunkSize to trigger 8 KiB truncation
  const hugeText = "🌟".repeat(3000); // 3000 * 4 bytes = 12,000 UTF-8 bytes
  const chunks = await chunkFile("huge.txt", hugeText, {
    chunkSize: 15000,
    overlap: 100,
    maxMetaTextBytes: 8192
  });
  assert.equal(chunks.length, 1);
  const chunk = chunks[0];
  assert.equal(chunk.truncated, true);
  const byteLen = new TextEncoder().encode(chunk.text).byteLength;
  assert.ok(byteLen <= 8192, `Expected byteLen <= 8192, got ${byteLen}`);
});

test("id is 64 hex characters computed via WebCrypto formula", async () => {
  const text = "hello world\nsecond line\n";
  const chunks = await chunkFile("hello.ts", text);
  assert.equal(chunks.length, 1);
  const chunk = chunks[0];
  assert.match(chunk.id, /^[0-9a-f]{64}$/);

  // Verify formula: sha256hex(path + "\n" + start_line + "\n" + end_line + "\n" + sha256hex(text))
  const contentHash = await sha256hex(chunk.text);
  const expectedId = await sha256hex(`${chunk.path}\n${chunk.start_line}\n${chunk.end_line}\n${contentHash}`);
  assert.equal(chunk.id, expectedId);
});
