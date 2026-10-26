// Camera views: driver station, top-down, chase, free orbit.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Alliance } from '../robot/robotConfig';

export type CameraMode = 'driver' | 'top' | 'chase' | 'free';

export const CAMERA_MODES: CameraMode[] = ['driver', 'top', 'chase', 'free'];

export const CAMERA_NAMES: Record<CameraMode, string> = {
  driver: 'Вид водителя',
  top: 'Сверху',
  chase: 'За роботом',
  free: 'Свободная (мышь)',
};

/** Eye height of a standing driver, m */
const DRIVER_EYE = 1.7;

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  mode: CameraMode = 'driver';
  alliance: Alliance = 'red';
  /** Where the driver stands along the alliance wall (world z), m */
  driverZ = 0.6;

  private readonly controls: OrbitControls;
  private readonly lookAt = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private snap = true;

  constructor(dom: HTMLElement) {
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.05, 80);
    this.controls = new OrbitControls(this.camera, dom);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.05;
    this.controls.enabled = false;
  }

  setMode(mode: CameraMode): void {
    this.mode = mode;
    this.controls.enabled = mode === 'free';
    this.camera.up.set(0, 1, 0);
    this.snap = true;
    if (mode === 'free') {
      this.camera.position.set(0, 3.6, 4.6);
      this.controls.target.set(0, 0.3, 0);
    }
  }

  next(): CameraMode {
    const mode = CAMERA_MODES[(CAMERA_MODES.indexOf(this.mode) + 1) % CAMERA_MODES.length];
    this.setMode(mode);
    return mode;
  }

  /** Direction the driver faces (unit X/Z): red looks toward +X, blue toward -X. */
  get driverForward(): number {
    return this.alliance === 'red' ? 1 : -1;
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    // Keep the whole field visible on narrow screens.
    this.camera.fov = width / height < 1.2 ? 72 : 60;
    this.camera.updateProjectionMatrix();
  }

  /** `robot` is null when watching without a robot. */
  update(robot: { x: number; z: number; yaw: number } | null, dt: number): void {
    const robotPos = robot ?? { x: 0, z: 0 };
    const robotYaw = robot?.yaw ?? 0;
    const k = this.snap ? 1 : 1 - Math.exp(-dt * 6);
    const s = this.driverForward;
    switch (this.mode) {
      case 'driver': {
        this.camera.position.set(-s * 2.75, DRIVER_EYE, this.driverZ);
        // Drivers follow the robot with their head, but keep the field in view.
        this.tmp.set(robotPos.x * 0.35, 0, robotPos.z * 0.45);
        this.lookAt.lerp(this.tmp, this.snap ? 1 : 1 - Math.exp(-dt * 3));
        this.camera.lookAt(this.lookAt);
        break;
      }
      case 'top': {
        // Driver's forward points up on screen.
        this.camera.position.set(0, 5.4, 0.0001);
        this.camera.up.set(s, 0, 0);
        this.camera.lookAt(0, 0, 0);
        break;
      }
      case 'chase': {
        const back = 1.25;
        this.tmp.set(robotPos.x - Math.cos(robotYaw) * back, 0.95, robotPos.z + Math.sin(robotYaw) * back);
        this.camera.position.lerp(this.tmp, k);
        this.tmp.set(robotPos.x + Math.cos(robotYaw) * 0.6, 0.2, robotPos.z - Math.sin(robotYaw) * 0.6);
        this.lookAt.lerp(this.tmp, k);
        this.camera.lookAt(this.lookAt);
        break;
      }
      case 'free':
        this.controls.update();
        break;
    }
    this.snap = false;
  }
}
