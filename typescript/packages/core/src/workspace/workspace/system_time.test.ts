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
import { afterEach, describe, expect, it } from 'vitest'
import { stdoutStr } from '../../../tests/workspace/fixtures/workspace_fixture.ts'
import { MountMode } from '../../types.ts'
import { ManualClock, parseSystemTime } from '../../utils/clock.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { Workspace } from './workspace.ts'

const workspaces: Workspace[] = []
afterEach(async () => {
  await Promise.allSettled(workspaces.splice(0).map((workspace) => workspace.close()))
})

function started(systemTime: string | null, clock = new ManualClock(1_000_000)): Workspace {
  const ws = new Workspace(
    { '/data': new RAMVFS() },
    { mode: MountMode.EXEC, clock, ...(systemTime === null ? {} : { systemTime }) },
  )
  workspaces.push(ws)
  return ws
}

async function out(ws: Workspace, line: string): Promise<string> {
  return stdoutStr(await ws.shell(line))
}

describe('system_time', () => {
  it('starts date, file times and jq at system_time', async () => {
    const clock = new ManualClock(1_000_000)
    const ws = started('2026-03-02T09:00:00Z', clock)
    expect(await out(ws, 'date -u')).toBe('Mon Mar  2 09:00:00 UTC 2026\n')
    expect(await out(ws, 'TZ=Asia/Shanghai date +%H:%M')).toBe('17:00\n')
    expect(await out(ws, 'date -u -d tomorrow +%F')).toBe('2026-03-03\n')
    await ws.shell('touch /data/a')
    // ls shows the time of a file stamped before now, as GNU's does.
    clock.advance(60)
    expect(await out(ws, 'ls -l /data')).toContain(' Mar  2 09:00 a\n')
    expect(await out(ws, 'find /data -mtime -1')).toBe('/data/a\n')
    expect(await out(ws, "echo '{}' | jq -r 'now|todate'")).toBe('2026-03-02T09:01:00Z\n')
  })

  it('ticks with the workspace clock', async () => {
    const clock = new ManualClock(1_000_000)
    const ws = started('2026-03-02T09:00:00+08:00', clock)
    clock.advance(90)
    expect(await out(ws, 'date -u +%T')).toBe('01:01:30\n')
  })

  it('stamps a file op outside any line', async () => {
    const ws = started('2026-03-02T09:00:00Z')
    await ws.dispatch('write', '/data/b', [new TextEncoder().encode('x')])
    expect((await ws.vfs.stat('/data/b')).modified).toBe('2026-03-02T09:00:00Z')
  })

  it("keeps the host's time when unset", async () => {
    const ws = started(null, new ManualClock(0))
    expect(await out(ws, 'date -u +%Y')).toBe(`${String(new Date().getUTCFullYear())}\n`)
    expect(ws.systemTime).toBeNull()
  })

  it('reports and carries the setting as written', async () => {
    const ws = started('2026-03-02T09:00:00Z')
    expect(ws.systemTime).toBe('2026-03-02T09:00:00Z')
    const loaded = await Workspace.load(await ws.snapshot())
    workspaces.push(loaded)
    expect(loaded.systemTime).toBe('2026-03-02T09:00:00Z')
    expect(await out(loaded, 'date -u +%F')).toBe('2026-03-02\n')
  })
})

describe('parseSystemTime', () => {
  it.each([
    ['2026-03-02T09:00:00Z', 1772442000],
    ['2026-03-02T09:00Z', 1772442000],
    ['2026-03-02T09:00:00+08:00', 1772413200],
    ['2026-03-02T09:00:00.1234567Z', 1772442000.123],
    ['2028-02-29T00:00:00Z', 1835395200],
  ])('reads %s', (text, seconds) => {
    expect(parseSystemTime(text)).toBeCloseTo(seconds, 6)
  })

  it.each([
    '2026-03-02',
    '2026-03-02T09:00:00',
    '2026-02-30T09:00:00Z',
    '2026-03-02T24:00:00Z',
    '2026-03-02T09:00:60Z',
    '2026-03-02T09:00:00+24:00',
  ])('refuses %s', (text) => {
    expect(() => parseSystemTime(text)).toThrow('is not an ISO 8601 instant with an offset')
  })
})
