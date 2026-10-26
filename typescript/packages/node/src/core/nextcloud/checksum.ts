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

import { record, startOp } from '@struktoai/mirage-core/observe/context'
import { VFSName } from '@struktoai/mirage-core/types'
import type { PathSpec } from '@struktoai/mirage-core/types'
import type { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { CHECKSUM_PROPFIND, CHECKSUM_TYPES } from './constants.ts'
import { davRequest, davUrl } from './dav.ts'
import { parser, records } from './search/response.ts'
import type { XmlRecord } from './search/types.ts'

/**
 * The digest Nextcloud keeps for a file, from `oc:checksums`.
 *
 * A client that uploads with an `OC-Checksum` header (the desktop and mobile
 * clients do) leaves its digest on the file, and a write without one clears
 * it, so a digest the server reports names the bytes it holds. The property is
 * one space-separated list of `TYPE:hex`; only the asked algorithm's, in hex of
 * its length, answers. A server that keeps none, a collection, and any answer
 * but a 207 leave the file to be read and hashed, which reports it. A digest
 * answered is recorded as the read it stands in for. Mirrors Python's
 * `checksum`.
 */
export async function checksum(
  accessor: NextcloudAccessor,
  path: PathSpec,
  algorithm: string,
): Promise<string | null> {
  const kind = Object.hasOwn(CHECKSUM_TYPES, algorithm) ? CHECKSUM_TYPES[algorithm] : undefined
  if (kind === undefined) return null
  const [name, width] = kind
  const timer = startOp()
  const response = await davRequest(
    accessor,
    'PROPFIND',
    davUrl(accessor, path),
    { Depth: '0', 'Content-Type': 'application/xml' },
    CHECKSUM_PROPFIND,
  )
  if (response.status !== 207) {
    console.debug(
      `nextcloud checksum of ${path.virtual} left to the read: HTTP ${String(response.status)}`,
    )
    return null
  }
  const tree = parser.parse(await response.text()) as XmlRecord
  const listed: string[] = []
  const groups = records(tree.multistatus)
    .flatMap((multistatus) => records(multistatus.response))
    .flatMap((answer) => records(answer.propstat))
  for (const propstat of groups) {
    const prop = records(propstat.prop)[0]
    const status = typeof propstat.status === 'string' ? propstat.status : ''
    if (prop === undefined || status.split(/\s+/)[1] !== '200') continue
    if (records(prop.resourcetype).some((type) => 'collection' in type)) return null
    for (const sums of records(prop.checksums)) {
      const values: unknown[] = Array.isArray(sums.checksum) ? sums.checksum : [sums.checksum]
      for (const value of values) {
        if (typeof value === 'string')
          for (const item of value.split(/\s+/).filter((word) => word !== '')) listed.push(item)
      }
    }
  }
  const hex = new RegExp(`^[0-9a-f]{${String(width)}}$`)
  for (const entry of listed) {
    const cut = entry.indexOf(':')
    if (cut < 0 || entry.slice(0, cut).toUpperCase() !== name) continue
    const digest = entry.slice(cut + 1).toLowerCase()
    if (hex.test(digest)) {
      record('read', path.virtual, VFSName.NEXTCLOUD, 0, timer)
      return digest
    }
  }
  return null
}
