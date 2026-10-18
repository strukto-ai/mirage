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

import type { ByteSource, IOResult, OpReport } from '../io/types.ts'
import type { PathSpec, SetAttrFields } from '../types.ts'

/** The runtime metadata shared by routing and capability checks. */
export interface RuntimeIdentity {
  readonly name: string
  readonly captures: readonly string[]
}

/**
 * Where an interpreter command (python3, js) runs its code, as the line
 * placed it, and what policy lets that code start and load. Mirrors Python's
 * `CommandRuntime`, less its `unavailable`: TypeScript refuses a missing
 * runtime before the command runs.
 */
export interface CommandRuntime {
  /** The runtime the line bound the command to; absent when none is. */
  readonly bound?: RuntimeIdentity
  /** Whether policy lets the command start an interpreter. */
  readonly execAllowed: boolean
  /**
   * Whether policy lets an interpreter load code from a path; absent outside
   * a workspace, where `execAllowed` decides.
   */
  readonly execPathAllowed?: (virtual: string) => boolean
}

/**
 * The languages a runtime can interpret, one name for both entry points (run
 * and eval). A union, not string, so a typo is a type error instead of
 * a selector that silently matches nothing and reports "no runtime".
 */
export type RuntimeLanguage = 'python' | 'js'

/**
 * Which entry points code executed by a runtime has to the outside world.
 *
 * The workspace dispatch is a gate: it checks mount modes, session
 * grants, and policy, records the op, and only then touches the real
 * backend behind the mount (S3, disk, an API). Reach states whether
 * that gate is avoidable, not where bytes physically end up; a 'workspace'
 * write to an S3 mount still lands in real S3, but only after the
 * gate said yes.
 *
 * - 'workspace': the gate is the code's only entry point. The engine runs as an
 *   in-process guest with no syscalls, so its I/O can only travel the
 *   VFS bridge (or the workspace executor itself) and a mount-mode or
 *   policy refusal is final.
 * - 'process': the code has host entry points around the gate. It is, or
 *   spawns, a real process on this machine with the user's own
 *   filesystem and network, so it can reach the same backends (and
 *   everything else) without the gate seeing it.
 * - 'remote': the code runs on another machine and acts on that
 *   machine's world; the gate never sees those effects.
 */
export type RuntimeReach = 'workspace' | 'process' | 'remote'

/**
 * How a sandbox sees the workspace: `ssh` serves every prefix from the
 * host over SFTP, `fuse` leaves them to the sandbox's own mirage, and
 * `both` serves from the host what the sandbox does not mount itself.
 */
export type MountType = 'ssh' | 'fuse' | 'both'

/**
 * The workspace dispatch: run the function `name` against the mount
 * owning `path` and return its result with the accounting IOResult.
 * Defined here, on
 * the consumer side, because runtimes receive it through a binding while the
 * workspace provides it, and the runtime package imports no workspace
 * module — the home of Python's DispatchFn protocol (runtime/types).
 * `report`, when a caller passes one, is stamped by the dispatcher the moment
 * the op completes, so an observer reads what ran even when a later
 * step throws the result away; runtimes and combiners never pass it.
 */
export type DispatchFn = (
  name: string,
  path: PathSpec,
  args?: readonly unknown[],
  kwargs?: Record<string, unknown>,
  report?: OpReport,
) => Promise<[unknown, IOResult]>

/**
 * Run one shell line in the calling session and return its result, the
 * line reading the given input (null keeps the ambient one): the entry point a
 * command handler reaches the executor through, as awk's command pipes
 * and system() do. Defined beside DispatchFn for the same reason: the
 * consumer receives it, the workspace provides it.
 */
export type ShellFn = (line: string, stdin?: ByteSource | null) => Promise<IOResult>

/**
 * Per-op modifiers riding the bridge's attrs slot: setattr's fields,
 * stat's `nofollow` (the caller's lstat), mkdir's `parents`
 * (pathlib's mkdir(parents=True), forwarded to the backend op the way
 * python forwards it as a dispatch kwarg), and setxattr's `create` and
 * `replace` (XATTR_CREATE and XATTR_REPLACE).
 */
export type BridgeOpAttrs = SetAttrFields & {
  /** Check writable-open admission or stat's command path rules without backend I/O. */
  admitOnly?: boolean
  parents?: boolean
  create?: boolean
  replace?: boolean
  /** A ranged read, or where a pwrite lands: where it starts and how long it is. */
  offset?: number
  size?: number
  /** The length a truncate leaves. */
  length?: number
  /** A read of the stored bytes rather than a rendering. */
  raw?: boolean
  /** A read of what the backend holds now, past the file cache. */
  direct?: boolean
}

/**
 * The narrow bridge a sandboxed guest's file I/O rides: fixed op names,
 * string paths, positional payloads (the guest cannot build PathSpecs).
 *
 * `dst` carries a rename's destination, a symlink's target and an
 * extended attribute's name: each is the op's second string, and a link
 * target is stored verbatim rather than resolved, so there is nothing a
 * second slot would say. `bytes` carries setxattr's value and `attrs`
 * its create/replace flags beside every op's `nofollow`.
 */
export type BridgeDispatchFn = (
  op:
    | 'read'
    | 'write'
    | 'append'
    | 'pwrite'
    | 'readdir'
    | 'stat'
    | 'create'
    | 'truncate'
    | 'unlink'
    | 'mkdir'
    | 'rmdir'
    | 'rename'
    | 'symlink'
    | 'readlink'
    | 'setattr'
    | 'getxattr'
    | 'listxattr'
    | 'setxattr'
    | 'removexattr',
  path: string,
  bytes?: Uint8Array,
  dst?: string,
  attrs?: BridgeOpAttrs,
) => Promise<unknown>

/**
 * Live view of the workspace mount prefixes, read per run so mounts
 * added or removed after construction are always picked up.
 */
export type PrefixSource = () => string[]

/**
 * Live view of the link names one directory owns, read per listing so a
 * link created after construction is always seen.
 */
export type LinkChildrenSource = (directory: string) => Set<string>

/**
 * One program a language runtime runs, as it resolved it from its
 * operands: what the `Context` does not already carry. The runtime reads
 * the working directory, the environment, the interpreter switches, the
 * signal and the limit off `ctx`; this is the rest, the source and the
 * argv it found. Mirrors Python's `Program`.
 */
export interface Program {
  /** The source to run: a script's text, a `-c` payload, the program a `-m` runs, or piped stdin. */
  readonly code: string
  /** argv exposed to the program, argv[0] excluded. */
  readonly args: readonly string[]
  /**
   * argv[0]: the script as typed, `-c` for a CPython payload, the
   * installed head word of a script CLI; absent leaves the engine's own
   * spelling. '' is an answer (CPython's for a program piped in with no
   * operand).
   */
  readonly prog?: string
  /** The input left after any read as source. */
  readonly stdin: Uint8Array | null
  /** The script the program was read from, `rawPath` as typed. */
  readonly scriptPath?: PathSpec
  /** An installed script CLI, which also finds its argv and stdin as program globals. */
  readonly scriptCli?: boolean
}

/** Where a pipe's bytes go: a Node `Writable`, or anything with its two calls. */
export interface PipeWriter {
  write(data: Uint8Array): void
  end(): void
}

/** A command a sandbox runs with its stdin and stdout held open. */
export interface SandboxPipe {
  /** What the command writes. */
  readonly reader: ReadableStream<Uint8Array>
  /** What the command reads. */
  readonly writer: PipeWriter
  /** Ends the command. */
  stop(): Promise<void>
  /** Bounded startup diagnostics, when available. */
  diagnostic?(): Promise<string>
}

/** Outcome of one interpreter execution. */
export interface RunResult {
  stdout: Uint8Array
  /** Captured standard error, null when empty (mirrors Python). */
  stderr: Uint8Array | null
  exitCode: number
}

/**
 * What a caller asks of a runtime: run code in its language (`code`), a
 * whole shell line, `sh -c` with the line in `ctx.flags.c` (`line`), or a
 * program whose argv is the texts (`process`).
 */
export type ExecutionKind = 'code' | 'line' | 'process'

/** Where a streamed process's output goes, each write awaited before the next is read. */
export type OutputFn = (chunk: Uint8Array) => Promise<void>

/** Guest APIs for workspace files; policy and backend support still apply per operation. */
export type FilesystemOperation = 'read' | 'write' | 'list' | 'stat' | 'glob'

/** Derived execution support; reach remains a separate guarantee. */
export interface RuntimeCapabilities {
  readonly languages: readonly RuntimeLanguage[]
  readonly shell: boolean
  readonly process: boolean
  readonly reach: RuntimeReach
  readonly filesystem: readonly FilesystemOperation[]
}

/**
 * A program's source: a policy program or a script CLI.
 *
 * A yaml `script:` value references a `.py` or `.js`/`.mjs` file whose
 * content is embedded here at load; code passes the text. It runs as a
 * program on the runtime its config names, never edited.
 */
export class ScriptSource {
  /**
   * `language` names the script's language ("python" or "js"), stamped
   * from the file extension at config load; the programmatic default
   * is "python".
   *
   * `module` says the source is an ES module (a `.mjs` file), so a js
   * engine must run it in module mode or `import` and top-level
   * `await` fail. It is stamped from the extension at load beside
   * `language`, since the path is gone once the source is embedded.
   */
  constructor(
    readonly source: string,
    readonly language: RuntimeLanguage = 'python',
    readonly module = false,
  ) {}
}

/** One directory entry as the mounts report it. */
export interface VFSEntry {
  path: string
  size: number
  isDir: boolean
  // A namespace symlink. Marked so a guest walking a tree can skip it:
  // stat follows links, so a directory link would otherwise read as a
  // plain directory and a cyclic one would recurse the walk forever.
  isLink?: boolean
  // The stat's mode and stamp, absent on a row that carries no stat.
  // A backend that slash-marks its directories is listed without one,
  // which is the whole point of the mark, and so is an entry the
  // listing did not classify, so the row says "not known" rather than
  // inventing a default the guest cannot tell from an answer. A row
  // that did stat carries both, so a guest placing a directory's nodes
  // from one listing needs no second stat per file.
  mode?: number
  mtimeMs?: number
  // The access time and owner a stat reported, on the same rows.
  atimeMs?: number
  uid?: number
  gid?: number
  // Encoded logical major:minor; present only for a character device.
  rdev?: number
}

/** One path's metadata, in the shape every guest encoder needs. */
export interface VFSStat {
  size: number
  isDir: boolean
  // Milliseconds here and nanoseconds in python, on purpose: epoch
  // nanoseconds are past 2**53, so a number cannot hold them exactly.
  // Absent when the source reports none; a guest wire with no validity
  // channel spells that 0 at its own boundary.
  mtimeMs?: number
  // The full st_mode, type bits included, so a chmod the shell made is
  // what a guest's stat reports. A guest that has no mode field on its
  // own wire (preview1's filestat carries only a filetype) reads the
  // type bits and drops the rest. `isDir` and `isLink` are this
  // field's type bits spelled out; mode is the authority.
  mode: number
  // Only ever set for a stat the caller asked not to follow, since
  // every other answer is the target's.
  isLink?: boolean
  // Encoded logical major:minor; present only for a character device.
  rdev?: number
  // Access time, absent when the source reports none.
  atimeMs?: number
  // Numeric owner and group, absent when unknown or stored as a name.
  uid?: number
  gid?: number
}
