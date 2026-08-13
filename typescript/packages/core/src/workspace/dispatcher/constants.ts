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

// The content reads the warm file cache may answer: a cached whole-file
// value can serve them (sliced for ranged reads) without touching the
// backend, subject to the reconciler's consistency check.
export const DISPATCH_READ_OPS: ReadonlySet<string> = new Set(['read', 'read_bytes'])

// Backend mutations that run the dispatcher's post-write bookkeeping:
// file-cache eviction, parent index invalidation, and overlay time
// clearing (plus the observed-mtime stamp for the content writes in
// STAMP_WRITE_OPS).
export const DISPATCH_WRITE_OPS: ReadonlySet<string> = new Set([
  'write',
  'write_bytes',
  'append',
  'unlink',
  'create',
  'truncate',
  'mkdir',
  'rmdir',
  'rename',
])

// What the admission gates classify as a write (OpsContext.write). A
// superset of DISPATCH_WRITE_OPS: setattr mutates the mount but keeps
// its own overlay bookkeeping in applySetattr, and symlink writes only
// the node table, so both need write admission without joining the
// post-write invalidation path.
export const POLICY_WRITE_OPS: ReadonlySet<string> = new Set([
  ...DISPATCH_WRITE_OPS,
  'setattr',
  'symlink',
])

// Ops the node table itself answers: a symlink is namespace state with
// no backend behind it, so the door is the authority for both
// directions (create and readlink) rather than a router to a mount.
export const NAMESPACE_TABLE_OPS: ReadonlySet<string> = new Set(['symlink', 'readlink'])

// The attribute fields a setattr op can carry, in one place so the
// requested/residual split and the overlay write read the same names.
export const SETATTR_KEYS = ['mode', 'uid', 'gid', 'atime', 'mtime'] as const
