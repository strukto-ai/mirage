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
import { redactConfigWithSchema, secretStr } from '../../resource/secrets.ts'
import { normalizeFields } from '../../utils/normalize.ts'

export interface GoogleConfig {
  clientId: string
  // Optional: omit in browser PKCE flows. The PKCE verifier authenticates
  // the client at the token endpoint, so no secret is sent.
  clientSecret?: string
  refreshToken: string
  // Optional: caller-supplied refresh strategy. When provided, TokenManager
  // delegates token refresh to this callback instead of calling Google's
  // token endpoint directly. Useful when the client_secret must stay on a
  // backend (e.g. a Vercel function proxy).
  refreshFn?: (refreshToken: string) => Promise<{ accessToken: string; expiresIn: number }>
  // Drive-only: scope the mount to this folder ID instead of the Drive
  // root, the s3 key_prefix analog. Other Google backends ignore it.
  folderId?: string
}

export interface GoogleConfigRedacted {
  clientId: string
  clientSecret?: '<REDACTED>'
  refreshToken: '<REDACTED>'
  folderId?: string
}

export const GoogleConfigSchema = z.object({
  clientId: z.string(),
  clientSecret: secretStr().optional(),
  refreshToken: secretStr(),
  folderId: z.string().optional(),
})

export function redactGoogleConfig(config: GoogleConfig): GoogleConfigRedacted {
  return redactConfigWithSchema(GoogleConfigSchema, config) as unknown as GoogleConfigRedacted
}

export function normalizeGoogleConfig(input: Record<string, unknown>): GoogleConfig {
  return normalizeFields(input, {
    rename: {
      client_id: 'clientId',
      client_secret: 'clientSecret',
      refresh_token: 'refreshToken',
      folder_id: 'folderId',
    },
  }) as unknown as GoogleConfig
}
