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
} from '../../vfs/secrets.ts'

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
    )
      .optional()
      .describe(
        'OAuth access token, or a function (sync or async) that returns one, read on every request. Use it instead of `clientId` and `refreshToken` when your app already manages OAuth; it wins when both are set.',
      ),
    clientId: z
      .string()
      .optional()
      .describe(
        'Google OAuth client ID. Required with `refreshToken` when `accessToken` is unset; mirage then mints and renews access tokens itself.',
      ),
    // The PKCE verifier authenticates the client at the token endpoint, so
    // no secret is sent.
    clientSecret: secretStr()
      .optional()
      .describe(
        'Google OAuth client secret, sent with the refresh-token grant. Omit it for a PKCE client.',
      ),
    refreshToken: secretStr()
      .optional()
      .describe(
        "User's OAuth refresh token. Required with `clientId` when `accessToken` is unset.",
      ),
    // Declared here rather than on a CLI-only extension: parse strips what
    // the schema does not name, and marking it secret is what keeps a
    // callback out of snapshot state.
    refreshFn: secretSchema(z.custom<GoogleRefreshFn>((value) => typeof value === 'function'))
      .optional()
      .describe(
        "Function that takes the refresh token and returns `{ accessToken, expiresIn }` (seconds), called instead of Google's token endpoint, for example so the client secret stays on a backend. `clientId` and `refreshToken` are still required.",
      ),
    apiBase: z
      .string()
      .optional()
      .describe(
        "One base URL that replaces every Google API host and the OAuth token endpoint, such as a test server. Unset uses Google's hosts.",
      ),
    folderId: z
      .string()
      .optional()
      .describe(
        'Drive folder ID the `gdrive` mount uses as its root instead of My Drive; it may be a folder in a Shared Drive. Other Google mounts ignore it.',
      ),
  })
  .refine(hasGoogleCredential, { message: GOOGLE_CREDENTIAL_ERROR })

// Derived, not declared twice: the schema validates every install and
// carries the secret markers redaction reads, so a hand-written twin only
// adds a shape that can drift from it.
export type GoogleConfig = ConfigOf<typeof GoogleConfigSchema>

export const GoogleAppConfigSchema = GoogleConfigSchema.extend({
  contentSearch: z.boolean().optional().meta({
    description:
      "Let `grep -w` and `rg -w` read only the files Drive full-text search names. Drive searches a file's text, not the JSON the mount renders, and indexes a write with a delay, so a file that holds the word can be left out.",
    default: false,
  }),
})

export type GoogleAppConfig = ConfigOf<typeof GoogleAppConfigSchema>

export type GoogleAppConfigRedacted = RedactedConfig<
  GoogleAppConfig,
  'accessToken' | 'clientSecret' | 'refreshToken' | 'refreshFn'
>

export function redactGoogleAppConfig(config: GoogleAppConfig): GoogleAppConfigRedacted {
  return redactConfigWithSchema(GoogleAppConfigSchema, config) as unknown as GoogleAppConfigRedacted
}

export function normalizeGoogleAppConfig(input: Record<string, unknown>): GoogleAppConfig {
  return parseConfigWithSchema(GoogleAppConfigSchema, input)
}
