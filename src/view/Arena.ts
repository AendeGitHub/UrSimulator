// The venue around the field: carpet, hall walls, bleachers, ceiling trusses with lights and a banner.
// Field center is the origin; the audience side is +Z.

import * as THREE from 'three';

const HALL = { halfX: 14, halfZ: 11, height: 9 };

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

/** Event carpet: blue-grey with fine fibre noise. */
function carpetTexture(): THREE.CanvasTexture {
  let seed = 42;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  return canvasTexture(256, 256, g => {
    g.fillStyle = '#4a5468';
    g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 9000; i++) {
      const v = 70 + rand() * 40;
      g.fillStyle = `rgba(${v - 10},${v},${v + 22},0.5)`;
      g.fillRect(rand() * 256, rand() * 256, 1.5, 1.5);
    }
  }, [24, 20]);
}

/** Painted block wall with horizontal panel seams. */
function wallTexture(): THREE.CanvasTexture {
  return canvasTexture(256, 256, g => {
    g.fillStyle = '#9aa7bd';
    g.fillRect(0, 0, 256, 256);
    g.fillStyle = '#8796ad';
    for (let y = 0; y < 256; y += 32) g.fillRect(0, y, 256, 3);
  }, [10, 3]);
}

function bannerTexture(logo: HTMLImageElement | null): THREE.CanvasTexture {
  return canvasTexture(1024, 384, g => {
    g.fillStyle = '#0d1117';
    g.fillRect(0, 0, 1024, 384);
    g.strokeStyle = '#018d59';
    g.lineWidth = 10;
    g.strokeRect(10, 10, 1004, 364);
    if (logo) g.drawImage(logo, 40, 52, 360, 280);
    g.fillStyle = '#ffffff';
    g.font = 'bold 120px system-ui, -apple-system, Segoe UI, sans-serif';
    g.textBaseline = 'middle';
    g.fillText('BIOBUZZ', 430, 150);
    g.fillStyle = '#19b877';
    g.font = 'bold 54px system-ui, -apple-system, Segoe UI, sans-serif';
    g.fillText('FTC 2026–2027 · UrSim', 436, 262);
  });
}

export class Arena {
  readonly root = new THREE.Group();

  constructor(scene: THREE.Scene) {
    this.buildFloor();
    this.buildWalls();
    this.buildBleachers();
    this.buildCeiling();
    this.buildBanner();
    scene.add(this.root);
  }

  private add(mesh: THREE.Mesh, shadows = false): THREE.Mesh {
    mesh.receiveShadow = true;
    mesh.castShadow = shadows;
    this.root.add(mesh);
    return mesh;
  }

  private buildFloor(): void {
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(HALL.halfX * 2, HALL.halfZ * 2),
      new THREE.MeshStandardMaterial({ map: carpetTexture(), roughness: 0.95 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.016;
    this.add(floor);
  }

  private buildWalls(): void {
    const mat = new THREE.MeshStandardMaterial({ map: wallTexture(), roughness: 0.9 });
    const { halfX, halfZ, height } = HALL;
    for (const [w, x, z, ry] of [
      [halfX * 2, 0, -halfZ, 0],
      [halfX * 2, 0, halfZ, Math.PI],
      [halfZ * 2, -halfX, 0, Math.PI / 2],
      [halfZ * 2, halfX, 0, -Math.PI / 2],
    ] as const) {
      const wall = this.add(new THREE.Mesh(new THREE.PlaneGeometry(w, height), mat));
      wall.position.set(x, height / 2 - 0.016, z);
      wall.rotation.y = ry;
    }
  }

  /** Stands along the audience side: wooden steps with blue bench seats. */
  private buildBleachers(): void {
    const rows = 9;
    const length = 18;
    const depth = 0.7;
    const rise = 0.42;
    const z0 = 4.6;
    const steps = new THREE.InstancedMesh(new THREE.BoxGeometry(length, rise, depth), new THREE.MeshStandardMaterial({ color: '#b98a55', roughness: 0.75 }), rows);
    const seats = new THREE.InstancedMesh(new THREE.BoxGeometry(length - 0.4, 0.08, 0.32), new THREE.MeshStandardMaterial({ color: '#2047c9', roughness: 0.5 }), rows);
    const m = new THREE.Matrix4();
    for (let i = 0; i < rows; i++) {
      // Each step is a full-height block so the stand looks solid from the side.
      const h = rise * (i + 1);
      m.compose(new THREE.Vector3(0, h / 2 - 0.016, z0 + i * depth), new THREE.Quaternion(), new THREE.Vector3(1, h / rise, 1));
      steps.setMatrixAt(i, m);
      m.makeTranslation(0, h + 0.03, z0 + i * depth - 0.12);
      seats.setMatrixAt(i, m);
    }
    for (const mesh of [steps, seats]) {
      mesh.receiveShadow = true;
      this.root.add(mesh);
    }
    // Railings on the open ends.
    const railMat = new THREE.MeshStandardMaterial({ color: '#2a2d33', metalness: 0.6, roughness: 0.4 });
    for (const x of [-length / 2 - 0.05, length / 2 + 0.05]) {
      for (let i = 0; i < rows; i += 2) {
        const post = this.add(new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1, 8), railMat));
        post.position.set(x, rise * (i + 1) + 0.5, z0 + i * depth);
      }
    }
  }

  private buildCeiling(): void {
    const { halfX, halfZ, height } = HALL;
    const ceiling = this.add(new THREE.Mesh(new THREE.PlaneGeometry(halfX * 2, halfZ * 2), new THREE.MeshStandardMaterial({ color: '#3a4150', roughness: 1 })));
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.y = height - 0.02;
    const beamMat = new THREE.MeshStandardMaterial({ color: '#59606d', metalness: 0.5, roughness: 0.5 });
    const lampMat = new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#fff6e0', emissiveIntensity: 2.2 });
    for (let x = -halfX + 3; x <= halfX - 3; x += 4) {
      const beam = this.add(new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.6, halfZ * 2), beamMat));
      beam.position.set(x, height - 0.7, 0);
      for (let z = -halfZ + 3; z <= halfZ - 3; z += 4) {
        const lamp = this.add(new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.08, 0.5), lampMat));
        lamp.position.set(x, height - 1.05, z);
      }
    }
  }

  private buildBanner(): void {
    const mat = new THREE.MeshStandardMaterial({ map: bannerTexture(null), roughness: 0.7, emissive: '#ffffff', emissiveIntensity: 0.15 });
    mat.emissiveMap = mat.map;
    const banner = this.add(new THREE.Mesh(new THREE.PlaneGeometry(8, 3), mat));
    banner.position.set(0, 4.6, -HALL.halfZ + 0.05);
    const logo = new Image();
    logo.onload = () => {
      mat.map?.dispose();
      mat.map = bannerTexture(logo);
      mat.emissiveMap = mat.map;
      mat.needsUpdate = true;
    };
    logo.src = 'assets/logo.svg';
  }
}
