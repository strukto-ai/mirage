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
import type { LinkView, MountView, StatPath } from '../../../doors/types.ts'
import type { FileStat, PathSpec } from '../../../types.ts'
import { FileType } from '../../../types.ts'
import { eisdir, isDotWalkError, isEisdir, isFsError } from '../../../errors/fs.ts'
import { fsErrorLine } from '../../../errors/render.ts'
import { READ_FAILURES } from '../../../errors/constants.ts'
import { readFailExitCode } from '../../spec/usage.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import { compareCodePoints } from '../../../utils/sort.ts'
import { encodeText } from '../../../shell/bytes.ts'

type Stat = (p: PathSpec) => Promise<FileStat>

// What a stat row's `name` should say for a path: the basename, or `/`
// for the workspace root, which is the spelling `namespaceStat` already
// uses for a namespace-only directory. Mirrors Python's `operand_name`,
// which takes a PathSpec because its one caller outside this module has
// one; here both callers hold the virtual string.
export function operandName(virtual: string): string {
  const trimmed = rstripSlash(virtual)
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
    // An operand that did not resolve is answered by no namespace
    // structure under the path it simplifies to.
    if (!isFsError(e) || isDotWalkError(e)) throw e
    if (
      mounts?.visibleDescendants(path.virtual).length === 0 &&
      (links?.subtree(path.virtual).length ?? 0) === 0
    )
      throw e
    const fallback = statPath === undefined || statPath === null ? null : await statPath(path)
    if (fallback === null) throw e
    return fallback
  }
  if (mounts?.isRoot(path.virtual) === true) {
    return row.with({ name: operandName(path.virtual) })
  }
  return row
}

/**
 * The mount roots a walk of `directory` reaches first, sorted: the edge of
 * the directory's own filesystem, so a mount nested in a mount is not one
 * of them. Mirrors Python's mount_points.
 */
export function mountPoints(mounts: MountView | null | undefined, directory: string): string[] {
  if (mounts === undefined || mounts === null) return []
  const roots = mounts.visibleDescendants(directory)
  return roots
    .filter((root) => !roots.some((other) => root.startsWith(`${other}/`)))
    .sort(compareCodePoints)
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

/**
 * splitReadable for the commands that head each operand. GNU head and tail
 * open an operand before they read it, and a directory opens: its `==> name
 * <==` header prints and only the read after it fails. So a directory keeps
 * its place among the opened operands, named in the unread set, while one
 * that does not open at all (a missing name) is dropped as splitReadable
 * drops it. Mirrors Python's split_opened.
 */
export async function splitOpened(
  paths: readonly PathSpec[],
  stat: Stat,
  cmdName: string,
): Promise<[PathSpec[], ReadonlySet<string>, string]> {
  const opened: PathSpec[] = []
  const unread = new Set<string>()
  let err = ''
  for (const p of paths) {
    let failure: unknown = null
    try {
      if ((await stat(p)).type === FileType.DIRECTORY) failure = eisdir(p)
    } catch (e) {
      if (!isFsError(e)) throw e
      failure = e
    }
    if (failure !== null) {
      err += fsErrorLine(cmdName, p, failure)
      const code = (failure as { code?: string }).code
      if (code === undefined || !READ_FAILURES.has(code)) continue
      unread.add(p.virtual)
    }
    opened.push(p)
  }
  return [opened, unread, err]
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
export function operandsIo(err: string, init?: { exitCode?: number }): IOResult {
  return new IOResult({
    exitCode: err === '' ? 0 : (init?.exitCode ?? 1),
    stderr: err === '' ? null : encodeText(err),
  })
}

// A one-shot stream over already-materialized bytes, for feeding buffered
// operands back through a stream transformer.
// eslint-disable-next-line @typescript-eslint/require-await
export async function* singleChunk(data: Uint8Array): AsyncIterable<Uint8Array> {
  if (data.byteLength > 0) yield data
}
