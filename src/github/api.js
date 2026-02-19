const { GH_TOKEN, GH_OWNER, GH_REPO } = process.env;

/**
 * GitHub REST API helper with authentication.
 * @param {string} endpoint - e.g. '/repos/owner/repo/...'
 * @param {object} [options] - fetch options (method, body, headers)
 * @returns {Promise<object>} parsed JSON response
 */
async function githubApi(endpoint, options = {}) {
  const url = endpoint.startsWith('https://')
    ? endpoint
    : `https://api.github.com${endpoint}`;

  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`GitHub API ${res.status}: ${text}`);
    err.status = res.status;
    throw err;
  }

  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

/**
 * Convenience: return owner/repo from env.
 */
function repoPath() {
  return `/repos/${GH_OWNER}/${GH_REPO}`;
}

module.exports = { githubApi, repoPath };
