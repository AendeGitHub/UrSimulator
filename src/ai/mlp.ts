// A small fully connected network (multilayer perceptron): ReLU hidden layers, raw outputs. The
// AI driver's policy runs on it 20 times a second; one pass is a few thousand multiply-adds, far
// under a millisecond. Weights are trained by tools/train-bot.ts and stored as base64 float32.

export interface LayerData {
  inputs: number;
  outputs: number;
  /** Row-major [outputs][inputs], base64 float32 */
  w: string;
  /** base64 float32 */
  b: string;
}

export interface MlpData {
  /** Input normalization measured on the training data: (x - mean) / std */
  mean: string;
  std: string;
  layers: LayerData[];
}

export interface Layer {
  inputs: number;
  outputs: number;
  w: Float32Array;
  b: Float32Array;
}

export function fromBase64(text: string): Float32Array {
  const bytes = Uint8Array.from(atob(text), c => c.charCodeAt(0));
  return new Float32Array(bytes.buffer);
}

export function toBase64(values: Float32Array): string {
  const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

export class Mlp {
  private readonly buffers: Float32Array[];

  constructor(readonly layers: Layer[], readonly mean: Float32Array, readonly std: Float32Array) {
    this.buffers = [new Float32Array(mean.length), ...layers.map(l => new Float32Array(l.outputs))];
  }

  static fromData(data: MlpData): Mlp {
    return new Mlp(
      data.layers.map(l => ({ inputs: l.inputs, outputs: l.outputs, w: fromBase64(l.w), b: fromBase64(l.b) })),
      fromBase64(data.mean),
      fromBase64(data.std),
    );
  }

  toData(): MlpData {
    return {
      mean: toBase64(this.mean),
      std: toBase64(this.std),
      layers: this.layers.map(l => ({ inputs: l.inputs, outputs: l.outputs, w: toBase64(l.w), b: toBase64(l.b) })),
    };
  }

  /** Raw outputs for features `x` (the returned array is reused by the next call). */
  forward(x: ArrayLike<number>): Float32Array {
    let input = this.buffers[0];
    for (let i = 0; i < input.length; i++) input[i] = (x[i] - this.mean[i]) / this.std[i];
    this.layers.forEach((layer, n) => {
      const out = this.buffers[n + 1];
      const last = n === this.layers.length - 1;
      const { w, b, inputs, outputs } = layer;
      for (let o = 0; o < outputs; o++) {
        let sum = b[o];
        const row = o * inputs;
        for (let i = 0; i < inputs; i++) sum += w[row + i] * input[i];
        out[o] = last || sum > 0 ? sum : 0;
      }
      input = out;
    });
    return input;
  }
}
