use std::time::Duration;

use bevy::{
    color::LinearRgba,
    prelude::{
        Color, ColorToComponents, IntoScheduleConfigs, Plugin, Query, Res, ResMut, Resource, Time,
        Update,
    },
    tasks::AsyncComputeTaskPool,
};
use bevy_egui::{egui, EguiContexts, EguiPrimaryContextPass};

use crate::{
    cell_renderer::{CellRenderer, InstanceData, InstanceMaterialData},
    cells::Sim,
    neighbours::NeighbourMethod,
    rule::{ColorMethod, Rule, Value},
    utils,
};

#[derive(Clone)]
pub struct Example {
    pub name: String,
    pub rule: Rule,
    pub color_method: ColorMethod,
    pub color1: Color,
    pub color2: Color,
}

#[derive(Resource)]
pub struct Sims {
    sims: Vec<(String, Box<dyn Sim>)>,
    active_sim: usize,
    bounds: i32,
    pending_bounds: i32,
    update_dt: Duration,
    renderer: CellRenderer,
    rule: Rule,
    color_method: ColorMethod,
    color1: Color,
    color2: Color,
    examples: Vec<Example>,
    active_example: usize,
    running: bool,
    tick_rate: f32,
    tick_accumulator: f32,
    step_requested: bool,
    render_dirty: bool,
    generation: u64,
    visible_cells: usize,
}

impl Sims {
    pub fn new() -> Self {
        Self {
            sims: vec![],
            active_sim: usize::MAX,
            bounds: 64,
            pending_bounds: 64,
            update_dt: Duration::ZERO,
            renderer: CellRenderer::new(),
            rule: Rule {
                survival_rule: Value::new(&[]),
                birth_rule: Value::new(&[]),
                states: 2,
                neighbour_method: NeighbourMethod::Moore,
            },
            color_method: ColorMethod::DistToCenter,
            color1: Color::srgb(1.0, 1.0, 0.0),
            color2: Color::srgb(1.0, 0.0, 0.0),
            examples: vec![],
            active_example: usize::MAX,
            running: true,
            tick_rate: 10.0,
            tick_accumulator: 0.0,
            step_requested: false,
            render_dirty: true,
            generation: 0,
            visible_cells: 0,
        }
    }

    pub fn add_sim(&mut self, name: String, sim: Box<dyn Sim>) {
        self.sims.push((name, sim));
    }

    pub fn add_example(&mut self, example: Example) {
        self.examples.push(example);
    }

    pub fn set_sim(&mut self, index: usize) {
        if index >= self.sims.len() {
            return;
        }
        if self.active_sim < self.sims.len() {
            self.sims[self.active_sim].1.reset();
        }

        self.active_sim = index;
        self.bounds = self.sims[index].1.set_bounds(self.bounds);
        self.pending_bounds = self.bounds;
        self.sims[index].1.spawn_noise(&self.rule);
        self.renderer.set_bounds(self.bounds);
        self.generation = 0;
        self.render_dirty = true;
    }

    pub fn set_example(&mut self, index: usize) {
        if index >= self.examples.len() {
            return;
        }
        let example = self.examples[index].clone();
        self.active_example = index;
        self.rule = example.rule;
        self.color_method = example.color_method;
        self.color1 = example.color1;
        self.color2 = example.color2;

        if self.active_sim < self.sims.len() {
            let sim = &mut self.sims[self.active_sim].1;
            sim.reset();
            sim.spawn_noise(&self.rule);
        }
        self.generation = 0;
        self.render_dirty = true;
    }

    fn clear(&mut self) {
        if self.active_sim < self.sims.len() {
            self.sims[self.active_sim].1.reset();
            self.generation = 0;
            self.render_dirty = true;
        }
    }

    fn spawn_noise(&mut self) {
        if self.active_sim < self.sims.len() {
            self.sims[self.active_sim].1.spawn_noise(&self.rule);
            self.render_dirty = true;
        }
    }

    fn apply_bounds(&mut self) {
        if self.active_sim >= self.sims.len() || self.pending_bounds == self.bounds {
            return;
        }
        self.bounds = self.sims[self.active_sim].1.set_bounds(self.pending_bounds);
        self.pending_bounds = self.bounds;
        self.sims[self.active_sim].1.spawn_noise(&self.rule);
        self.renderer.set_bounds(self.bounds);
        self.generation = 0;
        self.render_dirty = true;
    }

    fn apply_rule(&mut self, rule: Rule) {
        self.rule = rule;
        if self.active_sim < self.sims.len() {
            let sim = &mut self.sims[self.active_sim].1;
            sim.reset();
            sim.spawn_noise(&self.rule);
        }
        self.generation = 0;
        self.render_dirty = true;
    }
}

fn ui_system(mut sims: ResMut<Sims>, mut contexts: EguiContexts) -> bevy::prelude::Result {
    if sims.active_sim >= sims.sims.len() {
        return Ok(());
    }

    let context = contexts.ctx_mut()?;
    egui::Window::new("Cellular Automata")
        .default_width(300.0)
        .min_width(300.0)
        .resizable(false)
        .show(context, |ui| {
            ui.horizontal(|ui| {
                let run_label = if sims.running { "Pause" } else { "Play" };
                if ui.button(run_label).clicked() {
                    sims.running = !sims.running;
                    sims.tick_accumulator = 0.0;
                }
                if ui
                    .add_enabled(!sims.running, egui::Button::new("Step"))
                    .clicked()
                {
                    sims.step_requested = true;
                }
            });
            ui.add(egui::Slider::new(&mut sims.tick_rate, 1.0..=30.0).text("ticks / second"));

            ui.separator();
            ui.label(format!("Generation: {}", sims.generation));
            ui.label(format!("Visible cells: {}", sims.visible_cells));
            ui.label(format!(
                "Tick time: {:.2} ms",
                sims.update_dt.as_secs_f64() * 1000.0
            ));

            if sims.sims.len() > 1 {
                let mut active_sim = sims.active_sim;
                egui::ComboBox::from_label("Simulator")
                    .selected_text(&sims.sims[active_sim].0)
                    .show_ui(ui, |ui| {
                        for (index, (name, _)) in sims.sims.iter().enumerate() {
                            ui.selectable_value(&mut active_sim, index, name);
                        }
                    });
                if active_sim != sims.active_sim {
                    sims.set_sim(active_sim);
                }
            }

            ui.horizontal(|ui| {
                if ui.button("Clear").clicked() {
                    sims.clear();
                }
                if ui.button("Add noise").clicked() {
                    sims.spawn_noise();
                }
            });

            let bounds_response =
                ui.add(egui::Slider::new(&mut sims.pending_bounds, 32..=128).text("bounds"));
            if bounds_response.drag_stopped()
                || (bounds_response.changed() && !bounds_response.dragged())
            {
                sims.apply_bounds();
            }

            ui.separator();
            ui.label("Appearance");
            let previous_color_method = sims.color_method;
            egui::ComboBox::from_label("Color")
                .selected_text(format!("{:?}", sims.color_method))
                .show_ui(ui, |ui| {
                    ui.selectable_value(&mut sims.color_method, ColorMethod::Single, "Single");
                    ui.selectable_value(
                        &mut sims.color_method,
                        ColorMethod::StateLerp,
                        "State gradient",
                    );
                    ui.selectable_value(
                        &mut sims.color_method,
                        ColorMethod::DistToCenter,
                        "Distance",
                    );
                    ui.selectable_value(
                        &mut sims.color_method,
                        ColorMethod::Neighbour,
                        "Neighbors",
                    );
                });

            let old_color1 = sims.color1;
            let old_color2 = sims.color2;
            ui.horizontal(|ui| {
                ui.label("Colors");
                color_picker(ui, &mut sims.color1);
                color_picker(ui, &mut sims.color2);
            });
            if sims.color_method != previous_color_method
                || sims.color1 != old_color1
                || sims.color2 != old_color2
            {
                sims.render_dirty = true;
            }

            ui.separator();
            ui.label("Rule");
            let mut rule = sims.rule.clone();
            let old_rule = rule.clone();
            egui::ComboBox::from_label("Neighborhood")
                .selected_text(format!("{:?}", rule.neighbour_method))
                .show_ui(ui, |ui| {
                    ui.selectable_value(
                        &mut rule.neighbour_method,
                        NeighbourMethod::Moore,
                        "Moore (26)",
                    );
                    ui.selectable_value(
                        &mut rule.neighbour_method,
                        NeighbourMethod::VonNeuman,
                        "Von Neumann (6)",
                    );
                });
            ui.add(egui::Slider::new(&mut rule.states, 1..=50).text("states"));
            if rule != old_rule {
                sims.apply_rule(rule);
            }

            ui.separator();
            let mut active_example = sims.active_example;
            let selected_example = sims
                .examples
                .get(active_example)
                .map(|example| example.name.as_str())
                .unwrap_or("Choose preset");
            egui::ComboBox::from_label("Preset")
                .selected_text(selected_example)
                .show_ui(ui, |ui| {
                    for (index, example) in sims.examples.iter().enumerate() {
                        ui.selectable_value(&mut active_example, index, &example.name);
                    }
                });
            if active_example != sims.active_example {
                sims.set_example(active_example);
            }
        });

    Ok(())
}

fn advance_simulation(time: Res<Time>, mut sims: ResMut<Sims>) {
    if sims.active_sim >= sims.sims.len() {
        return;
    }

    let mut steps = usize::from(sims.step_requested);
    sims.step_requested = false;

    if sims.running {
        sims.tick_accumulator += time.delta_secs().min(0.25);
        let tick_interval = 1.0 / sims.tick_rate;
        while sims.tick_accumulator >= tick_interval && steps < 4 {
            sims.tick_accumulator -= tick_interval;
            steps += 1;
        }
    } else {
        sims.tick_accumulator = 0.0;
    }

    if steps == 0 {
        return;
    }

    let active_sim = sims.active_sim;
    let rule = sims.rule.clone();
    let started = web_time::Instant::now();
    for _ in 0..steps {
        sims.sims[active_sim]
            .1
            .update(&rule, AsyncComputeTaskPool::get());
    }
    sims.update_dt = started.elapsed() / steps as u32;
    sims.generation += steps as u64;
    sims.render_dirty = true;
}

fn sync_instances(mut sims: ResMut<Sims>, mut query: Query<&mut InstanceMaterialData>) {
    if !sims.render_dirty || sims.active_sim >= sims.sims.len() {
        return;
    }

    let active_sim = sims.active_sim;
    let bounds = sims.bounds;
    let rule = sims.rule.clone();
    {
        let sims = &mut *sims;
        let sim = &sims.sims[active_sim].1;
        sim.render(&mut sims.renderer);
    }

    let Ok(mut instance_data) = query.single_mut() else {
        return;
    };
    instance_data.0.clear();
    instance_data
        .0
        .reserve(sims.renderer.cell_count().min(64 * 1024));

    for index in 0..sims.renderer.cell_count() {
        let value = sims.renderer.values[index];
        if value == 0 {
            continue;
        }
        let neighbors = sims.renderer.neighbors[index];
        let pos = utils::index_to_pos(index, bounds);
        instance_data.0.push(InstanceData {
            position: (pos - utils::center(bounds)).as_vec3(),
            scale: 1.0,
            color: LinearRgba::from(sims.color_method.color(
                sims.color1,
                sims.color2,
                rule.states,
                value,
                neighbors,
                utils::dist_to_center(pos, bounds),
            ))
            .to_f32_array(),
        });
    }

    sims.visible_cells = instance_data.0.len();
    sims.render_dirty = false;
}

pub struct SimsPlugin;

impl Plugin for SimsPlugin {
    fn build(&self, app: &mut bevy::prelude::App) {
        app.insert_resource(Sims::new())
            .add_systems(EguiPrimaryContextPass, ui_system)
            .add_systems(
                Update,
                (advance_simulation, sync_instances.after(advance_simulation)),
            );
    }
}

fn color_picker(ui: &mut egui::Ui, color: &mut Color) {
    let srgba = color.to_srgba();
    let mut value = [
        (srgba.red * 255.0) as u8,
        (srgba.green * 255.0) as u8,
        (srgba.blue * 255.0) as u8,
    ];
    egui::color_picker::color_edit_button_srgb(ui, &mut value);
    *color = Color::srgb_u8(value[0], value[1], value[2]);
}
