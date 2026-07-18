export function longestMatch(prefixes: readonly string[], url: string): string | null {
  const path = url.split('?', 1)[0] ?? url;
  let best: string | null = null;
  for (const prefix of prefixes) {
    if (matchesSegment(prefix, path)) {
      if (best === null || prefix.length > best.length) {
        best = prefix;
      }
    }
  }
  return best;
}

function matchesSegment(prefix: string, path: string): boolean {
  if (path === prefix) return true;
  if (!path.startsWith(prefix)) return false;
  if (prefix.endsWith('/')) return true;
  return path.charAt(prefix.length) === '/';
}
