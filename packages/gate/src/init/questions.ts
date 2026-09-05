/**
 * `interlock init` — the four questions, and the prompt they become.
 *
 * This file is the one place in Interlock where a model touches the money path,
 * and it touches it at AUTHORING time only. The model reads an operator's plain
 * English and drafts a mandate; a human reads that draft and approves it; from
 * then on nothing but deterministic code ever reads the file. The model is
 * upstream of the approval, never downstream of it, so it can propose a policy
 * and can never apply one.
 *
 * That asymmetry is the whole argument of the project, and it is why the prompt
 * below is allowed to be as persuadable as any prompt: the artefact it produces
 * is inert until a human signs it, and every number in it is then checked by a
 * gate that cannot be talked to.
 */

export interface InitAnswers {
  allowed: string;
  max_per_action: string;
  daily_cap: string;
  approver: string;
}

/**
 * Four questions, in the operator's language rather than ours.
 *
 * Nobody setting up a refund bot at 11pm knows what a "velocity window" or a
 * "reversibility class" is, and asking them to would produce a worse mandate,
 * not a better one. The jargon is the drafting step's job: these answers are
 * prose, and the model turns prose into the fields Gates 1, 2 and 3 read.
 */
export const QUESTIONS: readonly { key: keyof InitAnswers; prompt: string; help: string }[] = [
  {
    key: 'allowed',
    prompt: 'What should this agent be allowed to do?',
    help:
      'One sentence, in your own words. For example: "refund customers who were ' +
      'charged twice for the same order". Be specific about the job — anything the ' +
      'agent is not clearly allowed to do will be refused.',
  },
  {
    key: 'max_per_action',
    prompt: 'What is the most it should ever move in one action?',
    help:
      'A single amount, with the currency. For example "5,000 rupees". This is a hard ' +
      'ceiling: a request for one rupee more is blocked, not queued.',
  },
  {
    key: 'daily_cap',
    prompt: 'What is the daily cap across everything it does?',
    help:
      'The total it may move in any 24 hours, and optionally how many actions. For ' +
      'example "50,000 rupees and no more than 40 refunds". Reaching the cap stops the ' +
      'agent; it does not slow it down.',
  },
  {
    key: 'approver',
    prompt: 'Who approves exceptions?',
    help:
      'A name, a role or an email. Anything the agent may not do on its own is held for ' +
      'this person, so write down someone who will actually look.',
  },
];

/** Descriptions can run to hundreds of words; choosing scope needs the first few. */
const DESCRIPTION_BUDGET = 400;

function summarise(description: string): string {
  const flat = description.replace(/\s+/g, ' ').trim();
  return flat.length <= DESCRIPTION_BUDGET ? flat : `${flat.slice(0, DESCRIPTION_BUDGET)}...`;
}

function renderTools(tools: readonly { name: string; description?: string }[]): string {
  if (tools.length === 0) return '  (the upstream server advertised no tools)';
  return tools
    .map((tool) =>
      tool.description === undefined
        ? `  - ${tool.name}`
        : `  - ${tool.name}: ${summarise(tool.description)}`,
    )
    .join('\n');
}

/**
 * Build the message sent to the authoring model.
 *
 * The tool descriptions below are the upstream server's own words, and a
 * hostile server could write them to argue for a wider grant than the operator
 * asked for. That is not defended against here and does not need to be: the
 * draft is printed for a human before anything is written, irreversible grants
 * come back as warnings, and the manifest pin is computed by us from the bytes
 * we actually fetched rather than taken from anything the model says. A
 * description that talks this prompt into granting create_instant_settlement
 * still has to get past the person reading the draft.
 *
 * `issued_at` is fixed here rather than left to the model. A model has no clock,
 * and an invented timestamp is either a mandate that is not yet valid or one
 * that has already expired — both of which Gate 1 refuses, at runtime, long
 * after anyone is watching.
 */
export function buildAuthoringPrompt(input: {
  answers: InitAnswers;
  tools: readonly { name: string; description?: string }[];
  merchantId: string;
  agentId: string;
  upstream: string;
}): string {
  const now = Date.now();

  return `You are drafting an Interlock mandate: the machine-checkable policy file that decides,
without any further help from a model, which of an AI agent's payment calls may reach the
payment rail. A human operator is about to read your draft line by line and either approve it
or throw it away. Nothing you write takes effect until they approve it, and once they do, only
deterministic code reads it — you will not be consulted again at decision time.

Draft the narrowest mandate that still lets the agent do the job the operator described. Every
grant you add is standing authority to move money. Every one you leave out is a call the agent
must ask a human for, which is the right outcome whenever you are unsure.

THE OPERATOR'S ANSWERS, VERBATIM
  What should this agent be allowed to do?
    ${input.answers.allowed}
  What is the most it should ever move in one action?
    ${input.answers.max_per_action}
  What is the daily cap across everything it does?
    ${input.answers.daily_cap}
  Who approves exceptions?
    ${input.answers.approver}

FACTS YOU MUST USE EXACTLY AS GIVEN
  merchant_id : ${input.merchantId}
  agent_id    : ${input.agentId}
  upstream    : ${input.upstream}
  issued_at   : ${String(now)}   (epoch milliseconds; use this number, do not invent one)

TOOLS THE UPSTREAM SERVER ADVERTISES
${renderTools(input.tools)}

Grant only tools from that list, and only the ones the operator's answer actually requires. A
tool you grant that is not on that list is reported to the operator as a defect in your draft.

MONEY IS ALWAYS AN INTEGER IN MINOR UNITS
Every *_minor field is a whole number of the smallest unit of the currency: paise for INR,
cents for USD. 5,000 rupees is 500000. Never write a decimal point, a currency symbol, or a
string. If the operator named no currency, use INR at 100 minor units per rupee. Restate the
amounts in plain language inside 'purpose' so the human checking your draft can verify the
conversion without doing arithmetic.

THE SCHEMA. Every object is strict: an unknown key is a hard failure, not a warning.

  v            the literal 1
  mandate_id   short non-empty slug naming this mandate
  merchant_id  exactly the merchant_id above
  agent_id     exactly the agent_id above
  issued_at    exactly the issued_at above
  expires_at   epoch ms, strictly greater than issued_at. Prefer 30 days out. Anything more
               than 90 days out is flagged to the operator.
  purpose      one or two sentences of plain English: the job, the ceilings, the approver
  scope.grants map of tool name -> grant. Tool names are snake_case. A tool absent from this
               map is out of scope, and the agent is never even shown it.
    <tool>.reversibility  "reversible" | "compensable" | "irreversible".
                          A refund and an instant settlement are irreversible: the money is
                          gone and no call brings it back.
    <tool>.value.max_amount_minor  integer >= 0, the per-action ceiling from answer 2
    <tool>.value.min_amount_minor  integer >= 0, normally 0
    <tool>.value.currencies        non-empty list of ISO 4217 codes, e.g. [INR]
    <tool>.on_unresolvable  optional "HOLD" | "BLOCK": what to do when the gate cannot read
                          the underlying payment off the rail to check the limit against.
                          Omit it to get BLOCK for irreversible and compensable tools and
                          HOLD for reversible ones. There is deliberately no ALLOW — failing
                          to check a limit is never grounds for waiving it.
  limits.windows      list of velocity windows. Answer 3 is a window: window_ms 86400000, a
                      max_calls integer > 0, a max_amount_minor, and a currency. Emit at
                      least one, because with none there is no cap at all.
  limits.fee_budgets  map of currency -> { window_ms, max_fee_minor }: a ceiling on the fees
                      the rail actually charges. Include one only if the operator's answers
                      imply it. Never guess a fee rate; the real one is read back from the
                      rail response.
  idempotency         map of tool name -> { key_fields: [string], window_ms: integer|null }.
                      EVERY granted tool needs an entry or the mandate is invalid.
                      window_ms is the span within which a repeat of the same request means
                      the same action. null means a repeat is never legitimate, however much
                      time passes. create_refund MUST be null: two refunds of the same amount
                      on the same payment are indistinguishable by meaning, so refusing the
                      second is the correct behaviour.
                      key_fields are extra argument names that make two otherwise identical
                      calls genuinely different requests; [] is the normal answer.
  provenance.server_id         short identifier for the upstream server, e.g. razorpay-mcp
  provenance.pinned_manifests  map of tool name -> { sha256, trust_tier }. EVERY granted tool
                      needs an entry. You cannot compute a hash, so write the 64-character
                      placeholder of all zeros, QUOTED so YAML keeps it a string rather than
                      reading it as the number 0, and trust_tier "pinned". Interlock
                      overwrites it from the manifest it actually fetched: the pin is never
                      yours to choose.
                      Do NOT emit provenance.manifest_sha256 or provenance.pinned_manifest.
                      Those are filled in from the bytes we fetched.
  degraded_mode       { reversible, compensable, irreversible }, each "hold" or "block": what
                      to do when a check could not be completed at all. There is no "allow",
                      because losing a guarantee must never be what opens the path.

SHAPE EXAMPLE — copy the structure, not the values.

v: 1
mandate_id: mdt_support_refunds
merchant_id: acc_example
agent_id: support-bot
issued_at: 1757000000000
expires_at: 1759592000000
purpose: >-
  Refund duplicate charges reported by customers. At most 5,000 rupees per refund and
  50,000 rupees per day. Exceptions go to the head of support.
scope:
  grants:
    create_refund:
      reversibility: irreversible
      value:
        max_amount_minor: 500000
        min_amount_minor: 0
        currencies: [INR]
      on_unresolvable: BLOCK
limits:
  windows:
    - window_ms: 86400000
      max_calls: 40
      max_amount_minor: 5000000
      currency: INR
  fee_budgets: {}
idempotency:
  create_refund:
    key_fields: []
    window_ms: null
provenance:
  server_id: razorpay-mcp
  pinned_manifests:
    create_refund:
      sha256: '0000000000000000000000000000000000000000000000000000000000000000'
      trust_tier: pinned
degraded_mode:
  reversible: hold
  compensable: block
  irreversible: block

OUTPUT
Reply with the YAML document and nothing else. No prose before it, no explanation after it,
no code fence, no comments. The next thing that happens to your reply is a schema parse.`;
}
