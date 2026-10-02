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

type Writer = (...args: never[]) => Promise<void>

interface Wired {
  write: Writer
  /** The source of the module that defines `write`. */
  module: string
}

const IMPORT = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*'([^']+)'/g

/**
 * The function an IO table source wires as its whole-file `write`, loaded
 * from the module that defines it rather than read off the built table,
 * which may wrap it (an error translator, a renderer) out of sight.
 */
async function wiredWrite(ioPath: string, source: string): Promise<Wired | null> {
  const writes = /\bwrites:\s*\{([^}]*)\}/.exec(source)?.[1] ?? ''
  const entry = /(?:^|[\s,])write(?::\s*([A-Za-z_$][\w$]*))?\s*(?:,|$)/m.exec(writes)
  if (entry === null) return null
  const wired = entry[1] ?? 'write'
  for (const [, names = '', from = ''] of source.matchAll(IMPORT)) {
    for (const item of names.split(',')) {
      const [exported = '', local = exported] = item.trim().split(/\s+as\s+/)
      if (local !== wired) continue
      const file = join(dirname(ioPath), from)
      const module = (await import(file)) as Record<string, unknown>
      const write = module[exported]
      if (typeof write !== 'function') return null
      return { write: write as Writer, module: readFileSync(file, 'utf8') }
    }
  }
  return null
}

/** Every whole-file `write` an IO table under `builtinDir` wires, by backend. */
async function wiredWriters(builtinDir: string): Promise<Map<string, Wired>> {
  const found = new Map<string, Wired>()
  for (const name of readdirSync(builtinDir).sort()) {
    const ioPath = join(builtinDir, name, 'io.ts')
    if (!existsSync(ioPath)) continue
    const wired = await wiredWrite(ioPath, readFileSync(ioPath, 'utf8'))
    if (wired !== null) found.set(name, wired)
  }
  return found
}

/** Whether `source` calls `name`, however the transform spelled the import. */
function calls(source: string, name: string): boolean {
  return new RegExp(`\\b${name}\\)?\\(`).test(source)
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

  for (const [name, { write, module }] of writers) {
    it(name, () => {
      // A writer holds the file's full new bytes, so it settles them with
      // the cache; one that still only invalidates would drop what it
      // wrote, and applyIo no longer stores written paths. A writer wrapped
      // out of sight (an error translator) is judged by its module.
      const own = write.toString()
      const source = calls(own, 'settleAfterWrite') ? own : module
      expect(calls(source, 'settleAfterWrite')).toBe(true)
      expect(calls(source, 'writeGeneration')).toBe(true)
      expect(calls(source, 'invalidateAfterWrite')).toBe(false)
    })
  }
})
