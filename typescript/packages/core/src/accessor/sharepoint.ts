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
import { Accessor } from './base.ts'
import {
  MSGRAPH_CONFIG_SHAPE,
  resolveMsGraphConfig,
  type MsGraphConfig,
  type MsGraphConfigResolved,
} from '../core/msgraph/config.ts'
import {
  type ConfigOf,
  parseConfigWithSchema,
  redactConfigWithSchema,
  type RedactedConfig,
} from '../vfs/secrets.ts'
import { stripSlash } from '../utils/slash.ts'

export interface SharePointConfig extends MsGraphConfig {
  siteFilter?: string
  site?: string
  drive?: string
  keyPrefix?: string
}

const SharePointConfigSchema = z.object({
  ...MSGRAPH_CONFIG_SHAPE,
  siteFilter: z.string().optional().meta({
    description:
      "Search term passed to Graph's `/sites?search=` to choose which sites the mount lists.",
    default: '*',
  }),
  site: z
    .string()
    .optional()
    .describe(
      'Site, by display name or internal name, that scopes the mount to one document library together with `drive`. With either unset the mount lists every site as `/<site>/<library>/...`.',
    ),
  drive: z
    .string()
    .optional()
    .describe(
      'Document library in `site` that the mount uses as its root; takes effect only with `site` set.',
    ),
  keyPrefix: z
    .string()
    .optional()
    .describe(
      'Folder path inside the scoped library that the mount uses as its root; takes effect only with `site` and `drive` set. `..` segments are rejected.',
    ),
})

export type SharePointConfigRedacted = RedactedConfig<
  ConfigOf<typeof SharePointConfigSchema>,
  'accessToken'
>

export function redactSharePointConfig(config: SharePointConfig): SharePointConfigRedacted {
  return redactConfigWithSchema(
    SharePointConfigSchema,
    config,
  ) as unknown as SharePointConfigRedacted
}

export function normalizeSharePointConfig(input: Record<string, unknown>): SharePointConfig {
  return parseConfigWithSchema(SharePointConfigSchema, input)
}

export interface SharePointConfigResolved extends MsGraphConfigResolved {
  siteFilter: string | null
  site: string | null
  drive: string | null
  keyPrefix: string
}

function normalizePrefix(value: string | undefined): string {
  const normalized = stripSlash(value ?? '')
  if (normalized.split('/').includes('..'))
    throw new Error("keyPrefix must not contain '..' segments")
  return normalized
}

function optionalText(value: string | undefined): string | null {
  const normalized = value?.trim()
  return normalized === undefined || normalized === '' ? null : normalized
}

function resolveSharePointConfig(config: SharePointConfig): SharePointConfigResolved {
  return {
    ...resolveMsGraphConfig(config),
    siteFilter: optionalText(config.siteFilter),
    site: optionalText(config.site),
    drive: optionalText(config.drive),
    keyPrefix: normalizePrefix(config.keyPrefix),
  }
}

export class SharePointAccessor extends Accessor {
  readonly config: SharePointConfigResolved
  // Name -> id lookups for the two namespace levels above a drive item, so
  // resolving a path does not call /sites and /drives on every op. They live
  // on the accessor, not the module: one accessor is one mount is one
  // tenant, and a site name is only unique within a tenant. A drive name is
  // only unique within its site, so its key carries the site id. Entries
  // live until the mount drops its caches (forget).
  siteCache = new Map<string, string>()
  driveCache = new Map<string, string>()

  constructor(config: SharePointConfig) {
    super()
    this.config = resolveSharePointConfig(config)
  }

  /** Drop the site and drive ids with the mount's caches. */
  override forget(): void {
    super.forget?.()
    this.siteCache = new Map()
    this.driveCache = new Map()
  }
}
