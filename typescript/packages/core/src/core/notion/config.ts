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

export const NotionConfigSchema = z.object({
  apiKey: secretStr().describe('Notion integration token.'),
  baseUrl: z.string().optional().meta({
    description: 'Notion API root; override to point at a fake or proxy.',
    default: 'https://api.notion.com/v1',
  }),
  apiVersion: z.string().optional().meta({
    description:
      '`Notion-Version` header sent with every request; `ntn --notion-version` overrides it per line.',
    default: '2025-09-03',
  }),
  fullScanLimit: z.number().int().min(-1).optional().meta({
    description:
      'Most files one command walks under a folder: `grep -r`, `find` and other walks stop there, and a larger glob, `tar -c`, `cp -r` or `rm -r` is refused. `-1` lifts the limit.',
    default: 1000,
  }),
})

export type NotionConfig = ConfigOf<typeof NotionConfigSchema>

export type NotionConfigRedacted = RedactedConfig<NotionConfig, 'apiKey'>

export function redactNotionConfig(config: NotionConfig): NotionConfigRedacted {
  return redactConfigWithSchema(NotionConfigSchema, config) as unknown as NotionConfigRedacted
}

export function normalizeNotionConfig(input: Record<string, unknown>): NotionConfig {
  return parseConfigWithSchema(NotionConfigSchema, input)
}
