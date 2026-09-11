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
import { parseConfigWithSchema, redactConfigWithSchema, secretStr } from '../../resource/secrets.ts'

const GitHubConfigSchema = z.object({
  token: secretStr(),
  owner: z.string(),
  repo: z.string(),
  ref: z.string().optional(),
  baseUrl: z.string().optional(),
})

export type GitHubConfig = ConfigOf<typeof GitHubConfigSchema>

export type GitHubConfigRedacted = RedactedConfig<GitHubConfig, 'token'>

export function redactGitHubConfig(config: GitHubConfig): GitHubConfigRedacted {
  return redactConfigWithSchema(GitHubConfigSchema, config) as unknown as GitHubConfigRedacted
}

export function normalizeGitHubConfig(input: Record<string, unknown>): GitHubConfig {
  return parseConfigWithSchema(GitHubConfigSchema, input)
}

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
