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

import { IOResult, materialize } from '../../../io/types.ts'
import type { LinkView, MountView, StatPath } from '../../../ops/types.ts'
import { FileStat, FileType, PathSpec } from '../../../types.ts'
import { mountKey } from '../../../utils/key_prefix.ts'
import { eisdir, fsErrorLine, isEisdir, isFsError, isMissError } from '../../../utils/errors.ts'
import { readFailExitCode } from '../../spec/usage.ts'
import { resolvePath } from '../../../utils/path.ts'
import { stripSlash } from '../../../utils/slash.ts'

const ENC = new TextEncoder()

type Stat = (p: PathSpec) => Promise<FileStat>

// What a stat row's `name` should say for a path: the basename, or `/`
// for the workspace root, which is the spelling `namespaceStat` already
// uses for a namespace-only directory. Mirrors Python's `operand_name`,
// which takes a PathSpec because its one caller outside this module has
// one; here both callers hold the virtual string.
function operandName(virtual: string): string {
  const trimmed = virtual.replace(/\/+$/, '')
  const cut = trimmed.lastIndexOf('/')
  return trimmed.slice(cut + 1) || '/'
}

/**
 * Stat one operand the way a reporting command needs it.
 *
 * Two things no single backend stat can get right, both about paths that
 * are namespace structure rather than backend state:
 *
 * A path that only exists because mounts or links sit under it (`/repos`
 * when `/repos/alpha` is mounted) has no backend to answer for it, so the
 * backend stat throws and the operand reads as absent. `statPath` routes
 * through the dispatcher, which answers such a path from the namespace,
 * so it is asked second and only on a miss. Its row is already named from
 * the path.
 *
 * A mount root has a backend, but that backend names its own root rather
 * than the path: ram answers `/`, and disk answers the host directory's
 * basename, which leaks the path behind the mount. So the row is renamed
 * here, the way `ls` renames a child-mount row for the same reason.
 *
 * Mirrors Python `mirage.commands.builtin.utils.operands.operand_stat`.
 */
export async function operandStat(
  path: PathSpec,
  stat: Stat,
  statPath?: StatPath | null,
  mounts?: MountView | null,
  links?: LinkView | null,
): Promise<FileStat> {
  let row: FileStat
  try {
    row = await stat(path)
  } catch (e) {
    if (!isFsError(e)) throw e
    if (
      mounts?.visibleDescendants(path.virtual).length === 0 &&
      (links?.subtree(path.virtual).length ?? 0) === 0
    )
      throw e
    const fallback =
      statPath === undefined || statPath === null ? null : await statPath(path.virtual)
    if (fallback === null) throw e
    return fallback
  }
  if (mounts?.isRoot(path.virtual) === true) {
    return row.with({ name: operandName(path.virtual) })
  }
  return row
}

/**
 * Wrap a walker's readdir so a mount parent lists as empty, not absent.
 *
 * A directory that exists only because mounts sit under it has no backend
 * to list it, so the readdir throws and a recursive command reports the
 * operand missing even as the fan-out searches the mounts below it and
 * prints hits. Empty is the honest answer for the primary backend: the
 * directory is there, and it owns nothing in it.
 *
 * Empty rather than the mount names, because the fan-out already runs the
 * command once per descendant mount and concatenates. Listing them here
 * would search each one twice.
 *
 * The visible descendants, not every descendant. Answering at all tells
 * the session the directory is there, and a directory that exists only
 * because of a mount it may not be told about is a directory it may not be
 * told about either: a hidden mount under an otherwise absent parent has
 * to keep reading as absence, the same way the mount itself does.
 *
 * Only for an absence, which is why the catch is `isMissError` and not the
 * walk's own wider set: a directory the backend refused with EACCES or
 * ENOTSUP is there and holds data this run cannot read, and calling it
 * empty would let `grep -r` print the descendant mount's hits and exit 0
 * while silently omitting it. A refusal that is not absence keeps
 * propagating and gets reported.
 */
export function mountParentReaddir(
  readdir: (p: string) => Promise<string[]>,
  mounts?: MountView | null,
): (p: string) => Promise<string[]> {
  if (mounts === undefined || mounts === null) return readdir
  return async (p: string) => {
    try {
      return await readdir(p)
    } catch (e) {
      if (!isMissError(e)) throw e
      if (mounts.visibleDescendants(p).length === 0) throw e
      return []
    }
  }
}

/**
 * Wrap a walker's stat so a mount parent reports as a directory.
 *
 * The twin of `mountParentReaddir`, and the reason a recursive search over
 * `/repos` reported it missing while still printing hits from
 * `/repos/alpha`: the operand was statted before it was walked, the
 * primary backend has no such path, and the miss was reported as absence.
 *
 * The mount table decides, not the dispatcher. A dispatched stat would
 * answer for paths inside the descendant mounts too, which is exactly what
 * the primary run must not see: the fan-out searches each of them
 * separately, so claiming their entries here would search them twice.
 *
 * Visible descendants only, because a row is a disclosure: the parent of a
 * mount this session may not be told about stays absent, which is what
 * every other verb already answers there.
 *
 * An absence only, the same as its readdir twin: a backend that refused the
 * path rather than not having it is reporting something the run must not
 * paper over with a synthesized row.
 */
export function mountParentStat(
  stat: (p: string) => Promise<FileStat>,
  mounts?: MountView | null,
): (p: string) => Promise<FileStat> {
  if (mounts === undefined || mounts === null) return stat
  return async (p: string) => {
    try {
      return await stat(p)
    } catch (e) {
      if (!isMissError(e)) throw e
      if (mounts.visibleDescendants(p).length === 0) throw e
      return new FileStat({ name: operandName(p), type: FileType.DIRECTORY })
    }
  }
}

// True when any operand still carries a glob to expand. Backend push-down
// branches read paths[0] directly to build SQL, so they must not run before
// glob expansion: a pattern segment would be taken for a literal entity
// name, and tables/*/rows.jsonl would query a relation actually called "*".
export function hasUnresolvedGlob(paths: PathSpec[]): boolean {
  return paths.some((p) => p.pattern !== null && p.pattern !== '')
}

// Resolve a script operand (absolute or cwd-relative) to a fully-resolved
// PathSpec, the way python3/js locate a mounted script before running it.
export function resolveScript(name: string, cwd: string): PathSpec {
  const path = resolvePath(name, cwd)
  const lastSlash = path.lastIndexOf('/')
  const directory = lastSlash >= 0 ? path.slice(0, lastSlash + 1) : '/'
  return new PathSpec({ vfsPath: stripSlash(path), virtual: path, directory, resolved: true })
}

// Partition operands into readable paths and GNU stderr lines. Read-family
// commands (cat/head/tail/wc) process remaining operands after one fails,
// per GNU coreutils: each failed operand becomes one `<cmd>: <path>:
// <strerror>` line and the command exits 1 while still emitting output for
// the operands that resolved. Each path is stat'ed eagerly so a lazy output
// stream never aborts mid-drain on a missing operand. Non-filesystem errors
// keep propagating.
export async function splitReadable(
  paths: readonly PathSpec[],
  stat: Stat,
  cmdName: string,
): Promise<[PathSpec[], string]> {
  const readable: PathSpec[] = []
  let err = ''
  for (const p of paths) {
    let st: FileStat
    try {
      st = await stat(p)
    } catch (e) {
      if (!isFsError(e)) throw e
      err += fsErrorLine(cmdName, p, e)
      continue
    }
    if (st.type === FileType.DIRECTORY) {
      err += fsErrorLine(cmdName, p, eisdir(p))
      continue
    }
    readable.push(p)
  }
  return [readable, err]
}

export interface ReadOperand {
  path: PathSpec
  data: Uint8Array
}

// Read every operand eagerly, skipping the ones whose read fails with a
// filesystem error: each failed operand becomes one GNU stderr line and the
// remaining operands still process (the read-family rule). Lives inside the
// generics so every wrapper — factory builders and bespoke backend commands
// alike — inherits the behavior. Non-filesystem errors keep propagating.
// readOperands, plus the exit code the failures add up to. The code is the
// gzip family's, which is the only reason this variant exists: gzip reports a
// directory as a warning (2) and a missing file as an error (1), where every
// other command in the family answers the same number whichever failure is
// asked, so readOperands just drops this one.
//
// Its rule is not "the last failure wins". An error is recorded outright
// while a warning is recorded only when nothing has failed yet, so the error
// outranks the warning in either order: `zcat nope dir` and `zcat dir nope`
// are both 1, and only an invocation with no error at all (`zcat dir ok.gz`)
// is 2. That is gzip's own code: `progerror` assigns `exit_code = ERROR`
// unconditionally while the `WARN` macro assigns only `if (exit_code == OK)`
// (gzip 1.13, pinned on debian:stable-slim). A command whose rule is
// different again has to own its own loop: GNU sed takes the most severe
// code, and sedGeneric does that itself. The python twin is
// `split_readable_coded`, which sits on the stat-based split because python's
// zcat partitions there rather than on the read.
export async function readOperandsCoded(
  paths: readonly PathSpec[],
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  cmdName: string,
): Promise<[ReadOperand[], string, number]> {
  const ok: ReadOperand[] = []
  let err = ''
  let code = 0
  for (const p of paths) {
    try {
      ok.push({ path: p, data: await materialize(stream(p)) })
    } catch (e) {
      if (!isFsError(e)) throw e
      err += fsErrorLine(cmdName, p, e)
      // A directory is gzip's warning and everything else its error, so the
      // directory yields to a code already recorded.
      if (code === 0 || !isEisdir(e)) code = readFailExitCode(cmdName, e)
    }
  }
  return [ok, err, code]
}

export async function readOperands(
  paths: readonly PathSpec[],
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  cmdName: string,
): Promise<[ReadOperand[], string]> {
  const [ok, err] = await readOperandsCoded(paths, stream, cmdName)
  return [ok, err]
}

// IOResult carrying the readOperands stderr lines: exit `exitCode` when any
// operand failed, exit 0 otherwise. The default is 1, which is every GNU
// command in this family except the gzip one, whose code depends on the errno
// and which passes the number readOperandsCoded reports.
export function operandsIo(err: string, init?: { cache?: string[]; exitCode?: number }): IOResult {
  return new IOResult({
    ...(init?.cache !== undefined ? { cache: init.cache } : {}),
    exitCode: err === '' ? 0 : (init?.exitCode ?? 1),
    stderr: err === '' ? null : ENC.encode(err),
  })
}

// A one-shot stream over already-materialized bytes, for feeding buffered
// operands back through a stream transformer.
// eslint-disable-next-line @typescript-eslint/require-await
export async function* singleChunk(data: Uint8Array): AsyncIterable<Uint8Array> {
  if (data.byteLength > 0) yield data
}

// Default a command's path operands the way the shell would: explicit
// operands pass through, otherwise the session cwd becomes the single
// operand (keyed against the mount prefix when the caller knows it).
export function defaultPaths(paths: PathSpec[], cwd: string, mountPrefix = ''): PathSpec[] {
  if (paths.length > 0) return paths
  return [PathSpec.fromStrPath(cwd, mountKey(cwd, mountPrefix))]
}
