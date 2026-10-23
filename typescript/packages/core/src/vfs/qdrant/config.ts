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
  type ConfigOf,
  parseConfigWithSchema,
  REDACTED_SECRET,
  type RedactedConfig,
  secretSchema,
  secretStr,
} from '../secrets.ts'

// What `search` vectorizes the query with when the caller brings a model:
// the text in, its embedding out, in the space the collection was built in.
export type EmbedFn = (text: string) => Promise<number[]>

const QdrantConfigSchema = z.object({
  url: z
    .string()
    .optional()
    .describe(
      'Full URL of the Qdrant server, such as a Qdrant Cloud cluster URL; when set, `host`, `port` and `https` are ignored.',
    ),
  host: z.string().optional().meta({
    description: 'Host name of the Qdrant server when `url` is unset.',
    default: 'localhost',
  }),
  port: z
    .number()
    .optional()
    .meta({ description: 'Port of the Qdrant server when `url` is unset.', default: 6333 }),
  https: z
    .boolean()
    .optional()
    .meta({ description: 'Connect to `host` over HTTPS when `url` is unset.', default: false }),
  apiKey: secretStr().optional().describe('Qdrant API key, required by Qdrant Cloud.'),
  collection: z
    .string()
    .optional()
    .describe(
      'Collection the mount root shows; unset lists every collection as a top-level folder.',
    ),
  groupBy: z.array(z.string()).optional().meta({
    description:
      "Payload fields that become folder levels, one per field in order; dotted paths reach nested keys. Unset puts every point's files directly under the collection.",
    default: [],
  }),
  basenameFields: z.array(z.string()).optional().meta({
    description:
      '`groupBy` fields whose folder names keep only the last path or URL segment of the value; two values with one basename under the same parent are refused as a collision.',
    default: [],
  }),
  idField: z.string().optional().meta({
    description:
      "Key the point id is written under in a point's `.json`; it replaces a payload field of that name.",
    default: 'id',
  }),
  nameField: z
    .string()
    .optional()
    .describe(
      "Payload field whose value prefixes each point's file stem as `<name>__<id>`; unset names files by point id alone.",
    ),
  textField: z
    .string()
    .optional()
    .describe(
      "Payload field served as the point's `.txt` file and printed by `search`; unset leaves no `.txt`, and `search` returns the `.json`.",
    ),
  blobField: z
    .string()
    .optional()
    .describe(
      'Payload field of raw or base64 bytes served as `<id>.<blobExt>` and left out of the `.json`; unset adds no blob file.',
    ),
  blobExt: z
    .string()
    .optional()
    .meta({ description: 'File extension of the blob file, without the dot.', default: 'bin' }),
  vectorField: z
    .string()
    .optional()
    .describe('Payload field holding a copy of the vector, left out of the `.json`.'),
  searchLimit: z
    .number()
    .optional()
    .meta({ description: 'Results `search` returns when `--top-k` is not given.', default: 10 }),
  maxRows: z.number().optional().meta({
    description:
      'Most points one folder listing scrolls; points past it are left out, and a group folder lists only the values those points carry.',
    default: 1000,
  }),
  embeddingModel: z.string().optional().meta({
    description:
      'Model the server embeds a `search` query with under `cloudInference`; it must match the model the stored vectors came from.',
    default: 'sentence-transformers/all-MiniLM-L6-v2',
  }),
  cloudInference: z.boolean().optional().meta({
    description:
      'Send the `search` query text to the server to embed, which needs a cluster with inference enabled (Qdrant Cloud). `embed` takes precedence; with neither, `search` refuses the query.',
    default: false,
  }),
  // Declared so parse keeps it, and marked secret so no snapshot carries
  // it: a restored mount asks for a fresh VFS rather than searching
  // with a hook it cannot have.
  embed: secretSchema(z.custom<EmbedFn>((value) => typeof value === 'function'))
    .optional()
    .describe(
      'Async function that turns a `search` query into a vector in-process, `(text: string) => Promise<number[]>`.',
    ),
  fullScanLimit: z.number().int().min(-1).optional().meta({
    description:
      'Most files one command walks under a folder: `grep -r`, `find` and other walks stop there, and a larger glob, `tar -c`, `cp -r` or `rm -r` is refused. `-1` lifts the limit.',
    default: 1000,
  }),
})

export type QdrantConfig = ConfigOf<typeof QdrantConfigSchema>

export function normalizeQdrantConfig(input: Record<string, unknown>): QdrantConfig {
  return parseConfigWithSchema(QdrantConfigSchema, input)
}

export interface QdrantConfigResolved {
  url: string | null
  host: string
  port: number
  https: boolean
  apiKey: string | null
  collection: string | null
  groupBy: string[]
  basenameFields: string[]
  idField: string
  nameField: string | null
  textField: string | null
  blobField: string | null
  blobExt: string
  vectorField: string | null
  searchLimit: number
  maxRows: number
  embeddingModel: string
  cloudInference: boolean
  embed: EmbedFn | null
}

export function resolveQdrantConfig(config: QdrantConfig): QdrantConfigResolved {
  return {
    url: config.url ?? null,
    host: config.host ?? 'localhost',
    port: config.port ?? 6333,
    https: config.https ?? false,
    apiKey: config.apiKey ?? null,
    collection: config.collection ?? null,
    groupBy: config.groupBy ?? [],
    basenameFields: config.basenameFields ?? [],
    idField: config.idField ?? 'id',
    nameField: config.nameField ?? null,
    textField: config.textField ?? null,
    blobField: config.blobField ?? null,
    blobExt: config.blobExt ?? 'bin',
    vectorField: config.vectorField ?? null,
    searchLimit: config.searchLimit ?? 10,
    maxRows: config.maxRows ?? 1000,
    embeddingModel: config.embeddingModel ?? 'sentence-transformers/all-MiniLM-L6-v2',
    cloudInference: config.cloudInference ?? false,
    embed: config.embed ?? null,
  }
}

// `apiKey` is the credential, and it is the field Python annotates secret
// on this config. A null one stays null: a local Qdrant reached without a
// credential has nothing to mask, and planting the marker anyway would
// make `Workspace.load` demand a fresh config for a self-contained
// snapshot. Python's redactor skips None for the same reason.
export type QdrantConfigRedacted = RedactedConfig<QdrantConfigResolved, 'apiKey' | 'embed'>

export function redactQdrantConfig(config: QdrantConfigResolved): QdrantConfigRedacted {
  return {
    ...config,
    apiKey: config.apiKey === null ? null : REDACTED_SECRET,
    embed: config.embed === null ? null : REDACTED_SECRET,
  }
}
