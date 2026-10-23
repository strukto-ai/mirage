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

/** Credentials and bounds for one Airtable account. */
export const AirtableConfigSchema = z
  .object({
    token: secretStr().describe(
      'Personal access token (or OAuth access token), sent as `Authorization: Bearer`.',
    ),
    baseIds: z
      .array(z.string())
      .readonly()
      .optional()
      .describe(
        'Only these bases are listed or readable. Unset shows every base the token can reach.',
      ),
    baseUrl: z.string().optional().meta({
      description: 'Airtable API root; override to point at a fake or proxy.',
      default: 'https://api.airtable.com/v0',
    }),
    maxReadRecords: z.number().int().min(1).optional().meta({
      description:
        'The most records one file renders. A full read of a larger table or view fails with `File too large` once it passes the cap; `head -n N` still reads its first records.',
      default: 10000,
    }),
    requestsPerSecond: z.number().positive().optional().meta({
      description:
        'Requests per second per base. Airtable allows 5 and answers a burst with a 30-second penalty.',
      default: 5,
    }),
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
  .strict()

export type AirtableConfig = ConfigOf<typeof AirtableConfigSchema>

export type AirtableConfigRedacted = RedactedConfig<AirtableConfig, 'token'>

export function redactAirtableConfig(config: AirtableConfig): AirtableConfigRedacted {
  return redactConfigWithSchema(AirtableConfigSchema, config) as unknown as AirtableConfigRedacted
}

export function normalizeAirtableConfig(input: Record<string, unknown>): AirtableConfig {
  return parseConfigWithSchema(AirtableConfigSchema, input)
}
