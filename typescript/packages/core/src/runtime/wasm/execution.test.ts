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
import { answerOf } from '../binding.ts'
import type { RunAnswer } from '../types.ts'
import { GuestHost, type GuestEnd } from './execution.ts'
import { WasmView } from './view.ts'

const DEC = new TextDecoder()

/** How a run that ended as `end` answers, its writes kept whole. */
function ended(end: GuestEnd): Promise<RunAnswer> {
  const halt = new AbortController().signal
  return answerOf(async (output, errors) => ({
    exitCode: await new GuestHost(new WasmView(), null, output, errors, halt, 'probe').result(end),
  }))
}

describe('GuestHost.result', () => {
  // A trap's message reaches the run's stderr last, beside its status.
  it('says a trap on errors', async () => {
    const done = await ended({ exitCode: 1, trap: 'wasm trap: unreachable', lost: [] })
    expect([done.exitCode, DEC.decode(done.stdout), DEC.decode(done.stderr)]).toEqual([
      1,
      '',
      'probe: wasm trap: unreachable\n',
    ])
  })

  // A file whose writes could not land is said too, and turns a clean exit
  // into a failure.
  it('says each lost landing and fails a clean exit', async () => {
    const done = await ended({ exitCode: 0, trap: null, lost: ['/data/a: No space left'] })
    expect([done.exitCode, DEC.decode(done.stderr)]).toEqual([1, 'probe: /data/a: No space left\n'])
  })

  it('says nothing for a run that exited', async () => {
    expect(await ended({ exitCode: 3, trap: null, lost: [] })).toEqual({
      exitCode: 3,
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
    })
  })
})
