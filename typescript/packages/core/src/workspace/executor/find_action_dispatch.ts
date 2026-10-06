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

import { compareCodePoints } from '../../utils/sort.ts'
import { contentSize } from '../../utils/stat_view.ts'
import { resolvePath } from '../../utils/path.ts'
import { enoent, gnuStrerror } from '../../utils/errors.ts'
import { failureText } from '../../errors/classify.ts'
import { formatFindLs } from '../../commands/builtin/utils/formatting.ts'
import {
  expandPrintf,
  printfKind,
  printfNeedsStat,
  type PrintfStatFacts,
} from '../../commands/builtin/find_printf.ts'
import { modifiedTs } from '../../core/generic/find.ts'
import type { Identity } from '../../commands/builtin/utils/identity.ts'
import { PolicyDenied } from '../../policy/errors.ts'
import { shellJoin } from '../../shell/join.ts'
import { type ByteSource, materialize } from '../../io/types.ts'
import { getCurrentSession, runAsProgram } from '../../context/session_context.ts'
import { type FileStat, type PathSpec, FileType } from '../../types.ts'
import type { MountRegistry } from '../mount/registry.ts'
import { SHELL_ONLY_BUILTINS } from '../lookup/constants.ts'
import { lookupAll } from '../lookup/lookup.ts'
import { Consumer } from '../lookup/types.ts'
import type { NamespaceView, StatPath } from '../../ops/types.ts'
import { SharedStdin } from '../../io/stream.ts'
import {
  execActions,
  type FindExpr,
  parseFindExpression,
} from '../../commands/builtin/find_parse.ts'
import { EXEC_PLACEHOLDER } from '../../commands/builtin/constants.ts'
import type { ExecAction, FindAction, PrintfAction } from '../../commands/builtin/types.ts'
import type { ExecuteFn } from '../expand/node.ts'
import type { DispatchFn } from '../../runtime/types.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { concat } from '../../io/cachable_iterator.ts'
import { encodeText } from '../../shell/bytes.ts'

export interface FindActionDoors {
  // Runs an `-exec` line in the session; absent outside a workspace,
  // where `-exec` is refused.
  executeFn?: ExecuteFn
  sessionId?: string
  // The invocation's abort, checked between matches so a cancelled
  // `-delete` or `-exec` stops at the next row instead of the last one.
  signal?: AbortSignal
  // The name plane's facts, threaded into the -ls sub-dispatch so a
  // namespace-only row (a mount point, a symlink) renders the way
  // `ls -l` renders it.
  ns?: NamespaceView | null
  // Dispatcher stat, threaded with it and used to find a
  // slash-carrying `-exec` head.
  statPath?: StatPath | null
  // The op dispatcher a `-delete` unlinks a symlink row through, since
  // the row is namespace state no mount's `rm` can reach.
  dispatch?: DispatchFn | null
  // Who the session is, for the owner and group columns of `-ls`.
  identity?: Identity | null
  // find's own input, which its `-exec` children share as one cursor, as
  // GNU's do (a pipe feeds one reader, and a child that never reads leaves
  // it for the next).
  stdin?: ByteSource | null
  /** The start operands, whose rows GNU statted when it opened the
   * walk; empty means the working directory. */
  readonly starts?: readonly PathSpec[]
}

/**
 * The shell line one `-exec` run becomes. GNU execs the words directly, so
 * every match must reach the command as exactly one argv word: the line is
 * built with `shellJoin`, and a plain join would be re-parsed by the shell.
 * A per-match run substitutes every `{}` inside every word (`x{}y` is
 * `xd/a.txty`); a batched run replaces its one bare `{}` with the matches,
 * one word each.
 */
/**
 * The argv one `-exec` run becomes, matches substituted: a per-match run
 * substitutes every `{}` inside every word (`x{}y` is `xd/a.txty`), a
 * batched run replaces its one bare `{}` with the matches, one word
 * each. The head is substituted like any other word, which is what lets
 * `-exec {} \;` run each match itself.
 */
export function execWords(action: ExecAction, paths: readonly string[]): string[] {
  const words: string[] = []
  for (const word of action.argv) {
    if (action.batch && word === EXEC_PLACEHOLDER) words.push(...paths)
    else if (!action.batch) words.push(word.replaceAll(EXEC_PLACEHOLDER, paths[0] ?? ''))
    else words.push(word)
  }
  return words
}

/**
 * Whether `execvp` would fail to find an `-exec` head word, and whether
 * a shell function shadows the program it would find. A head carrying a
 * slash is a file the loader runs, which no builtin, function or CLI can
 * claim, so it is statted where the line would read it; any other head
 * is looked up by name across the layers dispatch consults. Outside a
 * workspace there is no stat and the loader answers for itself.
 */
async function headState(
  head: string,
  registry: MountRegistry,
  cwd: string,
  statPath: StatPath | null,
): Promise<[boolean, boolean]> {
  if (head.includes('/')) {
    return [statPath !== null && (await statPath(resolvePath(head, cwd))) === null, false]
  }
  const sess = getCurrentSession()
  // A shell function is not found either, nor a builtin that is the
  // shell's own: GNU execs the head through execvp, which sees programs
  // and nothing the shell defined, so `f(){ :; }; find d -exec f {} \;`
  // and `find d -exec cd {} \;` report `No such file or directory` per
  // match while `-exec echo` or `-exec sh -c` runs (SHELL_ONLY_BUILTINS
  // names the shell's own). Every layer is asked, not the winner: execvp
  // never sees the function `cat(){ ...; }` defines, so `-exec cat` still
  // finds the program, and the run bypasses the function the way
  // `command` does.
  if (sess === null) return [false, false]
  const layers = lookupAll(head, sess, registry)
  const program = layers.some(
    (layer) =>
      layer !== Consumer.FUNCTION && (layer !== Consumer.SESSION || !SHELL_ONLY_BUILTINS.has(head)),
  )
  // An alias is as invisible to execvp as a function, and `command` masks
  // both for the run.
  const shadowed = layers.includes(Consumer.FUNCTION) || head in sess.aliases
  return [!program, shadowed]
}

async function runExec(
  executeFn: ExecuteFn,
  sessionId: string,
  registry: MountRegistry,
  cwd: string,
  statPath: StatPath | null,
  action: ExecAction,
  paths: readonly string[],
  out: Uint8Array[],
  errors: Uint8Array[],
  stdin: SharedStdin | null,
): Promise<boolean> {
  // GNU substitutes the matches into the words and only then hands them
  // to execvp, so the head looked up is the substituted one: `-exec {}
  // \;` runs each match itself.
  const words = execWords(action, paths)
  const head = words[0] ?? action.argv[0] ?? ''
  const [missing, shadowed] = await headState(head, registry, cwd, statPath)
  if (missing) {
    errors.push(encodeText(`find: '${head}': No such file or directory\n`))
    return false
  }
  // A function or alias of the head's name is invisible to execvp, so the
  // line runs the program past it, as `command` does. The run is marked a
  // program run for the session, so a builtin that doubles as a program
  // answers as the program (`printf -v` is a format).
  const line = (shadowed ? 'command ' : '') + shellJoin(words)
  const sess = getCurrentSession()
  const run = () => executeFn(`( ${line} )`, { sessionId, stdin })
  const io = sess === null ? await run() : await runAsProgram(sess, run)
  if (io.stdout !== null) {
    const data = await materialize(io.stdout)
    if (data.byteLength > 0) out.push(data)
  }
  const err = await materialize(io.stderr)
  if (err.byteLength > 0) errors.push(err)
  return io.exitCode === 0
}

/** Remove a matched entry through the operation door, which owns admission,
 * backend support, cache invalidation and namespace cleanup. */
async function deleteRow(
  ps: PathSpec,
  ns: NamespaceView | null,
  dispatch: DispatchFn | null,
  errors: Uint8Array[],
  statPath: StatPath | null,
): Promise<boolean> {
  const path = ps.rawPath || ps.virtual
  if (dispatch === null) {
    errors.push(encodeText('find: -delete requires an operation dispatcher\n'))
    return false
  }
  try {
    const link = (ns?.links?.statAt(ps.virtual) ?? null) !== null
    const st = link || statPath === null ? null : await statPath(ps)
    if (!link && statPath !== null && st === null) throw enoent(ps)
    const op = st !== null && st.type === FileType.DIRECTORY ? 'rmdir' : 'unlink'
    await dispatch(op, ps)
    return true
  } catch (err) {
    errors.push(encodeText(`find: cannot delete '${path}': ${refusalWhy(err)}\n`))
    return false
  }
}

/**
 * How a row's failure is worded: GNU uses the errno text, and a policy
 * refusal carries its reason in that place (`frozen`, not the
 * `Permission denied` its EACCES code would spell), which is what the
 * python twin reads off `strerror or str(exc)`.
 */
function refusalWhy(err: unknown): string {
  if (err instanceof PolicyDenied) return err.message
  return failureText(err)
}

/**
 * Render one accepted row in `find -ls`'s own layout.
 *
 * The row's facts come from the two doors the command boundary has: a
 * symlink is namespace state no backend can see, so the link view
 * answers for one (lstat, as GNU's `-ls` reports the link itself), and
 * every other row is statted through the op dispatcher, which answers
 * for a mount point and a namespace-only ancestor as well as a backend
 * entry. A row that cannot be statted (an earlier `-delete` removed
 * it, or the backend refuses it) is GNU's `find: 'path': <reason>`;
 * null with a line appended is the caller's signal to end the row's
 * chain.
 */
async function rowStat(
  ps: PathSpec,
  ns: NamespaceView | null,
  statPath: StatPath | null,
  errors: Uint8Array[],
): Promise<FileStat | null> {
  const path = ps.rawPath || ps.virtual
  if (statPath === null) {
    errors.push(encodeText(`find: '${path}': no stat door\n`))
    return null
  }
  const link = ns?.links?.statAt(ps.virtual) ?? null
  let st: FileStat | null
  try {
    st = link ?? (await statPath(ps))
  } catch (err) {
    errors.push(encodeText(`find: '${path}': ${refusalWhy(err)}\n`))
    return null
  }
  if (st === null) {
    errors.push(encodeText(`find: '${path}': ${gnuStrerror('ENOENT') ?? 'ENOENT'}\n`))
    return null
  }
  return st
}

/** Render one accepted row in `find -ls`'s own layout. */
function lsRow(ps: PathSpec, st: FileStat, identity: Identity | null): Uint8Array {
  const path = ps.rawPath || ps.virtual
  return encodeText(`${formatFindLs(st.with({ name: path }), identity)}\n`)
}

/**
 * The facts one `-printf` row renders from, off the stat find holds for
 * it. A symlink row is the link itself, and %Y reads what it points at
 * through the workspace, so a link into another mount classifies and a
 * dangling one reads N.
 */
async function printfFacts(
  ps: PathSpec,
  st: FileStat,
  ns: NamespaceView | null,
): Promise<PrintfStatFacts> {
  const links = ns?.links ?? null
  const link = links !== null && links.statAt(ps.virtual) !== null
  const target = link ? await links.targetStat(ps.virtual) : null
  return {
    size: contentSize(st),
    kind: link ? 'l' : printfKind(st),
    mtimeEpoch: modifiedTs(st.modified) ?? 0,
    mode: st.mode,
    targetKind: !link ? null : target === null ? 'N' : printfKind(target),
    uid: st.uid,
    gid: st.gid,
  }
}

/** Render one row through a `-printf` format; `st` is null when the
 * format names no stat directive. */
function printfRow(
  action: PrintfAction,
  path: string,
  base: string,
  st: PrintfStatFacts | null,
  warnings: string[],
  identity: Identity | null,
): Uint8Array {
  return encodeText(expandPrintf(action.format, path, base, st, warnings, identity))
}

/** Whether an action reads the row's stat: `-ls`, and a `-printf` whose
 * format names a stat directive (%s %y %m %T ...). */
function readsStat(action: FindAction): boolean {
  return action.kind === 'ls' || (action.kind === 'printf' && printfNeedsStat(action.format))
}

/** The spelling a start point's rows are measured from (%P, %d); with no
 * operand, the working directory find walked, which prints as `.`. */
function startBase(start: PathSpec | undefined): string {
  return start === undefined ? '.' : start.rawPath || start.virtual
}

/**
 * GNU's `-depth` order over sorted siblings: a directory's contents, each
 * sorted, then the directory. The final component is flagged so a path
 * sorts after its descendants, whose entry at that depth carries the same
 * name unflagged. A start point spelled with a trailing slash prints as
 * `d/` while its descendants print as `d/a`, so the slash is dropped
 * before splitting: kept, it would leave an empty final component that
 * sorts the directory ahead of everything under it, which is the one
 * order `-delete` cannot remove a tree in.
 */
export function compareDepthFirst(a: string, b: string): number {
  const pa = rstripSlash(a).split('/')
  const pb = rstripSlash(b).split('/')
  const n = Math.min(pa.length, pb.length)
  for (let i = 0; i < n; i++) {
    const byName = compareCodePoints(pa[i] ?? '', pb[i] ?? '')
    if (byName !== 0) return byName
    const fa = i === pa.length - 1 ? 1 : 0
    const fb = i === pb.length - 1 ? 1 : 0
    if (fa !== fb) return fa - fb
  }
  return pa.length - pb.length
}

/** Whether a row is a mount point or a namespace-only ancestor of one,
 * which are not unlinkable entries. Ancestors use the raw mount table
 * like isMountRoot: an ungranted mount still pins its ancestors in the
 * namespace. */
function structural(path: PathSpec, registry: MountRegistry): boolean {
  const virtual = path.virtual
  return registry.isMountRoot(virtual) || registry.descendantMounts(virtual).length > 0
}

/** Whether the actions differ from the implicit print: one explicit
 * `-print` is exactly what the backend already rendered, two of them
 * print every row twice, as GNU does. */
/**
 * Whether the expression's tests made find stat every row it kept. GNU
 * reads `-name`, `-path` and `-type` off the directory entry and stats
 * only for a test that needs the inode: a size or time window, `-newer`
 * and `-empty`.
 */
function testsStat(expr: FindExpr): boolean {
  return (
    expr.minSize !== null ||
    expr.maxSize !== null ||
    expr.mtimeMin !== null ||
    expr.mtimeMax !== null ||
    expr.usesEmpty ||
    expr.newer.length > 0
  )
}

function hasActions(expr: FindExpr): boolean {
  return expr.actions.length > 1 || expr.actions.some((a) => a.kind !== 'print')
}

/**
 * Apply find's actions (-exec / -delete / -print0 / -ls / -printf) to its
 * rows.
 *
 * Per-VFS find handlers only emit matched paths. This dispatcher
 * layer re-reads the actions off the expression and applies them per
 * match, in the order they were written, the way GNU's implicit `-a`
 * chain runs: each per-match `-exec` runs in turn and the first that
 * fails ends the chain for that match, so a later `-print` (or `-ls`,
 * `-print0`, `-printf`, `-delete`) sees only the matches every earlier
 * `-exec` accepted (`-exec grep -q x {} ";" -print`), and `-exec echo {}
 * ";" -print -exec echo again {} ";"` alternates the three per match. A
 * batched `-exec ... {} +` collects the match at its position and runs
 * once after the walk; a failing batch is find's exit 1, as is a row it
 * could not delete, list or stat for a `-printf`, and either ends that
 * row's chain; a failing per-match run is not, and neither is a command
 * that cannot be found, which GNU reports per match and carries on from
 * with exit 0. An action other than `-print` suppresses
 * the implicit print. `-delete` runs at its position, so a later `-exec`
 * sees the row gone, and a row it cannot delete ends the chain with GNU's
 * line and find's exit 1. It also turns on `-depth`, which orders every
 * directory after its contents, the only order a tree can be removed in;
 * `-depth` alone reorders the implicit print the same way, and both
 * order one start point's walk at a time: GNU walks each start point to
 * completion before the next, so `find b a -depth` prints `b/x b a/y a`
 * and `find d d/sub -depth` finishes `d` before it begins `d/sub` again,
 * which is why the rows arrive as one run per start point rather than
 * one list; `-printf`'s %P and %d measure a row from its run's start
 * point. Returns the rows to print, the stderr to append, and the
 * exit status the actions impose (0 when they impose none, even with
 * stderr).
 */
export async function applyFindActions(
  stdout: ByteSource | null,
  matchedRuns: readonly (readonly PathSpec[])[] | null,
  texts: readonly string[],
  registry: MountRegistry,
  cwd: string,
  doors: FindActionDoors = {},
): Promise<[ByteSource | null, Uint8Array, number]> {
  const expr = parseFindExpression([...texts])
  const reorders = expr.depthFirst
  if (stdout === null || !(hasActions(expr) || reorders)) return [stdout, new Uint8Array(), 0]
  const executeFn = doors.executeFn
  const execs = execActions(expr.actions)
  if (execs.length > 0 && executeFn === undefined) {
    return [null, encodeText('find: -exec: no shell to run the command\n'), 1]
  }
  const sessionId = doors.sessionId ?? ''
  const ns = doors.ns ?? null
  const statPath = doors.statPath ?? null
  const dispatch = doors.dispatch ?? null
  const identity = doors.identity ?? null
  const starts = doors.starts ?? []
  const signal = doors.signal
  const once =
    doors.stdin === undefined || doors.stdin === null ? null : new SharedStdin(doors.stdin)
  await materialize(stdout)
  if (matchedRuns === null)
    return [null, encodeText('find: actions require structured matches\n'), 1]
  // The runs arrive one per start point, in operand order, so each row
  // carries the spelling of the start point it was found under.
  const matches = matchedRuns.flatMap((run, i) =>
    (reorders
      ? [...run].sort((a, b) => compareDepthFirst(a.rawPath || a.virtual, b.rawPath || b.virtual))
      : run
    ).map((match): [PathSpec, string] => [match, startBase(starts[i])]),
  )
  // An expression with no action of its own prints, which is the one
  // implicit action -depth reorders.
  const actions: FindAction[] = expr.actions.length > 0 ? expr.actions : [{ kind: 'print' }]
  const errors: Uint8Array[] = []
  const warnings: string[] = []
  const out: Uint8Array[] = []
  const batches = new Map<number, string[]>()
  let exitCode = 0
  const stats = actions.some(readsStat)
  const statted = testsStat(expr)
  const startVirtuals = new Set(starts.length > 0 ? starts.map((s) => s.virtual) : [cwd])
  for (const [match, base] of matches) {
    signal?.throwIfAborted()
    const path = match.rawPath || match.virtual
    // The stat -ls and -printf render is the one find already holds,
    // taken before any action of the chain can remove the row; a row it
    // never statted is looked up by the first action that reads it, and
    // held from there, as GNU stats a row once.
    let held =
      stats && (statted || startVirtuals.has(match.virtual))
        ? await rowStat(match, ns, statPath, [])
        : null
    for (const [position, action] of actions.entries()) {
      if (action.kind === 'exec') {
        if (action.batch) {
          const bucket = batches.get(position) ?? []
          bucket.push(path)
          batches.set(position, bucket)
          continue
        }
        if (executeFn === undefined) break
        if (
          !(await runExec(
            executeFn,
            sessionId,
            registry,
            cwd,
            statPath,
            action,
            [path],
            out,
            errors,
            once,
          ))
        )
          break
      } else if (readsStat(action)) {
        held = held ?? (await rowStat(match, ns, statPath, errors))
        if (held === null) {
          // A row -ls or -printf cannot stat is false, so the chain ends
          // for it, as GNU's does.
          exitCode = 1
          break
        }
        out.push(
          action.kind === 'printf'
            ? printfRow(action, path, base, await printfFacts(match, held, ns), warnings, identity)
            : lsRow(match, held, identity),
        )
      } else if (action.kind === 'printf') {
        out.push(printfRow(action, path, base, null, warnings, identity))
      } else if (action.kind === 'delete') {
        // A structural row is skipped, not refused, the way Unix leaves
        // a mount point in place.
        if (structural(match, registry)) continue
        if (!(await deleteRow(match, ns, dispatch, errors, statPath))) {
          exitCode = 1
          break
        }
      } else {
        out.push(encodeText(path + (action.kind === 'print0' ? '\0' : '\n')))
      }
    }
  }
  for (const [position, action] of actions.entries()) {
    const paths = batches.get(position)
    if (action.kind !== 'exec' || paths === undefined || executeFn === undefined) continue
    signal?.throwIfAborted()
    if (
      !(await runExec(
        executeFn,
        sessionId,
        registry,
        cwd,
        statPath,
        action,
        paths,
        out,
        errors,
        once,
      ))
    )
      exitCode = 1
  }
  const body = concat(out)
  // GNU warns about a directive it cannot render once, ahead of anything
  // the actions report.
  const warned = warnings.map((line) => encodeText(`${line}\n`))
  return [body.byteLength > 0 ? body : null, concat([...warned, ...errors]), exitCode]
}
