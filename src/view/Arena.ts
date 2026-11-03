// The venue around the field: carpet, sided hall walls with a band of windows, two blue bench
// stands, a vaulted roof of steel ribs and glass, a lighting truss over the field (the moving
// lights of view/FieldLights.ts hang from it) and big logo banners. FTC drivers stand on the floor
// in the alliance area, so there are no FRC-style driver station walls.
// Field center is the origin; red drivers stand at -X, blue at +X, the audience side is +Z.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { t } from '../ui/i18n';

/** Walls `height` high, then a barrel-vault roof across Z that rises to `apex` in the middle, m */
const HALL = { halfX: 15, halfZ: 13, height: 8, apex: 12.5 };
/** The roof's circle: radius from its span and rise, centre below the floor */
const VAULT_R = (HALL.halfZ ** 2 + (HALL.apex - HALL.height) ** 2) / (2 * (HALL.apex - HALL.height));
const VAULT_Y = HALL.apex - VAULT_R;
const VAULT_ANGLE = Math.asin(HALL.halfZ / VAULT_R);
/** The lighting truss over the field: a square ring, half size and height, m */
export const LIGHTING_TRUSS = { half: 3.2, y: 6.8 };
/** Brightness of hall surfaces compared to their real colours (the field gets the light). */
const HALL_DIM = 0.55;
/**
 * How much hall surfaces light themselves: the soft light of a hall from its roof, without a real
 * light that would also brighten the field.
 */
const HALL_GLOW = 0.45;
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

/** A point on the roof `angle` rad from the top, across the hall (y, z). */
function vaultPoint(angle: number): [number, number] {
  return [VAULT_Y + VAULT_R * Math.cos(angle) + FLOOR_Y, VAULT_R * Math.sin(angle)];
}

/** High windows along the side walls: dark panes in light frames. */
function windowTexture(): THREE.CanvasTexture {
  return canvasTexture(256, 64, g => {
    g.fillStyle = '#cfd8e6';
    g.fillRect(0, 0, 256, 64);
    g.fillStyle = '#16233a';
    for (let x = 0; x < 256; x += 64) {
      g.fillRect(x + 6, 6, 24, 52);
      g.fillRect(x + 34, 6, 24, 52);
    }
  }, [12, 1]);
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

  constructor(scene: THREE.Scene) {
    this.buildFloor();
    this.buildWalls();
    this.buildBleachers(5.2, 1);
    this.buildBleachers(-5.2, -1);
    this.buildRoof();
    this.buildLightingTruss();
    this.buildBanners();
    this.mergeStatic();
    this.dim();
    this.simplifyMaterials();
    // Drawn once a frame: no outline or ambient occlusion pass over the hall (view/ScreenEffects.ts).
    this.root.userData.noGBuffer = true;
    scene.add(this.root);
  }

  /**
   * The hall fills most of the screen but sits in the dark, so it gets the cheap Lambert shading
   * instead of the physically based one (no reflections, which nobody sees there anyway).
   */
  private simplifyMaterials(): void {
    const cheap = new Map<THREE.Material, THREE.MeshLambertMaterial>();
    this.root.traverse(obj => {
      if (!(obj instanceof THREE.Mesh) || !(obj.material instanceof THREE.MeshStandardMaterial)) return;
      const m = obj.material;
      let lambert = cheap.get(m);
      if (!lambert) {
        const glows = m.emissiveIntensity > 0 && !m.emissive.equals(BLACK);
        lambert = new THREE.MeshLambertMaterial({
          color: m.color, map: m.map,
          // Surfaces without a glow of their own get the hall's soft light (through their texture).
          emissive: glows ? m.emissive : m.color, emissiveMap: glows ? m.emissiveMap : m.map,
          emissiveIntensity: glows ? m.emissiveIntensity : HALL_GLOW,
          transparent: m.transparent, opacity: m.opacity, depthWrite: m.depthWrite, side: m.side,
        });
        cheap.set(m, lambert);
        m.dispose();
      }
      obj.material = lambert;
    });
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
      this.root.add(new THREE.Mesh(merged, material));
    }
  }

  /** Hall parts take no shadows: the spotlight only reaches the field and the floor around it. */
  private add<T extends THREE.Object3D>(obj: T): T {
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
    floor.receiveShadow = true;
    this.add(floor);
  }

  private buildWalls(): void {
    const { halfX, halfZ, height } = HALL;
    const kickMat = new THREE.MeshStandardMaterial({ color: '#2b3140', roughness: 0.8 });
    // Side walls up to the roof, with a band of windows under it.
    const siding = new THREE.MeshStandardMaterial({ map: sidingTexture(), roughness: 0.6, metalness: 0.25 });
    siding.map!.repeat.set(16, 3.2);
    const windows = new THREE.MeshStandardMaterial({ map: windowTexture(), emissive: '#1a2840', emissiveIntensity: 0.6, roughness: 0.3 });
    for (const [z, ry] of [[-halfZ, 0], [halfZ, Math.PI]] as const) {
      const wall = this.add(new THREE.Mesh(new THREE.PlaneGeometry(halfX * 2, height), siding));
      wall.position.set(0, height / 2 + FLOOR_Y, z);
      wall.rotation.y = ry;
      const band = this.add(new THREE.Mesh(new THREE.PlaneGeometry(halfX * 2, 1.4), windows));
      band.position.set(0, height - 1.1 + FLOOR_Y, z * 0.999);
      band.rotation.y = ry;
      const kick = this.add(new THREE.Mesh(new THREE.PlaneGeometry(halfX * 2, 1.1), kickMat));
      kick.position.set(0, 0.55 + FLOOR_Y, z * 0.998);
      kick.rotation.y = ry;
    }
    // End walls follow the roof's arch.
    const arch = new THREE.Shape();
    arch.moveTo(-halfZ, 0);
    arch.lineTo(halfZ, 0);
    arch.lineTo(halfZ, height);
    const steps = 24;
    for (let i = 1; i <= steps; i++) {
      const [y, z] = vaultPoint(VAULT_ANGLE - (2 * VAULT_ANGLE * i) / steps);
      arch.lineTo(z, y - FLOOR_Y);
    }
    arch.lineTo(-halfZ, 0);
    // The shape's UVs are in metres: one siding tile every 1.9 × 2.5 m, as on the side walls.
    const endSiding = new THREE.MeshStandardMaterial({ map: sidingTexture(), roughness: 0.6, metalness: 0.25 });
    endSiding.map!.repeat.set(1 / 1.9, 1 / 2.5);
    for (const [x, ry] of [[-halfX, Math.PI / 2], [halfX, -Math.PI / 2]] as const) {
      const wall = this.add(new THREE.Mesh(new THREE.ShapeGeometry(arch), endSiding));
      wall.position.set(x, FLOOR_Y, 0);
      wall.rotation.y = ry;
      const kick = this.add(new THREE.Mesh(new THREE.PlaneGeometry(halfZ * 2, 1.1), kickMat));
      kick.position.set(x * 0.999, 0.55 + FLOOR_Y, 0);
      kick.rotation.y = ry;
    }
  }

  /**
   * Arena stand along one long side. `side` = +1 faces the field from +Z, -1 from -Z.
   * Concrete steps with blue risers and long blue benches, a glass front barrier with a rail and
   * an LED strip, aisle stairs with handrails. Everything repeated is instanced, so a stand costs a
   * handful of draw calls.
   */
  private buildBleachers(z0: number, side: 1 | -1): void {
    const rows = 10;
    const length = 24;
    const depth = 0.8;
    const rise = 0.4;
    const aisles = [-8, 0, 8];
    const aisleWidth = 1.2;
    const sections = [[-length / 2, aisles[0]], [aisles[0], aisles[1]], [aisles[1], aisles[2]], [aisles[2], length / 2]]
      .map(([a, b]) => [a + (a === -length / 2 ? 0.2 : aisleWidth / 2), b - (b === length / 2 ? 0.2 : aisleWidth / 2)]);

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const v = new THREE.Vector3();
    const s = new THREE.Vector3(1, 1, 1);
    const unit = new THREE.BoxGeometry(1, 1, 1);
    // Bright stand blue that keeps its colour in the dim hall.
    const blue = new THREE.MeshStandardMaterial({ color: '#2457e0', emissive: '#0b1d5c', emissiveIntensity: 0.7, roughness: 0.5 });

    // Concrete steps (each a solid block from the floor so the stand looks solid from the ends).
    const steps = new THREE.InstancedMesh(unit, new THREE.MeshStandardMaterial({ color: '#9a9ea8', roughness: 0.9 }), rows);
    for (let i = 0; i < rows; i++) {
      const top = rise * (i + 1);
      steps.setMatrixAt(i, m.compose(v.set(0, top / 2 + FLOOR_Y, z0 + side * i * depth), q, s.set(length, top, depth)));
    }
    // Per row and section: a blue riser on the step's front and a long blue bench on top.
    const risers = new THREE.InstancedMesh(unit, blue, rows * sections.length);
    const benches = new THREE.InstancedMesh(unit, blue, rows * sections.length);
    let n = 0;
    for (let i = 0; i < rows; i++) {
      const z = z0 + side * i * depth;
      const top = rise * (i + 1) + FLOOR_Y;
      for (const [a, b] of sections) {
        const cx = (a + b) / 2;
        const w = b - a;
        risers.setMatrixAt(n, m.compose(v.set(cx, top - rise / 2, z - side * (depth / 2 + 0.005)), q, s.set(w, rise, 0.02)));
        benches.setMatrixAt(n, m.compose(v.set(cx, top + 0.4, z + side * 0.08), q, s.set(w, 0.06, 0.36)));
        n++;
      }
    }
    for (const mesh of [steps, risers, benches]) this.root.add(mesh);

    // Front of the stand: dark fascia with a glowing LED strip, glass barrier and top rail.
    const front = z0 - side * (depth / 2 + 0.02);
    this.box([length, 0.5, 0.04], new THREE.MeshStandardMaterial({ color: '#16181d', roughness: 0.6 }), [0, 0.25 + FLOOR_Y, front]);
    this.box([length, 0.04, 0.02], new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#7fb2ff', emissiveIntensity: 1.6 }), [0, 0.44 + FLOOR_Y, front - side * 0.015]);
    this.box([length, 0.9, 0.015], new THREE.MeshStandardMaterial({ color: '#cfe3ff', transparent: true, opacity: 0.12, roughness: 0.05, depthWrite: false }), [0, 0.95 + FLOOR_Y, front]);
    const rail = new THREE.MeshStandardMaterial({ color: '#dfe5ee', emissive: '#30343c', emissiveIntensity: 0.6, metalness: 0.6, roughness: 0.35 });
    this.box([length, 0.05, 0.06], rail, [0, 1.42 + FLOOR_Y, front]);

    // Aisle stairs (half steps) with handrails down the middle.
    const stairMat = new THREE.MeshStandardMaterial({ color: '#7d828c', roughness: 0.9 });
    for (const x of aisles) {
      for (let i = 0; i < rows; i++) {
        const z = z0 + side * i * depth;
        this.box([aisleWidth - 0.1, 0.04, depth / 2], stairMat, [x, rise * i + rise / 2 + FLOOR_Y + 0.02, z - side * depth / 4]);
      }
      const railLen = Math.hypot(rows * depth, rows * rise);
      const hand = this.box([0.05, 0.05, railLen], rail, [x, (rows * rise) / 2 + 0.95 + FLOOR_Y, z0 + side * (rows - 1) * depth / 2]);
      hand.rotation.x = side * Math.atan2(rows * rise, rows * depth);
      for (let i = 0; i < rows; i += 3) {
        this.box([0.04, 0.95, 0.04], rail, [x, rise * (i + 1) + 0.47 + FLOOR_Y, z0 + side * i * depth]);
      }
    }
    // Back wall and railing behind the top row.
    const backZ = z0 + side * (rows - 0.5) * depth;
    this.box([length, 1.2, 0.08], new THREE.MeshStandardMaterial({ color: '#2a2d34', roughness: 0.8 }), [0, rise * rows + 0.6 + FLOOR_Y, backZ + side * 0.04]);
    this.box([length, 0.05, 0.05], rail, [0, rise * rows + 1.0 + FLOOR_Y, backZ]);
  }

  /**
   * A barrel vault across the hall: glass (the night sky behind it) on a grid of light steel ribs
   * and purlins, with rows of lamps along every other rib.
   */
  private buildRoof(): void {
    const { halfX } = HALL;
    const glass = new THREE.Mesh(
      new THREE.CylinderGeometry(VAULT_R, VAULT_R, halfX * 2, 32, 1, true, Math.PI / 2 - VAULT_ANGLE, 2 * VAULT_ANGLE),
      new THREE.MeshStandardMaterial({ color: '#0d1626', emissive: '#111d33', emissiveIntensity: 1, roughness: 0.2, side: THREE.BackSide }));
    // The cylinder's axis turned from Y to X: its arc lies across the hall.
    glass.rotation.z = Math.PI / 2;
    glass.position.y = VAULT_Y + FLOOR_Y;
    this.add(glass);

    // Light steel, a little self-lit so the grid reads against the dark glass as in a real hall.
    const steel = new THREE.MeshStandardMaterial({ color: '#c3ccd8', emissive: '#7a8698', emissiveIntensity: 0.9, metalness: 0.5, roughness: 0.45 });
    const lampMat = new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#fff4dc', emissiveIntensity: 2.5 });
    const inset = 0.06;
    const ribs = 13;
    for (let i = 0; i < ribs; i++) {
      const x = -halfX + 0.1 + (i * (halfX * 2 - 0.2)) / (ribs - 1);
      const points: THREE.Vector3[] = [];
      for (let k = 0; k <= 16; k++) {
        const a = -VAULT_ANGLE + (2 * VAULT_ANGLE * k) / 16;
        const [y, z] = vaultPoint(a);
        points.push(new THREE.Vector3(x, y - inset, z * (1 - inset / VAULT_R)));
      }
      this.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 32, 0.09, 6), steel));
      if (i % 2 === 1) {
        for (const a of [-0.36, 0, 0.36]) {
          const [y, z] = vaultPoint(a);
          const lamp = this.box([0.6, 0.08, 0.9], lampMat, [x, y - 0.25, z]);
          lamp.rotation.x = -a;
        }
      }
    }
    const purlins = 12;
    for (let k = 0; k < purlins; k++) {
      const a = -VAULT_ANGLE + (2 * VAULT_ANGLE * (k + 0.5)) / purlins;
      const [y, z] = vaultPoint(a);
      const purlin = this.box([halfX * 2, 0.1, 0.1], steel, [0, y - inset, z]);
      purlin.rotation.x = -a;
    }
  }

  /** A square truss over the field: something for the moving lights to hang from, as at events. */
  private buildLightingTruss(): void {
    const { half, y } = LIGHTING_TRUSS;
    const truss = new THREE.MeshStandardMaterial({ color: '#2a2e35', metalness: 0.7, roughness: 0.4 });
    const depth = 0.4;
    for (const sx of [1, 0] as const) {
      for (const sign of [-1, 1]) {
        const len = half * 2 + 0.4;
        const pos = (dx: number, dy: number, dz: number): [number, number, number] =>
          sx ? [dx, y + dy, sign * half + dz] : [sign * half + dx, y + dy, dz];
        const size: [number, number, number] = sx ? [len, 0.06, 0.06] : [0.06, 0.06, len];
        for (const [dy, dd] of [[0, -depth / 2], [0, depth / 2], [depth, 0]] as const) {
          this.box(size, truss, sx ? pos(0, dy, dd) : pos(dd, dy, 0));
        }
      }
    }
    // Cables up to the roof at the corners.
    for (const x of [-half, half]) {
      for (const z of [-half, half]) {
        const [top] = vaultPoint(Math.asin(z / VAULT_R));
        this.box([0.02, top - y, 0.02], truss, [x, (top + y) / 2, z]);
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
    make('assets/logo.svg', 'UrSim', t('arena.subtitle'), 8, [HALL.halfX - 0.05, 5.6, 0], -Math.PI / 2);
  }
}
