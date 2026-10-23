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
} from '@struktoai/mirage-core/vfs/secrets'
import type { ConfigOf } from '@struktoai/mirage-core/vfs/secrets'

const JaegerConfigSchema = z.object({
  host: z.string().optional().meta({
    description: 'Jaeger query service URL.',
    default: 'http://localhost:16686',
  }),
  defaultTraceLimit: z.number().optional().meta({
    description:
      "The most traces one service's `traces/` listing shows, newest first. An older trace is still readable by its id.",
    default: 100,
  }),
  defaultFromTimestamp: z
    .string()
    .optional()
    .describe(
      'Lower bound of trace listings, an ISO 8601 timestamp. Unset searches from the beginning.',
    ),
  defaultToTimestamp: z
    .string()
    .optional()
    .describe('Upper bound of trace listings, an ISO 8601 timestamp. Unset means now.'),
  requestTimeout: z.number().optional().meta({
    description: 'Seconds to wait for one HTTP request to Jaeger.',
    default: 30,
  }),
  fullScanLimit: z.number().int().min(-1).optional().meta({
    description:
      'Most files one command walks under a folder: `grep -r`, `find` and other walks stop there, and a larger glob, `tar -c`, `cp -r` or `rm -r` is refused. `-1` lifts the limit.',
    default: 1000,
  }),
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
