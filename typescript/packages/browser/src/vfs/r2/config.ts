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

import type { ConfigOf } from '@struktoai/mirage-core/vfs/secrets'
import { z } from '@struktoai/mirage-core/vfs/secrets'
import { browserAliasSchema, derivedEndpoint, makeBrowserS3Alias } from '../s3_alias.ts'

export const R2Config = makeBrowserS3Alias({
  schema: browserAliasSchema({
    region: z.string().optional().meta({
      description: 'Region of the bucket; R2 addresses a bucket by account, not by region.',
      default: 'auto',
    }),
    accountId: z
      .string()
      .optional()
      .describe(
        'Cloudflare account ID. It builds the endpoint `https://<accountId>.r2.cloudflarestorage.com` unless `endpoint` is set.',
      ),
  }),
  endpointFor: derivedEndpoint(
    'accountId',
    (accountId) => `https://${accountId}.r2.cloudflarestorage.com`,
  ),
  regionDefault: 'auto',
})

export type R2Config = ConfigOf<typeof R2Config>
