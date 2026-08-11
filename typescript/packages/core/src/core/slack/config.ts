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
import { redactConfigWithSchema, secretStr } from '../../resource/secrets.ts'
import { normalizeFields } from '../../utils/normalize.ts'

export interface SlackConfig {
  token: string
  searchToken?: string
  baseUrl?: string
}

export interface SlackConfigRedacted {
  token: '<REDACTED>'
  searchToken?: '<REDACTED>'
  baseUrl?: string
}

export const SlackConfigSchema = z.object({
  token: secretStr(),
  searchToken: secretStr().optional(),
  baseUrl: z.string().optional(),
})

export function redactSlackConfig(config: SlackConfig): SlackConfigRedacted {
  return redactConfigWithSchema(SlackConfigSchema, config) as unknown as SlackConfigRedacted
}

export function normalizeSlackConfig(input: Record<string, unknown>): SlackConfig {
  return normalizeFields(input, {
    rename: { search_token: 'searchToken', base_url: 'baseUrl' },
  }) as unknown as SlackConfig
}
