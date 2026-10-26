// Camera views, picked before the match: driver station, audience stands, or following the robot.
// Only the follow camera changes during play: R3 turns it to look forward or back.

import * as THREE from 'three';
import type { Alliance } from '../robot/robotConfig';

export type CameraMode = 'driver' | 'audience' | 'follow';

export const CAMERA_MODES: CameraMode[] = ['driver', 'audience', 'follow'];

export const CAMERA_NAMES: Record<CameraMode, string> = {
  driver: 'Вид водителя',
  audience: 'Вид зрителей',
  follow: 'За роботом',
};

/** Eye height of a standing driver, m */
const DRIVER_EYE = 1.7;
/** A seat in the stands on the audience side (+Z), looking across the field. */
const AUDIENCE_SEAT = new THREE.Vector3(0, 3.1, 4.3);
/** Follow camera: distance behind the robot and height, m */
const FOLLOW = { back: 1.35, height: 1.05, ahead: 0.7 };

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  mode: CameraMode = 'driver';
  alliance: Alliance = 'red';
  /** Where the driver stands along the alliance wall (world z), m */
  driverZ = 0.6;
  /** Follow camera looks back toward its own drivers instead of across the field. */
  lookingBack = false;

  private readonly lookAt = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private snap = true;

  constructor() {
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.05, 80);
  }

  setMode(mode: CameraMode): void {
    this.mode = mode;
    this.lookingBack = false;
    this.camera.up.set(0, 1, 0);
    this.snap = true;
  }

  /** Follow camera only: look the other way. */
  flip(): void {
    this.lookingBack = !this.lookingBack;
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
  update(robot: { x: number; z: number } | null, dt: number): void {
    const robotPos = robot ?? { x: 0, z: 0 };
    const k = this.snap ? 1 : 1 - Math.exp(-dt * 6);
    const s = this.driverForward;
    this.camera.up.set(0, 1, 0);
    switch (this.mode) {
      case 'driver': {
        this.camera.position.set(-s * 2.75, DRIVER_EYE, this.driverZ);
        // Drivers follow the robot with their head, but keep the field in view.
        this.tmp.set(robotPos.x * 0.35, 0, robotPos.z * 0.45);
        this.lookAt.lerp(this.tmp, this.snap ? 1 : 1 - Math.exp(-dt * 3));
        this.camera.lookAt(this.lookAt);
        break;
      }
      case 'audience': {
        this.camera.position.copy(AUDIENCE_SEAT);
        // Like a person in the stands: the head turns a little with the play.
        this.tmp.set(robotPos.x * 0.3, 0, -0.25);
        this.lookAt.lerp(this.tmp, this.snap ? 1 : 1 - Math.exp(-dt * 2));
        this.camera.lookAt(this.lookAt);
        break;
      }
      case 'follow': {
        // Fixed direction (does not turn with the robot): across the field, or back with R3.
        const dir = this.lookingBack ? -s : s;
        this.tmp.set(robotPos.x - dir * FOLLOW.back, FOLLOW.height, robotPos.z);
        this.camera.position.lerp(this.tmp, k);
        this.tmp.set(robotPos.x + dir * FOLLOW.ahead, 0.15, robotPos.z);
        this.lookAt.lerp(this.tmp, k);
        this.camera.lookAt(this.lookAt);
        break;
      }
    }
    this.snap = false;
  }
}
