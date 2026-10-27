// Keyboard state for playing without a controller (which key does what: input/bindings.ts).
// Read once per frame, so a key press is seen by exactly one frame.

export class KeyboardPad {
  /** Keys down right now (events) */
  private readonly live = new Set<string>();
  /** Keys down at this frame's update and at the previous one */
  private now = new Set<string>();
  private prev = new Set<string>();

  constructor(target: Window = window) {
    target.addEventListener('keydown', e => {
      if (e.target instanceof HTMLInputElement) return;
      this.live.add(e.code);
      if (e.code === 'Tab' || e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    });
    target.addEventListener('keyup', e => this.live.delete(e.code));
    target.addEventListener('blur', () => this.live.clear());
  }

  /** Call once at the start of every frame. */
  update(): void {
    this.prev = this.now;
    this.now = new Set(this.live);
  }

  isDown(code: string): boolean {
    return this.now.has(code);
  }

  /** Went down since the previous frame. */
  pressed(code: string): boolean {
    return this.now.has(code) && !this.prev.has(code);
  }
}
