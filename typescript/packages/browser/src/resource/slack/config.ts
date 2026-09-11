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
  z,
} from '@struktoai/mirage-core/resource/secrets'
import type { ConfigOf, RedactedConfig } from '@struktoai/mirage-core/resource/secrets'

type HeaderProvider = () => Promise<Record<string, string>> | Record<string, string>

const SlackConfigSchema = z.object({
  proxyUrl: z.string(),
  getHeaders: secretSchema(
    z.custom<HeaderProvider>((value) => typeof value === 'function'),
  ).optional(),
})

export type SlackConfig = ConfigOf<typeof SlackConfigSchema>

export type SlackConfigRedacted = RedactedConfig<SlackConfig, 'getHeaders'>

export function redactSlackConfig(config: SlackConfig): SlackConfigRedacted {
  return redactConfigWithSchema(SlackConfigSchema, config) as unknown as SlackConfigRedacted
}

/**
 * Translate a python-style config blob to this one's camelCase.
 *
 * No rename map: every field's camelCase spelling is what `snakeToCamel`
 * already produces, and restating those only creates a second place to be
 * wrong. Mirrors node's `normalizeSlackConfig`.
 */
export function normalizeSlackConfig(input: Record<string, unknown>): SlackConfig {
  return parseConfigWithSchema(SlackConfigSchema, input)
}
