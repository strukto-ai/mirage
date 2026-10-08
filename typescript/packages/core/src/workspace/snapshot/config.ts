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

import { IndexType, type IndexConfig, type RedisIndexConfig } from '../../cache/index/config.ts'
import { REDACTED_SECRET, hasRedactedSecret } from '../../vfs/secrets.ts'
import type { CLISpec } from '../../commands/cli/types.ts'
import type { Mount } from '../mount/spec.ts'
import type { WritePolicy } from '../../types.ts'

export interface MountArgs {
  clis?: Record<string, [string | CLISpec, Record<string, unknown> | null]>
  mountArgs: Record<string, Mount>
  defaultSessionId: string | undefined
  defaultAgentId: string | null
  writeDefault: WritePolicy
}

export interface IndexConfigSnapshot {
  type: IndexType
  ttl: number
  url?: string
  key_prefix?: string
}

export function indexConfigDump(
  config: IndexConfig | undefined,
  reveal = false,
): IndexConfigSnapshot | null {
  if (config === undefined) return null
  const data: IndexConfigSnapshot = { type: config.type ?? IndexType.RAM, ttl: config.ttl ?? 600 }
  if (data.type === IndexType.REDIS) {
    const redis = config as RedisIndexConfig
    data.url = redis.url ?? 'redis://localhost:6379/0'
    data.key_prefix = redis.keyPrefix ?? 'mirage:index:'
    const url = new URL(data.url)
    if (!reveal && (url.username !== '' || url.password !== '')) data.url = REDACTED_SECRET
  }
  return data
}

export function restoreIndexConfig(
  data: IndexConfigSnapshot | null | undefined,
  override: IndexConfig | undefined,
  prefix: string,
): IndexConfig | undefined {
  if (override !== undefined) return override
  if (data == null) return undefined
  if (hasRedactedSecret(data)) {
    throw new Error(
      `Workspace.load: mount '${prefix}' needs a Mount override with fresh index credentials`,
    )
  }
  const config: RedisIndexConfig = { type: data.type, ttl: data.ttl }
  if (data.url !== undefined) config.url = data.url
  if (data.key_prefix !== undefined) config.keyPrefix = data.key_prefix
  return config
}
