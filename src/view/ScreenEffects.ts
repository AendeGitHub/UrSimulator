// Post-processing for a crisp, CAD-render look: ambient occlusion darkens creases and gaps, and
// black outlines trace silhouettes and sharp edges (like a Fusion 360 render). Both read one
// shared buffer of scene normals and depth, so the scene is drawn only twice per frame.

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

/** Outlines fade out with distance, so the hall and stands stay soft, m */
const OUTLINE_FADE = { start: 5, end: 9 };
/** Outline width in CSS pixels */
const OUTLINE_WIDTH = 0.8;

/** Normals and depth of everything solid. See-through parts hide nothing and get no outline. */
class GBufferPass extends Pass {
  readonly target: THREE.WebGLRenderTarget;
  private readonly normalMaterial = new THREE.MeshNormalMaterial();
  private readonly clearColor = new THREE.Color();

  constructor(private readonly scene: THREE.Scene, private readonly camera: THREE.Camera) {
    super();
    this.needsSwap = false;
    const depth = new THREE.DepthTexture(1, 1);
    depth.format = THREE.DepthStencilFormat;
    depth.type = THREE.UnsignedInt248Type;
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      type: THREE.HalfFloatType,
      depthTexture: depth,
    });
  }

  override setSize(width: number, height: number): void {
    this.target.setSize(width, height);
  }

  override render(renderer: THREE.WebGLRenderer): void {
    const hidden: THREE.Object3D[] = [];
    this.scene.traverseVisible(obj => {
      const seeThrough = obj instanceof THREE.Mesh && ([] as THREE.Material[]).concat(obj.material).some(m => m.transparent);
      if (seeThrough || obj instanceof THREE.Points || obj instanceof THREE.Line || obj instanceof THREE.Sprite) hidden.push(obj);
    });
    for (const obj of hidden) obj.visible = false;
    const { background, overrideMaterial } = this.scene;
    renderer.getClearColor(this.clearColor);
    const clearAlpha = renderer.getClearAlpha();
    this.scene.background = null;
    this.scene.overrideMaterial = this.normalMaterial;
    renderer.setRenderTarget(this.target);
    // Empty space reads as a surface facing the camera, far away.
    renderer.setClearColor(0x7777ff, 1);
    renderer.clear();
    renderer.render(this.scene, this.camera);
    this.scene.background = background;
    this.scene.overrideMaterial = overrideMaterial;
    renderer.setClearColor(this.clearColor, clearAlpha);
    for (const obj of hidden) obj.visible = true;
  }
}

/** GTAO from the shared buffer, computed at half resolution (it is smooth anyway). */
class AmbientOcclusionPass extends GTAOPass {
  constructor(scene: THREE.Scene, camera: THREE.Camera, gbuffer: THREE.WebGLRenderTarget) {
    super(scene, camera, 1, 1);
    this.setGBuffer(gbuffer.depthTexture ?? undefined, gbuffer.texture);
    // Radius in metres: robot-sized creases, not whole-field darkening.
    this.updateGtaoMaterial({ radius: 0.16, distanceExponent: 1, thickness: 1, scale: 1.25, samples: 8 });
    this.updatePdMaterial({ samples: 8 });
    this.blendIntensity = 0.85;
  }

  override setSize(width: number, height: number): void {
    super.setSize(Math.max(1, Math.round(width / 2)), Math.max(1, Math.round(height / 2)));
  }
}

const OutlineShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tNormal: { value: null as THREE.Texture | null },
    tDepth: { value: null as THREE.Texture | null },
    texel: { value: new THREE.Vector2() },
    cameraNear: { value: 0.05 },
    cameraFar: { value: 80 },
    fadeStart: { value: OUTLINE_FADE.start },
    fadeEnd: { value: OUTLINE_FADE.end },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    #include <packing>
    uniform sampler2D tDiffuse;
    uniform sampler2D tNormal;
    uniform sampler2D tDepth;
    uniform vec2 texel;
    uniform float cameraNear;
    uniform float cameraFar;
    uniform float fadeStart;
    uniform float fadeEnd;
    varying vec2 vUv;

    float distanceAt(vec2 uv) {
      return -perspectiveDepthToViewZ(texture2D(tDepth, uv).x, cameraNear, cameraFar);
    }

    vec3 normalAt(vec2 uv) {
      return unpackRGBToNormal(texture2D(tNormal, uv).rgb);
    }

    void main() {
      vec4 color = texture2D(tDiffuse, vUv);
      float d = distanceAt(vUv);
      vec3 n = normalAt(vUv);
      float edge = 0.0;
      for (int i = 0; i < 4; i++) {
        vec2 offset = i == 0 ? vec2(texel.x, 0.0) : i == 1 ? vec2(-texel.x, 0.0) : i == 2 ? vec2(0.0, texel.y) : vec2(0.0, -texel.y);
        vec2 uv = vUv + offset;
        // Silhouette: the neighbour is clearly farther away (the nearer object draws the line).
        edge = max(edge, smoothstep(0.03, 0.06, (distanceAt(uv) - d) / d));
        // Sharp edge: the surface turns by more than ~60 degrees (finer facets of curved parts
        // such as mecanum rollers would otherwise turn black).
        edge = max(edge, smoothstep(0.45, 0.7, 1.0 - dot(n, normalAt(uv))));
      }
      edge *= 1.0 - smoothstep(fadeStart, fadeEnd, d);
      gl_FragColor = vec4(mix(color.rgb, vec3(0.02), edge * 0.9), color.a);
    }`,
};

class OutlinePass extends ShaderPass {
  private pixelRatio = 1;

  constructor(camera: THREE.PerspectiveCamera, gbuffer: THREE.WebGLRenderTarget) {
    super(OutlineShader);
    this.uniforms.tNormal.value = gbuffer.texture;
    this.uniforms.tDepth.value = gbuffer.depthTexture;
    this.uniforms.cameraNear.value = camera.near;
    this.uniforms.cameraFar.value = camera.far;
  }

  setPixelRatio(ratio: number): void {
    this.pixelRatio = ratio;
  }

  override setSize(width: number, height: number): void {
    const px = Math.max(1, OUTLINE_WIDTH * this.pixelRatio);
    this.uniforms.texel.value.set(px / width, px / height);
  }
}

export class ScreenEffects {
  private readonly composer: EffectComposer;
  private readonly outline: OutlinePass;
  private readonly ao: AmbientOcclusionPass;
  private readonly gbuffer: GBufferPass;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    // 4× MSAA on the colour image; the effects work on the shared normal/depth buffer.
    this.composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }));
    const gbuffer = new GBufferPass(scene, camera);
    this.gbuffer = gbuffer;
    this.outline = new OutlinePass(camera, gbuffer.target);
    this.composer.addPass(new RenderPass(scene, camera));
    this.composer.addPass(gbuffer);
    this.ao = new AmbientOcclusionPass(scene, camera, gbuffer.target);
    this.composer.addPass(this.ao);
    this.composer.addPass(this.outline);
    this.composer.addPass(new OutputPass());
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    this.outline.setPixelRatio(pixelRatio);
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
  }

  /** Ambient occlusion is the first thing to go on a slow computer. */
  setAmbientOcclusion(on: boolean): void {
    this.ao.enabled = on;
    this.updateGBuffer();
  }

  setOutlines(on: boolean): void {
    this.outline.enabled = on;
    this.updateGBuffer();
  }

  /** With neither effect on, the extra normal/depth render of the scene is skipped entirely. */
  private updateGBuffer(): void {
    this.gbuffer.enabled = this.ao.enabled || this.outline.enabled;
  }

  render(dt: number): void {
    this.composer.render(dt);
  }
}
