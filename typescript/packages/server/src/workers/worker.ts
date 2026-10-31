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

import { spawn, type ChildProcess } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { Worker as Thread } from 'node:worker_threads'
import { ENV_FORWARDED_ALLOW_IPS, ENV_WORKER_SOCKET, ENV_WORKERS } from '../env.ts'
import { EXIT_SECONDS, READY_SECONDS } from './constants.ts'
import type { WorkerOptions } from './types.ts'

/**
 * One worker: the whole server, on a socket of its own. A worker that
 * exits stays gone, and so do its workspaces. Mirrors Python's `Worker`.
 */
export abstract class Worker {
  /** The ids of the workspaces it holds. */
  readonly live = new Set<string>()
  dead = false
  onExit: () => void = () => undefined

  constructor(readonly options: WorkerOptions) {}

  get index(): number {
    return this.options.index
  }

  get socket(): string {
    return this.options.socket
  }

  /** Start it and wait until it answers. */
  async start(): Promise<void> {
    this.launch({
      ...this.options.env,
      [ENV_WORKER_SOCKET]: this.socket,
      [ENV_WORKERS]: '1',
      // Only the daemon reaches a worker's socket, and it names the
      // client it served.
      [ENV_FORWARDED_ALLOW_IPS]: '*',
    })
    const deadline = Date.now() + READY_SECONDS * 1000
    for (;;) {
      if (this.dead) throw new Error(`mirage: worker ${String(this.index)} exited as it started`)
      if (await answers(this.socket, this.options.host)) return
      if (Date.now() > deadline) {
        await this.stop(0)
        throw new Error(`mirage: worker ${String(this.index)} did not answer`)
      }
      await delay(100)
    }
  }

  /** Stop it: it drains for `gracefulTimeout`, then exits or is ended. */
  abstract stop(gracefulTimeout: number): Promise<void>

  protected abstract launch(env: Record<string, string | undefined>): void

  protected exited(code: number | null): void {
    if (this.dead) return
    this.dead = true
    this.onExit()
    if (code !== 0) console.error(`mirage: worker ${String(this.index)} exited (${String(code)})`)
  }
}

/** A worker in a process of its own. Mirrors Python's `ProcessWorker`. */
export class ProcessWorker extends Worker {
  private child: ChildProcess | null = null

  protected launch(env: Record<string, string | undefined>): void {
    const execArgv = this.options.execArgv ?? process.execArgv
    const child = spawn(process.execPath, [...execArgv, this.options.entry], {
      env,
      // A worker exits when its stdin closes: the daemon is gone.
      stdio: ['pipe', 'inherit', 'inherit'],
    })
    this.child = child
    child.once('exit', (code) => {
      this.exited(code)
    })
    child.once('error', (error) => {
      console.error(`mirage: worker ${String(this.index)} did not start:`, error)
      this.exited(null)
    })
  }

  async stop(gracefulTimeout: number): Promise<void> {
    const child = this.child
    if (child === null || this.dead) return
    const exited = new Promise<void>((resolve) =>
      child.once('exit', () => {
        resolve()
      }),
    )
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), (gracefulTimeout + EXIT_SECONDS) * 1000)
    try {
      await exited
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * A worker on a thread of the daemon's, with an event loop of its own.
 * Mirrors Python's `ThreadWorker`.
 */
export class ThreadWorker extends Worker {
  private thread: Thread | null = null

  protected launch(env: Record<string, string | undefined>): void {
    const { execArgv } = this.options
    const thread = new Thread(this.options.entry, {
      env,
      ...(execArgv === undefined ? {} : { execArgv: [...execArgv] }),
      workerData: { socket: this.socket },
    })
    this.thread = thread
    thread.once('exit', (code) => {
      this.exited(code)
    })
    thread.once('error', (error) => {
      console.error(`mirage: worker ${String(this.index)} failed:`, error)
    })
  }

  async stop(gracefulTimeout: number): Promise<void> {
    const thread = this.thread
    if (thread === null || this.dead) return
    const exited = new Promise<void>((resolve) =>
      thread.once('exit', () => {
        resolve()
      }),
    )
    thread.postMessage('stop')
    const timer = setTimeout(() => void thread.terminate(), (gracefulTimeout + EXIT_SECONDS) * 1000)
    try {
      await exited
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Whether the server on `socket` answers its health check. */
function answers(socket: string, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = httpRequest(
      { socketPath: socket, path: '/v1/health', method: 'GET', headers: { host } },
      (res) => {
        res.resume()
        resolve(res.statusCode === 200)
      },
    )
    probe.once('error', (error) => {
      // A worker still starting refuses its socket; the caller retries.
      console.debug('mirage: a worker did not answer its health check:', error)
      resolve(false)
    })
    probe.end()
  })
}
