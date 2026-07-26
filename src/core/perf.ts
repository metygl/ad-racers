/**
 * Frame-time instrumentation.
 *
 * Deliberately allocation-free and ring-buffered: a performance monitor that
 * causes garbage collections is measuring itself. It reports percentiles rather
 * than an average, because the number that decides whether a racing game feels
 * good is the worst frame, not the mean.
 */

export interface PerfSnapshot {
  fps: number;
  /** Median frame time, milliseconds. */
  medianMs: number;
  /** 95th percentile frame time, milliseconds. */
  p95Ms: number;
  /** Worst frame in the window, milliseconds. */
  worstMs: number;
  /** Simulation steps executed in the last second. */
  stepsPerSecond: number;
  /** JS heap in megabytes, where the browser exposes it. */
  heapMb: number | null;
}

const WINDOW = 180;

export class PerformanceMonitor {
  private readonly frames = new Float32Array(WINDOW);
  private readonly sorted = new Float32Array(WINDOW);
  private index = 0;
  private filled = 0;
  private stepAccumulator = 0;
  private stepWindow = 0;
  private stepsPerSecond = 0;

  /** Records one frame. `frameSeconds` is the wall-clock delta. */
  record(frameSeconds: number, steps: number): void {
    this.frames[this.index] = frameSeconds * 1000;
    this.index = (this.index + 1) % WINDOW;
    if (this.filled < WINDOW) this.filled += 1;

    this.stepAccumulator += steps;
    this.stepWindow += frameSeconds;
    if (this.stepWindow >= 1) {
      this.stepsPerSecond = this.stepAccumulator / this.stepWindow;
      this.stepAccumulator = 0;
      this.stepWindow = 0;
    }
  }

  snapshot(): PerfSnapshot {
    if (this.filled === 0) {
      return { fps: 0, medianMs: 0, p95Ms: 0, worstMs: 0, stepsPerSecond: 0, heapMb: null };
    }
    this.sorted.set(this.frames.subarray(0, this.filled));
    const view = this.sorted.subarray(0, this.filled);
    view.sort();

    const median = view[Math.floor(this.filled * 0.5)] ?? 0;
    const p95 = view[Math.min(this.filled - 1, Math.floor(this.filled * 0.95))] ?? 0;
    const worst = view[this.filled - 1] ?? 0;

    let total = 0;
    for (let i = 0; i < this.filled; i++) total += view[i] as number;
    const mean = total / this.filled;

    const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;

    return {
      fps: mean > 0 ? 1000 / mean : 0,
      medianMs: median,
      p95Ms: p95,
      worstMs: worst,
      stepsPerSecond: this.stepsPerSecond,
      heapMb: memory ? memory.usedJSHeapSize / (1024 * 1024) : null,
    };
  }

  reset(): void {
    this.index = 0;
    this.filled = 0;
    this.stepAccumulator = 0;
    this.stepWindow = 0;
    this.stepsPerSecond = 0;
  }
}
