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

import { GoogleConfigSchema } from '../../core/google/config.ts'
import {
  parseConfigWithSchema,
  redactConfigWithSchema,
  type ConfigOf,
  type RedactedConfig,
  z,
} from '../secrets.ts'

const GDriveConfigSchema = GoogleConfigSchema.extend({
  fullScanLimit: z.number().int().min(-1).optional().meta({
    description:
      'Most files one command walks under a folder: `grep -r`, `find` and other walks stop there, and a larger glob, `tar -c`, `cp -r` or `rm -r` is refused. `-1` lifts the limit and reads every file without asking Drive full-text search, which lags writes and covers only extracted text.',
    default: 1000,
  }),
})

export type GDriveConfig = ConfigOf<typeof GDriveConfigSchema>

export type GDriveConfigRedacted = RedactedConfig<
  GDriveConfig,
  'accessToken' | 'clientSecret' | 'refreshToken' | 'refreshFn'
>

export function redactGDriveConfig(config: GDriveConfig): GDriveConfigRedacted {
  return redactConfigWithSchema(GDriveConfigSchema, config) as unknown as GDriveConfigRedacted
}

export function normalizeGDriveConfig(input: Record<string, unknown>): GDriveConfig {
  return parseConfigWithSchema(GDriveConfigSchema, input)
}
