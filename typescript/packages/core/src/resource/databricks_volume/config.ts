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
  redactConfigWithSchema,
  type ConfigOf,
  type RedactedConfig,
  secretStr,
} from '../secrets.ts'
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

// The workspace credential is held the way every other account backend holds
// one, so a snapshot dumps it as <REDACTED> and the loader demands a fresh
// resource. No profile field and no environment discovery: the embedding
// program decides where the token comes from and hands it over.
const DatabricksVolumeConfigSchema = z.object({
  host: z.string().transform(normalizeHost),
  token: secretStr(),
  catalog: z.string().refine(validVolumePart, 'must be a non-empty path segment'),
  schema: z.string().refine(validVolumePart, 'must be a non-empty path segment'),
  volume: z.string().refine(validVolumePart, 'must be a non-empty path segment'),
  rootPath: z.string().transform(normalizeRootPath).default('/'),
  timeout: z.number().default(30),
})

export type DatabricksVolumeConfig = ConfigOf<typeof DatabricksVolumeConfigSchema>

export type DatabricksVolumeConfigRedacted = RedactedConfig<DatabricksVolumeConfig, 'token'>

export function redactDatabricksVolumeConfig(
  config: DatabricksVolumeConfig,
): DatabricksVolumeConfigRedacted {
  return redactConfigWithSchema(
    DatabricksVolumeConfigSchema,
    config,
  ) as unknown as DatabricksVolumeConfigRedacted
}

export function normalizeDatabricksVolumeConfig(
  input: Record<string, unknown>,
): DatabricksVolumeConfig {
  const renamed = normalizeFields(input)
  return DatabricksVolumeConfigSchema.parse(renamed) as DatabricksVolumeConfig
}
