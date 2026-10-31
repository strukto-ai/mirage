// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ENV_WORKER_TOKEN } from '../env.ts'
import { type WorkerPoolOptions, WorkerType } from './types.ts'
import { ProcessWorker, ThreadWorker, type Worker } from './worker.ts'

/**
 * The workers and which holds each workspace. A workspace's worker
 * outlives its close, so a create under its id reaches the worker that
 * has its state; a delete forgets it. Mirrors Python's
 * `WorkerPool`.
 */
export class WorkerPool {
  readonly workers: Worker[]
  /** Creates being answered, each holding a slot under `max_workspaces`. */
  reserved = 0
  /**
   * The workers' `$MIRAGE_WORKER_TOKEN`: a request carrying it was counted
   * against the rate limits already.
   */
  readonly token = randomUUID()
  /** Called when a worker's workspaces are gone with it. */
  onLost: () => void = () => undefined
  private readonly homes = new Map<string, Worker>()
  /** The worker each id being created goes to, until its create ends. */
  private readonly pending = new Map<string, Worker>()
  private readonly directory: string
  private stopping = false

  constructor(private readonly options: WorkerPoolOptions) {
    this.directory = mkdtempSync(join(tmpdir(), 'mirage-workers-'))
    const Kind = options.type === WorkerType.Process ? ProcessWorker : ThreadWorker
    this.workers = Array.from({ length: options.count }, (_, index) => {
      const worker = new Kind({
        index,
        socket: join(this.directory, `${String(index)}.sock`),
        entry: options.entry,
        execArgv: options.execArgv,
        env: { ...options.env, [ENV_WORKER_TOKEN]: this.token },
        host: options.host,
      })
      worker.onExit = () => {
        this.lost(worker)
      }
      return worker
    })
  }

  /** Start every worker and wait until each answers. */
  async start(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.start()))
  }

  /** Stop every worker: each drains, then exits or is ended. */
  async stop(): Promise<void> {
    this.stopping = true
    await Promise.all(this.workers.map((worker) => worker.stop(this.options.gracefulTimeout)))
    rmSync(this.directory, { recursive: true, force: true })
  }

  /** The first worker still running, which answers what no workspace owns. */
  first(): Worker | undefined {
    return this.workers.find((worker) => !worker.dead)
  }

  /** A worker still running, at random: where a new workspace goes. */
  random(): Worker | undefined {
    const running = this.workers.filter((worker) => !worker.dead)
    return running[Math.floor(Math.random() * running.length)]
  }

  /** The worker now creating `id`, else undefined. */
  building(id: string): Worker | undefined {
    return this.pending.get(id)
  }

  /** The worker holding, last holding or now creating `id`, else undefined. */
  home(id: string): Worker | undefined {
    return this.homes.get(id) ?? this.pending.get(id)
  }

  /** Send the creates of `id` to `worker` until `settle` is called. */
  claim(id: string, worker: Worker): () => void {
    this.pending.set(id, worker)
    return () => {
      if (this.pending.get(id) === worker) this.pending.delete(id)
    }
  }

  /** Record `id` as held by `worker`. */
  adopt(id: string, worker: Worker): void {
    if (worker.dead) return
    const previous = this.homes.get(id)
    if (previous !== undefined && previous !== worker) previous.live.delete(id)
    this.homes.set(id, worker)
    worker.live.add(id)
  }

  /** Record `id` as closed: its worker stays its home. */
  release(id: string): void {
    this.homes.get(id)?.live.delete(id)
  }

  /** Record `id` as deleted. */
  forget(id: string): void {
    this.release(id)
    this.homes.delete(id)
  }

  /** How many workspaces the workers hold, those being created among them. */
  held(): number {
    return this.count() + this.reserved
  }

  /** How many workspaces the workers hold. */
  count(): number {
    return this.workers.reduce((sum, worker) => sum + worker.live.size, 0)
  }

  /** A worker that exited: its workspaces are gone with it. */
  private lost(worker: Worker): void {
    if (this.stopping) return
    for (const [id, home] of this.homes) if (home === worker) this.homes.delete(id)
    worker.live.clear()
    this.onLost()
  }
}
