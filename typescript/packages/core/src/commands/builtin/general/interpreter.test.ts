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
import type { LanguageRuntime } from '../../../runtime/language.ts'
import type { Context } from '../../config.ts'
import { runInterpreter } from './interpreter.ts'

describe('runInterpreter', () => {
  // A kill reaches the interpreter as an abort, which stops the job that
  // ran it; it is no failure of the program's to report on stderr.
  it('lets an abort through rather than reporting it', async () => {
    const abort = new AbortController()
    abort.abort()
    const runtime = {
      execute: () => Promise.reject(new DOMException('execute aborted', 'AbortError')),
    } as unknown as LanguageRuntime
    const ctx = { signal: abort.signal } as unknown as Context
    await expect(runInterpreter('python3', runtime, [], [], ctx, null)).rejects.toMatchObject({
      name: 'AbortError',
    })
  })
})
