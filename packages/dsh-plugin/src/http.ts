/**
 * Read-only HTTP endpoints for the web UI.
 *
 * {@link buildRoutes} constructs route descriptors with Node.js-style
 * `(req, res)` handlers. All endpoints return secret-free JSON.
 *
 * @module @dsh-wallet/plugin/http
 */

import type { WalletService } from './service.js';

/** A minimal HTTP request shape. */
export interface HttpRequest {
  method: string;
  url?: string;
  query?: Record<string, string>;
}

/** A minimal HTTP response shape. */
export interface HttpResponse {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body: string): void;
}

/** A single read-only route descriptor. */
export interface WalletHttpRoute {
  method: 'GET';
  path: string;
  description: string;
  handler(req: HttpRequest, res: HttpResponse): void | Promise<void>;
}

function sendJson(res: HttpResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function parseQuery(req: HttpRequest): Record<string, string> {
  if (req.query !== undefined) return req.query;
  if (req.url === undefined) return {};
  const queryIndex = req.url.indexOf('?');
  if (queryIndex < 0) return {};
  const params = new URLSearchParams(req.url.slice(queryIndex + 1));
  const result: Record<string, string> = {};
  for (const [key, value] of params.entries()) result[key] = value;
  return result;
}

/**
 * Build all read-only HTTP routes for the wallet service.
 *
 * @param service - the wallet service to route requests to.
 * @returns an array of route descriptors.
 */
export function buildRoutes(service: WalletService): WalletHttpRoute[] {
  return [
    {
      method: 'GET',
      path: '/api/dsh-wallet/status',
      description: 'Vault status snapshot.',
      handler: (_req, res) => {
        sendJson(res, 200, service.status());
      },
    },

    {
      method: 'GET',
      path: '/api/dsh-wallet/accounts',
      description: 'List all accounts (metadata only).',
      handler: (_req, res) => {
        sendJson(res, 200, { accounts: service.listAccounts() });
      },
    },

    {
      method: 'GET',
      path: '/api/dsh-wallet/balances',
      description: 'Native + configured token balances. Query: chainId, address.',
      handler: async (req, res) => {
        const query = parseQuery(req);
        const chainId = Number(query.chainId);
        const address = query.address;
        if (!Number.isFinite(chainId) || address === undefined) {
          sendJson(res, 400, { error: 'query parameters "chainId" and "address" are required' });
          return;
        }
        try {
          const meta = service.vault.requireAccount(address);
          const balances = await service.balances(meta, chainId);
          sendJson(res, 200, balances);
        } catch (error) {
          sendJson(res, 404, { error: error instanceof Error ? error.message : String(error) });
        }
      },
    },

    {
      method: 'GET',
      path: '/api/dsh-wallet/policy',
      description: 'Current signing policy.',
      handler: (_req, res) => {
        sendJson(res, 200, { policy: service.getPolicy() });
      },
    },

    {
      method: 'GET',
      path: '/api/dsh-wallet/audit',
      description: 'Recent audit entries. Query: limit (default 30).',
      handler: async (req, res) => {
        const query = parseQuery(req);
        const limit = query.limit !== undefined ? Number(query.limit) : 30;
        const entries = await service.recentAudit(Number.isFinite(limit) ? limit : 30);
        sendJson(res, 200, { entries });
      },
    },

    {
      method: 'GET',
      path: '/api/dsh-wallet/chains',
      description: 'Built-in chain registry.',
      handler: async (_req, res) => {
        const { listChains } = await import('@dsh-wallet/core');
        sendJson(res, 200, { chains: listChains() });
      },
    },
  ];
}
