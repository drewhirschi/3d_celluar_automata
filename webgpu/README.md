# Three.js WebGPU application

This is a nextrs 0.3.8 application with a Rust/Axum server and a React page.
The server only delivers the application shell and static assets. Cellular
automaton computation and Three.js rendering run entirely in browser WebGPU;
Rust and WebAssembly are not part of the simulation path.

Production: <https://3d-cellular-automata.vercel.app>

## Run

Install the nextrs development runner once, install the client dependencies,
and start the generated development loop:

```bash
cargo install cargo-nextrs-dev
cd client && npm ci && cd ..
cargo dev
```

Open `http://127.0.0.1:3000`. Localhost is a WebGPU secure context. Remote
deployments must use HTTPS.

## Architecture

- `app/page.tsx` renders the canvas, controls, and status nodes. Its effect
  mounts the WebGPU application and returns its teardown.
- `app/layout.tsx` owns document metadata and the favicon.
- `app/lib/cellular-automata.ts` initializes Three.js, owns the controls and
  animation loop, and reports WebGPU initialization or device-loss failures.
- `app/lib/automaton.ts` stores the current and next automaton states in two
  `rgba8unorm` 3D storage textures. TSL compute kernels gather either 26 Moore
  or 6 Von Neumann neighbors and ping-pong the textures each tick.
- `app/lib/cell-renderer.ts` compacts nonzero texels into a packed GPU instance
  buffer, updates an indirect draw count, and rasterizes one depth-tested cube
  per visible cell without copying state through JavaScript.
- `app/lib/rules.ts` defines parsing, bit masks, colors, and the ten presets.
- `app/lib/sim/reference.ts` is the CPU correctness oracle used by tests.
- `public/style.css` is fingerprinted and linked by nextrs. Static files under
  `public/` are served from the origin root.

The GPU design was inspired by Isidor Nielsen's implementation shown in
[Tantan's follow-up video](https://www.youtube.com/watch?v=jkHqrkcEHRc&t=591s).
The browser implementation fixes the original shader's in-place update race
and oversized workgroups. See `public/THIRD_PARTY_NOTICES.txt` for attribution.

This application has no server data and intentionally has no `prefetch.rs`.
nextrs still preloads route chunks on link intent without making data requests.

## Verify

```bash
cd client
npm test
npm run typecheck
cd ..
cargo check
cargo build
```

WebGPU behavior must also be checked in a real browser; headless WebKit is not
an equivalent runtime.

## Deploy

The generated Vercel configuration disables Git cloud builds. Install the
Vercel CLI, `cargo-zigbuild`, and a Zig toolchain once. Authenticate and link
the project, then use the generated prebuilt deployment flow:

```bash
vercel link
scripts/deploy-prebuilt.sh
```

The script builds locally, verifies that the Rust function exists, and uploads
the prebuilt artifacts. Vercel supplies the HTTPS origin required by WebGPU.
