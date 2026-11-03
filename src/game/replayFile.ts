// A recorded match (game/replay.ts) as one file for the archive (server/Replays.ts): "URP1", the
// number of frames, then each frame's time, countdown and snapshot (sim/stateCodec.ts). The game
// gzips it before sending (a 2:30 match of four robots: about 5 MB, 2 MB gzipped).

import type { ReplayFrame } from './replay';

const MAGIC = [0x55, 0x52, 0x50, 0x31];
const HEADER = MAGIC.length + 4;
/** Per frame: time, countdown, snapshot length */
const FRAME_HEADER = 12;

export function packReplay(frames: readonly ReplayFrame[]): Uint8Array {
  const out = new Uint8Array(HEADER + frames.reduce((n, f) => n + FRAME_HEADER + f.data.byteLength, 0));
  const view = new DataView(out.buffer);
  out.set(MAGIC, 0);
  view.setUint32(MAGIC.length, frames.length, true);
  let at = HEADER;
  for (const f of frames) {
    view.setFloat32(at, f.t, true);
    view.setFloat32(at + 4, f.startIn, true);
    view.setUint32(at + 8, f.data.byteLength, true);
    out.set(new Uint8Array(f.data), at + FRAME_HEADER);
    at += FRAME_HEADER + f.data.byteLength;
  }
  return out;
}

/** The frames of a file; throws when it isn't one. */
export function unpackReplay(bytes: Uint8Array): ReplayFrame[] {
  if (bytes.length < HEADER || MAGIC.some((b, i) => bytes[i] !== b)) throw new Error('not a replay');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(MAGIC.length, true);
  const frames: ReplayFrame[] = [];
  let at = HEADER;
  for (let i = 0; i < count; i++) {
    if (at + FRAME_HEADER > bytes.length) throw new Error('replay cut short');
    const length = view.getUint32(at + 8, true);
    if (at + FRAME_HEADER + length > bytes.length) throw new Error('replay cut short');
    frames.push({ t: view.getFloat32(at, true), startIn: view.getFloat32(at + 4, true), data: bytes.slice(at + FRAME_HEADER, at + FRAME_HEADER + length).buffer });
    at += FRAME_HEADER + length;
  }
  return frames;
}

async function through(bytes: Uint8Array, stream: TransformStream<Uint8Array, Uint8Array>): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

export const gzip = (bytes: Uint8Array) => through(bytes, new CompressionStream('gzip'));
export const gunzip = (bytes: Uint8Array) => through(bytes, new DecompressionStream('gzip'));
