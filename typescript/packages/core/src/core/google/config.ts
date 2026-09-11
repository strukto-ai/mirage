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
  redactConfigWithSchema,
  type RedactedConfig,
  secretSchema,
  secretStr,
} from '../../resource/secrets.ts'

// A pre-minted token read on every request. This is how a caller that
// already owns the OAuth dance (a service account, a host application's
// token source) plugs in: it caches and refreshes on its own, so mirage
// holds no long-lived credential and never contacts the token endpoint.
// Mirrors python's `access_token: SecretStr | Callable[[], str | SecretStr]`.
export type GoogleAccessTokenProvider = () => string | Promise<string>

// Caller-supplied refresh strategy. When provided, TokenManager delegates
// token refresh to this callback instead of calling Google's token endpoint
// directly. Useful when the client_secret must stay on a backend (e.g. a
// Vercel function proxy).
export type GoogleRefreshFn = (
  refreshToken: string,
) => Promise<{ accessToken: string; expiresIn: number }>

export const GOOGLE_CREDENTIAL_ERROR =
  'GoogleConfig needs either accessToken (a token or a provider callable) or both clientId and refreshToken'

// Both grants stand alone, so this is what keeps a mount from being built
// with no credential at all and failing on the first read instead. Mirrors
// python's `_one_credential` model validator.
function hasGoogleCredential(config: {
  accessToken?: string | GoogleAccessTokenProvider | undefined
  clientId?: string | undefined
  refreshToken?: string | undefined
}): boolean {
  if (config.accessToken !== undefined) return true
  return config.clientId !== undefined && config.refreshToken !== undefined
}

export const GoogleConfigSchema = z
  .object({
    // Two ways to authenticate, the same two MsGraphConfig offers: a token
    // (or provider) supplied by the caller, or the refresh-token grant where
    // mirage mints and renews the access token itself through TokenManager.
    accessToken: secretSchema(
      z.union([
        z.string(),
        z.custom<GoogleAccessTokenProvider>((value) => typeof value === 'function'),
      ]),
    ).optional(),
    clientId: z.string().optional(),
    // Optional: omit in browser PKCE flows. The PKCE verifier authenticates
    // the client at the token endpoint, so no secret is sent.
    clientSecret: secretStr().optional(),
    refreshToken: secretStr().optional(),
    // Declared here rather than on a CLI-only extension: parse strips what
    // the schema does not name, and marking it secret is what keeps a
    // callback out of snapshot state.
    refreshFn: secretSchema(
      z.custom<GoogleRefreshFn>((value) => typeof value === 'function'),
    ).optional(),
    // Single-host override for every Google API (drive/docs/sheets/slides)
    // plus the OAuth token endpoint; used to point backends at a fake server.
    apiBase: z.string().optional(),
    // Drive-only: scope the mount to this folder ID instead of the Drive
    // root, the s3 key_prefix analog. Other Google backends ignore it.
    folderId: z.string().optional(),
  })
  .refine(hasGoogleCredential, { message: GOOGLE_CREDENTIAL_ERROR })

// Derived, not declared twice: the schema validates every install and
// carries the secret markers redaction reads, so a hand-written twin only
// adds a shape that can drift from it.
export type GoogleConfig = ConfigOf<typeof GoogleConfigSchema>

export type GoogleConfigRedacted = RedactedConfig<
  GoogleConfig,
  'accessToken' | 'clientSecret' | 'refreshToken' | 'refreshFn'
>

export function redactGoogleConfig(config: GoogleConfig): GoogleConfigRedacted {
  return redactConfigWithSchema(GoogleConfigSchema, config) as unknown as GoogleConfigRedacted
}

export function normalizeGoogleConfig(input: Record<string, unknown>): GoogleConfig {
  return parseConfigWithSchema(GoogleConfigSchema, input)
}
