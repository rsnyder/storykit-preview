# storykit-preview

A preview service for StoryKit pages. Renders a StoryKit Markdown file on demand, without waiting for a GitHub Pages build.

## How it works

The service is a thin proxy around the existing [StoryKit preview renderer](https://github.com/rsnyder/storykit-starter/blob/main/preview/index.html). The browser still does all Liquid/Markdown rendering (via LiquidJS + markdown-it). The server's only job is to proxy GitHub API file requests using a server-held token, so users never need to configure a Personal Access Token.

## URL format

```
/:owner/:repo/:path/to/file.md?branch=main
```

- `owner` and `repo` identify the GitHub repository.
- The rest of the path is the Markdown file path within the repo.
- `branch` is optional (default: `main`).

**Example:**
```
http://localhost:3000/rsnyder/storykit-starter/_posts/2026-01-10-monument-valley.md
```

## Local development

### Setup

```bash
npm install
cp .env.example .env
# Edit .env and add your GITHUB_TOKEN
```

### GitHub mode (reads from GitHub API)

```bash
node server.js
# or
npm start
```

### Local filesystem mode (reads from a local repo directory)

```bash
node server.js --local /path/to/your/storykit-repo
# or via env var:
LOCAL_REPO_PATH=/path/to/repo node server.js
```

In local mode, `owner` and `repo` in the URL are ignored — all file requests are served from the local directory.

## Netlify deployment

1. Push this repo to GitHub.
2. Connect it to Netlify (Build command: none, Publish directory: `public`).
3. Set the `GITHUB_TOKEN` environment variable in **Netlify → Site settings → Environment variables**.
4. Deploy.

The `netlify.toml` routes `/api/gh/*` requests to the `gh-proxy` serverless function, which adds the token server-side before forwarding to GitHub.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `GITHUB_TOKEN` | Recommended | GitHub personal access token (no scopes needed for public repos). Raises rate limit from 60 to 5000 req/hr. |
| `PORT` | No | Port for local server (default: `3000`). |
| `LOCAL_REPO_PATH` | No | Path to a local StoryKit repo. Enables local filesystem mode. |

## File structure

```
storykit-preview/
├── server.js                  # Express server (local use)
├── public/
│   └── preview.html           # Modified copy of storykit-starter/preview/index.html
└── netlify/
    └── functions/
        └── gh-proxy.js        # Netlify Function: /api/gh/* proxy
```
