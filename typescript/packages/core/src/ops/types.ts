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

import type { ShellArray } from '../shell/array.ts'
import type { FileStat } from '../types.ts'

export type StatOverlay = (path: string, stat: FileStat) => FileStat

// Stat one virtual path through the workspace rather than one backend, so
// a path under another mount still answers; null when nothing is there.
// What a traversal command asks about its own start point, which decides
// whether a walk is possible at all.
export type StatPath = (path: string) => Promise<FileStat | null>
// readdir one virtual path through the workspace rather than one backend.
// What a walker whose output is a single document (tree) reads once it
// reaches a mount boundary, since the subtree below it lives in another
// resource that the walker's own accessor cannot open.
export type ReaddirPath = (path: string) => Promise<string[]>

// The mount prefix serving a virtual path. A mount boundary is a filesystem
// boundary, which is where git stops looking for a repository
// (GIT_DISCOVERY_ACROSS_FILESYSTEM); crossing it would probe an unrelated
// backend.
export type MountRoot = (path: string) => string

// Child names the namespace owes a directory (mounts and links, mount
// names session-filtered). The other half of namespace structure beside
// link rows: a nested mount is invisible to the parent mount's backend,
// so a listing command is handed the names from above, the same names
// the door merges into its own readdir.
export type ChildMounts = (parent: string) => string[]

// Where the mount boundaries are, as one injected object.
//
// A command runs bound to one backend, and that backend cannot see a
// mount nested inside its own tree: the child's keys live in another
// resource entirely, so the parent's `readdir` never lists it. A walker
// that must account for the whole subtree therefore has to be told, the
// same way `LinkView` tells it about symlinks.
//
// Traversal commands that render independent lines (find, grep -r) get
// this for free from the executor's fan-out, which reruns them per mount
// and concatenates the output. A command whose output is one binary
// object (tar, zip) cannot be merged that way, so it reads the
// boundaries here and says what it did with them. du is in between: its
// lines concatenate, but its per-directory totals are sums that already
// counted the parent backend's shadowed keys by the time any line filter
// runs, so it reads the boundaries here too and excludes a descendant's
// subtree while accounting.
export interface MountView {
  // Mount roots strictly under a path (a walker: tar, zip).
  descendants(path: string): string[]
  // Whether a path is a mount root itself.
  isRoot(path: string): boolean
  // The mount serving a path, so a walker can tell "still mine" from
  // "another backend" before it tries to read something it cannot.
  rootOf(path: string): string
}

// The session-plane facts a command may consult, as one injected object.
//
// The `LinkView` pattern on the session plane: every method answers
// through the plane's own writers (`workspace/session/state.ts`), so
// reads arrive exactly as the shell sees them and writes clear readonly
// plus the `preSession` policy gate. The plain `env` opts field every
// command already receives stays the frozen process-view snapshot; this
// view is the live, gated handle for the command that needs one, and it
// is the whole capability: no member reaches the raw session behind it.
// Reads are sync ($X expansion grade); writes are async because they
// clear the gate.
export interface SessionView {
  // One variable's value, null when unset.
  get(name: string): string | null
  // A process-view copy of the whole environment.
  snapshot(): Record<string, string>
  // Write one variable through the session plane (readonly + preSession).
  // General over variable shapes: a string stores a scalar, a ShellArray
  // stores a whole array, and the door keeps the two storages exclusive.
  // Writers with richer mechanics (subscripts, appends, holes) compute
  // the resulting value on a copy and hand it here, so a denial never
  // leaves a half-applied write.
  set(name: string, value: string | ShellArray): Promise<void>
  // Drop one variable through the session plane; a missing name is quiet.
  unset(name: string): Promise<void>
  // Whether `readonly` has marked the name.
  isReadonly(name: string): boolean
}

// The symlink facts a command may consult, as one injected object.
//
// Symlinks live in the workspace namespace and no backend can see them,
// so a command that must report them has to be handed the facts from
// above. Bundling them means a command that grows a new symlink need
// does not also grow a new property on every call site between here and
// the generic; it reads another field off the view it already receives.
//
// Unlike python, no gating is needed: a command that does not read
// `links` off its context simply ignores the property.
export interface LinkView {
  // lstat one path (a link operand: `ls -l link`, `stat link`).
  statAt(path: string): FileStat | null
  // One directory level (a listing: `ls`, `ls -R` per group).
  children(directory: string): FileStat[]
  // The whole subtree (a walker: `find`, `du`).
  subtree(directory: string): [string, FileStat][]
  // Where a path really points, for deciding whether a link is broken.
  resolve(path: string): string
  // Whether anything is actually there, resolved through the workspace
  // rather than one backend, so a link across mounts answers correctly.
  exists(path: string): Promise<boolean>
  // What a link points at (`-L` reports the target's identity, not the
  // link's), null when it dangles or loops. Resolved through the
  // workspace too, for the same reason.
  targetStat(path: string): Promise<FileStat | null>
}

// The name plane's facts a command may consult, as one injected object.
//
// Everything here answers from the workspace's addressing authority (the
// namespace node table plus the mount table), which no backend can see:
// symlinks, mount boundaries, the chmod/chown/touch attr overlay, and the
// child names the namespace owes a directory. One view per plane means a
// command that grows a new name-plane need reads another field instead of
// threading a new keyword through `executeCmd` and every builder. A
// command opts in by reading `ns` off its opts; fields are absent when
// the plane has nothing to offer (no links, no overlay) or outside a
// workspace.
export interface NamespaceView {
  // The symlink facts; absent when the namespace holds no links, which
  // is the fast path a walker checks before merging.
  links?: LinkView
  // Where the mount boundaries are (tar, zip, du).
  mounts?: MountView
  // The namespace attr merge for stat-rendering commands (ls).
  statOverlay?: StatOverlay
  // Child names the namespace owes a directory (mounts and links).
  childMounts?: ChildMounts
}
