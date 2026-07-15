use bevy::{camera::visibility::NoFrustumCulling, prelude::*, window::WindowResolution};
use bevy_egui::EguiPlugin;

mod cell_renderer;
mod neighbours;
mod rotating_camera;
mod rule;
mod utils;
use cell_renderer::*;
use neighbours::NeighbourMethod;
use rotating_camera::{RotatingCamera, RotatingCameraPlugin};
use rule::*;

mod cells;
use cells::sims::Example;

fn main() {
    App::new()
        .add_plugins(DefaultPlugins.set(WindowPlugin {
            primary_window: Some(Window {
                title: "Cellular Automata".into(),
                resolution: web_window_resolution(),
                canvas: Some("#cellular-automata".into()),
                fit_canvas_to_parent: true,
                prevent_default_event_handling: false,
                ..default()
            }),
            ..default()
        }))
        .add_plugins(EguiPlugin::default())
        .insert_resource(ClearColor(Color::srgb(0.65, 0.9, 0.96)))
        .add_plugins((RotatingCameraPlugin, CellMaterialPlugin, cells::SimsPlugin))
        .add_systems(Startup, setup)
        .run();
}

fn web_window_resolution() -> WindowResolution {
    let resolution = WindowResolution::new(1280, 720);
    #[cfg(target_arch = "wasm32")]
    return resolution.with_scale_factor_override(1.0);
    #[cfg(not(target_arch = "wasm32"))]
    resolution
}

fn setup(mut commands: Commands, mut meshes: ResMut<Assets<Mesh>>, mut sims: ResMut<cells::Sims>) {
    sims.add_sim(
        "leddoo single-threaded".into(),
        Box::new(cells::leddoo::LeddooSingleThreaded::new()),
    );

    #[cfg(not(target_arch = "wasm32"))]
    {
        sims.add_sim(
            "tantan single-threaded".into(),
            Box::new(cells::tantan::CellsSinglethreaded::new()),
        );
        sims.add_sim(
            "tantan multi-threaded".into(),
            Box::new(cells::tantan::CellsMultithreaded::new()),
        );
        sims.add_sim(
            "leddoo atomic".into(),
            Box::new(cells::leddoo::LeddooAtomic::new()),
        );
    }

    sims.add_example(Example {
        name: "builder".into(),
        rule: Rule {
            survival_rule: Value::new(&[2, 6, 9]),
            birth_rule: Value::new(&[4, 6, 8, 9, 10]),
            states: 10,
            neighbour_method: NeighbourMethod::Moore,
        },
        color_method: ColorMethod::DistToCenter,
        color1: Color::srgb(1.0, 1.0, 0.0),
        color2: Color::srgb(1.0, 0.0, 0.0),
    });

    sims.add_example(Example {
        name: "VN pyramid".into(),
        rule: Rule {
            survival_rule: Value::from_range(0..=6),
            birth_rule: Value::new(&[1, 3]),
            states: 2,
            neighbour_method: NeighbourMethod::VonNeuman,
        },
        color_method: ColorMethod::DistToCenter,
        color1: Color::srgb(0.0, 1.0, 0.0),
        color2: Color::srgb(0.0, 0.0, 1.0),
    });

    sims.add_example(Example {
        name: "fancy snancy".into(),
        rule: Rule {
            survival_rule: Value::new(&[0, 1, 2, 3, 7, 8, 9, 11, 13, 18, 21, 22, 24, 26]),
            birth_rule: Value::new(&[4, 13, 17, 20, 21, 22, 23, 24, 26]),
            states: 4,
            neighbour_method: NeighbourMethod::Moore,
        },
        color_method: ColorMethod::StateLerp,
        color1: Color::srgb(1.0, 0.0, 0.0),
        color2: Color::srgb(0.0, 0.0, 1.0),
    });

    sims.add_example(Example {
        name: "pretty crystals".into(),
        rule: Rule {
            survival_rule: Value::new(&[5, 6, 7, 8]),
            birth_rule: Value::new(&[6, 7, 9]),
            states: 10,
            neighbour_method: NeighbourMethod::Moore,
        },
        color_method: ColorMethod::DistToCenter,
        color1: Color::srgb(0.0, 1.0, 0.0),
        color2: Color::srgb(0.0, 0.0, 1.0),
    });

    sims.add_example(Example {
        name: "swapping structures".into(),
        rule: Rule {
            survival_rule: Value::new(&[3, 6, 9]),
            birth_rule: Value::new(&[4, 8, 10]),
            states: 20,
            neighbour_method: NeighbourMethod::Moore,
        },
        color_method: ColorMethod::StateLerp,
        color1: Color::srgb(1.0, 0.0, 0.0),
        color2: Color::srgb(0.0, 1.0, 0.0),
    });

    sims.add_example(Example {
        name: "slowly expanding blob".into(),
        rule: Rule {
            survival_rule: Value::from_range(9..=26),
            birth_rule: Value::new(&[5, 6, 7, 12, 13, 15]),
            states: 20,
            neighbour_method: NeighbourMethod::Moore,
        },
        color_method: ColorMethod::StateLerp,
        color1: Color::srgb(1.0, 1.0, 0.0),
        color2: Color::srgb(0.0, 0.0, 1.0),
    });

    sims.add_example(Example {
        name: "445".into(),
        rule: Rule {
            survival_rule: Value::new(&[4]),
            birth_rule: Value::new(&[4]),
            states: 5,
            neighbour_method: NeighbourMethod::Moore,
        },
        color_method: ColorMethod::StateLerp,
        color1: Color::BLACK,
        color2: Color::srgb(1.0, 0.0, 0.0),
    });

    sims.add_example(Example {
        name: "expand then die".into(),
        rule: Rule {
            survival_rule: Value::new(&[4]),
            birth_rule: Value::new(&[3]),
            states: 20,
            neighbour_method: NeighbourMethod::Moore,
        },
        color_method: ColorMethod::StateLerp,
        color1: Color::BLACK,
        color2: Color::srgb(1.0, 0.0, 0.0),
    });

    sims.add_example(Example {
        name: "no idea what to call this".into(),
        rule: Rule {
            survival_rule: Value::new(&[6, 7]),
            birth_rule: Value::new(&[4, 6, 9, 10, 11]),
            states: 6,
            neighbour_method: NeighbourMethod::Moore,
        },
        color_method: ColorMethod::StateLerp,
        color1: Color::srgb(0.0, 0.0, 1.0),
        color2: Color::srgb(1.0, 0.0, 0.0),
    });

    sims.add_example(Example {
        name: "LARGE LINES".into(),
        rule: Rule {
            survival_rule: Value::new(&[5]),
            birth_rule: Value::new(&[4, 6, 9, 10, 11, 16, 17, 18, 19, 20, 21, 22, 23, 24]),
            states: 35,
            neighbour_method: NeighbourMethod::Moore,
        },
        color_method: ColorMethod::StateLerp,
        color1: Color::srgb(0.0, 0.0, 1.0),
        color2: Color::srgb(1.0, 0.0, 0.0),
    });

    sims.set_example(0);
    sims.set_sim(0);

    commands.spawn((
        Mesh3d(meshes.add(Cuboid::new(0.9, 0.9, 0.9))),
        InstanceMaterialData(
            (1..=10)
                .flat_map(|x| (1..=100).map(move |y| (x as f32 / 10.0, y as f32 / 10.0)))
                .map(|(x, y)| InstanceData {
                    position: Vec3::new(x * 10.0 - 5.0, y * 10.0 - 5.0, 0.0),
                    scale: 1.0,
                    color: LinearRgba::from(Color::hsla(x * 360., y, 0.5, 1.0)).to_f32_array(),
                })
                .collect(),
        ),
        // NOTE: Frustum culling is done based on the Aabb of the Mesh and the GlobalTransform.
        // As the cube is at the origin, if its Aabb moves outside the view frustum, all the
        // instanced cubes will be culled.
        // The InstanceMaterialData contains the 'GlobalTransform' information for this custom
        // instancing, and that is not taken into account with the built-in frustum culling.
        // We must disable the built-in frustum culling by adding the `NoFrustumCulling` marker
        // component to avoid incorrect culling.
        NoFrustumCulling,
    ));

    // camera
    commands.spawn((
        Camera3d::default(),
        Transform::from_xyz(0.0, 0.0, 150.0).looking_at(Vec3::ZERO, Vec3::Y),
        RotatingCamera::default(),
        no_indirect_drawing(),
    ));
}
