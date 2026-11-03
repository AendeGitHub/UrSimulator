// Advertising in the hall, as around a football pitch: separate LED boards in front of the stands
// on both long sides of the field with the sponsors' logos (ui/sponsors.ts), every few seconds
// sliding on to the next logo, and "Robotics is a Sport" banners hanging from poles behind the
// drivers. The boards light themselves like real LED panels, so nothing here adds a light or a
// shadow: it is four meshes and two textures, loaded once.
// Field center is the origin; red drivers stand at -X, blue at +X, the audience side is +Z.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { SPONSORS } from '../ui/sponsors';

/** The hall's carpet (view/Arena.ts), m */
const FLOOR_Y = -0.016;
/** LED face: length, height, its bottom edge above the floor, m, and lean back from the field, rad */
export const FACE = { length: 2.6, height: 0.62, bottom: 0.06, lean: 0.1 };
/** Dark casing behind the face: how far it shows around the face, and its depth, m */
export const CASING = { margin: 0.03, depth: 0.08 };
/**
 * The middles of the boards (x, z): in a row along each long side, just in front of the stands
 * (their front is at |z| = 4.76; the audience camera sits at z = 4.3), apart from each other.
 */
export const BOARD_SPOTS: [number, number][] = [-4.8, -1.6, 1.6, 4.8].flatMap(x => [[x, -4.6], [x, 4.6]] as [number, number][]);
/** Texture pixels across a board's height */
const PANEL_PX = 192;
/** Each logo shows for HOLD, then the boards slide on to the next one in SLIDE, s */
const HOLD = 5;
const SLIDE = 0.8;
/** Panel backgrounds (top and bottom of a gradient), one per sponsor in turn */
const PANEL_COLORS: [string, string][] = [['#0b3a8f', '#04163d'], ['#07142e', '#020812'], ['#1b2130', '#07090d']];
/**
 * Hanging banners: picture, cloth size and its bottom edge above the floor (low enough for the
 * follow camera to see it whole), pole height, m
 */
export const BANNER = { src: 'assets/banners/robotics-is-a-sport.png', width: 0.8, height: 1.4, bottom: 0.8, pole: 2.35 };
/** Two banners behind each alliance's drivers (they stand at x = ±2.75), either side of the HIVE, (x, z) */
export const BANNER_SPOTS: [number, number][] = [[-4.3, -2.2], [-4.3, 2.2], [4.3, -2.2], [4.3, 2.2]];

const loadImage = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = reject;
  img.src = src;
});

/** The sponsors' panels side by side; each logo is drawn in once its picture has loaded (the name until then). */
function ledTexture(panelWidth: number, height: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = panelWidth * SPONSORS.length;
  canvas.height = height;
  const g = canvas.getContext('2d')!;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  const draw = (logos: (HTMLImageElement | null)[]) => {
    SPONSORS.forEach((sponsor, i) => {
      const x0 = i * panelWidth;
      const [top, bottom] = PANEL_COLORS[i % PANEL_COLORS.length];
      const bg = g.createLinearGradient(0, 0, 0, height);
      bg.addColorStop(0, top);
      bg.addColorStop(1, bottom);
      g.fillStyle = bg;
      g.fillRect(x0, 0, panelWidth, height);
      // The LED rows along the panel's edges catch the light.
      g.fillStyle = 'rgba(140, 180, 255, 0.35)';
      g.fillRect(x0, 0, panelWidth, 3);
      g.fillRect(x0, height - 3, panelWidth, 3);
      const logo = logos[i];
      if (logo) {
        const scale = Math.min((panelWidth * 0.78) / logo.width, (height * (sponsor.square ? 0.86 : 0.58)) / logo.height);
        const w = logo.width * scale;
        const h = logo.height * scale;
        g.drawImage(logo, x0 + (panelWidth - w) / 2, (height - h) / 2, w, h);
      } else {
        g.fillStyle = '#ffffff';
        g.font = `800 ${Math.round(height * 0.3)}px system-ui, -apple-system, Segoe UI, sans-serif`;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(sponsor.name.toUpperCase(), x0 + panelWidth / 2, height / 2);
      }
    });
    texture.needsUpdate = true;
  };
  draw([]);
  void Promise.all(SPONSORS.map(s => loadImage(s.src).catch(() => null))).then(draw);
  return texture;
}

export class HallAds {
  readonly root = new THREE.Group();
  private readonly ledTexture: THREE.CanvasTexture;
  private time = 0;

  constructor(scene: THREE.Scene) {
    this.ledTexture = this.buildBoards();
    this.buildBanners();
    // No outlines or ambient occlusion, like the rest of the hall (view/ScreenEffects.ts).
    this.root.userData.noGBuffer = true;
    scene.add(this.root);
  }

  /** Every few seconds every board slides one logo on, like LED boards changing adverts. */
  update(dt: number): void {
    this.time += dt;
    const n = SPONSORS.length;
    const cycle = HOLD + SLIDE;
    const step = Math.floor(this.time / cycle);
    const t = Math.min(1, Math.max(0, (this.time - step * cycle - HOLD) / SLIDE));
    this.ledTexture.offset.x = ((step % n) + t * t * (3 - 2 * t)) / n;
  }

  private buildBoards(): THREE.CanvasTexture {
    const n = SPONSORS.length;
    const texture = ledTexture(Math.round((PANEL_PX * FACE.length) / FACE.height), PANEL_PX);
    const faces: THREE.BufferGeometry[] = [];
    const casings: THREE.BufferGeometry[] = [];
    const place = new THREE.Matrix4();
    const turn = new THREE.Quaternion();
    const euler = new THREE.Euler();
    const at = new THREE.Vector3();
    const one = new THREE.Vector3(1, 1, 1);
    BOARD_SPOTS.forEach(([x, z], i) => {
      // On the floor, turned to the field and leaning back a little.
      euler.set(-FACE.lean, z < 0 ? 0 : Math.PI, 0, 'YXZ');
      place.compose(at.set(x, FLOOR_Y, z), turn.setFromEuler(euler), one);
      const face = new THREE.PlaneGeometry(FACE.length, FACE.height);
      face.translate(0, FACE.bottom + FACE.height / 2, 0.003);
      // One sponsor's panel of the texture; neighbouring boards show different sponsors.
      const uv = face.getAttribute('uv');
      for (let k = 0; k < uv.count; k++) uv.setX(k, ((i % n) + uv.getX(k)) / n);
      faces.push(face.applyMatrix4(place));
      const w = FACE.length + 2 * CASING.margin;
      const h = FACE.bottom + FACE.height + CASING.margin;
      casings.push(new THREE.BoxGeometry(w, h, CASING.depth).translate(0, h / 2, -CASING.depth / 2).applyMatrix4(place));
    });
    // Lit by itself, like the timer screen (view/TimerScreens.ts).
    const led = new THREE.Mesh(mergeGeometries(faces)!, new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }));
    const casing = new THREE.Mesh(mergeGeometries(casings)!, new THREE.MeshLambertMaterial({ color: '#15171c' }));
    this.root.add(led, casing);
    return texture;
  }

  /** Each banner hangs between two arms off a pole on its outer side, facing the field. */
  private buildBanners(): void {
    const { width, height, bottom, pole } = BANNER;
    const cloth: THREE.BufferGeometry[] = [];
    const metal: THREE.BufferGeometry[] = [];
    const place = new THREE.Matrix4();
    for (const [x, z] of BANNER_SPOTS) {
      const yaw = x < 0 ? Math.PI / 2 : -Math.PI / 2;
      // The pole on the side away from the HIVE.
      const side = Math.sign(-Math.sin(yaw) * z) || 1;
      place.makeRotationY(yaw).setPosition(x, FLOOR_Y, z);
      // The cloth bows back a little between the arms.
      const sheet = new THREE.PlaneGeometry(width, height, 6, 1);
      const pos = sheet.getAttribute('position');
      for (let k = 0; k < pos.count; k++) pos.setZ(k, -0.05 * Math.cos((Math.PI * pos.getX(k)) / width));
      sheet.computeVertexNormals();
      cloth.push(sheet.translate(0, bottom + height / 2, 0).applyMatrix4(place));
      const poleX = side * (width / 2 + 0.04);
      metal.push(
        new THREE.CylinderGeometry(0.022, 0.028, pole, 8).translate(poleX, pole / 2, 0).applyMatrix4(place),
        new THREE.SphereGeometry(0.045, 10, 6).translate(poleX, pole + 0.03, 0).applyMatrix4(place),
        new THREE.CylinderGeometry(0.16, 0.19, 0.04, 16).translate(poleX, 0.02, 0).applyMatrix4(place),
      );
      for (const y of [bottom, bottom + height]) {
        metal.push(new THREE.CylinderGeometry(0.014, 0.014, width + 0.04, 6).rotateZ(Math.PI / 2).translate(side * 0.02, y, 0).applyMatrix4(place));
      }
    }
    const picture = new THREE.TextureLoader().load(BANNER.src);
    picture.colorSpace = THREE.SRGBColorSpace;
    picture.anisotropy = 8;
    // A printed banner in the dim hall: lit by the hall, plus some glow of its own so the white reads.
    const clothMat = new THREE.MeshLambertMaterial({ map: picture, emissive: '#ffffff', emissiveMap: picture, emissiveIntensity: 0.55 });
    const steel = new THREE.MeshLambertMaterial({ color: '#b9c1cc', emissive: '#30343c' });
    this.root.add(new THREE.Mesh(mergeGeometries(cloth)!, clothMat), new THREE.Mesh(mergeGeometries(metal)!, steel));
  }
}
