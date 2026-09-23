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
import { GoogleConfigSchema } from '../../core/google/config.ts'
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
  // One zone for the whole mount, not one per calendar: the Calendar UI
  // draws its whole grid in the primary zone, and per-calendar bucketing
  // would make the same day directory name mean different 24-hour windows
  // on different calendars. Defaults to the primary calendar's zone.
  timeZone: z.string().optional(),
  // Keep only calendars at or above this accessRole, e.g. "writer" for
  // ones the agent can actually schedule into.
  minAccessRole: z.string().optional(),
  // Pin the day the rolling window centres on; test and snapshot use.
  today: z.string().optional(),
})

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
