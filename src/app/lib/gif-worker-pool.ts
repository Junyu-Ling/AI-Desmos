/**
 * GIF 帧处理 Worker 池：并行调度多帧表达式生成
 */
import type { GifFrameWorkerInput, GifFrameWorkerOutput } from './gif-frame.worker';

type PendingTask = {
  input: GifFrameWorkerInput;
  resolve: (expressions: any[]) => void;
  reject: (err: Error) => void;
};

const isAbortError = (error: unknown) =>
  error instanceof DOMException && error.name === 'AbortError';

/** 从第 0 帧起连续完成的结果数量 */
export function countContinuousFrameResults(results: any[][]): number {
  let n = 0;
  for (let i = 0; i < results.length; i++) {
    if (!results[i] || results[i].length === 0) break;
    n = i + 1;
  }
  return n;
}

export class GifWorkerPool {
  private workers: Worker[] = [];
  private idleWorkers: Worker[] = [];
  private queue: PendingTask[] = [];
  private activeJobs = new Map<Worker, PendingTask>();
  private aborted = false;

  constructor(size: number) {
    const count = Math.max(1, Math.min(size, 8));
    for (let i = 0; i < count; i++) {
      const worker = new Worker(
        new URL('./gif-frame.worker.ts', import.meta.url),
        { type: 'module' },
      );
      worker.onmessage = (e: MessageEvent<GifFrameWorkerOutput>) => {
        this.handleMessage(worker, e.data);
      };
      worker.onerror = () => {
        const job = this.activeJobs.get(worker);
        if (job) {
          this.activeJobs.delete(worker);
          job.reject(new Error('GIF worker error'));
          this.dispatch(worker);
        }
      };
      this.workers.push(worker);
      this.idleWorkers.push(worker);
    }
  }

  private handleMessage(worker: Worker, output: GifFrameWorkerOutput): void {
    const job = this.activeJobs.get(worker);
    if (!job) return;

    this.activeJobs.delete(worker);
    if (output.error) {
      job.reject(new Error(output.error));
    } else {
      job.resolve(output.expressions);
    }
    this.dispatch(worker);
  }

  private dispatch(worker: Worker): void {
    if (this.aborted) {
      this.idleWorkers.push(worker);
      return;
    }

    const next = this.queue.shift();
    if (!next) {
      this.idleWorkers.push(worker);
      return;
    }

    this.activeJobs.set(worker, next);
    const payload = next.input;
    const transferables: ArrayBuffer[] = [payload.pixels.buffer];
    if (payload.fillPixels && payload.fillPixels.buffer !== payload.pixels.buffer) {
      transferables.push(payload.fillPixels.buffer);
    }
    worker.postMessage(payload, transferables);
  }

  resetAbort(): void {
    this.aborted = false;
  }

  abortPending(): void {
    this.aborted = true;
    while (this.queue.length > 0) {
      const task = this.queue.shift()!;
      task.reject(new DOMException('Aborted', 'AbortError'));
    }
  }

  run(input: GifFrameWorkerInput): Promise<any[]> {
    return new Promise((resolve, reject) => {
      if (this.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      this.queue.push({ input, resolve, reject });
      const worker = this.idleWorkers.pop();
      if (worker) this.dispatch(worker);
    });
  }

  async runAll(inputs: GifFrameWorkerInput[]): Promise<any[][]> {
    return Promise.all(inputs.map(input => this.run(input)));
  }

  /**
   * 并行处理；abort 时立刻停止排队，返回已从第 0 帧起连续完成的表达式。
   * 已在飞的 Worker 任务仍会计入结果。
   */
  async runUntilAbort(
    inputs: GifFrameWorkerInput[],
    signal?: AbortSignal,
    onProgress?: (continuous: number, total: number) => void,
    onFrameReady?: (index: number, expressions: any[]) => void | Promise<void>,
  ): Promise<any[][]> {
    if (inputs.length === 0) return [];

    this.resetAbort();

    const results: any[][] = new Array(inputs.length);
    const failures: Array<{ index: number; error: Error }> = [];
    const notify = () => {
      onProgress?.(countContinuousFrameResults(results), inputs.length);
    };

    const onAbort = () => this.abortPending();
    if (signal?.aborted) {
      this.abortPending();
    } else {
      signal?.addEventListener('abort', onAbort, { once: true });
    }

    const jobs = inputs.map((input, i) =>
      this.run(input)
        .then(async exprs => {
          if (!exprs || exprs.length === 0) {
            throw new Error('Worker returned no expressions');
          }
          results[i] = exprs;
          notify();
          if (onFrameReady) await onFrameReady(i, exprs);
        })
        .catch(err => {
          if (isAbortError(err)) return;
          failures.push({
            index: i,
            error: err instanceof Error ? err : new Error(String(err)),
          });
        }),
    );

    try {
      if (signal && !signal.aborted) {
        await Promise.race([
          Promise.all(jobs),
          new Promise<void>(resolve => {
            signal.addEventListener('abort', () => resolve(), { once: true });
          }),
        ]);
      } else if (!this.aborted) {
        await Promise.all(jobs);
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }

    if (failures.length > 0 && typeof console !== 'undefined') {
      console.warn(
        `[GIF] ${failures.length} worker frame(s) failed`,
        failures.map(f => ({ index: f.index, message: f.error.message })),
      );
    }

    return results;
  }

  terminate(): void {
    this.abortPending();
    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers = [];
    this.idleWorkers = [];
    this.queue = [];
    this.activeJobs.clear();
  }
}

/** 无 Worker 环境时返回 null */
export function createGifWorkerPool(size: number): GifWorkerPool | null {
  if (typeof Worker === 'undefined') return null;
  try {
    return new GifWorkerPool(size);
  } catch {
    return null;
  }
}
