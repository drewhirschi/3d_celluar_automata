use bevy::math::IVec3;

#[allow(dead_code)]
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum NeighbourMethod {
    Moore,
    VonNeuman,
}

impl NeighbourMethod {
    pub fn get_neighbour_iter(&self) -> &'static [IVec3] {
        match self {
            NeighbourMethod::Moore => &MOOSE_NEIGHBOURS[..],
            NeighbourMethod::VonNeuman => &VONNEUMAN_NEIGHBOURS[..],
        }
    }
}

pub static VONNEUMAN_NEIGHBOURS: [IVec3; 6] = [
    IVec3::new(1, 0, 0),
    IVec3::new(-1, 0, 0),
    IVec3::new(0, 1, 0),
    IVec3::new(0, -1, 0),
    IVec3::new(0, 0, -1),
    IVec3::new(0, 0, 1),
];

pub static MOOSE_NEIGHBOURS: [IVec3; 26] = [
    IVec3::new(-1, -1, -1),
    IVec3::new(0, -1, -1),
    IVec3::new(1, -1, -1),
    IVec3::new(-1, 0, -1),
    IVec3::new(0, 0, -1),
    IVec3::new(1, 0, -1),
    IVec3::new(-1, 1, -1),
    IVec3::new(0, 1, -1),
    IVec3::new(1, 1, -1),
    IVec3::new(-1, -1, 0),
    IVec3::new(0, -1, 0),
    IVec3::new(1, -1, 0),
    IVec3::new(-1, 0, 0),
    IVec3::new(1, 0, 0),
    IVec3::new(-1, 1, 0),
    IVec3::new(0, 1, 0),
    IVec3::new(1, 1, 0),
    IVec3::new(-1, -1, 1),
    IVec3::new(0, -1, 1),
    IVec3::new(1, -1, 1),
    IVec3::new(-1, 0, 1),
    IVec3::new(0, 0, 1),
    IVec3::new(1, 0, 1),
    IVec3::new(-1, 1, 1),
    IVec3::new(0, 1, 1),
    IVec3::new(1, 1, 1),
];

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    #[test]
    fn neighborhoods_have_unique_symmetric_offsets() {
        for neighbors in [&VONNEUMAN_NEIGHBOURS[..], &MOOSE_NEIGHBOURS[..]] {
            let unique: HashSet<_> = neighbors.iter().copied().collect();
            assert_eq!(unique.len(), neighbors.len());
            assert!(!unique.contains(&IVec3::ZERO));
            for offset in neighbors {
                assert!(unique.contains(&-*offset));
            }
        }
    }
}
