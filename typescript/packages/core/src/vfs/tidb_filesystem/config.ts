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
  parseConfigWithSchema,
  redactConfigWithSchema,
  type ConfigOf,
  type RedactedConfig,
  secretStr,
} from '../secrets.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { timeoutShape } from '../../core/api/config.ts'

function normalizeRootPath(value: string): string {
  const parts = value.split('/').filter((p) => p !== '' && p !== '.')
  if (parts.some((p) => p === '..')) {
    throw new Error("root_path must not contain '..' segments")
  }
  if (parts.length === 0) return '/'
  return '/' + parts.join('/')
}

const TiDBFilesystemConfigSchema = z.object({
  ...timeoutShape,
  host: z
    .string()
    .transform(rstripSlash)
    .describe(
      "The file system's endpoint, such as `https://aws-us-east-1.drive9.ai` for its region, or the origin of a self-hosted drive9 server.",
    ),
  token: secretStr().describe('The file system token, sent as a bearer token.'),
  rootPath: z
    .string()
    .transform(normalizeRootPath)
    .default('/')
    .describe(
      'Directory inside the file system that becomes the mount root, such as `/projects/a` for a token scoped to it; `..` segments are refused.',
    ),
})

export type TiDBFilesystemConfig = ConfigOf<typeof TiDBFilesystemConfigSchema>

export type TiDBFilesystemConfigRedacted = RedactedConfig<TiDBFilesystemConfig, 'token'>

export function redactTiDBFilesystemConfig(
  config: TiDBFilesystemConfig,
): TiDBFilesystemConfigRedacted {
  return redactConfigWithSchema(
    TiDBFilesystemConfigSchema,
    config,
  ) as unknown as TiDBFilesystemConfigRedacted
}

export function normalizeTiDBFilesystemConfig(
  input: Record<string, unknown>,
): TiDBFilesystemConfig {
  return parseConfigWithSchema(TiDBFilesystemConfigSchema, input)
}
