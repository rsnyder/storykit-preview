import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import fetch from 'node-fetch';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Configuration ────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';

// --local <path> flag or LOCAL_REPO_PATH env var
const localArgIdx = process.argv.indexOf('--local');
const LOCAL_REPO_PATH = localArgIdx !== -1
  ? path.resolve(process.argv[localArgIdx + 1] || '.')
  : (process.env.LOCAL_REPO_PATH ? path.resolve(process.env.LOCAL_REPO_PATH) : '');

if (LOCAL_REPO_PATH) {
  console.log(`Local mode: reading files from ${LOCAL_REPO_PATH}`);
} else if (!GITHUB_TOKEN) {
  console.warn('Warning: GITHUB_TOKEN is not set. GitHub API rate limit will be 60 req/hr.');
}

// ── Express app ──────────────────────────────────────────────────────────────

const app = express();

// Serve preview.html for any /preview/* URL
app.get('/preview/*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'preview.html'));
});

// ── GitHub file proxy ────────────────────────────────────────────────────────
// Route: /api/gh/:owner/:repo/contents/*filepath?ref=:branch
//
// In local mode: reads from LOCAL_REPO_PATH (ignores owner/repo/ref).
// In GitHub mode: proxies to api.github.com with Authorization header.

app.get('/api/gh/:owner/:repo/contents/*', async (req, res) => {
  const filepath = req.params[0];     // everything after /contents/
  const ref = req.query.ref || 'main';

  if (LOCAL_REPO_PATH) {
    return serveLocalFile(filepath, res);
  }

  const owner = req.params.owner;
  const repo  = req.params.repo;

  // Sanity-check: owner and repo must look like valid GitHub identifiers.
  // This prevents path traversal and SSRF via crafted identifiers.
  if (!/^[\w.\-]+$/.test(owner) || !/^[\w.\-]+$/.test(repo)) {
    return res.status(400).json({ error: 'Invalid owner or repo' });
  }

  const githubUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${filepath}?ref=${encodeURIComponent(ref)}`;

  try {
    const headers = { Accept: 'application/vnd.github.v3+json' };
    if (GITHUB_TOKEN) headers['Authorization'] = `token ${GITHUB_TOKEN}`;

    const ghRes = await fetch(githubUrl, { headers });
    const body  = await ghRes.text();

    res.status(ghRes.status)
       .set('Content-Type', 'application/json')
       .set('Cache-Control', 'public, max-age=300')
       .send(body);
  } catch (err) {
    console.error('GitHub proxy error:', err.message);
    res.status(502).json({ error: 'GitHub API request failed', detail: err.message });
  }
});

// ── Raw content proxy ────────────────────────────────────────────────────────
// Route: /api/raw/:owner/:repo/:ref/*filepath
//
// Serves raw file content with correct MIME type and CORS headers so that
// assets like storykit.js can be loaded as ES modules from the srcdoc iframe
// (GitHub Pages does not serve Access-Control-Allow-Origin for JS/CSS files).
//
// In local mode: reads from LOCAL_REPO_PATH (ignores owner/repo/ref).
// In GitHub mode: fetches from raw.githubusercontent.com.

app.get('/api/raw/:owner/:repo/:ref/*', async (req, res) => {
  const filepath = req.params[0];
  const ext      = path.extname(filepath).slice(1);

  res.set('Access-Control-Allow-Origin', '*');
  res.set('Cache-Control', 'public, max-age=300');
  if (ext) res.type(ext);

  if (LOCAL_REPO_PATH) {
    const resolved = path.resolve(LOCAL_REPO_PATH, filepath);
    if (!resolved.startsWith(LOCAL_REPO_PATH + path.sep) && resolved !== LOCAL_REPO_PATH) {
      return res.status(403).end();
    }
    try {
      const buf = await fs.readFile(resolved);
      return res.send(buf);
    } catch (err) {
      return res.status(err.code === 'ENOENT' ? 404 : 500).end();
    }
  }

  const { owner, repo, ref } = req.params;
  if (!/^[\w.\-]+$/.test(owner) || !/^[\w.\-]+$/.test(repo)) {
    return res.status(400).end();
  }

  const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(ref)}/${filepath}`;
  try {
    const headers = {};
    if (GITHUB_TOKEN) headers['Authorization'] = `token ${GITHUB_TOKEN}`;
    const ghRes = await fetch(rawUrl, { headers });
    if (!ghRes.ok) return res.status(ghRes.status).end();
    const buf = Buffer.from(await ghRes.arrayBuffer());
    res.send(buf);
  } catch (err) {
    console.error('Raw proxy error:', err.message);
    res.status(502).end();
  }
});

// ── Local file helper ────────────────────────────────────────────────────────

async function serveLocalFile(filepath, res) {
  // Guard against path traversal
  const resolved = path.resolve(LOCAL_REPO_PATH, filepath);
  if (!resolved.startsWith(LOCAL_REPO_PATH + path.sep) && resolved !== LOCAL_REPO_PATH) {
    return res.status(403).json({ error: 'Path traversal not allowed' });
  }

  try {
    const buf     = await fs.readFile(resolved);
    const content = buf.toString('base64');
    res.set('Content-Type', 'application/json')
       .json({ encoding: 'base64', content });
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.status(404).json({ error: 'Not found', path: filepath });
    } else {
      console.error('Local file error:', err.message);
      res.status(500).json({ error: 'Failed to read file', detail: err.message });
    }
  }
}

// ── Root redirect ────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.send(`<!doctype html>
<html><head><title>StoryKit Preview</title>
<style>body{font-family:system-ui;max-width:700px;margin:3rem auto;padding:0 1rem}
code{background:#f4f4f4;padding:.2em .4em;border-radius:3px}</style></head>
<body>
<h1>StoryKit Preview Service</h1>
<p>Render a StoryKit page without waiting for a GitHub Pages build.</p>
<h2>Usage</h2>
<p><code>/preview/<em>owner</em>/<em>repo</em>/<em>path/to/file.md</em></code></p>
<p>Optional: add <code>?branch=my-branch</code> to preview a specific branch (default: <code>main</code>).</p>
<h2>Example</h2>
<p><a href="/preview/rsnyder/storykit-starter/_posts/2026-01-10-monument-valley.md">
/preview/rsnyder/storykit-starter/_posts/2026-01-10-monument-valley.md</a></p>
${LOCAL_REPO_PATH ? `<p><strong>Local mode:</strong> reading from <code>${LOCAL_REPO_PATH}</code></p>` : ''}
</body></html>`);
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`StoryKit preview service running at http://localhost:${PORT}`);
  if (LOCAL_REPO_PATH) {
    console.log(`  Local mode  — files served from: ${LOCAL_REPO_PATH}`);
  } else {
    console.log(`  GitHub mode — using${GITHUB_TOKEN ? ' authenticated' : ' unauthenticated'} GitHub API`);
  }
});
