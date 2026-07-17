# webgpu — contract for coding agents

This is a [nextrs](https://nextrs-docs.vercel.app/docs/getting-started) app:
Rust (Axum) serving Next.js-style file routes with React `.tsx` pages. The
scaffold generated the wiring below — treat it as framework, not app code.

## The app/ tree is the router

Every directory under `app/` is a URL segment. The build step discovers these
files and wires the router — never register routes by hand:

| File | Role |
|---|---|
| `page.{tsx,rs,html}` | The content for this URL (`.tsx` = client-rendered React) |
| `layout.tsx` or `layout.rs` + `layout.html` | Wraps this segment's children (Askama layouts need `{{ children|safe }}`) |
| `loading.{tsx,rs,html}` | Skeleton streamed while the page computes |
| `middleware.rs` | Guard, runs before anything renders |
| `route.rs` | API handlers — one `pub async fn get/post/...` per method, `#[nextrs::api]` for the typed client |
| `prefetch.rs` | Server data seeding a `page.tsx`'s React Query cache (requires the `.tsx` sibling) |

A `.tsx` slot is exclusive: it cannot coexist with `.rs`/`.html` of the same
name. Full reference: <https://nextrs-docs.vercel.app/docs/conventions>

## Never hand-roll what the scaffold generates

`build.rs`, `src/main.rs`, `api/index.rs`, `vercel.json`,
`scripts/deploy-prebuilt.sh`, `rust-toolchain.toml`, and the `client/`
package are generated wiring. Extend them if you must; do not replace them
with improvised versions. Never edit generated output: `client/src/generated/**`,
`client/openapi.json`, and `public/dist/` are rebuilt on every build. The
seams for app code are `app/**`, `client/src/index.ts`, and
`client/package.json`.

## The client package and the bare-import rule

`client/` is a real npm package; pages import it as `@webgpu/client`.

- **Every bare import used by any `.tsx` file must be installed in
  `client/package.json`** — the bundler resolves from `client/node_modules`
  and errors on unresolved bare imports. Adding a dependency means adding it
  there and running `npm install` in `client/`.
- **Never hand-write API types.** After changing `#[nextrs::api]` routes, run
  `npm run gen` in `client/` to regenerate the typed hooks from OpenAPI.
  Guide: <https://nextrs-docs.vercel.app/docs/typesafe-client>

## Dev loop

```bash
cargo dev   # build + run + watch (alias for nextrs-dev; `cargo install cargo-nextrs-dev` once)
```

Don't substitute a hand-rolled watch script — the runner knows which inputs
(Rust, templates, `app/`, `public/`, env files) require a restart.

## Deploys are prebuilt

Git auto-builds are OFF (`vercel.json` sets `git.deploymentEnabled: false`);
pushing deploys nothing. The deploy path is:

```bash
scripts/deploy-prebuilt.sh             # production
scripts/deploy-prebuilt.sh --preview   # preview
```

Guide: <https://nextrs-docs.vercel.app/docs/deploy-prebuilt>

## Porting into this app

Bringing routes over from an existing app? Graft them into this skeleton —
`route.ts` bodies become `route.rs` handlers, auth becomes `middleware.rs`,
React pages drop into `app/**/page.tsx` — rather than assembling parallel
structure around it. The paved road, including the strangler pattern for
incremental conversion and the gotchas list:
<https://nextrs-docs.vercel.app/docs/porting>
