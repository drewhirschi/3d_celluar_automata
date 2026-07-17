export type Neighborhood = 'moore26' | 'vonNeumann6';

export interface AutomatonRule {
  readonly states: number;
  readonly survivalMask: number;
  readonly birthMask: number;
  readonly neighborhood: Neighborhood;
}

type Offset = readonly [x: number, y: number, z: number];

const VON_NEUMANN_6: readonly Offset[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

const MOORE_26: readonly Offset[] = (() => {
  const offsets: Offset[] = [];

  for (let z = -1; z <= 1; z += 1) {
    for (let y = -1; y <= 1; y += 1) {
      for (let x = -1; x <= 1; x += 1) {
        if (x !== 0 || y !== 0 || z !== 0) {
          offsets.push([x, y, z]);
        }
      }
    }
  }

  return offsets;
})();

function wrap(value: number, bounds: number): number {
  return (value + bounds) % bounds;
}

function matches(mask: number, neighborCount: number): boolean {
  return (mask & (1 << neighborCount)) !== 0;
}

function validate(current: Uint8Array, bounds: number, rule: AutomatonRule): void {
  if (!Number.isInteger(bounds) || bounds <= 0) {
    throw new RangeError('bounds must be a positive integer');
  }

  if (current.length !== bounds ** 3) {
    throw new RangeError('state length must equal bounds cubed');
  }

  if (!Number.isInteger(rule.states) || rule.states < 1 || rule.states > 255) {
    throw new RangeError('states must be an integer from 1 through 255');
  }

  const maxMask = 2 ** 27 - 1;
  if (
    !Number.isInteger(rule.survivalMask) ||
    rule.survivalMask < 0 ||
    rule.survivalMask > maxMask ||
    !Number.isInteger(rule.birthMask) ||
    rule.birthMask < 0 ||
    rule.birthMask > maxMask
  ) {
    throw new RangeError('rule masks may only contain neighbor counts 0 through 26');
  }
}

/**
 * Advances a cubic dense grid by one tick without mutating the input.
 *
 * Indexing matches the Rust simulation: x + y * bounds + z * bounds * bounds.
 * Only cells at `rule.states` count as alive neighbors; lower nonzero values are
 * decaying display states.
 */
export function stepReference(
  current: Uint8Array,
  bounds: number,
  rule: AutomatonRule,
): Uint8Array {
  validate(current, bounds, rule);

  const offsets = rule.neighborhood === 'moore26' ? MOORE_26 : VON_NEUMANN_6;
  const next = new Uint8Array(current.length);
  const plane = bounds * bounds;

  for (let z = 0; z < bounds; z += 1) {
    for (let y = 0; y < bounds; y += 1) {
      for (let x = 0; x < bounds; x += 1) {
        let neighbors = 0;

        for (const [dx, dy, dz] of offsets) {
          const nx = wrap(x + dx, bounds);
          const ny = wrap(y + dy, bounds);
          const nz = wrap(z + dz, bounds);
          const neighborIndex = nx + ny * bounds + nz * plane;
          neighbors += Number(current[neighborIndex] === rule.states);
        }

        const index = x + y * bounds + z * plane;
        const value = current[index]!;

        if (value === 0) {
          next[index] = matches(rule.birthMask, neighbors) ? rule.states : 0;
        } else if (value < rule.states || !matches(rule.survivalMask, neighbors)) {
          next[index] = value - 1;
        } else {
          next[index] = value;
        }
      }
    }
  }

  return next;
}

/** Counts every nonzero cell, including decaying cells that remain visible. */
export function activeCount(state: Uint8Array): number {
  let count = 0;

  for (const value of state) {
    count += Number(value !== 0);
  }

  return count;
}
