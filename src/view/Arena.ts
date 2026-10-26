// The venue around the field: carpet, sided hall walls, two sets of bleachers with aisles,
// steel ceiling trusses with light rows, driver stations and big logo banners.
// Field center is the origin; red drivers stand at -X, blue at +X, the audience side is +Z.

import * as THREE from 'three';

const HALL = { halfX: 15, halfZ: 13, height: 10 };
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
  tex.anisotropy = 8;
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
    this.buildDriverStation('red');
    this.buildDriverStation('blue');
    this.buildCeiling();
    this.buildBanners();
    scene.add(this.root);
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
   * Bleachers along one long side. `side` = +1 faces the field from +Z, -1 from -Z.
   * Wooden risers, blue bench seats with backs, aisle stairs with black handrails.
   */
  private buildBleachers(z0: number, side: 1 | -1): void {
    const rows = 10;
    const length = 22;
    const depth = 0.75;
    const rise = 0.4;
    const aisles = [-7.5, 0, 7.5];
    const sections = [[-length / 2, aisles[0] - 0.6], [aisles[0] + 0.6, aisles[1] - 0.6], [aisles[1] + 0.6, aisles[2] - 0.6], [aisles[2] + 0.6, length / 2]];

    const riserMat = new THREE.MeshStandardMaterial({ color: '#c49a63', roughness: 0.7 });
    const frontMat = new THREE.MeshStandardMaterial({ color: '#8c6a40', roughness: 0.8 });
    const seatMat = new THREE.MeshStandardMaterial({ color: '#1f45d6', roughness: 0.45, metalness: 0.1 });
    const unit = new THREE.BoxGeometry(1, 1, 1);
    const count = rows * sections.length;
    const risers = new THREE.InstancedMesh(unit, riserMat, rows);
    const fronts = new THREE.InstancedMesh(unit, frontMat, rows);
    const seats = new THREE.InstancedMesh(unit, seatMat, count);
    const backs = new THREE.InstancedMesh(unit, seatMat, count);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const v = new THREE.Vector3();
    const s = new THREE.Vector3();
    let k = 0;
    for (let i = 0; i < rows; i++) {
      const top = rise * (i + 1);
      const z = z0 + side * i * depth;
      // Each step is a solid block from the floor so the stand looks solid from the ends.
      risers.setMatrixAt(i, m.compose(v.set(0, top / 2 + FLOOR_Y, z), q, s.set(length, top, depth)));
      fronts.setMatrixAt(i, m.compose(v.set(0, top - 0.06 + FLOOR_Y, z - side * (depth / 2 - 0.01)), q, s.set(length, 0.12, 0.02)));
      for (const [a, b] of sections) {
        const cx = (a + b) / 2;
        const w = b - a;
        seats.setMatrixAt(k, m.compose(v.set(cx, top + 0.05 + FLOOR_Y, z - side * 0.12), q, s.set(w, 0.07, 0.34)));
        backs.setMatrixAt(k, m.compose(v.set(cx, top + 0.22 + FLOOR_Y, z + side * 0.06), q, s.set(w, 0.3, 0.05)));
        k++;
      }
    }
    for (const mesh of [risers, fronts, seats, backs]) {
      mesh.receiveShadow = true;
      this.root.add(mesh);
    }

    // Aisle stairs (half steps) with handrails down the middle.
    const stairMat = new THREE.MeshStandardMaterial({ color: '#d7b27c', roughness: 0.7 });
    for (const x of aisles) {
      for (let i = 0; i < rows; i++) {
        const z = z0 + side * i * depth;
        this.box([1.1, 0.04, depth / 2], stairMat, [x, rise * i + rise / 2 + FLOOR_Y + 0.02, z - side * depth / 4]);
      }
      const railLen = Math.hypot(rows * depth, rows * rise);
      const rail = this.box([0.05, 0.05, railLen], this.metal, [x, (rows * rise) / 2 + 0.95 + FLOOR_Y, z0 + side * (rows - 1) * depth / 2]);
      rail.rotation.x = side * Math.atan2(rows * rise, rows * depth);
      for (let i = 0; i < rows; i += 3) {
        this.box([0.04, 0.95, 0.04], this.metal, [x, rise * (i + 1) + 0.47 + FLOOR_Y, z0 + side * i * depth]);
      }
    }
    // Back railing along the top row.
    this.box([length, 0.05, 0.05], this.metal, [0, rise * rows + 1.0 + FLOOR_Y, z0 + side * (rows - 0.5) * depth]);
  }

  /** Alliance driver station wall with a shelf, behind the alliance area. */
  private buildDriverStation(alliance: 'red' | 'blue'): void {
    const sx = alliance === 'red' ? -1 : 1;
    const color = alliance === 'red' ? '#c62828' : '#1f4fd1';
    const x = sx * 3.55;
    const wallMat = new THREE.MeshStandardMaterial({ color, roughness: 0.55 });
    const glassMat = new THREE.MeshStandardMaterial({ color: '#cfe3ff', transparent: true, opacity: 0.18, roughness: 0.1, depthWrite: false });
    this.box([0.08, 0.9, 3.6], wallMat, [x, 0.45 + FLOOR_Y, 0]);
    this.box([0.03, 0.9, 3.6], glassMat, [x, 1.35 + FLOOR_Y, 0]);
    this.box([0.6, 0.04, 3.4], new THREE.MeshStandardMaterial({ color: '#2b2f36', roughness: 0.6 }), [x - sx * 0.3, 0.92 + FLOOR_Y, 0]);
    for (const z of [-1.8, 1.8]) this.box([0.06, 1.8, 0.06], this.metal, [x, 0.9 + FLOOR_Y, z]);
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
    const make = (title: string, subtitle: string, width: number, pos: [number, number, number], ry: number) => {
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
      logo.src = 'assets/logo.svg';
    };
    make('BIOBUZZ', 'FTC 2026–2027 · UrSim', 10, [-HALL.halfX + 0.05, 5.6, 0], Math.PI / 2);
    make('UrSim', 'Симулятор FIRST Tech Challenge', 8, [HALL.halfX - 0.05, 5.6, 0], -Math.PI / 2);
  }
}
