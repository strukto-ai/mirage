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
import { GRAPH_API } from '../core/msgraph/client.ts'
import {
  MSGRAPH_CONFIG_SHAPE,
  resolveMsGraphConfig,
  type MsGraphConfig,
  type MsGraphConfigResolved,
} from '../core/msgraph/config.ts'
import { DriveLoc } from '../core/msgraph/drive.ts'
import { redactConfigWithSchema } from '../resource/secrets.ts'
import { normalizeFields } from '../utils/normalize.ts'
import { stripSlash } from '../utils/slash.ts'

export interface OneDriveConfig extends MsGraphConfig {
  driveId?: string
  siteId?: string
  keyPrefix?: string
}

export interface OneDriveConfigRedacted {
  accessToken: '<REDACTED>'
  tenantHost?: string
  timeout?: number
  maxRetries?: number
  driveId?: string
  siteId?: string
  keyPrefix?: string
}

export const OneDriveConfigSchema = z.object({
  ...MSGRAPH_CONFIG_SHAPE,
  driveId: z.string().optional(),
  siteId: z.string().optional(),
  keyPrefix: z.string().optional(),
})

export function redactOneDriveConfig(config: OneDriveConfig): OneDriveConfigRedacted {
  return redactConfigWithSchema(OneDriveConfigSchema, config) as unknown as OneDriveConfigRedacted
}

export function normalizeOneDriveConfig(input: Record<string, unknown>): OneDriveConfig {
  return OneDriveConfigSchema.parse(normalizeFields(input)) as OneDriveConfig
}

export interface OneDriveConfigResolved extends MsGraphConfigResolved {
  driveId: string | null
  siteId: string | null
  keyPrefix: string
}

function normalizePrefix(value: string | undefined): string {
  return stripSlash(value ?? '')
}

function optionalText(value: string | undefined): string | null {
  const normalized = value?.trim()
  return normalized === undefined || normalized === '' ? null : normalized
}

export function resolveOneDriveConfig(config: OneDriveConfig): OneDriveConfigResolved {
  const graph = resolveMsGraphConfig(config)
  return {
    ...graph,
    driveId: optionalText(config.driveId),
    siteId: optionalText(config.siteId),
    keyPrefix: normalizePrefix(config.keyPrefix),
  }
}

export function oneDriveBase(config: OneDriveConfigResolved): string {
  if (config.driveId !== null) return `${GRAPH_API}/drives/${encodeURIComponent(config.driveId)}`
  if (config.siteId !== null) return `${GRAPH_API}/sites/${encodeURIComponent(config.siteId)}/drive`
  return `${GRAPH_API}/me/drive`
}

function encodedPath(path: string): string {
  return path
    .split('/')
    .filter((part) => part !== '')
    .map(encodeURIComponent)
    .join('/')
}

function fullPath(config: OneDriveConfigResolved, path: string): string {
  const stripped = stripSlash(path)
  if (config.keyPrefix !== '' && stripped !== '') return `${config.keyPrefix}/${stripped}`
  return config.keyPrefix || stripped
}

export function oneDriveItemUrl(config: OneDriveConfigResolved, path: string, action = ''): string {
  const base = oneDriveBase(config)
  const full = fullPath(config, path)
  if (full === '') return `${base}/root${action}`
  const stem = `${base}/root:/${encodedPath(full)}`
  return action !== '' ? `${stem}:${action}` : stem
}

export function oneDriveRefPath(config: OneDriveConfigResolved, folder = ''): string {
  const base = oneDriveBase(config).slice(GRAPH_API.length)
  const full = fullPath(config, folder)
  return full !== '' ? `${base}/root:/${encodedPath(full)}` : `${base}/root:`
}

export class OneDriveAccessor extends Accessor {
  readonly config: OneDriveConfigResolved

  constructor(config: OneDriveConfig) {
    super()
    this.config = resolveOneDriveConfig(config)
  }

  loc(path: string, virtual = path): DriveLoc {
    return new DriveLoc({
      drive: '',
      path: stripSlash(path),
      virtual: stripSlash(virtual),
      url: (item, action) => oneDriveItemUrl(this.config, item, action),
      ref: (folder) => oneDriveRefPath(this.config, folder),
    })
  }
}
