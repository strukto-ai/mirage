import { describe, expect, it } from 'vitest'
import { parseSessionProfile } from '../../../policy/profile.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { MountMode, PathSpec } from '../../../types.ts'
import { getTestParser } from '../../../../tests/workspace/fixtures/workspace_fixture.ts'
import { SessionState } from '../../../workspace/session/session.ts'
import { sessionView } from '../../../workspace/session/state.ts'
import type { WorkspaceOptions } from '../../../workspace/workspace/types.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'
import { groupName, identityFrom, identityOf, ownerName } from './identity.ts'

const NO_IDENTITY = { profile: null }

describe('identity', () => {
  it('prefers the entry, then the profile, then "-"', () => {
    const identity = { profile: 'admin' }
    expect(ownerName(501, identity)).toBe('501')
    expect(ownerName(null, identity)).toBe('admin')
    expect(ownerName(null, NO_IDENTITY)).toBe('-')
    expect(ownerName(null, null)).toBe('-')
    expect(groupName('staff', identity)).toBe('staff')
    expect(groupName(null, identity)).toBe('admin')
    expect(groupName(null, NO_IDENTITY)).toBe('-')
  })

  it('reads the session plane', () => {
    const session = new SessionState({ sessionId: 's', profile: 'admin' })
    const view = sessionView(session)
    expect(identityFrom(view)).toEqual({ profile: 'admin' })
    expect(identityFrom(undefined)).toEqual(NO_IDENTITY)
    expect(
      identityOf({ stdin: null, flags: {}, cwd: PathSpec.fromStrPath('/'), session: view }),
    ).toEqual({
      profile: 'admin',
    })
    expect(identityOf({ stdin: null, flags: {}, cwd: PathSpec.fromStrPath('/') })).toEqual(
      NO_IDENTITY,
    )
  })
})

async function run(ws: Workspace, line: string, sessionId?: string): Promise<[number, string]> {
  const io = await ws.shell(line, sessionId === undefined ? {} : { sessionId })
  return [io.exitCode, io.stdoutText]
}

async function makeWs(options: Partial<WorkspaceOptions> = {}): Promise<Workspace> {
  const parser = await getTestParser()
  const vfs = new RAMVFS()
  vfs.store.files.set('/f.txt', new TextEncoder().encode('hello'))
  return new Workspace({ '/data': vfs }, { mode: MountMode.WRITE, shellParser: parser, ...options })
}

describe('identity in a workspace', () => {
  it('ls, stat, find and whoami render the profile', async () => {
    const ws = await makeWs({ profiles: { admin: parseSessionProfile({}) }, profile: 'admin' })
    expect((await run(ws, 'ls -l /data/f.txt'))[1]).toBe(
      '-rw-r--r-- 1 admin admin 5 - /data/f.txt\n',
    )
    expect((await run(ws, 'stat -c "%U %G" /data/f.txt'))[1]).toBe('admin admin\n')
    expect((await run(ws, "find /data -type f -printf '%u %g %p\\n'"))[1]).toBe(
      'admin admin /data/f.txt\n',
    )
    expect((await run(ws, 'whoami'))[1]).toBe('admin\n')
    await ws.close()
  })

  it('renders a session with no profile as "-"', async () => {
    const ws = await makeWs()
    expect((await run(ws, 'ls -l /data/f.txt'))[1]).toBe('-rw-r--r-- 1 - - 5 - /data/f.txt\n')
    expect((await run(ws, 'stat -c "%U %G" /data/f.txt'))[1]).toBe('- -\n')
    await ws.close()
  })

  it('a named session reports its own profile', async () => {
    const ws = await makeWs({
      profiles: { default: parseSessionProfile({}), reviewer: parseSessionProfile({}) },
    })
    expect((await run(ws, 'stat -c "%G" /data/f.txt'))[1]).toBe('default\n')
    ws.createSession('r1', { profile: 'reviewer' })
    expect((await run(ws, 'stat -c "%G" /data/f.txt', 'r1'))[1]).toBe('reviewer\n')
    await ws.close()
  })
})
