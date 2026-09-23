import type { PathSpec } from '@struktoai/mirage-core/types'
import { mountPrefixOf } from '@struktoai/mirage-core/utils/key_prefix'
import { lstripSlash } from '@struktoai/mirage-core/utils/slash'

export function rawPathOf(path: PathSpec): string {
  const prefix = mountPrefixOf(path.virtual, path.vfsPath)
  return prefix !== '' && path.virtual.startsWith(prefix)
    ? path.virtual.slice(prefix.length) || '/'
    : path.virtual
}

export function nextcloudKey(path: PathSpec): string {
  return lstripSlash(rawPathOf(path))
}

export function isNotFound(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('NotFound')
}
