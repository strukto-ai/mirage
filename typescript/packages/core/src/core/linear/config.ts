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
} from '../../vfs/secrets.ts'

export const LinearConfigSchema = z.object({
  apiKey: secretStr().describe('Linear personal API key.'),
  workspace: z.string().optional().describe('Accepted for compatibility; not read.'),
  teamIds: z
    .array(z.string())
    .readonly()
    .optional()
    .describe('Only these teams are listed or readable. Unset shows every team the key can reach.'),
  baseUrl: z.string().optional().meta({
    description: 'Linear GraphQL endpoint; override to point at a fake or proxy.',
    default: 'https://api.linear.app/graphql',
  }),
  walkLimit: z.number().int().min(-1).optional().meta({
    description:
      "Most files one command walks under a folder: `grep -r`, `find` and other walks stop there, and a larger glob, `tar -c`, `cp -r` or `rm -r` is refused. `-1` lifts the limit and reads every file without asking Linear's search, which lags writes.",
    default: 1000,
  }),
})

export type LinearConfig = ConfigOf<typeof LinearConfigSchema>

export type LinearConfigRedacted = RedactedConfig<LinearConfig, 'apiKey'>

export function redactLinearConfig(config: LinearConfig): LinearConfigRedacted {
  return redactConfigWithSchema(LinearConfigSchema, config) as unknown as LinearConfigRedacted
}

export function normalizeLinearConfig(input: Record<string, unknown>): LinearConfig {
  return parseConfigWithSchema(LinearConfigSchema, input)
}
