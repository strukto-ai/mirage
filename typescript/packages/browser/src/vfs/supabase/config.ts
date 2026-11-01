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

export const SupabaseConfig = makeBrowserS3Alias({
  schema: browserAliasSchema({
    projectRef: z
      .string()
      .optional()
      .describe(
        'Supabase project reference. It builds the endpoint `https://<projectRef>.storage.supabase.co/storage/v1/s3` unless `endpoint` is set.',
      ),
  }),
  endpointFor: derivedEndpoint(
    'projectRef',
    (projectRef) => `https://${projectRef}.storage.supabase.co/storage/v1/s3`,
  ),
  forcePathStyle: true,
})

export type SupabaseConfig = ConfigOf<typeof SupabaseConfig>
