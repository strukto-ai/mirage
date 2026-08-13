// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsErrorCode } from '@deepseek-ai/dsh-fs'
import { isMissingPath } from '@struktoai/mirage-core'

export function assertNotAborted(signal: AbortSignal | undefined, operation: string): void {
  if (signal?.aborted === true) {
    throw new FsError(`${operation} aborted`, 'FS_ABORTED')
  }
}

function codeOf(err: unknown): string | null {
  if (err === null || typeof err !== 'object') return null
  const stamped = err as { code?: unknown }
  return typeof stamped.code === 'string' ? stamped.code : null
}

// mirage stamps POSIX codes on its errors (ENOENT, EISDIR, ENOTDIR, EACCES,
// EXDEV; PolicyDenied carries EACCES too), so the dsh taxonomy is derived
// from the stamp rather than from message sniffing or class checks that
// would couple this adapter to mirage internals.
function codeFor(err: unknown): FsErrorCode {
  if (isMissingPath(err)) return 'FS_NOT_FOUND'
  switch (codeOf(err)) {
    case 'EISDIR':
      return 'FS_NOT_REGULAR_FILE'
    case 'ENOTDIR':
      return 'FS_NOT_DIRECTORY'
    case 'EACCES':
    case 'EPERM':
      return 'FS_PERMISSION_DENIED'
    default:
      return 'FS_IO_ERROR'
  }
}

export function mapMirageError(err: unknown, operation: string, displayPath: string): FsError {
  if (err instanceof FsError) return err
  if (err instanceof DOMException && err.name === 'AbortError') {
    return new FsError(`${operation} aborted`, 'FS_ABORTED', { cause: err })
  }
  const message = err instanceof Error ? err.message : String(err)
  return new FsError(`cannot ${operation} "${displayPath}": ${message}`, codeFor(err), {
    cause: err,
  })
}
