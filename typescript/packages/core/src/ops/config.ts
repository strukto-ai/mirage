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
// no stat surface (dispatch, the fs facade, FUSE) may rewrite their
// operand through the symlink table.
export const NO_FOLLOW_OPS: ReadonlySet<string> = new Set(['unlink', 'rename', 'rmdir'])

// The symlink surface a namespace offers to lower layers. The workspace
// Namespace satisfies this structurally; the fs facade and FUSE consume
// it through this seam so the dependency points downward (workspace
// injects, lower layers never import workspace modules).
export interface NamespaceLinks {
  // Resolve symlink prefixes in `path` (identity when none).
  follow(path: string): string
  // Whether `path` names a symlink entry.
  isLink(path: string): boolean
  // The stored target for a link path, null when not a link.
  readlink(path: string): string | null
  // Link basename to target for entries directly under a directory.
  linksUnder(directory: string): Map<string, string>
  // Create or overwrite a symlink entry; target is kept verbatim.
  symlink(link: string, target: string, mtime: number): Promise<void>
  // Drop a node entry; true when one existed.
  unlink(path: string): Promise<boolean>
}

export type StatOverlay = (path: string, stat: FileStat) => FileStat
