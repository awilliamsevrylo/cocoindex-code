// In-page extractor. Runs inside Chromium (injected after turndown,
// turndown-plugin-gfm and Readability). Exposes window.__crawl(urls, conc):
// fetches each URL with the page's own fetch (same origin, real browser),
// parses it with DOMParser, extracts the devsite article, converts to MD.
// Returns [{url, ok, status, md?, via?, err?}] — no HTML leaves the page.
(() => {
  // Chrome that sits inside the article on devsite pages (measured on guide
  // and reference pages, 2026-09-28).
  const DROP = [
    '.nocontent', 'devsite-feedback', 'devsite-thumb-rating', 'devsite-bookmark',
    '.devsite-article-meta', '.devsite-breadcrumb-list', 'devsite-nav',
    '.devsite-floating-action-buttons', '.devsite-page-title-meta',
    'devsite-toc', 'devsite-content-footer', 'devsite-hats-survey',
    'script', 'style', 'noscript', 'template', 'button', 'devsite-dialog',
    'devsite-page-rating', 'devsite-actions', '.devsite-banner',
  ];

  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  td.use(turndownPluginGfm.gfm);
  // devsite wraps code as <devsite-code><pre class="prettyprint lang-kotlin">.
  td.addRule('devsiteCode', {
    filter: (n) => n.nodeName === 'PRE',
    replacement: (_c, n) => {
      const lang = ((n.className || '').match(/lang-([\w+-]+)/) || [])[1] || '';
      const code = n.textContent.replace(/\n+$/, '');
      return `\n\n\`\`\`${lang}\n${code}\n\`\`\`\n\n`;
    },
  });
  td.remove(['script', 'style']);

  function absolutize(root, base) {
    for (const a of root.querySelectorAll('a[href]')) {
      try { a.setAttribute('href', new URL(a.getAttribute('href'), base).href); } catch {}
    }
    for (const img of root.querySelectorAll('img[src]')) {
      try { img.setAttribute('src', new URL(img.getAttribute('src'), base).href); } catch {}
    }
  }

  function extract(doc, url) {
    const body = doc.querySelector('article.devsite-article .devsite-article-body')
      || doc.querySelector('.devsite-article-body');
    if (body) {
      for (const sel of DROP) body.querySelectorAll(sel).forEach((n) => n.remove());
      absolutize(body, url);
      const title = (doc.querySelector('h1.devsite-page-title')?.textContent
        || doc.querySelector('meta[property="og:title"]')?.content
        || doc.title.split('|')[0] || '').trim();
      let md = td.turndown(body).trim();
      if (title && !md.startsWith('# ')) md = `# ${title}\n\n${md}`;
      return { md, via: 'devsite' };
    }
    // Fallback: generic open-source extraction.
    const art = new Readability(doc.cloneNode(true)).parse();
    if (!art || !art.content) return null;
    const holder = doc.createElement('div');
    holder.innerHTML = art.content;
    absolutize(holder, url);
    return { md: `# ${(art.title || '').trim()}\n\n${td.turndown(holder).trim()}`, via: 'readability' };
  }

  // The devsite article: <article ... class="... devsite-article ...">, searched
  // only AFTER </head> so an `<article` string inside a head <script> never
  // counts. Nested <article> elements are depth-counted to the matching close.
  // Anything unexpected returns the FULL page (slower, never truncated).
  const DEVSITE_ARTICLE = /<article\b[^>]*\bclass=["'](?:[^"']*\s)?devsite-article(?:\s[^"']*)?["']/i;
  function slim(html) {
    const h = html.indexOf('</head>');
    if (h < 0) return html;
    const m = DEVSITE_ARTICLE.exec(html.slice(h));
    if (!m) return html; // no devsite article: Readability needs the full page
    const a = h + m.index;
    const tag = /<(\/?)article\b[^>]*>/gi;
    tag.lastIndex = a;
    let depth = 0, t;
    while ((t = tag.exec(html))) {
      depth += t[1] ? -1 : 1;
      if (depth === 0) {
        const z = t.index + t[0].length;
        return `${html.slice(0, h + 7)}<body>${html.slice(a, z)}</body></html>`;
      }
    }
    return html; // unbalanced: parse the whole page rather than truncate
  }

  async function one(url) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(url, { credentials: 'omit', redirect: 'follow', signal: AbortSignal.timeout(30000) });
        if (r.status === 429 || r.status >= 500) {
          await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
          continue;
        }
        if (!r.ok) return { url, ok: false, status: r.status };
        // Reference pages are ~2.2 MB, almost all nav; parsing the whole thing
        // grew the renderer to 3.3 GB and the rate fell 327 → 130 pages/min
        // (POC 10b). Parse only <head> + <article> (~66 KB) when present.
        const html = await r.text();
        const doc = new DOMParser().parseFromString(slim(html), 'text/html');
        const out = extract(doc, r.url || url);
        if (!out || out.md.length < 40) return { url, ok: false, status: r.status, err: 'empty' };
        return { url, ok: true, status: r.status, md: `<!-- source: ${url} -->\n\n${out.md}\n`, via: out.via };
      } catch (e) {
        if (attempt === 2) return { url, ok: false, status: 0, err: String(e).slice(0, 120) };
      }
    }
    return { url, ok: false, status: 429 };
  }

  window.__crawl = async (urls, conc) => {
    const out = new Array(urls.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(conc, urls.length) }, async () => {
      while (next < urls.length) {
        const i = next++;
        out[i] = await one(urls[i]);
      }
    }));
    return out;
  };
})();
