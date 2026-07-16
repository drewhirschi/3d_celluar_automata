// @ts-nocheck -- Three's recursive TSL proxy types exhaust TypeScript on nontrivial shader graphs.
import * as THREE from 'three/webgpu';
import { Break, Fn, If, max, select, texture3D, uniform, vec3, vec4 } from 'three/tsl';
import { RaymarchingBox } from 'three/addons/tsl/utils/Raymarching.js';

export class VolumeStyle {
  readonly colorLow = uniform(new THREE.Color('#ffe36e'));
  readonly colorHigh = uniform(new THREE.Color('#ff4f78'));
  readonly steps = uniform(160);
  readonly edgeStrength = uniform(0.72);
  readonly voxelSize = uniform(1 / 64);

  setColors(low: string, high: string): void {
    this.colorLow.value.set(low);
    this.colorHigh.value.set(high);
  }

  setBounds(bounds: number): void {
    this.voxelSize.value = 1 / bounds;
  }
}

export function createVolumeMaterial(
  texture: THREE.Storage3DTexture,
  style: VolumeStyle,
): THREE.NodeMaterial {
  const cells = texture3D(texture, null, 0);

  const raymarchCells = Fn(() => {
    const hit = vec4(0).toVar();

    RaymarchingBox(style.steps, ({ positionRay }) => {
      const uvw = positionRay.add(0.5);
      const state = cells.sample(uvw).r.toVar();

      If(state.greaterThan(0.001), () => {
        const deltaX = vec3(style.voxelSize, 0, 0);
        const deltaY = vec3(0, style.voxelSize, 0);
        const deltaZ = vec3(0, 0, style.voxelSize);
        const gradient = vec3(
          select(cells.sample(uvw.add(deltaX)).r.greaterThan(0.001), 1, 0).sub(
            select(cells.sample(uvw.sub(deltaX)).r.greaterThan(0.001), 1, 0),
          ),
          select(cells.sample(uvw.add(deltaY)).r.greaterThan(0.001), 1, 0).sub(
            select(cells.sample(uvw.sub(deltaY)).r.greaterThan(0.001), 1, 0),
          ),
          select(cells.sample(uvw.add(deltaZ)).r.greaterThan(0.001), 1, 0).sub(
            select(cells.sample(uvw.sub(deltaZ)).r.greaterThan(0.001), 1, 0),
          ),
        );
        const normal = gradient.div(max(gradient.length(), 0.001));
        const light = vec3(0.45, 0.78, 0.32).normalize();
        const diffuse = max(normal.dot(light), 0).mul(style.edgeStrength).add(0.28);
        const baseColor = style.colorLow.mul(state.oneMinus()).add(style.colorHigh.mul(state));

        hit.assign(vec4(baseColor.mul(diffuse), 1));
        Break();
      });
    });

    hit.a.lessThan(0.5).discard();
    return hit;
  });

  const material = new THREE.NodeMaterial();
  material.name = `cell-volume-${texture.name}`;
  material.colorNode = raymarchCells();
  material.side = THREE.BackSide;
  material.transparent = false;
  material.depthWrite = true;
  material.depthTest = true;
  return material;
}
