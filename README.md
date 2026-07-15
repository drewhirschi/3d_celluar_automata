# 3d_celluar_automata
A 3D cellutomata implementation with Rust and Bevy
![preview image](branding/preview.png)

Project creation was documented on my youtube page!
https://youtu.be/63qlEpO73C4

You can configure the simulation using a graphical interface:
![gui](branding/gui.png)

There are various implementations by
* [TanTanDev](https://github.com/TanTanDev)
* [leddoo](https://github.com/leddoo)

## Run natively

```bash
cargo run --release
```

## Run in a browser

The web build uses WebAssembly for the Rust application and WebGPU for rendering.

Install the one-time build prerequisites:

```bash
rustup target add wasm32-unknown-unknown
cargo install --locked wasm-bindgen-cli --version 0.2.126
```

Build and serve the static web application:

```bash
scripts/build-web.sh
scripts/serve-web.sh
```

Then open `http://127.0.0.1:8080`. Production deployments must use HTTPS for WebGPU. The generated static site is written to `web/dist`.

Drag to orbit, scroll or pinch to zoom, and use the control panel to pause, step, change tick rate, resize the volume, recolor the cells, or load a preset.


## License
3d_celluar_automata is free and open source! All code in this repository is dual-licensed under either:

* MIT License ([LICENSE-MIT](docs/LICENSE-MIT) or [http://opensource.org/licenses/MIT](http://opensource.org/licenses/MIT))
* Apache License, Version 2.0 ([LICENSE-APACHE](docs/LICENSE-APACHE) or [http://www.apache.org/licenses/LICENSE-2.0](http://www.apache.org/licenses/LICENSE-2.0))

at your option.

Unless you explicitly state otherwise, any contribution intentionally submitted
for inclusion in the work by you, as defined in the Apache-2.0 license, shall be dual licensed as above, without any
additional terms or conditions.
