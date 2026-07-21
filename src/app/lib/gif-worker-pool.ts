/**
 * GIF 帧处理 Worker 池：并行调度多帧表达式生成
 */
import type { GifFrameWorkerInput, GifFrameWorkerOutput } from './gif-frame.worker';

type PendingTask = {
  input: GifFrameWorkerInput;
  resolve: (expressions: any[]) => void;
  reject: (err: Error) => void;
};

export class GifWorkerPool {
  private workers: Worker[] = [];
  private idleWorkers: Worker[] = [];
  private queue: PendingTask[] = [];
  private activeJobs = new Map<Worker, PendingTask>();

  constructor(size: number) {
    const count = Math.max(1, Math.min(size, 6));
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
    const next = this.queue.shift();
    if (!next) {
      this.idleWorkers.push(worker);
      return;
    }

    this.activeJobs.set(worker, next);
    const pixels = new Uint8ClampedArray(next.input.pixels);
    worker.postMessage(
      { ...next.input, pixels },
      [pixels.buffer],
    );
  }

  run(input: GifFrameWorkerInput): Promise<any[]> {
    return new Promise((resolve, reject) => {
      this.queue.push({ input, resolve, reject });
      const worker = this.idleWorkers.pop();
      if (worker) this.dispatch(worker);
    });
  }

  async runAll(inputs: GifFrameWorkerInput[]): Promise<any[][]> {
    return Promise.all(inputs.map(input => this.run(input)));
  }

  terminate(): void {
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
