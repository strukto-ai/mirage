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
import { DevicePipe } from '../../core/dev/pipe.ts'
import { MountMode } from '../../types.ts'
import { getTestParser } from '../../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { RAMVFS } from '../ram/ram.ts'
import { DevFiles, DevStore } from './store.ts'

function withPipe(): [DevFiles, string] {
  const files = new DevFiles('owner')
  const [path] = files.allocateInput(new DevicePipe(true))
  return [files, path.slice(4)]
}

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    return (err as { code?: string }).code ?? 'NO_CODE'
  }
  return 'NO_THROW'
}

describe('DevFiles', () => {
  it('reports has() true only for null/zero (with or without leading slash)', () => {
    const f = new DevFiles()
    expect(f.has('/null')).toBe(true)
    expect(f.has('null')).toBe(true)
    expect(f.has('/zero')).toBe(true)
    expect(f.has('zero')).toBe(true)
    expect(f.has('/other')).toBe(false)
  })

  it('returns empty bytes for /null', () => {
    const f = new DevFiles()
    const v = f.get('/null')
    expect(v).toBeInstanceOf(Uint8Array)
    expect(v?.byteLength).toBe(0)
  })

  it('uses empty placeholders for active devices', () => {
    const f = new DevFiles()
    const v = f.get('/zero')
    expect(v).toBeInstanceOf(Uint8Array)
    expect(v?.byteLength).toBe(0)
  })

  it('returns undefined for unknown keys', () => {
    const f = new DevFiles()
    expect(f.get('/missing')).toBeUndefined()
  })

  it('discards writes to an active synthetic device', () => {
    const f = new DevFiles()
    f.set('/null', new TextEncoder().encode('overwrite'))
    expect(f.get('/null')?.byteLength).toBe(0)
    expect(f.get('/zero')?.byteLength).toBe(0)
  })

  it('delete tombstones a synthetic device', () => {
    const f = new DevFiles()
    expect(f.delete('/null')).toBe(true)
    expect(f.has('/null')).toBe(false)
    expect(f.get('/null')).toBeUndefined()
    expect([...f.keys()]).toEqual(['/zero'])
    expect(f.size).toBe(1)
    expect(f.delete('/null')).toBe(false)
  })

  it('derives device kind from active synthetic state', () => {
    const f = new DevFiles()
    expect(f.deviceOf('/null')).toBe('null')
    f.delete('/null')
    expect(f.deviceOf('/null')).toBeNull()
    f.set('/null', new Uint8Array([1]))
    expect(f.deviceOf('/null')).toBeNull()
  })

  it('set after delete stores real bytes (rm-then-redirect recreation)', () => {
    const f = new DevFiles()
    expect(f.delete('/null')).toBe(true)
    f.set('/null', new TextEncoder().encode('recreated'))
    expect(f.has('/null')).toBe(true)
    expect(new TextDecoder().decode(f.get('/null'))).toBe('recreated')
    expect([...f.keys()]).toEqual(['/zero', '/null'])
    expect(f.size).toBe(2)
  })

  it('delete of a recreated real file removes it again', () => {
    const f = new DevFiles()
    f.delete('/null')
    f.set('/null', new TextEncoder().encode('recreated'))
    expect(f.delete('/null')).toBe(true)
    expect(f.has('/null')).toBe(false)
    expect([...f.keys()]).toEqual(['/zero'])
  })

  it('stores non-device names for real', () => {
    const f = new DevFiles()
    f.set('/custom', new TextEncoder().encode('bytes'))
    expect(f.has('/custom')).toBe(true)
    expect(new TextDecoder().decode(f.get('/custom'))).toBe('bytes')
    expect([...f.keys()]).toEqual(['/null', '/zero', '/custom'])
    expect(f.delete('/custom')).toBe(true)
    expect(f.has('/custom')).toBe(false)
  })

  it('clear stays a no-op', () => {
    const f = new DevFiles()
    f.clear()
    expect(f.has('/null')).toBe(true)
    expect(f.has('/zero')).toBe(true)
  })

  it('iterates as [/null, /zero]', () => {
    const f = new DevFiles()
    expect([...f.keys()]).toEqual(['/null', '/zero'])
    expect(f.size).toBe(2)
  })
})

describe('DevStore', () => {
  it('starts with the synthetic files and root dir', () => {
    const s = new DevStore()
    expect(s.files.size).toBe(2)
    expect(s.dirs.has('/')).toBe(true)
    expect(s.modified.size).toBe(0)
  })
})

describe('DevFiles descriptor rows', () => {
  it('pipe row has no byte buffer', () => {
    const [files, key] = withPipe()
    expect(codeOf(() => files.get(key))).toBe('EINVAL')
    expect(codeOf(() => files.set(key, new Uint8Array([1])))).toBe('EINVAL')
    expect(files.state.inputs.get(key)?.data.byteLength).toBe(0)
  })

  it('pipe row is listed and counted empty', () => {
    const [files, key] = withPipe()
    expect(files.has(key)).toBe(true)
    expect([...files.keys()]).toEqual(['/null', '/zero', key])
    expect(files.size).toBe(3)
    expect([...files.entries()].at(-1)).toEqual([key, new Uint8Array()])
    expect([...files.values()].at(-1)).toEqual(new Uint8Array())
  })

  it('removing a pipe row is EPERM and keeps it', () => {
    const [files, key] = withPipe()
    expect(codeOf(() => files.delete(key))).toBe('EPERM')
    expect(files.pipeOf(key)).not.toBeNull()
  })

  it('descriptor row without a pipe keeps its bytes', () => {
    const files = new DevFiles('owner')
    const [path, allocation] = files.allocateInput()
    files.setInput(path, allocation, new Uint8Array([7]))
    expect(files.get(path.slice(4))).toEqual(new Uint8Array([7]))
    expect(files.delete(path.slice(4))).toBe(true)
    expect(files.has(path.slice(4))).toBe(false)
  })

  it.each([
    ["f() { ls -l /dev/fd | awk 'NR > 1 { print $1, $5, $NF }'; }; f <(true)", 'prw------- 0 63\n'],
    ['f() { ls -lL "$1" | awk \'{ print $1, $5 }\'; }; f <(true)', 'prw------- 0\n'],
    ['f() { find /dev -type p > /dev/null; echo find=$?; }; f <(true)', 'find=0\n'],
    ['f() { find /dev -type p; find /dev -size -1; }; f <(true)', '/dev/fd/63\n/dev/fd/63\n'],
    ['f() { du -a /dev/fd; }; f <(true)', '0\t/dev/fd/63\n0\t/dev/fd\n'],
    [
      'f() { rm "$1"; mv "$1" /dev/x; echo "st=$?"; }; f <(true) 2>&1',
      "rm: cannot remove '/dev/fd/63': Operation not permitted\n" +
        "mv: cannot move '/dev/fd/63' to '/dev/x': Operation not permitted\nst=1\n",
    ],
  ])('listing an open substitution: %s', async (command, expected) => {
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      { mode: MountMode.WRITE, shellParser: await getTestParser() },
    )
    try {
      const io = await ws.shell(command)
      expect([io.exitCode, io.stdoutText, io.stderrText]).toEqual([0, expected, ''])
    } finally {
      await ws.close()
    }
  })
})
