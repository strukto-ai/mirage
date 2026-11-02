import type { PathSpec } from '@struktoai/mirage-core/types'
import { eacces, ebusy, enoent, enotempty, fsError } from '@struktoai/mirage-core/errors/fs'
import { sleep } from '@struktoai/mirage-core/utils/abort'
import { rstripSlash } from '@struktoai/mirage-core/utils/slash'
import type { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { answered, davRequest, davUrl } from './dav.ts'
import { mtimePatch } from './set_attrs.ts'
import { parser, records } from './search/response.ts'
import type { XmlElement } from './search/types.ts'

export const SURVEY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<d:propfind xmlns:d="DAV:"><d:prop><d:getlastmodified/></d:prop></d:propfind>'
export const FENCE = 2000
export const ATTEMPTS = 4

/** The error for a status that ends an rmdir. Mirrors Python's `failure`. */
export function failure(path: PathSpec, status: number): Error {
  if (status === 404) return enoent(path)
  if (status === 403) return eacces(path)
  if (status === 423) return ebusy(path)
  return fsError(path, 'EIO')
}

/**
 * Whether a collection lists a child, when it last changed and the server's
 * clock, from one Depth 1 PROPFIND. Mirrors Python's `survey`.
 */
export async function survey(
  accessor: NextcloudAccessor,
  path: PathSpec,
): Promise<{ child: boolean; modified: Date; now: Date }> {
  const url = davUrl(accessor, path, true)
  const response = await davRequest(
    accessor,
    'PROPFIND',
    url,
    { Depth: '1', 'Content-Type': 'application/xml' },
    SURVEY,
  )
  if (response.status !== 207) throw failure(path, response.status)
  const own = rstripSlash(decodeURIComponent(new URL(url).pathname))
  const tree = parser.parse(await response.text()) as XmlElement
  let child = false
  let modified: string | null = null
  for (const entry of records(tree.multistatus).flatMap((m) => records(m.response))) {
    const href = typeof entry.href === 'string' ? entry.href : ''
    if (rstripSlash(decodeURIComponent(href)) !== own) child = true
    else modified = answered({ multistatus: { response: entry } }, 'getlastmodified')
  }
  const date = response.headers.get('Date')
  if (modified === null || date === null) throw fsError(path, 'EIO')
  return { child, modified: new Date(modified), now: new Date(date) }
}

/**
 * Move a collection's modified time out of the fence: set it `FENCE` back
 * from the server's clock, or wait `FENCE` out where the server will not set
 * it. Mirrors Python's `settle`.
 */
export async function settle(
  accessor: NextcloudAccessor,
  path: PathSpec,
  now: Date,
): Promise<void> {
  const response = await davRequest(
    accessor,
    'PROPPATCH',
    davUrl(accessor, path, true),
    { 'Content-Type': 'application/xml' },
    mtimePatch(Math.trunc((now.getTime() - FENCE) / 1000)),
  )
  if (
    response.status !== 207 ||
    answered(parser.parse(await response.text()) as XmlElement, 'lastmodified') === null
  ) {
    await sleep(FENCE)
  }
}

/**
 * Remove an empty collection.
 *
 * WebDAV DELETE on a collection is recursive (RFC 4918 9.6.1), so a listing
 * followed by a plain DELETE destroys a child another client adds in
 * between. Nextcloud never matches a collection's ETag, but every child that
 * arrives (PUT, MKCOL, MOVE, COPY, at any depth) sets the collection's
 * modified time to the server's current second, and `If-Unmodified-Since` is
 * honoured on a collection. So the DELETE carries the modified time the
 * listing saw and the server refuses it with 412 once anything has arrived;
 * the listing is then taken again.
 *
 * Times are whole seconds, so a child landing in the second the collection
 * last changed would not move it. The fence needs the collection unchanged
 * for `FENCE` by the server's clock; a younger or future-dated one is settled
 * first (`settle`). A collection that keeps changing for `ATTEMPTS` listings
 * is busy.
 */
export async function rmdir(accessor: NextcloudAccessor, path: PathSpec): Promise<void> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const { child, modified, now } = await survey(accessor, path)
    if (child) throw enotempty(path)
    if (now.getTime() - modified.getTime() < FENCE) {
      await settle(accessor, path, now)
      continue
    }
    const response = await davRequest(accessor, 'DELETE', davUrl(accessor, path, true), {
      'If-Unmodified-Since': modified.toUTCString(),
    })
    if (response.ok) return
    if (response.status !== 412) throw failure(path, response.status)
  }
  throw ebusy(path)
}
