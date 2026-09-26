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

import { requirePathsWritable } from '../../context/session_context.ts'
import { MountMode, type PathSpec } from '../../types.ts'
import type { MountEntry } from '../mount/mount.ts'

// The prefix governing a path no mount owns. Inside a workspace there is
// always one — Workspace synthesizes a root when no spec claims it — so a
// session statement about `/` (a `mounts: {"/": "read"}` cap, a
// mode-carrying show entry) is scored against that root and reaches
// `/toplink`. This constant is what remains when the registry has no root
// at all: a Dispatcher built outside a workspace.
export const BARE_PREFIX = '/'

/**
 * The prefix a namespace path is governed by.
 *
 * A node-table entry (a symlink, an attr overlay) is namespace state with
 * no backend behind it, but it lives at a path, and the mount whose
 * subtree holds that path is what a session statement about it is scored
 * against. Its lineage is therefore the same longest-prefix rule dispatch
 * resolves the path by, and the prefix is the whole of what the rule
 * needs: it is the key a profile's per-mount mode is written under.
 * Mirrors Python's `workspace/dispatcher/lineage.py`.
 */
export function turfOf(mount: MountEntry | null): string {
  if (mount === null) return BARE_PREFIX
  return mount.prefix
}

/**
 * Refuse a mutation outside the mount mode or session's grant.
 *
 * A symlink create, a link unlink or rename endpoint, and the no-mount
 * attr overlay all mutate namespace state at a path, and a session
 * handed a read-only view of that path must not reach any of them, or a
 * read-only grant would stop a file while waving its sibling link
 * through. Same voice as the backend gate: EROFS stamped with the
 * operand, so chokepoints render 'Read-only file system'.
 *
 * Mount mode is an authorization ceiling for both backend and namespace
 * writes. Backend capabilities are resolved only after admission.
 */
export function requireTurfWritable(mount: MountEntry | null, path: PathSpec): void {
  requirePathsWritable([path], turfOf(mount), mount?.mode ?? MountMode.WRITE)
}
