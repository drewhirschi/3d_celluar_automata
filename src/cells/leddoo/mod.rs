mod single_threaded;
pub use single_threaded::*;

#[cfg(not(target_arch = "wasm32"))]
mod atomic;
#[cfg(not(target_arch = "wasm32"))]
pub use atomic::*;
