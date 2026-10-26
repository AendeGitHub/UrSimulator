// Procedural placeholder robot model (until the team CAD is imported).
// Robot frame: forward = +X, right = +Z, origin on the floor at the robot center.

import * as THREE from 'three';
import { NECTAR_RADIUS, POLLEN_RADIUS } from '../field/layout';
import type { WheelPowers } from '../robot/mecanum';
import type { Alliance, RobotConfig } from '../robot/robotConfig';
import type { BallColor, BallSpec } from '../sim/BallSim';
import { SHOOTER } from '../sim/Mechanisms';
import type { RobotState } from '../sim/state';
import { BALL_COLORS } from './BallsView';

const ALLIANCE_COLORS: Record<Alliance, string> = { red: '#d42a2a', blue: '#1f5fd6' };

/** Hopper positions (forward, right) for the 4 stored balls; slot 0 feeds the shooter next. */
const HOPPER_SLOTS: [number, number][] = [[0.03, -0.05], [0.03, 0.05], [0.12, -0.05], [0.12, 0.05]];
const HOPPER_Y = 0.15;
const TURRET_Y = 0.3;

function rollerTexture(flip: boolean): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#1b1d21';
  g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = '#3c4048';
  g.lineWidth = 9;
  for (let x = -64; x < c.width + 64; x += 26) {
    g.beginPath();
    g.moveTo(x, flip ? 0 : c.height);
    g.lineTo(x + 40, flip ? c.height : 0);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  return tex;
}

function signTexture(text: string, color: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = color;
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#ffffff';
  g.font = 'bold 84px system-ui, -apple-system, Segoe UI, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, c.width / 2, c.height / 2 + 4);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class RobotView {
  readonly root = new THREE.Group();
  private readonly wheels: Record<keyof WheelPowers, THREE.Object3D>;
  private readonly signs: THREE.Mesh[] = [];
  private readonly wheelSpin: Record<keyof WheelPowers, number> = { fl: 0, fr: 0, bl: 0, br: 0 };
  private readonly turret = new THREE.Group();
  private readonly hood = new THREE.Group();
  private readonly flywheel: THREE.Mesh;
  private readonly roller: THREE.Group;
  private readonly hopper: THREE.Mesh[] = [];
  private readonly ballMaterials = new Map<BallColor, THREE.Material>();
  private alliance: Alliance;
  private name: string;

  constructor(private readonly cfg: RobotConfig, alliance: Alliance, name: string) {
    this.alliance = alliance;
    this.name = name;
    const metal = new THREE.MeshStandardMaterial({ color: '#b9c0c9', metalness: 0.75, roughness: 0.35 });
    const dark = new THREE.MeshStandardMaterial({ color: '#2a2d33', metalness: 0.2, roughness: 0.6 });
    const L = cfg.length;
    const W = cfg.width;
    const r = cfg.wheelRadius;
    const box = (sx: number, sy: number, sz: number, mat: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = this.root) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      m.receiveShadow = true;
      parent.add(m);
      return m;
    };

    // Chassis: two side rails, front/back cross rails, base plate.
    const railZ = W / 2 - 0.075;
    box(L - 0.02, 0.048, 0.048, metal, 0, r, railZ);
    box(L - 0.02, 0.048, 0.048, metal, 0, r, -railZ);
    box(0.048, 0.048, 2 * railZ, metal, -L / 2 + 0.034, r, 0);
    box(L - 0.09, 0.006, 2 * railZ - 0.04, dark, 0, r - 0.02, 0);

    // Electronics on the back rail.
    box(0.1, 0.035, 0.15, new THREE.MeshStandardMaterial({ color: '#202226', roughness: 0.5 }), -L / 2 + 0.06, r + 0.045, 0.07);
    box(0.08, 0.05, 0.13, new THREE.MeshStandardMaterial({ color: '#2b2b2b', roughness: 0.8 }), -L / 2 + 0.06, r + 0.05, -0.08);
    const led = box(0.012, 0.006, 0.012, new THREE.MeshBasicMaterial({ color: '#35ff7a' }), -L / 2 + 0.06, r + 0.065, 0.12);
    led.castShadow = false;

    // Intake: roller of green compliant wheels across the front.
    this.roller = new THREE.Group();
    this.roller.position.set(L / 2 - 0.025, 0.065, 0);
    const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 2 * railZ, 10), metal);
    axle.rotation.x = Math.PI / 2;
    this.roller.add(axle);
    const flapGeo = new THREE.CylinderGeometry(0.032, 0.032, 0.025, 6);
    flapGeo.rotateX(Math.PI / 2);
    const flapMat = new THREE.MeshStandardMaterial({ color: '#3fbf5a', roughness: 0.7 });
    for (let i = -3; i <= 3; i++) {
      const flap = new THREE.Mesh(flapGeo, flapMat);
      flap.position.z = i * 0.05;
      flap.castShadow = true;
      this.roller.add(flap);
    }
    this.root.add(this.roller);

    // Hopper floor (polycarbonate ramp) and stored balls.
    const ramp = box(0.2, 0.004, 0.2, new THREE.MeshStandardMaterial({ color: '#9fb4c8', transparent: true, opacity: 0.35, roughness: 0.2 }), 0.075, HOPPER_Y - 0.04, 0);
    ramp.castShadow = false;
    for (const [f, rt] of HOPPER_SLOTS) {
      const ball = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14));
      ball.position.set(f, HOPPER_Y, rt);
      ball.castShadow = true;
      ball.visible = false;
      this.root.add(ball);
      this.hopper.push(ball);
    }

    // Turret with flywheel shooter and adjustable hood.
    const [tf, tr] = SHOOTER.turretAt;
    box(0.06, TURRET_Y - r - 0.02, 0.06, metal, tf, (TURRET_Y + r) / 2, tr);
    this.turret.position.set(tf, TURRET_Y, tr);
    this.root.add(this.turret);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.025, 32), new THREE.MeshStandardMaterial({ color: '#ffb000', metalness: 0.4, roughness: 0.4 }));
    base.castShadow = true;
    this.turret.add(base);
    box(0.13, 0.11, 0.012, metal, 0.02, 0.07, 0.055, this.turret);
    box(0.13, 0.11, 0.012, metal, 0.02, 0.07, -0.055, this.turret);
    this.flywheel = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.09, 24), new THREE.MeshStandardMaterial({ map: rollerTexture(false), roughness: 0.6 }));
    this.flywheel.rotation.x = Math.PI / 2;
    this.flywheel.position.set(0.0, 0.085, 0);
    this.turret.add(this.flywheel);
    this.hood.position.set(0.0, 0.13, 0);
    this.turret.add(this.hood);
    box(0.11, 0.008, 0.1, new THREE.MeshStandardMaterial({ color: '#1d1f24', roughness: 0.5 }), 0.055, 0, 0, this.hood);

    // Direction arrow on the turret base side so the front is obvious.
    const arrowShape = new THREE.Shape();
    arrowShape.moveTo(0.06, 0);
    arrowShape.lineTo(-0.02, 0.045);
    arrowShape.lineTo(-0.02, -0.045);
    arrowShape.closePath();
    const arrow = new THREE.Mesh(new THREE.ShapeGeometry(arrowShape), new THREE.MeshStandardMaterial({ color: '#ffd23f', roughness: 0.5, side: THREE.DoubleSide }));
    arrow.rotation.x = -Math.PI / 2;
    arrow.position.set(L / 2 - 0.05, r + 0.03, railZ - 0.03);
    this.root.add(arrow);

    // Mecanum wheels: rollers form an X when seen from above.
    const wheelGeo = new THREE.CylinderGeometry(r, r, 0.038, 28, 1);
    wheelGeo.rotateX(Math.PI / 2);
    const hubGeo = new THREE.CylinderGeometry(r * 0.45, r * 0.45, 0.042, 20);
    hubGeo.rotateX(Math.PI / 2);
    const hubMat = new THREE.MeshStandardMaterial({ color: '#ffb000', metalness: 0.4, roughness: 0.4 });
    const make = (x: number, z: number, flip: boolean) => {
      const wheel = new THREE.Group();
      const tire = new THREE.Mesh(wheelGeo, new THREE.MeshStandardMaterial({ map: rollerTexture(flip), roughness: 0.85 }));
      tire.castShadow = true;
      wheel.add(tire, new THREE.Mesh(hubGeo, hubMat));
      wheel.position.set(x, r, z);
      this.root.add(wheel);
      return wheel;
    };
    const wx = cfg.drive.wheelBase / 2;
    const wz = cfg.drive.trackWidth / 2;
    this.wheels = { fl: make(wx, -wz, false), fr: make(wx, wz, true), bl: make(-wx, -wz, true), br: make(-wx, wz, false) };

    // Robot signs (alliance color) on both sides.
    for (const side of [-1, 1]) {
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.075), new THREE.MeshStandardMaterial({ roughness: 0.6 }));
      sign.position.set(0, r + 0.075, side * (W / 2 - 0.004));
      sign.rotation.y = side > 0 ? 0 : Math.PI;
      this.root.add(sign);
      this.signs.push(sign);
    }
    this.paintSigns();
  }

  /** Robot signs show the alliance color and the driver's name. */
  setIdentity(alliance: Alliance, name: string): void {
    if (alliance === this.alliance && name === this.name) return;
    this.alliance = alliance;
    this.name = name;
    this.paintSigns();
  }

  private paintSigns(): void {
    for (const sign of this.signs) {
      const mat = sign.material as THREE.MeshStandardMaterial;
      mat.map?.dispose();
      mat.map = signTexture(this.name.slice(0, 12), ALLIANCE_COLORS[this.alliance]);
      mat.needsUpdate = true;
    }
  }

  dispose(): void {
    this.root.removeFromParent();
    this.root.traverse(obj => {
      if (obj instanceof THREE.Mesh) obj.geometry.dispose();
    });
  }

  private ballMaterial(color: BallColor): THREE.Material {
    let mat = this.ballMaterials.get(color);
    if (!mat) {
      mat = new THREE.MeshStandardMaterial({ color: BALL_COLORS[color], roughness: 0.5 });
      this.ballMaterials.set(color, mat);
    }
    return mat;
  }

  /** Places the robot, spins wheels, rollers and flywheel, points the turret, shows stored balls. */
  apply(s: RobotState, balls: BallSpec[], dt: number): void {
    this.root.position.set(s.x, 0.002, s.z);
    this.root.rotation.set(0, s.yaw, 0);
    const omega = this.cfg.drive.maxWheelSpeed / this.cfg.wheelRadius;
    for (const k of Object.keys(this.wheels) as (keyof WheelPowers)[]) {
      this.wheelSpin[k] -= s.powers[k] * omega * dt;
      this.wheels[k].rotation.z = this.wheelSpin[k];
    }
    this.roller.rotation.z += s.intakeDir * 25 * dt;
    this.flywheel.rotation.y += s.flywheel * 120 * dt;
    this.turret.rotation.y = s.turretYaw;
    this.hood.rotation.z = s.pitch * 0.6;
    this.hopper.forEach((mesh, i) => {
      const id = s.stored[i];
      const ball = id === undefined ? undefined : balls[id];
      mesh.visible = !!ball;
      if (!ball) return;
      mesh.material = this.ballMaterial(ball.color);
      mesh.scale.setScalar(ball.kind === 'pollen' ? POLLEN_RADIUS : NECTAR_RADIUS);
    });
  }
}
