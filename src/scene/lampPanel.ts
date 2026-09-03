import * as THREE from "three";
import { type Lights } from "../game/engine.js";

/**
 * The UP/DOWN indicator display from the manga: a standing panel with two glowing lamps,
 * one per card in hand. Red = UP (8..A), blue = DOWN (2..7).
 */
export class LampPanel {
  readonly group = new THREE.Group();
  private readonly canvas: HTMLCanvasElement;
  private readonly texture: THREE.CanvasTexture;
  private readonly lampMats: THREE.MeshStandardMaterial[] = [];
  private readonly glow: THREE.PointLight;
  private lights: Lights = { up: 0, down: 0 };
  private pulse = 0;

  constructor(private readonly title: string) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = 512;
    this.canvas.height = 256;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;

    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(1.7, 0.85, 0.08),
      new THREE.MeshStandardMaterial({ color: "#15131a", roughness: 0.35, metalness: 0.7 })
    );
    frame.castShadow = true;
    frame.position.y = 0.5;
    const screen = new THREE.Mesh(
      new THREE.PlaneGeometry(1.6, 0.75),
      new THREE.MeshBasicMaterial({ map: this.texture })
    );
    screen.position.set(0, 0.5, 0.045);
    const stand = new THREE.Mesh(
      new THREE.BoxGeometry(0.9, 0.08, 0.5),
      new THREE.MeshStandardMaterial({ color: "#26232d", roughness: 0.4, metalness: 0.6 })
    );
    stand.position.y = 0.04;
    stand.castShadow = true;
    const trim = new THREE.Mesh(
      new THREE.BoxGeometry(1.74, 0.03, 0.09),
      new THREE.MeshStandardMaterial({ color: "#d4a24c", emissive: "#d4a24c", emissiveIntensity: 0.6, metalness: 0.8, roughness: 0.3 })
    );
    trim.position.set(0, 0.94, 0);
    this.group.add(frame, screen, stand, trim);

    for (let i = 0; i < 2; i += 1) {
      const mat = new THREE.MeshStandardMaterial({ color: "#111", emissive: "#000", emissiveIntensity: 2.2, roughness: 0.2 });
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.11, 24, 20), mat);
      lamp.position.set(-0.42 + i * 0.84, 0.62, 0.1);
      this.group.add(lamp);
      this.lampMats.push(mat);
    }
    this.glow = new THREE.PointLight("#000000", 0, 3, 2);
    this.glow.position.set(0, 0.7, 0.5);
    this.group.add(this.glow);
    this.group.rotation.x = -0.28;
    this.draw();
  }

  setLights(lights: Lights): void {
    if (lights.up === this.lights.up && lights.down === this.lights.down) return;
    this.lights = { ...lights };
    this.pulse = 1;
    this.draw();
  }

  update(dt: number): void {
    this.pulse = Math.max(0, this.pulse - dt * 1.4);
    const { up, down } = this.lights;
    const total = up + down;
    const base = 1.6 + this.pulse * 2.4;
    this.lampMats.forEach((mat, i) => {
      if (i >= total) {
        mat.emissive.set("#000000");
        mat.color.set("#111");
      } else if (i < up) {
        mat.emissive.set("#ff2020");
        mat.color.set("#ff8080");
        mat.emissiveIntensity = base;
      } else {
        mat.emissive.set("#2060ff");
        mat.color.set("#80a8ff");
        mat.emissiveIntensity = base;
      }
    });
    if (total === 0) {
      this.glow.intensity = 0;
    } else {
      const c = up === total ? "#ff3030" : down === total ? "#3070ff" : "#c060ff";
      this.glow.color.set(c);
      this.glow.intensity = 1.2 + this.pulse * 3;
    }
  }

  private draw(): void {
    const ctx = this.canvas.getContext("2d")!;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, "#1b1820");
    bg.addColorStop(1, "#0a090d");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "rgba(212,162,76,0.5)";
    ctx.lineWidth = 3;
    ctx.strokeRect(8, 8, w - 16, h - 16);

    ctx.fillStyle = "#d4a24c";
    ctx.font = "bold 30px 'Helvetica Neue', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(this.title, w / 2, 40);

    const { up, down } = this.lights;
    const total = up + down;
    for (let i = 0; i < 2; i += 1) {
      const cx = w / 2 + (i === 0 ? -134 : 134);
      const cy = 118;
      const lit = i < total;
      const isUp = i < up;
      const color = !lit ? "#2a2a30" : isUp ? "#ff3b3b" : "#3b7bff";
      // halo
      if (lit) {
        const halo = ctx.createRadialGradient(cx, cy, 10, cx, cy, 70);
        halo.addColorStop(0, isUp ? "rgba(255,60,60,0.55)" : "rgba(60,120,255,0.55)");
        halo.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = halo;
        ctx.fillRect(cx - 70, cy - 70, 140, 140);
      }
      ctx.beginPath();
      ctx.arc(cx, cy, 34, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = "#555";
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.fillStyle = lit ? "#fff" : "#555";
      ctx.font = "bold 26px 'Helvetica Neue', sans-serif";
      ctx.fillText(lit ? (isUp ? "UP" : "DOWN") : "—", cx, cy + 66);
    }
    ctx.fillStyle = "#e8dcc0";
    ctx.font = "bold 24px 'Helvetica Neue', sans-serif";
    ctx.fillText(`UP ${up}   ·   DOWN ${down}`, w / 2, h - 26);
    this.texture.needsUpdate = true;
  }
}
