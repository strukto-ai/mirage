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
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { MountMode, RAMResource, Workspace } from './index.ts'

const CONFORMANCE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'conformance',
)

const ENC = new TextEncoder()
const SUPPORTED_MATRIX: Record<string, ReadonlySet<string>> = {
  python: new Set(['ram', 'disk', 'redis']),
  typescript: new Set(['ram']),
}

interface ConformanceExpect {
  exit: number
  stdout_text?: string
  stdout_base64?: string
  stderr_text?: string
  stderr_base64?: string
}

interface ConformanceCase {
  id: string
  cmd: string
  stdin_text?: string
  stdin_base64?: string
  matrix: Record<string, string[]>
  expect: ConformanceExpect
}

function decodeBytes(record: object, textKey: string, base64Key: string): Uint8Array {
  const rec = record as Record<string, unknown>
  const hasText = textKey in rec
  const hasBase64 = base64Key in rec
  if (hasText === hasBase64) {
    throw new Error(`record must set exactly one of ${textKey}/${base64Key}`)
  }
  if (hasText) return ENC.encode(rec[textKey] as string)
  return Uint8Array.from(Buffer.from(rec[base64Key] as string, 'base64'))
}

function comparable(bytes: Uint8Array): string {
  const buf = Buffer.from(bytes)
  const text = buf.toString('utf8')
  if (Buffer.from(text, 'utf8').equals(buf)) return `txt:${text}`
  return `b64:${buf.toString('base64')}`
}

function loadSeeds(): Map<string, Uint8Array> {
  const raw = JSON.parse(readFileSync(join(CONFORMANCE_DIR, 'seeds.json'), 'utf8')) as Record<
    string,
    Record<string, unknown>
  >
  const seeds = new Map<string, Uint8Array>()
  for (const [path, spec] of Object.entries(raw)) {
    seeds.set(path, decodeBytes(spec, 'text', 'base64'))
  }
  return seeds
}

function validateMatrix(c: ConformanceCase, specName: string): void {
  const unknownLanguages = Object.keys(c.matrix).filter(
    (language) => !(language in SUPPORTED_MATRIX),
  )
  if (unknownLanguages.length > 0) {
    throw new Error(
      `case ${c.id} in ${specName} has unknown matrix language(s): ${unknownLanguages.sort().join(', ')}`,
    )
  }

  for (const [language, backends] of Object.entries(c.matrix)) {
    const supported = SUPPORTED_MATRIX[language]
    if (supported === undefined) continue
    const unsupported = backends.filter((backend) => !supported.has(backend))
    if (unsupported.length > 0) {
      throw new Error(
        `case ${c.id} in ${specName} has unsupported ${language} backend(s): ${unsupported.sort().join(', ')}`,
      )
    }
  }

  if (!Object.values(c.matrix).some((backends) => backends.length > 0)) {
    throw new Error(`case ${c.id} in ${specName} applies to no backend`)
  }
}

function loadCases(): ConformanceCase[] {
  const cases: ConformanceCase[] = []
  const casesDir = join(CONFORMANCE_DIR, 'cases')
  for (const name of readdirSync(casesDir).sort()) {
    if (!name.endsWith('.json')) continue
    const doc = JSON.parse(readFileSync(join(casesDir, name), 'utf8')) as {
      cases: ConformanceCase[]
    }
    for (const c of doc.cases) {
      validateMatrix(c, name)
      cases.push(c)
    }
  }
  return cases
}

const SEEDS = loadSeeds()
const CASES = loadCases()

async function seedWorkspace(ws: Workspace): Promise<void> {
  const made = new Set<string>()
  for (const [path, content] of SEEDS) {
    const parts = path.split('/').slice(0, -1).filter(Boolean)
    for (let depth = 1; depth <= parts.length; depth++) {
      const dir = '/' + parts.slice(0, depth).join('/')
      if (!made.has(dir)) {
        made.add(dir)
        await ws.fs.mkdir(dir)
      }
    }
    await ws.fs.writeFile(path, content)
  }
}

async function runCase(c: ConformanceCase): Promise<void> {
  const ws = new Workspace({ '/': new RAMResource() }, { mode: MountMode.WRITE })
  try {
    await seedWorkspace(ws)
    const hasStdin = 'stdin_text' in c || 'stdin_base64' in c
    const stdin = hasStdin ? decodeBytes(c, 'stdin_text', 'stdin_base64') : undefined
    const result = await ws.execute(c.cmd, stdin === undefined ? undefined : { stdin })
    expect(result.exitCode).toBe(c.expect.exit)
    expect(comparable(result.stdout)).toBe(
      comparable(decodeBytes(c.expect, 'stdout_text', 'stdout_base64')),
    )
    expect(comparable(result.stderr)).toBe(
      comparable(decodeBytes(c.expect, 'stderr_text', 'stderr_base64')),
    )
  } finally {
    await ws.close()
  }
}

describe('command conformance spec (ram)', () => {
  for (const c of CASES) {
    const backends = c.matrix.typescript ?? []
    if (!backends.includes('ram')) continue
    it(c.id, async () => {
      await runCase(c)
    })
  }
})

describe('command conformance matrix validation', () => {
  it.each([
    [{ pyhton: ['ram'] }, 'unknown matrix language'],
    [{ typescript: ['disk'] }, 'unsupported typescript backend'],
    [{ python: [], typescript: [] }, 'applies to no backend'],
  ])('rejects invalid targets', (matrix, message) => {
    const c = {
      id: 'invalid_matrix',
      cmd: 'true',
      matrix,
      expect: { exit: 0, stdout_text: '', stderr_text: '' },
    }
    expect(() => {
      validateMatrix(c, 'invalid.json')
    }).toThrow(message)
  })

  it('accepts supported targets', () => {
    const c = {
      id: 'valid_matrix',
      cmd: 'true',
      matrix: {
        python: ['ram', 'disk', 'redis'],
        typescript: ['ram'],
      },
      expect: { exit: 0, stdout_text: '', stderr_text: '' },
    }
    expect(() => {
      validateMatrix(c, 'valid.json')
    }).not.toThrow()
  })
})
