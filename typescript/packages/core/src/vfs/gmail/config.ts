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

import { GoogleConfigSchema } from '../../core/google/config.ts'
import {
  parseConfigWithSchema,
  redactConfigWithSchema,
  type ConfigOf,
  type RedactedConfig,
  z,
} from '../secrets.ts'

const GmailConfigSchema = GoogleConfigSchema.extend({
  // Let grep -w and rg -w read only the messages Gmail search names
  // (`filesContaining`). Off by default: Gmail indexes a message some time
  // after it arrives.
  contentSearch: z.boolean().optional(),
})

export type GmailConfig = ConfigOf<typeof GmailConfigSchema>

export type GmailConfigRedacted = RedactedConfig<
  GmailConfig,
  'accessToken' | 'clientSecret' | 'refreshToken' | 'refreshFn'
>

export function redactGmailConfig(config: GmailConfig): GmailConfigRedacted {
  return redactConfigWithSchema(GmailConfigSchema, config) as unknown as GmailConfigRedacted
}

export function normalizeGmailConfig(input: Record<string, unknown>): GmailConfig {
  return parseConfigWithSchema(GmailConfigSchema, input)
}
