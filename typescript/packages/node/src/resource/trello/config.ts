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

export interface TrelloConfig {
  apiKey: string
  apiToken: string
  workspaceId?: string
  boardIds?: readonly string[]
  baseUrl?: string
}

export interface TrelloConfigRedacted {
  apiKey: '<REDACTED>'
  apiToken: '<REDACTED>'
  workspaceId?: string
  boardIds?: readonly string[]
  baseUrl?: string
}

const TrelloConfigSchema = z.object({
  apiKey: secretStr(),
  apiToken: secretStr(),
  workspaceId: z.string().optional(),
  boardIds: z.array(z.string()).optional(),
  baseUrl: z.string().optional(),
})

export function redactTrelloConfig(config: TrelloConfig): TrelloConfigRedacted {
  return redactConfigWithSchema(TrelloConfigSchema, config) as unknown as TrelloConfigRedacted
}

export function normalizeTrelloConfig(input: Record<string, unknown>): TrelloConfig {
  return normalizeFields(input, {
    rename: {
      api_key: 'apiKey',
      api_token: 'apiToken',
      workspace_id: 'workspaceId',
      board_ids: 'boardIds',
      base_url: 'baseUrl',
    },
  }) as unknown as TrelloConfig
}
