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
import type { ConfigOf, RedactedConfig } from '../../resource/secrets.ts'
import { redactConfigWithSchema, secretStr } from '../../resource/secrets.ts'
import { normalizeFields } from '../../utils/normalize.ts'

export const GhConfigSchema = z.object({
  token: secretStr(),
  baseUrl: z.string().optional(),
  repo: z.string().optional(),
  branch: z.string().optional(),
})

// Derived, not declared twice. The schema is the one doing real work --
// it validates an install's config and carries the `secretStr` marker
// redaction reads -- so a hand-written twin only adds a shape that can
// drift from it, which is how `branch` reached the schema and not the type.
export type GhConfig = ConfigOf<typeof GhConfigSchema>

export type GhConfigRedacted = RedactedConfig<GhConfig, 'token'>

export function redactGhConfig(config: GhConfig): GhConfigRedacted {
  return redactConfigWithSchema(GhConfigSchema, config) as unknown as GhConfigRedacted
}

export function normalizeGhConfig(input: Record<string, unknown>): GhConfig {
  return normalizeFields(input, {}) as unknown as GhConfig
}
