import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pickReachableRpc } from '../src/provider.js';

describe('pickReachableRpc', () => {
  let server: Server;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const url = (req.url ?? '').slice(1); // path carries the endpoint id
        if (url === 'dead') {
          res.writeHead(502).end('bad gateway');
          return;
        }
        if (url === 'auth') {
          // 200 with an error body (rate-limit / api-key required) must be skipped.
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Unauthorized' }, id: body.id }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', result: '0x1', id: body.id }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterAll(() => server.close());

  function base(url: string): string {
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server not listening');
    return `http://127.0.0.1:${String(address.port)}/${url}`;
  }

  it('skips dead endpoints and 200-with-error bodies, picking the first working one', async () => {
    const chosen = await pickReachableRpc([base('dead'), base('auth'), base('ok')], 1000);
    expect(chosen).toBe(base('ok'));
  });

  it('picks the first healthy endpoint in order', async () => {
    const chosen = await pickReachableRpc([base('ok'), base('ok2')], 1000);
    expect(chosen).toBe(base('ok'));
  });

  it('falls back to the first candidate when every endpoint fails', async () => {
    const chosen = await pickReachableRpc([base('dead')], 500);
    expect(chosen).toBe(base('dead'));
  });
});
