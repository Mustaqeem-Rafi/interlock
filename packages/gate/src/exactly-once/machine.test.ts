import { ABSORBING_STATES, IntentState } from '@interlock/core';
import { describe, expect, it } from 'vitest';
import {
  IllegalTransitionError,
  MACHINE_EVENTS,
  allEdges,
  assertMayIssueRailCall,
  canTransition,
  isAbsorbing,
  nextState,
} from './machine.js';

const STATES = IntentState.options;
const EDGES = allEdges(STATES);

describe('the one guarantee', () => {
  it('has exactly one edge whose target is IN_FLIGHT, and it leaves AUTHORIZED', () => {
    const intoRailCall = EDGES.filter((edge) => edge.to === 'IN_FLIGHT');
    expect(intoRailCall).toEqual([
      { from: 'AUTHORIZED', event: 'ATTEMPT_STARTED', to: 'IN_FLIGHT' },
    ]);
  });

  it('reaches AUTHORIZED after an attempt only from CONFIRMED_NOT_APPLIED or FAILED_TERMINAL', () => {
    const intoAuthorized = EDGES.filter((edge) => edge.to === 'AUTHORIZED');
    expect(new Set(intoAuthorized.map((edge) => edge.from))).toEqual(
      // PROPOSED and HELD are pre-attempt: no rail call has been made from
      // either. The post-attempt edges are the two states that carry positive
      // knowledge that nothing was applied.
      new Set(['PROPOSED', 'HELD', 'CONFIRMED_NOT_APPLIED', 'FAILED_TERMINAL']),
    );
  });

  it('never reaches AUTHORIZED from UNKNOWN, which is the double-refund edge', () => {
    for (const event of MACHINE_EVENTS) {
      if (canTransition('UNKNOWN', event)) {
        expect(nextState('UNKNOWN', event)).not.toBe('AUTHORIZED');
      }
    }
  });

  it('never reaches IN_FLIGHT from UNKNOWN or RECONCILING', () => {
    for (const from of ['UNKNOWN', 'RECONCILING'] as const) {
      for (const event of MACHINE_EVENTS) {
        if (canTransition(from, event)) {
          expect(nextState(from, event)).not.toBe('IN_FLIGHT');
        }
      }
    }
  });

  it('refuses to start a rail call from any state but AUTHORIZED', () => {
    expect(() => {
      assertMayIssueRailCall('AUTHORIZED');
    }).not.toThrow();
    for (const state of STATES.filter((s) => s !== 'AUTHORIZED')) {
      expect(() => {
        assertMayIssueRailCall(state);
      }).toThrow(/only be issued from AUTHORIZED/);
    }
  });
});

describe('the transition table', () => {
  it('covers all eleven states', () => {
    expect(STATES).toHaveLength(11);
    expect(STATES).toEqual([
      'PROPOSED',
      'HELD',
      'BLOCKED',
      'AUTHORIZED',
      'IN_FLIGHT',
      'APPLIED',
      'FAILED_TERMINAL',
      'UNKNOWN',
      'RECONCILING',
      'CONFIRMED_NOT_APPLIED',
      'QUARANTINED',
    ]);
  });

  it('reads exactly as documented', () => {
    const table = EDGES.map((e) => `${e.from} --${e.event}--> ${e.to}`).sort();
    expect(table).toEqual(
      [
        'AUTHORIZED --ATTEMPT_STARTED--> IN_FLIGHT',
        'AUTHORIZED --GATES_BLOCKED--> BLOCKED',
        'AUTHORIZED --QUARANTINE--> QUARANTINED',
        'CONFIRMED_NOT_APPLIED --QUARANTINE--> QUARANTINED',
        'CONFIRMED_NOT_APPLIED --REOPENED--> AUTHORIZED',
        'CONFIRMED_NOT_APPLIED --RETRY_AUTHORIZED--> AUTHORIZED',
        'FAILED_TERMINAL --QUARANTINE--> QUARANTINED',
        'FAILED_TERMINAL --REOPENED--> AUTHORIZED',
        'HELD --HOLD_REJECTED--> BLOCKED',
        'HELD --HOLD_RELEASED--> AUTHORIZED',
        'HELD --QUARANTINE--> QUARANTINED',
        'IN_FLIGHT --LEASE_EXPIRED--> UNKNOWN',
        'IN_FLIGHT --RAIL_AMBIGUOUS--> UNKNOWN',
        'IN_FLIGHT --RAIL_APPLIED--> APPLIED',
        'IN_FLIGHT --RAIL_REJECTED--> FAILED_TERMINAL',
        'PROPOSED --GATES_BLOCKED--> BLOCKED',
        'PROPOSED --GATES_HELD--> HELD',
        'PROPOSED --GATES_PASSED--> AUTHORIZED',
        'RECONCILING --QUARANTINE--> QUARANTINED',
        'RECONCILING --RECONCILE_CONFIRMED_ABSENT--> CONFIRMED_NOT_APPLIED',
        'RECONCILING --RECONCILE_FOUND_APPLIED--> APPLIED',
        'RECONCILING --RECONCILE_INCONCLUSIVE--> UNKNOWN',
        'UNKNOWN --QUARANTINE--> QUARANTINED',
        'UNKNOWN --RECONCILE_STARTED--> RECONCILING',
      ].sort(),
    );
  });

  it('throws IllegalTransitionError for anything not in the table', () => {
    expect(() => nextState('PROPOSED', 'RAIL_APPLIED')).toThrow(IllegalTransitionError);
    expect(() => nextState('UNKNOWN', 'RETRY_AUTHORIZED')).toThrow(IllegalTransitionError);
    expect(() => nextState('IN_FLIGHT', 'ATTEMPT_STARTED')).toThrow(IllegalTransitionError);
  });

  it('names the edge it refused', () => {
    try {
      nextState('UNKNOWN', 'ATTEMPT_STARTED');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(IllegalTransitionError);
      expect((error as IllegalTransitionError).from).toBe('UNKNOWN');
      expect((error as IllegalTransitionError).event).toBe('ATTEMPT_STARTED');
    }
  });

  it('lets nothing out of QUARANTINED without a human', () => {
    for (const event of MACHINE_EVENTS) {
      expect(canTransition('QUARANTINED', event)).toBe(false);
    }
  });

  it('reaches every state except PROPOSED from somewhere', () => {
    const reachable = new Set(EDGES.map((edge) => edge.to));
    for (const state of STATES.filter((s) => s !== 'PROPOSED')) {
      expect(reachable.has(state)).toBe(true);
    }
  });
});

describe('I4 in isolation', () => {
  it('lets nothing out of APPLIED or BLOCKED', () => {
    for (const state of ABSORBING_STATES) {
      expect(isAbsorbing(state)).toBe(true);
      for (const event of MACHINE_EVENTS) {
        expect(canTransition(state, event)).toBe(false);
        expect(() => nextState(state, event)).toThrow(/absorbing/);
      }
    }
  });

  it('marks only APPLIED and BLOCKED absorbing', () => {
    expect(STATES.filter(isAbsorbing)).toEqual(['BLOCKED', 'APPLIED']);
  });
});
