import type { AutomatonRule, Neighborhood } from './sim/reference';

export type ColorMode = 'distance' | 'state';

export interface RulePreset extends AutomatonRule {
  id: string;
  name: string;
  survival: readonly number[];
  birth: readonly number[];
  colorMode: ColorMode;
  colorLow: string;
  colorHigh: string;
}

export function maskFromCounts(counts: readonly number[]): number {
  let mask = 0;

  for (const count of counts) {
    if (!Number.isInteger(count) || count < 0 || count > 26) {
      throw new RangeError(`Neighbour count must be an integer from 0 to 26: ${count}`);
    }
    mask = (mask | (1 << count)) >>> 0;
  }

  return mask;
}

export function parseCounts(value: string): number[] | null {
  if (value.trim() === '') {
    return [];
  }

  const counts = value
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number);

  if (counts.some((count) => !Number.isInteger(count) || count < 0 || count > 26)) {
    return null;
  }

  return [...new Set(counts)].sort((a, b) => a - b);
}

export function formatCounts(counts: readonly number[]): string {
  return counts.join(', ');
}

function preset(
  id: string,
  name: string,
  survival: readonly number[],
  birth: readonly number[],
  states: number,
  neighborhood: Neighborhood,
  colorMode: ColorMode,
  colorLow: string,
  colorHigh: string,
): RulePreset {
  return {
    id,
    name,
    survival,
    birth,
    survivalMask: maskFromCounts(survival),
    birthMask: maskFromCounts(birth),
    states,
    neighborhood,
    colorMode,
    colorLow,
    colorHigh,
  };
}

const range = (start: number, end: number): number[] =>
  Array.from({ length: end - start + 1 }, (_, index) => start + index);

export const RULE_PRESETS: readonly RulePreset[] = [
  preset('builder', 'Builder', [2, 6, 9], [4, 6, 8, 9, 10], 10, 'moore26', 'distance', '#ffff00', '#ff0000'),
  preset('vn-pyramid', 'VN Pyramid', range(0, 6), [1, 3], 2, 'vonNeumann6', 'distance', '#00ff00', '#0000ff'),
  preset(
    'fancy-snancy',
    'Fancy Snancy',
    [0, 1, 2, 3, 7, 8, 9, 11, 13, 18, 21, 22, 24, 26],
    [4, 13, 17, 20, 21, 22, 23, 24, 26],
    4,
    'moore26',
    'state',
    '#ff0000',
    '#0000ff',
  ),
  preset('pretty-crystals', 'Pretty Crystals', [5, 6, 7, 8], [6, 7, 9], 10, 'moore26', 'distance', '#00ff00', '#0000ff'),
  preset('swapping', 'Swapping Structures', [3, 6, 9], [4, 8, 10], 20, 'moore26', 'state', '#ff0000', '#00ff00'),
  preset(
    'slow-blob',
    'Slowly Expanding Blob',
    range(9, 26),
    [5, 6, 7, 12, 13, 15],
    20,
    'moore26',
    'state',
    '#ffff00',
    '#0000ff',
  ),
  preset('445', '445', [4], [4], 5, 'moore26', 'state', '#000000', '#ff0000'),
  preset('expand-die', 'Expand Then Die', [4], [3], 20, 'moore26', 'state', '#000000', '#ff0000'),
  preset('coral', 'Coral Lines', [6, 7], [4, 6, 9, 10, 11], 6, 'moore26', 'state', '#0000ff', '#ff0000'),
  preset(
    'large-lines',
    'Large Lines',
    [5],
    [4, 6, 9, 10, 11, 16, 17, 18, 19, 20, 21, 22, 23, 24],
    35,
    'moore26',
    'state',
    '#0000ff',
    '#ff0000',
  ),
];

export function getPreset(id: string): RulePreset {
  return RULE_PRESETS.find((candidate) => candidate.id === id) ?? RULE_PRESETS[0]!;
}
