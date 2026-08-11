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

import { describe, expect, it } from 'vitest'
import { IOResult, materialize, type ByteSource } from '../../../../../io/types.ts'
import { PathSpec } from '../../../../../types.ts'
import { mountKey } from '../../../../../utils/key_prefix.ts'
import { Cmd, type CrossResult, type RunSingle } from '../types.ts'
import { runFanout } from './fanout.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

function scope(path: string): PathSpec {
  return new PathSpec({
    virtual: path,
    directory: path.slice(0, path.lastIndexOf('/') + 1),
    resolved: true,
    resourcePath: mountKey(path, ''),
  })
}

interface Call {
  cmd: string
  paths: string[]
  flags: Record<string, string | boolean | number | string[]>
}

function fakeRunSingle(outputs: Record<string, string>): { fn: RunSingle; calls: Call[] } {
  const calls: Call[] = []
  const fn: RunSingle = (cmdName, paths, _texts, flagKwargs): Promise<CrossResult> => {
    calls.push({
      cmd: cmdName,
      paths: paths.map((p) => p.virtual),
      flags: { ...flagKwargs },
    })
    const key = paths[0]?.virtual ?? ''
    return Promise.resolve([ENC.encode(outputs[key] ?? ''), new IOResult()])
  }
  return { fn, calls }
}

async function text(body: ByteSource | null): Promise<string> {
  if (body === null) return ''
  return DEC.decode(await materialize(body))
}

describe('runFanout wc', () => {
  it('forces --total=never on the native runs', async () => {
    const { fn, calls } = fakeRunSingle({
      '/a/x': '1 1 1 /a/x\n',
      '/b/y': '2 2 2 /b/y\n',
    })
    await runFanout(Cmd.WC, [scope('/a/x'), scope('/b/y')], [], {}, fn)
    expect(calls.map((c) => c.flags.total)).toEqual(['never', 'never'])
  })

  it('rejects an invalid --total before running any operand', async () => {
    // The forced override would otherwise hide the bad value from every
    // native run, leaving exit 0 and no diagnostic.
    const { fn, calls } = fakeRunSingle({ '/a/x': '', '/b/y': '' })
    const [body, io] = await runFanout(
      Cmd.WC,
      [scope('/a/x'), scope('/b/y')],
      [],
      { total: 'bogus' },
      fn,
    )
    expect(await text(body)).toBe('')
    expect(io.exitCode).toBe(1)
    expect(await text(io.stderr)).toBe("wc: invalid argument 'bogus' for '--total'\n")
    expect(calls).toEqual([])
  })
})
