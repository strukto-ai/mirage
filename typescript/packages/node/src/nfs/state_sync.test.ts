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

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const STATE_CLASSES: [string, string][] = [
  ['IdTable', 'ids.ts'],
  ['WriteBuffer', '../mount/writebuf.ts'],
]

// The python twin walks an AST, which never sees a comment; this reads
// source text, so the prose about staying await-free has to go first.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

function classBody(name: string, file: string): string {
  const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8')
  const opening = source.indexOf(`export class ${name} {`)
  expect(opening).toBeGreaterThan(-1)
  let depth = 0
  for (let i = source.indexOf('{', opening); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return stripComments(source.slice(opening, i + 1))
    }
  }
  throw new Error(`unterminated class ${name} in ${file}`)
}

describe('adapter state', () => {
  // The state holders carry no lock because the event loop cannot
  // interleave a synchronous function: each runs to completion before
  // another callback proceeds. One await inside any of these methods
  // breaks that invariant silently, and a lock would not restore it —
  // the fix would be to keep the state consistent in the caller.
  // Python's twin is tests/nfs/test_state_is_await_free.py.
  it.each(STATE_CLASSES)('%s stays await-free', (name, file) => {
    const body = classBody(name, file)
    expect(body).not.toMatch(/\basync\b/)
    expect(body).not.toMatch(/\bawait\b/)
    expect(body).not.toMatch(/\bPromise\b/)
  })

  it.each(STATE_CLASSES)('%s holds no lock', (name, file) => {
    // No concurrency primitives: mirage spawns no threads for NFS, and
    // a worker would not share this state anyway.
    const body = classBody(name, file)
    expect(body).not.toMatch(/\b(Mutex|Semaphore|Atomics|SharedArrayBuffer)\b/)
  })
})
