// @ts-nocheck -- Three's recursive TSL proxy types exhaust TypeScript on nontrivial compute graphs.
import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  Return,
  atomicAdd,
  atomicStore,
  globalId,
  instancedArray,
  ivec3,
  mix,
  positionLocal,
  select,
  storage,
  struct,
  texture3D,
  uint,
  uniform,
  varyingProperty,
  vec3,
} from 'three/tsl';

import type { ColorMode } from './rules';

const WORKGROUP_SIZE = [8, 8, 4] as const;
const CELL_ID_MASK = 0x00ff_ffff;

function dispatchSize(bounds: number): [number, number, number] {
  return WORKGROUP_SIZE.map((size) => Math.ceil(bounds / size)) as [number, number, number];
}

export class CellStyle {
  readonly colorLow = uniform(new THREE.Color('#ffff00'));
  readonly colorHigh = uniform(new THREE.Color('#ff0000'));
  readonly colorMode = uniform(0, 'uint');
  readonly scale = uniform(0.9);

  setColors(low: string, high: string): void {
    this.colorLow.value.set(low);
    this.colorHigh.value.set(high);
  }

  setColorMode(mode: ColorMode): void {
    this.colorMode.value = mode === 'distance' ? 0 : 1;
  }
}

export class GpuCellRenderer {
  readonly mesh: THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicNodeMaterial>;

  private readonly resetNode: THREE.ComputeNode;
  private readonly compactNodes: [THREE.ComputeNode, THREE.ComputeNode];

  constructor(
    private readonly renderer: THREE.WebGPURenderer,
    textures: readonly [THREE.Storage3DTexture, THREE.Storage3DTexture],
    bounds: number,
    style: CellStyle,
  ) {
    const cellCount = bounds ** 3;
    if (cellCount > CELL_ID_MASK + 1) {
      throw new RangeError(`Grid is too large for packed cell rendering: ${bounds}`);
    }

    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const index = geometry.getIndex();
    if (index === null) {
      throw new Error('Cell cube geometry must be indexed');
    }

    const drawAttribute = new THREE.IndirectStorageBufferAttribute(
      new Uint32Array([index.count, 0, 0, 0, 0]),
      5,
    );
    geometry.setIndirect(drawAttribute);

    const DrawIndexedArguments = struct(
      {
        indexCount: 'uint',
        instanceCount: { type: 'uint', atomic: true },
        firstIndex: 'uint',
        baseVertex: 'int',
        firstInstance: 'uint',
      },
      'CellDrawIndexedArguments',
    );
    const drawArguments = storage(drawAttribute, DrawIndexedArguments, drawAttribute.count);

    const packedCells = instancedArray(cellCount, 'uint');
    const packedCell = packedCells.toAttribute();

    this.resetNode = Fn(() => {
      atomicStore(drawArguments.get('instanceCount'), uint(0));
    })()
      .compute(1)
      .setName('Reset visible cell count');

    this.compactNodes = [
      this.createCompactionNode(textures[0], packedCells, drawArguments, bounds),
      this.createCompactionNode(textures[1], packedCells, drawArguments, bounds),
    ];

    const cellState = varyingProperty('float', 'vCellState');
    const cellDistance = varyingProperty('float', 'vCellDistance');
    const positionNode = Fn(() => {
      const packed = packedCell.toVar();
      const id = packed.bitAnd(uint(CELL_ID_MASK));
      const x = id.mod(uint(bounds));
      const y = id.div(uint(bounds)).mod(uint(bounds));
      const z = id.div(uint(bounds * bounds));
      const centered = vec3(x.toFloat(), y.toFloat(), z.toFloat()).sub(
        Math.floor(bounds / 2),
      );

      cellState.assign(packed.shiftRight(24).toFloat().div(255));
      cellDistance.assign(centered.length().div(bounds / 2).clamp(0, 1));

      return positionLocal.mul(style.scale.div(bounds)).add(centered.div(bounds));
    })();

    const colorMix = select(style.colorMode.equal(0), cellDistance, cellState);
    const material = new THREE.MeshBasicNodeMaterial();
    material.name = 'gpu-cell-material';
    material.positionNode = positionNode;
    material.colorNode = mix(style.colorLow, style.colorHigh, colorMix);
    material.side = THREE.FrontSide;
    material.depthTest = true;
    material.depthWrite = true;

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = 'gpu-cells';
    this.mesh.frustumCulled = false;
  }

  compact(textureIndex: 0 | 1): void {
    this.renderer.compute([this.resetNode, this.compactNodes[textureIndex]]);
  }

  dispose(): void {
    this.resetNode.dispose();
    this.compactNodes[0].dispose();
    this.compactNodes[1].dispose();
    this.mesh.material.dispose();
    this.mesh.geometry.dispose();
  }

  private createCompactionNode(
    texture: THREE.Storage3DTexture,
    packedCells: THREE.StorageBufferNode,
    drawArguments: THREE.StorageBufferNode,
    bounds: number,
  ): THREE.ComputeNode {
    const cells = texture3D(texture, null, 0);
    const compactKernel = Fn(() => {
      const outsideGrid = globalId.x
        .greaterThanEqual(bounds)
        .or(globalId.y.greaterThanEqual(bounds))
        .or(globalId.z.greaterThanEqual(bounds));

      If(outsideGrid, () => {
        Return();
      });

      const state = cells.load(ivec3(globalId.x, globalId.y, globalId.z)).r;
      If(state.greaterThan(0.001), () => {
        const slot = atomicAdd(drawArguments.get('instanceCount'), uint(1));
        const id = globalId.x
          .add(globalId.y.mul(bounds))
          .add(globalId.z.mul(bounds * bounds));
        const stateByte = state.mul(255).round().toUint();
        packedCells.element(slot).assign(id.bitOr(stateByte.shiftLeft(24)));
      });
    });

    return compactKernel()
      .compute(dispatchSize(bounds), [...WORKGROUP_SIZE])
      .setName(`Compact visible cells from ${texture.name}`);
  }
}
