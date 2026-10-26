// Procedural texture for the 6×6 grid of grey FTC foam tiles.

import * as THREE from 'three';

export function createTileTexture(tiles = 6, pxPerTile = 340): THREE.CanvasTexture {
  const size = tiles * pxPerTile;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d')!;

  // Deterministic noise so the floor looks the same every run.
  let seed = 1234567;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

  for (let ty = 0; ty < tiles; ty++) {
    for (let tx = 0; tx < tiles; tx++) {
      const shade = 70 + Math.floor(rand() * 8);
      g.fillStyle = `rgb(${shade},${shade + 2},${shade + 5})`;
      g.fillRect(tx * pxPerTile, ty * pxPerTile, pxPerTile, pxPerTile);
      // Foam texture speckle.
      for (let i = 0; i < 1400; i++) {
        const v = shade + (rand() - 0.5) * 22;
        g.fillStyle = `rgba(${v},${v + 2},${v + 5},0.55)`;
        g.fillRect(tx * pxPerTile + rand() * pxPerTile, ty * pxPerTile + rand() * pxPerTile, 2, 2);
      }
    }
  }

  // Seams with the interlocking tabs of FTC tiles.
  g.strokeStyle = 'rgba(25,27,31,0.9)';
  g.lineWidth = 3;
  const tab = pxPerTile / 12;
  for (let i = 1; i < tiles; i++) {
    const p = i * pxPerTile;
    for (const vertical of [true, false]) {
      g.beginPath();
      for (let s = 0; s <= size; s += tab) {
        const offset = (Math.floor(s / tab) % 2) * 6 - 3;
        if (vertical) g.lineTo(p + offset, s);
        else g.lineTo(s, p + offset);
      }
      g.stroke();
    }
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}
