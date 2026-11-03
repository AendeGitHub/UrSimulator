// Field lighting (Settings → Graphics → Field lights). "On": LED strips along the top of the
// perimeter wall in the alliance colours, breathing slowly. "Final": the strips plus eight moving
// heads on the truss over the field (view/Arena.ts) running a synchronised show like a final at an
// event: sweeps, circles, crossing beams, fans and chases, and every few seconds all of them
// swing onto the robots, which two real spotlights then light up.

import * as THREE from 'three';
import { LIGHTING_TRUSS } from './Arena';

export type FieldLightMode = 'off' | 'on' | 'final';

export interface LitRobot {
  x: number;
  z: number;
}

const RED = new THREE.Color('#ff2a2a');
const BLUE = new THREE.Color('#2b6bff');
/** White beams add up in every channel, so they shine much brighter than the coloured ones: toned down. */
const WHITE = new THREE.Color('#ffffff').multiplyScalar(0.4);
const PURPLE = new THREE.Color('#b44dff');
const AMBER = new THREE.Color('#ffb347');

/** The top of the perimeter wall (FTC walls are 12 in high), m */
const WALL_TOP = 0.31;
const LEDS_PER_SIDE = 24;
/** Half the beam's spread, rad */
const BEAM_ANGLE = 0.085;
/** Each pattern of the show lasts this long, s */
const PATTERN_TIME = 4;
/** Real light on the robots while the beams are on them (decay 0, like the field spotlight) */
const ROBOT_LIGHT = 3.5;

type Pattern = (i: number, t: number, robots: readonly LitRobot[]) => { x: number; z: number; color: THREE.Color; level: number };

/** The fixtures around the truss, by angle from +X. */
const FIXTURES = Array.from({ length: 8 }, (_, i) => {
  const a = (i * Math.PI) / 4;
  // Corners sit on the square's corners, the others on its sides.
  const r = i % 2 ? LIGHTING_TRUSS.half * Math.SQRT2 : LIGHTING_TRUSS.half;
  return { a, pos: new THREE.Vector3(Math.cos(a) * r, LIGHTING_TRUSS.y - 0.3, Math.sin(a) * r) };
});

const robotFor = (i: number, robots: readonly LitRobot[]) => robots[i % robots.length];

/** The show: one pattern after another, each fixture's target on the floor, its colour and brightness. */
const PATTERNS: Pattern[] = [
  // Wave: everyone sweeps across the field together, red side and blue side.
  (i, t) => ({ x: 1.5 * Math.sin((t * Math.PI) / 2), z: 1.2 * Math.sin(FIXTURES[i].a), color: Math.cos(FIXTURES[i].a) < 0 ? RED : BLUE, level: 1 }),
  // Circle: a ring of light turning around the HIVE.
  (i, t) => ({ x: 1.3 * Math.cos(t * 1.6 + FIXTURES[i].a), z: 1.3 * Math.sin(t * 1.6 + FIXTURES[i].a), color: WHITE, level: 1 }),
  // Cross: each beam to the far side, swinging, so they cross over the middle.
  (i, t) => ({ x: -1.4 * Math.cos(FIXTURES[i].a) + 0.6 * Math.sin(t * 2), z: -1.4 * Math.sin(FIXTURES[i].a), color: PURPLE, level: 1 }),
  // Focus: on the robots.
  (i, t, robots) => {
    const r = robotFor(i, robots);
    return r ? { x: r.x + 0.08 * Math.sin(t * 3 + i), z: r.z + 0.08 * Math.cos(t * 3 + i), color: WHITE, level: 1 } : { x: 0, z: 0, color: WHITE, level: 1 };
  },
  // Fan: all to the centre, then bursting out to the walls, in time.
  (i, t) => {
    const k = 0.5 - 0.5 * Math.cos((t % 2) * Math.PI);
    return { x: 1.7 * k * Math.cos(FIXTURES[i].a), z: 1.7 * k * Math.sin(FIXTURES[i].a), color: (Math.floor(t / 2) % 2 ? RED : BLUE), level: 1 };
  },
  // Chase: a single bright beam running round, the others low.
  (i, t) => {
    const lead = Math.floor(t * 4) % 8;
    return { x: 1.1 * Math.cos(FIXTURES[i].a), z: 1.1 * Math.sin(FIXTURES[i].a), color: AMBER, level: i === lead ? 1 : 0.18 };
  },
  // Alliances: red beams on the red end, blue beams on the blue end, swaying.
  (i, t) => {
    const red = i % 2 === 0;
    return { x: (red ? -1.2 : 1.2) + 0.25 * Math.sin(t * 2.5 + i), z: 1.3 * Math.sin(t * 1.2 + i), color: red ? RED : BLUE, level: 1 };
  },
  // Focus again, flashing in on the beat.
  (i, t, robots) => {
    const r = robotFor(i, robots);
    const flash = Math.floor(t * 4) % 2 ? 1 : 0.35;
    return r ? { x: r.x, z: r.z, color: WHITE, level: flash } : { x: 0, z: 0, color: WHITE, level: flash };
  },
];
const FOCUS = new Set([3, 7]);

/** Additive beam: bright at the fixture, fading toward the floor and at its soft edges. */
function beamMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color() }, level: { value: 1 } },
    vertexShader: `
      varying float vAlong;
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        vAlong = -position.y;
        vec4 world = modelViewMatrix * vec4(position, 1.0);
        vNormal = normalize(normalMatrix * normal);
        vView = normalize(-world.xyz);
        gl_Position = projectionMatrix * world;
      }`,
    fragmentShader: `
      uniform vec3 color;
      uniform float level;
      varying float vAlong;
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        float edge = pow(abs(dot(normalize(vNormal), normalize(vView))), 2.4);
        float fade = 1.0 - 0.85 * vAlong;
        gl_FragColor = vec4(color * level * edge * fade * 0.3, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

/** Additive pool of light on the floor where a beam lands. */
function poolMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color() }, level: { value: 1 } },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 color;
      uniform float level;
      varying vec2 vUv;
      void main() {
        float d = length(vUv - 0.5) * 2.0;
        gl_FragColor = vec4(color * level * smoothstep(1.0, 0.25, d) * 0.5, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  });
}

interface Head {
  beam: THREE.Mesh<THREE.ConeGeometry, THREE.ShaderMaterial>;
  pool: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  lens: THREE.MeshBasicMaterial;
  target: THREE.Vector3;
  color: THREE.Color;
  level: number;
}

export class FieldLights {
  private mode: FieldLightMode = 'off';
  private time = 0;
  private readonly strips: THREE.InstancedMesh;
  private readonly show = new THREE.Group();
  private readonly heads: Head[] = [];
  private readonly spots: THREE.SpotLight[] = [];
  private readonly color = new THREE.Color();

  constructor(private readonly scene: THREE.Scene, wallInnerHalf: number) {
    // LED strips: segments around the top of the wall, coloured one by one.
    const half = wallInnerHalf + 0.03;
    const seg = (half * 2) / LEDS_PER_SIDE;
    this.strips = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.025, 0.035), new THREE.MeshBasicMaterial({ toneMapped: false }), LEDS_PER_SIDE * 4);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    let n = 0;
    for (const [axis, sign] of [['x', -1], ['x', 1], ['z', -1], ['z', 1]] as const) {
      for (let k = 0; k < LEDS_PER_SIDE; k++) {
        const along = -half + (k + 0.5) * seg;
        const p = axis === 'x' ? new THREE.Vector3(along, WALL_TOP, sign * half) : new THREE.Vector3(sign * half, WALL_TOP, along);
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), axis === 'x' ? 0 : Math.PI / 2);
        this.strips.setMatrixAt(n, m.compose(p, q, s.set(seg * 0.9, 1, 1)));
        this.strips.setColorAt(n, BLUE);
        n++;
      }
    }
    this.strips.visible = false;
    scene.add(this.strips);

    // The moving heads: a body under the truss, a lens, the beam and its pool on the floor.
    const body = new THREE.BoxGeometry(0.26, 0.32, 0.26);
    const bodyMat = new THREE.MeshStandardMaterial({ color: '#1b1d22', metalness: 0.6, roughness: 0.4 });
    // Cone with its tip at the origin, opening down along -Y, one metre long.
    const cone = new THREE.ConeGeometry(1, 1, 24, 1, true).translate(0, -0.5, 0);
    const disc = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
    for (const f of FIXTURES) {
      const housing = new THREE.Mesh(body, bodyMat);
      housing.position.copy(f.pos).setY(f.pos.y + 0.15);
      const lens = new THREE.MeshBasicMaterial({ color: WHITE, toneMapped: false });
      const glass = new THREE.Mesh(new THREE.CircleGeometry(0.09, 16).rotateX(Math.PI / 2), lens);
      glass.position.copy(f.pos);
      const beam = new THREE.Mesh(cone, beamMaterial());
      beam.position.copy(f.pos);
      const pool = new THREE.Mesh(disc, poolMaterial());
      pool.renderOrder = 1;
      this.show.add(housing, glass, beam, pool);
      this.heads.push({ beam, pool, lens, target: new THREE.Vector3(0, 0, 0), color: WHITE.clone(), level: 0 });
    }
    this.show.visible = false;
    scene.add(this.show);
  }

  setMode(mode: FieldLightMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.strips.visible = mode !== 'off';
    this.show.visible = mode === 'final';
    // Real lights only in the show: adding them changes every lit material's shader once.
    if (mode === 'final' && !this.spots.length) {
      for (let i = 0; i < 2; i++) {
        const spot = new THREE.SpotLight('#ffffff', 0, 0, 0.22, 0.6, 0);
        this.scene.add(spot, spot.target);
        this.spots.push(spot);
      }
    } else if (mode !== 'final' && this.spots.length) {
      for (const spot of this.spots.splice(0)) {
        spot.removeFromParent();
        spot.target.removeFromParent();
        spot.dispose();
      }
    }
  }

  update(dt: number, robots: readonly LitRobot[]): void {
    if (this.mode === 'off') return;
    this.time += dt;
    const t = this.time;
    if (this.mode === 'on') {
      // Breathing alliance colours.
      const level = 0.65 + 0.35 * Math.sin(t * 1.4);
      this.paintStrips((x, z) => this.color.copy(x < 0 || (x === 0 && z < 0) ? RED : BLUE).multiplyScalar(level));
      return;
    }
    const index = Math.floor(t / PATTERN_TIME) % PATTERNS.length;
    const pattern = PATTERNS[index];
    const local = t % PATTERN_TIME;
    const k = 1 - Math.exp(-dt * 5);
    const target = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const up = new THREE.Vector3(0, -1, 0);
    this.heads.forEach((head, i) => {
      const want = pattern(i, local, robots);
      head.target.lerp(target.set(want.x, 0.02, want.z), k);
      head.color.lerp(want.color, k);
      head.level += (want.level - head.level) * Math.min(1, k * 2);
      const from = FIXTURES[i].pos;
      dir.subVectors(head.target, from);
      const length = dir.length();
      head.beam.quaternion.setFromUnitVectors(up, dir.normalize());
      const r = Math.tan(BEAM_ANGLE) * length;
      head.beam.scale.set(r, length, r);
      head.beam.material.uniforms.color.value.copy(head.color);
      head.beam.material.uniforms.level.value = head.level;
      head.pool.position.copy(head.target);
      head.pool.scale.setScalar(r * 1.15);
      head.pool.material.uniforms.color.value.copy(head.color);
      head.pool.material.uniforms.level.value = head.level;
      head.lens.color.copy(head.color).multiplyScalar(0.4 + head.level);
    });
    // The real spotlights follow the beams onto the robots while the show focuses on them.
    const focus = FOCUS.has(index) && robots.length > 0;
    this.spots.forEach((spot, i) => {
      const head = this.heads[i * 4];
      const r = robots[i % Math.max(1, robots.length)];
      spot.position.copy(FIXTURES[i * 4].pos);
      if (r) spot.target.position.set(r.x, 0, r.z);
      spot.target.updateMatrixWorld();
      const want = focus ? ROBOT_LIGHT * head.level : 0;
      spot.intensity += (want - spot.intensity) * k;
    });
    // The strips take the beams' colours, running around the field with the show.
    this.paintStrips((x, z) => {
      const angle = Math.atan2(z, x);
      const nearest = Math.round(((angle + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8;
      const ripple = 0.55 + 0.45 * Math.sin(angle * 3 - t * 6);
      return this.color.copy(this.heads[nearest].color).multiplyScalar(ripple * (0.5 + 0.5 * this.heads[nearest].level));
    });
  }

  private paintStrips(colorAt: (x: number, z: number) => THREE.Color): void {
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    for (let i = 0; i < this.strips.count; i++) {
      this.strips.getMatrixAt(i, m);
      p.setFromMatrixPosition(m);
      this.strips.setColorAt(i, colorAt(p.x, p.z));
    }
    this.strips.instanceColor!.needsUpdate = true;
  }
}
