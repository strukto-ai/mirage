import { CapacityState, type CapacityResult } from '@struktoai/mirage-core/types'
import { rstripSlash } from '@struktoai/mirage-core/utils/slash'
import type { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { QUOTA_PROPFIND, SPACE_UNLIMITED } from './constants.ts'
import { davRequest } from './dav.ts'
import { parser, records } from './search/response.ts'
import type { XmlRecord } from './search/types.ts'

/**
 * A quota property's byte count from a property group the server answered,
 * null when no such group holds a whole number. Mirrors Python's
 * `quota_value`.
 */
function quotaValue(tree: XmlRecord, name: string): number | null {
  const groups = records(tree.multistatus)
    .flatMap((multistatus) => records(multistatus.response))
    .flatMap((answer) => records(answer.propstat))
  for (const propstat of groups) {
    const status = typeof propstat.status === 'string' ? propstat.status : ''
    if (status.split(/\s+/)[1] !== '200') continue
    const text = records(propstat.prop)[0]?.[name]
    if (typeof text === 'string' && /^-?\d+$/.test(text.trim())) return Number(text.trim())
  }
  return null
}

/**
 * The user's Nextcloud quota, for df, from the WebDAV quota properties of the
 * mount's root. A user without a quota is ELASTIC; a quota Nextcloud has not
 * computed is UNKNOWN. Mirrors Python's `capacity`.
 */
export async function capacity(accessor: NextcloudAccessor): Promise<CapacityResult> {
  const response = await davRequest(
    accessor,
    'PROPFIND',
    `${rstripSlash(accessor.config.url)}/`,
    { Depth: '0', 'Content-Type': 'application/xml' },
    QUOTA_PROPFIND,
  )
  if (response.status !== 207) {
    if (!response.ok) throw new Error(`Nextcloud PROPFIND returned HTTP ${String(response.status)}`)
    return { state: CapacityState.UNKNOWN }
  }
  const tree = parser.parse(await response.text()) as XmlRecord
  const available = quotaValue(tree, 'quota-available-bytes')
  const used = quotaValue(tree, 'quota-used-bytes')
  if (available === SPACE_UNLIMITED) return { state: CapacityState.ELASTIC }
  if (available === null || used === null || available < 0) {
    return { state: CapacityState.UNKNOWN }
  }
  return { state: CapacityState.QUOTA, total: used + available, used, available }
}
