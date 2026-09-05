import type { Store } from '@interlock/store';
import { applyOperatorAction, OperatorActionError, type Operation } from './operations.js';
import * as view from './console-api.js';
import type { ConsoleContext } from './console-api.js';

/**
 * The routes the operator console calls, in the shapes it expects.
 *
 * Read handlers return a body. Write handlers return a body or throw an
 * OperatorActionError; nothing here decides anything on its own, and no route
 * can reach the rail. The most a write can do is move an intent along an edge
 * the state machine already permits.
 */

export interface RouteResult {
  readonly status: number;
  readonly body: unknown;
}

const ok = (body: unknown): RouteResult => ({ status: 200, body });

function heldItem(
  ctx: ConsoleContext,
  row: {
    sik: string;
    tool: string;
    amount_minor: number;
    state: string;
    first_seen_at: number;
    updated_at: number;
  },
): Record<string, unknown> {
  const decisions = ctx.store.decisions.forIntent(ctx.mandate.merchant_id, row.sik);
  const last = decisions[decisions.length - 1];
  const detail = last === undefined ? undefined : view.decision(ctx, last.request_id);
  const failing = (
    (detail?.gate_results ?? []) as { verdict: string; reasons: { code: string; message: string }[] }[]
  ).find((g) => g.verdict !== 'ALLOW');

  return {
    // The SIK is the id. A separate held_id would be a second name for one
    // thing, and the operator already sees the SIK everywhere else.
    held_id: row.sik,
    decision_id: last?.request_id ?? null,
    sik: row.sik,
    agent_id: last?.agent_id ?? ctx.mandate.agent_id,
    tool: row.tool,
    amount_minor: row.amount_minor,
    reason_code: failing?.reasons[0]?.code ?? 'HELD',
    reason: failing?.reasons[0]?.message ?? 'Held for a human decision.',
    evidence: (failing as { evidence?: unknown } | undefined)?.evidence ?? {},
    status: row.state === 'HELD' ? 'open' : row.state === 'BLOCKED' ? 'denied' : 'approved',
    created_at: row.first_seen_at,
    resolved_by: null,
    resolved_note: null,
    resolved_at: row.state === 'HELD' ? null : row.updated_at,
  };
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new OperatorActionError(422, 'VALIDATION_FAILED', `${field} is required`);
  }
  return value.trim();
}

export function handleRead(
  ctx: ConsoleContext,
  path: string,
  params: URLSearchParams,
  readiness: { ready: boolean; outstanding: number },
): RouteResult | undefined {
  if (path === '/api/health') return { status: readiness.ready ? 200 : 503, body: view.health(ctx, readiness) };
  if (path === '/api/summary') return ok(view.summary(ctx));
  if (path === '/api/agents') return ok(view.agents(ctx));
  if (path === '/api/mandates') return ok(view.mandates(ctx));
  if (path === '/api/audit/verify') return ok(view.auditVerify(ctx));

  if (path === '/api/findings') {
    const kind = params.get('kind');
    return ok({ items: view.listFindings(ctx, kind ?? undefined) });
  }

  if (path === '/api/decisions') {
    const num = (name: string): number | undefined => {
      const raw = params.get(name);
      return raw === null || !Number.isFinite(Number(raw)) ? undefined : Number(raw);
    };
    const str = (name: string): string | undefined => params.get(name) ?? undefined;
    return ok(
      view.decisions(ctx, {
        ...(str('verdict') === undefined ? {} : { verdict: str('verdict') as string }),
        ...(str('agent_id') === undefined ? {} : { agent_id: str('agent_id') as string }),
        ...(str('tool') === undefined ? {} : { tool: str('tool') as string }),
        ...(num('limit') === undefined ? {} : { limit: num('limit') as number }),
        ...(num('cursor') === undefined ? {} : { cursor: num('cursor') as number }),
      }),
    );
  }

  const decisionDetail = /^\/api\/decisions\/(.+)$/.exec(path);
  if (decisionDetail) {
    const found = view.decision(ctx, decodeURIComponent(decisionDetail[1] ?? ''));
    if (found === undefined) throw new OperatorActionError(404, 'NOT_FOUND', 'No such decision');
    return ok(found);
  }

  const intentDetail = /^\/api\/intents\/(.+)$/.exec(path);
  if (intentDetail) {
    const found = view.intent(ctx, decodeURIComponent(intentDetail[1] ?? ''));
    if (found === undefined) {
      // Precisely why, not just "not found". A request refused before Gate 4
      // never had a row inserted, and an operator hunting for one deserves to
      // know that rather than assume the ledger lost it.
      throw new OperatorActionError(
        404,
        'NOT_FOUND',
        'No intent record for this SIK. It was blocked before Gate 4, so no row was ever inserted.',
      );
    }
    return ok(found);
  }

  if (path === '/api/held') {
    const status = params.get('status') ?? 'open';
    const states = status === 'all' ? (['HELD', 'BLOCKED', 'AUTHORIZED'] as const) : (['HELD'] as const);
    return ok({
      items: ctx.store.intents
        .list({ states: [...states], limit: 200 })
        .map((row) => heldItem(ctx, row)),
    });
  }

  if (path === '/api/quarantine') {
    return ok({
      items: ctx.store.intents
        .list({ states: ['QUARANTINED'], limit: 200 })
        .map((row) => ({ ...heldItem(ctx, row), state: row.state })),
    });
  }

  return undefined;
}

export function handleWrite(
  store: Store,
  ctx: ConsoleContext,
  path: string,
  body: Record<string, unknown>,
  at: number,
): RouteResult | undefined {
  const heldAction = /^\/api\/held\/([^/]+)\/(approve|deny)$/.exec(path);
  if (heldAction) {
    const approver = requireString(body, 'approver');
    const note = typeof body['note'] === 'string' ? body['note'].trim() : '';
    const sik = decodeURIComponent(heldAction[1] ?? '');
    const operation = (heldAction[2] === 'approve' ? 'approve' : 'deny') as Operation;
    applyOperatorAction(store, {
      merchant_id: ctx.mandate.merchant_id,
      sik,
      operation,
      // The console's note is optional, but the audit record's reason is not.
      // An approval with no words at all still says who and which button.
      reason: note === '' ? `${operation}d from the console` : note,
      operator: approver,
      at,
    });
    const row = store.intents.require(ctx.mandate.merchant_id, sik);
    return ok({
      ...heldItem(ctx, row),
      resolved_by: approver,
      resolved_note: note === '' ? null : note,
      resolved_at: at,
    });
  }

  const quarantineAction = /^\/api\/quarantine\/([^/]+)\/resolve$/.exec(path);
  if (quarantineAction) {
    const resolution = requireString(body, 'resolution');
    if (resolution !== 'APPLIED' && resolution !== 'CONFIRMED_NOT_APPLIED') {
      throw new OperatorActionError(
        422,
        'VALIDATION_FAILED',
        'resolution must be APPLIED or CONFIRMED_NOT_APPLIED',
      );
    }
    const approver = requireString(body, 'approver');
    const evidence = typeof body['evidence_url'] === 'string' ? body['evidence_url'].trim() : '';
    const sik = decodeURIComponent(quarantineAction[1] ?? '');

    if (resolution === 'APPLIED' && evidence === '') {
      // Claiming money moved without saying where it moved to leaves the
      // ledger asserting a payment it cannot point at.
      throw new OperatorActionError(
        422,
        'VALIDATION_FAILED',
        'evidence_url is required when recording this as applied',
      );
    }

    applyOperatorAction(store, {
      merchant_id: ctx.mandate.merchant_id,
      sik,
      operation: resolution === 'APPLIED' ? 'confirm-applied' : 'confirm-not-applied',
      reason: evidence === '' ? 'resolved from the console' : `evidence: ${evidence}`,
      operator: approver,
      ...(resolution === 'APPLIED' ? { rail_entity_id: evidence } : {}),
      at,
    });
    const row = store.intents.require(ctx.mandate.merchant_id, sik);
    return ok({ ...heldItem(ctx, row), state: row.state, resolved_by: approver, updated_at: at });
  }

  return undefined;
}
