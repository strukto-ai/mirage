import type { PathSpec } from '@struktoai/mirage-core/types'
import { rawPathOf } from '@struktoai/mirage-core/utils/key_prefix'
import { lstripSlash } from '@struktoai/mirage-core/utils/slash'

export function nextcloudKey(path: PathSpec): string {
  return lstripSlash(rawPathOf(path))
}

export function isNotFound(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('NotFound')
}
