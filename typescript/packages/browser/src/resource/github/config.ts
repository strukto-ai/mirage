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

import { normalizeFields, redactConfigWithSchema, secretStr, z } from '@struktoai/mirage-core'

export interface GitHubConfig {
  token: string
  owner: string
  repo: string
  ref?: string
  baseUrl?: string
}

export interface GitHubConfigRedacted {
  token: '<REDACTED>'
  owner: string
  repo: string
  ref?: string
  baseUrl?: string
}

export const GitHubConfigSchema = z.object({
  token: secretStr(),
  owner: z.string(),
  repo: z.string(),
  ref: z.string().optional(),
  baseUrl: z.string().optional(),
})

export function redactGitHubConfig(config: GitHubConfig): GitHubConfigRedacted {
  return redactConfigWithSchema(GitHubConfigSchema, config) as unknown as GitHubConfigRedacted
}

export function normalizeGitHubConfig(input: Record<string, unknown>): GitHubConfig {
  return normalizeFields(input, {
    rename: { base_url: 'baseUrl' },
  }) as unknown as GitHubConfig
}
