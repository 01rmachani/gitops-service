const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set(['.git', 'node_modules', '.DS_Store']);

/**
 * Recursively read all files inside a directory.
 * Skips .git and node_modules. Reads files as UTF-8; falls back to base64 for binaries.
 * Returns an array of { path, content } where path is relative to the given dir.
 *
 * @param {string} dir - Absolute path to the directory to read
 * @param {string} [_base] - Internal: base path for building relative paths
 * @returns {Array<{path: string, content: string}>}
 */
function readDirFiles(dir, _base = dir) {
  if (!fs.existsSync(dir)) {
    throw new Error(`Directory not found: ${dir}`);
  }

  const stat = fs.statSync(dir);
  if (!stat.isDirectory()) {
    throw new Error(`Path is not a directory: ${dir}`);
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...readDirFiles(fullPath, _base));
    } else if (entry.isFile()) {
      const relativePath = path.relative(_base, fullPath);
      let content;
      try {
        content = fs.readFileSync(fullPath, 'utf8');
      } catch {
        content = fs.readFileSync(fullPath).toString('base64');
      }
      files.push({ path: relativePath, content });
    }
  }

  return files;
}

module.exports = { readDirFiles };
