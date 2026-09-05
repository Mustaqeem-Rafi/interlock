import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { IntentState } from '@interlock/core';
import type { Store } from '@interlock/store';

import { createAuthoriser, type Authoriser } from './auth.js';
import { applyOperatorAction, OperatorActionError, type Operation } from './operations.js';
import { streamAuditLog } from './stream.js';
import { listDecisions, listIntents, summarise, NEEDS_A_HUMAN } from './views.js';

/**
 * The operator console's HTTP surface. Node's own http, no framework.
 *
 * Read endpoints answer from the ledger. Write endpoints do exactly one thing:
 * move an intent through an edge the state machine already allows. Nothing
 * here calls the rail, so nothing here can move money.
 */

export interface ConsoleOptions {
  readonly store: Store;
  /**
   * How this process answers "may I serve?".
   *
   * Injected rather than assumed, because the two callers know different
   * things. Beside the engine it is recovery.readiness(); in the standalone
   * console it is derived from the ledger, since a reader that never runs
   * recovery would otherwise report "still scanning" for the rest of its life.
   */
  readonly readiness: () => { ready: boolean; phase: string; outstanding: number; status: number };
  readonly token: string;
  readonly merchantId: string;
  readonly now?: () => number;
}

/**
 * Where console.html is, from wherever this module ended up.
 *
 * Running from source the module is dist/api/server.js, two levels under the
 * package root. In the published bundle everything is flattened into
 * dist/interlock-console.js, one level under it. Rather than encode a depth
 * that is right in one layout and silently wrong in the other, try both and
 * fail loudly if neither is there.
 */
function findConsoleHtml(): string | undefined {
  for (const candidate of ['../../console.html', '../console.html']) {
    const path = fileURLToPath(new URL(candidate, import.meta.url));
    if (existsSync(path)) return path;
  }
  return undefined;
}

const OPERATIONS: Readonly<Record<string, Operation>> = {
  approve: 'approve',
  deny: 'deny',
  'confirm-applied': 'confirm-applied',
  'confirm-not-applied': 'confirm-not-applied',
};

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    // The console holds a bearer token and shows money. Nothing here should be
    // cached by anything, ever.
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // An operator action is a few hundred bytes. Anything larger is either a
    // mistake or an attempt to exhaust memory on a box that holds a ledger.
    if (size > 64 * 1024) throw new OperatorActionError(413, 'BODY_TOO_LARGE', 'body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new OperatorActionError(400, 'BAD_BODY', 'body must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof OperatorActionError) throw error;
    throw new OperatorActionError(400, 'BAD_JSON', 'body is not valid JSON');
  }
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

function handleRead(
  path: string,
  url: URL,
  options: ConsoleOptions,
  now: number,
  res: ServerResponse,
): boolean {
  if (path === '/api/summary') {
    send(res, 200, summarise(options.store, options.merchantId, now));
    return true;
  }
  if (path === '/api/intents') {
    const states = url.searchParams.getAll('state') as IntentState[];
    send(res, 200, {
      intents: listIntents(options.store, {
        ...(states.length > 0 ? { states } : {}),
        limit: Number(url.searchParams.get('limit') ?? 100),
      }),
    });
    return true;
  }
  // The two queues Block 12 names. Same data as /api/intents?state=, given the
  // names the console is written against so a route rename cannot silently
  // empty a queue that a person is supposed to be working through.
  if (path === '/api/held') {
    send(res, 200, { intents: listIntents(options.store, { states: ['HELD'], limit: 200 }) });
    return true;
  }
  if (path === '/api/quarantine') {
    send(res, 200, { intents: listIntents(options.store, { states: ['QUARANTINED'], limit: 200 }) });
    return true;
  }
  if (path === '/api/attention') {
    // One call for the only screen that matters during an incident.
    send(res, 200, { intents: listIntents(options.store, { states: NEEDS_A_HUMAN, limit: 200 }) });
    return true;
  }
  if (path === '/api/decisions') {
    const verdict = url.searchParams.get('verdict');
    const before = url.searchParams.get('before');
    send(res, 200, {
      decisions: listDecisions(options.store, {
        ...(verdict === null ? {} : { verdict }),
        ...(before === null ? {} : { before: Number(before) }),
        limit: Number(url.searchParams.get('limit') ?? 50),
      }),
    });
    return true;
  }
  if (path === '/api/audit') {
    const from = Number(url.searchParams.get('from') ?? 0);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 100), 1), 500);
    send(res, 200, {
      records: options.store.audit.read(from, limit),
      count: options.store.audit.count(),
      // Cheap to ask, and the only honest way to present an audit log: say
      // whether the chain still verifies rather than implying it.
      first_broken_seq: options.store.audit.verifyChain(),
    });
    return true;
  }
  return false;
}

export function createConsoleApp(options: ConsoleOptions): Server {
  const authorised: Authoriser = createAuthoriser(options.token);
  const now = options.now ?? Date.now;

  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://console.invalid');
      const path = url.pathname.replace(/\/+$/, '') || '/';

      try {
        /**
         * Health is deliberately unauthenticated and deliberately 503 while
         * recovery is still running. A load balancer has no bearer token, and
         * a process that has not finished settling intents left by a killed
         * predecessor must not be sent traffic — it would decide against a
         * ledger that is still incomplete.
         */
        if (path === '/health') {
          const readiness = options.readiness();
          send(res, readiness.status, {
            status: readiness.ready ? 'ready' : 'recovering',
            phase: readiness.phase,
            outstanding: readiness.outstanding,
          });
          return;
        }

        if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
          const html = findConsoleHtml();
          if (html === undefined) {
            send(res, 500, { error: { code: 'NO_CONSOLE', message: 'console.html is missing' } });
            return;
          }
          const body = readFileSync(html);
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'content-length': body.length,
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
            // The page talks only to its own origin and loads fonts. Nothing
            // it renders comes from the agent, but the ledger does hold
            // attacker-influenced strings, so the policy is stated rather than
            // assumed.
            'content-security-policy':
              "default-src 'none'; connect-src 'self'; img-src 'self' data:; " +
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
              "font-src https://fonts.gstatic.com; script-src 'unsafe-inline'; base-uri 'none'",
          });
          res.end(body);
          return;
        }

        /**
         * EventSource cannot set an Authorization header, so the stream route
         * also accepts the same token as a query parameter. It is the same
         * shared secret, not a weaker one — but query strings reach access
         * logs, so this is confined to the one route that needs it.
         */
        const streaming = req.method === 'GET' && path === '/api/stream';
        const queryToken = streaming ? url.searchParams.get('token') : null;
        if (
          !authorised(req.headers.authorization) &&
          !(queryToken !== null && authorised(`Bearer ${queryToken}`))
        ) {
          res.setHeader('www-authenticate', 'Bearer realm="interlock"');
          send(res, 401, { error: { code: 'UNAUTHORISED', message: 'bearer token required' } });
          return;
        }

        if (req.method === 'GET' && path === '/api/stream') {
          const last = Number(req.headers['last-event-id'] ?? url.searchParams.get('from') ?? NaN);
          streamAuditLog(res, {
            store: options.store,
            // Resuming from Last-Event-ID is what makes a dropped connection
            // invisible: the browser reconnects and asks for what it missed.
            ...(Number.isSafeInteger(last) ? { fromSeq: last } : {}),
          });
          return;
        }

        if (req.method === 'GET' && handleRead(path, url, options, now(), res)) return;

        const action = /^\/api\/intents\/([A-Z2-7]{1,64})\/(.+)$/.exec(path);
        if (req.method === 'POST' && action) {
          const [, sik, verb] = action;
          const operation = OPERATIONS[verb ?? ''];
          if (operation === undefined) {
            send(res, 404, { error: { code: 'NO_SUCH_OPERATION', message: `unknown: ${verb}` } });
            return;
          }
          const body = await readJson(req);
          const result = applyOperatorAction(options.store, {
            merchant_id: options.merchantId,
            sik: sik ?? '',
            operation,
            reason: str(body['reason']),
            operator: str(body['operator']) || 'console',
            rail_entity_id:
              typeof body['rail_entity_id'] === 'string' ? body['rail_entity_id'] : undefined,
            at: now(),
          });
          send(res, 200, result);
          return;
        }

        send(res, 404, { error: { code: 'NOT_FOUND', message: `no route for ${path}` } });
      } catch (error) {
        if (error instanceof OperatorActionError) {
          send(res, error.status, { error: { code: error.code, message: error.message } });
          return;
        }
        // Never echo an internal message to a caller holding only a shared
        // token; the detail goes to stderr where the operator can read it.
        process.stderr.write(
          `console: ${path} failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
        );
        send(res, 500, { error: { code: 'INTERNAL', message: 'request failed' } });
      }
    })();
  });
}
