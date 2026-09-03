import * as THREE from "three";
import { type Card, RANK_LABEL, SUIT_SYMBOL } from "../game/cards.js";

const cache = new Map<string, THREE.Texture>();

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function cardFaceTexture(card: Card): THREE.Texture {
  const key = `face:${card.id}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const w = 256;
  const h = 358;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#f6f2e8";
  roundedRect(ctx, 0, 0, w, h, 22);
  ctx.fill();
  ctx.strokeStyle = "#c9c1b0";
  ctx.lineWidth = 4;
  roundedRect(ctx, 6, 6, w - 12, h - 12, 18);
  ctx.stroke();
  const red = card.suit === "H" || card.suit === "D";
  const color = red ? "#c8102e" : "#161616";
  const rank = RANK_LABEL[card.rank];
  const suit = SUIT_SYMBOL[card.suit];
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "bold 46px 'Georgia', serif";
  ctx.fillText(rank, 34, 40);
  ctx.font = "36px serif";
  ctx.fillText(suit, 34, 84);
  ctx.save();
  ctx.translate(w - 34, h - 40);
  ctx.rotate(Math.PI);
  ctx.font = "bold 46px 'Georgia', serif";
  ctx.fillText(rank, 0, 0);
  ctx.font = "36px serif";
  ctx.fillText(suit, 0, -44);
  ctx.restore();
  ctx.font = "150px serif";
  ctx.fillText(suit, w / 2, h / 2 + 8);
  // UP / DOWN tag
  const up = card.rank >= 8;
  ctx.font = "bold 22px sans-serif";
  ctx.fillStyle = up ? "#c8102e" : "#1e5bc6";
  ctx.fillText(up ? "UP" : "DOWN", w / 2, h - 30);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  cache.set(key, tex);
  return tex;
}

export function cardBackTexture(): THREE.Texture {
  const key = "back";
  const hit = cache.get(key);
  if (hit) return hit;
  const w = 256;
  const h = 358;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#f6f2e8";
  roundedRect(ctx, 0, 0, w, h, 22);
  ctx.fill();
  ctx.fillStyle = "#7a1020";
  roundedRect(ctx, 14, 14, w - 28, h - 28, 14);
  ctx.fill();
  ctx.strokeStyle = "#d4a24c";
  ctx.lineWidth = 3;
  roundedRect(ctx, 24, 24, w - 48, h - 48, 10);
  ctx.stroke();
  ctx.save();
  ctx.beginPath();
  ctx.rect(28, 28, w - 56, h - 56);
  ctx.clip();
  ctx.strokeStyle = "rgba(212,162,76,0.35)";
  ctx.lineWidth = 2;
  for (let i = -h; i < w + h; i += 18) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + h, h);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(i, h);
    ctx.lineTo(i + h, 0);
    ctx.stroke();
  }
  ctx.restore();
  ctx.fillStyle = "#d4a24c";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "bold 34px 'Georgia', serif";
  ctx.fillText("帝愛", w / 2, h / 2 - 8);
  ctx.font = "16px sans-serif";
  ctx.fillText("ONE POKER", w / 2, h / 2 + 30);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  cache.set(key, tex);
  return tex;
}

export function feltTexture(): THREE.Texture {
  const key = "felt";
  const hit = cache.get(key);
  if (hit) return hit;
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#0f4a2f";
  ctx.fillRect(0, 0, size, size);
  const img = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 18;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(4, 4);
  tex.colorSpace = THREE.SRGBColorSpace;
  cache.set(key, tex);
  return tex;
}

export function labelTexture(text: string, color = "#e8dcc0", bg = "rgba(0,0,0,0)"): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 512, 128);
  ctx.fillStyle = color;
  ctx.font = "bold 56px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 256, 64);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
