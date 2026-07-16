// @ts-nocheck -- Three's recursive TSL proxy types exhaust TypeScript on nontrivial compute graphs.
import * as THREE from 'three/webgpu';
import {
  Fn,
  globalId,
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

const WORKGROUP_SIZE = [8, 8, 4] as const;

function dispatchSize(bounds: number): [number, number, number] {
  return WORKGROUP_SIZE.map((size) => Math.ceil(bounds / size)) as [number, number, number];
}

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
  private readonly batchCache = new Map<string, THREE.ComputeNode[]>();

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
    if (this.resources === null || count < 1) {
      return;
    }

    const nodes = this.resources.stepNodes[this.neighborhood];
    const batchKey = `${this.neighborhood}:${this.textureIndex}:${count}`;
    let batch = this.batchCache.get(batchKey);

    if (batch === undefined) {
      let textureIndex = this.textureIndex;
      batch = [];
      for (let index = 0; index < count; index += 1) {
        batch.push(nodes[textureIndex]);
        textureIndex = textureIndex === 0 ? 1 : 0;
      }
      this.batchCache.set(batchKey, batch);
    }

    this.renderer.compute(batch.length === 1 ? batch[0] : batch);
    if (count % 2 === 1) {
      this.textureIndex = this.textureIndex === 0 ? 1 : 0;
    }
    this.generationValue += count;
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
    const writeA = storageTexture3D(textures[0]).toWriteOnly();

    const initKernel = Fn(() => {
      const x = globalId.x;
      const y = globalId.y;
      const z = globalId.z;
      const id = x.add(y.mul(bounds)).add(z.mul(bounds * bounds));
      const coordinate = globalId;
      const center = vec3(x, y, z).sub(Math.floor(bounds / 2));

      const hash = uint(id.add(this.seedUniform)).toVar();
      hash.assign(hash.bitXor(hash.shiftRight(16)));
      hash.assign(hash.mul(uint(0x7feb352d)));
      hash.assign(hash.bitXor(hash.shiftRight(15)));
      hash.assign(hash.mul(uint(0x846ca68b)));
      hash.assign(hash.bitXor(hash.shiftRight(16)));

      const random = hash.toFloat().div(4294967295);
      const insideSeed = center.x
        .abs()
        .lessThanEqual(this.seedRadiusUniform)
        .and(center.y.abs().lessThanEqual(this.seedRadiusUniform))
        .and(center.z.abs().lessThanEqual(this.seedRadiusUniform));
      const alive = insideSeed.and(random.lessThan(this.seedDensityUniform));
      const value = select(alive, 1, 0);

      textureStore(writeA, coordinate, vec4(value, 0, 0, 1));
    });

    const clearKernel = Fn(() => {
      textureStore(writeA, globalId, vec4(0, 0, 0, 1));
    });

    const dispatch = dispatchSize(bounds);
    const workgroup = [...WORKGROUP_SIZE];

    return {
      textures,
      initNode: initKernel().compute(dispatch, workgroup),
      clearNode: clearKernel().compute(dispatch, workgroup),
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
        const x = globalId.x;
        const y = globalId.y;
        const z = globalId.z;
        const coordinate = ivec3(x, y, z);
        const neighbours = uint(0).toVar();

        const xMinus = select(x.equal(0), uint(bounds - 1), x.sub(1));
        const yMinus = select(y.equal(0), uint(bounds - 1), y.sub(1));
        const zMinus = select(z.equal(0), uint(bounds - 1), z.sub(1));
        const xPlus = select(x.equal(bounds - 1), uint(0), x.add(1));
        const yPlus = select(y.equal(bounds - 1), uint(0), y.add(1));
        const zPlus = select(z.equal(bounds - 1), uint(0), z.add(1));

        for (const [offsetX, offsetY, offsetZ] of offsets) {
          const neighborX = offsetX < 0 ? xMinus : offsetX > 0 ? xPlus : x;
          const neighborY = offsetY < 0 ? yMinus : offsetY > 0 ? yPlus : y;
          const neighborZ = offsetZ < 0 ? zMinus : offsetZ > 0 ? zPlus : z;
          const neighbourCoordinate = ivec3(neighborX, neighborY, neighborZ);
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

    return stepKernel({ readCells: readNode, writeCells: writeNode }).compute(
      dispatchSize(bounds),
      [...WORKGROUP_SIZE],
    );
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
    this.batchCache.clear();
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
