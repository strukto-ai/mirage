import { CapacityState, type CapacityResult } from '@struktoai/mirage-core/types'
import { rstripSlash } from '@struktoai/mirage-core/utils/slash'
import type { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { QUOTA_PROPFIND, SPACE_UNLIMITED } from './constants.ts'
import { davRequest } from './dav.ts'
import { parser, records } from './search/response.ts'
import type { XmlRecord } from './search/types.ts'

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
  const prop = records(tree.multistatus)
    .flatMap((multistatus) => records(multistatus.response))
    .flatMap((answer) => records(answer.propstat))
    .flatMap((propstat) => records(propstat.prop))[0]
  const available = prop?.['quota-available-bytes']
  const used = prop?.['quota-used-bytes']
  if (typeof available !== 'string' || typeof used !== 'string') {
    return { state: CapacityState.UNKNOWN }
  }
  if (Number(available) === SPACE_UNLIMITED) return { state: CapacityState.ELASTIC }
  if (Number(available) < 0) return { state: CapacityState.UNKNOWN }
  return {
    state: CapacityState.QUOTA,
    total: Number(used) + Number(available),
    used: Number(used),
    available: Number(available),
  }
}
