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
    vfsPath: mountKey(path, ''),
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

describe('runFanout rg labels and -q', () => {
  it('labels every rg run unless -I is the last word on it', async () => {
    const runs = async (flags: Record<string, boolean>): Promise<Call[]> => {
      const { fn, calls } = fakeRunSingle({ '/a/x': '', '/b/y': '' })
      await runFanout(Cmd.RG, [scope('/a/x'), scope('/b/y')], ['pat'], flags, fn)
      return calls
    }
    expect((await runs({})).every((c) => c.flags.with_filename === true)).toBe(true)
    expect((await runs({ no_filename: true })).every((c) => !('with_filename' in c.flags))).toBe(
      true,
    )
    // -H and -I are last-wins in ripgrep, so a -H after -I labels again.
    const again = await runs({ no_filename: true, with_filename: true })
    expect(again.every((c) => c.flags.with_filename === true)).toBe(true)
  })

  it.each([
    [Cmd.GREP, { q: true }],
    [Cmd.RG, { quiet: true }],
  ])('stops %s -q at its first match', async (cmd, flags) => {
    // grep -q and rg -q exit at the first match, so the operands after it
    // are never read (GNU grep 3.11, ripgrep 14.1.1: `rg -q x a /nope` says
    // nothing about /nope).
    const { fn, calls } = fakeRunSingle({ '/a/x': '', '/b/y': '' })
    const [, io] = await runFanout(cmd, [scope('/a/x'), scope('/b/y')], ['pat'], flags, fn)
    expect(calls.map((c) => c.paths)).toEqual([['/a/x']])
    expect(io.exitCode).toBe(0)
  })
})

// GNU grep 3.11 and ripgrep 14.1.1 put `--` between one file's context and the
// next file's, so runs on different mounts join the same way; a run that
// printed nothing adds no separator.
describe('runFanout grep and rg context', () => {
  it.each([
    [Cmd.GREP, { A: '1' }],
    [Cmd.RG, { after_context: '1' }],
  ])('separates %s context runs', async (cmd, flags) => {
    const { fn } = fakeRunSingle({
      '/a/x': '/a/x:hit\n/a/x-next\n',
      '/c/w': '',
      '/b/y': '/b/y:hit\n/b/y-next\n',
    })
    const [out] = await runFanout(
      cmd,
      [scope('/a/x'), scope('/c/w'), scope('/b/y')],
      ['hit'],
      flags,
      fn,
    )
    expect(await text(out)).toBe('/a/x:hit\n/a/x-next\n--\n/b/y:hit\n/b/y-next\n')
  })

  it.each([
    [{ after_context: '1', context_separator: '@@' }, '/a/x:hit\n@@\n/b/y:hit\n'],
    [{ after_context: '1', no_context_separator: true }, '/a/x:hit\n/b/y:hit\n'],
    [{ heading: true }, '/a/x:hit\n\n/b/y:hit\n'],
  ])('joins rg runs with its own separator: %j', async (flags, joined) => {
    // ripgrep 14.1.1 sets files apart with its --context-separator (none
    // under --no-context-separator), and --heading groups with a blank line.
    const { fn } = fakeRunSingle({ '/a/x': '/a/x:hit\n', '/b/y': '/b/y:hit\n' })
    const [out] = await runFanout(Cmd.RG, [scope('/a/x'), scope('/b/y')], ['hit'], flags, fn)
    expect(await text(out)).toBe(joined)
  })

  it.each([
    [Cmd.GREP, { A: '1', c: true }],
    [Cmd.RG, { after_context: '1', count: true }],
  ])('joins %s counts without a separator', async (cmd, flags) => {
    const { fn } = fakeRunSingle({ '/a/x': '/a/x:1\n', '/b/y': '/b/y:1\n' })
    const [out] = await runFanout(cmd, [scope('/a/x'), scope('/b/y')], ['hit'], flags, fn)
    expect(await text(out)).toBe('/a/x:1\n/b/y:1\n')
  })
})
