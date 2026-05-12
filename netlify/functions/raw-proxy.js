// Netlify Function: serves raw file content with CORS headers and correct MIME type.
//
// Route (via netlify.toml redirect):
//   GET /api/raw/:owner/:repo/:ref/*filepath
//
// This is needed because GitHub Pages does not serve Access-Control-Allow-Origin
// headers for JS/CSS files, so assets loaded as ES modules from the srcdoc iframe
// would be blocked. This proxy fetches from raw.githubusercontent.com and adds the
// required CORS headers.
//
// For HTML files, a small script is injected that patches window.parent.postMessage
// to strip the /api/raw/{o}/{r}/{ref} prefix from any src/url fields before the
// message reaches storykit.js. Component iframes (image-compare.html, youtube.html,
// etc.) construct their showDialog URL from window.location.pathname which includes
// the proxy prefix; storykit.js's showDialog validation rejects anything that doesn't
// start with /assets/, so we strip the prefix at the sender.

import path from 'path';

const MIME_TYPES = {
  js:   'application/javascript',
  mjs:  'application/javascript',
  css:  'text/css',
  html: 'text/html',
  json: 'application/json',
  svg:  'image/svg+xml',
  png:  'image/png',
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  gif:  'image/gif',
  woff: 'font/woff',
  woff2:'font/woff2',
  ttf:  'font/ttf',
  ico:  'image/x-icon',
};

export async function handler(event) {
  // Path: /api/raw/:owner/:repo/:ref/*filepath
  const suffix = event.path.replace(/^\/api\/raw\//, '');
  const parts  = suffix.split('/');

  if (parts.length < 4) {
    return { statusCode: 400, body: 'Invalid path' };
  }

  const [owner, repo, ref, ...fileParts] = parts;
  const filepath = fileParts.join('/');

  if (!/^[\w.\-]+$/.test(owner) || !/^[\w.\-]+$/.test(repo)) {
    return { statusCode: 400, body: 'Invalid owner or repo' };
  }

  const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(ref)}/${filepath}`;

  const ghHeaders = {};
  const token = process.env.GITHUB_TOKEN;
  if (token) ghHeaders['Authorization'] = `token ${token}`;

  const ext      = path.extname(filepath).slice(1).toLowerCase();
  const mimeType = MIME_TYPES[ext] || 'application/octet-stream';
  const corsHeaders = {
    'Content-Type': mimeType,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=300',
  };

  // Inject a postMessage-fix script into HTML responses. Component iframes served
  // through the proxy have URLs like /api/raw/{o}/{r}/{ref}/assets/components/foo.html.
  // Their click handlers send postMessage with that full path as the dialog src, but
  // storykit.js's showDialog only accepts paths starting with /assets/. The injected
  // script patches window.parent.postMessage before the component's own JS runs,
  // stripping the proxy prefix so showDialog receives the canonical path.
  function injectPostMessageFix(buf) {
    if (ext !== 'html') return buf;
    const prefix = `/api/raw/${owner}/${repo}/${ref}`;
    const script =
      `<script>` +
      `(function(){` +
        `var p=${JSON.stringify(prefix)},pp=window.parent&&window.parent.postMessage;` +
        `if(!pp||pp.__ppx)return;` +
        `var orig=pp.bind(window.parent);` +
        `function fix(s){return typeof s==='string'&&s.indexOf(p)===0?window.location.origin+s:s;}` +
        `window.parent.postMessage=function(d,t){` +
          `if(typeof d==='string')d=fix(d);` +
          `else if(d&&typeof d==='object'){d=Object.assign({},d);` +
            `['src','href','url','path'].forEach(function(k){d[k]=fix(d[k]);});` +
          `}` +
          `return orig(d,t);` +
        `};` +
        `window.parent.postMessage.__ppx=1;` +
      `})()` +
      `</script>`;
    let html = buf.toString('utf8');
    html = /<head>/i.test(html) ? html.replace(/<head>/i, '<head>' + script) : script + html;
    return Buffer.from(html);
  }

  try {
    const ghRes = await fetch(rawUrl, { headers: ghHeaders });
    if (ghRes.ok) {
      const buf = injectPostMessageFix(Buffer.from(await ghRes.arrayBuffer()));
      return { statusCode: 200, headers: corsHeaders, body: buf.toString('base64'), isBase64Encoded: true };
    }
    if (ghRes.status !== 404) return { statusCode: ghRes.status, body: '' };
    // 404 from raw — fall through to GitHub Pages fallback
  } catch {
    return { statusCode: 502, body: 'Upstream fetch failed' };
  }

  // Fallback chain for compiled assets (jekyll-theme-chirpy.css, etc.):
  //   1. The repo's GitHub Pages site — works for repos with a deployed site.
  //   2. The official Chirpy demo — universal fallback for Chirpy theme CSS.
  async function tryUrl(url) {
    try {
      const r = await fetch(url);
      if (!r.ok) return null;
      return Buffer.from(await r.arrayBuffer());
    } catch { return null; }
  }

  const isUserSite  = repo.toLowerCase() === `${owner.toLowerCase()}.github.io`;
  const ghPagesBase = isUserSite ? `https://${owner}.github.io` : `https://${owner}.github.io/${repo}`;
  const buf = injectPostMessageFix(
    await tryUrl(`${ghPagesBase}/${filepath}`) ??
    await tryUrl(`https://cotes2020.github.io/chirpy-demo/${filepath}`)
  );
  if (buf) return { statusCode: 200, headers: corsHeaders, body: buf.toString('base64'), isBase64Encoded: true };
  return { statusCode: 404, body: '' };
}
