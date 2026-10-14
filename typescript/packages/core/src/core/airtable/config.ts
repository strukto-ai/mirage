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

/**
 * Credentials and bounds for one Airtable account. `token` is a personal
 * access token (or an OAuth access token) sent as `Authorization: Bearer`;
 * `baseIds` restricts the mount to those bases; `maxReadRecords` is the
 * most records one file may render, so a full read of a larger table stops
 * at the cap rather than paging at 5 requests a second for minutes; and
 * `requestsPerSecond` paces each base (Airtable allows 5 and answers a
 * burst with a 30-second penalty).
 */
export const AirtableConfigSchema = z
  .object({
    token: secretStr(),
    baseIds: z.array(z.string()).readonly().optional(),
    baseUrl: z.string().optional(),
    maxReadRecords: z.number().int().min(1).optional(),
    requestsPerSecond: z.number().positive().optional(),
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
