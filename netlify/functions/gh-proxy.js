// Netlify Function: proxies /api/gh/* requests to the GitHub Contents API,
// adding a server-side token so the browser never handles credentials.
//
// Route (via netlify.toml redirect):
//   GET /api/gh/:owner/:repo/contents/*filepath?ref=:branch

export async function handler(event) {
  // Strip the /api/gh/ prefix to get /:owner/:repo/contents/*filepath?ref=...
  const suffix = event.path.replace(/^\/api\/gh\//, '');

  // Basic validation: first two path segments must be owner/repo
  const parts = suffix.split('/');
  if (parts.length < 3) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid path' }) };
  }

  const [owner, repo] = parts;
  if (!/^[\w.\-]+$/.test(owner) || !/^[\w.\-]+$/.test(repo)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid owner or repo' }) };
  }

  const ref = event.queryStringParameters?.ref || 'main';
  const githubUrl = `https://api.github.com/repos/${suffix.split('?')[0]}?ref=${encodeURIComponent(ref)}`;

  const headers = { Accept: 'application/vnd.github.v3+json' };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers['Authorization'] = `token ${token}`;

  try {
    const ghRes = await fetch(githubUrl, { headers });
    const body  = await ghRes.text();

    return {
      statusCode: ghRes.status,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300',
      },
      body,
    };
  } catch (err) {
    return {
      statusCode: 502,
      body: JSON.stringify({ error: 'GitHub API request failed', detail: err.message }),
    };
  }
}
