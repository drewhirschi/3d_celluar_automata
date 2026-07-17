import { describe, expect, it } from 'vitest';

import {
  activeCount,
  type AutomatonRule,
  type Neighborhood,
  stepReference,
} from './reference';

function indexOf(x: number, y: number, z: number, bounds: number): number {
  return x + y * bounds + z * bounds * bounds;
}

function mask(...counts: number[]): number {
  return counts.reduce((result, count) => result | (1 << count), 0);
}

function rule(
  neighborhood: Neighborhood,
  states: number,
  survival: number[] = [],
  birth: number[] = [],
): AutomatonRule {
  return {
    neighborhood,
    states,
    survivalMask: mask(...survival),
    birthMask: mask(...birth),
  };
}

describe('stepReference', () => {
  it('wraps Von Neumann neighbors across an axis boundary', () => {
    const bounds = 4;
    const current = new Uint8Array(bounds ** 3);
    current[indexOf(bounds - 1, 0, 0, bounds)] = 2;

    const next = stepReference(current, bounds, rule('vonNeumann6', 2, [], [1]));

    expect(next[indexOf(0, 0, 0, bounds)]).toBe(2);
  });

  it('includes wrapped diagonal cells only in the Moore neighborhood', () => {
    const bounds = 4;
    const current = new Uint8Array(bounds ** 3);
    current[indexOf(bounds - 1, bounds - 1, bounds - 1, bounds)] = 2;

    const moore = stepReference(current, bounds, rule('moore26', 2, [], [1]));
    const vonNeumann = stepReference(
      current,
      bounds,
      rule('vonNeumann6', 2, [], [1]),
    );

    expect(moore[indexOf(0, 0, 0, bounds)]).toBe(2);
    expect(vonNeumann[indexOf(0, 0, 0, bounds)]).toBe(0);
  });

  it('applies birth, survival, and irreversible decay states', () => {
    const bounds = 5;
    const states = 4;
    const current = new Uint8Array(bounds ** 3);
    const left = indexOf(1, 2, 2, bounds);
    const center = indexOf(2, 2, 2, bounds);
    const right = indexOf(3, 2, 2, bounds);
    const decaying = indexOf(0, 0, 0, bounds);
    current[left] = states;
    current[center] = states;
    current[decaying] = states - 1;

    const next = stepReference(
      current,
      bounds,
      rule('vonNeumann6', states, [1], [1]),
    );

    expect(next[left]).toBe(states);
    expect(next[center]).toBe(states);
    expect(next[right]).toBe(states);
    expect(next[decaying]).toBe(states - 2);
    expect(current[right]).toBe(0);
    expect(current[decaying]).toBe(states - 1);
  });

  it('matches a deterministic multi-tick fixture', () => {
    const bounds = 3;
    const states = 3;
    const persistentA = indexOf(0, 0, 0, bounds);
    const persistentB = indexOf(1, 0, 0, bounds);
    const isolated = indexOf(0, 2, 2, bounds);
    const initial = new Uint8Array(bounds ** 3);
    initial[persistentA] = states;
    initial[persistentB] = states;
    initial[isolated] = states;
    const fixtureRule = rule('vonNeumann6', states, [1]);

    const tick1 = stepReference(initial, bounds, fixtureRule);
    const tick2 = stepReference(tick1, bounds, fixtureRule);
    const tick3 = stepReference(tick2, bounds, fixtureRule);

    const expected1 = initial.slice();
    expected1[isolated] = 2;
    const expected2 = expected1.slice();
    expected2[isolated] = 1;
    const expected3 = expected2.slice();
    expected3[isolated] = 0;

    expect(tick1).toEqual(expected1);
    expect(tick2).toEqual(expected2);
    expect(tick3).toEqual(expected3);
    expect(activeCount(initial)).toBe(3);
    expect(activeCount(tick2)).toBe(3);
    expect(activeCount(tick3)).toBe(2);
  });
});
