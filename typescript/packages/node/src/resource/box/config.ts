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
} from '@struktoai/mirage-core/resource/secrets'
import type { ConfigOf, RedactedConfig } from '@struktoai/mirage-core/resource/secrets'

export interface BoxConfig {
  // API origin override (e.g. an integ fake). Defaults to api.box.com.
  endpoint?: string
  // Box folder id to mount as the workspace root instead of the account
  // root ("0"). Folder ids are stable across renames/moves and visible in
  // the Box web URL (box.com/folder/<id>), so a subfolder mount survives
  // reorganization that a path prefix would not.
  rootFolderId?: string
  // Opt in to grep/rg content-search push-down: route recursive literal
  // scans through Box search to narrow the file set before scanning locally.
  // Off by default because Box's search index lags recent writes.
  contentSearch?: boolean
  clientId?: string
  clientSecret?: string
  refreshToken?: string
  // Box enterprise ID for the client-credentials grant. With clientId +
  // clientSecret + enterpriseId set, the resource authenticates as the app's
  // service account; no refresh token needed.
  enterpriseId?: string
  // Box developer token from https://app.box.com/developers/console (60-min
  // lifetime). When set, the resource skips the OAuth refresh flow and uses
  // this token directly. Useful for first-run / quick exploration.
  accessToken?: string
  refreshFn?: (
    refreshToken: string,
  ) => Promise<{ accessToken: string; refreshToken: string; expiresIn: number }>
  onRefreshTokenRotated?: (newRefreshToken: string) => void | Promise<void>
}

const BoxConfigSchema = z.object({
  endpoint: z.string().optional(),
  rootFolderId: z.string().optional(),
  contentSearch: z.boolean().optional(),
  clientId: z.string().optional(),
  clientSecret: secretStr().optional(),
  refreshToken: secretStr().optional(),
  enterpriseId: z.string().optional(),
  accessToken: secretStr().optional(),
  // The callbacks are declared so parse keeps them, and marked secret so
  // no snapshot carries them.
  refreshFn: secretSchema(
    z.custom<NonNullable<BoxConfig['refreshFn']>>((value) => typeof value === 'function'),
  ).optional(),
  onRefreshTokenRotated: secretSchema(
    z.custom<NonNullable<BoxConfig['onRefreshTokenRotated']>>(
      (value) => typeof value === 'function',
    ),
  ).optional(),
})

// Only the redacted twin derives; the interface above stays the readable
// statement of the callback signatures.
export type BoxConfigRedacted = RedactedConfig<
  ConfigOf<typeof BoxConfigSchema>,
  'clientSecret' | 'refreshToken' | 'accessToken' | 'refreshFn' | 'onRefreshTokenRotated'
>

export function redactBoxConfig(config: BoxConfig): BoxConfigRedacted {
  return redactConfigWithSchema(BoxConfigSchema, config) as unknown as BoxConfigRedacted
}

export function normalizeBoxConfig(input: Record<string, unknown>): BoxConfig {
  return parseConfigWithSchema(BoxConfigSchema, input, {
    rename: {
      developer_token: 'accessToken',
    },
  })
}
