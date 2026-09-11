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
  graphApi,
  resolveMsGraphConfig,
  type MsGraphConfig,
  type MsGraphConfigResolved,
} from '../core/msgraph/config.ts'
import { DriveLoc } from '../core/msgraph/drive.ts'
import {
  type ConfigOf,
  parseConfigWithSchema,
  redactConfigWithSchema,
  type RedactedConfig,
} from '../resource/secrets.ts'
import { stripSlash } from '../utils/slash.ts'

export interface OneDriveConfig extends MsGraphConfig {
  driveId?: string
  siteId?: string
  // A Teams/Microsoft 365 group's document library, and another user's
  // drive under app-only auth. Both are reachable without first resolving
  // a drive id out of band.
  groupId?: string
  userId?: string
  keyPrefix?: string
}

const DRIVE_TARGETS = ['driveId', 'siteId', 'groupId', 'userId'] as const

// Names the count and the fields actually set, the way python's
// `OneDriveConfig` validator does; a fixed message listing all four
// targets pointed at two the caller never wrote.
function driveTargetError(named: readonly string[]): string {
  return (
    `OneDriveConfig names ${String(named.length)} drives (${named.join(', ')}); ` +
    "set exactly one, or none for the signed-in user's drive"
  )
}

const OneDriveConfigSchema = z
  .object({
    ...MSGRAPH_CONFIG_SHAPE,
    driveId: z.string().optional(),
    siteId: z.string().optional(),
    groupId: z.string().optional(),
    userId: z.string().optional(),
    keyPrefix: z.string().optional(),
  })
  // With four fields and a fixed precedence, setting two would make the
  // mount silently address whichever won, which is the kind of
  // misconfiguration that only shows up as a confusing 404.
  .superRefine((c, ctx) => {
    const named = DRIVE_TARGETS.filter((f) => c[f] !== undefined)
    if (named.length > 1) ctx.addIssue({ code: 'custom', message: driveTargetError(named) })
  })

export type OneDriveConfigRedacted = RedactedConfig<
  ConfigOf<typeof OneDriveConfigSchema>,
  'accessToken'
>

export function redactOneDriveConfig(config: OneDriveConfig): OneDriveConfigRedacted {
  return redactConfigWithSchema(OneDriveConfigSchema, config) as unknown as OneDriveConfigRedacted
}

export function normalizeOneDriveConfig(input: Record<string, unknown>): OneDriveConfig {
  return parseConfigWithSchema(OneDriveConfigSchema, input)
}

export interface OneDriveConfigResolved extends MsGraphConfigResolved {
  driveId: string | null
  siteId: string | null
  groupId: string | null
  userId: string | null
  keyPrefix: string
}

function normalizePrefix(value: string | undefined): string {
  return stripSlash(value ?? '')
}

function optionalText(value: string | undefined): string | null {
  const normalized = value?.trim()
  return normalized === undefined || normalized === '' ? null : normalized
}

function resolveOneDriveConfig(config: OneDriveConfig): OneDriveConfigResolved {
  const graph = resolveMsGraphConfig(config)
  const resolved = {
    ...graph,
    driveId: optionalText(config.driveId),
    siteId: optionalText(config.siteId),
    groupId: optionalText(config.groupId),
    userId: optionalText(config.userId),
    keyPrefix: normalizePrefix(config.keyPrefix),
  }
  // Checked here and not only in the schema: a config built in code never
  // goes through the schema, and that is the path the accessor takes.
  const named = DRIVE_TARGETS.filter((f) => resolved[f] !== null)
  if (named.length > 1) throw new Error(driveTargetError(named))
  return resolved
}

// Exactly one target may be named (resolveOneDriveConfig enforces it), so
// the arms are alternatives rather than a precedence chain. Naming none
// means the signed-in user's own drive, which is the only form that works
// under delegated auth with no extra identifiers.
export function oneDriveBase(config: OneDriveConfigResolved): string {
  const api = graphApi(config)
  if (config.driveId !== null) return `${api}/drives/${encodeURIComponent(config.driveId)}`
  if (config.siteId !== null) return `${api}/sites/${encodeURIComponent(config.siteId)}/drive`
  if (config.groupId !== null) return `${api}/groups/${encodeURIComponent(config.groupId)}/drive`
  if (config.userId !== null) return `${api}/users/${encodeURIComponent(config.userId)}/drive`
  return `${api}/me/drive`
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
  const base = oneDriveBase(config).slice(graphApi(config).length)
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
