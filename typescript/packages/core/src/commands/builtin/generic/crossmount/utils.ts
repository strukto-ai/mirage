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

import { abortable } from '../../../../utils/abort.ts'
import { discardStreams, ensureStream } from '../../../../io/stream.ts'
import { chunks } from '../../../../io/cooperative.ts'
import { concat as concatBytes } from '../../../../utils/bytes.ts'
import { isStdin } from '../../utils/stream.ts'
import type { TransferLinks } from '../cp.ts'
import type { LinkView } from '../../../../view/types.ts'
import { virtualKey } from '../../utils/paths.ts'
import { ROOT_CWD } from '../../../constants.ts'
import { OPERAND_CONCURRENCY } from '../../constants.ts'
import { eisdir, isFsError } from '../../../../errors/fs.ts'
import { fsErrorLine } from '../../../../errors/render.ts'
import { IOResult, materialize, type ByteSource } from '../../../../io/types.ts'
import type { PathSpec } from '../../../../types.ts'
import { type FileStat, FileType } from '../../../../types.ts'
import type { Context } from '../../../config.ts'
import type { DispatchFn, OperandRun, RunSingle } from './types.ts'
import type { FlagValue } from '../../../spec/types.ts'
import { readFailExitCode } from '../../../spec/usage.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import { specOf } from '../../../spec/builtins.ts'
import { parseFlags as parseGrepFlags } from '../grep.ts'
import { groupLine } from '../../grep_binary.ts'
import { betweenFiles as rgBetweenFiles, parseFlags as parseRgFlags } from '../rg.ts'
import { encodeText } from '../../../../shell/bytes.ts'

// Run one native single-mount command per operand, in operand order. Each
// operand executes on its owning mount through `runSingle` (which also
// expands the operand's glob natively). Output is materialized and the lazy
// exit code synced, so combiners see final values.
/**
 * What sets one run's grep or rg output off from the next's. Both print a
 * separator between one file's context and the next file's (rg's own, or
 * none under --no-context-separator), and rg a blank line between --heading
 * groups, so the runs a line splits into join the way one run would. Nothing
 * for any other output, a plain line stream.
 */
export function runSeparator(cmdName: string, flagKwargs: Record<string, FlagValue>): string {
  if (cmdName === 'rg') {
    return rgBetweenFiles(parseRgFlags(new FlagView(flagKwargs, specOf('rg'))))
  }
  if (cmdName === 'grep') {
    return groupLine(parseGrepFlags(new FlagView(flagKwargs, specOf('grep'))))
  }
  return ''
}

export async function runOperands(
  runSingle: RunSingle,
  cmdName: string,
  scopes: PathSpec[],
  texts: string[],
  flagKwargs: Record<string, FlagValue>,
): Promise<OperandRun[]> {
  const results: OperandRun[] = []
  for (const scope of scopes) {
    const [out, io] = await runSingle(cmdName, [scope], texts, flagKwargs, {})
    const parts: Uint8Array[] = []
    try {
      for await (const part of chunks(out ?? new Uint8Array())) parts.push(part)
    } catch (e) {
      // A lazy stream can fail on first pull (head/tail opening the operand
      // mid-drain); report it like the native run would and keep the
      // remaining operands, GNU-style.
      if (!isFsError(e)) throw e
      const existing = await materialize(io.stderr)
      const line = encodeText(fsErrorLine(cmdName, scope, e))
      const merged = new Uint8Array(existing.byteLength + line.byteLength)
      merged.set(existing, 0)
      merged.set(line, existing.byteLength)
      io.stderr = merged
      // The command's own code for a failed read, not the catch-all: a
      // lazy operand that fails here is the same failure the single-mount
      // run reports eagerly, and it must answer the same number.
      io.exitCode = readFailExitCode(cmdName, e)
    }
    results.push({ scope, data: concatBytes(parts), io })
  }
  return results
}

// Merge per-operand IOResults in operand order under one exit code (each
// family has its own combine rule).
export async function mergeOperandIos(results: OperandRun[], exitCode: number): Promise<IOResult> {
  let io = new IOResult()
  for (const run of results) {
    io = await io.merge(run.io)
  }
  io.exitCode = exitCode
  // A merge keeps the last run's records; the operands' records are wanted
  // together and in order, since find's actions run once over all of them
  // at the command boundary (`-exec {} +` is one batch across start points,
  // as in GNU), each under its own operand. One run without them means the
  // whole selection is unstructured.
  io.records = results.every((run) => run.io.records !== null)
    ? results.flatMap((run, position) =>
        (run.io.records ?? []).map((record) => ({ ...record, run: position })),
      )
    : null
  return io
}

// Drop each mount prefix so a generic sees one flat namespace of full virtual
// paths; the relayed primitives route each full path to its owning mount. Used
// by transfer/compare where the generic does path arithmetic; read commands
// pass scopes through unchanged.
export function flatten(scopes: PathSpec[]): PathSpec[] {
  return scopes.map(virtualKey)
}

// Minimal Context for delegating a read/compare to a generic: only flags and
// stdin are read by those generics. The cross command always has path
// operands, so stdin is never consulted.
export function crossOpts(flagKwargs: Record<string, FlagValue>): Context {
  return {
    stdin: null,
    flags: flagKwargs,
    cwd: ROOT_CWD,
  }
}

export function statOp(dispatch: DispatchFn): (p: PathSpec) => Promise<FileStat> {
  return async (p: PathSpec) => {
    const [info] = await dispatch('stat', p)
    return info as FileStat
  }
}

export function readdirOp(
  dispatch: DispatchFn,
): (p: PathSpec, nofollow?: boolean) => Promise<string[]> {
  return async (p: PathSpec, nofollow?: boolean) => {
    const [entries] = await dispatch('readdir', p, [], nofollow === true ? { nofollow } : {})
    return (entries as string[] | null) ?? []
  }
}

/** A directory-aware streamed reader. Mirrors Python's `file_stream_op`. */
export function fileStreamOp(dispatch: DispatchFn): (p: PathSpec) => AsyncIterable<Uint8Array> {
  const stat = statOp(dispatch)
  async function* stream(path: PathSpec): AsyncIterable<Uint8Array> {
    if ((await stat(path)).type === FileType.DIRECTORY) throw eisdir(path)
    const [data] = await dispatch('read', path, [], { stream: true })
    yield* ensureStream(data as ByteSource)
  }
  return stream
}

export function streamOp(dispatch: DispatchFn): (p: PathSpec) => AsyncIterable<Uint8Array> {
  async function* gen(p: PathSpec): AsyncIterable<Uint8Array> {
    const [data] = await dispatch('read', p)
    yield (data as Uint8Array | null) ?? new Uint8Array()
  }
  return gen
}

/**
 * Copy one file store to store, from its mount onto `dst`'s. The dispatcher
 * judges the source as a read and the destination as a create, and answers
 * EXDEV when the destination's store cannot copy from the source's. Mirrors
 * Python's `_relay_copy`.
 */
export async function relayCopy(dispatch: DispatchFn, src: PathSpec, dst: PathSpec): Promise<void> {
  await dispatch('copy', src, [dst])
}

export function transferLinksOf(
  links: LinkView,
  dispatch: DispatchFn,
  cwd: string,
  owns?: (virtual: string) => boolean,
): TransferLinks {
  const relayStat = statOp(dispatch)
  return {
    links,
    dispatch,
    cwd,
    ...(owns !== undefined ? { owns } : {}),
    relay: {
      read: fileStreamOp(dispatch),
      write: async (p: PathSpec, data: ByteSource) => {
        await dispatch('write', p, [data])
      },
      mkdir: async (p: PathSpec) => {
        await dispatch('mkdir', p)
      },
      readdir: readdirOp(dispatch),
      copy: (src: PathSpec, dst: PathSpec) => relayCopy(dispatch, src, dst),
    },
    relayStat,
  }
}

/** Stream independent native reads in order, keeping at most four invocations open. */
export function streamOperands(
  runSingle: RunSingle,
  cmdName: string,
  scopes: readonly PathSpec[],
  texts: string[],
  bag: Record<string, FlagValue>,
  separator = '',
): [ByteSource, IOResult] {
  const io = new IOResult()
  async function* stream(): AsyncGenerator<Uint8Array> {
    const controller = new AbortController()
    const pending: {
      scope: PathSpec
      result: Promise<readonly [ByteSource | null, IOResult]>
      ready?: readonly [ByteSource | null, IOResult]
    }[] = []
    let next = 0
    let printed = false
    const start = (): void => {
      const scope = scopes[next++]
      if (scope === undefined) return
      const result = runSingle(cmdName, [scope], texts, bag, { signal: controller.signal })
      // Attach a rejection observer immediately while earlier operands drain.
      void result.catch(() => undefined)
      const item: (typeof pending)[number] = { scope, result }
      void result.then(
        (ready) => {
          item.ready = ready
        },
        () => undefined,
      )
      pending.push(item)
    }
    const concurrency = scopes.some((p) => isStdin(p)) ? 1 : OPERAND_CONCURRENCY
    for (let i = 0; i < concurrency; i++) start()
    try {
      while (pending.length > 0) {
        const head = pending[0]
        if (head === undefined) break
        const { scope, result } = head
        const [out, branch] = await abortable(result, controller.signal)
        let first = true
        try {
          for await (const data of chunks(out ?? new Uint8Array(), controller.signal)) {
            if (data.byteLength === 0) continue
            if (first && printed && separator !== '') yield encodeText(separator)
            first = false
            printed = true
            yield data
          }
        } catch (err) {
          if (!isFsError(err)) throw err
          branch.stderr = concatBytes([
            await materialize(branch.stderr),
            encodeText(fsErrorLine(cmdName, scope, err)),
          ])
          branch.exitCode = readFailExitCode(cmdName, err)
        }
        io.stderr = concatBytes([await materialize(io.stderr), await materialize(branch.stderr)])
        io.exitCode = Math.max(io.exitCode, branch.exitCode)
        if (branch.refusal !== null) io.refusal = branch.refusal
        pending.shift()
        start()
      }
    } finally {
      controller.abort()
      for (const item of pending) {
        if (item.ready !== undefined) await discardStreams(item.ready[0], item.ready[1].stderr)
        else
          void item.result.then(
            ([out, branch]) => discardStreams(out, branch.stderr),
            () => undefined,
          )
      }
    }
  }
  return [stream(), io]
}
