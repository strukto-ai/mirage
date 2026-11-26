import { classify } from '@struktoai/mirage-core/errors/classify'
import type { FsCondition } from '@struktoai/mirage-core/errors/types'
import { HttpError } from '../errors.ts'

export class SandboxNotRunning extends HttpError {
  constructor() {
    super('unauthorized', 'invalid sandbox access token')
  }
}

export class InvalidConnectRequest extends Error {}

export class UnsupportedProcessOption extends Error {}

type FileCode =
  | 'already_exists'
  | 'failed_precondition'
  | 'internal'
  | 'invalid_argument'
  | 'not_found'
  | 'permission_denied'
  | 'resource_exhausted'
  | 'unimplemented'

export class FileError extends Error {
  constructor(
    readonly code: FileCode,
    message: string,
  ) {
    super(message)
    this.name = 'FileError'
  }
}

const ERRORS: Partial<Record<FsCondition, [FileCode, string]>> = {
  ENOENT: ['not_found', 'file not found'],
  EEXIST: ['already_exists', 'file or directory already exists'],
  EACCES: ['permission_denied', 'permission denied'],
  EPERM: ['permission_denied', 'permission denied'],
  EROFS: ['permission_denied', 'read-only filesystem'],
  ENOTDIR: ['failed_precondition', 'not a directory'],
  EISDIR: ['failed_precondition', 'is a directory'],
  ENOTEMPTY: ['failed_precondition', 'directory is not empty'],
  EBUSY: ['failed_precondition', 'path is busy'],
  EXDEV: ['failed_precondition', 'cannot move across mounts'],
  ELOOP: ['invalid_argument', 'symbolic link loop'],
  EINVAL: ['invalid_argument', 'invalid path'],
  EDQUOT: ['resource_exhausted', 'disk quota exceeded'],
  EFBIG: ['resource_exhausted', 'file is too large'],
  ENOTSUP: ['unimplemented', 'filesystem operation is unsupported'],
}

export function fileError(error: unknown): FileError {
  if (error instanceof FileError) return error
  const condition = classify(error)
  const entry = condition === null ? undefined : ERRORS[condition]
  if (entry !== undefined) return new FileError(...entry)
  return new FileError('internal', 'filesystem operation failed')
}

export const CONNECT_STATUS: Record<FileError['code'], number> = {
  invalid_argument: 400,
  failed_precondition: 400,
  permission_denied: 403,
  not_found: 404,
  already_exists: 409,
  resource_exhausted: 429,
  internal: 500,
  unimplemented: 501,
}

export function connectCode(status: number): string {
  switch (status) {
    case 400:
      return 'invalid_argument'
    case 401:
      return 'unauthenticated'
    case 403:
      return 'permission_denied'
    case 404:
      return 'not_found'
    case 413:
    case 429:
      return 'resource_exhausted'
    case 501:
      return 'unimplemented'
    case 503:
      return 'unavailable'
    default:
      return 'internal'
  }
}
