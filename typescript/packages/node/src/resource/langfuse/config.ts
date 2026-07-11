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

import { normalizeFields, redactConfigWithSchema, secretStr, z } from '@struktoai/mirage-core'

export interface LangfuseConfig {
  publicKey: string
  secretKey: string
  host?: string
  defaultTraceLimit?: number
  defaultSearchLimit?: number
  defaultFromTimestamp?: string
}

export interface LangfuseConfigRedacted {
  publicKey: string
  secretKey: '<REDACTED>'
  host?: string
  defaultTraceLimit?: number
  defaultSearchLimit?: number
  defaultFromTimestamp?: string
}

const LangfuseConfigSchema = z.object({
  publicKey: z.string(),
  secretKey: secretStr(),
  host: z.string().optional(),
  defaultTraceLimit: z.number().optional(),
  defaultSearchLimit: z.number().optional(),
  defaultFromTimestamp: z.string().optional(),
})

export function redactLangfuseConfig(config: LangfuseConfig): LangfuseConfigRedacted {
  return redactConfigWithSchema(LangfuseConfigSchema, config) as unknown as LangfuseConfigRedacted
}

export function normalizeLangfuseConfig(input: Record<string, unknown>): LangfuseConfig {
  return normalizeFields(input, {
    rename: {
      public_key: 'publicKey',
      secret_key: 'secretKey',
      default_trace_limit: 'defaultTraceLimit',
      default_search_limit: 'defaultSearchLimit',
      default_from_timestamp: 'defaultFromTimestamp',
    },
  }) as unknown as LangfuseConfig
}
