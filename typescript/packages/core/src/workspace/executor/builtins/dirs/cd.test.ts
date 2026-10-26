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

import { resolveSymlinks } from '../../../../utils/path.ts'
import { varsFromEnv } from '../../../../workspace/session/session.ts'
import { describe, expect, it, vi } from 'vitest'
import { PathSpec } from '../../../../types.ts'
import { ContentType, FileType } from '../../../../types.ts'
import { SessionState } from '../../../session/session.ts'
import type { DispatchFn } from '../../../../runtime/types.ts'
import { handleCd } from './cd.ts'
import { ManualClock } from '../../../../utils/clock.ts'
import { MountMode } from '../../../../types.ts'
import { RAMVFS } from '../../../../vfs/ram/ram.ts'
import { Workspace } from '../../../workspace/workspace.ts'
import { getTestParser } from '../../../../../tests/workspace/fixtures/workspace_fixture.ts'

import type * as FilesModule from '../../../files.ts'

const seenClocks = vi.hoisted(() => [] as unknown[])

vi.mock('../../../files.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof FilesModule>()
  class ClockSeen extends mod.Files {
    constructor(...args: ConstructorParameters<typeof mod.Files>) {
      super(...args)
      if (args[3]?.ledger !== false) seenClocks.push(args[3]?.clock)
    }
  }
  return { ...mod, Files: ClockSeen }
})

// A follow over a fixed link table, as the session's link view resolves.
function through(links: ReadonlyMap<string, string>): (path: string) => string {
  return (path) => resolveSymlinks(path, links)
}

function dispatcher(dirs: string[] = [], files: string[] = []) {
  const seen: string[] = []
  const dispatch = ((_op: string, scope: PathSpec) => {
    seen.push(scope.virtual)
    if (dirs.includes(scope.virtual)) {
      return Promise.resolve([{ name: scope.virtual, type: FileType.DIRECTORY }, null])
    }
    if (files.includes(scope.virtual)) {
      return Promise.resolve([
        { name: scope.virtual, type: FileType.FILE, content: ContentType.TEXT },
        null,
      ])
    }
    const err = new Error(`no such file: ${scope.virtual}`)
    ;(err as { code?: string }).code = 'ENOENT'
    return Promise.reject(err)
  }) as unknown as DispatchFn
  return { dispatch, seen }
}

const noMountRoot = () => false

function session(cwd = '/', env: Record<string, string> = {}): SessionState {
  return new SessionState({ sessionId: 'test', cwd, vars: varsFromEnv(env) })
}

function decode(b: Uint8Array | null): string {
  return b === null ? '' : new TextDecoder().decode(b)
}

describe('handleCd', () => {
  it('moves the session and records the previous directory', async () => {
    const { dispatch } = dispatcher(['/data/sub'])
    const s = session('/data')
    const [stdout, io] = await handleCd(dispatch, noMountRoot, 'sub', s)
    expect(io.exitCode).toBe(0)
    expect(stdout).toBeNull()
    expect(s.cwd).toBe('/data/sub')
    expect(s.env.OLDPWD).toBe('/data')
  })

  it('joins a relative target after repeated trailing slashes', async () => {
    const { dispatch, seen } = dispatcher(['/data/sub'])
    const s = session('/data///')
    const [, io] = await handleCd(dispatch, noMountRoot, 'sub', s)
    expect(io.exitCode).toBe(0)
    expect(seen).toEqual(['/data/sub'])
    expect(s.cwd).toBe('/data/sub')
  })

  it('never consults the backend for the root', async () => {
    const { dispatch, seen } = dispatcher()
    const s = session('/data')
    const [, io] = await handleCd(dispatch, noMountRoot, '/', s)
    expect(io.exitCode).toBe(0)
    expect(s.cwd).toBe('/')
    expect(seen).toEqual([])
  })

  it('refuses a missing directory and leaves the cwd alone', async () => {
    const { dispatch } = dispatcher()
    const s = session('/data')
    const [, io] = await handleCd(dispatch, noMountRoot, 'nope', s)
    expect(io.exitCode).toBe(1)
    expect(decode(io.stderr as Uint8Array)).toBe('bash: cd: nope: No such file or directory\n')
    expect(s.cwd).toBe('/data')
  })

  it('refuses a regular file', async () => {
    const { dispatch } = dispatcher([], ['/data/f.txt'])
    const s = session('/data')
    const [, io] = await handleCd(dispatch, noMountRoot, 'f.txt', s)
    expect(io.exitCode).toBe(1)
    expect(decode(io.stderr as Uint8Array)).toBe('bash: cd: f.txt: Not a directory\n')
  })

  it('searches CDPATH before the cwd-relative candidate', async () => {
    const { dispatch, seen } = dispatcher(['/opt/sub'])
    const s = session('/data', { CDPATH: '/opt' })
    const [stdout, io] = await handleCd(dispatch, noMountRoot, 'sub', s, false, 'sub')
    expect(io.exitCode).toBe(0)
    expect(s.cwd).toBe('/opt/sub')
    expect(seen).toEqual(['/opt/sub'])
    expect(decode(stdout as Uint8Array)).toBe('/opt/sub\n')
  })

  it('falls back to the cwd when no CDPATH entry matches', async () => {
    const { dispatch, seen } = dispatcher(['/data/sub'])
    const s = session('/data', { CDPATH: '/opt' })
    const [, io] = await handleCd(dispatch, noMountRoot, 'sub', s, false, 'sub')
    expect(io.exitCode).toBe(0)
    expect(s.cwd).toBe('/data/sub')
    expect(seen).toEqual(['/opt/sub', '/data/sub'])
  })

  it('follows a symlink to its target', async () => {
    const { dispatch } = dispatcher(['/real'])
    const s = session()
    const [, io] = await handleCd(
      dispatch,
      noMountRoot,
      '/link',
      s,
      false,
      null,
      through(new Map([['/link', '/real']])),
    )
    expect(io.exitCode).toBe(0)
    expect(s.cwd).toBe('/real')
  })

  it('reports ELOOP on a symlink cycle', async () => {
    const { dispatch } = dispatcher()
    const s = session('/data')
    const [, io] = await handleCd(
      dispatch,
      noMountRoot,
      '/a',
      s,
      false,
      null,
      through(
        new Map([
          ['/a', '/b'],
          ['/b', '/a'],
        ]),
      ),
    )
    expect(io.exitCode).toBe(1)
    expect(decode(io.stderr as Uint8Array)).toBe(
      'bash: cd: /a: Too many levels of symbolic links\n',
    )
    expect(s.cwd).toBe('/data')
  })

  // GNU bash 5.2 (debian:stable-slim), with /link -> /deep/real:
  //   cd -L /link/..      PWD=/            cd -P /link/..      PWD=/deep
  //   cd -L /link/sub/..  PWD=/link        cd -P /link/sub/..  PWD=/deep/real
  // -L simplifies `..` textually against the path as typed; -P resolves the
  // link first, so `..` lands in the target's parent. mirage reports the
  // physical name in both modes, so the -L rows land in the same directory
  // bash does while spelling it /deep/real.
  it('simplifies `..` before following links under -L', async () => {
    // The name in front of a `..` has to be a directory either way, so the
    // target exists here (bash answers `cd /link/..` over a dangling link
    // with ENOENT).
    const { dispatch } = dispatcher(['/deep', '/deep/real'])
    const s = session()
    const [, io] = await handleCd(
      dispatch,
      noMountRoot,
      '/link/..',
      s,
      false,
      null,
      through(new Map([['/link', '/deep/real']])),
    )
    expect(io.exitCode).toBe(0)
    expect(s.cwd).toBe('/')
  })

  it('applies `..` to the link target under -P', async () => {
    const { dispatch } = dispatcher(['/deep', '/deep/real'])
    const s = session()
    const [, io] = await handleCd(
      dispatch,
      noMountRoot,
      '/link/..',
      s,
      false,
      null,
      through(new Map([['/link', '/deep/real']])),
      true,
    )
    expect(io.exitCode).toBe(0)
    expect(s.cwd).toBe('/deep')
  })

  it('resolves a link in the middle of the path under -P', async () => {
    const { dispatch } = dispatcher(['/deep/real', '/deep/real/sub'])
    const s = session()
    const [, io] = await handleCd(
      dispatch,
      noMountRoot,
      '/link/sub/..',
      s,
      false,
      null,
      through(new Map([['/link', '/deep/real']])),
      true,
    )
    expect(io.exitCode).toBe(0)
    expect(s.cwd).toBe('/deep/real')
  })

  it("reads `..` off a relative operand's own spelling under -P", async () => {
    // A relative operand reaches cd as a PathSpec whose `virtual` was already
    // normalized against cwd, so -P has to read `rawPath`.
    const { dispatch } = dispatcher(['/deep/real'])
    const s = session('/link/sub')
    const operand = new PathSpec({
      virtual: '/link',
      directory: '/link/',
      vfsPath: '',
      rawPath: '..',
    })
    const [, io] = await handleCd(
      dispatch,
      noMountRoot,
      operand,
      s,
      false,
      null,
      through(new Map([['/link', '/deep/real']])),
      true,
    )
    expect(io.exitCode).toBe(0)
    expect(s.cwd).toBe('/deep/real')
  })

  it('normalizes `..` when the workspace has no symlinks', async () => {
    const { dispatch, seen } = dispatcher(['/data'])
    const s = session('/data/sub')
    const [, io] = await handleCd(dispatch, noMountRoot, '..', s)
    expect(io.exitCode).toBe(0)
    expect(seen).toEqual(['/data'])
    expect(s.cwd).toBe('/data')
  })
})

it('cd reads links on the workspace clock', async () => {
  seenClocks.length = 0
  const clock = new ManualClock()
  const ws = new Workspace(
    { '/data': new RAMVFS() },
    { mode: MountMode.WRITE, shellParser: await getTestParser(), clock },
  )
  try {
    await ws.shell('mkdir /data/d && ln -s /data/d /data/link && cd /data/link')
  } finally {
    await ws.close()
  }
  expect(seenClocks.length).toBeGreaterThan(0)
  expect(seenClocks.every((c) => c === clock)).toBe(true)
})
