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

import type { FsError, PathSpec } from '@struktoai/mirage-core'

// Restamp a raw node:fs error against the mount path. The disk backend
// operates on a resolved host path, so a raw ErrnoException carries that host
// path in its message and the command boundary would print it. Only the
// virtual path may ever reach a user-facing message: the host root is an
// implementation detail of the mount, and leaking it discloses the server's
// directory layout. The errno code is preserved, so the GNU strerror wording
// at the command boundary is unchanged. Errors with no errno code (a bug, not
// a filesystem condition) are returned untouched so they still surface.
export function diskError(err: unknown, spec: PathSpec): unknown {
  const code = (err as NodeJS.ErrnoException).code
  if (typeof code !== 'string') return err
  const out = new Error(spec.virtual) as FsError
  out.code = code
  out.virtualPath = spec.virtual
  return out
}
