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

import {
  parseConfigWithSchema,
  redactConfigWithSchema,
  secretSchema,
  secretStr,
  z,
} from '@struktoai/mirage-core/resource/secrets'
import type { ConfigOf, RedactedConfig } from '@struktoai/mirage-core/resource/secrets'

export interface DropboxConfig {
  clientId: string
  clientSecret?: string
  refreshToken: string
  rootPath?: string
  contentSearch?: boolean
  endpoint?: string
  refreshFn?: (refreshToken: string) => Promise<{ accessToken: string; expiresIn: number }>
}

const DropboxConfigSchema = z.object({
  clientId: z.string(),
  clientSecret: secretStr().optional(),
  refreshToken: secretStr(),
  rootPath: z.string().optional(),
  contentSearch: z.boolean().optional(),
  endpoint: z.string().optional(),
  // Declared so parse keeps it, marked secret so no snapshot carries it.
  refreshFn: secretSchema(
    z.custom<NonNullable<DropboxConfig['refreshFn']>>((value) => typeof value === 'function'),
  ).optional(),
})

export type DropboxConfigRedacted = RedactedConfig<
  ConfigOf<typeof DropboxConfigSchema>,
  'clientSecret' | 'refreshToken' | 'refreshFn'
>

export function redactDropboxConfig(config: DropboxConfig): DropboxConfigRedacted {
  return redactConfigWithSchema(DropboxConfigSchema, config) as unknown as DropboxConfigRedacted
}

export function normalizeDropboxConfig(input: Record<string, unknown>): DropboxConfig {
  return parseConfigWithSchema(DropboxConfigSchema, input)
}
