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
import { OpsRegistry } from '../ops/registry.ts'
import { RAMVFS } from '../vfs/ram/ram.ts'
import { MountMode } from '../types.ts'
import { parseSessionProfile } from '../policy/profile.ts'
import type { Action, OpsContext, Policy } from '../policy/index.ts'
import { runWithSession } from '../context/session_context.ts'
import { getTestParser, stderrStr, stdoutStr } from './fixtures/workspace_fixture.ts'
import { Session } from './workspace/handle.ts'
import { Workspace } from './workspace/workspace.ts'

/** Refuse the unlink of one exact path, whatever door asked. */
class DenyRemnantUnlink implements Policy {
  preOps(ctx: OpsContext): Action | null {
    if (ctx.op === 'unlink' && ctx.path.virtual === '/a/d/sec/k') {
      return { kind: 'deny', reason: 'protected' }
    }
    return null
  }
}

const CARVE_PROFILE = parseSessionProfile({
  mounts: { '/repo': 'r' },
  paths: { hide: ['/repo'], show: { '/repo/public': 'r' } },
})

const open: Workspace[] = []

afterEach(async () => {
  for (const ws of open.splice(0)) await ws.close()
})

async function hiding(): Promise<Workspace> {
  const parser = await getTestParser()
  const ws = new Workspace(
    { '/data': [new RAMVFS(), MountMode.WRITE] as const },
    {
      mode: MountMode.WRITE,
      shellParser: parser,
      profiles: { agent: parseSessionProfile({ paths: { hide: ['/data/vault'] } }) },
      profile: 'agent',
    },
  )
  open.push(ws)
  return ws
}

async function seeded(mode: MountMode = MountMode.WRITE): Promise<Workspace> {
  const parser = await getTestParser()
  const repo = new RAMVFS()
  const registry = new OpsRegistry()
  registry.registerVfs(repo)
  const ws = new Workspace(
    { '/repo': [repo, mode] as const },
    { mode: MountMode.WRITE, ops: registry, shellParser: parser },
  )
  open.push(ws)
  const io = await ws.shell(
    'mkdir -p /repo/secrets /repo/public/docs && ' +
      "printf 'hello repo\\n' > /repo/README.md && " +
      "printf 'PRIVATE needle\\n' > /repo/secrets/key.pem && " +
      "printf '<h1>needle</h1>\\n' > /repo/public/index.html && " +
      "printf 'docs needle\\n' > /repo/public/docs/a.txt",
  )
  expect(io.exitCode).toBe(0)
  return ws
}

async function carved(): Promise<Workspace> {
  const ws = await seeded()
  ws.createSession('rev', { profile: CARVE_PROFILE })
  return ws
}

describe('the path axis end to end', () => {
  it('a deeper show reopens its subtree', async () => {
    const ws = await carved()
    const ok = await ws.shell('cat /repo/public/index.html', { sessionId: 'rev' })
    expect(ok.exitCode).toBe(0)
    expect(stdoutStr(ok)).toContain('needle')
    const denied = await ws.shell('cat /repo/secrets/key.pem', { sessionId: 'rev' })
    expect(denied.exitCode).not.toBe(0)
    expect(stderrStr(denied)).toBe('cat: /repo/secrets/key.pem: No such file or directory\n')
  })

  it('every enumeration surface agrees on the carve-out', async () => {
    // One tree probed through ls, globs, find, grep -r and du: the same
    // predicate answers all of them, and this battery is what holds the
    // surfaces together if one grows its own filter.
    const ws = await carved()
    const listed = await ws.shell('ls /repo', { sessionId: 'rev' })
    expect(stdoutStr(listed).split(/\s+/).filter(Boolean)).toEqual(['public'])
    const globbed = await ws.shell('echo /repo/*', { sessionId: 'rev' })
    expect(stdoutStr(globbed)).toBe('/repo/public\n')
    const found = await ws.shell('find /repo', { sessionId: 'rev' })
    expect(stdoutStr(found)).toBe(
      '/repo\n/repo/public\n/repo/public/docs\n/repo/public/docs/a.txt\n/repo/public/index.html\n',
    )
    const grepped = await ws.shell('grep -rl needle /repo', { sessionId: 'rev' })
    expect(stdoutStr(grepped).split('\n').filter(Boolean).sort()).toEqual([
      '/repo/public/docs/a.txt',
      '/repo/public/index.html',
    ])
    const sized = await ws.shell('du -a /repo', { sessionId: 'rev' })
    const duPaths = stdoutStr(sized)
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\t')[1])
    expect(duPaths).not.toContain('/repo/secrets/key.pem')
    expect(duPaths).toContain('/repo/public/index.html')
  })

  it('the road to the carve-out exists', async () => {
    // `/repo` itself lies under the hide, but a visible show anchors
    // below it, so the directory stays traversable and lists only the
    // carve-out.
    const ws = await carved()
    const walked = await ws.shell('cd /repo && ls', { sessionId: 'rev' })
    expect(walked.exitCode).toBe(0)
    expect(stdoutStr(walked).split(/\s+/).filter(Boolean)).toEqual(['public'])
    const statOk = await ws.shell('test -d /repo/public && echo yes', { sessionId: 'rev' })
    expect(stdoutStr(statOk)).toBe('yes\n')
    const statGone = await ws.shell('test -e /repo/secrets || echo gone', { sessionId: 'rev' })
    expect(stdoutStr(statGone)).toBe('gone\n')
  })

  it('hide speaks before the mode', async () => {
    // A create under a hidden directory answers ENOENT, as every read
    // of that directory does, so a write cannot detect the hide; the
    // mode never speaks about a path the session cannot see, so no
    // refusal leaks that the region is read-only. Neither write lands.
    const ws = await carved()
    const create = await ws.shell('echo x > /repo/secrets/new.txt', { sessionId: 'rev' })
    expect(stderrStr(create)).toBe('/repo/secrets/new.txt: No such file or directory\n')
    const clobber = await ws.shell('echo x > /repo/secrets/key.pem', { sessionId: 'rev' })
    expect(stderrStr(clobber)).toBe('/repo/secrets/key.pem: No such file or directory\n')
    expect(stdoutStr(await ws.shell('cat /repo/secrets/key.pem'))).toBe('PRIVATE needle\n')
  })

  it('the op door runs as the default session', async () => {
    // `ws.vfs`, `ws.dispatch`, `ws.stat` and `ws.readdir` are judged
    // under the default session's profile, the way a bare `shell`
    // is, so an agent whose file tool reads through the facade is
    // confined like its shell. A session already bound is kept, and
    // A handle runs the same door as another session over the
    // same ledger; a session with an explicit empty profile is the
    // host's door to what the default profile hides.
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/data': [new RAMVFS(), MountMode.WRITE] as const },
      {
        mode: MountMode.WRITE,
        shellParser: parser,
        profiles: { agent: parseSessionProfile({ paths: { hide: ['/data/vault'] } }) },
        profile: 'agent',
      },
    )
    open.push(ws)
    const host = ws.createSession('host', { profile: parseSessionProfile({}) })
    const door = new Session(ws, host.sessionId).vfs
    expect(door.records).toBe(ws.vfs.records)
    await door.mkdir('/data/vault')
    await door.writeFile('/data/vault/secret', 'top\n')
    expect(await door.readFileText('/data/vault/secret')).toBe('top\n')
    await expect(ws.vfs.readFile('/data/vault/secret')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(ws.stat('/data/vault')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(ws.dispatch('read', '/data/vault/secret')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(await ws.readdir('/data')).toEqual([])
    expect(await ws.vfs.readdir('/data')).toEqual([])
    await runWithSession(host, async () => {
      expect(await ws.vfs.readFileText('/data/vault/secret')).toBe('top\n')
    })
  })

  it("the op door does not adopt another workspace's session", async () => {
    // A session bound by another workspace describes that workspace:
    // an embedder callback reaching this door from inside the other's
    // line runs as this workspace's default session, not as the wider
    // session it arrived under. A binding that names no owner is a
    // deliberate placement (a kernel mount binds one that way) and is
    // kept as before.
    const parser = await getTestParser()
    const other = new Workspace(
      { '/data': [new RAMVFS(), MountMode.WRITE] as const },
      { mode: MountMode.WRITE, shellParser: parser },
    )
    open.push(other)
    const wide = other.createSession('wide', { profile: parseSessionProfile({}) })
    const ws = await hiding()
    const host = ws.createSession('host', { profile: parseSessionProfile({}) })
    const door = new Session(ws, host.sessionId).vfs
    await door.mkdir('/data/vault')
    await door.writeFile('/data/vault/secret', 'top\n')
    await runWithSession(
      wide,
      async () => {
        await expect(ws.vfs.readFile('/data/vault/secret')).rejects.toMatchObject({
          code: 'ENOENT',
        })
        expect(await door.readFileText('/data/vault/secret')).toBe('top\n')
      },
      other.sessionManager,
    )
    await runWithSession(wide, async () => {
      expect(await ws.vfs.readFileText('/data/vault/secret')).toBe('top\n')
    })
  })

  it('the op door does not follow a link the session cannot see', async () => {
    // The facade follows links before the door so the record carries
    // the resolved path, and that follow used to run unbound: a link
    // inside hidden space reached the door already resolved to its
    // visible target, so the door's check of the typed path never saw
    // the hide. The follow now runs as the session and only from a
    // path it can see, so the link reads as absent.
    const ws = await hiding()
    const host = ws.createSession('host', { profile: parseSessionProfile({}) })
    const door = new Session(ws, host.sessionId).vfs
    await door.writeFile('/data/pub.txt', 'pub\n')
    await door.mkdir('/data/vault')
    await door.symlink('/data/vault/lk', '/data/pub.txt')
    expect(await door.readFileText('/data/vault/lk')).toBe('pub\n')
    await expect(ws.vfs.readFile('/data/vault/lk')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(ws.vfs.writeFile('/data/vault/lk', 'x\n')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(await door.readFileText('/data/pub.txt')).toBe('pub\n')
  })

  it('a write below the mode reads Read-only file system', async () => {
    const ws = await carved()
    const refused = await ws.shell('echo x > /repo/public/new.txt', { sessionId: 'rev' })
    expect(refused.exitCode).not.toBe(0)
    expect(stderrStr(refused)).toBe('/repo/public/new.txt: Read-only file system\n')
  })

  it('a deeper show mode refines the mount cap', async () => {
    // mounts: {/repo: r} + show {"/repo/build": rw}: the deeper entry
    // wins below its anchor, the mount cap holds everywhere else, and
    // the whole-mount write command gate lets the line reach the op
    // door instead of refusing the command outright.
    const ws = await seeded()
    ws.createSession('rev', {
      profile: parseSessionProfile({
        mounts: { '/repo': 'r' },
        paths: { show: { '/repo/build': 'rw' } },
      }),
    })
    const ok = await ws.shell(
      'mkdir /repo/build && echo out > /repo/build/a.txt && cat /repo/build/a.txt',
      { sessionId: 'rev' },
    )
    expect(ok.exitCode).toBe(0)
    expect(stdoutStr(ok)).toBe('out\n')
    const held = await ws.shell('echo x > /repo/README.md', { sessionId: 'rev' })
    expect(stderrStr(held)).toBe('/repo/README.md: Read-only file system\n')
  })

  it('a show mode never grants past the configured mode', async () => {
    // The mount's own mode stays the strongest answer possible: a show
    // stating rw on a READ-configured mount changes nothing.
    const parser = await getTestParser()
    const repo = new RAMVFS()
    const registry = new OpsRegistry()
    registry.registerVfs(repo)
    const ws = new Workspace(
      { '/repo': [repo, MountMode.READ] as const },
      { mode: MountMode.WRITE, ops: registry, shellParser: parser },
    )
    open.push(ws)
    ws.createSession('rev', {
      profile: parseSessionProfile({ paths: { show: { '/repo/build': 'rw' } } }),
    })
    const refused = await ws.shell('echo x > /repo/build/a.txt', { sessionId: 'rev' })
    expect(refused.exitCode).not.toBe(0)
    expect(stderrStr(refused)).toBe('/repo/build/a.txt: Read-only file system\n')
  })

  it('a show without a covering hide restricts nothing', async () => {
    // 12.3b: show is a carve-out and a mode statement, never an
    // allowlist; a path outside every show entry stays visible.
    const ws = await seeded()
    ws.createSession('rev', {
      profile: parseSessionProfile({ paths: { show: { '/repo/public': 'r' } } }),
    })
    const ok = await ws.shell('cat /repo/README.md', { sessionId: 'rev' })
    expect(ok.exitCode).toBe(0)
    expect(stdoutStr(ok)).toContain('hello')
  })

  it('scripts run only from an x region', async () => {
    // x per script path: the show grants rwx below one subtree, so a
    // script there runs and the same interpreter refuses one outside
    // it, in file-operand voice, exit 126.
    const ws = await seeded(MountMode.EXEC)
    ws.createSession('rev', {
      profile: parseSessionProfile({
        mounts: { '/repo': 'r' },
        paths: { show: { '/repo/tools': 'rwx' } },
      }),
    })
    const seededTool = await ws.shell(
      `mkdir /repo/tools && echo 'print("ran")' > /repo/tools/go.py`,
      { sessionId: 'rev' },
    )
    expect(seededTool.exitCode).toBe(0)
    const ran = await ws.shell('python3 /repo/tools/go.py', { sessionId: 'rev' })
    expect(ran.exitCode).toBe(0)
    expect(stdoutStr(ran)).toBe('ran\n')
    const outside = await ws.shell('python3 /repo/public/index.html', { sessionId: 'rev' })
    expect(outside.exitCode).toBe(126)
    expect(stderrStr(outside)).toBe('python3: /repo/public/index.html: not in EXEC mode\n')
  }, 120_000)

  it('inline permissions cannot add show', async () => {
    const ws = await seeded()
    expect(() =>
      ws.createSession('rev', {
        profile: CARVE_PROFILE,
        permissions: parseSessionProfile({ paths: { show: ['/repo/secrets'] } }),
      }),
    ).toThrow('not show entries')
  })

  it('the write gate holds per path inside an admitted command', async () => {
    // The command gate admits mkdir because one region grants writes;
    // each write the handler then makes still answers for its own
    // region, so the whole-mount admission opens no side door.
    const ws = await seeded()
    ws.createSession('rev', {
      profile: parseSessionProfile({
        mounts: { '/repo': 'r' },
        paths: { show: { '/repo/build': 'rw' } },
      }),
    })
    const ok = await ws.shell('mkdir /repo/build', { sessionId: 'rev' })
    expect(ok.exitCode).toBe(0)
    const held = await ws.shell('mkdir /repo/probe', { sessionId: 'rev' })
    expect(held.exitCode).not.toBe(0)
    expect(stderrStr(held)).toContain('Read-only file system')
    const removed = await ws.shell('rm /repo/README.md', { sessionId: 'rev' })
    expect(removed.exitCode).not.toBe(0)
    expect(stderrStr(removed)).toContain('Read-only file system')
    const still = await ws.shell('cat /repo/README.md', { sessionId: 'rev' })
    expect(still.exitCode).toBe(0)
    // Copying OUT of the read-only region is a read plus a write into
    // the granted one, both allowed; moving back mutates a read-only
    // endpoint and is refused.
    const copied = await ws.shell('cp /repo/README.md /repo/build/copy.md', { sessionId: 'rev' })
    expect(copied.exitCode).toBe(0)
    const moved = await ws.shell('mv /repo/build/copy.md /repo/copy.md', { sessionId: 'rev' })
    expect(moved.exitCode).not.toBe(0)
    expect(stderrStr(moved)).toContain('Read-only file system')
  })

  it('a subtree mutation answers for the regions below it', async () => {
    // A native rm -r or a directory rename covers everything below its
    // operand in one backend call, so a read-only carve-out below the
    // operand refuses the whole op up front rather than being deleted
    // past the per-path check.
    const ws = await seeded()
    const grown = await ws.shell(
      'mkdir -p /repo/tree/locked && ' +
        "printf 'kept\\n' > /repo/tree/locked/f.txt && " +
        "printf 'open\\n' > /repo/tree/open.txt",
    )
    expect(grown.exitCode).toBe(0)
    ws.createSession('rev', {
      profile: parseSessionProfile({
        paths: { show: { '/repo/tree/locked': 'r' } },
      }),
    })
    const held = await ws.shell('rm -r /repo/tree', { sessionId: 'rev' })
    expect(held.exitCode).not.toBe(0)
    expect(stderrStr(held)).toBe("rm: cannot remove '/repo/tree/locked': Read-only file system\n")
    expect((await ws.shell('cat /repo/tree/locked/f.txt', { sessionId: 'rev' })).exitCode).toBe(0)
    expect((await ws.shell('cat /repo/tree/open.txt', { sessionId: 'rev' })).exitCode).toBe(0)
    const moved = await ws.shell('mv /repo/tree /repo/moved', { sessionId: 'rev' })
    expect(moved.exitCode).not.toBe(0)
    expect(stderrStr(moved)).toContain('Read-only file system')
    expect((await ws.shell('cat /repo/tree/locked/f.txt', { sessionId: 'rev' })).exitCode).toBe(0)
    // A subtree with no carve-out below still mutates freely.
    const ok = await ws.shell('rm -r /repo/public', { sessionId: 'rev' })
    expect(ok.exitCode).toBe(0)
  })

  it('a globbed show reopens and stays walkable', async () => {
    // The carve-out spelled as a pattern: the anchor directory the glob
    // exposes children of stays traversable, so the road to the matches
    // exists.
    const ws = await seeded()
    ws.createSession('rev', {
      profile: parseSessionProfile({
        mounts: { '/repo': 'r' },
        paths: { hide: ['/repo'], show: ['/repo/public/*'] },
      }),
    })
    const walked = await ws.shell('ls /repo', { sessionId: 'rev' })
    expect(stdoutStr(walked).split(/\s+/).filter(Boolean)).toEqual(['public'])
    const listed = await ws.shell('ls /repo/public', { sessionId: 'rev' })
    expect(listed.exitCode).toBe(0)
    const found = await ws.shell('find /repo -type f', { sessionId: 'rev' })
    const out = stdoutStr(found).split('\n').filter(Boolean)
    expect(out).toContain('/repo/public/index.html')
    expect(out).not.toContain('/repo/secrets/key.pem')
  })

  it('a fork carries the carve-out', async () => {
    // A subshell forks the session; the axis rides the inherited
    // fields, so the fork answers exactly like its parent.
    const ws = await carved()
    const forked = await ws.shell('(cat /repo/secrets/key.pem)', { sessionId: 'rev' })
    expect(forked.exitCode).not.toBe(0)
    expect(stderrStr(forked)).toContain('No such file or directory')
    const ok = await ws.shell('(cat /repo/public/index.html)', { sessionId: 'rev' })
    expect(ok.exitCode).toBe(0)
  })
})

async function boxed(profile: object): Promise<Workspace> {
  const parser = await getTestParser()
  const repo = new RAMVFS()
  const registry = new OpsRegistry()
  registry.registerVfs(repo)
  const ws = new Workspace(
    { '/repo': [repo, MountMode.WRITE] as const },
    { mode: MountMode.WRITE, ops: registry, shellParser: parser },
  )
  open.push(ws)
  const io = await ws.shell(
    'mkdir -p /repo/box/sec /repo/only && ' +
      "printf 'v\\n' > /repo/box/a.txt && " +
      "printf 's\\n' > /repo/box/sec/k && " +
      "printf 't\\n' > /repo/box/x.tkn && " +
      "printf 'h\\n' > /repo/only/h",
  )
  expect(io.exitCode).toBe(0)
  ws.createSession('rev', { profile: parseSessionProfile(profile) })
  return ws
}

describe('subtree mutations against hides', () => {
  it('mv that would reveal hidden content refuses', async () => {
    // The hide anchors at /repo/box/sec; the move would re-anchor its
    // content to /repo/moved/sec, which nothing hides, so it refuses
    // in GNU's permission-denied voice and the source stays whole.
    const ws = await boxed({ paths: { hide: ['/repo/box/sec'] } })
    const refused = await ws.shell('mv /repo/box /repo/moved', { sessionId: 'rev' })
    expect(refused.exitCode).toBe(1)
    expect(stderrStr(refused)).toBe(
      "mv: cannot move '/repo/box' to '/repo/moved': Permission denied\n",
    )
    const intact = await ws.shell('test -e /repo/box/sec/k')
    expect(intact.exitCode).toBe(0)
  })

  it('mv rides a component-pattern hide along', async () => {
    // *.tkn follows the name wherever the content goes, so nothing is
    // revealed and the move proceeds, the hidden file riding along.
    const ws = await boxed({ paths: { hide: ['*.tkn'] } })
    const ok = await ws.shell('mv /repo/box /repo/moved', { sessionId: 'rev' })
    expect(ok.exitCode).toBe(0)
    const listing = await ws.shell('ls /repo/moved', { sessionId: 'rev' })
    expect(stdoutStr(listing)).toBe('a.txt\nsec\n')
    const survived = await ws.shell('cat /repo/moved/x.tkn')
    expect(survived.exitCode).toBe(0)
    expect(stdoutStr(survived)).toBe('t\n')
  })

  it('mv of a file under an anchored-pattern hide passes', async () => {
    // /repo/*/sec could match below any directory under /repo, so a
    // directory move refuses conservatively, but a regular file
    // carries nothing below it: renaming one reveals nothing.
    const ws = await boxed({ paths: { hide: ['/repo/*/sec'] } })
    const moved = await ws.shell('mv /repo/box/a.txt /repo/box/b.txt', { sessionId: 'rev' })
    expect(moved.exitCode).toBe(0)
    const listing = await ws.shell('ls /repo/box', { sessionId: 'rev' })
    expect(stdoutStr(listing)).toContain('b.txt')
  })

  it('mv of a directory under an anchored-pattern hide refuses', async () => {
    const ws = await boxed({ paths: { hide: ['/repo/*/sec'] } })
    const refused = await ws.shell('mv /repo/box /repo/moved', { sessionId: 'rev' })
    expect(refused.exitCode).toBe(1)
    expect(stderrStr(refused)).toContain('Permission denied')
  })

  it('mv -b refusal leaves the destination backup-free', async () => {
    // The reveal guard answers before -b renames the destination
    // aside, so a refused move mutates nothing: no backup, destination
    // intact.
    const ws = await boxed({ paths: { hide: ['/repo/box/sec'] } })
    const prep = await ws.shell('mkdir /repo/moved', { sessionId: 'rev' })
    expect(prep.exitCode).toBe(0)
    const refused = await ws.shell('mv -b -T /repo/box /repo/moved', { sessionId: 'rev' })
    expect(refused.exitCode).toBe(1)
    expect(stderrStr(refused)).toContain('Permission denied')
    const intact = await ws.shell('test -d /repo/moved')
    expect(intact.exitCode).toBe(0)
    const backup = await ws.shell('test -e /repo/moved~')
    expect(backup.exitCode).toBe(1)
  })

  it('cp -r copies the visible view silently', async () => {
    const ws = await boxed({ paths: { hide: ['/repo/box/sec'] } })
    const copied = await ws.shell('cp -r /repo/box /repo/copy', { sessionId: 'rev' })
    expect(copied.exitCode).toBe(0)
    expect(stderrStr(copied)).toBe('')
    const listing = await ws.shell('find /repo/copy')
    expect(stdoutStr(listing)).toBe('/repo/copy\n/repo/copy/a.txt\n/repo/copy/x.tkn\n')
  })

  it('rmdir takes hidden remnants with the directory', async () => {
    // The session sees an empty directory; a not-empty refusal would
    // leak that something invisible exists, so the remnants go with it.
    const ws = await boxed({ paths: { hide: ['/repo/only/h'] } })
    const empty = await ws.shell('ls -a /repo/only', { sessionId: 'rev' })
    expect(stdoutStr(empty)).toBe('')
    const removed = await ws.shell('rmdir /repo/only', { sessionId: 'rev' })
    expect(removed.exitCode).toBe(0)
    const gone = await ws.shell('test -e /repo/only')
    expect(gone.exitCode).toBe(1)
  })

  it('rmdir with a visible child keeps the refusal', async () => {
    const ws = await boxed({ paths: { hide: ['/repo/box/sec'] } })
    const refused = await ws.shell('rmdir /repo/box', { sessionId: 'rev' })
    expect(refused.exitCode).toBe(1)
    expect(stderrStr(refused)).toContain('Directory not empty')
  })

  it('rm -r still destroys hidden content below', async () => {
    const ws = await boxed({ paths: { hide: ['/repo/box/sec'] } })
    const removed = await ws.shell('rm -r /repo/box', { sessionId: 'rev' })
    expect(removed.exitCode).toBe(0)
    const gone = await ws.shell('test -e /repo/box')
    expect(gone.exitCode).toBe(1)
  })

  it('a read-only hidden remnant keeps the refusal', async () => {
    // A show may state a mode at the same anchor a hide covers (the
    // hide wins visibility on the tie), leaving content the session
    // cannot see that its mode still protects. Every cascade deletion
    // answers for its own path's mode, so the protected remnant
    // survives and the rmdir keeps a not-empty refusal.
    const ws = await boxed({
      paths: { hide: ['/repo/only/h'], show: { '/repo/only/h': 'r' } },
    })
    const refused = await ws.shell('rmdir /repo/only', { sessionId: 'rev' })
    expect(refused.exitCode).toBe(1)
    expect(stderrStr(refused)).toBe("rmdir: failed to remove '/repo/only': Directory not empty\n")
    const kept = await ws.shell('cat /repo/only/h')
    expect(stdoutStr(kept)).toBe('h\n')
  })

  it('a mounted child keeps the command plane refusal', async () => {
    // Command-plane twin of the ops door's merged emptiness: the
    // backend listing holds only hidden entries, but the namespace
    // owes the directory a visible mounted child no backend can list.
    // The stamped children join the guard's emptiness judgment, so the
    // not-empty refusal stays instead of the cascade destroying the
    // hidden remnant and reporting success while the mount remains.
    const parser = await getTestParser()
    const repo = new RAMVFS()
    const m = new RAMVFS()
    const registry = new OpsRegistry()
    registry.registerVfs(repo)
    registry.registerVfs(m)
    const ws = new Workspace(
      { '/repo': [repo, MountMode.WRITE] as const, '/repo/only/m': [m, MountMode.WRITE] as const },
      { mode: MountMode.WRITE, ops: registry, shellParser: parser },
    )
    open.push(ws)
    const io = await ws.shell("mkdir -p /repo/only && printf 'h\\n' > /repo/only/h")
    expect(io.exitCode).toBe(0)
    ws.createSession('rev', {
      profile: parseSessionProfile({ paths: { hide: ['/repo/only/h'] } }),
    })
    const refused = await ws.shell('rmdir /repo/only', { sessionId: 'rev' })
    expect(refused.exitCode).toBe(1)
    expect(stderrStr(refused)).toBe("rmdir: failed to remove '/repo/only': Directory not empty\n")
    const kept = await ws.shell('cat /repo/only/h')
    expect(stdoutStr(kept)).toBe('h\n')
  })
})

describe('the ops door against hides', () => {
  it('leaves a read-only hidden remnant intact and keeps the refusal', async () => {
    // The dispatcher's cascade routes every deletion through the same
    // mode fence normal dispatch applies, so FUSE and ws.vfs callers
    // cannot destroy a mode-protected remnant either.
    const parser = await getTestParser()
    const repo = new RAMVFS()
    const registry = new OpsRegistry()
    registry.registerVfs(repo)
    const ws = new Workspace(
      { '/repo': [repo, MountMode.WRITE] as const },
      { mode: MountMode.WRITE, ops: registry, shellParser: parser },
    )
    open.push(ws)
    const io = await ws.shell("mkdir -p /repo/only && printf 'h\\n' > /repo/only/h")
    expect(io.exitCode).toBe(0)
    const sess = ws.createSession('rev', {
      profile: parseSessionProfile({
        paths: { hide: ['/repo/only/h'], show: { '/repo/only/h': 'r' } },
      }),
    })
    await runWithSession(sess, async () => {
      await expect(ws.dispatch('rmdir', '/repo/only')).rejects.toMatchObject({
        code: 'ENOTEMPTY',
      })
    })
    const kept = await ws.shell('cat /repo/only/h')
    expect(stdoutStr(kept)).toBe('h\n')
  })

  it('keeps the refusal when a visible mounted child remains', async () => {
    // The backend cannot see a mount nested below the directory, so
    // the remnant arm judges emptiness on the door's merged listing:
    // the visible mounted child keeps the not-empty refusal instead of
    // the arm destroying the hidden backend remnants and reporting a
    // successful rmdir while the mount remains.
    const parser = await getTestParser()
    const a = new RAMVFS()
    const m = new RAMVFS()
    const registry = new OpsRegistry()
    registry.registerVfs(a)
    registry.registerVfs(m)
    const ws = new Workspace(
      { '/a': [a, MountMode.WRITE] as const, '/a/d/m': [m, MountMode.WRITE] as const },
      { mode: MountMode.WRITE, ops: registry, shellParser: parser },
    )
    open.push(ws)
    const io = await ws.shell("mkdir -p /a/d/sec && printf 'k\\n' > /a/d/sec/k")
    expect(io.exitCode).toBe(0)
    const sess = ws.createSession('rev', {
      profile: parseSessionProfile({ paths: { hide: ['/a/d/sec'] } }),
    })
    await runWithSession(sess, async () => {
      await expect(ws.dispatch('rmdir', '/a/d')).rejects.toMatchObject({
        code: 'ENOTEMPTY',
      })
    })
    const kept = await ws.shell('cat /a/d/sec/k')
    expect(stdoutStr(kept)).toBe('k\n')
  })

  it('a policy denied remnant keeps the refusal', async () => {
    // The gate that admitted the rmdir judged the directory; each
    // cascade deletion answers preOps with its own child path, so a
    // policy that protects the hidden file refuses its unlink, the
    // cascade folds the denial into the original not-empty refusal,
    // and the protected content survives.
    const parser = await getTestParser()
    const a = new RAMVFS()
    const registry = new OpsRegistry()
    registry.registerVfs(a)
    const ws = new Workspace(
      { '/a': [a, MountMode.WRITE] as const },
      {
        mode: MountMode.WRITE,
        ops: registry,
        shellParser: parser,
        policies: [new DenyRemnantUnlink()],
      },
    )
    open.push(ws)
    const io = await ws.shell("mkdir -p /a/d/sec && printf 'k\\n' > /a/d/sec/k")
    expect(io.exitCode).toBe(0)
    const sess = ws.createSession('rev', {
      profile: parseSessionProfile({ paths: { hide: ['/a/d/sec'] } }),
    })
    await runWithSession(sess, async () => {
      await expect(ws.dispatch('rmdir', '/a/d')).rejects.toMatchObject({
        code: 'ENOTEMPTY',
      })
    })
    const kept = await ws.shell('cat /a/d/sec/k')
    expect(stdoutStr(kept)).toBe('k\n')
  })

  it('takes hidden namespace links with the removed directory', async () => {
    // A hidden link is invisible to every backend, so the cascade walk
    // cannot take it; left in the node table it synthesizes /a/d right
    // back once the hide lifts, resurfacing the removed tree.
    const parser = await getTestParser()
    const a = new RAMVFS()
    const registry = new OpsRegistry()
    registry.registerVfs(a)
    const ws = new Workspace(
      { '/a': [a, MountMode.WRITE] as const },
      { mode: MountMode.WRITE, ops: registry, shellParser: parser },
    )
    open.push(ws)
    const io = await ws.shell(
      "mkdir -p /a/d/sec && printf 'k\\n' > /a/d/sec/k && ln -s /a/t /a/d/lnk",
    )
    expect(io.exitCode).toBe(0)
    const sess = ws.createSession('rev', {
      profile: parseSessionProfile({ paths: { hide: ['/a/d/sec', '/a/d/lnk'] } }),
    })
    await runWithSession(sess, async () => {
      await ws.dispatch('rmdir', '/a/d')
    })
    // No session, no hides: the tree must be gone, link included.
    const linkless = await ws.shell('readlink /a/d/lnk')
    expect(linkless.exitCode).not.toBe(0)
    const gone = await ws.shell('test -e /a/d')
    expect(gone.exitCode).toBe(1)
  })

  it('a visible link below keeps the rmdir refusal', async () => {
    // A visible link joins the merged emptiness judgment, so the
    // refusal stands and nothing (backend remnant or node table) is
    // destroyed.
    const parser = await getTestParser()
    const a = new RAMVFS()
    const registry = new OpsRegistry()
    registry.registerVfs(a)
    const ws = new Workspace(
      { '/a': [a, MountMode.WRITE] as const },
      { mode: MountMode.WRITE, ops: registry, shellParser: parser },
    )
    open.push(ws)
    const io = await ws.shell(
      "mkdir -p /a/d/sec && printf 'k\\n' > /a/d/sec/k && ln -s /a/t /a/d/lnk",
    )
    expect(io.exitCode).toBe(0)
    const sess = ws.createSession('rev', {
      profile: parseSessionProfile({ paths: { hide: ['/a/d/sec'] } }),
    })
    await runWithSession(sess, async () => {
      await expect(ws.dispatch('rmdir', '/a/d')).rejects.toMatchObject({
        code: 'ENOTEMPTY',
      })
    })
    const kept = await ws.shell('cat /a/d/sec/k')
    expect(stdoutStr(kept)).toBe('k\n')
    const link = await ws.shell('readlink /a/d/lnk')
    expect(link.exitCode).toBe(0)
  })
})

async function twoMounts(profile: object): Promise<Workspace> {
  const parser = await getTestParser()
  const a = new RAMVFS()
  const b = new RAMVFS()
  const registry = new OpsRegistry()
  registry.registerVfs(a)
  registry.registerVfs(b)
  const ws = new Workspace(
    { '/a': [a, MountMode.WRITE] as const, '/b': [b, MountMode.WRITE] as const },
    { mode: MountMode.WRITE, ops: registry, shellParser: parser },
  )
  open.push(ws)
  const io = await ws.shell(
    'mkdir -p /a/box/sec /a/bag && ' +
      "printf 'v\\n' > /a/box/a.txt && printf 's\\n' > /a/box/sec/k && " +
      "printf 't\\n' > /a/bag/x.tkn && printf 'v\\n' > /a/bag/a.txt",
  )
  expect(io.exitCode).toBe(0)
  ws.createSession('rev', { profile: parseSessionProfile(profile) })
  return ws
}

describe('cross-mount moves against hides', () => {
  it('a cross-mount mv refuses the reveal too', async () => {
    const ws = await twoMounts({ paths: { hide: ['/a/box/sec'] } })
    const refused = await ws.shell('mv /a/box /b/box', { sessionId: 'rev' })
    expect(refused.exitCode).toBe(1)
    expect(stderrStr(refused)).toBe("mv: cannot move '/a/box' to '/b/box': Permission denied\n")
    const intact = await ws.shell('test -e /a/box/sec/k')
    expect(intact.exitCode).toBe(0)
  })

  it('a name-pattern hide moves the visible and drops the remnant', async () => {
    // The filtered walk cannot copy what the session cannot see, and
    // refusing here would make EACCES an existence oracle, so the
    // remove phase takes the remnant with the source: destroy silently,
    // never reveal.
    const ws = await twoMounts({ paths: { hide: ['*.tkn'] } })
    const moved = await ws.shell('mv /a/bag /b/bag', { sessionId: 'rev' })
    expect(moved.exitCode).toBe(0)
    const dest = await ws.shell('find /b/bag')
    expect(stdoutStr(dest)).toBe('/b/bag\n/b/bag/a.txt\n')
    const gone = await ws.shell('test -e /a/bag')
    expect(gone.exitCode).toBe(1)
  })
})
