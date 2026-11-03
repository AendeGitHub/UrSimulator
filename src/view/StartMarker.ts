// The robot's footprint while its start is picked (ui/StartPositionScreen.ts): green where G304
// allows it to start, red where it doesn't. Drawn over everything, so the robot model under the
// camera can't hide it.

import * as THREE from 'three';
import type { StartPose } from '../field/startPose';
import type { RobotConfig } from '../robot/robotConfig';

const COLORS = { ok: new THREE.Color('#2fd36b'), bad: new THREE.Color('#ff3b3b') };

export class StartMarker {
  private readonly root = new THREE.Group();
  private readonly fill = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.4, depthTest: false, depthWrite: false });
  private readonly line = new THREE.LineBasicMaterial({ transparent: true, depthTest: false, depthWrite: false });

  constructor(scene: THREE.Scene) {
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), this.fill);
    const corners = [[0.5, 0.5], [0.5, -0.5], [-0.5, -0.5], [-0.5, 0.5]].map(([x, z]) => new THREE.Vector3(x, 0, z));
    const edge = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(corners), this.line);
    for (const o of [plane, edge]) {
      o.renderOrder = 10;
      this.root.add(o);
    }
    this.root.visible = false;
    scene.add(this.root);
  }

  /** The frame's outline (a folding arm stays up at the start) at a pose on the field. */
  show(pose: StartPose, cfg: RobotConfig, ok: boolean): void {
    const frame = cfg.frame ?? { length: cfg.length, offset: 0 };
    this.root.position.set(pose.x + Math.cos(pose.yaw) * frame.offset, 0.01, pose.z - Math.sin(pose.yaw) * frame.offset);
    this.root.rotation.set(0, pose.yaw, 0);
    this.root.scale.set(frame.length, 1, cfg.width);
    const color = ok ? COLORS.ok : COLORS.bad;
    this.fill.color.copy(color);
    this.line.color.copy(color);
    this.root.visible = true;
  }

  hide(): void {
    this.root.visible = false;
  }
}
