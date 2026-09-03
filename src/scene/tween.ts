import * as THREE from "three";

interface Tween {
  obj: THREE.Object3D;
  fromPos: THREE.Vector3;
  toPos: THREE.Vector3;
  fromRot: THREE.Euler;
  toRot: THREE.Euler;
  start: number;
  duration: number;
  arc: number;
  resolve: () => void;
}

const active: Tween[] = [];

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

export function tweenTo(
  obj: THREE.Object3D,
  toPos: THREE.Vector3,
  toRot: THREE.Euler,
  duration = 450,
  arc = 0
): Promise<void> {
  // cancel existing tween on this object
  for (let i = active.length - 1; i >= 0; i -= 1) {
    if (active[i].obj === obj) {
      active[i].resolve();
      active.splice(i, 1);
    }
  }
  return new Promise((resolve) => {
    active.push({
      obj,
      fromPos: obj.position.clone(),
      toPos: toPos.clone(),
      fromRot: obj.rotation.clone(),
      toRot: toRot.clone(),
      start: performance.now(),
      duration,
      arc,
      resolve
    });
  });
}

export function updateTweens(now: number): void {
  for (let i = active.length - 1; i >= 0; i -= 1) {
    const t = active[i];
    const raw = Math.min(1, (now - t.start) / t.duration);
    const k = easeInOut(raw);
    t.obj.position.lerpVectors(t.fromPos, t.toPos, k);
    t.obj.position.y += Math.sin(raw * Math.PI) * t.arc;
    t.obj.rotation.set(
      t.fromRot.x + (t.toRot.x - t.fromRot.x) * k,
      t.fromRot.y + (t.toRot.y - t.fromRot.y) * k,
      t.fromRot.z + (t.toRot.z - t.fromRot.z) * k
    );
    if (raw >= 1) {
      t.obj.position.copy(t.toPos);
      t.obj.rotation.copy(t.toRot);
      t.resolve();
      active.splice(i, 1);
    }
  }
}
