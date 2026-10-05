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
import type { Refusal } from '@struktoai/mirage-core/types'
import { isMissingPath } from '@struktoai/mirage-core/utils/errors'
import { withRefusal } from '@struktoai/mirage-core/workspace/tools/io_text'

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
// EROFS, EXDEV; PolicyDenied carries EACCES too), so the dsh taxonomy is
// derived from the stamp rather than from message sniffing or class checks
// that would couple this adapter to mirage internals.
function codeFor(err: unknown): FsErrorCode {
  if (isMissingPath(err)) return 'FS_NOT_FOUND'
  // An admission policy refused the op at the door: the session's
  // permission document, or a code policy registered beside it. EACCES is
  // too coarse to say so alone, since a plain mount-mode refusal carries
  // it too, and the two want different answers — a mode refusal is the
  // shape of this world, while a policy refusal is a confinement the call
  // may be entitled to escalate past. So it maps to the sandbox code,
  // which is what makes dsh's tool layer attach the escalation hint
  // (`FsSandboxController.mapError` keys on exactly this code) and render
  // the same denial marker bash gets for a refused command.
  //
  // Matched on `name`, like the AbortError case below and for the same
  // reason: core's PolicyDenied documents that name as the discriminator
  // for "handlers that special-case mount-mode refusals", and matching it
  // needs no import of a class this adapter never constructs.
  if (err instanceof Error && err.name === 'PolicyDenied') return 'FS_SANDBOX_DENIED'
  switch (codeOf(err)) {
    case 'EISDIR':
      return 'FS_NOT_REGULAR_FILE'
    case 'ENOTDIR':
      return 'FS_NOT_DIRECTORY'
    case 'EACCES':
    case 'EPERM':
    case 'EROFS':
      return 'FS_PERMISSION_DENIED'
    default:
      return 'FS_IO_ERROR'
  }
}

export function mapMirageError(err: unknown, operation: string, displayPath: string): FsError {
  if (err instanceof FsError) return err
  // Matched by name, not by class: mirage's own executor throws a
  // `DOMException`, but an aborted fetch or a backend SDK may throw a
  // plain `Error` named the same, and reporting that as FS_IO_ERROR
  // would tell the caller its own cancellation was a backend failure.
  if (err instanceof Error && err.name === 'AbortError') {
    return new FsError(`${operation} aborted`, 'FS_ABORTED', { cause: err })
  }
  const message = err instanceof Error ? err.message : String(err)
  // A policy's refusal reads as a plain EACCES; its reason is one more
  // line, as on every other surface that hands the agent text.
  const refusal = (err as { refusal?: Refusal | null } | null)?.refusal ?? null
  const text = withRefusal(`cannot ${operation} "${displayPath}": ${message}`, refusal)
  return new FsError(text.trimEnd(), codeFor(err), { cause: err })
}
