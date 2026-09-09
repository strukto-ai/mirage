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

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { GDriveAccessor } from '../../accessor/gdrive.ts'
import type { TokenManager } from '../google/client.ts'
import { DriveClient, driveApi } from './api.ts'

const GDRIVE_DIR = dirname(fileURLToPath(import.meta.url))
const GOOGLE_DIR = join(dirname(GDRIVE_DIR), 'google')

// api.ts is the seam; versions.ts is the Drive Revisions wire module the
// seam delegates to. Their tests are allowed the same reach, since a test
// of a wire module has to name the wire.
const ALLOWED = new Set(['api.ts', 'api.test.ts', 'versions.ts', 'versions.test.ts'])

// An import statement naming one of the three wire modules. The specifier
// list is `[^{}]*` rather than `[\s\S]*?`: a lazy match spans newlines and
// swallows every import between an earlier `import type {` and this one, so
// the whole statement then reads as type-only and the violation vanishes.
// Specifier lists never nest braces, so refusing one is exact.
const WIRE_IMPORT =
  /import\s+(type\s+)?(\{[^{}]*\}|\*\s+as\s+[A-Za-z0-9_$]+)\s+from\s+'([^']*(?:google\/(?:drive|client)|\/versions)\.ts)'/g

const EXPORTED_FUNCTION = /^export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)/gm

// Every function the three wire modules export. Derived, not listed, so a
// wire function added later is guarded the day it appears. Classes
// (GoogleApiError, TokenManager) and constants (FOLDER_MIME, MIME_TO_EXT)
// are deliberately not here: they carry no request.
function wireFunctionNames(): Set<string> {
  const names = new Set<string>()
  const sources = [
    join(GOOGLE_DIR, 'drive.ts'),
    join(GOOGLE_DIR, 'client.ts'),
    join(GDRIVE_DIR, 'versions.ts'),
  ]
  for (const file of sources) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(EXPORTED_FUNCTION)) {
      const name = match[1]
      if (name !== undefined) names.add(name)
    }
  }
  return names
}

function gdriveSources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...gdriveSources(full))
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out.sort()
}

// Every wire function one source reaches by value.
function scanSource(source: string, forbidden: Set<string>): string[] {
  const found: string[] = []
  for (const match of source.matchAll(WIRE_IMPORT)) {
    const typeOnly = match[1] !== undefined
    const clause = match[2]
    if (typeOnly || clause === undefined) continue
    if (clause.startsWith('*')) {
      // A namespace import hands the module every function at once, so
      // there is nothing to whitelist inside it.
      found.push(clause)
      continue
    }
    for (const raw of clause.slice(1, -1).split(',')) {
      const specifier = raw.trim()
      if (specifier === '' || specifier.startsWith('type ')) continue
      const local = (specifier.split(/\s+as\s+/)[0] ?? '').trim()
      if (forbidden.has(local)) found.push(local)
    }
  }
  return found
}

// [file, imported name] for every wire function reached by value.
function wireImports(forbidden: Set<string>): [string, string][] {
  const found: [string, string][] = []
  for (const file of gdriveSources(GDRIVE_DIR)) {
    const name = relative(GDRIVE_DIR, file)
    if (ALLOWED.has(name)) continue
    for (const local of scanSource(readFileSync(file, 'utf8'), forbidden)) {
      found.push([name, local])
    }
  }
  return found
}

describe('gdrive drive seam', () => {
  // Google Drive has no client object of its own: its calls are free
  // functions over a TokenManager. Importing them per module meant a fake
  // had to be installed at every one of those module sites, and a new call
  // site escaped the fake in silence. api.ts is the one seam; every other
  // gdrive module goes through `accessor.drive`.
  it('no gdrive module reaches a wire function by value', () => {
    const forbidden = wireFunctionNames()
    // A derived set that came back empty would pass this test vacuously.
    expect(forbidden.has('listFiles')).toBe(true)
    expect(forbidden.has('googleGet')).toBe(true)
    expect(forbidden.has('captureFileMetadata')).toBe(true)
    expect(wireImports(forbidden)).toEqual([])
  })

  // The gate's own pattern is what it trusts, and the first version of it
  // matched lazily across newlines: an earlier `import type {` in the same
  // file absorbed the violating import, so the statement read as type-only
  // and a real by-value import passed. Probe the detector, not just the
  // tree it walks.
  it('the detector sees what it is looking for', () => {
    const forbidden = wireFunctionNames()
    const header = "import type { GDriveAccessor } from '../../accessor/gdrive.ts'\n"
    expect(
      scanSource(`${header}import { deleteFile } from '../google/drive.ts'`, forbidden),
    ).toEqual(['deleteFile'])
    expect(
      scanSource(`${header}import { googleGet } from '../google/client.ts'`, forbidden),
    ).toEqual(['googleGet'])
    expect(
      scanSource(`${header}import { downloadRevision } from './versions.ts'`, forbidden),
    ).toEqual(['downloadRevision'])
    expect(scanSource(`${header}import * as drive from '../google/drive.ts'`, forbidden)).toEqual([
      '* as drive',
    ])
    // A wrapped list is one statement, and a renamed specifier is still the
    // wire function it renames.
    expect(
      scanSource(
        `${header}import {\n  listFiles,\n  getFile as g,\n} from '../google/drive.ts'`,
        forbidden,
      ),
    ).toEqual(['listFiles', 'getFile'])
    // Types and constants are not requests.
    expect(scanSource(`import type { DriveFile } from '../google/drive.ts'`, forbidden)).toEqual([])
    expect(scanSource(`import { FOLDER_MIME } from '../google/drive.ts'`, forbidden)).toEqual([])
    expect(scanSource(`import { type DriveFile } from '../google/drive.ts'`, forbidden)).toEqual([])
  })

  it('leaves constants and error types importable', () => {
    const forbidden = wireFunctionNames()
    expect(forbidden.has('FOLDER_MIME')).toBe(false)
    expect(forbidden.has('MIME_TO_EXT')).toBe(false)
    expect(forbidden.has('GoogleApiError')).toBe(false)
  })
})

describe('driveApi', () => {
  const tokenManager = { config: { clientId: 'cid', refreshToken: 'rt' } } as TokenManager

  it('builds a DriveClient bound to the token manager', () => {
    const api = driveApi(tokenManager)
    expect(api).toBeInstanceOf(DriveClient)
    expect((api as DriveClient).tokenManager).toBe(tokenManager)
  })

  it('the accessor builds a fresh client per access', () => {
    // Not memoized in the constructor: a resource builds its accessor
    // before a test installs a fake, so a cached client would pin the
    // live wire calls for the whole run.
    const accessor = new GDriveAccessor({ tokenManager })
    expect(accessor.drive).not.toBe(accessor.drive)
    expect((accessor.drive as DriveClient).tokenManager).toBe(tokenManager)
  })
})
