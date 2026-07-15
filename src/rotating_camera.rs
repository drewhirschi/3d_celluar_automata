use std::f32::consts::FRAC_PI_2;

use bevy::{
    ecs::schedule::common_conditions::not,
    input::mouse::{AccumulatedMouseMotion, AccumulatedMouseScroll, MouseScrollUnit},
    math::{vec3, Quat},
    prelude::*,
};
use bevy_egui::input::egui_wants_any_pointer_input;

#[derive(Component)]
pub struct RotatingCamera {
    pub yaw: f32,
    pub pitch: f32,
    pub speed: f32,
    pub dist: f32,
    pub center: Vec3,
}

impl Default for RotatingCamera {
    fn default() -> Self {
        Self {
            yaw: 0.0,
            pitch: -0.18,
            speed: 0.18,
            dist: 150.0,
            center: vec3(0.0, 0.0, 0.0),
        }
    }
}

pub struct RotatingCameraPlugin;

impl Plugin for RotatingCameraPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(
            Update,
            (
                camera_input.run_if(not(egui_wants_any_pointer_input)),
                update_camera,
            )
                .chain(),
        );
    }
}

fn camera_input(
    mut cameras: Query<&mut RotatingCamera>,
    mouse_buttons: Res<ButtonInput<MouseButton>>,
    mouse_motion: Res<AccumulatedMouseMotion>,
    mouse_scroll: Res<AccumulatedMouseScroll>,
    touches: Res<Touches>,
) {
    let active_touches: Vec<_> = touches.iter().collect();

    for mut camera in &mut cameras {
        if mouse_buttons.pressed(MouseButton::Left) {
            camera.yaw -= mouse_motion.delta.x * 0.006;
            camera.pitch = (camera.pitch - mouse_motion.delta.y * 0.006)
                .clamp(-FRAC_PI_2 + 0.05, FRAC_PI_2 - 0.05);
        }

        if mouse_scroll.delta.y != 0.0 {
            let scroll = match mouse_scroll.unit {
                MouseScrollUnit::Line => mouse_scroll.delta.y,
                MouseScrollUnit::Pixel => mouse_scroll.delta.y / 100.0,
            };
            camera.dist = (camera.dist * (-scroll * 0.12).exp()).clamp(20.0, 400.0);
        }

        match active_touches.as_slice() {
            [touch] => {
                let delta = touch.delta();
                camera.yaw -= delta.x * 0.006;
                camera.pitch =
                    (camera.pitch - delta.y * 0.006).clamp(-FRAC_PI_2 + 0.05, FRAC_PI_2 - 0.05);
            }
            [first, second, ..] => {
                let current_distance = first.position().distance(second.position());
                let previous_distance = first
                    .previous_position()
                    .distance(second.previous_position());
                if current_distance > 1.0 && previous_distance > 1.0 {
                    camera.dist =
                        (camera.dist * previous_distance / current_distance).clamp(20.0, 400.0);
                }
            }
            [] => {}
        }
    }
}

fn update_camera(mut cameras: Query<(&mut RotatingCamera, &mut Transform)>, time: Res<Time>) {
    for (mut camera, mut transform) in &mut cameras {
        camera.yaw += time.delta_secs() * camera.speed;
        let rotation = Quat::from_rotation_y(camera.yaw) * Quat::from_rotation_x(camera.pitch);
        transform.translation = camera.center + rotation * Vec3::Z * camera.dist;
        transform.look_at(camera.center, Vec3::Y);
    }
}
