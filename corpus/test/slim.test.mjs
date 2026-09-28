// extract.js slim(): the devsite article is found by class (not the first
// `<article` anywhere, e.g. inside a head <script>), nested articles are
// depth-counted, and an unbalanced page falls back to the full HTML.
// extract.js is an in-page IIFE; we evaluate it with stub globals and pull
// slim() out through a tiny source hook (no browser needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { CORPUS } from './helpers.mjs';

function loadSlim() {
  const src = readFileSync(join(CORPUS, 'crawler/extract.js'), 'utf8')
    .replace(/window\.__crawl\s*=/, 'window.__slim = slim; window.__crawl =');
  const ctx = { window: {}, TurndownService: function () { return { use() {}, addRule() {}, remove() {} }; },
    turndownPluginGfm: { gfm: {} }, AbortSignal, fetch: () => { throw new Error('no fetch in tests'); } };
  vm.runInNewContext(src, ctx);
  assert.equal(typeof ctx.window.__slim, 'function', 'slim() hook not found in extract.js');
  return ctx.window.__slim;
}
const slim = loadSlim();

const page = (head, body) => `<html><head>${head}</head><body><nav>NAV</nav>${body}<footer>F</footer></body></html>`;
const ART = (inner) => `<article class="devsite-article">${inner}</article>`;

test('nested <article>: text after the inner close is kept', () => {
  const html = page('<title>t</title>', ART('<p>before</p><article class="card">inner</article><p>after-inner</p>'));
  const out = slim(html);
  assert.match(out, /after-inner/);
  assert.doesNotMatch(out, /NAV/, 'still slimmed to the article');
});

test('`<article` inside a head <script> does not hijack the slice', () => {
  const head = '<script>var t = "<article class=\\"x\\">fake</article>";</script>';
  const out = slim(page(head, ART('<p>REAL-BODY</p>')));
  assert.match(out, /<body><article class="devsite-article"><p>REAL-BODY<\/p><\/article><\/body>/);
});

test('unbalanced article falls back to the full page (never truncates)', () => {
  const html = page('<title>t</title>', '<article class="devsite-article"><p>a</p><article>x</article><p>tail</p>');
  assert.equal(slim(html), html);
});

test('page with no devsite article returns the full page', () => {
  const html = page('', '<article><p>generic</p></article>');
  assert.equal(slim(html), html);
});

test('fetch is bounded by a timeout signal', () => {
  const src = readFileSync(join(CORPUS, 'crawler/extract.js'), 'utf8');
  assert.match(src, /fetch\(url,[^)]*signal:\s*AbortSignal\.timeout\(30000\)/);
});
