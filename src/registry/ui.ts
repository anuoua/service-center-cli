import type { Route } from '../shared/types.js';

export type RegistryMeta = {
  /** Display host (already normalized: 0.0.0.0 → 127.0.0.1). */
  host: string;
  port: number;
};

type Row = {
  prefix: string;
  target: string;
  url: string;
};

const COLUMNS: ReadonlyArray<{ header: string; key: keyof Row }> = [
  { header: 'PREFIX', key: 'prefix' },
  { header: 'TARGET', key: 'target' },
  { header: 'URL', key: 'url' },
];

function renderTable(rows: readonly Row[]): string {
  const widths = COLUMNS.map((col) => {
    let w = col.header.length;
    for (const row of rows) {
      const cell = row[col.key];
      if (cell.length > w) w = cell.length;
    }
    return w;
  });

  const fmt = (cells: ReadonlyArray<string>): string =>
    COLUMNS.map((col, i) => (cells[i] ?? '').padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();

  const headerLine = fmt(COLUMNS.map((c) => c.header));
  const bodyLines = rows.map((r) => fmt(COLUMNS.map((c) => r[c.key])));
  return [headerLine, ...bodyLines].join('\n');
}

export function renderRoutes(
  routes: readonly Route[],
  meta: RegistryMeta,
): string {
  const divider = '\u2500'.repeat(72);
  const baseUrl = `http://${meta.host}:${meta.port}`;
  const header =
    `sccli registry \u00b7 ${baseUrl} \u00b7 ${routes.length} route${routes.length === 1 ? '' : 's'} \u00b7 Ctrl+C to stop`;

  if (routes.length === 0) {
    return [header, divider, '(no routes registered)', divider].join('\n');
  }

  const sorted = [...routes].sort((a, b) => a.prefix.localeCompare(b.prefix));
  const rows: Row[] = sorted.map((r) => ({
    prefix: r.prefix,
    target: r.target,
    url: `${baseUrl}${r.prefix}`,
  }));

  return [header, divider, renderTable(rows), divider].join('\n');
}
