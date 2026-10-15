import type { PathSpec } from '@struktoai/mirage-core/types'
import { rstripSlash } from '@struktoai/mirage-core/utils/slash'
import type { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { auth } from './search/client.ts'
import { records } from './search/response.ts'
import type { XmlRecord } from './search/types.ts'
import { nextcloudKey } from './util.ts'

/** The WebDAV URL of a path, its segments percent-encoded; `folder` ends it with a slash, as a collection's. */
export function davUrl(accessor: NextcloudAccessor, path: PathSpec, folder = false): string {
  const key = rstripSlash(nextcloudKey(path)).split('/').map(encodeURIComponent).join('/')
  const url = rstripSlash(accessor.config.url) + (key === '' ? '' : `/${key}`)
  return folder ? `${url}/` : url
}

/** Send one WebDAV request with the mount's credentials. */
export async function davRequest(
  accessor: NextcloudAccessor,
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<Response> {
  const basic = auth(accessor)
  return fetch(url, {
    method,
    headers: basic === null ? headers : { ...headers, Authorization: basic },
    ...(body === undefined ? {} : { body }),
    signal: AbortSignal.timeout((accessor.config.timeout ?? 30) * 1000),
  })
}

/**
 * A property's text from a group the server answered 200 for, null when no
 * such group holds it. Mirrors Python's `answered`.
 */
export function answered(tree: XmlRecord, name: string): string | null {
  const groups = records(tree.multistatus)
    .flatMap((multistatus) => records(multistatus.response))
    .flatMap((answer) => records(answer.propstat))
  for (const propstat of groups) {
    const prop = records(propstat.prop)[0]
    const status = typeof propstat.status === 'string' ? propstat.status : ''
    if (prop === undefined || !(name in prop) || status.split(/\s+/)[1] !== '200') continue
    const value = prop[name]
    return typeof value === 'string' ? value.trim() : ''
  }
  return null
}
