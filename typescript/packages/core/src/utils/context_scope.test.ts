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
import { createAsyncContext } from './async_context.ts'
import { ContextScope } from './context_scope.ts'

it('retains the producer context during lazy reads and close', async () => {
  const current = createAsyncContext<string>()
  const closed: string[] = []
  const scope = current.run('producer', () => new ContextScope([current.capture()])) as ContextScope
  async function* source() {
    try {
      yield await Promise.resolve(current.getStore())
      yield await Promise.resolve(current.getStore())
    } finally {
      closed.push(current.getStore() ?? '')
    }
  }
  const stream = scope.stream(source())
  expect((await stream.next()).value).toBe('producer')
  expect(current.getStore()).toBeUndefined()
  expect((await stream.next()).value).toBe('producer')
  await stream.return(undefined)
  expect(closed).toEqual(['producer'])
  expect(current.getStore()).toBeUndefined()
})

it('replays the whole producer context, as Python copies it', async () => {
  // A store the scopes do not name keeps the producer's value too, and the
  // scope is entered once rather than on every call.
  const named = createAsyncContext<string>()
  const unnamed = createAsyncContext<string>()
  let entered = 0
  const scope = unnamed.run('producer', () =>
    named.run('producer', () => {
      const capture = named.capture()
      return new ContextScope([
        (fn) => {
          entered += 1
          return capture(fn)
        },
      ])
    }),
  ) as ContextScope
  const seen = await unnamed.run('consumer', () =>
    scope.run(async () => {
      await Promise.resolve()
      return [named.getStore(), unnamed.getStore()]
    }),
  )
  await scope.run(() => Promise.resolve())
  expect(seen).toEqual(['producer', 'producer'])
  expect(entered).toBe(1)
})
