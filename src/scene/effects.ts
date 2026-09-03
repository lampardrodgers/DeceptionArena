import * as THREE from "three";

interface Particle {
  vx: number;
  vy: number;
  vz: number;
  life: number;
}

/** Burst of glittering particles (confetti / sparks) used for round results. */
export class ParticleBurst {
  readonly points: THREE.Points;
  private readonly count = 420;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly particles: Particle[] = [];
  private active = false;
  private lastTime = 0;

  constructor(scene: THREE.Scene) {
    this.positions = new Float32Array(this.count * 3);
    this.colors = new Float32Array(this.count * 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(this.colors, 3));
    const material = new THREE.PointsMaterial({
      size: 0.07,
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    this.points = new THREE.Points(geometry, material);
    this.points.visible = false;
    this.points.frustumCulled = false;
    scene.add(this.points);
    for (let i = 0; i < this.count; i += 1) this.particles.push({ vx: 0, vy: 0, vz: 0, life: 0 });
  }

  burst(origin: THREE.Vector3, palette: THREE.Color[], spread = 1, up = 3.2): void {
    for (let i = 0; i < this.count; i += 1) {
      const p = this.particles[i];
      const angle = Math.random() * Math.PI * 2;
      const speed = (0.6 + Math.random() * 1.6) * spread;
      p.vx = Math.cos(angle) * speed;
      p.vz = Math.sin(angle) * speed;
      p.vy = up * (0.5 + Math.random());
      p.life = 1.6 + Math.random() * 1.2;
      this.positions[i * 3] = origin.x + (Math.random() - 0.5) * 0.3;
      this.positions[i * 3 + 1] = origin.y;
      this.positions[i * 3 + 2] = origin.z + (Math.random() - 0.5) * 0.3;
      const c = palette[Math.floor(Math.random() * palette.length)];
      this.colors[i * 3] = c.r;
      this.colors[i * 3 + 1] = c.g;
      this.colors[i * 3 + 2] = c.b;
    }
    (this.points.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.points.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    this.points.visible = true;
    this.active = true;
    this.lastTime = performance.now();
  }

  update(now: number): void {
    if (!this.active) return;
    const dt = Math.min(0.05, (now - this.lastTime) / 1000);
    this.lastTime = now;
    let alive = 0;
    for (let i = 0; i < this.count; i += 1) {
      const p = this.particles[i];
      if (p.life <= 0) continue;
      p.life -= dt;
      p.vy -= 4.5 * dt;
      p.vx *= 0.985;
      p.vz *= 0.985;
      const y = this.positions[i * 3 + 1] + p.vy * dt;
      this.positions[i * 3] += p.vx * dt;
      this.positions[i * 3 + 1] = y < 0.02 ? 0.02 : y;
      this.positions[i * 3 + 2] += p.vz * dt;
      if (y < 0.02) p.vy = Math.abs(p.vy) * 0.3;
      alive += 1;
    }
    (this.points.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    if (!alive) {
      this.active = false;
      this.points.visible = false;
    }
  }
}

/** Slowly drifting dust motes that catch the spotlights. */
export function makeDust(scene: THREE.Scene, count = 500): THREE.Points {
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    positions[i * 3] = (Math.random() - 0.5) * 14;
    positions[i * 3 + 1] = Math.random() * 6;
    positions[i * 3 + 2] = (Math.random() - 0.5) * 14;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({
    color: "#f2d9a0",
    size: 0.035,
    transparent: true,
    opacity: 0.35,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });
  const points = new THREE.Points(geometry, material);
  scene.add(points);
  return points;
}
