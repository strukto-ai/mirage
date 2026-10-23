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
import { timeRangeShape, orderedTimes, timeRangeOrderError } from '../../core/time_config.ts'
import { GoogleConfigSchema } from '../../core/google/config.ts'
import { FULL_SCAN_LIMIT } from '../constants.ts'
import {
  type ConfigOf,
  parseConfigWithSchema,
  redactConfigWithSchema,
  type RedactedConfig,
} from '../secrets.ts'

// Calendar-only knobs live here, not on the shared Google base, so a drive
// or docs mount cannot be handed a time zone that means nothing to it.
// `safeExtend` is zod's spelling for extending a refined object: the base's
// credential check rides along, and unlike `.extend` it cannot throw at
// import time should a key here ever shadow one of the base's. Mirrors
// python's `GCalConfig(GoogleConfig)`.
export const GCalConfigSchema = GoogleConfigSchema.safeExtend({
  ...timeRangeShape,
  // One zone for the whole mount, not one per calendar: the Calendar UI
  // draws its whole grid in the primary zone, and per-calendar bucketing
  // would make the same day directory name mean different 24-hour windows
  // on different calendars.
  timeZone: z
    .string()
    .optional()
    .describe(
      "IANA time zone the mount buckets every calendar's days in. Unset uses the primary calendar's zone.",
    ),
  bucketDays: z
    .literal([1, 7, 30])
    .default(1)
    .describe(
      'Days each date directory under a calendar holds: `1` names it by its day, `7` and `30` by its first and last day (`<first>--<last>`).',
    ),
  minAccessRole: z
    .string()
    .optional()
    .describe(
      'List only calendars where the account has at least this access role: `freeBusyReader`, `reader`, `writer` or `owner`. Unset lists every calendar.',
    ),
  today: z
    .string()
    .optional()
    .describe(
      "Day (`YYYY-MM-DD`) the default listing's 90-day future horizon is measured from, for tests and snapshots. Unset uses the current date in the mount's time zone.",
    ),
  fullScanLimit: z.number().int().min(-1).default(FULL_SCAN_LIMIT).meta({
    description:
      "Most files one command walks under a folder: `grep -r`, `find` and other walks stop there, and a larger glob, `tar -c`, `cp -r` or `rm -r` is refused. `-1` lifts the limit and reads every event without asking Calendar's search; the listing then keeps no event text.",
    default: 1000,
  }),
}).refine(orderedTimes, timeRangeOrderError)

export type GCalConfig = ConfigOf<typeof GCalConfigSchema>

export type GCalConfigRedacted = RedactedConfig<
  GCalConfig,
  'accessToken' | 'clientSecret' | 'refreshToken' | 'refreshFn'
>

export function redactGCalConfig(config: GCalConfig): GCalConfigRedacted {
  return redactConfigWithSchema(GCalConfigSchema, config) as unknown as GCalConfigRedacted
}

export function normalizeGCalConfig(input: Record<string, unknown>): GCalConfig {
  return parseConfigWithSchema(GCalConfigSchema, input)
}
