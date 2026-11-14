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

import { FileError, toError, type FileErrorCode } from '@earendil-works/pi-durable/env'
import { classify } from '@struktoai/mirage-core/errors/classify'
import type { FsCondition } from '@struktoai/mirage-core/errors/types'
import { errorText } from '@struktoai/mirage-core/workspace/tools/io_text'

const CODES: Partial<Record<FsCondition, FileErrorCode>> = {
  ENOENT: 'not_found',
  EACCES: 'permission_denied',
  EPERM: 'permission_denied',
  EROFS: 'permission_denied',
  ENOTDIR: 'not_directory',
  EISDIR: 'is_directory',
  EINVAL: 'invalid',
  ELOOP: 'invalid',
  ENOTSUP: 'not_supported',
}

/**
 * A Mirage failure as Pi's `FileError`: its errno picks the code, and the
 * message is the text Mirage's own agent tools show, a policy's reason
 * included.
 */
export function toFileError(error: unknown, path?: string): FileError {
  if (error instanceof FileError) return error
  const cause = toError(error)
  if (cause.name === 'AbortError') return new FileError('aborted', cause.message, path, cause)
  const condition = classify(error)
  const code = (condition === null ? undefined : CODES[condition]) ?? 'unknown'
  return new FileError(code, errorText(error).trimEnd(), path, cause)
}
