// The sound of pressing a menu button. Web Audio: it starts at once and overlaps itself when
// buttons are pressed quickly.

const VOLUME = 0.6;

export class ClickSound {
  enabled = true;
  private context: AudioContext | null = null;
  private data: Promise<ArrayBuffer> | null = null;
  private buffer: Promise<AudioBuffer> | null = null;

  constructor(private readonly url: string) {}

  /** Fetches the sound before the first press. */
  preload(): void {
    this.data ??= fetch(this.url).then(r => r.arrayBuffer());
    this.data.catch(() => undefined);
  }

  play(): void {
    if (!this.enabled) return;
    try {
      // Made on the first press: browsers only let a page start sound after the player acts.
      this.context ??= new AudioContext();
    } catch {
      return;
    }
    const context = this.context;
    if (context.state === 'suspended') context.resume().catch(() => undefined);
    this.preload();
    this.buffer ??= this.data!.then(d => context.decodeAudioData(d.slice(0)));
    this.buffer.then(buffer => {
      const source = context.createBufferSource();
      source.buffer = buffer;
      const gain = context.createGain();
      gain.gain.value = VOLUME;
      source.connect(gain).connect(context.destination);
      source.start();
    }).catch(() => undefined);
  }
}
