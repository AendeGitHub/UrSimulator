// The venue around the field: carpet, sided hall walls, two arena stands with seats,
// steel ceiling trusses with light rows and big logo banners. FTC drivers stand on the floor in
// the alliance area, so there are no FRC-style driver station walls.
// Field center is the origin; red drivers stand at -X, blue at +X, the audience side is +Z.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const HALL = { halfX: 15, halfZ: 13, height: 10 };
/** Brightness of hall surfaces compared to their real colours (the field gets the light). */
const HALL_DIM = 0.45;
const BLACK = new THREE.Color(0, 0, 0);
const FLOOR_Y = -0.016;

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, repeat?: [number, number]): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  if (repeat) {
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(...repeat);
  }
  tex.anisotropy = 16;
  return tex;
}

/** Event carpet: dark blue-grey with fibre noise. */
function carpetTexture(): THREE.CanvasTexture {
  let seed = 42;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  return canvasTexture(256, 256, g => {
    g.fillStyle = '#3d4558';
    g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 12000; i++) {
      const v = 55 + rand() * 40;
      g.fillStyle = `rgba(${v - 8},${v},${v + 24},0.45)`;
      g.fillRect(rand() * 256, rand() * 256, 1.5, 1.5);
    }
  }, [30, 26]);
}

/** Metal siding: light panels with deep horizontal grooves. */
function sidingTexture(): THREE.CanvasTexture {
  return canvasTexture(64, 256, g => {
    const grad = g.createLinearGradient(0, 0, 0, 64);
    grad.addColorStop(0, '#c5d0e2');
    grad.addColorStop(0.8, '#aebbd1');
    grad.addColorStop(1, '#7f8ca3');
    for (let y = 0; y < 256; y += 64) {
      g.fillStyle = grad;
      g.save();
      g.translate(0, y);
      g.fillRect(0, 0, 64, 64);
      g.restore();
      g.fillStyle = '#5d6980';
      g.fillRect(0, y + 60, 64, 4);
    }
  }, [16, 4]);
}

function bannerTexture(logo: HTMLImageElement | null, title: string, subtitle: string): THREE.CanvasTexture {
  return canvasTexture(1024, 400, g => {
    g.fillStyle = '#0b0f14';
    g.fillRect(0, 0, 1024, 400);
    // A banner without a title is just the logo, centered.
    if (logo && !title) {
      const scale = Math.min(960 / logo.width, 340 / logo.height);
      g.drawImage(logo, (1024 - logo.width * scale) / 2, (400 - logo.height * scale) / 2, logo.width * scale, logo.height * scale);
      return;
    }
    if (logo) g.drawImage(logo, 36, 40, 400, 320);
    g.fillStyle = '#ffffff';
    g.font = 'bold 110px system-ui, -apple-system, Segoe UI, sans-serif';
    g.textBaseline = 'middle';
    g.fillText(title, logo ? 470 : 60, 160);
    g.fillStyle = '#19b877';
    g.font = 'bold 50px system-ui, -apple-system, Segoe UI, sans-serif';
    g.fillText(subtitle, logo ? 476 : 64, 270);
  });
}

export class Arena {
  readonly root = new THREE.Group();
  private readonly metal = new THREE.MeshStandardMaterial({ color: '#4b515c', metalness: 0.7, roughness: 0.4 });

  constructor(scene: THREE.Scene) {
    this.buildFloor();
    this.buildWalls();
    this.buildBleachers(5.2, 1);
    this.buildBleachers(-5.2, -1);
    this.buildCeiling();
    this.buildBanners();
    this.mergeStatic();
    this.dim();
    scene.add(this.root);
  }

  /** The hall sits in the dark around the lit field: surfaces reflect much less light. */
  private dim(): void {
    this.root.traverse(obj => {
      if (!(obj instanceof THREE.Mesh)) return;
      const mat = obj.material as THREE.MeshStandardMaterial;
      // Lamps and logo banners glow on their own and stay bright.
      if (mat.emissiveIntensity > 0 && !mat.emissive.equals(BLACK)) return;
      mat.color.multiplyScalar(HALL_DIM);
    });
  }

  /**
   * The hall is hundreds of small boxes (trusses, steps, lamps). Drawn one by one they cost a
   * draw call each in every render pass, so boxes sharing a material become one mesh.
   */
  private mergeStatic(): void {
    this.root.updateMatrixWorld(true);
    const groups = new Map<THREE.Material, THREE.Mesh[]>();
    for (const obj of this.root.children) {
      if (!(obj instanceof THREE.Mesh) || obj instanceof THREE.InstancedMesh || Array.isArray(obj.material)) continue;
      const list = groups.get(obj.material) ?? [];
      list.push(obj);
      groups.set(obj.material, list);
    }
    for (const [material, meshes] of groups) {
      if (meshes.length < 2) continue;
      const merged = mergeGeometries(meshes.map(m => {
        const geo = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
        return geo.applyMatrix4(m.matrixWorld);
      }));
      if (!merged) continue;
      for (const m of meshes) {
        m.removeFromParent();
        m.geometry.dispose();
      }
      const mesh = new THREE.Mesh(merged, material);
      mesh.receiveShadow = true;
      this.root.add(mesh);
    }
  }

  private add<T extends THREE.Object3D>(obj: T): T {
    obj.traverse(o => {
      if (o instanceof THREE.Mesh) o.receiveShadow = true;
    });
    this.root.add(obj);
    return obj;
  }

  private box(size: [number, number, number], mat: THREE.Material, pos: [number, number, number]): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), mat);
    mesh.position.set(...pos);
    return this.add(mesh);
  }

  private buildFloor(): void {
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(HALL.halfX * 2, HALL.halfZ * 2), new THREE.MeshStandardMaterial({ map: carpetTexture(), roughness: 0.95 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = FLOOR_Y;
    this.add(floor);
  }

  private buildWalls(): void {
    const mat = new THREE.MeshStandardMaterial({ map: sidingTexture(), roughness: 0.6, metalness: 0.25 });
    const { halfX, halfZ, height } = HALL;
    for (const [w, x, z, ry] of [
      [halfX * 2, 0, -halfZ, 0],
      [halfX * 2, 0, halfZ, Math.PI],
      [halfZ * 2, -halfX, 0, Math.PI / 2],
      [halfZ * 2, halfX, 0, -Math.PI / 2],
    ] as const) {
      const wall = this.add(new THREE.Mesh(new THREE.PlaneGeometry(w, height), mat));
      wall.position.set(x, height / 2 + FLOOR_Y, z);
      wall.rotation.y = ry;
      // Dark kick plate along the bottom of each wall.
      const kick = this.add(new THREE.Mesh(new THREE.PlaneGeometry(w, 1.1), new THREE.MeshStandardMaterial({ color: '#2b3140', roughness: 0.8 })));
      kick.position.set(x * 0.999, 0.55 + FLOOR_Y, z * 0.999);
      kick.rotation.y = ry;
    }
  }

  /**
   * Arena stand along one long side. `side` = +1 faces the field from +Z, -1 from -Z.
   * Concrete steps, single plastic seats on pedestals, a glass front barrier with a rail and an
   * LED strip, aisle stairs with handrails. Everything repeated is instanced, so a stand costs a
   * handful of draw calls.
   */
  private buildBleachers(z0: number, side: 1 | -1): void {
    const rows = 10;
    const length = 22;
    const depth = 0.75;
    const rise = 0.4;
    const aisles = [-7.5, 0, 7.5];
    const aisleWidth = 1.2;
    const seatPitch = 0.52;
    const sections = [[-length / 2, aisles[0]], [aisles[0], aisles[1]], [aisles[1], aisles[2]], [aisles[2], length / 2]]
      .map(([a, b]) => [a + (a === -length / 2 ? 0.2 : aisleWidth / 2), b - (b === length / 2 ? 0.2 : aisleWidth / 2)]);
    // Seats face the field: -Z for the stand at +Z. Facing angle about Y for the instances.
    const facing = side > 0 ? 0 : Math.PI;

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), facing);
    const v = new THREE.Vector3();
    const s = new THREE.Vector3(1, 1, 1);

    // Concrete steps (each a solid block from the floor so the stand looks solid from the ends)
    // with a darker nosing on every step edge.
    const unit = new THREE.BoxGeometry(1, 1, 1);
    const steps = new THREE.InstancedMesh(unit, new THREE.MeshStandardMaterial({ color: '#8d9099', roughness: 0.9 }), rows);
    const nosing = new THREE.InstancedMesh(unit, new THREE.MeshStandardMaterial({ color: '#3a3d44', roughness: 0.7 }), rows);
    for (let i = 0; i < rows; i++) {
      const top = rise * (i + 1);
      const z = z0 + side * i * depth;
      steps.setMatrixAt(i, m.compose(v.set(0, top / 2 + FLOOR_Y, z), q.identity(), s.set(length, top, depth)));
      nosing.setMatrixAt(i, m.compose(v.set(0, top - 0.02 + FLOOR_Y, z - side * (depth / 2 - 0.02)), q, s.set(length, 0.04, 0.05)));
    }
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), facing);

    // One stadium seat: pan and slightly reclined back in plastic, a dark pedestal under it.
    const pan = new THREE.BoxGeometry(0.44, 0.05, 0.38).translate(0, 0.42, -0.02);
    const back = new THREE.BoxGeometry(0.44, 0.4, 0.05).rotateX(-0.12).translate(0, 0.66, 0.19);
    const seatGeo = mergeGeometries([pan, back])!;
    const pedestalGeo = new THREE.BoxGeometry(0.08, 0.4, 0.26).translate(0, 0.2, 0.04);

    const spots: THREE.Vector3[] = [];
    for (let i = 0; i < rows; i++) {
      const z = z0 + side * i * depth;
      const y = rise * (i + 1) + FLOOR_Y;
      for (const [a, b] of sections) {
        const n = Math.floor((b - a) / seatPitch);
        for (let k = 0; k < n; k++) spots.push(new THREE.Vector3(a + (k + 0.5) * ((b - a) / n), y, z + side * 0.06));
      }
    }
    const seatMat = new THREE.MeshStandardMaterial({ color: '#1f45d6', roughness: 0.45 });
    const seats = new THREE.InstancedMesh(seatGeo, seatMat, spots.length);
    const pedestals = new THREE.InstancedMesh(pedestalGeo, this.metal, spots.length);
    spots.forEach((p, i) => {
      m.compose(p, q, s.set(1, 1, 1));
      seats.setMatrixAt(i, m);
      pedestals.setMatrixAt(i, m);
    });

    for (const mesh of [steps, nosing, seats, pedestals]) {
      mesh.receiveShadow = true;
      this.root.add(mesh);
    }

    // Front of the stand: dark fascia with a glowing LED strip, glass barrier and top rail.
    const front = z0 - side * (depth / 2 + 0.02);
    this.box([length, 0.5, 0.04], new THREE.MeshStandardMaterial({ color: '#16181d', roughness: 0.6 }), [0, 0.25 + FLOOR_Y, front]);
    this.box([length, 0.04, 0.02], new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#7fb2ff', emissiveIntensity: 1.6 }), [0, 0.44 + FLOOR_Y, front - side * 0.015]);
    this.box([length, 0.9, 0.015], new THREE.MeshStandardMaterial({ color: '#cfe3ff', transparent: true, opacity: 0.12, roughness: 0.05, depthWrite: false }), [0, 0.95 + FLOOR_Y, front]);
    this.box([length, 0.05, 0.06], this.metal, [0, 1.42 + FLOOR_Y, front]);

    // Aisle stairs (half steps) with handrails down the middle.
    const stairMat = new THREE.MeshStandardMaterial({ color: '#6f737c', roughness: 0.9 });
    for (const x of aisles) {
      for (let i = 0; i < rows; i++) {
        const z = z0 + side * i * depth;
        this.box([aisleWidth - 0.1, 0.04, depth / 2], stairMat, [x, rise * i + rise / 2 + FLOOR_Y + 0.02, z - side * depth / 4]);
      }
      const railLen = Math.hypot(rows * depth, rows * rise);
      const rail = this.box([0.05, 0.05, railLen], this.metal, [x, (rows * rise) / 2 + 0.95 + FLOOR_Y, z0 + side * (rows - 1) * depth / 2]);
      rail.rotation.x = side * Math.atan2(rows * rise, rows * depth);
      for (let i = 0; i < rows; i += 3) {
        this.box([0.04, 0.95, 0.04], this.metal, [x, rise * (i + 1) + 0.47 + FLOOR_Y, z0 + side * i * depth]);
      }
    }
    // Back wall and railing behind the top row.
    const backZ = z0 + side * (rows - 0.5) * depth;
    this.box([length, 1.2, 0.08], new THREE.MeshStandardMaterial({ color: '#2a2d34', roughness: 0.8 }), [0, rise * rows + 0.6 + FLOOR_Y, backZ + side * 0.04]);
    this.box([length, 0.05, 0.05], this.metal, [0, rise * rows + 1.0 + FLOOR_Y, backZ]);
  }

  private buildCeiling(): void {
    const { halfX, halfZ, height } = HALL;
    const ceiling = this.add(new THREE.Mesh(new THREE.PlaneGeometry(halfX * 2, halfZ * 2), new THREE.MeshStandardMaterial({ color: '#2c3240', roughness: 1 })));
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.y = height + FLOOR_Y;

    // Steel trusses spanning the hall (top and bottom chords with diagonals).
    const span = halfZ * 2;
    const trussDepth = 0.9;
    const lampMat = new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#fff4dc', emissiveIntensity: 2.5 });
    for (let x = -halfX + 2.5; x <= halfX - 2.5; x += 5) {
      const top = height - 0.25 + FLOOR_Y;
      const bottom = top - trussDepth;
      this.box([0.18, 0.18, span], this.metal, [x, top, 0]);
      this.box([0.18, 0.18, span], this.metal, [x, bottom, 0]);
      const bays = 16;
      for (let i = 0; i < bays; i++) {
        const z = -span / 2 + (i + 0.5) * (span / bays);
        const diag = this.box([0.07, Math.hypot(trussDepth, span / bays), 0.07], this.metal, [x, (top + bottom) / 2, z]);
        diag.rotation.x = (i % 2 ? 1 : -1) * Math.atan2(span / bays, trussDepth);
      }
      for (let z = -halfZ + 3; z <= halfZ - 3; z += 3.5) {
        this.box([1.4, 0.1, 0.5], lampMat, [x, bottom - 0.15, z]);
      }
    }
  }

  private buildBanners(): void {
    const make = (src: string, title: string, subtitle: string, width: number, pos: [number, number, number], ry: number) => {
      const mat = new THREE.MeshStandardMaterial({ map: bannerTexture(null, title, subtitle), roughness: 0.7, emissive: '#ffffff', emissiveIntensity: 0.25 });
      mat.emissiveMap = mat.map;
      const banner = this.add(new THREE.Mesh(new THREE.PlaneGeometry(width, width * 0.39), mat));
      banner.position.set(...pos);
      banner.rotation.y = ry;
      const logo = new Image();
      logo.onload = () => {
        mat.map?.dispose();
        mat.map = bannerTexture(logo, title, subtitle);
        mat.emissiveMap = mat.map;
        mat.needsUpdate = true;
      };
      logo.src = src;
    };
    make('assets/biobuzz.webp', '', '', 10, [-HALL.halfX + 0.05, 5.6, 0], Math.PI / 2);
    make('assets/logo.svg', 'UrSim', 'Симулятор FIRST Tech Challenge', 8, [HALL.halfX - 0.05, 5.6, 0], -Math.PI / 2);
  }
}
