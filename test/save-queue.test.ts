// @vitest-environment jsdom
//
// SaveQueue itself has no Obsidian dependency, but it now schedules through
// window.setTimeout/clearTimeout (Obsidian's own guidance, for popout-window
// compatibility) rather than the bare globals — jsdom is needed here purely
// to give `window` a real definition for those calls to resolve against.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SaveQueue } from '../src/save-queue';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('SaveQueue: cancel', () => {
  it('drops a debounced write that has not started yet', async () => {
    // Teardown case: a queued web-clip import must not fire against a plugin
    // that has since been unloaded.
    const write = vi.fn().mockResolvedValue(undefined);
    const q = new SaveQueue(write, vi.fn(), 100);

    q.schedule();
    q.cancel();
    await vi.advanceTimersByTimeAsync(500);

    expect(write).not.toHaveBeenCalled();
  });

  it('leaves a write that is already running alone', async () => {
    // Abandoning an in-flight write is how state mid-save gets lost.
    let release!: () => void;
    const write = vi.fn().mockReturnValue(new Promise<void>(r => { release = r; }));
    const q = new SaveQueue(write, vi.fn(), 100);

    q.schedule();
    await vi.advanceTimersByTimeAsync(100); // write starts
    expect(write).toHaveBeenCalledTimes(1);

    q.cancel();
    release();
    await vi.advanceTimersByTimeAsync(0);

    expect(write).toHaveBeenCalledTimes(1); // completed, not aborted
  });

  it('can be scheduled again after cancelling', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const q = new SaveQueue(write, vi.fn(), 100);

    q.schedule();
    q.cancel();
    q.schedule();
    await vi.advanceTimersByTimeAsync(100);

    expect(write).toHaveBeenCalledTimes(1);
  });

  it('is harmless when nothing is scheduled', () => {
    const q = new SaveQueue(vi.fn().mockResolvedValue(undefined), vi.fn(), 100);
    expect(() => { q.cancel(); q.cancel(); }).not.toThrow();
  });
});

describe('SaveQueue: debounce / scheduling', () => {
  it('coalesces a burst of schedule() calls into exactly one write', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const q = new SaveQueue(write, vi.fn(), 100);

    q.schedule();
    await vi.advanceTimersByTimeAsync(50);
    q.schedule(); // resets the debounce clock — the first timer never fires
    await vi.advanceTimersByTimeAsync(50);
    q.schedule();
    await vi.advanceTimersByTimeAsync(100); // now it fires

    expect(write).toHaveBeenCalledTimes(1);
  });

  it('hasPendingWork is true as soon as a write is debouncing', () => {
    const q = new SaveQueue(vi.fn().mockResolvedValue(undefined), vi.fn(), 100);
    expect(q.hasPendingWork).toBe(false);
    q.schedule();
    expect(q.hasPendingWork).toBe(true);
  });
});

describe('SaveQueue: closing/tearing down mid-save', () => {
  it('flush() cancels a pending debounce timer and writes immediately instead of waiting it out', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const q = new SaveQueue(write, vi.fn(), 100_000); // long enough it would never fire on its own within the test
    q.schedule();
    expect(q.hasPendingWork).toBe(true);

    await q.flush();

    expect(write).toHaveBeenCalledTimes(1);
    expect(q.hasPendingWork).toBe(false);
  });

  it('hasPendingWork stays true for the full duration of a slow write', async () => {
    let resolveWrite!: () => void;
    const write = vi.fn(() => new Promise<void>(res => { resolveWrite = res; }));
    const q = new SaveQueue(write, vi.fn());

    const inFlight = q.flush();
    expect(q.hasPendingWork).toBe(true);
    resolveWrite();
    await inFlight;
    expect(q.hasPendingWork).toBe(false);
  });
});

describe('SaveQueue: concurrent edits while a write is in flight', () => {
  it('never starts a second overlapping write while one is already running', async () => {
    // Every call (including any follow-up the pending flag triggers) bumps
    // and drops a concurrency counter around a real await, so two calls
    // overlapping in time would show up as maxConcurrent > 1.
    let concurrent = 0;
    let maxConcurrent = 0;
    const write = vi.fn(async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await Promise.resolve();
      concurrent--;
    });
    const q = new SaveQueue(write, vi.fn());

    const p1 = q.flush();
    const p2 = q.flush(); // piggybacks — must NOT invoke write() a second time yet
    const p3 = q.flush();
    expect(write).toHaveBeenCalledTimes(1);

    await Promise.all([p1, p2, p3]);

    expect(maxConcurrent).toBe(1); // write() was never called while a previous call was still pending
  });

  it('several edits piled up during one write result in exactly one follow-up write, not one per edit', async () => {
    let resolveFirst!: () => void;
    let calls = 0;
    const write = vi.fn(() => {
      calls++;
      if (calls === 1) return new Promise<void>(res => { resolveFirst = res; });
      return Promise.resolve();
    });
    const q = new SaveQueue(write, vi.fn());

    const p1 = q.flush();
    const p2 = q.flush();
    const p3 = q.flush();
    const p4 = q.flush();

    resolveFirst();
    await Promise.all([p1, p2, p3, p4]);

    expect(write).toHaveBeenCalledTimes(2); // one initial + one catch-up, not four
  });
});

describe('SaveQueue: write failures', () => {
  it('a rejected write calls onError and does not reject flush() itself', async () => {
    const err = new Error('disk full');
    const write = vi.fn().mockRejectedValue(err);
    const onError = vi.fn();
    const q = new SaveQueue(write, onError);

    await expect(q.flush()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(err);
  });

  it('does not retry synchronously after a failure (no tight loop against a persistent failure)', async () => {
    const write = vi.fn().mockRejectedValue(new Error('permission denied'));
    const q = new SaveQueue(write, vi.fn());

    await q.flush();

    expect(write).toHaveBeenCalledTimes(1);
    expect(q.hasPendingWork).toBe(false);
  });

  it('after a failure with nothing else pending, the next explicit flush() starts a clean fresh attempt', async () => {
    const write = vi.fn()
      .mockRejectedValueOnce(new Error('network blip'))
      .mockResolvedValueOnce(undefined);
    const onError = vi.fn();
    const q = new SaveQueue(write, onError);

    await q.flush();
    expect(onError).toHaveBeenCalledTimes(1);

    await q.flush();
    expect(write).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1); // no additional failure reported
  });

  it('an edit that piles up DURING a failing write is not silently dropped — a fresh attempt gets scheduled', async () => {
    let rejectFirst!: (err: unknown) => void;
    let calls = 0;
    const write = vi.fn(() => {
      calls++;
      if (calls === 1) return new Promise<void>((_res, rej) => { rejectFirst = rej; });
      return Promise.resolve();
    });
    const onError = vi.fn();
    const q = new SaveQueue(write, onError, 50);

    const p1 = q.flush();
    const p2 = q.flush(); // piggybacks onto the still-running (about to fail) first write

    rejectFirst(new Error('timeout'));
    await Promise.all([p1, p2]);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1); // no synchronous retry yet
    // The piggybacked edit wasn't thrown away — a fresh debounced attempt
    // is now pending rather than the state only surviving in memory.
    expect(q.hasPendingWork).toBe(true);

    await vi.advanceTimersByTimeAsync(50);
    expect(write).toHaveBeenCalledTimes(2);
    expect(q.hasPendingWork).toBe(false);
  });
});
