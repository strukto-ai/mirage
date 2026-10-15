import type { PathSpec } from '@struktoai/mirage-core/types'
import { rstripSlash } from '@struktoai/mirage-core/utils/slash'
import type { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { auth } from './search/client.ts'
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
