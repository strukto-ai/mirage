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

import { z } from 'zod'
import {
  type ConfigOf,
  parseConfigWithSchema,
  REDACTED_SECRET,
  type RedactedConfig,
  secretStr,
} from '../secrets.ts'

// `dsn` is the credential, so it carries the secret marker the redactor
// reads; the rest are the knobs python's `PostgresConfig` declares.
const PostgresConfigSchema = z.object({
  dsn: secretStr(),
  schemas: z.array(z.string()).readonly().optional(),
  defaultRowLimit: z.number().optional(),
  maxReadRows: z.number().optional(),
  maxReadBytes: z.number().optional(),
  defaultSearchLimit: z.number().optional(),
})

export type PostgresConfig = ConfigOf<typeof PostgresConfigSchema>

export interface PostgresConfigResolved {
  dsn: string
  schemas: readonly string[] | null
  defaultRowLimit: number
  maxReadRows: number
  maxReadBytes: number
  defaultSearchLimit: number
}

export function normalizePostgresConfig(input: Record<string, unknown>): PostgresConfig {
  return parseConfigWithSchema(PostgresConfigSchema, input)
}

export function resolvePostgresConfig(config: PostgresConfig): PostgresConfigResolved {
  return {
    dsn: config.dsn,
    schemas: config.schemas ?? null,
    defaultRowLimit: config.defaultRowLimit ?? 1000,
    maxReadRows: config.maxReadRows ?? 10_000,
    maxReadBytes: config.maxReadBytes ?? 10 * 1024 * 1024,
    defaultSearchLimit: config.defaultSearchLimit ?? 100,
  }
}

// `dsn` is the credential. Masking it is what makes
// `resourceStateRequiresOverride` demand a fresh one at load instead of
// quietly rebuilding the mount as an empty RAMResource. Mirrors the
// field Python annotates secret on this config.
export type PostgresConfigRedacted = RedactedConfig<PostgresConfigResolved, 'dsn'>

export function redactPostgresConfig(config: PostgresConfigResolved): PostgresConfigRedacted {
  return { ...config, dsn: REDACTED_SECRET }
}
