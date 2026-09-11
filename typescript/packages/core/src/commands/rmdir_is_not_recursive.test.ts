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

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// rmdir(2) refuses a non-empty directory; `rm -r` is what empties one.
// Implementing rmdir AS the recursive removal silently turns it into a
// subtree delete for every caller that does not pre-check emptiness itself,
// and the command builders are the only callers that do -- FUSE, `ws.fs`
// and the sandbox runtimes all reach the op directly. That is the shape the
// bug took in five backends at once: two took the object store kit's prefix
// delete, three called their own recursive removal.
//
// This is a source scan rather than an import-and-compare, because the
// backends live in three packages and `core` cannot import from `node` or
// `browser`. Mirrors python's
// tests/commands/test_rmdir_is_not_recursive.py, which compares the wired
// functions' provenance directly.
const PACKAGES = ['core', 'node', 'browser']

// `export const rmdir = makeRemovePrefix(DRIVER)` — the kit's recursive
// prefix delete standing in for rmdir.
const KIT_ALIAS = /\brmdir\s*=\s*makeRemovePrefix\s*\(/

// `export async function rmdir(...) { await rmR(accessor, path) }` — a body
// whose only statement hands off to the recursive removal.
const BODY_ALIAS =
  /function\s+rmdir\b[^{]*\{\s*(?:return\s+)?(?:await\s+)?(?:this\.)?rm(?:R|_r)\s*\([^)]*\)\s*;?\s*\}/

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      yield* sourceFiles(full)
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      yield full
    }
  }
}

function coreRoots(): string[] {
  const packagesDir = join(import.meta.dirname, '..', '..', '..')
  return PACKAGES.map((name) => join(packagesDir, name, 'src', 'core')).filter((dir) =>
    existsSync(dir),
  )
}

describe('rmdir is not the recursive removal', () => {
  it('scans every package that ships backends', () => {
    // A guard on the guard: a path that stopped resolving would make the
    // assertion below vacuous.
    const roots = coreRoots()
    expect(roots.length).toBe(PACKAGES.length)
    const files = roots.flatMap((root) => [...sourceFiles(root)])
    expect(files.length).toBeGreaterThan(100)
  })

  it('no backend implements rmdir as its recursive removal', () => {
    const offenders: string[] = []
    for (const root of coreRoots()) {
      for (const file of sourceFiles(root)) {
        const src = readFileSync(file, 'utf8')
        if (KIT_ALIAS.test(src)) offenders.push(`${file}: rmdir = makeRemovePrefix(...)`)
        if (BODY_ALIAS.test(src)) offenders.push(`${file}: rmdir body only calls rmR`)
      }
    }
    expect(offenders).toEqual([])
  })
})
