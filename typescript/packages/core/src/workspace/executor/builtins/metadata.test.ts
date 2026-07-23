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
import { OpsRegistry, type RegisteredOp } from '../../../ops/registry.ts'
import { RAMResource } from '../../../resource/ram/ram.ts'
import type { FileStat } from '../../../types.ts'
import { MountMode } from '../../../types.ts'
import { getTestParser } from '../../fixtures/workspace_fixture.ts'
import { Workspace } from '../../workspace.ts'
import { parseGroup, parseOwner, parseTouchStamp } from './metadata.ts'

describe('parseOwner', () => {
  it('parses owner and group forms', () => {
    expect(parseOwner('1000:staff')).toEqual([1000, 'staff'])
    expect(parseOwner('alice')).toEqual(['alice', null])
    expect(parseOwner(':dev')).toEqual([null, 'dev'])
    expect(parseOwner('500:501')).toEqual([500, 501])
  })
})

describe('parseTouchStamp', () => {
  it('parses POSIX stamps', () => {
    expect(parseTouchStamp('202601021530', null)).toBe('2026-01-02T15:30:00+00:00')
    expect(parseTouchStamp('202601021530.45', null)).toBe('2026-01-02T15:30:45+00:00')
  })

  it('resolves two-digit years by century split', () => {
    expect(parseTouchStamp('2601021530', null)?.startsWith('2026-')).toBe(true)
    expect(parseTouchStamp('9901021530', null)?.startsWith('1999-')).toBe(true)
  })

  it('parses date strings and passes through null', () => {
    expect(parseTouchStamp(null, '2026-01-02')).toBe('2026-01-02T00:00:00+00:00')
    expect(parseTouchStamp(null, null)).toBeNull()
  })

  it('throws on invalid stamps', () => {
    expect(() => parseTouchStamp('13011200', '')).toThrow()
    expect(() => parseTouchStamp('2026010215301', null)).toThrow()
    expect(() => parseTouchStamp('202601021530.5', null)).toThrow()
  })
})

describe('parseGroup', () => {
  it('parses names, numeric ids, and empty', () => {
    expect(parseGroup('staff')).toBe('staff')
    expect(parseGroup('20')).toBe(20)
    expect(parseGroup('')).toBeNull()
  })
})

async function makeWs(mode: MountMode = MountMode.WRITE): Promise<[Workspace, RAMResource]> {
  const parser = await getTestParser()
  const resource = new RAMResource()
  resource.store.files.set('/f.txt', new TextEncoder().encode('hello'))
  const ws = new Workspace({ '/data': resource }, { mode, shellParser: parser })
  return [ws, resource]
}

// Ops resolve by resource kind in the workspace registry, so overlay- and
// stat-only-backend simulations block registration itself.
class NoSetattrRegistry extends OpsRegistry {
  override register(ro: RegisteredOp): void {
    if (ro.name === 'setattr') return
    super.register(ro)
  }
}

class StatOnlyRegistry extends OpsRegistry {
  override register(ro: RegisteredOp): void {
    if (ro.name === 'setattr' || ro.name === 'write') return
    super.register(ro)
  }
}

async function makeOverlayWs(
  files: Record<string, string>,
  registry: OpsRegistry = new NoSetattrRegistry(),
): Promise<[Workspace, RAMResource]> {
  const parser = await getTestParser()
  const resource = new RAMResource()
  for (const [p, data] of Object.entries(files)) {
    resource.store.files.set(p, new TextEncoder().encode(data))
  }
  const ws = new Workspace(
    { '/data': resource },
    { mode: MountMode.WRITE, shellParser: parser, ops: registry },
  )
  return [ws, resource]
}

async function statOf(ws: Workspace, path: string): Promise<FileStat> {
  return (await ws.dispatch('stat', path)) as FileStat
}

async function run(ws: Workspace, cmd: string): Promise<[number, string, string]> {
  const r = await ws.execute(cmd)
  return [r.exitCode, r.stdoutText, r.stderrText]
}

describe('chmod/chown/touch (namespace-routed metadata commands)', () => {
  it('chmod renders in ls -l', async () => {
    const [ws] = await makeWs()
    const [code] = await run(ws, 'chmod 601 /data/f.txt')
    expect(code).toBe(0)
    const [, out] = await run(ws, 'ls -l /data')
    expect(out).toContain('-rw------x')
    await ws.close()
  })

  it('symbolic chmod starts from the current mode', async () => {
    const [ws] = await makeWs()
    await run(ws, 'chmod 644 /data/f.txt')
    await run(ws, 'chmod u+x /data/f.txt')
    const [, out] = await run(ws, 'ls -l /data')
    expect(out).toContain('-rwxr--r--')
    await ws.close()
  })

  it('chmod rejects a bad mode', async () => {
    const [ws] = await makeWs()
    const [code, , err] = await run(ws, 'chmod zz /data/f.txt')
    expect(code).toBe(1)
    expect(err).toContain('invalid mode')
    await ws.close()
  })

  it('chmod reports missing files', async () => {
    const [ws] = await makeWs()
    const [code, , err] = await run(ws, 'chmod 644 /data/nope.txt')
    expect(code).toBe(1)
    expect(err).toContain('nope.txt')
    await ws.close()
  })

  it('chown renders owner and group', async () => {
    const [ws] = await makeWs()
    const [code] = await run(ws, 'chown 500:dev /data/f.txt')
    expect(code).toBe(0)
    const [, out] = await run(ws, 'ls -l /data')
    expect(out).toContain(' 500 dev ')
    await ws.close()
  })

  it('touch -t sets the displayed mtime', async () => {
    const [ws] = await makeWs()
    const [code] = await run(ws, 'touch -t 202603041200 /data/f.txt')
    expect(code).toBe(0)
    const [, out] = await run(ws, 'ls -l /data')
    expect(out).toContain('Mar  4 12:00')
    await ws.close()
  })

  it('touch creates missing files; -c does not', async () => {
    const [ws] = await makeWs()
    await run(ws, 'touch /data/new.txt')
    const [, out] = await run(ws, 'ls /data')
    expect(out).toContain('new.txt')
    await run(ws, 'touch -c /data/ghost.txt')
    const [, out2] = await run(ws, 'ls /data')
    expect(out2).not.toContain('ghost.txt')
    await ws.close()
  })

  it('chmod follows symlinks to the target', async () => {
    const [ws] = await makeWs()
    await run(ws, 'ln -s /data/f.txt /data/link')
    await run(ws, 'chmod 640 /data/link')
    const [, out] = await run(ws, 'ls -l /data')
    expect(out).toContain('-rw-r----- 1 user user 5')
    await ws.close()
  })

  it('metadata commands refuse a read-only mount', async () => {
    const [ws] = await makeWs(MountMode.READ)
    for (const cmd of ['chmod 644 /data/f.txt', 'chown alice /data/f.txt', 'touch /data/f.txt']) {
      const [code, , err] = await run(ws, cmd)
      expect(code).toBe(1)
      expect(err).toContain('read-only mount')
    }
    await ws.close()
  })

  it('falls back to the namespace overlay when the mount has no setattr', async () => {
    const [ws, resource] = await makeOverlayWs({ '/f.txt': 'hello' })
    const [code] = await run(
      ws,
      'chmod 601 /data/f.txt && chown 500:dev /data/f.txt && touch -t 202603041200 /data/f.txt',
    )
    expect(code).toBe(0)
    expect(resource.store.attrs.size).toBe(0)
    const stat = await statOf(ws, '/data/f.txt')
    expect(stat.mode).toBe(0o601)
    expect(stat.uid).toBe(500)
    expect(stat.gid).toBe('dev')
    expect(stat.modified).toBe('2026-03-04T12:00:00Z')
    await ws.close()
  })

  it('renders overlay attrs in ls -l when the mount has no setattr', async () => {
    // ls stats through the backend, which has no attribute slot here; the
    // injected namespace overlay must still render chmod/chown/touch.
    const [ws] = await makeOverlayWs({ '/f.txt': 'hello' })
    await run(
      ws,
      'chmod 664 /data/f.txt && chown 500:dev /data/f.txt && touch -t 202603041200 /data/f.txt',
    )
    const [, out] = await run(ws, 'ls -l /data')
    expect(out).toContain('-rw-rw-r--')
    expect(out).toContain(' 500 dev ')
    expect(out).toContain('Mar  4 12:00')
    await ws.close()
  })

  it('touch cannot create on a stat-only mount', async () => {
    const [ws] = await makeOverlayWs({ '/f.txt': 'hello' }, new StatOnlyRegistry())
    const [code, , err] = await run(ws, 'touch /data/new.txt')
    expect(code).toBe(1)
    expect(err).toContain("cannot touch '/data/new.txt': Read-only file system")
    const [, out] = await run(ws, 'ls /data')
    expect(out).not.toContain('new.txt')
    await ws.close()
  })

  it('touch on a stat-only mount still stamps existing files via the overlay', async () => {
    const [ws] = await makeOverlayWs({ '/f.txt': 'hello' }, new StatOnlyRegistry())
    const [code] = await run(ws, 'touch -t 202603041200 /data/f.txt')
    expect(code).toBe(0)
    expect((await statOf(ws, '/data/f.txt')).modified).toBe('2026-03-04T12:00:00Z')
    await ws.close()
  })

  it('symbolic chmod on a directory builds on 755', async () => {
    const [ws] = await makeOverlayWs({})
    await run(ws, 'mkdir /data/sub')
    const [code, , err] = await run(ws, 'chmod g+w /data/sub')
    expect(code, err).toBe(0)
    expect((await statOf(ws, '/data/sub')).mode).toBe(0o775)
    await ws.close()
  })

  it('touch -r resolves a relative reference against cwd', async () => {
    const [ws] = await makeWs()
    await run(ws, 'touch -t 202603041200 /data/f.txt')
    const [code, , err] = await run(ws, 'cd /data && touch -r f.txt new.txt')
    expect(code, err).toBe(0)
    const [, out] = await run(ws, 'ls -l /data')
    expect(out.split('Mar  4 12:00').length - 1).toBe(2)
    await ws.close()
  })

  it('a content write clears overlay times but keeps the mode', async () => {
    const [ws] = await makeOverlayWs({ '/f.txt': 'hello' })
    await run(ws, 'chmod 601 /data/f.txt')
    await run(ws, 'touch -t 202603041200 /data/f.txt')
    const [code] = await run(ws, 'echo more >> /data/f.txt')
    expect(code).toBe(0)
    const stat = await statOf(ws, '/data/f.txt')
    expect(stat.modified).not.toBe('2026-03-04T12:00:00Z')
    expect(stat.mode).toBe(0o601)
    await ws.close()
  })

  it('mv replacing a file drops the destination meta', async () => {
    const [ws] = await makeOverlayWs({ '/src.txt': 'new', '/dst.txt': 'old' })
    await run(ws, 'chmod 601 /data/dst.txt')
    const [code, , err] = await run(ws, 'mv /data/src.txt /data/dst.txt')
    expect(code, err).toBe(0)
    expect((await statOf(ws, '/data/dst.txt')).mode).toBeNull()
    await ws.close()
  })

  it('mv carries the source meta over the destination meta', async () => {
    const [ws] = await makeOverlayWs({ '/src.txt': 'new', '/dst.txt': 'old' })
    await run(ws, 'chmod 601 /data/dst.txt')
    await run(ws, 'chmod 640 /data/src.txt')
    const [code, , err] = await run(ws, 'mv /data/src.txt /data/dst.txt')
    expect(code, err).toBe(0)
    expect((await statOf(ws, '/data/dst.txt')).mode).toBe(0o640)
    await ws.close()
  })

  it('mv into a symlinked directory keys meta under the real path', async () => {
    const [ws] = await makeOverlayWs({ '/f.txt': 'hi' })
    await run(ws, 'mkdir /data/sub')
    await run(ws, 'chmod 601 /data/f.txt')
    await run(ws, 'ln -s /data/sub /data/lnk')
    const [code, , err] = await run(ws, 'mv /data/f.txt /data/lnk')
    expect(code, err).toBe(0)
    expect((await statOf(ws, '/data/sub/f.txt')).mode).toBe(0o601)
    await ws.close()
  })

  it('glob rm drops the meta of expanded files', async () => {
    const [ws] = await makeOverlayWs({ '/f.txt': 'hello' })
    await run(ws, 'chmod 601 /data/f.txt')
    const [code, , err] = await run(ws, 'rm /data/*.txt')
    expect(code, err).toBe(0)
    await run(ws, 'echo hi > /data/f.txt')
    expect((await statOf(ws, '/data/f.txt')).mode).toBeNull()
    await ws.close()
  })

  it('chgrp renders the group and leaves the owner default', async () => {
    const [ws] = await makeWs()
    const [code, , err] = await run(ws, 'chgrp staff /data/f.txt')
    expect(code, err).toBe(0)
    const [, out] = await run(ws, 'ls -l /data')
    expect(out).toContain(' user staff ')
    await ws.close()
  })

  it('chgrp changes only the group, keeping a prior chown owner', async () => {
    const [ws] = await makeWs()
    await run(ws, 'chown alice:devs /data/f.txt')
    const [code, , err] = await run(ws, 'chgrp 20 /data/f.txt')
    expect(code, err).toBe(0)
    const [, out] = await run(ws, 'ls -l /data')
    expect(out).toContain(' alice 20 ')
    await ws.close()
  })

  it('chgrp reports missing operand, invalid group, -R, and missing files', async () => {
    const [ws] = await makeWs()
    expect((await run(ws, 'chgrp staff'))[0]).toBe(2)
    expect((await run(ws, "chgrp '' /data/f.txt"))[0]).toBe(1)
    expect((await run(ws, 'chgrp -R staff /data'))[0]).toBe(2)
    const [code, , err] = await run(ws, 'chgrp staff /data/nope.txt')
    expect(code).toBe(1)
    expect(err).toContain('nope.txt')
    await ws.close()
  })

  it('chgrp falls back to the namespace overlay when the mount has no setattr', async () => {
    const [ws, resource] = await makeOverlayWs({ '/f.txt': 'hello' })
    const [code] = await run(ws, 'chgrp dev /data/f.txt')
    expect(code).toBe(0)
    expect(resource.store.attrs.size).toBe(0)
    expect((await statOf(ws, '/data/f.txt')).gid).toBe('dev')
    await ws.close()
  })

  it('chgrp -h targets the link node, leaving the target group untouched', async () => {
    const [ws] = await makeWs()
    await run(ws, 'ln -s /data/f.txt /data/link')
    const [code, , err] = await run(ws, 'chgrp -h ops /data/link')
    expect(code, err).toBe(0)
    // stat follows the link; -h wrote the link node, so the target is clean.
    expect((await statOf(ws, '/data/f.txt')).gid).toBeNull()
    await ws.close()
  })

  it('chgrp refuses a read-only mount', async () => {
    const [ws] = await makeWs(MountMode.READ)
    const [code, , err] = await run(ws, 'chgrp staff /data/f.txt')
    expect(code).toBe(1)
    expect(err).toContain('read-only mount')
    await ws.close()
  })
})
