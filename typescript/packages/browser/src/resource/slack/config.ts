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

import { redactConfigWithSchema, secretSchema, z } from '@struktoai/mirage-core'

export interface SlackConfig {
  proxyUrl: string
  getHeaders?: () => Promise<Record<string, string>> | Record<string, string>
}

export interface SlackConfigRedacted {
  proxyUrl: string
  getHeaders?: '<REDACTED>'
}

export const SlackConfigSchema = z.object({
  proxyUrl: z.string(),
  getHeaders: secretSchema(
    z.custom<SlackConfig['getHeaders']>((value) => typeof value === 'function'),
  ).optional(),
})

export function redactSlackConfig(config: SlackConfig): SlackConfigRedacted {
  return redactConfigWithSchema(SlackConfigSchema, config) as unknown as SlackConfigRedacted
}
