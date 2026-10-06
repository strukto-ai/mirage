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

import { expect, it } from 'vitest'
import { IOResult, materialize } from '../../../../../io/types.ts'
import { PathSpec } from '../../../../../types.ts'
import { enoent } from '../../../../../errors/fs.ts'
import type { Cmd, CrossResult } from '../types.ts'
import { runFanout } from './fanout.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

// Serves canned per-operand outputs and records the calls in flight.
function fakeRunSingle(outputs: Record<string, string | Error>) {
  const state = { calls: [] as [string, Record<string, unknown>][], open: 0, peak: 0 }
  const run = async (
    _cmd: string,
    paths: PathSpec[],
    _texts: string[],
    flags: Record<string, unknown>,
  ): Promise<CrossResult> => {
    const virtual = paths[0]?.virtual ?? ''
    state.calls.push([virtual, { ...flags }])
    state.open += 1
    state.peak = Math.max(state.peak, state.open)
    await Promise.resolve()
    const out = outputs[virtual]
    async function* stream(): AsyncIterable<Uint8Array> {
      try {
        if (out instanceof Error) throw out
        yield await Promise.resolve(ENC.encode(out ?? ''))
      } finally {
        state.open -= 1
      }
    }
    return [stream(), new IOResult()]
  }
  return { run, state }
}

it('head names every operand and joins with a blank line', async () => {
  const { run, state } = fakeRunSingle({
    '/a/x': '==> /a/x <==\n1\n',
    '/b/y': '==> /b/y <==\n2\n',
  })
  const [out, io] = await runFanout(
    'head' as Cmd,
    [PathSpec.fromStrPath('/a/x'), PathSpec.fromStrPath('/b/y')],
    [],
    {},
    run,
  )
  expect(DEC.decode(await materialize(out))).toBe('==> /a/x <==\n1\n\n==> /b/y <==\n2\n')
  expect(state.calls.every(([, flags]) => flags.verbose === true)).toBe(true)
  expect(io.exitCode).toBe(0)
})

it('reads prepare at most four ahead in operand order', async () => {
  const names = Array.from({ length: 7 }, (_, i) => `/m${String(i)}/f`)
  const { run, state } = fakeRunSingle(Object.fromEntries(names.map((n) => [n, n + '\n'])))
  const [out] = await runFanout(
    'rev' as Cmd,
    names.map((n) => PathSpec.fromStrPath(n)),
    [],
    {},
    run,
  )
  expect(DEC.decode(await materialize(out))).toBe(names.map((n) => n + '\n').join(''))
  expect(state.calls.map(([p]) => p)).toEqual(names)
  expect(state.peak).toBeLessThanOrEqual(4)
})

it('a failed read keeps the rest and settles the status', async () => {
  const { run } = fakeRunSingle({ '/a/x': enoent('/a/x'), '/b/y': 'ok\n' })
  const [out, io] = await runFanout(
    'rev' as Cmd,
    [PathSpec.fromStrPath('/a/x'), PathSpec.fromStrPath('/b/y')],
    [],
    {},
    run,
  )
  expect(io.exitCode).toBe(0)
  expect(DEC.decode(await materialize(out))).toBe('ok\n')
  expect(io.exitCode).toBe(1)
  expect(DEC.decode(await materialize(io.stderr))).toBe(
    'rev: cannot open /a/x: No such file or directory\n',
  )
})
