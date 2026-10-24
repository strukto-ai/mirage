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

import { type ShellValue, type VarAttr } from '../shell/variable.ts'
import type { IndexCacheStore } from '../cache/index/store.ts'
import type { FileStat, MountMode, PathSpec, SetAttrFields, Visibility } from '../types.ts'
import type { ByteSource, IOResult, OpReport } from '../io/types.ts'

/**
 * The keywords an op carries through the dispatcher: the mount's index, the
 * filetype a read resolves by (null asks for the stored bytes), and the
 * op's own (`offset`, `size`, `parents`, `no_create`, the setattr fields).
 */
export interface OpKwargs {
  index?: IndexCacheStore
  filetype?: string | null
  [k: string]: unknown
}

// Stat one virtual path through the workspace rather than one backend, so
// a path under another mount still answers; null when nothing is there.
// What a traversal command asks about its own start point, which decides
// whether a walk is possible at all.
export type StatPath = (path: string | PathSpec) => Promise<FileStat | null>
// readdir one virtual path through the workspace rather than one backend.
// What a walker whose output is a single document (tree) reads once it
// reaches a mount boundary, since the subtree below it lives in another
// VFS that the walker's own accessor cannot open.
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
// the dispatcher merges into its own readdir.
export type ChildMounts = (parent: string) => string[]
// The pathname resolution a command line gives its operands: every link
// above an operand's final name followed, and the final name too where
// the command follows it. A glob's matches take it as typed words would.
export type FollowOperands = (
  items: readonly (string | PathSpec)[],
) => Promise<(string | PathSpec)[]>

// Where the mount boundaries are, as one injected object.
//
// A command runs bound to one backend, and that backend cannot see a
// mount nested inside its own tree: the child's keys live in another
// VFS entirely, so the parent's `readdir` never lists it. A walker
// that must account for the whole subtree therefore has to be told, the
// same way `LinkView` tells it about symlinks.
//
// A walk that spans mounts (find, du over a nested mount) lets each mount's
// own command answer for its part and composes the parts (find's rows, du's
// measurement); ls -R runs once over the dispatcher, whose listings already
// name the mounts below. Each part, like any command bound to one backend
// (tar, zip, du -x), reads the boundaries here and says what it did with
// them: du excludes a descendant's subtree while accounting, since its
// totals would otherwise count the parent backend's shadowed keys.
//
// Two questions, two methods, because one name for both is what let a
// hidden mount reach a user. **Avoiding** a boundary needs every mount
// under the path, whatever the session can see: one it cannot see still
// shadows the parent backend's keys, and those keys must stay out of a
// walk's entries and a directory's total, or the size alone reports the
// subtree. **Naming** a boundary needs only the mounts the session may
// be told about: a member in an archive, a row in a tree, a "different
// filesystem" warning all hand back a name, and a hidden mount's name is
// the one thing the hide exists to withhold. A caller that needs both
// (`tar` prunes by one and warns by the other) reads both.
export interface MountView {
  // Every mount root strictly under a path, for a caller avoiding one.
  descendants(path: string): string[]
  // The ones this session may be told about, for a caller naming one.
  visibleDescendants(path: string): string[]
  // Whether a path is a mount root itself.
  isRoot(path: string): boolean
  // The mount serving a path, so a walker can tell "still mine" from
  // "another backend" before it tries to read something it cannot.
  rootOf(path: string): string
  // Whether the VFS serving a path answers the function `name` itself (the
  // dispatcher's name; `read_range` for a ranged read), so a command takes
  // its shortcut only where one stands. A walk through the dispatcher has no
  // mount to ask, and answers none.
  answers(path: string, name: string): boolean
  // The globs its search covers; null for every file.
  searchable(path: string): readonly string[] | null
  // The most files one command walks under a directory of the mount serving
  // a path (its VFS's `walkLimit`), -1 for no cap, so a walk that crosses
  // mounts charges each entry to its own backend.
  walkLimit?(path: string): number
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
  // stores a whole array, and the session view keeps the two storages exclusive.
  // Writers with richer mechanics (subscripts, appends, holes) compute
  // the resulting value on a copy and hand it here, so a denial never
  // leaves a half-applied write.
  // `followRef` (default true) resolves a `declare -n` reference to its
  // target first, which is what every ordinary assignment does;
  // `declare -n r=w` on an existing reference re-aims it and passes
  // false. `assigned` names the elements an array write assigns; the rest
  // are carried over as stored. `added` is an integer `+=`'s text, which
  // they evaluate after their held one.
  set(
    name: string,
    value: ShellValue,
    followRef?: boolean,
    assigned?: ReadonlySet<number | string> | null,
    added?: string | null,
  ): Promise<void>
  // Drop one variable through the session plane; a missing name is quiet.
  // `followRef` (default true) resolves a reference to its target;
  // `unset -n r` drops the reference itself and passes false.
  unset(name: string, followRef?: boolean): Promise<void>
  // Turn one attribute on or off through the session plane, or with a
  // null attribute declare the name and change nothing. Separate from
  // `set` because it writes no value: `export NAME`, `readonly NAME`
  // and a bare `local NAME` on a fresh name leave it *unset* and merely
  // declared, which is a state `set` cannot express. Gated all the same
  // -- a mark is a session write, so a hidden name refuses and
  // `preSession` rules. `followRef` is `set`'s: `declare -rn r` marks the
  // reference itself.
  mark(name: string, attr: VarAttr | null, on: boolean, followRef?: boolean): Promise<void>
  // Whether `readonly` has marked the name; `followRef` false asks about
  // a `declare -n` reference itself rather than its target.
  isReadonly(name: string, followRef?: boolean): boolean
  // The name of the profile the session runs under, null for an
  // unrestricted session. What an owner-rendering command (ls -l, stat
  // %g, find -printf %g) prints in the group column: the profile is the
  // permission set the session acts with, which is what a group is.
  profile(): string | null
  // The session's working directory, the one an operand resolves against.
  cwd(): string
  readonly sessionId: string
  // Its access and shell settings (hides, umask, shell options) as they stand.
  access(): SessionAccess
}

// The symlink surface a namespace offers to lower layers. The workspace
// Namespace satisfies this structurally; FUSE and the session's files
// consume it through this seam so the dependency points downward
// (workspace injects, lower layers never import workspace modules).
//
// Read-only, and the Python twin declares the same eight members in the
// same order. A link is created and removed through the dispatcher
// (`Files.symlink`, `Files.unlink`), never here: the dispatcher is the only layer
// that sees both planes, so it is where symlink(2)'s refusal to
// overwrite an occupied name is decided, and where session grants,
// admission policies and the op ledger fire. A mutator on this seam is
// a write at a layer no session view covers, which is how a
// session-scoped kernel mount came to delete a link on a mount its
// profile hides. Routing through the dispatcher costs a caller nothing: the
// dispatcher already answers `unlink` on a link path, because `unlink`
// is in `LINK_ENTRY_OPS`.
export interface NamespaceLinks {
  // Resolve symlink prefixes in `path` (identity when none).
  follow(path: string): string
  // `path` with every link above its final name followed, the walk a call
  // that acts on the name itself is given.
  followParent(path: string): string
  // Whether `path` names a symlink entry.
  isLink(path: string): boolean
  // The stored target for a link path, null when not a link.
  readlink(path: string): string | null
  // The link's own stat row (lstat), null when not a link. A link has no
  // backend inode, so this table is the only authority for one.
  linkStatAt(path: string): FileStat | null
  // Every link path to its stored target, the whole table.
  symlinkTargets(): ReadonlyMap<string, string>
  // Every link at any depth under `directory`, each with its own row, which a
  // walk that reads a subtree in one call merges in.
  linkStatsBelow(directory: string): [string, FileStat][]
  // The names of the links directly under `directory`, which a listing's
  // link marks need; a link prefix resolves first, as the listing does.
  linkNamesUnder(directory: string): Set<string>
}

// The symlink facts a command may consult, as one injected object.
//
// Symlinks live in the workspace namespace and no backend can see them,
// so a command that must report them has to be handed the facts from
// above. Bundling them means a command that grows a new symlink need
// does not also grow a new property on every call site between here and
// the generic; it reads another field off the view it already receives.
// Read off a command's files (`linksOf(opts)`).
export interface LinkView {
  // lstat one path (a link operand: `ls -l link`, `stat link`).
  statAt(path: string): FileStat | null
  // The links under a directory, which the dispatcher lists and reads with
  // the backend's own.
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

/**
 * Run one facade op as a session: `(sessionId, run) => result`, null
 * naming the workspace's default session as it is when the op runs.
 * The workspace supplies it, so the facade binds the session the way a
 * shell line does without holding the session manager itself. `run` is
 * handed the session the bind put in place, or null when it kept the
 * caller's ambient one, so the op can dispatch as that owner.
 */
export type SessionBind = <T>(
  sessionId: string | null,
  run: (bound: SessionAccess | null) => Promise<T>,
) => Promise<T>

/** The calling session's read-only access and shell settings. */
export interface SessionAccess {
  readonly sessionId: string
  readonly visibility: Visibility | null
  readonly umask: number
  readonly shopts: Readonly<Record<string, boolean>>
  readonly mountModes: ReadonlyMap<string, MountMode> | null
}

/** The public file operations a consumer uses, independent of the dispatcher. */
export interface FileView {
  readonly sessionId: string | null
  mountOf(path: string | PathSpec): string | null
  isMount(path: string | PathSpec): boolean
  submounts(path: string | PathSpec): string[]
  readonly dispatch: (
    name: string,
    path: string | PathSpec,
    args?: readonly unknown[],
    kwargs?: OpKwargs,
    report?: OpReport,
  ) => Promise<[unknown, IOResult]>
  read(
    path: string | PathSpec,
    options?: { raw?: boolean; offset?: number; size?: number | null; stream?: false },
    sessionId?: string,
  ): Promise<Uint8Array>
  read(
    path: string | PathSpec,
    options: { raw?: boolean; offset?: number; size?: number | null; stream: true },
    sessionId?: string,
  ): Promise<AsyncIterable<Uint8Array>>
  read(
    path: string | PathSpec,
    options: { raw?: boolean; offset?: number; size?: number | null; stream: boolean },
    sessionId?: string,
  ): Promise<Uint8Array | AsyncIterable<Uint8Array>>
  write(path: string | PathSpec, data: ByteSource | string, sessionId?: string): Promise<void>
  append(path: string | PathSpec, data: ByteSource, sessionId?: string): Promise<void>
  pwrite(
    path: string | PathSpec,
    data: Uint8Array,
    offset: number,
    sessionId?: string,
  ): Promise<void>
  readdir(path: string | PathSpec, sessionId?: string): Promise<string[]>
  stat(
    path: string | PathSpec,
    sessionId?: string,
    opts?: { nofollow?: boolean; fresh?: boolean },
  ): Promise<FileStat>
  exists(path: string | PathSpec, sessionId?: string): Promise<boolean>
  isDir(path: string | PathSpec, sessionId?: string): Promise<boolean>
  isFile(path: string | PathSpec, sessionId?: string): Promise<boolean>
  mkdir(path: string | PathSpec, sessionId?: string): Promise<void>
  create(path: string | PathSpec, sessionId?: string): Promise<void>
  symlink(path: string | PathSpec, target: string, sessionId?: string): Promise<void>
  readlink(path: string | PathSpec, sessionId?: string): Promise<string>
  setattr(
    path: string | PathSpec,
    attrs?: SetAttrFields,
    sessionId?: string,
  ): Promise<Record<string, number | string>>
  getxattr(
    path: string | PathSpec,
    name: string,
    opts?: { nofollow?: boolean },
    sessionId?: string,
  ): Promise<Uint8Array>
  listxattr(
    path: string | PathSpec,
    opts?: { nofollow?: boolean },
    sessionId?: string,
  ): Promise<string[]>
  setxattr(
    path: string | PathSpec,
    name: string,
    value: Uint8Array,
    opts?: { create?: boolean; replace?: boolean; nofollow?: boolean },
    sessionId?: string,
  ): Promise<void>
  removexattr(
    path: string | PathSpec,
    name: string,
    opts?: { nofollow?: boolean },
    sessionId?: string,
  ): Promise<void>
  truncate(path: string | PathSpec, length: number, sessionId?: string): Promise<void>
  unlink(path: string | PathSpec, sessionId?: string): Promise<void>
  rmdir(path: string | PathSpec, sessionId?: string): Promise<void>
  rename(src: string | PathSpec, dst: string | PathSpec, sessionId?: string): Promise<void>
  listFiles(path: string | PathSpec, sessionId?: string): Promise<string[]>
}
