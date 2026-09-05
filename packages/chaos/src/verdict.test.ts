import { describe, expect, it } from 'vitest';
import { KILL_POINTS } from '@interlock/gate';
import { EXPECTATION, GUARANTEE, judge, type TrialObservation } from './verdict.js';
import { renderResults, totalViolations, type MatrixResults } from './results.js';

const BASE: TrialObservation = {
  killPoint: 'after_call_before_commit',
  profile: 'none',
  phase: 'recover',
  trial: 1,
  sik: 'A'.repeat(32),
  railEntities: ['rfnd_MOCK0000000001'],
  state: 'APPLIED',
  recordedEntityId: 'rfnd_MOCK0000000001',
  recovered: 1,
  ready: true,
  killed: true,
  killExpected: true,
  disposition: null,
};

const kinds = (observation: TrialObservation): string[] =>
  judge(observation).map((violation) => violation.kind);

describe('the guarantee is "never two, and never unknown"', () => {
  it('passes one refund with an APPLIED intent', () => {
    expect(judge(BASE)).toEqual([]);
  });

  it('passes zero refunds with CONFIRMED_NOT_APPLIED — not "always one"', () => {
    expect(
      judge({
        ...BASE,
        killPoint: 'after_wal_before_call',
        railEntities: [],
        state: 'CONFIRMED_NOT_APPLIED',
        recordedEntityId: null,
      }),
    ).toEqual([]);
  });

  it('passes zero refunds with nothing attempted', () => {
    expect(
      judge({
        ...BASE,
        killPoint: 'before_wal',
        railEntities: [],
        state: 'AUTHORIZED',
        recordedEntityId: null,
      }),
    ).toEqual([]);
  });

  it('catches two rail entities for one sik', () => {
    const violations = judge({
      ...BASE,
      railEntities: ['rfnd_MOCK0000000001', 'rfnd_MOCK0000000002'],
    });
    expect(violations.map((v) => v.kind)).toEqual(['DOUBLE_APPLIED']);
    expect(violations[0]?.message).toContain(GUARANTEE);
    expect(violations[0]?.message).toContain('not "always one"');
    expect(violations[0]?.message).toContain('rfnd_MOCK0000000002');
  });

  it('catches an intent still unresolved after recovery', () => {
    for (const state of ['IN_FLIGHT', 'UNKNOWN', 'RECONCILING'] as const) {
      expect(kinds({ ...BASE, railEntities: [], state, recordedEntityId: null })).toContain(
        'UNRESOLVED_AFTER_RECOVERY',
      );
    }
  });

  it('catches money that moved without the ledger saying so', () => {
    expect(kinds({ ...BASE, state: 'CONFIRMED_NOT_APPLIED' })).toContain('SILENT_LOSS');
    expect(kinds({ ...BASE, state: null })).toContain('SILENT_LOSS');
    // QUARANTINED is escalated, not silent: a human has been asked.
    expect(kinds({ ...BASE, state: 'QUARANTINED', recordedEntityId: null })).toEqual([]);
  });

  it('catches a ledger claiming money moved when it did not', () => {
    expect(
      kinds({ ...BASE, railEntities: [], state: 'APPLIED', recordedEntityId: null }),
    ).toEqual(['PHANTOM_SUCCESS']);
  });

  it('catches a trial where the kill never landed', () => {
    // Without this the two late kill points would be indistinguishable from an
    // unkilled run, and a disarmed matrix would report green.
    const violations = judge({ ...BASE, killed: false });
    expect(violations.map((v) => v.kind)).toEqual(['KILL_DID_NOT_FIRE']);
    expect(violations[0]?.message).toContain('proves nothing');
  });

  it('catches a ledger pointing at somebody else s refund', () => {
    const violations = judge({ ...BASE, recordedEntityId: 'rfnd_MOCK0000000099' });
    expect(violations.map((v) => v.kind)).toEqual(['WRONG_ENTITY_RECORDED']);
    expect(violations[0]?.message).toContain('without checking the stamp');
  });

  it('catches a retry that cannot make progress', () => {
    const violations = judge({
      ...BASE,
      phase: 'retry',
      railEntities: [],
      state: 'AUTHORIZED',
      recordedEntityId: null,
      disposition: 'HOLD',
    });
    expect(violations.map((v) => v.kind)).toEqual(['STUCK_NO_PROGRESS']);
  });

  it('does not require a kill the fault preempted', () => {
    expect(judge({ ...BASE, killed: false, killExpected: false })).toEqual([]);
    expect(kinds({ ...BASE, killed: false, killExpected: true })).toContain('KILL_DID_NOT_FIRE');
  });

  it('names every kill point in the expectations table', () => {
    expect(Object.keys(EXPECTATION).sort()).toEqual([...KILL_POINTS].sort());
  });
});

describe('RESULTS.md', () => {
  const results: MatrixResults = {
    startedAt: '2025-09-05T12:00:00.000Z',
    durationMs: 42_000,
    trialsPerPoint: 20,
    summaries: KILL_POINTS.map((killPoint) => ({
      killPoint,
      profile: 'none',
      trials: 20,
      counts: killPoint.startsWith('after_call') || killPoint.startsWith('after_commit')
        ? { 1: 20 }
        : { 0: 20 },
      states: { APPLIED: 20 },
      retryCounts: { 1: 20 },
      retryStates: { APPLIED: 20 },
      killedAsExpected: 20,
      preempted: 0,
      escalated: 0,
      violations: [],
    })),
  };

  it('renders a table with one row per kill point and a zero-violation total', () => {
    const markdown = renderResults(results);
    expect(totalViolations(results)).toBe(0);
    expect(markdown).toContain('| Kill point | Fault | Trials | Expected after recovery |');
    for (const killPoint of KILL_POINTS) {
      expect(markdown).toContain(`| \`${killPoint}\` | none | 20 |`);
    }
    expect(markdown).toContain('**Exactly-once violations: 0**');
    expect(markdown).toContain('| **Total** | | **100** | | | | **0** |');
    expect(markdown).toContain('100 of 100 issuing processes were confirmed killed');
  });

  it('states the guarantee, and that it is not "always one"', () => {
    const markdown = renderResults(results);
    expect(markdown).toContain(GUARANTEE);
    expect(markdown).toContain('Not "always one"');
  });

  it('lists violations when there are any', () => {
    const broken: MatrixResults = {
      ...results,
      summaries: [
        {
          ...results.summaries[0]!,
          violations: [{ kind: 'DOUBLE_APPLIED', message: 'two entities for one sik' }],
        },
        ...results.summaries.slice(1),
      ],
    };
    const markdown = renderResults(broken);
    expect(totalViolations(broken)).toBe(1);
    expect(markdown).toContain('**Exactly-once violations: 1**');
    expect(markdown).toContain('- **DOUBLE_APPLIED** — two entities for one sik');
  });
});
