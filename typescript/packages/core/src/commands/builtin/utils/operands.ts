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

import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { closeQuietly } from '../../../io/stream.ts'
import { chunks } from '../../../io/cooperative.ts'
import type { LinkView, MountView, StatPath } from '../../../view/types.ts'
import type { FileStat, PathSpec, StatFn } from '../../../types.ts'
import { FileType } from '../../../types.ts'
import { eisdir, isDotWalkError, isFsError } from '../../../errors/fs.ts'
import { fsErrorLine } from '../../../errors/render.ts'
import { READ_FAILURES } from '../../../errors/constants.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import { compareCodePoints } from '../../../utils/sort.ts'
import { encodeText } from '../../../shell/bytes.ts'
import { concat } from '../../../utils/bytes.ts'

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
  stat: StatFn,
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
  stat: StatFn,
  cmdName: string,
): Promise<[PathSpec[], string]> {
  const order = await splitInOrder(paths, stat, cmdName)
  return [
    order.filter((p): p is PathSpec => typeof p !== 'string'),
    order.filter((p): p is string => typeof p === 'string').join(''),
  ]
}

/**
 * splitReadable's partition kept in operand order: each operand that reads,
 * or the stderr line of one that failed, where it stood, for inOrder to say
 * when the output reaches it. Mirrors Python's split_in_order.
 */
export async function splitInOrder(
  paths: readonly PathSpec[],
  stat: StatFn,
  cmdName: string,
): Promise<(PathSpec | string)[]> {
  const order: (PathSpec | string)[] = []
  for (const p of paths) {
    let st: FileStat
    try {
      st = await stat(p)
    } catch (e) {
      if (!isFsError(e)) throw e
      order.push(fsErrorLine(cmdName, p, e))
      continue
    }
    if (st.type === FileType.DIRECTORY) {
      order.push(fsErrorLine(cmdName, p, eisdir(p)))
      continue
    }
    order.push(p)
  }
  return order
}

/**
 * The parts' streams one after another, each bytes part a failed operand's
 * stderr line said on `io` when the output reaches it, as GNU reports an
 * operand and goes on (`cat a missing b`). A reader that stops early still
 * finds the lines it never reached on `io`, after what it read. Mirrors
 * Python's in_order.
 */
export async function* inOrder(
  parts: readonly (AsyncIterable<Uint8Array> | Uint8Array)[],
  io: IOResult,
): AsyncIterable<Uint8Array> {
  const lines = parts.filter((p): p is Uint8Array => p instanceof Uint8Array)
  let said = 0
  try {
    for (const part of parts) {
      if (part instanceof Uint8Array) {
        said++
        await say(io, part)
        continue
      }
      yield* part
    }
  } finally {
    if (said < lines.length) await say(io, concat(lines.slice(said)))
    for (const part of parts) {
      if (!(part instanceof Uint8Array)) await closeQuietly(part)
    }
  }
}

/**
 * `body` with each note, a stderr line and the offset in `body` it was
 * written before, said on `io` when the output reaches it, for a command that
 * renders all it prints before it prints (`wc a missing b`); `body` itself
 * when there is no note. Mirrors Python's at_offsets.
 */
export function atOffsets(
  body: Uint8Array,
  notes: readonly (readonly [number, Uint8Array])[],
  io: IOResult,
): ByteSource {
  if (notes.length === 0) return body
  const parts: (AsyncIterable<Uint8Array> | Uint8Array)[] = []
  let start = 0
  for (const [offset, line] of notes) {
    parts.push(chunks(body.subarray(start, offset)), line)
    start = offset
  }
  parts.push(chunks(body.subarray(start)))
  return inOrder(parts, io)
}

/**
 * splitInOrder for the commands that head each operand. GNU head and tail
 * open an operand before they read it, and a directory opens: its `==> name
 * <==` header prints and only the read after it fails. So a directory keeps
 * its place among the opened operands, its line said after its header, while
 * one that does not open at all (a missing name) leaves its line where it
 * stood, as splitInOrder does. Mirrors Python's split_opened.
 */
export async function splitOpened(
  paths: readonly PathSpec[],
  stat: StatFn,
  cmdName: string,
): Promise<[(PathSpec | string)[], Map<string, string>]> {
  const order: (PathSpec | string)[] = []
  const unread = new Map<string, string>()
  for (const p of paths) {
    let failure: unknown = null
    try {
      if ((await stat(p)).type === FileType.DIRECTORY) failure = eisdir(p)
    } catch (e) {
      if (!isFsError(e)) throw e
      failure = e
    }
    if (failure !== null) {
      const line = fsErrorLine(cmdName, p, failure)
      const code = (failure as { code?: string }).code
      if (code === undefined || !READ_FAILURES.has(code)) {
        order.push(line)
        continue
      }
      unread.set(p.virtual, line)
    }
    order.push(p)
  }
  return [order, unread]
}

/**
 * Each stderr line of a splitOpened partition by its operand's index, in
 * operand order: a command takes each as it says it, and says what is left
 * once its reader stops. Mirrors Python's operand_lines.
 */
export function operandLines(
  order: readonly (PathSpec | string)[],
  unread: ReadonlyMap<string, string>,
): Map<number, string> {
  const lines = new Map<number, string>()
  order.forEach((p, i) => {
    const line = typeof p === 'string' ? p : unread.get(p.virtual)
    if (line !== undefined && line !== '') lines.set(i, line)
  })
  return lines
}

/** Put an operand's stderr line on `io` after what it holds. Mirrors Python's say. */
export async function say(io: IOResult, line: Uint8Array | string): Promise<void> {
  io.stderr = concat([
    await materialize(io.stderr),
    typeof line === 'string' ? encodeText(line) : line,
  ])
}

// IOResult carrying operand-split stderr lines: exit 1 when any operand
// failed, exit 0 otherwise.
export function operandsIo(err: string): IOResult {
  return new IOResult({
    exitCode: err === '' ? 0 : 1,
    stderr: err === '' ? null : encodeText(err),
  })
}

// A one-shot stream over already-materialized bytes, for feeding buffered
// operands back through a stream transformer.
// eslint-disable-next-line @typescript-eslint/require-await
export async function* singleChunk(data: Uint8Array): AsyncIterable<Uint8Array> {
  if (data.byteLength > 0) yield data
}

/** Report a deferred filesystem error while allowing later operands. */
export async function* reportedStream(
  source: AsyncIterable<Uint8Array>,
  io: IOResult,
  path: PathSpec,
  cmdName: string,
): AsyncIterable<Uint8Array> {
  try {
    yield* source
  } catch (err) {
    if (!isFsError(err)) throw err
    await reportFsError(io, cmdName, path, err)
  }
}

/**
 * Report one operand's filesystem failure on a result whose output goes on:
 * its fsErrorLine lands after the stderr already there, and the exit code
 * becomes 1. Mirrors Python's report_fs_error.
 */
export async function reportFsError(
  io: IOResult,
  cmdName: string,
  path: PathSpec,
  err: unknown,
): Promise<void> {
  io.stderr = concat([await materialize(io.stderr), encodeText(fsErrorLine(cmdName, path, err))])
  io.exitCode = 1
}

/**
 * `each` over every operand in turn, or over stdin without one; a failed
 * operand's line (splitInOrder) is said where it stood. Mirrors Python's
 * per_operand.
 */
export function perOperand(
  paths: readonly (PathSpec | string)[],
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  stdin: ByteSource | null,
  io: IOResult,
  cmdName: string,
  each: (source: ByteSource) => AsyncIterable<Uint8Array>,
): AsyncIterable<Uint8Array> {
  if (paths.length === 0) return each(stdin ?? new Uint8Array())
  return inOrder(
    paths.map((p) =>
      typeof p === 'string' ? encodeText(p) : each(reportedStream(stream(p), io, p, cmdName)),
    ),
    io,
  )
}

/**
 * Put the split's lines before the output, as GNU's land when it holds its
 * output until it ends (`rev`, `tac`). Mirrors Python's errors_first.
 */
export async function errorsFirst(
  result: [ByteSource | null, IOResult],
  err: string,
): Promise<[ByteSource | null, IOResult]> {
  const [out, io] = result
  if (err === '') return result
  io.exitCode = 1
  if (out === null) {
    await say(io, err)
    return [null, io]
  }
  return [inOrder([encodeText(err), chunks(out)], io), io]
}
