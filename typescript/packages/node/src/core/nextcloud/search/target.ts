import type { PathSpec } from '@struktoai/mirage-core'
import { rawPathOf } from '../util.ts'
import { SEARCH_ENDPOINT_PATH } from './constants.ts'
import type { SearchTarget } from './types.ts'

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path)
  } catch (error) {
    throw new Error(`invalid percent-encoding in Nextcloud path: ${path}`, { cause: error })
  }
}

export function searchTarget(url: string): SearchTarget | null {
  const parsed = new URL(url)
  const marker = parsed.pathname.indexOf(SEARCH_ENDPOINT_PATH)
  if (marker < 0) return null
  const davEnd = marker + SEARCH_ENDPOINT_PATH.length
  const relative = parsed.pathname.slice(davEnd).replace(/^\/+|\/+$/g, '')
  const parts = relative === '' ? [] : relative.split('/')
  if (parts.length < 2 || parts[0] !== 'files') return null
  const endpoint = new URL(parsed.toString())
  endpoint.pathname = parsed.pathname.slice(0, davEnd)
  endpoint.search = ''
  endpoint.hash = ''
  return {
    endpoint: endpoint.toString(),
    resourceScope: decodePath(`/${parts.join('/')}`),
  }
}

export function scopePath(target: SearchTarget, path: PathSpec): string {
  const relative = rawPathOf(path).replace(/^\/+|\/+$/g, '')
  return relative === ''
    ? target.resourceScope
    : `${target.resourceScope.replace(/\/+$/, '')}/${relative}`
}

function stripScope(path: string, scope: string): string | null {
  if (path === scope) return ''
  const prefix = `${scope.replace(/\/+$/, '')}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : null
}

export function relativePath(href: string, target: SearchTarget): string {
  const hrefPath = decodePath(new URL(href, target.endpoint).pathname).replace(/\/+$/, '')
  const resourceScope = target.resourceScope.replace(/\/+$/, '')
  let relative = stripScope(hrefPath, resourceScope)
  if (relative === null) {
    const davRoot = decodePath(new URL(target.endpoint).pathname).replace(/\/+$/, '')
    relative = stripScope(hrefPath, `${davRoot}${resourceScope}`)
  }
  if (relative === null) {
    throw new Error(`Nextcloud Files Search returned an out-of-scope href: ${href}`)
  }
  return relative !== '' ? `/${relative}` : '/'
}
