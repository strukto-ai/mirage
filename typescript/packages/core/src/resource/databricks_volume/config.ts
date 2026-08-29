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
import type { ConfigOf } from '../secrets.ts'
import { normalizeFields } from '../../utils/normalize.ts'

function normalizeHost(value: string): string {
  const trimmed = value.replace(/\/+$/, '')
  if (trimmed === '') {
    throw new Error('host must be a non-empty workspace URL')
  }
  return trimmed
}

function validVolumePart(value: string): boolean {
  return value !== '' && !value.includes('/')
}

function normalizeRootPath(value: string): string {
  const parts = value.split('/').filter((p) => p !== '' && p !== '.')
  if (parts.some((p) => p === '..')) {
    throw new Error("root_path must not contain '..' segments")
  }
  if (parts.length === 0) return '/'
  return '/' + parts.join('/')
}

// Location and transport only: the credential reaches the resource through a
// TokenProvider, so this config holds no secret at all and a snapshot of it
// has nothing to redact.
const DatabricksVolumeConfigSchema = z.object({
  host: z.string().transform(normalizeHost),
  catalog: z.string().refine(validVolumePart, 'must be a non-empty path segment'),
  schema: z.string().refine(validVolumePart, 'must be a non-empty path segment'),
  volume: z.string().refine(validVolumePart, 'must be a non-empty path segment'),
  rootPath: z.string().transform(normalizeRootPath).default('/'),
  timeout: z.number().default(30),
})

export type DatabricksVolumeConfig = ConfigOf<typeof DatabricksVolumeConfigSchema>

// No credential in this config, so the snapshot carries it whole; the mount
// still needs an override at load because the token provider is runtime state.
export type DatabricksVolumeConfigRedacted = DatabricksVolumeConfig

export function redactDatabricksVolumeConfig(
  config: DatabricksVolumeConfig,
): DatabricksVolumeConfigRedacted {
  return { ...config }
}

export function normalizeDatabricksVolumeConfig(
  input: Record<string, unknown>,
): DatabricksVolumeConfig {
  const renamed = normalizeFields(input)
  return DatabricksVolumeConfigSchema.parse(renamed) as DatabricksVolumeConfig
}
