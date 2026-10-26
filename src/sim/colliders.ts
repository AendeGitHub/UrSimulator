// Reads public/assets/field-colliders.bin (written by tools/build-colliders.mjs).

export interface ColliderPart {
  name: string;
  /** static parts are in field coordinates; hive parts relative to their pivot axle */
  kind: 'static' | 'hive_red' | 'hive_blue';
  vertices: Float32Array;
  indices: Uint32Array;
}

interface Header {
  parts: { name: string; kind: ColliderPart['kind']; vertexOffset: number; vertexCount: number; indexOffset: number; indexCount: number }[];
}

export function parseColliders(buffer: ArrayBuffer): ColliderPart[] {
  const view = new DataView(buffer);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== 'URC1') throw new Error('field-colliders.bin: unknown format');
  const headerLength = view.getUint32(4, true);
  const header: Header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, headerLength)));
  const data = 8 + headerLength;
  return header.parts.map(p => ({
    name: p.name,
    kind: p.kind,
    // Copies, so the parts stay valid independent of the source buffer's alignment.
    vertices: new Float32Array(buffer.slice(data + p.vertexOffset, data + p.vertexOffset + p.vertexCount * 4)),
    indices: new Uint32Array(buffer.slice(data + p.indexOffset, data + p.indexOffset + p.indexCount * 4)),
  }));
}
