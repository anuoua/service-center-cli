import net from 'node:net';

export type AllocateOptions = {
  retries?: number;
};

export function allocatePort(opts?: AllocateOptions): Promise<number> {
  const retries = opts?.retries ?? 1;
  return attempt(0);

  async function attempt(n: number): Promise<number> {
    const server = net.createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        throw new Error('failed to get port');
      }
      const port = addr.port;
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      return port;
    } catch (err) {
      try {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      } catch {
        // ignore
      }
      if (n < retries) {
        return attempt(n + 1);
      }
      throw err;
    }
  }
}
