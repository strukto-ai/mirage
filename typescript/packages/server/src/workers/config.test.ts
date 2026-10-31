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

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DaemonConfigError } from '../daemon_config.ts'
import { ENV_HOME, ENV_WORKER_TYPE, ENV_WORKERS } from '../env.ts'
import { resolveWorkers, resolveWorkerType } from './config.ts'
import { WorkerType } from './types.ts'

describe('resolveWorkers', () => {
  it('reads the env, then config, else 1', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mir-workers-'))
    try {
      const env = { [ENV_HOME]: home }
      expect(resolveWorkers(undefined, env)).toBe(1)
      await writeFile(join(home, 'config.toml'), '[daemon]\nworkers = 4\n')
      expect(resolveWorkers(undefined, env)).toBe(4)
      expect(resolveWorkers(undefined, { ...env, [ENV_WORKERS]: '2' })).toBe(2)
      expect(resolveWorkers(8, env)).toBe(8)
      expect(() => resolveWorkers(undefined, { [ENV_WORKERS]: '0' })).toThrow(DaemonConfigError)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('resolveWorkerType', () => {
  it('reads the env, then config, else threads', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mir-workers-'))
    try {
      const env = { [ENV_HOME]: home }
      expect(resolveWorkerType(undefined, env)).toBe(WorkerType.Thread)
      await writeFile(join(home, 'config.toml'), '[daemon]\nworker_type = "process"\n')
      expect(resolveWorkerType(undefined, env)).toBe(WorkerType.Process)
      expect(resolveWorkerType(undefined, { ...env, [ENV_WORKER_TYPE]: 'thread' })).toBe(
        WorkerType.Thread,
      )
      expect(() => resolveWorkerType('cpu', env)).toThrow(DaemonConfigError)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
