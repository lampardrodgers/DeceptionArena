import * as THREE from "three";

/**
 * A small human figurine ("命" in One Poker): base, legs, torso, arms, head.
 * Geometry is shared; each call returns a lightweight Group.
 */
const geo = {
  base: new THREE.CylinderGeometry(0.11, 0.13, 0.03, 20),
  leg: new THREE.CylinderGeometry(0.028, 0.032, 0.16, 10),
  torso: new THREE.CylinderGeometry(0.055, 0.075, 0.2, 12),
  arm: new THREE.CylinderGeometry(0.02, 0.022, 0.16, 8),
  neck: new THREE.CylinderGeometry(0.02, 0.025, 0.03, 8),
  head: new THREE.SphereGeometry(0.052, 16, 14)
};

export function makeFigure(material: THREE.Material, baseMaterial: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  const add = (geometry: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rz = 0) => {
    const m = new THREE.Mesh(geometry, mat);
    m.position.set(x, y, z);
    m.rotation.z = rz;
    m.castShadow = true;
    g.add(m);
    return m;
  };
  add(geo.base, baseMaterial, 0, 0.015, 0);
  add(geo.leg, material, -0.035, 0.11, 0);
  add(geo.leg, material, 0.035, 0.11, 0);
  add(geo.torso, material, 0, 0.29, 0);
  add(geo.arm, material, -0.095, 0.3, 0, 0.25);
  add(geo.arm, material, 0.095, 0.3, 0, -0.25);
  add(geo.neck, material, 0, 0.405, 0);
  add(geo.head, material, 0, 0.465, 0);
  return g;
}

export const FIGURE_HEIGHT = 0.52;
