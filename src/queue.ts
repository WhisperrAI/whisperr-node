import type { QueuedOp, TrackOp } from "./types.js";

/**
 * A simple in-memory, ordered outbound queue. Unlike the browser SDK there's no
 * durable backing store — a backend process that crashes loses unsent events,
 * which is an acceptable trade for zero I/O on the hot path.
 *
 * The drain loop *takes ownership* of a batch (removing it up front) before
 * sending, and requeues it only if delivery gives up. That keeps in-flight
 * events off the queue, so concurrent enqueues — including overflow drops —
 * can never disturb a batch that's mid-send. On overflow the oldest events are
 * dropped (the freshest churn signal is the most valuable).
 */
export class MemoryQueue {
  private ops: QueuedOp[] = [];

  constructor(private readonly maxSize: number) {}

  get size(): number {
    return this.ops.length;
  }

  /** The op at the front, or undefined if empty. */
  peek(): QueuedOp | undefined {
    return this.ops[0];
  }

  /** Append an op. Returns how many oldest ops were dropped to stay in bounds. */
  enqueue(op: QueuedOp): number {
    this.ops.push(op);
    if (this.ops.length > this.maxSize) {
      const overflow = this.ops.length - this.maxSize;
      this.ops.splice(0, overflow);
      return overflow;
    }
    return 0;
  }

  /** Remove and return up to `n` ops from the front. */
  takeFront(n: number): QueuedOp[] {
    return this.ops.splice(0, n);
  }

  /** Remove and return a leading run of track ops (up to `max`). */
  takeTrackBatchFront(max: number): TrackOp[] {
    let n = 0;
    while (n < this.ops.length && n < max && this.ops[n]!.kind === "track") n++;
    return this.ops.splice(0, n) as TrackOp[];
  }

  /** Put an un-delivered batch back at the front, preserving order. */
  requeueFront(ops: QueuedOp[]): void {
    if (ops.length) this.ops.unshift(...ops);
  }

  clear(): void {
    this.ops = [];
  }
}
