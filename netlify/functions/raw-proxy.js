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

const fetchFn = globalThis.fetch ?? (await import('node-fetch')).default;

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

  const headers = {};
  const token = process.env.GITHUB_TOKEN;
  if (token) headers['Authorization'] = `token ${token}`;

  try {
    const ghRes = await fetchFn(rawUrl, { headers });
    if (!ghRes.ok) return { statusCode: ghRes.status, body: '' };

    const ext      = path.extname(filepath).slice(1).toLowerCase();
    const mimeType = MIME_TYPES[ext] || 'application/octet-stream';
    const buf      = Buffer.from(await ghRes.arrayBuffer());

    return {
      statusCode: 200,
      headers: {
        'Content-Type': mimeType,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=300',
      },
      body: buf.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (err) {
    return { statusCode: 502, body: 'Upstream fetch failed' };
  }
}
