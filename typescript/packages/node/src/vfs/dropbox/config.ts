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

import {
  parseConfigWithSchema,
  redactConfigWithSchema,
  secretSchema,
  secretStr,
  z,
} from '@struktoai/mirage-core/vfs/secrets'
import type { ConfigOf, RedactedConfig } from '@struktoai/mirage-core/vfs/secrets'

// Stricter than core's DropboxConfig on purpose: a server is a confidential
// client and python requires the secret too, while the browser refreshes as a
// PKCE public client that has none. The class in core takes either.
export interface DropboxConfig {
  clientId: string
  clientSecret: string
  refreshToken: string
  rootPath?: string
  endpoint?: string
  refreshFn?: (refreshToken: string) => Promise<{ accessToken: string; expiresIn: number }>
}

const DropboxConfigSchema = z.object({
  clientId: z.string().describe('Dropbox app key.'),
  clientSecret: secretStr().describe('Dropbox app secret.'),
  refreshToken: secretStr().describe(
    'Long-lived OAuth refresh token; mirage mints short-lived access tokens from it.',
  ),
  rootPath: z
    .string()
    .optional()
    .describe(
      'Dropbox folder the mount uses as its root, such as `/Projects`; unset or `/` is the account root. `..` segments are rejected.',
    ),
  endpoint: z
    .string()
    .optional()
    .describe(
      "Base URL that replaces Dropbox's OAuth, API and content hosts, such as a test server. Unset uses Dropbox's hosts.",
    ),
  // Declared so parse keeps it, marked secret so no snapshot carries it.
  refreshFn: secretSchema(
    z.custom<NonNullable<DropboxConfig['refreshFn']>>((value) => typeof value === 'function'),
  )
    .optional()
    .describe(
      "Function that takes the refresh token and returns `{ accessToken, expiresIn }` (seconds), called instead of Dropbox's token endpoint, for example so the app secret stays on a backend.",
    ),
})

// Only the redacted twin derives; the interface above stays the readable
// statement of the callback signature.
export type DropboxConfigRedacted = RedactedConfig<
  ConfigOf<typeof DropboxConfigSchema>,
  'clientSecret' | 'refreshToken' | 'refreshFn'
>

export function redactDropboxConfig(config: DropboxConfig): DropboxConfigRedacted {
  return redactConfigWithSchema(DropboxConfigSchema, config) as unknown as DropboxConfigRedacted
}

export function normalizeDropboxConfig(input: Record<string, unknown>): DropboxConfig {
  return parseConfigWithSchema(DropboxConfigSchema, input)
}
