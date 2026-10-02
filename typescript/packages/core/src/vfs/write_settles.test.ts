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
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { calls, wiredWriteImport, wrappedSource } from '../test-utils.ts'

type Writer = (...args: never[]) => Promise<void>

interface Wired {
  write: Writer
  /** The name the defining module exports `write` under. */
  exported: string
  /** The source of the module that defines `write`. */
  module: string
}

/** Every whole-file `write` an IO table under `builtinDir` wires, by backend. */
async function wiredWriters(builtinDir: string): Promise<Map<string, Wired>> {
  const found = new Map<string, Wired>()
  for (const name of readdirSync(builtinDir).sort()) {
    const ioPath = join(builtinDir, name, 'io.ts')
    if (!existsSync(ioPath)) continue
    const wired = wiredWriteImport(readFileSync(ioPath, 'utf8'))
    if (wired === null) continue
    const file = join(dirname(ioPath), wired.from)
    const write = ((await import(file)) as Record<string, unknown>)[wired.exported]
    if (typeof write !== 'function') continue
    found.set(name, {
      write: write as Writer,
      exported: wired.exported,
      module: readFileSync(file, 'utf8'),
    })
  }
  return found
}

const BUILTIN = join(dirname(fileURLToPath(import.meta.url)), '../commands/builtin')

describe('every whole-file write settles instead of invalidating', async () => {
  const writers = await wiredWriters(BUILTIN)

  it('the scan reaches every whole-file writer', () => {
    // A scan that found nothing would pass every assertion below.
    expect([...writers.keys()]).toEqual(
      expect.arrayContaining(['onedrive', 'sharepoint', 's3', 'ram', 'dropbox']),
    )
  })

  for (const [name, { write, exported, module }] of writers) {
    it(name, () => {
      // A writer holds the file's full new bytes, so it settles them with
      // the cache; one that still only invalidates would drop what it
      // wrote, and applyIo no longer stores written paths. A writer wrapped
      // out of sight (an error translator) is judged by the function it
      // wraps.
      const own = write.toString()
      const source = calls(own, 'settleAfterWrite') ? own : (wrappedSource(module, exported) ?? own)
      expect(calls(source, 'settleAfterWrite')).toBe(true)
      expect(calls(source, 'writeGeneration')).toBe(true)
      expect(calls(source, 'invalidateAfterWrite')).toBe(false)
    })
  }
})
