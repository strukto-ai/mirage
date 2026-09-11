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
  z,
} from '@struktoai/mirage-core/resource/secrets'
import type { ConfigOf } from '@struktoai/mirage-core/resource/secrets'

const JaegerConfigSchema = z.object({
  host: z.string().optional(),
  defaultTraceLimit: z.number().optional(),
  defaultFromTimestamp: z.string().optional(),
  defaultToTimestamp: z.string().optional(),
  requestTimeout: z.number().optional(),
})

export type JaegerConfig = ConfigOf<typeof JaegerConfigSchema>

// Nothing on a Jaeger config is a secret, so the twin is the config.
export type JaegerConfigRedacted = JaegerConfig

export function redactJaegerConfig(config: JaegerConfig): JaegerConfigRedacted {
  return redactConfigWithSchema(JaegerConfigSchema, config) as unknown as JaegerConfigRedacted
}

export function normalizeJaegerConfig(input: Record<string, unknown>): JaegerConfig {
  return parseConfigWithSchema(JaegerConfigSchema, input)
}
