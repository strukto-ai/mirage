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

import type { NamespaceView } from '../../../../doors/types.ts'
import { type PathSpec, type FileStat } from '../../../../types.ts'
import type { DispatchFn } from '../../../../runtime/types.ts'
import type { Zone } from '../../../../utils/timezone.ts'
import type { CLIInvocation } from '../../types.ts'
import type { GitError } from './errors.ts'

/**
 * The workspace op dispatcher, as every module here consumes it.
 *
 * PathSpec-typed and tuple-returning, which is the dispatcher's own contract
 * rather than the Workspace facade's: a CLI leaf is handed the same callable a
 * mount command receives.
 */
export type Dispatch = DispatchFn

/**
 * A resolved repository: where the objects live, and over what.
 *
 * `gitdir` and `worktree` are separate for the same reason they are in git: the
 * two need not be nested, and a bare repository has no worktree at all.
 *
 * `commondir` is the third: a linked worktree (`git worktree add`) gets its own
 * gitdir holding HEAD and the index, while the object database, packed-refs and
 * branches stay in the repository it was cut from. The two are the same
 * directory for an ordinary checkout, which is why one field carried both until
 * worktrees turned up.
 */
export interface RepoLocation {
  /** This checkout's git directory, which holds HEAD and the index. */
  readonly gitdir: PathSpec
  /**
   * The shared git directory, which holds objects and branches. Equal to
   * `gitdir` unless this is a linked worktree.
   */
  readonly commondir: PathSpec
  /** The working tree root. */
  readonly worktree: PathSpec
  /** The mount prefix both live under, which bounded the discovery walk. */
  readonly mountRoot: PathSpec
  readonly ns?: NamespaceView | null
}

/** What HEAD points at: a branch, some other ref, or a raw commit. */
/** A branch's configured upstream, and how far the two have moved. */
export interface Upstream {
  /** The upstream as git names it, `origin/main` or a local branch. */
  readonly label: string
  /** Commits on the branch the upstream lacks. */
  readonly ahead: number
  /** Commits on the upstream the branch lacks. */
  readonly behind: number
  /** The upstream ref is configured but missing. */
  readonly gone: boolean
}

/**
 * `branch.autoSetupMerge`: the start points that give a new branch an
 * upstream. Each member is spelled as the config value that picks it: `true`
 * takes a remote-tracking start point, `always` a local branch too, `simple` a
 * remote one of the same name, `inherit` copies the start branch's own
 * upstream, and `false` takes none.
 */
export enum Track {
  OFF = 'false',
  REMOTE = 'true',
  ALWAYS = 'always',
  SIMPLE = 'simple',
  INHERIT = 'inherit',
}

export interface HeadRef {
  /** Short branch name when HEAD is a symbolic ref under `refs/heads`. */
  readonly branch: string | null
  /** The full ref name HEAD names, null when detached. */
  readonly ref: string | null
  /** The object id HEAD holds directly, set only on a detached HEAD. */
  readonly commit: string | null
}

/**
 * What moving HEAD carried across, and what it could not do.
 *
 * Two things rather than one because git writes both: the paths whose
 * uncommitted change survived the move go to stdout with their status letters,
 * and a submodule directory the move could not remove is a warning on stderr
 * above the line saying the branch changed.
 */
export interface HeadMove {
  /** Each path whose uncommitted change was carried across, by status letter. */
  readonly carried: ReadonlyMap<string, string>
  /** The warning lines to write before the note, empty when there are none. */
  readonly warnings: string
}

/**
 * One object id with the type git records for it.
 *
 * The pair travels together because a revision that names a tree or a blob is
 * as legal as one that names a commit wherever an object is wanted, and the
 * type is what a tag records about its target.
 */
export interface GitObject {
  readonly oid: string
  readonly type: string
}

/** One `~` or `^` suffix of a revision. */
export interface AncestryStep {
  /**
   * True for `~n` (walk n generations along first parents), false for `^n`
   * (take the n-th parent).
   */
  readonly firstParent: boolean
  /** The number after the suffix, 1 when it was bare. */
  readonly count: number
}

/** One `^{<type>}` suffix of a revision. */
export interface PeelStep {
  /** The type word inside the braces, empty for `^{}`. */
  readonly want: string
}

/** One operator of a revision, in the order git applies them. */
export type RevOp = AncestryStep | PeelStep

/**
 * One entry of `.git/index`.
 *
 * The stat fields are what git calls the stat cache; zeroing them means "do not
 * trust it", which is safe. A zeroed `size` is therefore read as "not stated"
 * rather than "empty", which is what lets a restored entry carry no length.
 */
export interface IndexEntry {
  readonly path: string
  readonly oid: string
  readonly mode: number
  readonly size: number
  /** 1, 2 or 3 for a conflicted entry; 0 for an ordinary one. */
  readonly stage: number
}

/** Whichever of the three merge stages a conflicted path has. */
export interface ConflictedEntry {
  readonly ancestor: IndexEntry | null
  readonly this: IndexEntry | null
  readonly other: IndexEntry | null
}

/**
 * What `.git/index` says, split by whether a path is in conflict.
 *
 * Conflicted paths are carried apart rather than dropped, because a dropped one
 * reads as unmodified: the file would compare equal to nothing and vanish from
 * the report while git is refusing to commit because of it.
 */
export interface IndexState {
  /** Staged content, keyed by repository-relative path. */
  readonly entries: Map<string, IndexEntry>
  /** Paths left unmerged, each holding whichever of the three stages exist. */
  readonly conflicts: Map<string, ConflictedEntry>
  /**
   * Whether `MERGE_HEAD` is present, which is what distinguishes a merge in
   * progress from its leftovers.
   */
  readonly merging: boolean
}

/**
 * One path's status, in the two columns git reports it in.
 *
 * The pair is git's own model, not a convenience: the left column is HEAD
 * against the index and the right is the index against the working tree, so a
 * file edited, staged, then edited again is `MM` and appears in both sections of
 * the long format. Collapsing the two into one verdict is what makes a status
 * report unable to say that.
 */
export interface StatusEntry {
  /** Repository-relative path. */
  readonly path: string
  /** The left column, one character. */
  readonly indexStatus: string
  /** The right column, one character. */
  readonly treeStatus: string
  /** The path renamed from, set only for `R`. */
  readonly original: string | null
}

/** What one walk of the working tree found. */
export interface WorkTree {
  /**
   * Every non-ignored file that is not under an untracked collapsed directory,
   * mapped to what the mount said about it. The whole stat is kept rather than
   * the size alone because the comparison reads the mode too, and the walk has
   * already paid for it.
   */
  readonly files: Map<string, FileStat>
  /** Paths to report as untracked, already collapsed to `dir/` where git would. */
  readonly untracked: string[]
  readonly ignored: string[]
}

/** One `.mailmap` line: the identity it matches and what it maps to. */
export interface MailmapEntry {
  /** The recorded email it matches, lowercased. */
  readonly email: string
  /** The recorded name it also requires, lowercased; null for email alone. */
  readonly name: string | null
  /** The canonical name, null to keep the recorded one. */
  readonly mappedName: string | null
  /** The canonical email, null to keep the recorded one. */
  readonly mappedEmail: string | null
}

/** One of git's date styles, spelled as `--date` names it. */
export enum DateKind {
  NORMAL = 'default',
  RELATIVE = 'relative',
  SHORT = 'short',
  ISO8601 = 'iso8601',
  ISO8601_STRICT = 'iso8601-strict',
  RFC2822 = 'rfc2822',
  HUMAN = 'human',
  RAW = 'raw',
  UNIX = 'unix',
  STRFTIME = 'format',
}

/** A parsed `--date` value, with the clock it is rendered against. */
export interface DateMode {
  readonly kind: DateKind
  /** The `-local` suffix: show the time in the session's zone. */
  readonly local: boolean
  /** The `format:` template, empty otherwise. */
  readonly strftime: string
  /** The moment `relative` and `human` count from, epoch seconds. */
  readonly now: number
  /** The session's `TZ`, null for the host's own zone. */
  readonly zone: Zone | null
}

/**
 * git's refusal for a verb a read-only mount turned down, built from the line
 * and the repository it opened, null when it opened none.
 */
export type ReadOnlyRefusal = (inv: CLIInvocation, location: RepoLocation | null) => GitError

/** Where a chain of symbolic refs ends: the last name reached, and whether any hop was symbolic. */
export interface SymbolicEnd {
  readonly name: string
  readonly symbolic: boolean
}

/**
 * How `log` and `show` label a commit with the refs that point at it, git's
 * decoration style: not at all, by short names, or by full ref names.
 */
export enum Decoration {
  NONE = 'no',
  SHORT = 'short',
  FULL = 'full',
}

/** How a ref field sorts, git's `cmp_type`: as text, or by the number behind it. */
export enum FieldCompare {
  TEXT = 'text',
  NUMBER = 'number',
  TIME = 'time',
}

/**
 * Where a ref field's value comes from, git's `info_source`: the ref alone, the
 * object's content, or its type and size.
 */
export enum FieldSource {
  REF = 'ref',
  OBJECT = 'object',
  OBJECT_INFO = 'object-info',
}

/** `--shell`, `--perl`, `--python` and `--tcl`: how each field is quoted. */
export enum QuoteStyle {
  NONE = 'none',
  SHELL = 'shell',
  PERL = 'perl',
  PYTHON = 'python',
  TCL = 'tcl',
}

/** Which part of the namespace a listed ref lives in. */
export enum RefKind {
  BRANCH = 'branch',
  REMOTE = 'remote',
  TAG = 'tag',
  DETACHED = 'detached',
  ROOT = 'root',
  OTHER = 'other',
}

/** One `%(...)` field of a ref format or a sort key, parsed. */
export interface RefField {
  /** The field as typed, its `*` and arguments included. */
  readonly name: string
  /** The field's own name, e.g. `refname`. */
  readonly field: string
  /** The `*` prefix: read the object a tag peels to. */
  readonly deref: boolean
  /** The text after the first `:`, null when there is none or it is empty. */
  readonly arg: string | null
  readonly compare: FieldCompare
  readonly source: FieldSource
  /** The argument the field's parser settled on, e.g. `short` or `lstrip`. */
  readonly option: string
  /** The count an option carries (`lstrip=2`, `short=10`, an `align` width). */
  readonly number: number
  /** The flags a list argument set, e.g. an email's `trim` and `mailmap`. */
  readonly words: ReadonlySet<string>
  /**
   * A second word an option carries: an `if` comparand, an `align` position,
   * or the refname option an upstream field shows its ref with.
   */
  readonly text: string
}

/** A `--format` string, parsed once for every ref it renders. */
export interface RefFormat {
  /** Literal text, escapes already expanded, and fields, in order. */
  readonly pieces: readonly (string | RefField)[]
  readonly quote: QuoteStyle
}

/** One `--sort` key. */
export interface RefSortKey {
  readonly field: RefField
  /** The leading `-`. */
  readonly reverse: boolean
  /** The `version:` (`v:`) prefix. */
  readonly version: boolean
}

/** An object as ref fields read it: its id, type and content. */
export interface RefObject {
  readonly oid: string
  readonly type: string
  readonly raw: Uint8Array
}

/** A branch's upstream as the `upstream` field reads it. */
export interface RefUpstream {
  /** The remote-tracking (or local) ref it follows. */
  readonly ref: string
  /** `branch.<name>.remote`. */
  readonly remote: string
  /** `branch.<name>.merge`. */
  readonly merge: string
  readonly ahead: number
  readonly behind: number
  /** The upstream ref does not exist. */
  readonly gone: boolean
}

/** One listed ref, with what its fields are read from. */
export interface RefItem {
  /** The full ref name, `HEAD` for a detached HEAD. */
  readonly name: string
  /** The object the ref resolves to. */
  readonly oid: string
  readonly kind: RefKind
  /** The ref a symbolic ref points at. */
  readonly symref: string | null
  /** The object, when a field reads it. */
  readonly obj: RefObject | null
  /** What a tag peels to, when a `*` field reads it. */
  readonly peeled: RefObject | null
  /** A branch's upstream, when an `upstream` field reads it. */
  readonly upstream: RefUpstream | null
  /** The worktree a branch is checked out in. */
  readonly worktree: string
}

/** What a ref's fields read beyond the ref itself, once per listing. */
export interface RefContext {
  /** Every name that resolves, which decides whether a short name is ambiguous. */
  readonly known: ReadonlySet<string>
  /**
   * `core.warnAmbiguousRefs`: a short name is ambiguous if any other rule finds
   * a ref under it, not only an earlier one.
   */
  readonly strict: boolean
  /** The ref HEAD resolves to, `HEAD` when detached, null when it names nothing. */
  readonly head: string | null
  /** How a detached HEAD row names itself, e.g. `(HEAD detached at 1a2b3c4)`. */
  readonly headDescription: string
  /** How many hex digits a short id keeps. */
  readonly abbrev: number
  /** Minimum unique widths for the object ids abbreviated by this listing. */
  readonly abbreviations: ReadonlyMap<string, number>
  /** For the `mailmap` options. */
  readonly mailmap: readonly MailmapEntry[]
  /** The clock date fields render by. */
  readonly date: DateMode
  /** `versionsort.suffix`. */
  readonly suffixes: readonly string[]
}

/** A field's value for one ref: what it renders as, and what it sorts by as a number. */
export interface FieldValue {
  readonly text: string
  readonly number: number
}

/** One open block while a ref format renders: the whole row, an `%(align)` or an `%(if)`. */
export interface FormatFrame {
  readonly kind: 'root' | 'align' | 'if'
  /** The `align` or `if` field. */
  readonly opener: RefField | null
  /** What the block has rendered so far. */
  out: string[]
  /** An `if` block reached its `%(then)`. */
  thenSeen: boolean
  /** What its condition came to. */
  satisfied: boolean
  /** For the `%(else)` half of an `if`, the `if` it belongs to. */
  readonly head: FormatFrame | null
}

/** One `[+]<src>[:<dst>]` refspec. */
export interface Refspec {
  /** The remote ref, or a pattern with one `*`. */
  readonly src: string
  /** The local ref it lands in, null for FETCH_HEAD alone. */
  readonly dst: string | null
  /** The leading `+`, which allows a non-fast-forward. */
  readonly force: boolean
}
