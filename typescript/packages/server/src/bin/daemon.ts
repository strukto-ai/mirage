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

import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { buildApp, type BuildAppOptions, type MirageApp } from '../app.ts'
import {
  ENV_DAEMON_PORT,
  ENV_IDLE_GRACE_SECONDS,
  ENV_SNAPSHOT_ROOT,
  ENV_VERSION_ROOT,
} from '../env.ts'

const DEFAULT_PORT = 8765

export interface DaemonEnvOpts {
  port: number
  opts: Omit<BuildAppOptions, 'onIdleExit'>
}

export function buildDaemonOpts(env: Record<string, string | undefined>): DaemonEnvOpts {
  const port = Number(env[ENV_DAEMON_PORT] ?? DEFAULT_PORT)
  const idleGraceSeconds = Number(env[ENV_IDLE_GRACE_SECONDS] ?? '30')
  const versionRoot = env[ENV_VERSION_ROOT]
  const snapshotRoot = env[ENV_SNAPSHOT_ROOT]
  const opts: Omit<BuildAppOptions, 'onIdleExit'> = {
    idleGraceSeconds,
    ...(versionRoot !== undefined ? { versionRoot } : {}),
    ...(snapshotRoot !== undefined ? { snapshotRoot } : {}),
  }
  return { port, opts }
}

function writePidFile(p: string): void {
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, String(process.pid))
}

function removePidFile(p: string): void {
  try {
    unlinkSync(p)
  } catch {
    // file already gone; nothing to clean up.
  }
}

async function main(): Promise<void> {
  const { port, opts } = buildDaemonOpts(process.env)
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
      .finally(() => {
        removePidFile(app.pidFile)
        process.exit(0)
      })
  }
  app = buildApp({ ...opts, onIdleExit: triggerExit })
  process.on('SIGTERM', triggerExit)
  process.on('SIGINT', triggerExit)
  await app.listen({ port, host: '127.0.0.1' })
  writePidFile(app.pidFile)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
