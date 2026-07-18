import type { IncomingMessage, ServerResponse } from 'node:http';

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.length === 0) {
    throw new Error('empty request body');
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('invalid JSON body');
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): Promise<void> {
  return new Promise((resolve) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body), () => resolve());
  });
}
