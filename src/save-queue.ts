// A serialized, coalescing async write queue — deliberately has no
// Obsidian/DOM dependency so it can be unit-tested in isolation (see
// test/save-queue.test.ts). The caller supplies the actual write function
// and what to do if it rejects; this only owns the scheduling/serialization
// behavior:
//   - schedule() debounces bursts of edits into a single write.
//   - flush() writes immediately. If a write is already running, this call
//     piggybacks on it rather than starting a second, concurrent one —
//     Obsidian's vault.modify() gives no guarantee that two overlapping
//     writes to the same file resolve in call order, so two in-flight
//     writes could race and let a stale one land last. The in-flight write
//     loops once more after it finishes, picking up whatever state exists
//     by then, so a piggybacked call is never served a stale result.
//   - a failed write calls onError and does not immediately retry (so a
//     persistent failure can't spin in a tight loop). If further edits
//     piled up while the failing write was running, though, they are NOT
//     silently dropped — a fresh debounced attempt is scheduled so that
//     state still eventually gets written instead of only surviving in
//     memory until the next unrelated edit happens to trigger a save.
export class SaveQueue {
  private timer: number | null = null;
  private inFlight: Promise<void> | null = null;
  private pending = false;

  constructor(
    private readonly write: () => Promise<void>,
    private readonly onError: (err: unknown) => void,
    private readonly debounceMs = 600,
  ) {}

  /** True if a write is debouncing, pending, or currently running. */
  get hasPendingWork(): boolean {
    return this.timer !== null || this.inFlight !== null;
  }

  schedule(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.debounceMs);
  }

  /**
   * Drops a debounced write that hasn't started yet. A write already in
   * flight is left alone — it owns state that is mid-save, and abandoning it
   * is what losing work looks like.
   *
   * For teardown, where the alternative is a timer firing against an object
   * that no longer exists.
   */
  cancel(): void {
    if (this.timer !== null) { window.clearTimeout(this.timer); this.timer = null; }
  }

  async flush(): Promise<void> {
    if (this.timer !== null) { window.clearTimeout(this.timer); this.timer = null; }

    if (this.inFlight) {
      this.pending = true;
      return this.inFlight;
    }

    const run = async (): Promise<void> => {
      do {
        this.pending = false;
        try {
          await this.write();
        } catch (err) {
          this.onError(err);
          // Don't drop state that piled up while this write was failing —
          // give it a fresh debounced attempt rather than looping
          // synchronously (which would hammer a persistent failure).
          if (this.pending) { this.pending = false; this.schedule(); }
          return;
        }
      } while (this.pending);
    };
    const inFlight = run();
    this.inFlight = inFlight;
    try {
      await inFlight;
    } finally {
      if (this.inFlight === inFlight) this.inFlight = null;
    }
  }
}
