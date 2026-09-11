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
import { resolvePath } from '../../utils/path.ts'
import { fsStrerror, gnuStrerror, isFsError } from '../../utils/errors.ts'
import { formatFindLs } from '../../commands/builtin/utils/formatting.ts'
import type { Identity } from '../../commands/builtin/utils/identity.ts'
import { PolicyDenied } from '../../policy/errors.ts'
import { shellJoin } from '../../shell/join.ts'
import { type ByteSource, materialize } from '../../io/types.ts'
import {
  getCurrentSession,
  runAsProgram,
  runWithSuspendedOpPolicies,
} from '../../context/session_context.ts'
import { preOpsGate } from '../../policy/policies.ts'
import type { FileStat, PathSpec } from '../../types.ts'
import type { MountRegistry } from '../mount/registry.ts'
import { SHELL_ONLY_BUILTINS } from '../lookup/constants.ts'
import { lookupAll } from '../lookup/lookup.ts'
import { Consumer } from '../lookup/types.ts'
import type { NamespaceView, StatPath } from '../../ops/types.ts'
import { yieldBytes } from '../../io/stream.ts'
import { FileType } from '../../types.ts'
import type { Namespace } from '../mount/namespace/namespace.ts'
import {
  execActions,
  type FindExpr,
  parseFindExpression,
} from '../../commands/builtin/find_parse.ts'
import { EXEC_PLACEHOLDER } from '../../commands/builtin/constants.ts'
import type { ExecAction, FindAction } from '../../commands/builtin/types.ts'
import type { ExecuteFn } from '../expand/node.ts'
import type { DispatchFn } from '../../runtime/types.ts'

export interface FindActionDoors {
  // Runs an `-exec` line in the session; absent outside a workspace,
  // where `-exec` is refused.
  executeFn?: ExecuteFn
  sessionId?: string
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
  namespace?: Namespace | null
  // find's own input, which its `-exec` children share as one cursor, as
  // GNU's do (a pipe feeds one reader, and a child that never reads leaves
  // it for the next).
  stdin?: ByteSource | null
  /** The start operands, whose rows GNU statted when it opened the
   * walk; empty means the working directory. */
  readonly starts?: readonly PathSpec[]
}

const enc = new TextEncoder()

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
 * The shell line one `-exec` run becomes. GNU execs the words directly,
 * so every match must reach the command as exactly one argv word: the
 * line is built with `shellJoin`, and a plain join would be re-parsed by
 * the shell.
 */
export function execLine(action: ExecAction, paths: readonly string[]): string {
  return shellJoin(execWords(action, paths))
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

/**
 * Run one `-exec` invocation, collecting its streams. A command that
 * cannot be found is GNU's `find: 'cmd': No such file or directory` rather
 * than the shell's `command not found`, and counts as a failed run. That
 * is decided by looking the head word up before the line runs (GNU fails
 * in `execvp`), never from the exit status: a program that exists and
 * exits 127 keeps its own stderr and is just a failed run. Returns
 * whether the run succeeded, which is the action's truth value.
 */
/**
 * find's own input, shared by its `-exec` children as one cursor. GNU's
 * children inherit find's stdin descriptor, so its offset moves only
 * when a child reads: `-exec true \; -exec cat \;` leaves the bytes for
 * cat, while two cats see them once. The same object rides into every
 * child as its stdin, and the first read drains it.
 */
export class SharedStdin implements AsyncIterable<Uint8Array> {
  private chunks: AsyncIterator<Uint8Array> | null
  private buffer: Uint8Array = new Uint8Array()
  private pos = 0

  constructor(source: ByteSource) {
    this.chunks = (source instanceof Uint8Array ? yieldBytes(source) : source)[
      Symbol.asyncIterator
    ]()
  }

  // The source is pulled only as a child reads: find itself never reads
  // its stdin, so a walk with no reading child (`yes | find d -maxdepth
  // 0`) must not wait on it, and a child that reads a little of an
  // unbounded input (`-exec head -c 1`) must get its byte without waiting
  // for EOF. One byte per pull, so a child that stops reading early
  // leaves the rest at the cursor for the next child, the way a shared
  // descriptor's offset does; the next source chunk is pulled only once
  // the buffered one is spent.
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: async () => {
        while (this.pos >= this.buffer.byteLength) {
          if (this.chunks === null) return { done: true, value: undefined }
          const step = await this.chunks.next()
          if (step.done === true) {
            this.chunks = null
            return { done: true, value: undefined }
          }
          this.buffer = step.value
          this.pos = 0
        }
        const chunk = this.buffer.subarray(this.pos, this.pos + 1)
        this.pos += 1
        return { done: false, value: chunk }
      },
    }
  }
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
    errors.push(enc.encode(`find: '${head}': No such file or directory\n`))
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

/**
 * Delete one accepted row; returns whether it succeeded.
 *
 * A symlink row came from the namespace, which no backend can see, so
 * it is unlinked through the op dispatcher the way `rm link` is
 * (`stripLinkOperands`): that door is where the path gate, the turf's
 * mode and the op ledger fire, and it removes the node the mount's `rm`
 * would only report as absent. Every other row is a backend entry,
 * removed by the mount's own `rm`.
 */
async function deleteRow(
  ps: PathSpec,
  registry: MountRegistry,
  cwd: string,
  ns: NamespaceView | null,
  dispatch: DispatchFn | null,
  errors: Uint8Array[],
  namespace: Namespace | null,
  statPath: StatPath | null,
): Promise<boolean> {
  const path = ps.rawPath || ps.virtual
  const link = dispatch !== null && (ns?.links?.statAt(ps.virtual) ?? null) !== null
  const mount = registry.tryMountFor(ps.virtual)
  if (mount === null && !link) {
    errors.push(enc.encode(`find: cannot delete '${path}': no mount\n`))
    return false
  }
  try {
    if (link) {
      await dispatch('unlink', ps)
      return true
    }
    if (mount === null) return false
    // -delete is find's own action, not an `rm` line, so no command rule
    // sees it; it is a removal all the same, so it clears the op door a
    // path rule guards (the same gate `ws.fs`, FUSE and a redirect
    // clear), by the session the line runs under, and a refusal reports
    // in find's voice. The delegated rm's own slots are suspended for the
    // call, so the deletion admits exactly once. -d so a directory
    // emptied by the rows before it in -depth order is removable,
    // matching GNU -delete's rmdir behavior.
    // Admitted as the op the row's removal is: a directory row is an
    // rmdir, so a rule that refuses rmdir and allows unlink judges `find
    // emptydir -delete` as it judges `rmdir emptydir`.
    const st = statPath === null ? null : await statPath(ps.virtual)
    const op = st !== null && st.type === FileType.DIRECTORY ? 'rmdir' : 'unlink'
    await preOpsGate(
      registry.policies,
      op,
      ps,
      true,
      mount.prefix,
      getCurrentSession()?.sessionId ?? '',
    )
    const [, rmIo] = await runWithSuspendedOpPolicies(() =>
      mount.executeCmd('rm', [ps], [], { d: true }, { stdin: null, cwd }),
    )
    if (rmIo.exitCode !== 0) {
      // rm names the reason last (`rm: cannot remove '/w/d': Directory
      // not empty`), and find says the same thing about the row as it
      // was typed.
      const line = new TextDecoder().decode(await materialize(rmIo.stderr)).trim()
      const why = line.slice(line.lastIndexOf(': ') + 2)
      errors.push(enc.encode(`find: cannot delete '${path}'${why ? `: ${why}` : ''}\n`))
      return false
    }
    if (namespace !== null) {
      // The row's node meta (a chmod/chown overlay) goes with it and a
      // directory's subtree purges, as the `rm` command path does in
      // command_dispatch: a file later created at the same name must not
      // inherit the removed one's mode.
      await namespace.unlink(ps.virtual)
      await namespace.purgeUnder(ps.virtual)
    }
    return true
  } catch (err) {
    errors.push(enc.encode(`find: cannot delete '${path}': ${refusalWhy(err)}\n`))
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
  return (
    (isFsError(err) ? fsStrerror(err) : null) ?? (err instanceof Error ? err.message : String(err))
  )
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
    errors.push(enc.encode(`find: '${path}': no stat door\n`))
    return null
  }
  const link = ns?.links?.statAt(ps.virtual) ?? null
  let st: FileStat | null
  try {
    st = link ?? (await statPath(ps.virtual))
  } catch (err) {
    errors.push(enc.encode(`find: '${path}': ${refusalWhy(err)}\n`))
    return null
  }
  if (st === null) {
    errors.push(enc.encode(`find: '${path}': ${gnuStrerror('ENOENT') ?? 'ENOENT'}\n`))
    return null
  }
  return st
}

/** Render one accepted row in `find -ls`'s own layout. */
function lsRow(ps: PathSpec, st: FileStat, identity: Identity | null): Uint8Array {
  const path = ps.rawPath || ps.virtual
  return enc.encode(`${formatFindLs(st.with({ name: path }), identity)}\n`)
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
  const pa = a.replace(/\/+$/, '').split('/')
  const pb = b.replace(/\/+$/, '').split('/')
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
 * Apply find's actions (-exec / -delete / -print0 / -ls) to its rows.
 *
 * Per-resource find handlers only emit matched paths. This dispatcher
 * layer re-reads the actions off the expression and applies them per
 * match, in the order they were written, the way GNU's implicit `-a`
 * chain runs: each per-match `-exec` runs in turn and the first that
 * fails ends the chain for that match, so a later `-print` (or `-ls`,
 * `-print0`, `-delete`) sees only the matches every earlier `-exec`
 * accepted (`-exec grep -q x {} ";" -print`), and `-exec echo {} ";"
 * -print -exec echo again {} ";"` alternates the three per match. A
 * batched `-exec ... {} +` collects the match at its position and runs
 * once after the walk; a failing batch is find's exit 1, as is a row it
 * could not delete or list, and either ends that row's chain; a failing
 * per-match run is not, and neither
 * is a command that cannot be found, which GNU reports per match and
 * carries on from with exit 0. An action other than `-print` suppresses
 * the implicit print. `-delete` runs at its position, so a later `-exec`
 * sees the row gone, and a row it cannot delete ends the chain with GNU's
 * line and find's exit 1. It also turns on `-depth`, which orders every
 * directory after its contents, the only order a tree can be removed in;
 * `-depth` alone reorders the implicit print the same way, and both
 * order one start point's walk at a time: GNU walks each start point to
 * completion before the next, so `find b a -depth` prints `b/x b a/y a`
 * and `find d d/sub -depth` finishes `d` before it begins `d/sub` again,
 * which is why the rows arrive as one run per start point rather than
 * one list. Returns the rows to print, the stderr to append, and the
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
  const reorders = expr.depthFirst && expr.printf === null
  if (stdout === null || !(hasActions(expr) || reorders)) return [stdout, new Uint8Array(), 0]
  const executeFn = doors.executeFn
  const execs = execActions(expr.actions)
  if (execs.length > 0 && executeFn === undefined) {
    return [null, enc.encode('find: -exec: no shell to run the command\n'), 1]
  }
  const sessionId = doors.sessionId ?? ''
  const ns = doors.ns ?? null
  const statPath = doors.statPath ?? null
  const dispatch = doors.dispatch ?? null
  const identity = doors.identity ?? null
  const starts = doors.starts ?? []
  const namespace = doors.namespace ?? null
  const once =
    doors.stdin === undefined || doors.stdin === null ? null : new SharedStdin(doors.stdin)
  if (matchedRuns === null)
    return [null, enc.encode('find: actions require structured matches\n'), 1]
  const matches = matchedRuns.flatMap((run) =>
    reorders
      ? [...run].sort((a, b) => compareDepthFirst(a.rawPath || a.virtual, b.rawPath || b.virtual))
      : [...run],
  )
  // An expression with no action of its own prints, which is the one
  // implicit action -depth reorders.
  const actions: FindAction[] = expr.actions.length > 0 ? expr.actions : [{ kind: 'print' }]
  const errors: Uint8Array[] = []
  const out: Uint8Array[] = []
  const batches = new Map<number, string[]>()
  let exitCode = 0
  const lists = actions.some((a) => a.kind === 'ls')
  const statted = testsStat(expr)
  const startVirtuals = new Set(starts.length > 0 ? starts.map((s) => s.virtual) : [cwd])
  for (const match of matches) {
    const path = match.rawPath || match.virtual
    // The stat -ls renders is the one find already holds, taken before
    // any action of the chain can remove the row; a row it never statted
    // is looked up by the -ls that reaches it.
    const held =
      lists && (statted || startVirtuals.has(match.virtual))
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
      } else if (action.kind === 'ls') {
        const st = held ?? (await rowStat(match, ns, statPath, errors))
        if (st === null) {
          // A row -ls cannot list is false, so the chain ends for it, as
          // GNU's does.
          exitCode = 1
          break
        }
        out.push(lsRow(match, st, identity))
      } else if (action.kind === 'delete') {
        // A structural row is skipped, not refused, the way Unix leaves
        // a mount point in place.
        if (structural(match, registry)) continue
        if (!(await deleteRow(match, registry, cwd, ns, dispatch, errors, namespace, statPath))) {
          exitCode = 1
          break
        }
      } else {
        out.push(enc.encode(path + (action.kind === 'print0' ? '\0' : '\n')))
      }
    }
  }
  for (const [position, action] of actions.entries()) {
    const paths = batches.get(position)
    if (action.kind !== 'exec' || paths === undefined || executeFn === undefined) continue
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
  return [body.byteLength > 0 ? body : null, concat(errors), exitCode]
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0
  for (const c of chunks) total += c.byteLength
  const merged = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    merged.set(c, offset)
    offset += c.byteLength
  }
  return merged
}
