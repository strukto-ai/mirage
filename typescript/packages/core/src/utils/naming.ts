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

import { enoent } from './errors.ts'
import {
  NAME_MAX_BYTES,
  byteLength,
  pathSafeName,
  sanitizeName,
  stripTrailingUnderscores,
  truncateBytes,
} from './sanitize.ts'

export const SEPARATOR = '__'

/**
 * Join an already-transformed label to its id inside NAME_MAX.
 *
 * The id and the suffix are what make the name *address* something, so they
 * are spent first and never trimmed; the label takes whatever of the 255
 * bytes is left. Trimming the id instead would leave a name that no longer
 * resolves, and `parseIdName` splits on the last separator, so a shortened
 * label still round-trips.
 *
 * Budgets in bytes, not characters: `sanitizeName` caps at 100 characters and
 * `pathSafeName` does not cap at all, so a CJK display name reached 621 bytes
 * against a 255-byte NAME_MAX and the filesystem refused the name outright.
 *
 * Takes the label already transformed because callers differ on the
 * transform: most pass one name through `sanitizeName`, while Linear's team
 * directory joins two sanitized parts with the separator itself --
 * re-sanitizing that would collapse `__` to `_` and change the name's shape.
 */
export function fitIdName(label: string, resourceId: string, suffix = ''): string {
  const budget = NAME_MAX_BYTES - (SEPARATOR.length + byteLength(resourceId) + byteLength(suffix))
  const fitted =
    byteLength(label) > budget ? stripTrailingUnderscores(truncateBytes(label, budget)) : label
  return `${fitted}${SEPARATOR}${resourceId}${suffix}`
}

/**
 * Build a `<name>__<id>` segment for VFS paths.
 *
 * Used by mounts that encode resource IDs in filenames for reverse lookups
 * (Discord, Slack, gcal calendars, Linear, Trello). By default applies the
 * full `sanitizeName` transform; set `pathSafe` to preserve the original
 * spelling and only escape the path separator. Discord and Slack use
 * `pathSafe` so display names stay readable.
 *
 * Pass `suffix` here rather than concatenating an extension afterwards, so it
 * is counted against the NAME_MAX budget instead of pushing the name past it.
 */
export function makeIdName(
  displayName: string,
  resourceId: string,
  pathSafe = false,
  suffix = '',
): string {
  const transform = pathSafe ? pathSafeName : sanitizeName
  return fitIdName(transform(displayName), resourceId, suffix)
}

/**
 * Extract `[displayName, resourceId]` from `makeIdName` output, optionally
 * stripping a file extension first. Throws when `name` doesn't end with
 * `suffix` or doesn't contain `__`.
 */
export function parseIdName(name: string, suffix = ''): [string, string] {
  if (suffix !== '' && !name.endsWith(suffix)) {
    throw enoent(name)
  }
  const raw = suffix !== '' ? name.slice(0, -suffix.length) : name
  const idx = raw.lastIndexOf(SEPARATOR)
  if (idx === -1) {
    throw enoent(name)
  }
  const label = raw.slice(0, idx)
  const id = raw.slice(idx + SEPARATOR.length)
  if (id === '') {
    throw enoent(name)
  }
  return [label, id]
}
