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

import { mountKey } from '../../../../utils/key_prefix.ts'
import { IOResult, materialize } from '../../../../io/types.ts'
import type { Resource } from '../../../../resource/base.ts'
import { type FileStat, PathSpec } from '../../../../types.ts'
import type { CommandOpts } from '../../../config.ts'
import type { DispatchFn, OperandRun, RunSingle } from './types.ts'

// Run one native single-mount command per operand, in operand order. Each
// operand executes on its owning mount through `runSingle` (which also
// expands the operand's glob natively). Output is materialized and the lazy
// exit code synced, so combiners see final values.
export async function runOperands(
  runSingle: RunSingle,
  cmdName: string,
  scopes: PathSpec[],
  texts: string[],
  flagKwargs: Record<string, string | boolean | string[]>,
  stdinBytes: Uint8Array | null = null,
): Promise<OperandRun[]> {
  const results: OperandRun[] = []
  for (const scope of scopes) {
    const [out, io] = await runSingle(cmdName, [scope], texts, flagKwargs, {
      stdin: stdinBytes,
    })
    const data = out !== null ? await materialize(out) : new Uint8Array()
    io.syncExitCode()
    results.push({ scope, data, io })
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
  return io
}

class CrossResourceStub implements Resource {
  readonly kind = 'cross'
  open(): Promise<void> {
    return Promise.resolve()
  }
  close(): Promise<void> {
    return Promise.resolve()
  }
}

const CROSS_RESOURCE = new CrossResourceStub()

// Drop each mount prefix so a generic sees one flat namespace of full virtual
// paths; the relayed primitives route each full path to its owning mount. Used
// by transfer/compare where the generic does path arithmetic; read commands
// pass scopes through unchanged.
export function flatten(scopes: PathSpec[]): PathSpec[] {
  return scopes.map(
    (s) =>
      new PathSpec({
        virtual: s.virtual,
        directory: s.directory,
        pattern: s.pattern,
        resolved: s.resolved,
        resourcePath: mountKey(s.virtual, ''),
        rawPath: s.rawPath,
      }),
  )
}

// Minimal CommandOpts for delegating a read/compare to a generic: only flags,
// mountPrefix and stdin are read by those generics. The cross command always
// has path operands, so stdin is never consulted.
export function crossOpts(flagKwargs: Record<string, string | boolean | string[]>): CommandOpts {
  return {
    stdin: null,
    flags: flagKwargs,
    filetypeFns: null,
    mountPrefix: '',
    cwd: '/',
    resource: CROSS_RESOURCE,
  }
}

export function statOp(dispatch: DispatchFn): (p: PathSpec) => Promise<FileStat> {
  return async (p: PathSpec) => {
    const [info] = await dispatch('stat', p)
    return info as FileStat
  }
}

export function readdirOp(dispatch: DispatchFn): (p: PathSpec) => Promise<string[]> {
  return async (p: PathSpec) => {
    const [entries] = await dispatch('readdir', p)
    return (entries as string[] | null) ?? []
  }
}

export function readBytesOp(dispatch: DispatchFn): (p: PathSpec) => Promise<Uint8Array> {
  return async (p: PathSpec) => {
    const [data] = await dispatch('read', p)
    return (data as Uint8Array | null) ?? new Uint8Array()
  }
}

export function streamOp(dispatch: DispatchFn): (p: PathSpec) => AsyncIterable<Uint8Array> {
  const readBytes = readBytesOp(dispatch)
  async function* gen(p: PathSpec): AsyncIterable<Uint8Array> {
    yield await readBytes(p)
  }
  return gen
}
