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

import { IOResult, materialize } from '../../../../../io/types.ts'
import { PathSpec } from '../../../../../types.ts'
import type { FlagValue } from '../../../../spec/types.ts'
import { Cmd, type RunSingle } from '../types.ts'
import { runStream } from './stream.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

interface Call {
  cmd: string
  flags: Record<string, FlagValue>
}

// Serves bytes for some operands and a cat-voiced failure for others, and
// records what the run over the merged stream was handed. Mirrors
// FetchFailures in test_stream.py.
class Fetches {
  readonly calls: Call[] = []
  finalStdin: Uint8Array | null = null

  constructor(
    private readonly files: Record<string, string>,
    private readonly failures: Record<string, string> = {},
  ) {}

  readonly run: RunSingle = async (cmd, paths, _texts, flags, extra) => {
    this.calls.push({ cmd, flags: { ...flags } })
    const path = paths[0]?.virtual
    if (cmd === 'cat' && path !== undefined) {
      const failure = this.failures[path]
      if (failure !== undefined) {
        return [
          null,
          new IOResult({ exitCode: 1, stderr: ENC.encode(`cat: ${path}: ${failure}\n`) }),
        ]
      }
      return [ENC.encode(this.files[path] ?? ''), new IOResult()]
    }
    const stdin = extra?.stdin ?? null
    this.finalStdin = stdin === null ? null : await materialize(stdin)
    return [ENC.encode('FINAL'), new IOResult()]
  }
}

function scopes(...virtuals: string[]): PathSpec[] {
  return virtuals.map((virtual) => PathSpec.fromStrPath(virtual))
}

describe('runStream', () => {
  it('ends a line reader file at its boundary and keeps cat bytewise', async () => {
    const fetches = new Fetches({ '/a/x': 'ab', '/b/y': 'cd' })
    await runStream(Cmd.CUT, scopes('/a/x', '/b/y'), [], {}, fetches.run)
    expect(DEC.decode(fetches.finalStdin ?? undefined)).toBe('ab\ncd')
    await runStream(Cmd.CAT, scopes('/a/x', '/b/y'), [], { n: true }, fetches.run)
    expect(DEC.decode(fetches.finalStdin ?? undefined)).toBe('abcd')
  })
})
