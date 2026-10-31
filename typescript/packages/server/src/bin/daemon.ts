#!/usr/bin/env node
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

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { buildApp, type BuildAppOptions, type MirageApp } from '../app.ts'
import { DaemonConfigError, readDaemonTable } from '../daemon_config.ts'
import { ENV_DAEMON_PORT, ENV_IDLE_GRACE_SECONDS, ENV_WORKER_SOCKET } from '../env.ts'
import { resolveForwardedAllowIps } from '../host_validation.ts'
import { pidFilePath, mirageHome } from '../paths.ts'
import { resolveRateLimits } from '../rate_limit.ts'
import { resolveGracefulTimeout, resolveMaxWorkspaces } from '../registry.ts'
import { resolveSSHConfig } from '../ssh/config.ts'
import { buildFront, resolveCpus, resolveWorkers, WorkerPool } from '../workers.ts'

const DEFAULT_PORT = 8765

export interface DaemonEnvOpts {
  port: number
  opts: Omit<BuildAppOptions, 'onIdleExit'>
}

export function buildDaemonOpts(env: Record<string, string | undefined>): DaemonEnvOpts {
  const configPort = readDaemonTable(mirageHome(env)).port
  const port = Number(env[ENV_DAEMON_PORT] ?? configPort ?? DEFAULT_PORT)
  const idleGraceSeconds = Number(env[ENV_IDLE_GRACE_SECONDS] ?? '30')
  const opts: Omit<BuildAppOptions, 'onIdleExit'> = { idleGraceSeconds }
  return { port, opts }
}

async function writePidFile(p: string): Promise<void> {
  await mkdir(dirname(p), { recursive: true })
  await writeFile(p, String(process.pid))
}

async function removePidFile(p: string): Promise<void> {
  try {
    await rm(p, { force: true })
  } catch (err) {
    console.debug(`could not remove pid file ${p}`, err)
  }
}

/**
 * A worker of a front (`workers` above 1): the whole server on the socket
 * the front named, holding as many workspaces as the front sends it; the
 * front keeps the daemon's cap. It exits when the front is gone.
 */
async function serveWorker(socket: string): Promise<void> {
  const { opts } = buildDaemonOpts(process.env)
  const app = buildApp({ ...opts, maxWorkspaces: Number.MAX_SAFE_INTEGER })
  let exiting = false
  const stop = (): void => {
    if (exiting) return
    exiting = true
    void app
      .close()
      .catch((err: unknown) => {
        console.error('worker close error:', err)
      })
      .finally(() => process.exit(0))
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  process.stdin.once('close', stop)
  process.stdin.resume()
  await app.listen({ path: socket })
}

/**
 * The front of `workers` worker processes, on the daemon's port. The
 * daemon's SSH port and rate limits are one process's, so neither is
 * taken with workers yet.
 */
async function serveFront(port: number, workers: number, idleGraceSeconds: number): Promise<void> {
  if (resolveSSHConfig().port !== null) {
    throw new DaemonConfigError('ssh_port does not combine with workers yet')
  }
  if (resolveRateLimits().length > 0) {
    throw new DaemonConfigError('rate_limits do not combine with workers yet')
  }
  const gracefulTimeout = resolveGracefulTimeout()
  const pool = new WorkerPool({
    count: workers,
    cpus: resolveCpus(),
    command: [process.execPath, ...process.execArgv, process.argv[1] ?? ''],
    env: process.env,
    gracefulTimeout,
  })
  const pidFile = pidFilePath()
  let exiting = false
  const triggerExit = (): void => {
    if (exiting) return
    exiting = true
    void front
      .close()
      .catch((err: unknown) => {
        console.error('daemon close error:', err)
      })
      .finally(async () => {
        await removePidFile(pidFile)
        process.exit(0)
      })
  }
  const front = buildFront({
    pool,
    maxWorkspaces: resolveMaxWorkspaces(),
    proxies: resolveForwardedAllowIps(),
    idleGraceSeconds,
    exit: triggerExit,
  })
  process.on('SIGTERM', triggerExit)
  process.on('SIGINT', triggerExit)
  try {
    await pool.start()
  } catch (err) {
    await pool.stop()
    throw err
  }
  await front.listen(port, '127.0.0.1')
  await writePidFile(pidFile)
}

async function main(): Promise<void> {
  const socket = process.env[ENV_WORKER_SOCKET]
  if (socket !== undefined && socket !== '') {
    await serveWorker(socket)
    return
  }
  const { port, opts } = buildDaemonOpts(process.env)
  const workers = resolveWorkers()
  if (workers > 1) {
    await serveFront(port, workers, opts.idleGraceSeconds ?? 30)
    return
  }
  // eslint-disable-next-line prefer-const -- assigned after triggerExit closes over it
  let app: MirageApp
  let exiting = false
  const triggerExit = (): void => {
    if (exiting) return
    exiting = true
    void app
      .close()
      .catch((err: unknown) => {
        console.error('daemon close error:', err)
      })
      .finally(async () => {
        await removePidFile(app.pidFile)
        process.exit(0)
      })
  }
  app = buildApp({ ...opts, onIdleExit: triggerExit })
  process.on('SIGTERM', triggerExit)
  process.on('SIGINT', triggerExit)
  await app.listen({ port, host: '127.0.0.1' })
  await writePidFile(app.pidFile)
}

main().catch((err: unknown) => {
  if (err instanceof DaemonConfigError) {
    console.error(err.message)
    process.exit(2)
  }
  console.error(err)
  process.exit(1)
})
