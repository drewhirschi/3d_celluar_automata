# Three.js WebGPU experiment

This application keeps a dense 3D cellular automaton on the GPU and renders the
same GPU-resident state with Three.js. Rust and WebAssembly are not part of this
path.

## Run

Use Node.js `^20.19.0` or `>=22.12.0` and a current browser with WebGPU.
WebGPU is available on localhost; deployed builds must be served over HTTPS.

```bash
npm ci
npm run dev
```

Open `http://127.0.0.1:5173`.

## Architecture

- Two `rgba8unorm` `Storage3DTexture` objects hold the current and next state.
- A TSL compute kernel gathers either 26 Moore or 6 Von Neumann neighbors.
- Every tick reads one texture and writes the other, then swaps them. This
  ping-pong layout avoids cross-workgroup data races.
- State is encoded as `state / states`; only the fully alive state contributes
  to the next generation's neighbor count.
- A Three.js raymarching material samples the current texture directly. No cell
  state is copied through JavaScript during simulation or rendering.
- `src/sim/reference.ts` is a small CPU implementation used as a correctness
  oracle for rule semantics and toroidal boundaries.

The design was inspired by Isidor Nielsen's GPU implementation shown in
[Tantan's follow-up video](https://www.youtube.com/watch?v=jkHqrkcEHRc&t=591s).
The browser port uses new Three.js TSL kernels and fixes the original shader's
in-place update race and oversized workgroups. See
[`THIRD_PARTY_NOTICES.txt`](public/THIRD_PARTY_NOTICES.txt) for attribution.

## Verify

```bash
npm test
npm run typecheck
npm run build
```

The static production build is written to `dist` and uses relative asset URLs,
so it can be hosted at a domain root or a subpath. Preview it locally with
`npm run preview`.
