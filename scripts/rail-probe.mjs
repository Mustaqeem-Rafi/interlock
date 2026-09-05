#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Ask Razorpay the questions the reconciler's design already assumes answers to.
 *
 *   node --env-file=.env scripts/rail-probe.mjs
 *
 * Four of them, and the second is the one that matters:
 *
 *   1. Does a refund echo back the receipt we stamped on it?
 *      Reconciliation matches on that stamp. If it is not returned, matching
 *      has to fall back to notes, and if neither survives there is no way to
 *      tell our refund from someone else's of the same amount.
 *
 *   2. What happens when the same receipt is used twice on one payment?
 *      The whole design rests on this. RailDuplicateReceiptError exists
 *      because we believe Razorpay refuses it. If instead it cheerfully
 *      creates a second refund, the receipt is not an idempotency key, the
 *      README says something untrue, and the engine's belt-and-braces layer is
 *      only braces.
 *
 *   3. How soon does a refund read back on the listing endpoint?
 *      RECONCILE_MIN_DELAY_MS is 2000 because we assume the rail is not
 *      read-your-writes. This measures it instead of assuming.
 *
 *   4. Does the listing paginate the way the adapter expects?
 *
 * Test mode only. It refuses to run against a key that is not rzp_test_,
 * because every question above is answered by creating real refunds.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'docs', 'rail-notes.md');

const keyId = process.env.RAZORPAY_KEY_ID ?? '';
const keySecret = process.env.RAZORPAY_KEY_SECRET ?? '';

if (keyId === '' || keySecret === '') {
  console.error('RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are required.');
  console.error('Run: node --env-file=.env scripts/rail-probe.mjs');
  process.exit(2);
}
if (!keyId.startsWith('rzp_test_')) {
  console.error(`RAZORPAY_KEY_ID is ${keyId.slice(0, 12)}…, which is not a test key.`);
  console.error('This probe creates refunds. It will not run against anything else.');
  process.exit(2);
}

const auth = 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64');
const BASE = 'https://api.razorpay.com/v1';

async function api(method, path, body) {
  const started = Date.now();
  const res = await fetch(BASE + path, {
    method,
    headers: {
      authorization: auth,
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* left null on purpose: the raw text is reported below */
  }
  return { status: res.status, ok: res.ok, body: json, raw: text, ms: Date.now() - started };
}

const findings = [];
const note = (question, answer, detail) => {
  findings.push({ question, answer, detail });
  console.log(`\n${question}\n  -> ${answer}`);
  if (detail) console.log(`     ${detail}`);
};

/**
 * A payment to refund.
 *
 * Test mode will not let an API call capture a payment — that needs the
 * checkout flow — so this cannot mint one unaided. The operator passes the id
 * of a captured test payment with --payment, which is the honest constraint
 * rather than a workaround.
 */
const paymentId = process.argv.includes('--payment')
  ? process.argv[process.argv.indexOf('--payment') + 1]
  : '';

if (!paymentId) {
  console.error('Pass a captured test-mode payment with --payment pay_XXXXXXXX.');
  console.error('Razorpay test mode cannot capture a payment from the API alone;');
  console.error('make one in the dashboard, then hand its id to this probe.');
  process.exit(2);
}

const payment = await api('GET', `/payments/${paymentId}`);
if (!payment.ok) {
  console.error(`Could not read ${paymentId}: ${payment.status} ${payment.raw}`);
  process.exit(1);
}
const refundable = payment.body.amount - (payment.body.amount_refunded ?? 0);
console.log(
  `payment ${paymentId}: ${payment.body.status}, ` +
    `${refundable} minor units refundable of ${payment.body.amount}`,
);
if (refundable < 200) {
  console.error('Not enough left on this payment to run the probe. Use another.');
  process.exit(1);
}

const stamp = `ilk_probe_${Date.now().toString(36)}`;
const amount = 100;

// ---------------------------------------------------------------------------
// 1 + 2. The stamp, and the same stamp twice.
// ---------------------------------------------------------------------------
const first = await api('POST', `/payments/${paymentId}/refund`, {
  amount,
  speed: 'normal',
  receipt: stamp,
  notes: { interlock_sik: stamp },
});

if (!first.ok) {
  console.error(`The first refund failed: ${first.status} ${first.raw}`);
  process.exit(1);
}

note(
  'Does a refund echo back the receipt we stamped on it?',
  first.body.receipt === stamp ? 'Yes' : 'NO — reconciliation cannot match on receipt',
  `receipt=${JSON.stringify(first.body.receipt)} notes=${JSON.stringify(first.body.notes)}`,
);

const second = await api('POST', `/payments/${paymentId}/refund`, {
  amount,
  speed: 'normal',
  receipt: stamp,
  notes: { interlock_sik: stamp },
});

if (second.ok) {
  note(
    'What happens when the same receipt is used twice on one payment?',
    `A SECOND REFUND WAS CREATED (${second.body.id})`,
    'The receipt is NOT a per-payment idempotency key. Every claim that says ' +
      'otherwise is wrong, and the ledger is the only thing preventing a double refund.',
  );
} else {
  note(
    'What happens when the same receipt is used twice on one payment?',
    `Refused with ${second.status}`,
    `${second.body?.error?.code ?? ''} ${second.body?.error?.description ?? second.raw}`,
  );
}

// ---------------------------------------------------------------------------
// 3. Read-your-writes.
// ---------------------------------------------------------------------------
const findFirst = async () => {
  const page = await api('GET', `/payments/${paymentId}/refunds?count=100`);
  return page.ok && (page.body.items ?? []).some((r) => r.id === first.body.id);
};

let visibleAfterMs = null;
const startedLooking = Date.now();
for (const waitMs of [0, 250, 500, 1000, 2000, 4000]) {
  if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
  if (await findFirst()) {
    visibleAfterMs = Date.now() - startedLooking;
    break;
  }
}
note(
  'How soon does a refund read back on the listing endpoint?',
  visibleAfterMs === null ? 'Still absent after ~7.75s' : `Visible after ~${visibleAfterMs}ms`,
  'RECONCILE_MIN_DELAY_MS is 2000. If this is ever larger, that constant is wrong.',
);

// ---------------------------------------------------------------------------
// 4. Pagination.
// ---------------------------------------------------------------------------
const page1 = await api('GET', `/payments/${paymentId}/refunds?count=1&skip=0`);
const page2 = await api('GET', `/payments/${paymentId}/refunds?count=1&skip=1`);
note(
  'Does the listing paginate with count/skip as the adapter assumes?',
  page1.ok && page2.ok && page1.body.items?.[0]?.id !== page2.body.items?.[0]?.id
    ? 'Yes — skip moves the window'
    : 'Unclear; see detail',
  `count=${page1.body?.count ?? '?'} page1=${page1.body?.items?.[0]?.id ?? 'none'} ` +
    `page2=${page2.body?.items?.[0]?.id ?? 'none'}`,
);

// ---------------------------------------------------------------------------
const when = new Date().toISOString();
const md = `# Rail notes — what Razorpay actually does

Written by \`scripts/rail-probe.mjs\` against **test mode**. Every line below is
a recorded response, not a reading of the documentation.

Probed ${when} · payment \`${paymentId}\` · key \`${keyId.slice(0, 12)}…\`

${findings
  .map(
    (f) =>
      `## ${f.question}\n\n**${f.answer}**\n\n${f.detail ? `\`\`\`\n${f.detail}\n\`\`\`\n` : ''}`,
  )
  .join('\n')}
## Why this file exists

The reconciler's design rests on three claims about this rail: that a receipt
is a per-payment idempotency key, that a refund does not read back immediately,
and that the listing paginates to exhaustion. All three were taken from the
documentation and none had been tested. A design that depends on someone else's
behaviour should say where it checked.

Re-run with:

\`\`\`
node --env-file=.env scripts/rail-probe.mjs --payment pay_XXXXXXXX
\`\`\`
`;

writeFileSync(OUT, md);
console.log(`\nwrote ${OUT}`);
