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

import type { CommandFnResult } from '../../../commands/config.ts'
import { currentCaller } from '../../../context/session_context.ts'
import { PartialOutputError, UsageError } from '../../../commands/errors.ts'
import { runWithTimeout } from '../../../commands/builtin/utils/limit.ts'
import { readFailExitCode } from '../../../commands/spec/usage.ts'
import { errorVirtualPath, fsStrerror } from '../../../errors/fs.ts'
import { formatFsError } from '../../../errors/render.ts'
import { CommandTimeoutError } from '../../../errors/types.ts'
import { chunks } from '../../../io/cooperative.ts'
import { PipeClosed } from '../../../io/errors.ts'
import { OutputStream, closeQuietly } from '../../../io/stream.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import { encodeText } from '../../../shell/bytes.ts'
import { STOP_WAIT_SECONDS } from '../../../shell/job_table/constants.ts'
import type { Limit, PathSpec, Producer } from '../../../types.ts'
import { ABORT_JOIN_MS, joinOrAbort } from '../../../utils/abort.ts'
import { concat } from '../../../utils/bytes.ts'
import { readerOf, type Files } from '../../files.ts'

/**
 * What a voice says for one failure: the bytes the handler printed before
 * it, the diagnostic line and the exit code.
 */
type Failure = [ByteSource | null, Uint8Array, number]

/**
 * How a caller words a handler that failed, before it answered or while its
 * output streamed. The runner is one for a mount command and a CLI leaf; the
 * wording is the caller's, and stays what each said before the two shared
 * it. Mirrors Python's `HandlerVoice`.
 */
export interface HandlerVoice {
  /** The failure as this caller words it. */
  fail(err: unknown): Failure
  /**
   * Whether a failure is not the command's to word and reaches the
   * workspace instead (a limit timeout answers 124 there).
   */
  passes(err: unknown): boolean
  /**
   * Whether output is pulled through `chunks`, which splits even a single
   * blob, so an answer in bytes streams too.
   */
  splits: boolean
}

export interface RunHandlerOpts {
  /**
   * Drops the caches a write past the dispatcher leaves stale; absent when
   * the handler writes nothing or only through the dispatcher.
   */
  drop?: () => Promise<void>
  /**
   * What the caller wraps an answer in before it is framed (a mount binds
   * its recorder and activity to the stream).
   */
  scope?: (result: [ByteSource | null, IOResult]) => [ByteSource | null, IOResult]
  /** False leaves a script leaf's output as its runtime worded it. */
  frame?: boolean
  /** The caller's abort, which stops waiting for the body. */
  signal?: AbortSignal
  /** Aborted when the limit trips, so a runtime can kill what it spawned. */
  abort?: AbortController
  /**
   * Called once the answer, its rows rendered, has settled, however the
   * caller left: a handler and its renderer may run past a timeout, so a
   * caller keeps what they use (a CLI's client) until then.
   */
  settle?: () => void
  /**
   * The handler's files, whose session's hides filter the rows it hands
   * over; absent filters none.
   */
  vfs?: Files | null
}

/**
 * What a failed leaf says after its name: a file error stamped with its
 * path as the path and phrase, the way the shell's own commands say it,
 * anything else in its own words. Mirrors Python's `_leaf_message`.
 */
function leafMessage(err: unknown): string {
  const strerror = fsStrerror(err)
  if (strerror !== null && typeof (err as { virtualPath?: unknown }).virtualPath === 'string')
    return `${errorVirtualPath(err)}: ${strerror}`
  return err instanceof Error ? err.message : String(err)
}

/** Whether `err` is an abort, which the caller that aborted answers. */
function aborted(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

/**
 * A mount command's failure, worded like GNU (`prog: message`), a file
 * error with the path as typed. Mirrors Python's `_mount_failure`.
 */
function mountFailure(name: string, paths: readonly PathSpec[], err: unknown): Failure {
  const code = err instanceof UsageError ? err.exitCode : readFailExitCode(name, err)
  return [null, formatFsError(name, err, paths), code]
}

/**
 * A CLI leaf's failure: a usage error in its own words and exit code,
 * anything else after the program's name with exit 1, and what the leaf
 * printed before it failed kept. Mirrors Python's `_leaf_failure`.
 */
function leafFailure(prog: string, err: unknown): Failure {
  const printed = err instanceof PartialOutputError ? err.stdout : null
  if (err instanceof UsageError) return [printed, encodeText(`${err.message}\n`), err.exitCode]
  return [printed, encodeText(`${prog}: ${leafMessage(err)}\n`), 1]
}

/** The voice of a command a mount runs; `paths` are the operands as typed. */
export function mountVoice(name: string, paths: readonly PathSpec[]): HandlerVoice {
  return {
    fail: (err) => mountFailure(name, paths, err),
    passes: (err) =>
      err instanceof CommandTimeoutError || err instanceof PipeClosed || aborted(err),
    splits: false,
  }
}

/** The voice of a CLI leaf, installed or on a mount. */
export function cliVoice(prog: string): HandlerVoice {
  return {
    fail: (err) => leafFailure(prog, err),
    passes: (err) => err instanceof CommandTimeoutError || aborted(err),
    splits: true,
  }
}

/**
 * The caller has gone, so output the handler hands back later has no
 * reader: close it, and log a failure no caller is left to see.
 */
function abandon(body: Promise<CommandFnResult>, err: unknown, name: string): void {
  void body.then(
    async (late) => {
      if (late === null) return
      await closeQuietly(late[0])
      await closeQuietly(late[1].stderr)
    },
    (late: unknown) => {
      if (late !== err && !aborted(late))
        console.error(`${name}: failed after its caller left: ${String(late)}`)
    },
  )
}

/**
 * A leaf's answer, an empty one where it returned null. A mount command's
 * null declines, so its mount tries the next handler; a leaf's null is its
 * whole answer, an empty one. Mirrors Python's `answered`.
 */
export async function answered(
  body: Promise<CommandFnResult>,
): Promise<[ByteSource | null, IOResult]> {
  return (await body) ?? [null, new IOResult()]
}

/**
 * Run one handler body: a mount command's, or a CLI leaf's.
 *
 * The body runs under the resolved limit's timeout, which must bound it as
 * well as its output: an eager handler does its work inside the call, where
 * the stream guard never runs. Racing a promise does not stop its work, so
 * the timeout aborts `opts.abort` for a runtime that can kill what it
 * spawned, and output the body hands back after its caller left is closed.
 * A usage error is the handler's own words and exit code; any other failure
 * is worded in the caller's voice, so the rest of the line keeps running. A
 * handler that may have written past the dispatcher drops caches afterwards,
 * whether it answered, failed (in its own words too), timed out or was
 * cancelled, again when a body (or the renderer of the rows it handed over)
 * still running past its timeout settles, since its write may land then, and
 * again once an answer that streams has ended or
 * been closed, since a stream does its work as it is pulled. An answer
 * carries the producer the output limits resolve from and
 * has its stream framed so a failure while it streams is worded too; a
 * failure the runner framed carries no producer. Null is the handler
 * declining, which a mount's cascade reads as "try the next handler".
 * Rows a handler hands over in place of stdout (`IOResult.rows`) lose those
 * the session cannot see and are rendered here, inside the timeout, so this
 * is the one place a command's output meets the session's hides.
 * Mirrors Python's `run_handler`.
 */
export async function runHandler(
  body: Promise<CommandFnResult>,
  name: string,
  limit: Limit | null,
  producer: Producer,
  voice: HandlerVoice,
  opts: RunHandlerOpts = {},
): Promise<CommandFnResult> {
  const timeout = limit?.timeoutSeconds ?? null
  let out: CommandFnResult
  // The rendered answer is what a caller that left abandons: a renderer that
  // finishes late hands back output nobody reads.
  const answer = rendered(body, opts.vfs ?? null, name)
  if (opts.settle !== undefined) void answer.then(opts.settle, opts.settle)
  // A `kill` names a signal, and the program the command started gets the
  // stop bound to answer it (a handler, a sandbox reap), as Python joins
  // the cancelled handler whole; any other abort releases the caller soon.
  const runner = currentCaller().process
  const grace = (): number =>
    (runner?.signal ?? null) === null ? ABORT_JOIN_MS : STOP_WAIT_SECONDS * 1000
  try {
    out = await runWithTimeout(joinOrAbort(answer, opts.signal, grace), timeout, name)
  } catch (err) {
    if (err instanceof CommandTimeoutError) opts.abort?.abort()
    abandon(answer, err, name)
    const drop = opts.drop
    if (drop !== undefined) {
      await drop()
      if (err instanceof CommandTimeoutError || opts.signal?.aborted === true) {
        const settle = (): Promise<void> => drop()
        void answer.then(settle, settle).catch((dropErr: unknown) => {
          // The command already returned, so a drop that fails here (a
          // workspace torn down under it) has no stream to land on; it is
          // reported rather than left as an unhandled rejection.
          const reason = dropErr instanceof Error ? dropErr.message : String(dropErr)
          console.warn(`${name}: cache drop after timeout failed: ${reason}`)
        })
      }
    }
    if (err instanceof UsageError) {
      return [
        null,
        new IOResult({ exitCode: err.exitCode, stderr: encodeText(`${err.message}\n`) }),
      ]
    }
    if (voice.passes(err)) throw err
    const [printed, stderr, exitCode] = voice.fail(err)
    return [printed, new IOResult({ exitCode, stderr })]
  }
  const drop = opts.drop
  if (drop !== undefined) await drop()
  if (out === null) return null
  const source = out[0]
  out[1].producer = producer
  const [stream, io] = opts.scope !== undefined ? opts.scope(out) : out
  let pulled: AsyncIterator<Uint8Array>
  if (opts.frame === false || stream === null || (stream instanceof Uint8Array && !voice.splits)) {
    if (drop === undefined || stream === null || stream instanceof Uint8Array) return [stream, io]
    pulled = stream[Symbol.asyncIterator]()
  } else {
    pulled = framed(stream, io, voice)
  }
  const lazy = !(stream instanceof Uint8Array)
  return [
    new OutputStream(pulled, async () => {
      await closeQuietly(source)
      await closeQuietly(stream)
      if (drop !== undefined && lazy) await drop()
    }),
    io,
  ]
}

/**
 * A handler's answer with the rows it handed over rendered: those the
 * session cannot see dropped first. Mirrors Python's `_rendered`.
 */
async function rendered(
  body: Promise<CommandFnResult>,
  vfs: Files | null,
  name: string,
): Promise<CommandFnResult> {
  const out = await body
  if (out === null) return out
  const [stdout, io] = out
  const rows = io.rows
  if (rows === null) return out
  if (stdout !== null) {
    await closeQuietly(stdout)
    throw new Error(`${name}: hands over both rows and stdout`)
  }
  io.rows = null
  let items = [...rows.items]
  if (vfs !== null) {
    const reader = readerOf(vfs)
    items = items.filter((row) => reader.visible(row.path))
  }
  return [await rows.render(items), io]
}

/** Keep a deferred failure on its command, after any emitted bytes. */
async function* framed(
  source: ByteSource,
  io: IOResult,
  voice: HandlerVoice,
): AsyncGenerator<Uint8Array> {
  try {
    if (voice.splits || source instanceof Uint8Array) yield* chunks(source)
    else yield* source
  } catch (err) {
    if (voice.passes(err)) throw err
    const [printed, stderr, exitCode] = voice.fail(err)
    if (printed !== null) yield* chunks(printed)
    io.stderr = concat([await io.materializeStderr(), stderr])
    io.exitCode = exitCode
  } finally {
    await closeQuietly(source)
  }
}
