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

import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MountMode } from '@struktoai/mirage-core'
import { DiskResource } from '../resource/disk/disk.ts'
import { Workspace } from '../workspace.ts'

const DEC = new TextDecoder()

describe('disk streaming commands on missing files', () => {
  let root: string
  let ws: Workspace

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'mirage-missing-'))
    ws = new Workspace({ '/disk': new DiskResource({ root }) }, { mode: MountMode.WRITE })
  })

  afterEach(async () => {
    await ws.close()
    await rm(root, { recursive: true, force: true })
  })

  it('cat /missing returns exit=1 with stderr', async () => {
    const res = await ws.execute('cat /disk/missing.txt')
    expect(res.exitCode).toBe(1)
    expect(DEC.decode(res.stderr)).toMatch(/No such file or directory/)
  })

  it('cat /missing.txt; echo after=$? yields after=1', async () => {
    const res = await ws.execute('cat /disk/missing.txt; echo after=$?')
    expect(DEC.decode(res.stdout)).toBe('after=1\n')
  })

  it('cat /missing || echo fallback runs fallback', async () => {
    const res = await ws.execute('cat /disk/missing.txt || echo fallback')
    expect(DEC.decode(res.stdout)).toBe('fallback\n')
  })

  it('head /missing.txt returns exit=1', async () => {
    const res = await ws.execute('head /disk/missing.txt')
    expect(res.exitCode).toBe(1)
    expect(DEC.decode(res.stderr)).toMatch(/No such file or directory/)
  })

  // GNU grep exits 2 for an operand it could not search, unlike the read
  // commands around it, which exit 1.
  it('grep pat /missing.txt returns exit=2', async () => {
    const res = await ws.execute('grep foo /disk/missing.txt')
    expect(res.exitCode).toBe(2)
    expect(DEC.decode(res.stderr)).toMatch(/No such file or directory/)
  })

  it('tail /missing.txt returns exit=1', async () => {
    const res = await ws.execute('tail /disk/missing.txt')
    expect(res.exitCode).toBe(1)
    expect(DEC.decode(res.stderr)).toMatch(/No such file or directory/)
  })

  it('wc /missing.txt returns exit=1', async () => {
    const res = await ws.execute('wc /disk/missing.txt')
    expect(res.exitCode).toBe(1)
    expect(DEC.decode(res.stderr)).toMatch(/No such file or directory/)
  })

  it('cat works on existing disk file', async () => {
    await mkdir(root, { recursive: true })
    await writeFile(path.join(root, 'hello.txt'), 'hello\n')
    const res = await ws.execute('cat /disk/hello.txt')
    expect(res.exitCode).toBe(0)
    expect(DEC.decode(res.stdout)).toBe('hello\n')
  })

  it('head works on existing disk file', async () => {
    await writeFile(path.join(root, 'lines.txt'), 'a\nb\nc\n')
    const res = await ws.execute('head -n 2 /disk/lines.txt')
    expect(res.exitCode).toBe(0)
    expect(DEC.decode(res.stdout)).toBe('a\nb\n')
  })

  it('grep works on existing disk file', async () => {
    await writeFile(path.join(root, 'words.txt'), 'foo\nbar\nfoo baz\n')
    const res = await ws.execute('grep foo /disk/words.txt')
    expect(res.exitCode).toBe(0)
    expect(DEC.decode(res.stdout)).toMatch(/foo/)
  })
})
