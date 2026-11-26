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
import { secretStr } from '../secrets.ts'

export const ChromaConfig = z.object({
  host: z
    .string()
    .default('localhost')
    .meta({ description: 'Host name of the Chroma HTTP server.', default: 'localhost' }),
  port: z
    .number()
    .int()
    .default(8000)
    .meta({ description: 'Port of the Chroma HTTP server.', default: 8000 }),
  ssl: z
    .boolean()
    .default(false)
    .meta({ description: 'Connect over HTTPS instead of HTTP.', default: false }),
  apiKey: secretStr()
    .refine((value) => value.trim() !== '', 'Chroma apiKey cannot be empty')
    .nullable()
    .default(null)
    .describe(
      'Chroma API key, sent in the `x-chroma-token` header as Chroma Cloud expects. Unset sends no key.',
    ),
  collectionName: z
    .string()
    .trim()
    .min(1, 'collectionName cannot be empty')
    .describe('Name of the existing Chroma collection to mount.'),
  slugField: z.string().trim().min(1, 'slugField cannot be empty').default('page_slug').meta({
    description:
      'Chunk metadata key that holds the path of the file a chunk belongs to, relative to the mount root (`guides/quickstart.md`).',
    default: 'page_slug',
  }),
  chunkIndexField: z
    .string()
    .trim()
    .min(1, 'chunkIndexField cannot be empty')
    .default('chunk_index')
    .meta({
      description:
        "Chunk metadata key whose integer orders a file's chunks; a chunk without one sorts as `0`.",
      default: 'chunk_index',
    }),
})

export type ChromaConfig = z.input<typeof ChromaConfig>
