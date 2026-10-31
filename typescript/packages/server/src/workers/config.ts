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

import { DaemonConfigError, readDaemonTable } from '../daemon_config.ts'
import { ENV_WORKER_TYPE, ENV_WORKERS } from '../env.ts'
import { mirageHome } from '../paths.ts'
import { WorkerType } from './types.ts'

/**
 * How many workers the daemon runs: `workers` when given, else
 * `$MIRAGE_WORKERS`, else the `workers` key in config.toml's `[daemon]`
 * table, else 1, a daemon that holds every workspace itself. Mirrors
 * Python's `resolve_workers`.
 */
export function resolveWorkers(
  workers?: number | null,
  env: Record<string, string | undefined> = process.env,
): number {
  let value: string | number | undefined = workers ?? undefined
  if (value === undefined) {
    const fromEnv = env[ENV_WORKERS]
    value =
      fromEnv !== undefined && fromEnv !== '' ? fromEnv : readDaemonTable(mirageHome(env)).workers
    if (value === undefined || value === '') return 1
  }
  const count = typeof value === 'number' ? value : /^\d+$/.test(value) ? Number(value) : 0
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new DaemonConfigError(
      `workers must be a positive whole number, got ${JSON.stringify(value)}`,
    )
  }
  return count
}

/**
 * What the workers are: `workerType` when given, else
 * `$MIRAGE_WORKER_TYPE`, else the `worker_type` key in config.toml's
 * `[daemon]` table, else threads, each with an event loop of its own.
 * Mirrors Python's `resolve_worker_type`.
 */
export function resolveWorkerType(
  workerType?: string | null,
  env: Record<string, string | undefined> = process.env,
): WorkerType {
  let value = workerType ?? undefined
  if (value === undefined) {
    const fromEnv = env[ENV_WORKER_TYPE]
    value =
      fromEnv !== undefined && fromEnv !== ''
        ? fromEnv
        : readDaemonTable(mirageHome(env)).worker_type
    if (value === undefined || value === '') return WorkerType.Thread
  }
  const type = Object.values(WorkerType).find((known) => known === (value as WorkerType))
  if (type !== undefined) return type
  throw new DaemonConfigError(`worker_type must be process or thread, got ${JSON.stringify(value)}`)
}
