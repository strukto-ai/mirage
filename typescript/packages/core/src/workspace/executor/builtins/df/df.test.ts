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
import { RAMVFS } from '../../../../vfs/ram/ram.ts'
import { CapacityState, MountMode } from '../../../../types.ts'
import type { CapacityResult } from '../../../../types.ts'
import { getTestParser } from '../../../fixtures/workspace_fixture.ts'
import { Workspace } from '../../../workspace/workspace.ts'

// RAM backend that reports a fixed quota, standing in for a real filesystem
// / a provider that exposes storage numbers (real disk free space is
// machine-specific, so this keeps the output deterministic).
class QuotaVFS extends RAMVFS {
  override statfs(): Promise<CapacityResult> {
    return Promise.resolve({
      state: CapacityState.QUOTA,
      total: 1024000,
      used: 409600,
      available: 614400,
      inodes: 1000,
      inodesUsed: 100,
      inodesFree: 900,
    })
  }
}

async function makeWs(): Promise<Workspace> {
  const parser = await getTestParser()
  return new Workspace(
    { '/mem': new RAMVFS(), '/q': new QuotaVFS() },
    { mode: MountMode.WRITE, shellParser: parser },
  )
}

async function run(ws: Workspace, cmd: string): Promise<[number, string]> {
  const r = await ws.shell(cmd)
  return [r.exitCode, r.stdoutText]
}

// Whitespace-split fields of output line `i` (0 = header).
function cols(out: string, i: number): string[] {
  return (out.trimEnd().split('\n')[i] ?? '').split(/\s+/)
}

describe('df', () => {
  it('default statfs state is UNKNOWN', async () => {
    const cap = await new RAMVFS().statfs()
    expect(cap.state).toBe(CapacityState.UNKNOWN)
    expect(cap.total).toBeUndefined()
  })

  it('unknown backend renders dashes', async () => {
    const ws = await makeWs()
    const [code, out] = await run(ws, 'df /mem')
    expect(code).toBe(0)
    expect(out).toBe(
      'Filesystem     1K-blocks Used Available Use% Mounted on\n' +
        'ram                    -    -         -    - /mem\n',
    )
    await ws.close()
  })

  it('quota backend reports real numbers', async () => {
    const ws = await makeWs()
    const [code, out] = await run(ws, 'df /q')
    expect(code).toBe(0)
    expect(cols(out, 0)).toEqual([
      'Filesystem',
      '1K-blocks',
      'Used',
      'Available',
      'Use%',
      'Mounted',
      'on',
    ])
    expect(cols(out, 1)).toEqual(['ram', '1000', '400', '600', '40%', '/q'])
    await ws.close()
  })

  // GNU coreutils 9.7, `numfmt --to=iec` on the quota's three numbers.
  // 1024000 is exactly 1000 KiB and GNU keeps `1000K` rather than rolling
  // to `1.0M`, because the roll happens at 1024, not 1000.
  it('human sizes match GNU', async () => {
    const ws = await makeWs()
    const [code, out] = await run(ws, 'df -h /q')
    expect(code).toBe(0)
    expect(cols(out, 1).slice(0, 4)).toEqual(['ram', '1000K', '400K', '600K'])
    await ws.close()
  })

  // `-H` is powers of 1000, and GNU spells that kilo lowercase: `410k`,
  // not the `410K` that means 1024. Read off a real `df -H` on a 100 KiB
  // tmpfs (which prints `103k`) and confirmed with `numfmt --to=si`. Only
  // kilo differs in case; M and up are capitals in both tables.
  it('SI sizes match GNU', async () => {
    const ws = await makeWs()
    const [code, out] = await run(ws, 'df -H /q')
    expect(code).toBe(0)
    expect(cols(out, 1).slice(0, 4)).toEqual(['ram', '1.1M', '410k', '615k'])
    await ws.close()
  })

  it('type column', async () => {
    const ws = await makeWs()
    const [, out] = await run(ws, 'df -T /q')
    expect(cols(out, 0).slice(0, 2)).toEqual(['Filesystem', 'Type'])
    expect(cols(out, 1).slice(0, 2)).toEqual(['ram', 'ram'])
    await ws.close()
  })

  it('inode columns; unknown -> dashes', async () => {
    const ws = await makeWs()
    const [, q] = await run(ws, 'df -i /q')
    expect(cols(q, 0)).toEqual(['Filesystem', 'Inodes', 'IUsed', 'IFree', 'IUse%', 'Mounted', 'on'])
    expect(cols(q, 1)).toEqual(['ram', '1000', '100', '900', '10%', '/q'])
    const [, m] = await run(ws, 'df -i /mem')
    expect(cols(m, 1)).toEqual(['ram', '-', '-', '-', '-', '/mem'])
    await ws.close()
  })

  it('posix and block-size headers', async () => {
    const ws = await makeWs()
    const [, posix] = await run(ws, 'df -P /q')
    expect(cols(posix, 0).slice(1)).toEqual([
      '1024-blocks',
      'Used',
      'Available',
      'Capacity',
      'Mounted',
      'on',
    ])
    const [, block] = await run(ws, 'df -B 1M /q')
    expect(cols(block, 0)[1]).toBe('1M-blocks')
    expect(cols(block, 1)[1]).toBe('1')
    await ws.close()
  })

  it('human-readable', async () => {
    const ws = await makeWs()
    const [, out] = await run(ws, 'df -h /q')
    expect(cols(out, 0).slice(1, 4)).toEqual(['Size', 'Used', 'Avail'])
    expect((cols(out, 1)[1] ?? '').endsWith('K')).toBe(true)
    await ws.close()
  })

  it('no args lists all mounts', async () => {
    const ws = await makeWs()
    const [code, out] = await run(ws, 'df')
    expect(code).toBe(0)
    const mountedOn = out
      .trimEnd()
      .split('\n')
      .slice(1)
      .map((ln) => ln.split(/\s+/).pop())
    expect(mountedOn).toContain('/mem')
    expect(mountedOn).toContain('/q')
    await ws.close()
  })

  it('invalid option', async () => {
    const ws = await makeWs()
    const [code] = await run(ws, 'df -z /mem')
    expect(code).toBe(2)
    await ws.close()
  })

  it('rejects a zero block size', async () => {
    const ws = await makeWs()
    const r = await ws.shell('df -B0 /q')
    expect(r.exitCode).toBe(1)
    expect(r.stderrText).toBe("df: invalid -B argument '0'\n")
    await ws.close()
  })

  it('last size-format flag wins', async () => {
    const ws = await makeWs()
    const [, hb] = await run(ws, 'df -h -B1M /q')
    expect(cols(hb, 0)[1]).toBe('1M-blocks')
    const [, bh] = await run(ws, 'df -B1M -h /q')
    expect(cols(bh, 0)[1]).toBe('Size')
    const [, hk] = await run(ws, 'df -h -k /q')
    expect(cols(hk, 0)[1]).toBe('1K-blocks')
    const [, kh] = await run(ws, 'df -k -h /q')
    expect(cols(kh, 0)[1]).toBe('Size')
    await ws.close()
  })

  it('errors on a missing FILE operand', async () => {
    const ws = await makeWs()
    await ws.shell('mkdir -p /mem/sub')
    await ws.shell("sh -c 'echo hi > /mem/sub/f.txt'")
    expect((await run(ws, 'df /mem/sub/f.txt'))[0]).toBe(0)
    expect((await run(ws, 'df /mem'))[0]).toBe(0)
    const r = await ws.shell('df /mem/missing')
    expect(r.exitCode).toBe(1)
    expect(r.stderrText).toBe('df: /mem/missing: No such file or directory\n')
    await ws.close()
  })

  it('follows a symlink to the target mount', async () => {
    const ws = await makeWs()
    await ws.shell('ln -s /q /mem/link')
    const [code, out] = await run(ws, 'df /mem/link')
    expect(code).toBe(0)
    const last = out.trimEnd().split('\n').pop() ?? ''
    expect(last.split(/\s+/).pop()).toBe('/q')
    await ws.close()
  })
})
