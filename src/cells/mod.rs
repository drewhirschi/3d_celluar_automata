use crate::{cell_renderer::CellRenderer, rule::Rule};
use bevy::tasks::TaskPool;

pub trait Sim: Send + Sync {
    fn update(&mut self, rule: &Rule, task_pool: &TaskPool);
    fn render(&self, data: &mut CellRenderer);

    fn reset(&mut self) {
        let bounds = self.bounds();
        self.set_bounds(0);
        self.set_bounds(bounds);
    }

    fn spawn_noise(&mut self, rule: &Rule);

    fn bounds(&self) -> i32;
    fn set_bounds(&mut self, new_bounds: i32) -> i32;
}

pub mod sims;
pub use sims::*;

pub mod leddoo;
#[cfg(not(target_arch = "wasm32"))]
pub mod tantan;
