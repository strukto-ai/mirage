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

import type { resolveOneDriveConfig } from '../../accessor/onedrive.ts'
import { stripSlash } from '../../utils/slash.ts'
import { encodedPath } from '../msgraph/client.ts'
import { graphApi } from '../msgraph/config.ts'
import { DriveLoc } from '../msgraph/drive.ts'

/**
 * The drive this mount addresses, as a Graph URL prefix.
 *
 * Exactly one target may be named (the accessor's config enforces it), so
 * the arms are alternatives rather than a precedence chain. Naming none
 * means the signed-in user's own drive, which is the only form that works
 * under delegated auth with no extra identifiers.
 *
 * Args:
 *   config: mount config.
 */
export function driveBase(config: ReturnType<typeof resolveOneDriveConfig>): string {
  const api = graphApi(config)
  if (config.driveId !== null) return `${api}/drives/${encodeURIComponent(config.driveId)}`
  if (config.siteId !== null) return `${api}/sites/${encodeURIComponent(config.siteId)}/drive`
  if (config.groupId !== null) return `${api}/groups/${encodeURIComponent(config.groupId)}/drive`
  if (config.userId !== null) return `${api}/users/${encodeURIComponent(config.userId)}/drive`
  return `${api}/me/drive`
}

function fullPath(config: ReturnType<typeof resolveOneDriveConfig>, path: string): string {
  const stripped = stripSlash(path)
  if (config.keyPrefix !== '' && stripped !== '') return `${config.keyPrefix}/${stripped}`
  return config.keyPrefix || stripped
}

/**
 * Graph URL of a drive item by its path from the drive root.
 *
 * Unlike {@link itemUrl}, `full` is not placed under the mount's
 * `keyPrefix`: this is how the prefix folders themselves are reached.
 *
 * Args:
 *   config: mount config.
 *   full: path from the drive root; empty for the root itself.
 *   action: a trailing Graph segment such as `/children`.
 */
export function fullItemUrl(
  config: ReturnType<typeof resolveOneDriveConfig>,
  full: string,
  action = '',
): string {
  const base = driveBase(config)
  const path = stripSlash(full)
  if (path === '') return `${base}/root${action}`
  const stem = `${base}/root:/${encodedPath(path)}`
  return action !== '' ? `${stem}:${action}` : stem
}

export function itemUrl(
  config: ReturnType<typeof resolveOneDriveConfig>,
  path: string,
  action = '',
): string {
  return fullItemUrl(config, fullPath(config, path), action)
}

// `folder` is mount-relative; the keyPrefix applies here exactly like
// itemUrl, or copy and rename destinations land at the drive root.
export function driveRefPath(
  config: ReturnType<typeof resolveOneDriveConfig>,
  folder = '',
): string {
  const base = driveBase(config).slice(graphApi(config).length)
  const full = fullPath(config, folder)
  return full !== '' ? `${base}/root:/${encodedPath(full)}` : `${base}/root:`
}

export function driveLoc(config: ReturnType<typeof resolveOneDriveConfig>, path: string): DriveLoc {
  const stripped = stripSlash(path)
  return new DriveLoc({
    drive: '',
    path: stripped,
    virtual: stripped,
    url: (item, action) => itemUrl(config, item, action),
    ref: (folder) => driveRefPath(config, folder),
  })
}
