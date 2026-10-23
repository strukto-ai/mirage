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

import { parseConfigWithSchema, redactConfigWithSchema, secretStr, z } from '../secrets.ts'
import type { ConfigOf, RedactedConfig } from '../secrets.ts'

const LangfuseConfigSchema = z.object({
  publicKey: z.string().describe('Langfuse project public key.'),
  secretKey: secretStr().describe('Langfuse project secret key.'),
  host: z.string().optional().meta({
    description: 'Langfuse API host; override for a self-hosted or regional instance.',
    default: 'https://cloud.langfuse.com',
  }),
  defaultTraceLimit: z.number().optional().meta({
    description:
      "The most traces one trace listing (`traces/` or a session's traces) shows. An older trace is still readable by its id.",
    default: 100,
  }),
  defaultFromTimestamp: z
    .string()
    .optional()
    .describe(
      'List only traces from this ISO 8601 timestamp on. Unset lists whatever the project holds, up to `defaultTraceLimit`.',
    ),
  fullScanLimit: z
    .number()
    .int()
    .min(-1)
    .optional()
    .meta({
      description:
        'Most files one command walks under a folder: `grep -r`, `find` and other walks stop there, and a larger glob, `tar -c`, `cp -r` or `rm -r` is refused. `-1` lifts the limit.',
      default: 1000,
    }),
})

export type LangfuseConfig = ConfigOf<typeof LangfuseConfigSchema>

export type LangfuseConfigRedacted = RedactedConfig<LangfuseConfig, 'secretKey'>

export function redactLangfuseConfig(config: LangfuseConfig): LangfuseConfigRedacted {
  return redactConfigWithSchema(LangfuseConfigSchema, config) as unknown as LangfuseConfigRedacted
}

export function normalizeLangfuseConfig(input: Record<string, unknown>): LangfuseConfig {
  return parseConfigWithSchema(LangfuseConfigSchema, input)
}
