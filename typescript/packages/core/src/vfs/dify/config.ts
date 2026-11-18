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
import { rstripSlash } from '../../utils/slash.ts'
import { secretStr } from '../secrets.ts'

export const DifyConfig = z.object({
  apiKey: secretStr().describe('Dify Knowledge API key, sent as `Authorization: Bearer`.'),
  baseUrl: z
    .string()
    .transform(rstripSlash)
    .describe('Dify API root, such as `https://api.dify.ai/v1`.'),
  datasetId: z
    .string()
    .trim()
    .min(1, 'datasetId cannot be empty')
    .describe('ID of the Knowledge dataset the mount shows.'),
  slugMetadataName: z
    .string()
    .trim()
    .min(1, 'slugMetadataName cannot be empty')
    .default('slug')
    .meta({
      description:
        "Document metadata field whose value is the document's path in the mount. A document without it is mounted under its document name.",
      default: 'slug',
    }),
  maxConcurrency: z.number().int().positive().default(10).meta({
    description: 'The most Dify API requests in flight at once.',
    default: 10,
  }),
  retryAttempts: z.number().int().positive().default(4).meta({
    description:
      'Attempts per request, the first included. A 429, a 5xx or a transport error is retried.',
    default: 4,
  }),
  retryMaxDelay: z.number().positive().default(30).meta({
    description: 'Longest wait in seconds before a retry, whether from backoff or `Retry-After`.',
    default: 30,
  }),
  timeout: defaultRequestTimeout,
})

export type DifyConfig = z.input<typeof DifyConfig>
