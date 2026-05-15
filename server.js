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
       .set('Cache-Control', 'no-store')
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
  const filepath      = req.params[0];
  const { owner, repo, ref } = req.params;
  const ext           = path.extname(filepath).slice(1);

  res.set('Access-Control-Allow-Origin', '*');
  res.set('Cache-Control', 'public, max-age=300');
  if (ext) res.type(ext);

  // ── Local filesystem mode ──────────────────────────────────────────────────
  if (LOCAL_REPO_PATH) {
    const resolved = path.resolve(LOCAL_REPO_PATH, filepath);
    if (!resolved.startsWith(LOCAL_REPO_PATH + path.sep) && resolved !== LOCAL_REPO_PATH) {
      return res.status(403).end();
    }
    try {
      const buf = await fs.readFile(resolved);
      return res.send(injectPostMessageFix(buf, ext, owner, repo, ref));
    } catch (err) {
      if (err.code !== 'ENOENT') return res.status(500).end();
      // File not in local repo (e.g. compiled jekyll-theme-chirpy.css) —
      // fall through to GitHub Pages fallback below.
    }
  } else {
    // ── GitHub raw mode ──────────────────────────────────────────────────────
    if (!/^[\w.\-]+$/.test(owner) || !/^[\w.\-]+$/.test(repo)) {
      return res.status(400).end();
    }
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(ref)}/${filepath}`;
    try {
      const headers = {};
      if (GITHUB_TOKEN) headers['Authorization'] = `token ${GITHUB_TOKEN}`;
      const ghRes = await fetch(rawUrl, { headers });
      if (ghRes.ok) {
        const buf = Buffer.from(await ghRes.arrayBuffer());
        return res.send(injectPostMessageFix(buf, ext, owner, repo, ref));
      }
      if (ghRes.status !== 404) return res.status(ghRes.status).end();
      // 404 from raw (e.g. compiled CSS not in source) — fall through to GitHub Pages.
    } catch (err) {
      console.error('Raw proxy error:', err.message);
      return res.status(502).end();
    }
  }

  // ── Fallback chain for compiled assets ────────────────────────────────────
  // Compiled assets like jekyll-theme-chirpy.css are not in the source tree
  // (only an SCSS placeholder is committed). Try two remote sources in order:
  //   1. The repo's GitHub Pages site at {owner}.github.io/{repo}/ — works for
  //      repos with a deployed site (follows redirects to custom domains too).
  //   2. The official Chirpy demo — always has the compiled Chirpy theme CSS.

  async function tryUrl(url) {
    try {
      const r = await fetch(url);
      if (!r.ok) return null;
      return Buffer.from(await r.arrayBuffer());
    } catch { return null; }
  }

  if (/^[\w.\-]+$/.test(owner) && /^[\w.\-]+$/.test(repo)) {
    const isUserSite  = repo.toLowerCase() === `${owner.toLowerCase()}.github.io`;
    const ghPagesBase = isUserSite ? `https://${owner}.github.io` : `https://${owner}.github.io/${repo}`;
    const buf = await tryUrl(`${ghPagesBase}/${filepath}`)
             ?? await tryUrl(`https://cotes2020.github.io/chirpy-demo/${filepath}`);
    if (buf) return res.send(injectPostMessageFix(buf, ext, owner, repo, ref));
  }

  return res.status(404).end();
});

// ── HTML injection helper ─────────────────────────────────────────────────────
// When serving HTML component files through /api/raw/, inject a script that patches
// window.parent.postMessage to strip the proxy prefix from any src/url fields before
// the message reaches storykit.js. Component iframes (image-compare.html, youtube.html,
// etc.) construct their showDialog URL from window.location.pathname, which includes
// the /api/raw/{o}/{r}/{ref} prefix. storykit.js's showDialog validation rejects any
// src that doesn't start with /assets/, so we strip the prefix at the sender.

function injectPostMessageFix(buf, ext, owner, repo, ref) {
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
  if (/<head>/i.test(html)) {
    html = html.replace(/<head>/i, '<head>' + script);
  } else {
    html = script + html;
  }
  return Buffer.from(html);
}

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

// ── Preview route — catch-all for /:owner/:repo/*filepath ───────────────────
// Must be defined after /api/* routes so those take precedence.

app.get('/:owner/:repo/*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'preview.html'));
});

// ── Root landing page ─────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
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
