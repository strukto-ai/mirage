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
} from '../../resource/secrets.ts'

export const DiscordConfigSchema = z.object({
  token: secretStr(),
  baseUrl: z.string().optional(),
})

export type DiscordConfig = ConfigOf<typeof DiscordConfigSchema>

export type DiscordConfigRedacted = RedactedConfig<DiscordConfig, 'token'>

export function redactDiscordConfig(config: DiscordConfig): DiscordConfigRedacted {
  return redactConfigWithSchema(DiscordConfigSchema, config) as unknown as DiscordConfigRedacted
}

export function normalizeDiscordConfig(input: Record<string, unknown>): DiscordConfig {
  return parseConfigWithSchema(DiscordConfigSchema, input)
}
