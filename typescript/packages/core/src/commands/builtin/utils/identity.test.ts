import { describe, expect, it } from 'vitest'
import { SessionProfile } from '../../../policy/profile.ts'
import { MountMode, PathSpec } from '../../../types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { SessionState } from '../../../workspace/session/session.ts'
import { sessionView } from '../../../workspace/session/state.ts'
import type { WorkspaceOptions } from '../../../workspace/workspace/types.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'
import {
  NOBODY,
  ROOT,
  findUser,
  groupId,
  groupIdNamed,
  groupLabel,
  groupWithId,
  homeOf,
  identityFrom,
  identityOf,
  ownAccount,
  ownerId,
  ownerLabel,
  ownerName,
  sessionUid,
  userHomes,
  userNamed,
} from './identity.ts'

const NO_IDENTITY = { profile: null }

describe('identity', () => {
  it('is root with no profile, uid 1000 when named, unnamed for a bare document', () => {
    expect(ownAccount(NO_IDENTITY)).toBe(ROOT)
    expect(ownAccount(null)).toBe(ROOT)
    expect(ownAccount({ profile: 'root' })).toBe(ROOT)
    expect(ownAccount({ profile: 'nobody' })).toBe(NOBODY)
    expect(ownAccount({ profile: 'admin' })).toEqual({
      name: 'admin',
      uid: 1000,
      group: 'admin',
      gid: 1000,
      home: '/home/admin',
    })
    expect(ownAccount({ profile: '' })).toBeNull()
    expect(sessionUid({ profile: '' })).toBe(1000)
    expect(homeOf({ profile: '' })).toBe('/')
    expect(homeOf(NO_IDENTITY)).toBe('/root')
  })

  it('prefers the entry, then the session', () => {
    const identity = { profile: 'admin' }
    expect(ownerLabel(501, identity)).toBe('501')
    expect(ownerLabel(null, identity)).toBe('admin')
    expect(ownerLabel(1000, identity)).toBe('admin')
    expect(ownerLabel('0', identity)).toBe('root')
    expect(ownerLabel(null, NO_IDENTITY)).toBe('root')
    expect(ownerLabel(null, { profile: '' })).toBe('1000')
    expect(ownerName(null, { profile: '' })).toBeNull()
    expect(ownerLabel('user', identity)).toBe('user')
    expect(ownerId('nobody', identity)).toBe(65534)
    expect(ownerId('user', identity)).toBe('user')
    expect(groupLabel(65534, identity)).toBe('nogroup')
    expect(groupLabel(null, identity)).toBe('admin')
    expect(groupId(null, NO_IDENTITY)).toBe(0)
  })

  it('looks up root, nobody and the session user', () => {
    const identity = { profile: 'admin' }
    expect(findUser(identity, 'admin')).toEqual(ownAccount(identity))
    expect(findUser(identity, '0')).toBe(ROOT)
    expect(findUser(identity, '1000')).toEqual(ownAccount(identity))
    expect(findUser(NO_IDENTITY, '1000')).toBeNull()
    expect(findUser(identity, 'zz')).toBeNull()
    expect(findUser(identity, '+0')).toBe(ROOT)
    expect(findUser({ profile: '+42' }, '+42')).toBeNull()
    expect(userNamed(identity, '0')).toBeNull()
    expect(userNamed(identity, 'nobody')).toBe(NOBODY)
    expect(groupIdNamed(identity, 'nogroup')).toBe(65534)
    expect(groupWithId(identity, 4242)).toBeNull()
    expect(userHomes(identity)).toEqual({
      root: '/root',
      nobody: '/nonexistent',
      admin: '/home/admin',
    })
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

function makeWs(options: Partial<WorkspaceOptions> = {}): Workspace {
  const vfs = new RAMVFS()
  vfs.store.files.set('/f.txt', new TextEncoder().encode('hello'))
  return new Workspace({ '/data': vfs }, { mode: MountMode.WRITE, ...options })
}

describe('identity in a workspace', () => {
  it('ls, stat, find and whoami render the profile', async () => {
    const ws = makeWs({ profiles: { admin: SessionProfile({}) }, profile: 'admin' })
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

  it('renders a session with no profile as root', async () => {
    const ws = makeWs()
    expect((await run(ws, 'ls -l /data/f.txt'))[1]).toBe('-rw-r--r-- 1 root root 5 - /data/f.txt\n')
    expect((await run(ws, 'stat -c "%U %u %G %g" /data/f.txt'))[1]).toBe('root 0 root 0\n')
    await ws.close()
  })

  it('a named session reports its own profile', async () => {
    const ws = makeWs({
      profiles: { default: SessionProfile({}), reviewer: SessionProfile({}) },
    })
    expect((await run(ws, 'stat -c "%G" /data/f.txt'))[1]).toBe('default\n')
    ws.createSession('r1', { profile: 'reviewer' })
    expect((await run(ws, 'stat -c "%G" /data/f.txt', 'r1'))[1]).toBe('reviewer\n')
    await ws.close()
  })

  it('prints a name the database lacks as unknown in id fields', async () => {
    const ws = makeWs()
    await ws.vfs.setattr('/data/f.txt', { uid: 'alice', gid: 'staff' })
    expect((await run(ws, "stat -c '%u %g %U %G' /data/f.txt"))[1]).toBe('? ? alice staff\n')
    expect((await run(ws, 'ls -n /data/f.txt; ls -l /data/f.txt'))[1]).toBe(
      '-rw-r--r-- 1 ? ? 5 - /data/f.txt\n-rw-r--r-- 1 alice staff 5 - /data/f.txt\n',
    )
    await ws.vfs.symlink('/data/l', 'f.txt')
    await ws.vfs.setattr('/data/l', { uid: 'bob', gid: 'ops', nofollow: true })
    expect((await run(ws, "stat -c '%u %g %U %G' /data/l"))[1]).toBe('? ? bob ops\n')
    await ws.close()
  })

  it('refuses a field past the memory budget', async () => {
    const ws = makeWs({ maxMemory: '1MB' })
    const io = await ws.shell("stat -c '%.9999999u' /data/f.txt")
    expect([io.exitCode, io.stderrText]).toEqual([1, 'stat: memory exhausted\n'])
    await ws.close()
    const uncapped = makeWs({ maxMemory: null })
    const wide = await uncapped.shell("stat -c '%.536870889u' /data/f.txt")
    expect([wide.exitCode, wide.stderrText]).toEqual([1, 'stat: memory exhausted\n'])
    await uncapped.close()
  })

  it('cuts a multibyte name by bytes for a precision', async () => {
    const ws = makeWs({ profiles: { équipe: SessionProfile({}) }, profile: 'équipe' })
    const io = await ws.shell("stat -c '[%.2U] [%.3G] [%.1U] [%.1G]' /data/f.txt")
    const enc = (text: string): number[] => [...new TextEncoder().encode(text)]
    expect([...io.stdout]).toEqual([...enc('[é] [éq] ['), 0xc3, ...enc('] ['), 0xc3, ...enc(']\n')])
    await ws.close()
  })

  it('keeps the bytes of a profile name past UTF-8 for the home', async () => {
    const name = 'team\udcff'
    const ws = makeWs({ profiles: { [name]: SessionProfile({}) }, profile: name })
    const io = await ws.shell(`echo ~; echo ~${name}`)
    const home = [...new TextEncoder().encode('/home/team'), 0xff, 0x0a]
    expect(io.exitCode).toBe(0)
    expect([...io.stdout]).toEqual([...home, ...home])
    await ws.close()
  })
})
