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
import { IOResult, materialize } from '../../../../io/types.ts'
import { PathSpec } from '../../../../types.ts'
import type { RunSingle } from './types.ts'
import { streamOperands } from './utils.ts'

const reporting: RunSingle = (_cmd, operands) => {
  const virtual = operands[0]?.virtual ?? ''
  async function* out(): AsyncGenerator<Uint8Array> {
    await Promise.resolve()
    yield new TextEncoder().encode(`${virtual}\n`)
    yield new TextEncoder().encode(`${virtual}/x\n`)
  }
  const io = new IOResult({
    stderr: new TextEncoder().encode("find: '/m1/c': Permission denied\n"),
    exitCode: 1,
  })
  return Promise.resolve([out(), io])
}

it('keeps what a run reported when its reader stops inside it', async () => {
  const scopes = [PathSpec.fromStrPath('/m1'), PathSpec.fromStrPath('/m2')]
  const [stream, io] = streamOperands(reporting, 'find', scopes, [], {})
  const output = (stream as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
  const first = await output.next()
  expect(new TextDecoder().decode(first.value as Uint8Array)).toBe('/m1\n')
  await output.return?.()
  expect(new TextDecoder().decode(await materialize(io.stderr))).toBe(
    "find: '/m1/c': Permission denied\n",
  )
  expect(io.exitCode).toBe(1)
})
