// Netlify Function: serves raw file content with CORS headers and correct MIME type.
//
// Route (via netlify.toml redirect):
//   GET /api/raw/:owner/:repo/:ref/*filepath
//
// This is needed because GitHub Pages does not serve Access-Control-Allow-Origin
// headers for JS/CSS files, so assets loaded as ES modules from the srcdoc iframe
// would be blocked. This proxy fetches from raw.githubusercontent.com and adds the
// required CORS headers.

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

  try {
    const ghRes = await fetch(rawUrl, { headers: ghHeaders });
    if (ghRes.ok) {
      const buf = Buffer.from(await ghRes.arrayBuffer());
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
  const buf = await tryUrl(`${ghPagesBase}/${filepath}`)
           ?? await tryUrl(`https://cotes2000.github.io/chirpy-demo/${filepath}`);
  if (buf) return { statusCode: 200, headers: corsHeaders, body: buf.toString('base64'), isBase64Encoded: true };
  return { statusCode: 404, body: '' };
}
