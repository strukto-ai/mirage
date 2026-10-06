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

import type { SharePointAccessor } from '../../accessor/sharepoint.ts'
import type { PathSpec } from '../../types.ts'
import { enoent } from '../../errors/fs.ts'
import { stripSlash } from '../../utils/slash.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { graphList } from '../msgraph/client.ts'
import { graphApi, type MsGraphConfigResolved } from '../msgraph/config.ts'
import { DriveLoc } from '../msgraph/drive.ts'
import { driveRefPath, itemUrl } from './client.ts'

export interface ResolvedPath {
  level: 'root' | 'site' | 'drive' | 'item'
  siteId: string | null
  driveId: string | null
  itemPath: string | null
}

function resolvedPath(
  level: ResolvedPath['level'],
  siteId: string | null = null,
  driveId: string | null = null,
  itemPath: string | null = null,
): ResolvedPath {
  return { level, siteId, driveId, itemPath }
}

function scopedItemPath(keyPrefix: string, raw: string): string {
  if (keyPrefix !== '' && raw !== '') return `${keyPrefix}/${raw}`
  return keyPrefix || raw
}

function driveKey(siteId: string, name: string): string {
  return `${siteId}\0${name}`
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

// A site whose webUrl is not on the configured tenant host is another
// tenant's, and a site name is only unique within one.
function onTenant(site: Record<string, unknown>, tenantHost: string): boolean {
  const webUrl = text(site.webUrl)
  return URL.canParse(webUrl) && new URL(webUrl).host === tenantHost.toLowerCase()
}

async function siteItems(accessor: SharePointAccessor): Promise<Record<string, unknown>[]> {
  const config = accessor.config
  const sites = await graphList(config, `${graphApi(config)}/sites`, {
    search: config.siteFilter ?? '*',
    $select: 'id,displayName,name,webUrl',
  })
  const tenantHost = config.tenantHost
  return tenantHost === null ? sites : sites.filter((site) => onTenant(site, tenantHost))
}

async function driveItems(
  accessor: SharePointAccessor,
  siteId: string,
): Promise<Record<string, unknown>[]> {
  const url = `${graphApi(accessor.config)}/sites/${encodeURIComponent(siteId)}/drives`
  return graphList(accessor.config, url, { $select: 'id,name' })
}

/**
 * Every accessible site as `[display name, id]`, sorted by name.
 *
 * A site with no id or no name is skipped: nothing could address it. Both
 * the display name and the internal name are cached for resolution.
 *
 * Args:
 *   accessor: the mount's accessor.
 */
export async function siteEntries(accessor: SharePointAccessor): Promise<[string, string][]> {
  const entries: [string, string][] = []
  for (const site of await siteItems(accessor)) {
    const id = text(site.id)
    const name = text(site.name)
    const display = text(site.displayName) || name
    if (id === '' || display === '') continue
    entries.push([display, id])
    accessor.siteCache.set(display, id)
    if (name !== '') accessor.siteCache.set(name, id)
  }
  return entries.sort((left, right) => compareCodePoints(left[0], right[0]))
}

export async function listSites(accessor: SharePointAccessor): Promise<string[]> {
  return (await siteEntries(accessor)).map((entry) => entry[0])
}

/**
 * A site's document libraries as `[name, id]`, sorted by name.
 *
 * Args:
 *   accessor: the mount's accessor.
 *   siteId: the site whose drives to list.
 */
export async function driveEntries(
  accessor: SharePointAccessor,
  siteId: string,
): Promise<[string, string][]> {
  const entries: [string, string][] = []
  for (const drive of await driveItems(accessor, siteId)) {
    const id = text(drive.id)
    const name = text(drive.name)
    if (id === '' || name === '') continue
    entries.push([name, id])
    accessor.driveCache.set(driveKey(siteId, name), id)
  }
  return entries.sort((left, right) => compareCodePoints(left[0], right[0]))
}

export async function listDrives(accessor: SharePointAccessor, siteId: string): Promise<string[]> {
  return (await driveEntries(accessor, siteId)).map((entry) => entry[0])
}

async function resolveSiteId(accessor: SharePointAccessor, name: string): Promise<string | null> {
  if (!accessor.siteCache.has(name)) await siteEntries(accessor)
  return accessor.siteCache.get(name) ?? null
}

async function resolveDriveId(
  accessor: SharePointAccessor,
  siteId: string,
  name: string,
): Promise<string | null> {
  const key = driveKey(siteId, name)
  if (!accessor.driveCache.has(key)) await driveEntries(accessor, siteId)
  return accessor.driveCache.get(key) ?? null
}

/**
 * Resolve a mount path to its site, drive and drive-relative item path.
 *
 * A mount scoped to one site and drive (both configured) lives inside that
 * drive, so its paths are drive-relative and the namespace levels vanish.
 * An unscoped mount exposes `/<site>/<library>/...`.
 *
 * Args:
 *   accessor: the mount's accessor.
 *   path: the path to resolve.
 */
export async function resolve(accessor: SharePointAccessor, path: PathSpec): Promise<ResolvedPath> {
  const raw = stripSlash(path.vfsPath)
  const config = accessor.config
  if (config.site !== null && config.drive !== null) {
    const siteId = await resolveSiteId(accessor, config.site)
    if (siteId === null) return resolvedPath('site')
    const driveId = await resolveDriveId(accessor, siteId, config.drive)
    if (driveId === null) return resolvedPath('drive', siteId)
    const itemPath = scopedItemPath(config.keyPrefix, raw)
    if (itemPath === '') return resolvedPath('drive', siteId, driveId)
    return resolvedPath('item', siteId, driveId, itemPath)
  }
  if (raw === '') return resolvedPath('root')
  const parts = raw.split('/')
  const siteId = await resolveSiteId(accessor, parts[0] ?? '')
  if (siteId === null) return resolvedPath('site')
  if (parts.length === 1) return resolvedPath('site', siteId)
  const driveId = await resolveDriveId(accessor, siteId, parts[1] ?? '')
  if (driveId === null) return resolvedPath('drive', siteId)
  if (parts.length === 2) return resolvedPath('drive', siteId, driveId)
  return resolvedPath('item', siteId, driveId, parts.slice(2).join('/'))
}

/**
 * Raise ENOENT unless `resolved` names a drive item.
 *
 * Args:
 *   path: the path `resolved` came from, named by the error.
 *   resolved: its resolution.
 */
export function requireItem(path: PathSpec, resolved: ResolvedPath): void {
  if (resolved.driveId === null || resolved.itemPath === null) throw enoent(path)
}

export async function resolveItem(
  accessor: SharePointAccessor,
  path: PathSpec,
): Promise<ResolvedPath> {
  const resolved = await resolve(accessor, path)
  requireItem(path, resolved)
  return resolved
}

export function driveLoc(
  config: MsGraphConfigResolved,
  resolved: ResolvedPath,
  virtual: string,
): DriveLoc {
  const driveId = resolved.driveId
  if (driveId === null) throw new Error('SharePoint path has no drive')
  return new DriveLoc({
    drive: driveId,
    path: resolved.itemPath ?? '',
    virtual: stripSlash(virtual),
    url: (item, action) => itemUrl(config, driveId, item, action),
    ref: (folder) => driveRefPath(driveId, folder),
  })
}
