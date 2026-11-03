// The field timer screen: one big screen on a low base beside the field's far long side, square to
// it and facing the field. Red drivers see it on their left, blue drivers on their right, clear of
// the HIVE. It shows the match timer recording (game/matchTimer.ts).
// Field center is the origin; red drivers stand at -X, the audience side is +Z.

import * as THREE from 'three';

/** Screen width, m; the height follows the recording (600 × 318) */
const WIDTH = 1.8;
const HEIGHT = (WIDTH * 318) / 600;
/** Behind the far side wall (it is at z = -1.83), m */
const Z = -2.4;
/**
 * Bottom edge of the picture. The whole screen stays inside a standing driver's view across the
 * field (60° tall, looking down at the robot at the start), m.
 */
const BOTTOM = 0.1;
const CENTER_Y = BOTTOM + HEIGHT / 2;
const BEZEL = 0.05;
const DEPTH = 0.07;

export class TimerScreens {
  private readonly texture: THREE.VideoTexture;

  constructor(scene: THREE.Scene, video: HTMLVideoElement) {
    this.texture = new THREE.VideoTexture(video);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    // Lit by itself, like a real screen in a dim hall.
    const screen = new THREE.MeshBasicMaterial({ map: this.texture, toneMapped: false });
    const frame = new THREE.MeshStandardMaterial({ color: '#15171c', roughness: 0.5, metalness: 0.3 });
    const metal = new THREE.MeshStandardMaterial({ color: '#3a3f48', roughness: 0.45, metalness: 0.7 });
    const baseHeight = BOTTOM - BEZEL;

    const tv = new THREE.Group();
    // Facing the field (+Z) from beyond its far side.
    tv.position.set(0, 0, Z);
    const face = new THREE.Mesh(new THREE.PlaneGeometry(WIDTH, HEIGHT), screen);
    face.position.set(0, CENTER_Y, DEPTH / 2 + 0.002);
    const back = new THREE.Mesh(new THREE.BoxGeometry(WIDTH + 2 * BEZEL, HEIGHT + 2 * BEZEL, DEPTH), frame);
    back.position.y = CENTER_Y;
    const stand = new THREE.Mesh(new THREE.BoxGeometry(WIDTH * 0.6, baseHeight, 0.45), metal);
    stand.position.y = baseHeight / 2;
    tv.add(face, back, stand);
    scene.add(tv);
  }
}
