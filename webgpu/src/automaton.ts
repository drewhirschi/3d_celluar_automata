// @ts-nocheck -- Three's recursive TSL proxy types exhaust TypeScript on nontrivial compute graphs.
import * as THREE from 'three/webgpu';
import {
  Fn,
  instanceIndex,
  int,
  ivec3,
  select,
  storageTexture3D,
  texture3D,
  textureStore,
  uint,
  uniform,
  uvec3,
  vec3,
  vec4,
} from 'three/tsl';

import type { AutomatonRule, Neighborhood } from './sim/reference';

// GPU-resident design reference: https://github.com/IsseW/cas/tree/858e298d0e1ef163cc3ebff46c880e6f135eba27

const MOORE_OFFSETS: ReadonlyArray<readonly [number, number, number]> = [];

for (let z = -1; z <= 1; z += 1) {
  for (let y = -1; y <= 1; y += 1) {
    for (let x = -1; x <= 1; x += 1) {
      if (x !== 0 || y !== 0 || z !== 0) {
        MOORE_OFFSETS.push([x, y, z]);
      }
    }
  }
}

const VON_NEUMANN_OFFSETS: ReadonlyArray<readonly [number, number, number]> = [
  [-1, 0, 0],
  [1, 0, 0],
  [0, -1, 0],
  [0, 1, 0],
  [0, 0, -1],
  [0, 0, 1],
];

interface TexturePair {
  textures: [THREE.Storage3DTexture, THREE.Storage3DTexture];
  initNode: THREE.ComputeNode;
  clearNode: THREE.ComputeNode;
  stepNodes: Record<Neighborhood, [THREE.ComputeNode, THREE.ComputeNode]>;
}

export interface AutomatonSnapshot {
  bounds: number;
  generation: number;
  neighborhood: Neighborhood;
  cellCount: number;
  texture: THREE.Storage3DTexture;
  textureIndex: 0 | 1;
}

export class GpuAutomaton {
  private readonly statesUniform = uniform(10, 'uint');
  private readonly survivalMaskUniform = uniform(0, 'uint');
  private readonly birthMaskUniform = uniform(0, 'uint');
  private readonly seedUniform = uniform(1, 'uint');
  private readonly seedDensityUniform = uniform(0.55);
  private readonly seedRadiusUniform = uniform(6);

  private resources: TexturePair | null = null;
  private textureIndex: 0 | 1 = 0;
  private neighborhood: Neighborhood = 'moore26';
  private boundsValue = 0;
  private generationValue = 0;
  private seedValue = 1;

  constructor(private readonly renderer: THREE.WebGPURenderer) {}

  get bounds(): number {
    return this.boundsValue;
  }

  get generation(): number {
    return this.generationValue;
  }

  get currentTexture(): THREE.Storage3DTexture {
    if (this.resources === null) {
      throw new Error('GPU automaton has not been initialized');
    }
    return this.resources.textures[this.textureIndex];
  }

  get textures(): readonly [THREE.Storage3DTexture, THREE.Storage3DTexture] {
    if (this.resources === null) {
      throw new Error('GPU automaton has not been initialized');
    }
    return this.resources.textures;
  }

  rebuild(bounds: number, rule: AutomatonRule): void {
    if (!Number.isInteger(bounds) || bounds < 4) {
      throw new RangeError(`Bounds must be an integer of at least 4: ${bounds}`);
    }

    this.disposeResources();
    this.boundsValue = bounds;
    this.resources = this.createResources(bounds);
    this.applyRule(rule);
    this.reset();
  }

  applyRule(rule: AutomatonRule): void {
    if (!Number.isInteger(rule.states) || rule.states < 1 || rule.states > 50) {
      throw new RangeError(`States must be an integer from 1 to 50: ${rule.states}`);
    }

    this.statesUniform.value = rule.states;
    this.survivalMaskUniform.value = rule.survivalMask >>> 0;
    this.birthMaskUniform.value = rule.birthMask >>> 0;
    this.neighborhood = rule.neighborhood;
  }

  configureSeed(density: number, radius: number): void {
    this.seedDensityUniform.value = THREE.MathUtils.clamp(density, 0, 1);
    this.seedRadiusUniform.value = Math.max(1, radius);
  }

  reset(seed?: number): void {
    if (this.resources === null) {
      return;
    }

    this.seedValue = seed === undefined ? (this.seedValue + 0x9e3779b9) >>> 0 : seed >>> 0;
    this.seedUniform.value = this.seedValue;
    this.textureIndex = 0;
    this.generationValue = 0;
    this.renderer.compute(this.resources.initNode);
  }

  clear(): void {
    if (this.resources === null) {
      return;
    }

    this.textureIndex = 0;
    this.generationValue = 0;
    this.renderer.compute(this.resources.clearNode);
  }

  step(count = 1): void {
    if (this.resources === null) {
      return;
    }

    const nodes = this.resources.stepNodes[this.neighborhood];

    for (let index = 0; index < count; index += 1) {
      this.renderer.compute(nodes[this.textureIndex]);
      this.textureIndex = this.textureIndex === 0 ? 1 : 0;
      this.generationValue += 1;
    }
  }

  snapshot(): AutomatonSnapshot {
    return {
      bounds: this.boundsValue,
      generation: this.generationValue,
      neighborhood: this.neighborhood,
      cellCount: this.boundsValue ** 3,
      texture: this.currentTexture,
      textureIndex: this.textureIndex,
    };
  }

  dispose(): void {
    this.disposeResources();
  }

  private createResources(bounds: number): TexturePair {
    const textures: [THREE.Storage3DTexture, THREE.Storage3DTexture] = [
      this.createTexture(bounds, 'cells-a'),
      this.createTexture(bounds, 'cells-b'),
    ];
    const cellCount = bounds ** 3;
    const writeA = storageTexture3D(textures[0]).toWriteOnly();

    const initKernel = Fn(() => {
      const id = instanceIndex;
      const x = id.mod(bounds);
      const y = id.div(bounds).mod(bounds);
      const z = id.div(bounds * bounds);
      const coordinate = uvec3(x, y, z);
      const center = vec3(x, y, z).sub((bounds - 1) * 0.5);

      const hash = uint(id.add(this.seedUniform)).toVar();
      hash.assign(hash.bitXor(hash.shiftRight(16)));
      hash.assign(hash.mul(uint(0x7feb352d)));
      hash.assign(hash.bitXor(hash.shiftRight(15)));
      hash.assign(hash.mul(uint(0x846ca68b)));
      hash.assign(hash.bitXor(hash.shiftRight(16)));

      const random = hash.toFloat().div(4294967295);
      const alive = center.length().lessThanEqual(this.seedRadiusUniform).and(random.lessThan(this.seedDensityUniform));
      const value = select(alive, 1, 0);

      textureStore(writeA, coordinate, vec4(value, 0, 0, 1));
    });

    const clearKernel = Fn(() => {
      const id = instanceIndex;
      const coordinate = uvec3(id.mod(bounds), id.div(bounds).mod(bounds), id.div(bounds * bounds));
      textureStore(writeA, coordinate, vec4(0, 0, 0, 1));
    });

    return {
      textures,
      initNode: initKernel().compute(cellCount, [64]),
      clearNode: clearKernel().compute(cellCount, [64]),
      stepNodes: {
        moore26: [
          this.createStepNode(textures[0], textures[1], bounds, MOORE_OFFSETS),
          this.createStepNode(textures[1], textures[0], bounds, MOORE_OFFSETS),
        ],
        vonNeumann6: [
          this.createStepNode(textures[0], textures[1], bounds, VON_NEUMANN_OFFSETS),
          this.createStepNode(textures[1], textures[0], bounds, VON_NEUMANN_OFFSETS),
        ],
      },
    };
  }

  private createStepNode(
    readTexture: THREE.Storage3DTexture,
    writeTexture: THREE.Storage3DTexture,
    bounds: number,
    offsets: ReadonlyArray<readonly [number, number, number]>,
  ): THREE.ComputeNode {
    const readNode = texture3D(readTexture, null, 0);
    const writeNode = storageTexture3D(writeTexture).toWriteOnly();

    const stepKernel = Fn(
      ({
        readCells,
        writeCells,
      }: {
        readCells: THREE.Texture3DNode;
        writeCells: THREE.StorageTexture3DNode;
      }) => {
        const id = instanceIndex;
        const x = id.mod(bounds);
        const y = id.div(bounds).mod(bounds);
        const z = id.div(bounds * bounds);
        const coordinate = ivec3(int(x), int(y), int(z));
        const neighbours = uint(0).toVar();

        for (const [offsetX, offsetY, offsetZ] of offsets) {
          const neighbourCoordinate = ivec3(
            int(x).add(bounds + offsetX).mod(bounds),
            int(y).add(bounds + offsetY).mod(bounds),
            int(z).add(bounds + offsetZ).mod(bounds),
          );
          const neighbourAlive = readCells.load(neighbourCoordinate).r.greaterThan(0.999);
          neighbours.addAssign(select(neighbourAlive, uint(1), uint(0)));
        }

        const state = uint(readCells.load(coordinate).r.mul(this.statesUniform).round());
        const survives = this.survivalMaskUniform.shiftRight(neighbours).bitAnd(1).notEqual(0);
        const isBorn = this.birthMaskUniform.shiftRight(neighbours).bitAnd(1).notEqual(0);
        const liveResult = select(survives, this.statesUniform, this.statesUniform.sub(1));
        const deadResult = select(isBorn, this.statesUniform, uint(0));
        const nextState = select(
          state.equal(this.statesUniform),
          liveResult,
          select(state.equal(0), deadResult, state.sub(1)),
        );
        const encodedState = nextState.toFloat().div(this.statesUniform.toFloat());

        textureStore(writeCells, uvec3(x, y, z), vec4(encodedState, 0, 0, 1));
      },
    );

    return stepKernel({ readCells: readNode, writeCells: writeNode }).compute(bounds ** 3, [64]);
  }

  private createTexture(bounds: number, name: string): THREE.Storage3DTexture {
    const texture = new THREE.Storage3DTexture(bounds, bounds, bounds);
    texture.name = name;
    texture.format = THREE.RGBAFormat;
    texture.type = THREE.UnsignedByteType;
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.wrapR = THREE.ClampToEdgeWrapping;
    return texture;
  }

  private disposeResources(): void {
    if (this.resources === null) {
      return;
    }

    this.resources.initNode.dispose();
    this.resources.clearNode.dispose();
    for (const pair of Object.values(this.resources.stepNodes)) {
      pair[0].dispose();
      pair[1].dispose();
    }

    for (const texture of this.resources.textures) {
      texture.dispose();
    }
    this.resources = null;
  }
}
