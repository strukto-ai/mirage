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
import { IOResult } from '../../../../../io/types.ts'
import type { FlagValue } from '../../../../spec/types.ts'
import { PathSpec } from '../../../../../types.ts'
import { mountKey } from '../../../../../utils/key_prefix.ts'
import { Cmd, type CrossResult, type RunSingle } from '../types.ts'
import { runFanout } from './fanout.ts'

const ENC = new TextEncoder()

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
  flags: Record<string, FlagValue>
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

describe('runFanout -q', () => {
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
