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

import { mountKey } from '../../../utils/key_prefix.ts'
import { describe, expect, it } from 'vitest'
import { FileStat, FileType, PathSpec } from '../../../types.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import type { CommandOpts } from '../../config.ts'
import { LS_FAILURE, LS_MINOR_PROBLEM, LS_OK, exitStatusFor, lsGeneric } from './ls.ts'

const DEC = new TextDecoder()

const MODIFIED: Record<string, string> = {
  'apple.txt': '2026-01-03T00:00:00Z',
  'Banana.txt': '2026-01-01T00:00:00Z',
  'CHERRY.txt': '2026-01-02T00:00:00Z',
}

function key(p: PathSpec): string {
  return rstripSlash(p.virtual) || '/'
}

function spec(path: string): PathSpec {
  return new PathSpec({
    virtual: path,
    directory: path,
    resolved: false,
    resourcePath: mountKey(path, ''),
  })
}

function opts(flags: Record<string, string | boolean | string[]>): CommandOpts {
  return {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
    resource: null,
  } as unknown as CommandOpts
}

const stat = (p: PathSpec): Promise<FileStat> => {
  const name = key(p).split('/').pop() ?? ''
  return Promise.resolve(
    new FileStat({
      name,
      type: key(p) === '/' ? FileType.DIRECTORY : FileType.TEXT,
      modified: MODIFIED[name] ?? null,
    }),
  )
}

const readdir = (p: PathSpec): Promise<string[]> => {
  if (key(p) === '/') return Promise.resolve(['/apple.txt', '/Banana.txt', '/CHERRY.txt'])
  return Promise.resolve([])
}

async function run(flags: Record<string, string | boolean | string[]>): Promise<string[]> {
  const result = await lsGeneric([spec('/')], opts(flags), readdir, stat)
  if (result === null) return []
  const [out] = result
  return DEC.decode(out as Uint8Array)
    .replace(/\n$/, '')
    .split('\n')
}

describe('lsGeneric', () => {
  it('sorts names by ASCII byte order, uppercase before lowercase', async () => {
    expect(await run({})).toEqual(['Banana.txt', 'CHERRY.txt', 'apple.txt'])
  })

  it('-r reverses the ASCII order', async () => {
    expect(await run({ r: true })).toEqual(['apple.txt', 'CHERRY.txt', 'Banana.txt'])
  })

  it('-t sorts newest first by codepoint comparison of modified', async () => {
    expect(await run({ t: true })).toEqual(['apple.txt', 'CHERRY.txt', 'Banana.txt'])
  })

  it('-tr sorts oldest first', async () => {
    expect(await run({ t: true, r: true })).toEqual(['Banana.txt', 'CHERRY.txt', 'apple.txt'])
  })
})

// GNU coreutils 9.7 exit codes: 0 ok, 1 minor problem (trouble met below an
// operand), 2 serious trouble (a command-line operand could not be accessed).
// Pinned with `docker run --rm debian:stable-slim`.
const enoent = (): Promise<never> =>
  Promise.reject(Object.assign(new Error('nope'), { code: 'ENOENT' }))

const eacces = (): Promise<never> =>
  Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' }))

// `/good` lists two entries; `/bad` does not exist; `/half` lists one entry
// whose stat is denied.
const treeReaddir = (p: PathSpec): Promise<string[]> => {
  const k = key(p)
  if (k === '/good') return Promise.resolve(['/good/a.txt', '/good/b.txt'])
  if (k === '/half') return Promise.resolve(['/half/locked.txt'])
  if (k === '/deep') return Promise.resolve(['/deep/sub'])
  if (k === '/deep/sub') return eacces()
  return enoent()
}

const treeStat = (p: PathSpec): Promise<FileStat> => {
  const k = key(p)
  if (k === '/half/locked.txt') return eacces()
  if (k === '/bad' || k.startsWith('/bad/')) return enoent()
  const dir = k === '/good' || k === '/half' || k === '/deep' || k === '/deep/sub'
  return Promise.resolve(
    new FileStat({
      name: k.split('/').pop() ?? '',
      type: dir ? FileType.DIRECTORY : FileType.TEXT,
    }),
  )
}

async function status(
  paths: string[],
  flags: Record<string, string | boolean | string[]> = {},
): Promise<[number, string]> {
  const result = await lsGeneric(paths.map(spec), opts(flags), treeReaddir, treeStat)
  if (result === null) return [-1, '']
  const [out, io] = result
  return [io.exitCode, DEC.decode((out ?? new Uint8Array()) as Uint8Array)]
}

describe('lsGeneric exit codes', () => {
  it('exits 0 when every operand lists cleanly', async () => {
    const [code] = await status(['/good'])
    expect(code).toBe(LS_OK)
  })

  it('exits 2 for a missing command-line operand', async () => {
    const [code] = await status(['/bad'])
    expect(code).toBe(LS_FAILURE)
  })

  it('exits 2 when only one of several operands is missing', async () => {
    expect((await status(['/bad', '/good']))[0]).toBe(LS_FAILURE)
    expect((await status(['/good', '/bad']))[0]).toBe(LS_FAILURE)
  })

  it('still lists the good operand while exiting 2', async () => {
    const [code, out] = await status(['/bad', '/good'])
    expect(code).toBe(LS_FAILURE)
    expect(out).toContain('a.txt')
  })

  it('exits 2 for a missing operand under -d', async () => {
    expect((await status(['/bad'], { d: true }))[0]).toBe(LS_FAILURE)
    expect((await status(['/good', '/bad'], { d: true }))[0]).toBe(LS_FAILURE)
  })

  it('exits 1 when an entry below the operand cannot be stat', async () => {
    const [code, out] = await status(['/half'])
    expect(code).toBe(LS_MINOR_PROBLEM)
    // The unreadable entry is skipped, not fatal: the listing still renders.
    expect(out).not.toContain('locked.txt')
  })

  it('exits 1 when -R cannot open a subdirectory, keeping parent output', async () => {
    const [code, out] = await status(['/deep'], { R: true })
    expect(code).toBe(LS_MINOR_PROBLEM)
    expect(out).toContain('/deep:')
  })

  it('lets a serious problem outrank a minor one', async () => {
    expect((await status(['/half', '/bad']))[0]).toBe(LS_FAILURE)
  })

  it('prints no header for a -R operand it cannot open', async () => {
    const [code, out] = await status(['/good', '/bad'], { R: true })
    expect(code).toBe(LS_FAILURE)
    expect(out).not.toContain('/bad:')
  })

  it('starts flush left when the first -R operand could not be opened', async () => {
    const [code, out] = await status(['/bad', '/good'], { R: true })
    expect(code).toBe(LS_FAILURE)
    expect(out).toBe('/good:\na.txt\nb.txt\n')
  })

  it('ratchets the status like GNU set_exit_status', () => {
    const minor = { message: "ls: cannot access 'x': Permission denied", serious: false }
    const serious = { message: "ls: cannot access '/nope': No such file", serious: true }
    expect(exitStatusFor([])).toBe(LS_OK)
    expect(exitStatusFor([minor])).toBe(LS_MINOR_PROBLEM)
    expect(exitStatusFor([serious])).toBe(LS_FAILURE)
    expect(exitStatusFor([minor, serious])).toBe(LS_FAILURE)
    expect(exitStatusFor([serious, minor])).toBe(LS_FAILURE)
  })
})
