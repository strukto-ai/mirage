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
import { rstripSlash } from '../../utils/slash.ts'
import {
  type ConfigOf,
  normalizeNonEmpty,
  parseConfigWithSchema,
  REDACTED_SECRET,
  type RedactedConfig,
  secretStr,
} from '../secrets.ts'

const DifyConfigSchema = z.object({
  apiKey: secretStr().describe('Dify Knowledge API key, sent as `Authorization: Bearer`.'),
  baseUrl: z.string().describe('Dify API root, such as `https://api.dify.ai/v1`.'),
  datasetId: z.string().describe('ID of the Knowledge dataset the mount shows.'),
  slugMetadataName: z.string().optional().meta({
    description:
      "Document metadata field whose value is the document's path in the mount. A document without it is mounted under its document name.",
    default: 'slug',
  }),
  maxConcurrency: z.number().optional().meta({
    description: 'The most Dify API requests in flight at once.',
    default: 10,
  }),
  requestTimeout: z.number().optional().meta({
    description: 'Seconds to wait for one HTTP request to Dify.',
    default: 30,
  }),
  retryAttempts: z.number().optional().meta({
    description:
      'Attempts per request, the first included. A 429, a 5xx or a transport error is retried.',
    default: 4,
  }),
  retryMaxDelay: z.number().optional().meta({
    description: 'Longest wait in seconds before a retry, whether from backoff or `Retry-After`.',
    default: 30,
  }),
  fullScanLimit: z
    .number()
    .int()
    .min(-1)
    .optional()
    .meta({
      description:
        'Most files one command walks under a folder: `grep -r`, `find` and other walks stop there, and a larger glob, `tar -c`, `cp -r` or `rm -r` is refused. `-1` lifts the limit.',
      default: 1000,
    }),
})

export type DifyConfig = ConfigOf<typeof DifyConfigSchema>

export function normalizeDifyConfig(input: Record<string, unknown>): DifyConfig {
  return parseConfigWithSchema(DifyConfigSchema, input)
}

export interface DifyConfigResolved {
  apiKey: string
  baseUrl: string
  datasetId: string
  slugMetadataName: string
  maxConcurrency: number
  requestTimeout: number
  retryAttempts: number
  retryMaxDelay: number
}

function normalizePositive(value: number | undefined, fallback: number, field: string): number {
  const resolved = value ?? fallback
  if (!(resolved > 0)) {
    throw new Error(`${field} must be positive`)
  }
  return resolved
}

export function resolveDifyConfig(config: DifyConfig): DifyConfigResolved {
  return {
    apiKey: config.apiKey,
    baseUrl: rstripSlash(config.baseUrl),
    datasetId: normalizeNonEmpty(config.datasetId, 'datasetId'),
    slugMetadataName: normalizeNonEmpty(config.slugMetadataName ?? 'slug', 'slugMetadataName'),
    maxConcurrency: normalizePositive(config.maxConcurrency, 10, 'maxConcurrency'),
    requestTimeout: normalizePositive(config.requestTimeout, 30, 'requestTimeout'),
    retryAttempts: normalizePositive(config.retryAttempts, 4, 'retryAttempts'),
    retryMaxDelay: normalizePositive(config.retryMaxDelay, 30, 'retryMaxDelay'),
  }
}

// `apiKey` is the credential. Masking it is what makes
// `vfsStateRequiresOverride` demand a fresh one at load instead of
// quietly rebuilding the mount as an empty RAMVFS. Python masks the
// same field, a SecretStr on the model.
export type DifyConfigRedacted = RedactedConfig<DifyConfigResolved, 'apiKey'>

export function redactDifyConfig(config: DifyConfigResolved): DifyConfigRedacted {
  return { ...config, apiKey: REDACTED_SECRET }
}
