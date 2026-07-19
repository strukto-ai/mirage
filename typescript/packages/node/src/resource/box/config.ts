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

export interface BoxConfig {
  // API origin override (e.g. an integ fake). Defaults to api.box.com.
  endpoint?: string
  // Box folder id to mount as the workspace root instead of the account
  // root ("0"). Folder ids are stable across renames/moves and visible in
  // the Box web URL (box.com/folder/<id>), so a subfolder mount survives
  // reorganization that a path prefix would not.
  rootFolderId?: string
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

export interface BoxConfigRedacted {
  endpoint?: string
  rootFolderId?: string
  clientId?: string
  clientSecret?: '<REDACTED>'
  refreshToken?: '<REDACTED>'
  enterpriseId?: string
  accessToken?: '<REDACTED>'
}

const BoxConfigSchema = z.object({
  endpoint: z.string().optional(),
  rootFolderId: z.string().optional(),
  clientId: z.string().optional(),
  clientSecret: secretStr().optional(),
  refreshToken: secretStr().optional(),
  enterpriseId: z.string().optional(),
  accessToken: secretStr().optional(),
})

export function redactBoxConfig(config: BoxConfig): BoxConfigRedacted {
  return redactConfigWithSchema(BoxConfigSchema, config) as unknown as BoxConfigRedacted
}

export function normalizeBoxConfig(input: Record<string, unknown>): BoxConfig {
  return normalizeFields(input, {
    rename: {
      root_folder_id: 'rootFolderId',
      client_id: 'clientId',
      client_secret: 'clientSecret',
      refresh_token: 'refreshToken',
      enterprise_id: 'enterpriseId',
      access_token: 'accessToken',
      developer_token: 'accessToken',
    },
  }) as unknown as BoxConfig
}
