import type { UpstreamTool } from './upstream.js';

/**
 * The tool surface presented when there is no upstream server to ask.
 *
 * This lives apart from both binaries on purpose. `interlock init` needs a
 * manifest to author against, and it is the one command that talks to a model;
 * if it reached for this constant through the proxy binary, the authoring
 * bundle would physically contain the exactly-once engine and the gate ladder.
 * The claim that no code path runs from a decision to a model is worth being
 * able to check by reading an import graph, so nothing shared between the two
 * is allowed to sit on the money path.
 */
export const MOCK_MANIFEST: readonly UpstreamTool[] = [
  {
    name: 'fetch_payment',
    description: 'Fetch a payment by id.',
    inputSchema: { type: 'object', properties: { payment_id: { type: 'string' } } },
  },
  {
    name: 'fetch_order',
    description: 'Fetch an order by id.',
    inputSchema: { type: 'object', properties: { order_id: { type: 'string' } } },
  },
  {
    name: 'create_refund',
    description: 'Refund a payment. amount is in minor units (paise).',
    inputSchema: {
      type: 'object',
      properties: { payment_id: { type: 'string' }, amount: { type: 'integer' } },
      required: ['payment_id', 'amount'],
    },
  },
  {
    name: 'create_instant_settlement',
    description: 'Settle available balance on demand. amount is in minor units.',
    inputSchema: {
      type: 'object',
      properties: { amount: { type: 'integer' } },
      required: ['amount'],
    },
  },
];
