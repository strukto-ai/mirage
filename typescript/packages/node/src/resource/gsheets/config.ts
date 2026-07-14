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

export interface GSheetsConfig {
  clientId: string
  clientSecret: string
  refreshToken: string
  refreshFn?: (refreshToken: string) => Promise<{ accessToken: string; expiresIn: number }>
}

export interface GSheetsConfigRedacted {
  clientId: string
  clientSecret: '<REDACTED>'
  refreshToken: '<REDACTED>'
}

const GSheetsConfigSchema = z.object({
  clientId: z.string(),
  clientSecret: secretStr(),
  refreshToken: secretStr(),
})

export function redactGSheetsConfig(config: GSheetsConfig): GSheetsConfigRedacted {
  return redactConfigWithSchema(GSheetsConfigSchema, config) as unknown as GSheetsConfigRedacted
}

export function normalizeGSheetsConfig(input: Record<string, unknown>): GSheetsConfig {
  return normalizeFields(input, {
    rename: {
      client_id: 'clientId',
      client_secret: 'clientSecret',
      refresh_token: 'refreshToken',
    },
  }) as unknown as GSheetsConfig
}
