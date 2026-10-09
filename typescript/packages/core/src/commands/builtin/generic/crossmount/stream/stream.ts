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

import { concat } from '../../../../../io/cachable_iterator.ts'
import { OutputStream } from '../../../../../io/stdio.ts'
import { asyncChain, closeQuietly, drain } from '../../../../../io/stream.ts'
import { readFailExitCodeFromLine } from '../../../../spec/usage.ts'
import { IOResult, OutputState, materialize, type ByteSource } from '../../../../../io/types.ts'
import type { PathSpec } from '../../../../../types.ts'
import { revoiceFsErrorLine } from '../../../../../errors/render.ts'
import { LINE_STREAM_COMMANDS } from '../constants.ts'
import { Cmd, type CrossResult, type RunSingle } from '../types.ts'
import type { FlagValue } from '../../../../spec/types.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

function hasActiveFlags(flagKwargs: Record<string, FlagValue>): boolean {
  return Object.values(flagKwargs).some((v) => v !== false)
}

// One operand's bytes, its last line ended where the file ends: what a line
// reader sees at a file boundary, so `ab` followed by the next file's `cd` is
// two lines, the way the single-mount commands join their operands. Mirrors
// Python's _line_ended.
async function* lineEnded(source: ByteSource): AsyncIterable<Uint8Array> {
  let last = 0x0a
  for await (const chunk of asyncChain([source])) {
    if (chunk.byteLength > 0) last = chunk[chunk.byteLength - 1] ?? 0x0a
    yield chunk
  }
  if (last !== 0x0a) yield Uint8Array.of(0x0a)
}

// The per-operand fetch is a native Cmd.CAT sub-run, so its error lines
// carry the fetch command's voice; each is said again in the real command's
// (its prefix, its quoting, the step it names) so the cross-mount bytes
// match single-mount.
function respellFetchStderr(stderr: Uint8Array, cmdName: string, scope: PathSpec): Uint8Array {
  const lines = DEC.decode(stderr).split('\n')
  const respelled = lines.map((line) => revoiceFsErrorLine(line, Cmd.CAT, cmdName, scope))
  return ENC.encode(respelled.join('\n'))
}

// Run a stream command (`cmd files...` == `cat files... | cmd`). Each
// operand's raw bytes come from a native flagless `cat` on its owning mount
// (which also expands the operand's glob natively); one native run of the
// real command then consumes the merged stream in its stdin mode, so every
// flag keeps its single-invocation semantics (continuous `cat -n`/`nl`
// numbering, one global `sort` order, one `sed` address space). A failed
// operand is skipped and reported on stderr, cat-style; the merged exit code
// is then non-zero.
export async function runStream(
  cmdName: Cmd,
  scopes: PathSpec[],
  textArgs: string[],
  flagKwargs: Record<string, FlagValue>,
  runSingle: RunSingle,
): Promise<CrossResult> {
  const result = new IOResult()
  const state = new OutputState()
  result.output = state
  const fetches: { scope: PathSpec; out: ByteSource | null; io: IOResult }[] = []
  let sources: ByteSource[] = []
  async function finish(final: IOResult | null = null): Promise<void> {
    let merged = new IOResult()
    let failCode = 0
    for (const { scope, io } of fetches) {
      if (io.exitCode !== 0) {
        let rendered = await materialize(io.stderr)
        if (cmdName !== Cmd.CAT) rendered = respellFetchStderr(rendered, cmdName, scope)
        io.stderr = rendered
        failCode = Math.max(failCode, readFailExitCodeFromLine(cmdName, DEC.decode(rendered)), 1)
        io.exitCode = 0
      }
      merged = await merged.merge(io)
    }
    if (final !== null) merged = await merged.merge(final)
    result.reads = merged.reads
    result.writes = merged.writes
    result.cache = merged.cache
    result.renames = merged.renames
    result.matchedRuns = merged.matchedRuns
    result.sizedRuns = merged.sizedRuns
    result.countedRuns = merged.countedRuns
    result.refusal = result.refusal ?? merged.refusal
    const stderr = concat([await materialize(merged.stderr), await materialize(result.stderr)])
    result.stderr = stderr.byteLength > 0 ? stderr : null
    result.exitCode = result.exitCode || merged.exitCode || failCode
    state.finish()
  }
  async function closeFetches(): Promise<void> {
    await Promise.all(fetches.map(({ out }) => closeQuietly(out)))
  }
  let out: ByteSource | null
  let final: IOResult | null = null
  try {
    for (const scope of scopes) {
      const [source, io] = await runSingle(Cmd.CAT, [scope], [], {})
      fetches.push({ scope, out: source, io })
      result.producer = io.producer
      result.refusal = io.refusal ?? result.refusal
      if (io.exitCode !== 0) await drain(source)
      else if (source !== null) sources.push(source)
    }
    if (cmdName === Cmd.SORT && fetches.some(({ io }) => io.exitCode !== 0)) {
      await closeFetches()
      await finish()
      return [null, result]
    }
    if (LINE_STREAM_COMMANDS.has(cmdName) && sources.length > 0)
      sources = [...sources.slice(0, -1).map(lineEnded), ...sources.slice(-1)]
    const body: ByteSource = asyncChain(sources)
    if (cmdName === Cmd.CAT && !hasActiveFlags(flagKwargs)) out = body
    else
      [out, final] = await runSingle(cmdName, [], [...textArgs], flagKwargs, {
        stdin: body,
        resolveHint: scopes[0] ?? null,
      })
    if (final !== null) {
      result.producer = final.producer
      result.refusal = final.refusal ?? result.refusal
    }
  } catch (error) {
    await closeFetches()
    throw error
  }
  let closing: Promise<void> | undefined
  async function finalize(): Promise<void> {
    await Promise.all([closeQuietly(out), closeFetches()])
    await finish(final)
  }
  function close(): Promise<void> {
    return (closing ??= finalize())
  }
  async function* output(): AsyncGenerator<Uint8Array> {
    try {
      for await (const data of asyncChain(out === null ? [] : [out])) {
        if (cmdName !== Cmd.SORT || !fetches.some(({ io }) => io.exitCode !== 0)) yield data
      }
    } finally {
      await close()
    }
  }
  return [new OutputStream(output(), close), result]
}
