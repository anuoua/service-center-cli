import { readFile } from 'node:fs/promises';
import type { RewriteRule } from '../shared/types.js';

// Static routes are declared in a JSON file (`sccli registry --routes file.json`)
// and loaded at startup / on SIGHUP. They exist for services that cannot
// register themselves. This module only parses & validates the file shape;
// semantic checks (admin-prefix collision, duplicates) live in RouteStore.

export type StaticRouteInput = {
  prefix: string;
  target: string;
  rewrite?: RewriteRule;
};

export type LoadRoutesResult =
  | { ok: true; routes: StaticRouteInput[] }
  | { ok: false; error: string };

export async function loadStaticRoutesFile(
  filePath: string,
): Promise<LoadRoutesResult> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    return {
      ok: false,
      error: `cannot read ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      error: `invalid JSON in ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      error: `${filePath}: expected a JSON array of routes, got ${typeof parsed}`,
    };
  }

  const routes: StaticRouteInput[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i];
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return {
        ok: false,
        error: `${filePath}: route[${i}] must be an object with "prefix" and "target"`,
      };
    }
    const prefix = (entry as Record<string, unknown>).prefix;
    const target = (entry as Record<string, unknown>).target;
    if (typeof prefix !== 'string' || prefix.length === 0) {
      return {
        ok: false,
        error: `${filePath}: route[${i}].prefix must be a non-empty string`,
      };
    }
    if (typeof target !== 'string' || target.length === 0) {
      return {
        ok: false,
        error: `${filePath}: route[${i}].target must be a non-empty string`,
      };
    }
    const rewrite = parseRewrite(filePath, i, entry);
    if (!rewrite.ok) return rewrite;
    routes.push({
      prefix,
      target,
      ...(rewrite.rewrite !== undefined ? { rewrite: rewrite.rewrite } : {}),
    });
  }
  return { ok: true, routes };
}

function parseRewrite(
  filePath: string,
  index: number,
  entry: unknown,
): { ok: true; rewrite?: RewriteRule } | { ok: false; error: string } {
  const rawRewrite = (entry as Record<string, unknown>).rewrite;
  if (rawRewrite === undefined) return { ok: true };
  if (typeof rawRewrite !== 'object' || rawRewrite === null || Array.isArray(rawRewrite)) {
    return {
      ok: false,
      error: `${filePath}: route[${index}].rewrite must be an object with "pattern" and "to"`,
    };
  }
  const pattern = (rawRewrite as Record<string, unknown>).pattern;
  const to = (rawRewrite as Record<string, unknown>).to;
  if (typeof pattern !== 'string' || pattern.length === 0) {
    return {
      ok: false,
      error: `${filePath}: route[${index}].rewrite.pattern must be a non-empty string`,
    };
  }
  if (typeof to !== 'string') {
    return {
      ok: false,
      error: `${filePath}: route[${index}].rewrite.to must be a string`,
    };
  }
  try {
    new RegExp(pattern);
  } catch (err) {
    return {
      ok: false,
      error: `${filePath}: route[${index}].rewrite.pattern is not a valid regular expression: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { ok: true, rewrite: { pattern, to } };
}
