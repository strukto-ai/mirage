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

import type { FileStat } from '../types.ts'

// Ops with lstat semantics: they act on the entry named by the path, so
// no stat surface (dispatch, the op facade, FUSE) may rewrite their
// operand through the symlink table.
export const NO_FOLLOW_OPS: ReadonlySet<string> = new Set([
  'unlink',
  'rename',
  'rmdir',
  'symlink',
  'readlink',
])

// Content-writing ops whose completion stamps an observed mtime on the
// namespace node (removals invalidate but must not stamp).
export const STAMP_WRITE_OPS: ReadonlySet<string> = new Set([
  'write',
  'write_bytes',
  'append',
  'create',
  'truncate',
  'mkdir',
])

// The symlink surface a namespace offers to lower layers. The workspace
// Namespace satisfies this structurally; the op facade and FUSE consume
// it through this seam so the dependency points downward (workspace
// injects, lower layers never import workspace modules).
//
// Read-only, and the Python twin declares the same five members in the
// same order. A link is created and removed through the op door
// (`Ops.symlink`, `Ops.unlink`), never here: the door is the only layer
// that sees both planes, so it is where symlink(2)'s refusal to
// overwrite an occupied name is decided, and where session grants,
// admission policies and the op ledger fire. A mutator on this seam is
// a write at a layer no session view covers, which is how a
// session-scoped kernel mount came to delete a link on a mount its
// profile hides. Routing through the door costs a caller nothing: the
// dispatcher already answers `unlink` on a link path, because `unlink`
// is in `LINK_ENTRY_OPS`.
export interface NamespaceLinks {
  // Resolve symlink prefixes in `path` (identity when none).
  follow(path: string): string
  // Whether `path` names a symlink entry.
  isLink(path: string): boolean
  // The stored target for a link path, null when not a link.
  readlink(path: string): string | null
  // The link's own stat row (lstat), null when not a link. A link has no
  // backend inode, so this table is the only authority for one.
  linkStatAt(path: string): FileStat | null
  // Every link path to its stored target, the whole table.
  symlinkTargets(): Map<string, string>
}
