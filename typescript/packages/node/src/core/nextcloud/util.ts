import { mountPrefixOf, type PathSpec } from '@struktoai/mirage-core'

export function rawPathOf(path: PathSpec): string {
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  return prefix !== '' && path.virtual.startsWith(prefix)
    ? path.virtual.slice(prefix.length) || '/'
    : path.virtual
}

export function nextcloudKey(path: PathSpec): string {
  return rawPathOf(path).replace(/^\/+/, '')
}

export function isNotFound(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('NotFound')
}
