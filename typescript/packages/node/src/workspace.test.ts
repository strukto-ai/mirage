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

import { chmodSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AIRTABLE } from '@struktoai/mirage-core/commands/cli/builtin/airtable/index'
import { DISCORD } from '@struktoai/mirage-core/commands/cli/builtin/discord/index'
import { GWS } from '@struktoai/mirage-core/commands/cli/builtin/gws/index'
import { LINEAR } from '@struktoai/mirage-core/commands/cli/builtin/linear/index'
import { NTN } from '@struktoai/mirage-core/commands/cli/builtin/ntn/index'
import { SLACK } from '@struktoai/mirage-core/commands/cli/builtin/slack/index'
import { TRELLO } from '@struktoai/mirage-core/commands/cli/builtin/trello/index'
import { CLIRegistry } from '@struktoai/mirage-core/workspace/cli/registry'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { MountMode, PathSpec, ReadPolicy, WritePolicy } from '@struktoai/mirage-core/types'
import { Mount } from '@struktoai/mirage-core/workspace/mount/spec'
import { DiskAccessor } from './accessor/disk.ts'
import { HIMALAYA } from './commands/cli/builtin/himalaya/index.ts'
import { HF } from './commands/cli/builtin/hf/index.ts'
import { DiskEventHook } from './core/disk/events/hook.ts'
import { DiskVFS } from './vfs/disk/disk.ts'
import { InlineGitHub } from '../tests/vfs/fixtures/github.ts'
import { buildVfs } from './vfs/registry.ts'
import { conditionalS3, s3Vfs, tmpRoot } from '../tests/test-utils.ts'
import { Workspace } from './workspace.ts'

describe('@struktoai/mirage-node Workspace', () => {
  it('runs `echo hi` end-to-end', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    const res = await ws.shell('echo hi')
    expect(res.exitCode).toBe(0)
    expect(new TextDecoder().decode(res.stdout)).toBe('hi\n')
    await ws.close()
  })

  it.each([
    ['-maxdepth abc', "find: invalid argument 'abc' to '-maxdepth'"],
    ['-mindepth xx', "find: invalid argument 'xx' to '-mindepth'"],
    ["-size ''", 'find: invalid null argument to -size'],
    ['-size abc', "find: Invalid argument `abc' to -size"],
    ['-mtime abc', "find: invalid argument 'abc' to '-mtime'"],
  ])('find %s exits 1 with a clean stderr instead of crashing', async (expr, message) => {
    const ws = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE })
    const res = await ws.shell(`find / ${expr}`)
    expect(res.exitCode).toBe(1)
    expect(new TextDecoder().decode(res.stderr)).toBe(`${message}\n`)
    await ws.close()
  })

  it.each([
    ["echo a '' b", 'a  b\n'],
    ['echo a "" b', 'a  b\n'],
  ])('keeps a quoted empty string as a real argument: %s', async (cmd, expected) => {
    const ws = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE })
    const res = await ws.shell(cmd)
    expect(res.exitCode).toBe(0)
    expect(new TextDecoder().decode(res.stdout)).toBe(expected)
    await ws.close()
  })
})

describe('@struktoai/mirage-node Workspace disk metadata', () => {
  function makeDiskWs(): { ws: Workspace; root: string; cleanup: () => void } {
    const { root, cleanup } = tmpRoot('mirage-node-meta-')
    writeFileSync(join(root, 'f.txt'), 'hello')
    const ws = new Workspace(
      { '/data': [new DiskVFS({ root }), MountMode.WRITE] },
      { mode: MountMode.WRITE },
    )
    return { ws, root, cleanup }
  }

  it('chmod 000 shows zero in ls -l but keeps owner access', async () => {
    const { ws, root, cleanup } = makeDiskWs()
    const c = await ws.shell('chmod 000 /data/f.txt')
    expect(c.exitCode).toBe(0)
    const ls = await ws.shell('ls -l /data')
    expect(ls.stdoutText).toContain('----------')
    expect(statSync(join(root, 'f.txt')).mode & 0o777).toBe(0o600)
    const cat = await ws.shell('cat /data/f.txt')
    expect(cat.exitCode).toBe(0)
    expect(cat.stdoutText).toBe('hello')
    await ws.close()
    cleanup()
  })

  // The link's name is on the mount the copy runs on, so the mount's own copy
  // writes it and keeps the mode GNU gives a new file.
  it('cp -b onto a link keeps the source mode', async () => {
    const { ws, root, cleanup } = makeDiskWs()
    await ws.shell('printf x > /data/src && chmod 755 /data/src && ln -s f.txt /data/link')
    const r = await ws.shell('cp -b /data/src /data/link && readlink /data/link~')
    expect([r.exitCode, r.stdoutText]).toEqual([0, 'f.txt\n'])
    expect(statSync(join(root, 'link')).mode & 0o777).toBe(0o755)
    await ws.close()
    cleanup()
  })

  it('relaxing chmod drops the stale residual overlay', async () => {
    const { ws, cleanup } = makeDiskWs()
    await ws.shell('chmod 000 /data/f.txt')
    await ws.shell('chmod 644 /data/f.txt')
    const st = (await ws.dispatch('stat', '/data/f.txt')) as { mode: number }
    expect(st.mode).toBe(0o644)
    expect(ws.namespace.metaFor('/data/f.txt')).toBeNull()
    await ws.close()
    cleanup()
  })

  it('shows an external chmod in ls -l', async () => {
    const { ws, root, cleanup } = makeDiskWs()
    chmodSync(join(root, 'f.txt'), 0o640)
    const ls = await ws.shell('ls -l /data')
    expect(ls.stdoutText).toContain('-rw-r-----')
    await ws.close()
    cleanup()
  })

  it('overlays chown and renders owner/group in ls -l', async () => {
    const { ws, cleanup } = makeDiskWs()
    const c = await ws.shell('chown 500:dev /data/f.txt')
    expect(c.exitCode).toBe(0)
    const ls = await ws.shell('ls -l /data')
    expect(ls.stdoutText).toContain(' 500 dev ')
    await ws.close()
    cleanup()
  })
})

// A fresh github mount lists the tree once, then pays one check of the head
// per command while nothing changes, and one check plus one walk after a
// change outside mirage.
it('checks a fresh github mount by its head once per command', async () => {
  const gh = new InlineGitHub({ 'docs/a.txt': 'a\n', 'docs/b.txt': 'b\n' })
  vi.stubGlobal('fetch', gh.fetch)
  const vfs = await buildVfs('github', {
    token: 't',
    owner: 'o',
    repo: 'r',
    ref: 'main',
    base_url: gh.url,
  })
  const ws = new Workspace({
    '/gh': new Mount(vfs, { mode: MountMode.READ, read: { policy: ReadPolicy.FRESH, ttl: 600 } }),
  })
  const ls = async (): Promise<[string, number[]]> => {
    gh.log.length = 0
    const result = await ws.shell('ls /gh/docs')
    expect([result.exitCode, new TextDecoder().decode(result.stderr)]).toEqual([0, ''])
    return [
      new TextDecoder().decode(result.stdout),
      [gh.count('dir'), gh.count('recursive'), gh.count('blob')],
    ]
  }
  try {
    gh.log.length = 0
    expect(await ls()).toEqual(['a.txt\nb.txt\n', [0, 1, 0]])
    expect(await ls()).toEqual(['a.txt\nb.txt\n', [1, 0, 0]])
    gh.set('docs/c.txt', 'c\n')
    expect(await ls()).toEqual(['a.txt\nb.txt\nc.txt\n', [1, 1, 0]])
  } finally {
    vi.unstubAllGlobals()
    await ws.close()
  }
})

describe('a host folder removal reported by the disk watcher', () => {
  const decoder = new TextDecoder()
  let root: string
  let ws: Workspace

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mirage-events-push-'))
    ws = new Workspace({ '/d': new DiskVFS({ root }) }, { mode: MountMode.READ })
  })

  afterEach(async () => {
    await ws.close()
    await rm(root, { recursive: true, force: true })
  })

  it('leaves nothing listed after a host rm -r reported children first', async () => {
    // A host `rm -r` arrives as one `deleted` per path, children first; each
    // level's listing is gone by the time its own event arrives, except an
    // empty folder's, which only its own event clears.
    await mkdir(join(root, 'day', 'sub'), { recursive: true })
    await mkdir(join(root, 'day', 'empty'))
    await writeFile(join(root, 'day', 'sub', 'a.txt'), 'a')
    await writeFile(join(root, 'day', 'b.txt'), 'b')
    expect(decoder.decode((await ws.shell('ls /d/day/sub')).stdout)).toContain('a.txt')
    expect((await ws.shell('ls /d/day/empty')).exitCode).toBe(0)
    expect(decoder.decode((await ws.shell('ls /d/day')).stdout)).toContain('b.txt')

    const removed = [
      join(root, 'day', 'sub', 'a.txt'),
      join(root, 'day', 'sub'),
      join(root, 'day', 'empty'),
      join(root, 'day', 'b.txt'),
      join(root, 'day'),
    ]
    await rm(join(root, 'day'), { recursive: true, force: true })
    const hook = new DiskEventHook(new DiskAccessor(root))
    const mountRoot = new PathSpec({ virtual: '/d', directory: '/d', vfsPath: '' })
    for (const removedPath of removed) {
      for (const change of await hook.toEvents(mountRoot, 'deleted', { src_path: removedPath })) {
        await ws.notify(change)
      }
    }

    expect((await ws.shell('ls /d/day/sub')).exitCode).not.toBe(0)
    expect((await ws.shell('ls /d/day/empty')).exitCode).not.toBe(0)
    expect((await ws.shell('ls /d/day')).exitCode).not.toBe(0)
  })
})

describe('the write policy at the workspace entry points', () => {
  const built: Workspace[] = []
  function track(ws: Workspace): Workspace {
    built.push(ws)
    return ws
  }
  afterEach(async () => {
    for (const ws of built.splice(0).reverse()) await ws.close()
  })

  it.each([
    ['names', {}, s3Vfs, 'conditional', WritePolicy.CONDITIONAL],
    ['cannot honour', {}, () => new RAMVFS(), 'conditional', 'ram does not'],
    ['inherits', { write: WritePolicy.CONDITIONAL }, s3Vfs, undefined, WritePolicy.CONDITIONAL],
    ['inherits on null', { write: WritePolicy.CONDITIONAL }, s3Vfs, null, WritePolicy.CONDITIONAL],
    ['keeps nothing', { cacheLimit: 0 }, s3Vfs, 'conditional', 'caches reads'],
  ] as const)(
    'judges an added mount on its write policy: %s',
    (_name, options, vfs, write, expected) => {
      // The wire string, not the enum: the programmatic entry point coerces first.
      const ws = track(new Workspace({}, { mode: MountMode.WRITE, ...options }))
      const add = () => ws.addMount('/m', vfs(), MountMode.WRITE, undefined, null, undefined, write)
      if (expected === WritePolicy.CONDITIONAL) expect(add().write).toBe(expected)
      else expect(add).toThrow(expected)
    },
  )

  it('keeps the host-built mounts unconditional under a conditional default', async () => {
    const ws = track(
      new Workspace({ '/s3': s3Vfs() }, { mode: MountMode.WRITE, write: WritePolicy.CONDITIONAL }),
    )
    expect(ws.mount('/s3/').write).toBe(WritePolicy.CONDITIONAL)
    for (const prefix of ['/dev/', '/', '/.bash_history/', '/usr/bin/']) {
      expect(ws.mount(prefix).write, prefix).toBe(WritePolicy.UNCONDITIONAL)
    }
    expect((await ws.shell('echo x > /dev/null')).exitCode).toBe(0)
  })

  it('refuses a conditional mount when the cache keeps nothing', () => {
    // A zero cache limit keeps nothing, so no write would have a version.
    expect(() => new Workspace({ '/s3': conditionalS3() }, { cacheLimit: 0 })).toThrow(
      'caches reads',
    )
  })
})

describe('an account CLI write drops only the mounts it reaches', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const MAIL = { imap_host: 'imap.a', smtp_host: 'smtp.a', username: 'u', password: 'p' }
  const MAIL_MOUNTS = ['mail', 'mail_elsewhere', 'gmail']
  const GOOGLE = { access_token: 't' }
  const GOOGLE_MOUNTS = ['gdrive', 'gdocs', 'gsheets', 'gslides', 'gmail', 'gcal']
  const PROXY = 'https://proxy.test'
  const REPO = { repo_id: 'o/r' }
  // A github mount asks for its repository when built, so it is built on the fake.
  const GITHUB = new InlineGitHub()
  const MOUNTS: Record<string, [string, Record<string, unknown>]> = {
    mail: ['email', MAIL],
    mail_elsewhere: ['email', { ...MAIL, imap_host: 'imap.b', imap_port: 143, username: 'v' }],
    slack: ['slack', { token: 'u', base_url: PROXY }],
    discord: ['discord', { token: 'u', base_url: PROXY }],
    notion: ['notion', { api_key: 'u', base_url: PROXY }],
    linear: ['linear', { api_key: 'u', base_url: PROXY }],
    airtable: ['airtable', { token: 'u', base_url: PROXY }],
    trello: ['trello', { api_key: 'k', api_token: 'u', base_url: PROXY }],
    ...Object.fromEntries(
      GOOGLE_MOUNTS.map((name) => [name, [name, { ...GOOGLE, api_base: PROXY }]]),
    ),
    box: ['box', { access_token: 't' }],
    dropbox: ['dropbox', { client_id: 'c', client_secret: 's', refresh_token: 'r' }],
    hf_models: ['hf_models', REPO],
    hf_datasets: ['hf_datasets', REPO],
    hf_spaces: ['hf_spaces', REPO],
    hf_elsewhere: ['hf_models', { ...REPO, endpoint: 'https://hub.test' }],
    hf_buckets: ['hf_buckets', { bucket: 'o/b' }],
    github: ['github', { token: 't', owner: 'o', repo: 'r', base_url: GITHUB.url }],
    ram: ['ram', {}],
  }

  it.each([
    ['himalaya', HIMALAYA, MAIL, MAIL_MOUNTS],
    ['slack', SLACK, { token: 't' }, ['slack']],
    ['discord', DISCORD, { token: 't' }, ['discord']],
    ['ntn', NTN, { api_key: 't' }, ['notion']],
    ['linear', LINEAR, { api_key: 't' }, ['linear']],
    ['airtable', AIRTABLE, { token: 't' }, ['airtable']],
    ['trello', TRELLO, { api_key: 'k', api_token: 't' }, ['trello']],
    ['gws', GWS, GOOGLE, [...new Set([...GOOGLE_MOUNTS, ...MAIL_MOUNTS])]],
    ['hf', HF, { endpoint: 'https://huggingface.co/' }, ['hf_models', 'hf_datasets', 'hf_spaces']],
  ] as const)('a %s write reaches its own service alone', async (_name, cli, config, reached) => {
    // A proxy in front of an API root reaches the same data, so only a Hub
    // endpoint narrows; mail reaches every mailbox, whichever server or API
    // reads it, since a send can land in any of them. Mirrors Python's
    // registry test.
    vi.stubGlobal('fetch', GITHUB.fetch)
    const accessor = new CLIRegistry().install('acct', cli, config).accessor
    const got: string[] = []
    for (const [name, [kind, mountConfig]] of Object.entries(MOUNTS)) {
      const vfs = await buildVfs(kind, mountConfig)
      if (accessor.reaches?.(vfs.accessor) ?? true) got.push(name)
    }
    expect(got.sort()).toEqual([...reached].sort())
  })
})
