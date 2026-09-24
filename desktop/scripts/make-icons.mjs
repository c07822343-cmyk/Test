// Generates the app and tray icons (run from the repo root: node desktop/scripts/make-icons.mjs).
import { writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
// Point-in-polygon for the "A" mark.
const inside = (x, y, poly) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if (((yi > y) !== (yj > y)) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
const A = [[[0.5, 0.2], [0.78, 0.8], [0.64, 0.8], [0.58, 0.66], [0.42, 0.66], [0.36, 0.8], [0.22, 0.8]], [[0.5, 0.38], [0.555, 0.54], [0.445, 0.54]]];

function draw(size, bg, { mark = true, shape = 'square', ring = null } = {}) {
  const png = new PNG({ width: size, height: size });
  const [r, g, b] = hex(bg);
  const ss = 4; // supersampling for smooth edges
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let cover = 0, white = 0, ringHit = 0;
    for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
      const u = (x + (sx + 0.5) / ss) / size, v = (y + (sy + 0.5) / ss) / size;
      let inShape;
      if (shape === 'circle') inShape = (u - 0.5) ** 2 + (v - 0.5) ** 2 <= 0.25;
      else { const rad = 0.22, cx = Math.min(Math.max(u, rad), 1 - rad), cy = Math.min(Math.max(v, rad), 1 - rad); inShape = (u - cx) ** 2 + (v - cy) ** 2 <= rad * rad; }
      if (!inShape) continue;
      cover++;
      if (ring && (u - 0.5) ** 2 + (v - 0.5) ** 2 > 0.16) ringHit++;
      else if (mark && inside(u, v, A[0]) && !inside(u, v, A[1])) white++;
    }
    const n = ss * ss, i = (y * size + x) * 4;
    const w = white / Math.max(cover, 1), rh = ringHit / Math.max(cover, 1);
    const [rr, rg, rb] = ring ? hex(ring) : [0, 0, 0];
    png.data[i] = Math.round(r * (1 - w - rh) + 255 * w + rr * rh);
    png.data[i + 1] = Math.round(g * (1 - w - rh) + 255 * w + rg * rh);
    png.data[i + 2] = Math.round(b * (1 - w - rh) + 255 * w + rb * rh);
    png.data[i + 3] = Math.round((cover / n) * 255);
  }
  return PNG.sync.write(png);
}

const out = new URL('../assets/', import.meta.url);
writeFileSync(new URL('icon.png', out), draw(512, '#4f46e5'));
writeFileSync(new URL('icon-256.png', out), draw(256, '#4f46e5'));
for (const [name, color] of [['ok', '#16a34a'], ['warn', '#d97706'], ['err', '#dc2626']]) {
  writeFileSync(new URL(`tray-${name}.png`, out), draw(32, '#4f46e5', { shape: 'circle', ring: color }));
  writeFileSync(new URL(`tray-${name}@2x.png`, out), draw(64, '#4f46e5', { shape: 'circle', ring: color }));
}
console.log('icons written');
