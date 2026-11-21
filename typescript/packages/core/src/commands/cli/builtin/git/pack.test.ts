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

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { MountMode, PathSpec } from '../../../../types.ts'
import { RAMVFS } from '../../../../vfs/ram/ram.ts'
import { Workspace } from '../../../../workspace/workspace/workspace.ts'
import type { Files } from '../../../../workspace/files.ts'
import { SYSTEM_IDS } from '../../../../utils/ids.ts'
import type * as ConstantsModule from './constants.ts'
import { GitError } from './errors.ts'
import { storePack } from './pack.ts'

// No delta base outlives its next sibling, so every base with deltas still
// waiting is let go and rebuilt from its whole object.
vi.mock('./constants.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof ConstantsModule>()),
  PACK_CACHE_BYTES: 0,
}))

let tmp: string
let packBytes: Uint8Array
let idxBytes: Uint8Array
let stem: string

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'A',
      GIT_AUTHOR_EMAIL: 'a@example.com',
      GIT_COMMITTER_NAME: 'A',
      GIT_COMMITTER_EMAIL: 'a@example.com',
    },
  })
}

async function* chunked(data: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let at = 0; at < data.byteLength; at += size) {
    await Promise.resolve()
    yield data.subarray(at, at + size)
  }
}

function files(): Files {
  return new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE }).vfs
}

const gitdir = PathSpec.fromStrPath('/r/.git')

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mirage-git-pack-'))
  git(tmp, 'init', '-q', '-b', 'main')
  const lines = Array.from(
    { length: 400 },
    (_, n) => `line ${String(n)} of a file long enough to delta`,
  )
  for (let round = 0; round < 6; round++) {
    lines[round * 50] = `changed in round ${String(round)}`
    writeFileSync(join(tmp, 'big.txt'), `${lines.join('\n')}\n`)
    writeFileSync(join(tmp, `small${String(round)}.txt`), `${String(round)}\n`)
    writeFileSync(
      join(tmp, `variant${String(round)}.txt`),
      `${lines.map((line, n) => (n === 399 - round ? `variant ${String(round)}` : line)).join('\n')}\n`,
    )
    git(tmp, 'add', '-A')
    git(tmp, 'commit', '-q', '-m', `round ${String(round)}`)
  }
  git(tmp, 'repack', '-a', '-d', '-f', '-q', '--depth=50', '--window=10')
  const dir = join(tmp, '.git', 'objects', 'pack')
  const name = readdirSync(dir).find((entry) => entry.endsWith('.pack')) ?? ''
  stem = name.slice(0, -'.pack'.length)
  packBytes = new Uint8Array(readFileSync(join(dir, name)))
  idxBytes = new Uint8Array(readFileSync(join(dir, `${stem}.idx`)))
})

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('storePack', () => {
  it('keeps the pack and writes the index git writes, deltas resolved', async () => {
    const listed = git(
      tmp,
      'verify-pack',
      '-v',
      join(tmp, '.git', 'objects', 'pack', `${stem}.idx`),
    )
    const bases = [
      ...listed.matchAll(/^[0-9a-f]{40}\s+\w+\s+\d+\s+\d+\s+\d+\s+\d+\s+([0-9a-f]{40})$/gm),
    ].map((match) => match[1])
    expect(bases.some((base, n) => bases.indexOf(base) !== n)).toBe(true)
    const vfs = files()
    await storePack(vfs, gitdir, chunked(packBytes, 997), SYSTEM_IDS)
    const dir = gitdir.join('objects/pack')
    expect((await vfs.readdir(dir)).map((entry) => entry.split('/').at(-1)).sort()).toEqual([
      `${stem}.idx`,
      `${stem}.pack`,
    ])
    expect(await vfs.read(dir.join(`${stem}.pack`))).toEqual(packBytes)
    expect(await vfs.read(dir.join(`${stem}.idx`))).toEqual(idxBytes)
  })

  it('refuses a corrupt pack as git does and leaves nothing behind', async () => {
    const vfs = files()
    const bad = packBytes.slice()
    bad[bad.byteLength - 1] = (bad[bad.byteLength - 1] ?? 0) ^ 1
    await expect(storePack(vfs, gitdir, chunked(bad, 4096), SYSTEM_IDS)).rejects.toThrow(
      new GitError('pack is corrupted (SHA1 mismatch)'),
    )
    expect(await vfs.readdir(gitdir.join('objects/pack'))).toEqual([])
    await expect(
      storePack(vfs, gitdir, chunked(packBytes.subarray(0, 100), 30), SYSTEM_IDS),
    ).rejects.toThrow(new GitError('early EOF'))
    expect(await vfs.readdir(gitdir.join('objects/pack'))).toEqual([])
  })

  it('stores nothing for an empty pack', async () => {
    const vfs = files()
    await storePack(vfs, gitdir, chunked(new Uint8Array(), 1), SYSTEM_IDS)
    expect(await vfs.exists(gitdir.join('objects/pack'))).toBe(false)
  })
})
