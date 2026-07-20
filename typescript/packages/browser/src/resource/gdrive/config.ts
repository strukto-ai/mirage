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

export interface GDriveConfig {
  clientId: string
  clientSecret?: string
  refreshToken: string
  refreshFn?: (refreshToken: string) => Promise<{ accessToken: string; expiresIn: number }>
  folderId?: string
}

export interface GDriveConfigRedacted {
  clientId: string
  clientSecret?: '<REDACTED>'
  refreshToken: '<REDACTED>'
}

const GDriveConfigSchema = z.object({
  clientId: z.string(),
  clientSecret: secretStr().optional(),
  refreshToken: secretStr(),
  folderId: z.string().optional(),
})

export function redactGDriveConfig(config: GDriveConfig): GDriveConfigRedacted {
  return redactConfigWithSchema(GDriveConfigSchema, config) as unknown as GDriveConfigRedacted
}

export function normalizeGDriveConfig(input: Record<string, unknown>): GDriveConfig {
  return normalizeFields(input, {
    rename: {
      client_id: 'clientId',
      client_secret: 'clientSecret',
      refresh_token: 'refreshToken',
      folder_id: 'folderId',
    },
  }) as unknown as GDriveConfig
}
