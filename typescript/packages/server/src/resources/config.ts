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

import type { ResourceStore } from '@struktoai/mirage-core/resources/base'
import { memoryResourceStore } from '@struktoai/mirage-core/resources/memory'
import { DaemonConfigError, readDaemonTable } from '../daemon_config.ts'
import { ENV_RESOURCE_STORE } from '../env.ts'
import { mirageHome, resourcesRootPath } from '../paths.ts'
import { filesResourceStore } from './files.ts'
import { ResourceStoreBackend } from './types.ts'

/**
 * Which store holds saved configs: `backend` when given, else
 * `$MIRAGE_RESOURCE_STORE`, else the `resource_store` key in config.toml's
 * `[daemon]` table, else files. Mirrors Python's `resolve_resource_store`.
 */
export function resolveResourceStore(
  backend?: string | null,
  env: Record<string, string | undefined> = process.env,
): ResourceStoreBackend {
  let value = backend ?? undefined
  if (value === undefined) {
    const fromEnv = env[ENV_RESOURCE_STORE]
    value =
      fromEnv !== undefined && fromEnv !== ''
        ? fromEnv
        : readDaemonTable(mirageHome(env)).resource_store
    if (value === undefined || value === '') return ResourceStoreBackend.Files
  }
  const known = Object.values(ResourceStoreBackend).find(
    (b) => b === (value as ResourceStoreBackend),
  )
  if (known !== undefined) return known
  throw new DaemonConfigError(
    `resource_store must be files or memory, got ${JSON.stringify(value)}`,
  )
}

/** The daemon's store for `backend`, in its one fixed scope. */
export function buildResourceStore(
  backend: ResourceStoreBackend,
  env: Record<string, string | undefined> = process.env,
): ResourceStore {
  return backend === ResourceStoreBackend.Memory
    ? memoryResourceStore()
    : filesResourceStore(resourcesRootPath(undefined, env))
}
