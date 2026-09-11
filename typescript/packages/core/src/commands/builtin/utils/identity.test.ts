import { describe, expect, it } from 'vitest'
import { parseSessionProfile } from '../../../policy/profile.ts'
import { RAMResource } from '../../../resource/ram/ram.ts'
import { MountMode } from '../../../types.ts'
import { getTestParser } from '../../../workspace/fixtures/workspace_fixture.ts'
import { Session } from '../../../workspace/session/session.ts'
import { sessionView } from '../../../workspace/session/state.ts'
import type { WorkspaceOptions } from '../../../workspace/workspace/types.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'
import { NO_IDENTITY, groupName, identityFrom, identityOf, ownerName } from './identity.ts'

describe('identity', () => {
  it('prefers the entry, then the identity, then "-"', () => {
    const identity = { user: 'alice', profile: 'admin' }
    expect(ownerName(501, identity)).toBe('501')
    expect(ownerName(null, identity)).toBe('alice')
    expect(ownerName(null, { user: null, profile: 'admin' })).toBe('-')
    expect(ownerName(null, null)).toBe('-')
    expect(groupName('staff', identity)).toBe('staff')
    expect(groupName(null, identity)).toBe('admin')
    expect(groupName(null, { user: 'alice', profile: null })).toBe('-')
    expect(groupName(null, NO_IDENTITY)).toBe('-')
  })

  it('reads the name plane and the session plane', () => {
    const session = new Session({ sessionId: 's', profile: 'admin' })
    const view = sessionView(session)
    const ns = { user: 'alice' }
    expect(identityFrom(ns, view)).toEqual({ user: 'alice', profile: 'admin' })
    expect(identityFrom(undefined, undefined)).toEqual(NO_IDENTITY)
    expect(
      identityOf({ stdin: null, flags: {}, filetypeFns: null, cwd: '/', ns, sessionView: view }),
    ).toEqual({
      user: 'alice',
      profile: 'admin',
    })
    expect(identityOf({ stdin: null, flags: {}, filetypeFns: null, cwd: '/' })).toEqual(NO_IDENTITY)
  })
})

async function run(ws: Workspace, line: string, sessionId?: string): Promise<[number, string]> {
  const io = await ws.execute(line, sessionId === undefined ? {} : { sessionId })
  return [io.exitCode, io.stdoutText]
}

async function makeWs(options: Partial<WorkspaceOptions> = {}): Promise<Workspace> {
  const parser = await getTestParser()
  const resource = new RAMResource()
  resource.store.files.set('/f.txt', new TextEncoder().encode('hello'))
  return new Workspace(
    { '/data': resource },
    { mode: MountMode.WRITE, shellParser: parser, ...options },
  )
}

describe('identity in a workspace', () => {
  it('ls, stat and find render the user and the profile', async () => {
    const ws = await makeWs({
      agentId: 'alice',
      profiles: { admin: parseSessionProfile({}) },
      profile: 'admin',
    })
    expect((await run(ws, 'ls -l /data/f.txt'))[1]).toBe(
      '-rw-r--r-- 1 alice admin 5 Jan  1 00:00 /data/f.txt\n',
    )
    expect((await run(ws, 'stat -c "%U %G" /data/f.txt'))[1]).toBe('alice admin\n')
    expect((await run(ws, "find /data -type f -printf '%u %g %p\\n'"))[1]).toBe(
      'alice admin /data/f.txt\n',
    )
    expect((await run(ws, 'whoami'))[1]).toBe('alice\n')
    await ws.close()
  })

  it('renders a missing user or profile as "-"', async () => {
    const ws = await makeWs()
    expect((await run(ws, 'ls -l /data/f.txt'))[1]).toBe(
      '-rw-r--r-- 1 - - 5 Jan  1 00:00 /data/f.txt\n',
    )
    expect((await run(ws, 'stat -c "%U %G" /data/f.txt'))[1]).toBe('- -\n')
    await ws.close()
  })

  it('a named session reports its own profile', async () => {
    const ws = await makeWs({
      agentId: 'alice',
      profiles: { default: parseSessionProfile({}), reviewer: parseSessionProfile({}) },
    })
    expect((await run(ws, 'stat -c "%G" /data/f.txt'))[1]).toBe('default\n')
    ws.createSession('r1', { profile: 'reviewer' })
    expect((await run(ws, 'stat -c "%G" /data/f.txt', 'r1'))[1]).toBe('reviewer\n')
    await ws.close()
  })
})
