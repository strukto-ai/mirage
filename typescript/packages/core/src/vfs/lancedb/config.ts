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
import { defaultRequestTimeout } from '../../core/api/config.ts'
import { secretStr } from '../secrets.ts'

export const LanceDBConfig = z
  .object({
    timeout: defaultRequestTimeout,
    uri: z
      .string()
      .describe(
        'Database location: a local directory, an `s3://`, `gs://` or `az://` URI, or a `db://` URI for LanceDB Cloud or Enterprise.',
      ),
    apiKey: secretStr()
      .nullable()
      .default(null)
      .describe('API key for LanceDB Cloud or Enterprise.'),
    region: z.string().default('us-east-1').meta({
      description: 'LanceDB Cloud region of a `db://` database; ignored for other URIs.',
      default: 'us-east-1',
    }),
    hostOverride: z
      .string()
      .nullable()
      .default(null)
      .describe(
        'Endpoint of a LanceDB Enterprise deployment for a `db://` URI; ignored for other URIs.',
      ),
    storageOptions: z
      .record(z.string(), z.string())
      .nullable()
      .default(null)
      .describe(
        "Options passed to LanceDB's object-store layer, such as credentials or an endpoint for an `s3://` URI.",
      ),
    table: z
      .string()
      .nullable()
      .default(null)
      .describe('Table the mount root shows; unset lists every table as a top-level folder.'),
    groupBy: z.array(z.string()).default([]).meta({
      description:
        "Columns that become folder levels, one per column in order; unset puts every row's files directly under the table.",
      default: [],
    }),
    idColumn: z.string().default('id').meta({
      description: "Column whose value names each row's files (`<id>.md`, `<id>.<blobExt>`).",
      default: 'id',
    }),
    titleColumn: z
      .string()
      .nullable()
      .default(null)
      .describe(
        "Column whose value heads a row's card as a `# ` title; unset leaves the card without one.",
      ),
    blobColumn: z
      .string()
      .nullable()
      .default(null)
      .describe(
        'Column of raw or base64 bytes served as `<id>.<blobExt>` and left out of the card; unset adds no blob file.',
      ),
    blobExt: z
      .string()
      .default('bin')
      .meta({ description: 'File extension of the blob file, without the dot.', default: 'bin' }),
    vectorColumn: z
      .string()
      .nullable()
      .default(null)
      .describe('Embedding column left out of cards and listings.'),
    searchLimit: z
      .number()
      .int()
      .default(10)
      .meta({ description: 'Results `search` returns when `--top-k` is not given.', default: 10 }),
    maxRows: z.number().int().default(1000).meta({
      description:
        'Most rows one folder listing reads; rows past it are left out, and a group folder lists only the values those rows carry.',
      default: 1000,
    }),
  })
  .strict()

export type LanceDBConfig = z.input<typeof LanceDBConfig>
