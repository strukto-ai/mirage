import { enoent } from '@struktoai/mirage-core/errors/fs'
import type { PathSpec, SetAttrFields } from '@struktoai/mirage-core/types'
import type { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { davRequest, davUrl } from './dav.ts'
import { parser, records } from './search/response.ts'
import type { XmlRecord } from './search/types.ts'

/** The PROPPATCH body that sets a node's modified time, in whole seconds since the epoch. */
export function mtimePatch(seconds: number): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<d:propertyupdate xmlns:d="DAV:"><d:set><d:prop>' +
    `<d:lastmodified>${String(seconds)}</d:lastmodified>` +
    '</d:prop></d:set></d:propertyupdate>'
  )
}

/** Whether a PROPPATCH answer says the modified time was set. */
export function stored(content: string): boolean {
  const tree = parser.parse(content) as XmlRecord
  for (const multistatus of records(tree.multistatus)) {
    for (const response of records(multistatus.response)) {
      for (const propstat of records(response.propstat)) {
        const prop = records(propstat.prop)[0]
        if (prop === undefined || !('lastmodified' in prop)) continue
        const status = propstat.status
        return typeof status === 'string' && status.includes(' 200 ')
      }
    }
  }
  return false
}

/**
 * Store a modified time on the node, and return the fields Nextcloud does not
 * keep: permission bits, ownership and the access time land in the
 * namespace's overlay, and so does the modified time on a server that will
 * not set it. Nextcloud keeps whole seconds, so a fraction is dropped.
 * Mirrors Python's `set_attrs`.
 */
export async function setAttrs(
  accessor: NextcloudAccessor,
  path: PathSpec,
  fields: SetAttrFields,
): Promise<Record<string, number | string>> {
  const residual: Record<string, number | string> = {}
  if (fields.mode !== undefined) residual.mode = fields.mode
  if (fields.uid !== undefined) residual.uid = fields.uid
  if (fields.gid !== undefined) residual.gid = fields.gid
  if (fields.atime !== undefined) residual.atime = fields.atime
  if (fields.mtime === undefined) return residual
  const seconds = Math.trunc(new Date(fields.mtime).getTime() / 1000)
  const response = await davRequest(
    accessor,
    'PROPPATCH',
    davUrl(accessor, path),
    { 'Content-Type': 'application/xml' },
    mtimePatch(seconds),
  )
  if (response.status === 404) throw enoent(path)
  if (response.status !== 207 || !stored(await response.text())) {
    residual.mtime = fields.mtime
    return residual
  }
  return residual
}
