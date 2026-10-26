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

import { parseConfigWithSchema, redactConfigWithSchema, secretStr, z } from '../../vfs/secrets.ts'
import type { ConfigOf, RedactedConfig } from '../../vfs/secrets.ts'
import { timeoutShape } from '../api/config.ts'

export const TrelloConfigSchema = z.object({
  ...timeoutShape,
  apiKey: secretStr().describe('Trello API key.'),
  apiToken: secretStr().describe('Trello API token.'),
  workspaceId: z
    .string()
    .optional()
    .describe(
      "Only this workspace and its boards are listed or readable. Unset shows every workspace of the token's member.",
    ),
  boardIds: z
    .array(z.string())
    .readonly()
    .optional()
    .describe(
      'Only these boards are listed or readable. Unset shows every open board of the shown workspaces.',
    ),
  baseUrl: z.string().optional().meta({
    description: 'Trello API root; override to point at a fake or proxy.',
    default: 'https://api.trello.com/1',
  }),
})

export type TrelloConfig = ConfigOf<typeof TrelloConfigSchema>

export type TrelloConfigRedacted = RedactedConfig<TrelloConfig, 'apiKey' | 'apiToken'>

export function redactTrelloConfig(config: TrelloConfig): TrelloConfigRedacted {
  return redactConfigWithSchema(TrelloConfigSchema, config) as unknown as TrelloConfigRedacted
}

export function normalizeTrelloConfig(input: Record<string, unknown>): TrelloConfig {
  return parseConfigWithSchema(TrelloConfigSchema, input)
}
