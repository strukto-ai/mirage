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
import { graphList } from '../core/msgraph/client.ts'
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
import { compareCodePoints } from '../utils/sort.ts'

export interface SharePointConfig extends MsGraphConfig {
  siteFilter?: string
  site?: string
  drive?: string
  keyPrefix?: string
}

const SharePointConfigSchema = z.object({
  ...MSGRAPH_CONFIG_SHAPE,
  siteFilter: z.string().optional(),
  site: z.string().optional(),
  drive: z.string().optional(),
  keyPrefix: z.string().optional(),
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

export interface ResolvedSharePointPath {
  level: 'root' | 'site' | 'drive' | 'item'
  siteId: string | null
  driveId: string | null
  itemPath: string | null
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

function encodedPath(path: string): string {
  return path
    .split('/')
    .filter((part) => part !== '')
    .map(encodeURIComponent)
    .join('/')
}

// Takes the config, not just the drive id, because the service root is a
// per-mount setting (national cloud, private endpoint, test server) rather
// than a constant.
function sharePointItemUrl(
  config: MsGraphConfigResolved,
  driveId: string,
  path: string,
  action = '',
): string {
  const base = `${graphApi(config)}/drives/${encodeURIComponent(driveId)}`
  const stripped = stripSlash(path)
  if (stripped === '') return `${base}/root${action}`
  const stem = `${base}/root:/${encodedPath(stripped)}`
  return action !== '' ? `${stem}:${action}` : stem
}

function sharePointRefPath(driveId: string, folder = ''): string {
  const base = `/drives/${driveId}`
  const stripped = stripSlash(folder)
  return stripped !== '' ? `${base}/root:/${encodedPath(stripped)}` : `${base}/root:`
}

function displayName(item: Record<string, unknown>): string {
  return typeof item.displayName === 'string'
    ? item.displayName
    : typeof item.name === 'string'
      ? item.name
      : ''
}

export class SharePointAccessor extends Accessor {
  readonly config: SharePointConfigResolved
  private readonly siteCache = new Map<string, string>()
  private readonly driveCache = new Map<string, string>()

  constructor(config: SharePointConfig) {
    super()
    this.config = resolveSharePointConfig(config)
  }

  private async siteItems(): Promise<Record<string, unknown>[]> {
    const sites = await graphList(this.config, `${graphApi(this.config)}/sites`, {
      search: this.config.siteFilter ?? '*',
      $select: 'id,displayName,name,webUrl',
    })
    if (this.config.tenantHost === null) return sites
    return sites.filter((site) => {
      if (typeof site.webUrl !== 'string') return false
      try {
        return new URL(site.webUrl).host === this.config.tenantHost
      } catch {
        return false
      }
    })
  }

  private async driveItems(siteId: string): Promise<Record<string, unknown>[]> {
    const url = `${graphApi(this.config)}/sites/${encodeURIComponent(siteId)}/drives`
    return graphList(this.config, url, {
      $select: 'id,name',
    })
  }

  async siteEntries(): Promise<[string, string][]> {
    const entries: [string, string][] = []
    for (const site of await this.siteItems()) {
      const id = typeof site.id === 'string' ? site.id : null
      const display = displayName(site)
      const name = typeof site.name === 'string' ? site.name : ''
      if (id === null || display === '') continue
      entries.push([display, id])
      this.siteCache.set(display, id)
      if (name !== '') this.siteCache.set(name, id)
    }
    return entries.sort((left, right) => compareCodePoints(left[0], right[0]))
  }

  async listSites(): Promise<string[]> {
    return (await this.siteEntries()).map((entry) => entry[0])
  }

  async driveEntries(siteId: string): Promise<[string, string][]> {
    const entries: [string, string][] = []
    for (const drive of await this.driveItems(siteId)) {
      if (typeof drive.id !== 'string' || typeof drive.name !== 'string') continue
      entries.push([drive.name, drive.id])
      this.driveCache.set(`${siteId}\0${drive.name}`, drive.id)
    }
    return entries.sort((left, right) => compareCodePoints(left[0], right[0]))
  }

  async listDrives(siteId: string): Promise<string[]> {
    return (await this.driveEntries(siteId)).map((entry) => entry[0])
  }

  private async siteId(name: string): Promise<string | null> {
    if (!this.siteCache.has(name)) await this.listSites()
    return this.siteCache.get(name) ?? null
  }

  private async driveId(siteId: string, name: string): Promise<string | null> {
    const key = `${siteId}\0${name}`
    if (!this.driveCache.has(key)) await this.listDrives(siteId)
    return this.driveCache.get(key) ?? null
  }

  async resolve(path: string): Promise<ResolvedSharePointPath> {
    const raw = stripSlash(path)
    if (this.config.site !== null && this.config.drive !== null) {
      const siteId = await this.siteId(this.config.site)
      if (siteId === null) return { level: 'site', siteId: null, driveId: null, itemPath: null }
      const driveId = await this.driveId(siteId, this.config.drive)
      if (driveId === null) return { level: 'drive', siteId, driveId: null, itemPath: null }
      const itemPath =
        this.config.keyPrefix !== '' && raw !== ''
          ? `${this.config.keyPrefix}/${raw}`
          : this.config.keyPrefix || raw
      return itemPath === ''
        ? { level: 'drive', siteId, driveId, itemPath: null }
        : { level: 'item', siteId, driveId, itemPath }
    }
    if (raw === '') return { level: 'root', siteId: null, driveId: null, itemPath: null }
    const parts = raw.split('/')
    const siteId = await this.siteId(parts[0] ?? '')
    if (siteId === null) return { level: 'site', siteId: null, driveId: null, itemPath: null }
    if (parts.length === 1) return { level: 'site', siteId, driveId: null, itemPath: null }
    const driveId = await this.driveId(siteId, parts[1] ?? '')
    if (driveId === null) return { level: 'drive', siteId, driveId: null, itemPath: null }
    if (parts.length === 2) return { level: 'drive', siteId, driveId, itemPath: null }
    return { level: 'item', siteId, driveId, itemPath: parts.slice(2).join('/') }
  }

  loc(resolved: ResolvedSharePointPath, virtual: string): DriveLoc {
    if (resolved.driveId === null) throw new Error('SharePoint path has no drive')
    return new DriveLoc({
      drive: resolved.driveId,
      path: resolved.itemPath ?? '',
      virtual: stripSlash(virtual),
      url: (item, action) => sharePointItemUrl(this.config, resolved.driveId ?? '', item, action),
      ref: (folder) => sharePointRefPath(resolved.driveId ?? '', folder),
    })
  }
}
