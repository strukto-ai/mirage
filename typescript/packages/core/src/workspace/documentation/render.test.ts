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
import { SEARCH } from '../../commands/cli/builtin/search/index.ts'
import { CLI, CLIHandler } from '../../commands/cli/types.ts'
import { command } from '../../commands/config.ts'
import { Argument, CommandSpec } from '../../commands/spec/types.ts'
import { IOResult } from '../../io/types.ts'
import { parseSessionProfile } from '../../policy/profile.ts'
import { MountMode, type PathSpec } from '../../types.ts'
import { norm } from '../../utils/path.ts'
import { BaseVFS } from '../../vfs/base.ts'
import { methodName } from '../../vfs/call.ts'
import { DifyVFS } from '../../vfs/dify/dify.ts'
import { GDocsVFS } from '../../vfs/gdocs/gdocs.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { SharePointVFS } from '../../vfs/sharepoint/sharepoint.ts'
import { Workspace } from '../workspace/workspace.ts'
import { CHANGES } from './constants.ts'

const SUPPORTED = '## Supported Unix Commands for VFS'
const LIMITS = '## Limitations of Unix Commands for VFS'

const POST = command({
  name: 'post',
  vfs: 'dify',
  spec: new CommandSpec(),
  fn: () => [null, new IOResult()],
  write: true,
})

class TreeCopyVFS extends RAMVFS {
  override dirCopy(src: PathSpec, dst: PathSpec): Promise<void> {
    const store = this.accessor.store
    const [s, d] = [norm(src.mountPath), norm(dst.mountPath)]
    for (const key of [...store.dirs].filter((k) => k === s || k.startsWith(`${s}/`)))
      store.dirs.add(d + key.slice(s.length))
    for (const [key, data] of [...store.files].filter(([k]) => k.startsWith(`${s}/`)))
      store.files.set(d + key.slice(s.length), data)
    return Promise.resolve()
  }
}

// The text of one path's row in one of VFS.md's tables; an empty section is
// the first table.
function row(markdown: string, section: string, path: string): string {
  const body = section === '' ? markdown : (markdown.split(section)[1] ?? '')
  return (body.split(`| \`${path}\` | `)[1] ?? '').split(' |\n')[0] ?? ''
}

function dify(): DifyVFS {
  return new DifyVFS({ apiKey: 'k', baseUrl: 'https://dify.test', datasetId: 'd' })
}

const ACCOUNT = new CLI({
  spec: new CommandSpec({ name: 'acct', subcommands: [new CommandSpec({ name: 'list' })] }),
  handlers: { list: new CLIHandler({ fn: () => null }) },
  configModel: (input: Record<string, unknown>) => ({ token: String(input.token) }),
})

const TOOL = new CLI({
  spec: new CommandSpec({
    name: 'tool',
    arguments: [new Argument('--token', { required: true })],
    subcommands: [new CommandSpec({ name: 'run' })],
  }),
  handlers: { run: new CLIHandler({ fn: () => null }) },
})

const NOTES = new CLI({
  spec: new CommandSpec({
    name: 'notes',
    subcommands: [new CommandSpec({ name: 'show' }), new CommandSpec({ name: 'add' })],
  }),
  handlers: {
    show: new CLIHandler({ fn: () => null }),
    add: new CLIHandler({ fn: () => null, write: true }),
  },
})

function gdocs(): GDocsVFS {
  return new GDocsVFS({ clientId: 'x', clientSecret: 'y', refreshToken: 'z' })
}

function gws(): CLI {
  const spec = new CommandSpec({
    name: 'gws',
    subcommands: [
      new CommandSpec({
        name: 'drive',
        subcommands: [
          new CommandSpec({ name: 'list', description: 'List files.' }),
          new CommandSpec({ name: 'delete', description: 'Delete one.' }),
        ],
      }),
    ],
  })
  return new CLI({
    spec,
    handlers: {
      'drive list': new CLIHandler({ fn: () => null }),
      'drive delete': new CLIHandler({ fn: () => null }),
    },
  })
}

const SETUP = 'echo hello > /m/f; mkdir /m/d0 /m/d1; echo x > /m/d1/a'
const RUNS: Record<string, string> = {
  '`>`': 'echo hi > /m/n',
  '`>>`': 'echo hi >> /m/f',
  '`tee`': 'echo hi | tee /m/t',
  '`tee -a`': 'echo hi | tee -a /m/f',
  '`touch` of a new file': 'touch /m/new',
  '`cp`': 'cp /m/f /m/c',
  '`cp -r`': 'cp -r /m/d1 /m/d3',
  '`mkdir`': 'mkdir /m/d',
  '`mv`': 'mv /m/f /m/g',
  '`rm`': 'rm /m/f',
  '`unlink`': 'unlink /m/f',
  '`rm -r`': 'rm -r /m/d1',
  '`rmdir`': 'rmdir /m/d0',
  '`truncate`': 'truncate -s 0 /m/f',
  '`sed -i`': 'sed -i s/h/j/ /m/f',
}

async function seeded(
  ops: readonly string[],
  vfs: RAMVFS = new RAMVFS(),
  profile: Record<string, unknown> | null = null,
): Promise<Workspace> {
  const seed = new Workspace({ '/m': [vfs, MountMode.WRITE] })
  expect((await seed.shell(SETUP)).exitCode).toBe(0)
  const base = BaseVFS.prototype as unknown as Record<string, unknown>
  for (const op of ops)
    (vfs as unknown as Record<string, unknown>)[methodName(op)] = base[methodName(op)]
  return new Workspace(
    { '/m': [vfs, MountMode.WRITE] },
    {
      mode: MountMode.WRITE,
      profiles: profile === null ? {} : { default: parseSessionProfile(profile) },
    },
  )
}

describe('vfsMd', () => {
  it('opens with its frontmatter', async () => {
    const ws = new Workspace({ '/': [new RAMVFS(), MountMode.WRITE] }, { mode: MountMode.WRITE })
    expect(await ws.vfsMd()).toMatch(
      /^---\nname: workspace-filesystem\ndescription: The virtual filesystem layout of this workspace\.\n---\n\n# Virtual Filesystem\n/,
    )
  })

  it('states each mount mode', async () => {
    const ws = new Workspace(
      {
        '/': [new RAMVFS(), MountMode.EXEC],
        '/data': [new RAMVFS(), MountMode.READ],
        '/scratch': [new RAMVFS(), MountMode.WRITE],
      },
      { mode: MountMode.WRITE },
    )
    expect(await ws.vfsMd()).toContain(
      '| Path | Description |\n| --- | --- |\n' +
        '| `/` | `ram`, exec |\n' +
        '| `/data` | `ram`, read |\n' +
        '| `/scratch` | `ram`, write |\n',
    )
  })

  it('shows a layout only where the VFS has one', async () => {
    const ws = new Workspace(
      { '/': [new RAMVFS(), MountMode.WRITE], '/docs': [gdocs(), MountMode.READ] },
      { mode: MountMode.WRITE },
    )
    const markdown = await ws.vfsMd()
    expect(markdown).toContain('## `/docs` layout\n\n```text\n/docs\n  owned/')
    expect(markdown).not.toContain('## `/` layout')
  })

  it('keeps literal braces', async () => {
    const ws = new Workspace(
      { '/sp': [new SharePointVFS({ accessToken: 'tok' }), MountMode.READ] },
      { mode: MountMode.READ },
    )
    expect(await ws.vfsMd()).toContain('/{site_name}/{library_name}/{path_to_file}')
    expect(await ws.vfsMd()).not.toContain('{prefix}')
  })

  it('says what each path supports', async () => {
    const ws = new Workspace(
      {
        '/': [new RAMVFS(), MountMode.WRITE],
        '/data': [new RAMVFS(), MountMode.READ],
        '/docs': [gdocs(), MountMode.WRITE],
      },
      { mode: MountMode.WRITE },
    )
    const markdown = await ws.vfsMd()
    expect(row(markdown, SUPPORTED, '/')).toBe('Almost all Unix commands.')
    expect(row(markdown, SUPPORTED, '/docs')).toBe(
      'Commands that read files (`ls`, `cat`, `grep`, `find`, `jq` and the rest), and `mv`, `rm` and `unlink`. ' +
        '`grep -r` and `rg` with `-w` ask `gdocs` which files may match.',
    )
    expect(row(markdown, LIMITS, '/data')).toMatch(/^Read only: no command changes files\./)
    expect(row(markdown, LIMITS, '/docs')).toMatch(
      /^Not supported: `>`, `>>`, `tee`, `tee -a`, `touch` of a new file, `cp`, `cp -r`, `mkdir`, `rm -r`, `rmdir`, `truncate`, `sed -i`\. Without `-w`, `grep -r` and `rg` read every file\./,
    )
    expect(row(markdown, LIMITS, '/')).toMatch(
      /`grep -r`, `find` and `du` stop after 10000 files; a glob matching more, `tar -c`, `cp -r` and `rm -r` are refused\.$/,
    )
  })

  // Twin of test_vfs_md_leaves_out_a_cli_over_the_mount.
  it('leaves out a CLI over the mount', async () => {
    const ws = new Workspace({ '/kb': [dify(), MountMode.READ] })
    ws.registerCli('search', SEARCH)
    expect(await ws.vfsMd()).not.toContain('search')
  })

  it('names no command the profile denies', async () => {
    const ws = new Workspace(
      { '/': [new RAMVFS(), MountMode.WRITE] },
      {
        mode: MountMode.WRITE,
        profiles: { default: parseSessionProfile({ commands: { deny: ['rm', 'grep', 'tree'] } }) },
      },
    )
    const markdown = await ws.vfsMd()
    expect(markdown).not.toContain('`rm`')
    expect(markdown).not.toContain('`rm -r`')
    expect(markdown).toContain('`rmdir`')
    expect(markdown).not.toContain('`grep')
    expect(markdown).not.toContain('tree')
    expect(markdown).toContain('`find` and `du` stop after')
  })

  it('reads read where no command changes files', async () => {
    const ws = new Workspace({ '/kb': [dify(), MountMode.WRITE] }, { mode: MountMode.WRITE })
    const markdown = await ws.vfsMd()
    expect(markdown).toContain('| `/kb` | `dify`, read |')
    expect(row(markdown, LIMITS, '/kb')).toMatch(/^Read only: no command changes files\./)
  })

  it("shows the user's own text", async () => {
    const docs = gdocs()
    docs.vfsMd = '{prefix}/owned holds our team docs.'
    const ws = new Workspace({ '/docs': [docs, MountMode.READ] })
    const markdown = await ws.vfsMd()
    expect(markdown).toContain('/docs/owned holds our team docs.')
    expect(markdown).not.toContain('<date>_<title>')
  })

  it('fences a layout past a spaced fence inside it', async () => {
    const docs = gdocs()
    docs.vfsMd = 'Run:\n  ```sh\n  ls {prefix}\n  ```  \nDone.'
    const ws = new Workspace({ '/docs': [docs, MountMode.READ] })
    const markdown = await ws.vfsMd()
    expect(markdown).toContain('````text\nRun:\n  ```sh\n  ls /docs\n  ```  \nDone.\n````')
  })

  it('names each search command the profile allows', async () => {
    const ws = new Workspace(
      { '/docs': [gdocs(), MountMode.WRITE] },
      {
        mode: MountMode.WRITE,
        profiles: { default: parseSessionProfile({ commands: { deny: ['rg'] } }) },
      },
    )
    const markdown = await ws.vfsMd()
    expect(markdown).not.toContain('`rg`')
    expect(markdown).toContain('`grep -r` with `-w` asks `gdocs` which files may match.')
    expect(markdown).toContain('Without `-w`, `grep -r` reads every file.')
  })

  it('follows a rule written for paths', async () => {
    const ws = new Workspace(
      { '/': [new RAMVFS(), MountMode.WRITE], '/data': [new RAMVFS(), MountMode.WRITE] },
      {
        mode: MountMode.WRITE,
        profiles: {
          default: parseSessionProfile({ commands: { deny: [{ commands: { rm: ['/data/*'] } }] } }),
        },
      },
    )
    const markdown = await ws.vfsMd()
    expect(row(markdown, SUPPORTED, '/')).toBe('Almost all Unix commands.')
    expect(row(markdown, SUPPORTED, '/data')).not.toContain('`rm`')
    expect(row(markdown, SUPPORTED, '/data')).toContain('`mv`')
  })

  it('summarizes nothing for an allow list', async () => {
    const ws = new Workspace(
      { '/': [new RAMVFS(), MountMode.WRITE] },
      {
        mode: MountMode.WRITE,
        profiles: { default: parseSessionProfile({ commands: { allow: ['cat'] } }) },
      },
    )
    expect(row(await ws.vfsMd(), SUPPORTED, '/')).toBe(
      'Commands that read files (`cat` and the rest), and `>` and `>>`.',
    )
  })

  it('counts a longer form the allow list names', async () => {
    const ws = new Workspace(
      { '/docs': [gdocs(), MountMode.WRITE] },
      {
        mode: MountMode.WRITE,
        profiles: { default: parseSessionProfile({ commands: { allow: ['cat', 'rm -f'] } }) },
      },
    )
    const markdown = await ws.vfsMd()
    expect(markdown).toContain('| `/docs` | `gdocs`, write |')
    expect(row(markdown, SUPPORTED, '/docs')).toBe(
      'Commands that read files (`cat` and the rest), and `rm`.',
    )
  })

  it('keeps the denied words inside a longer form', async () => {
    const ws = new Workspace(
      { '/docs': [gdocs(), MountMode.WRITE] },
      {
        mode: MountMode.WRITE,
        profiles: {
          default: parseSessionProfile({
            commands: { allow: ['cat', 'grep * needle'], deny: ['grep -r'] },
          }),
        },
      },
    )
    expect(await ws.vfsMd()).not.toContain('`grep -r`')
  })

  it('counts no help request as a write', async () => {
    const ws = new Workspace(
      { '/docs': [gdocs(), MountMode.WRITE] },
      {
        mode: MountMode.WRITE,
        profiles: { default: parseSessionProfile({ commands: { allow: ['cat', 'rm --help'] } }) },
      },
    )
    const markdown = await ws.vfsMd()
    expect(markdown).toContain('| `/docs` | `gdocs`, read |')
    expect(row(markdown, SUPPORTED, '/docs')).not.toContain('`rm`')
  })

  it('names no search whose whole-word form is denied', async () => {
    const ws = new Workspace(
      { '/docs': [gdocs(), MountMode.WRITE] },
      {
        mode: MountMode.WRITE,
        profiles: {
          default: parseSessionProfile({ commands: { deny: ['grep -r -w', 'rg -w'] } }),
        },
      },
    )
    const markdown = await ws.vfsMd()
    expect(markdown).not.toContain('`gdocs` search')
    expect(markdown).not.toContain('Without `-w`')
  })

  it("counts a writer of the mount's own", async () => {
    const ws = new Workspace({ '/kb': [dify(), MountMode.WRITE] }, { mode: MountMode.WRITE })
    ws.mount('/kb').registerCommands(POST)
    const markdown = await ws.vfsMd()
    expect(markdown).toContain('| `/kb` | `dify`, write |')
    expect(row(markdown, SUPPORTED, '/kb')).toContain('`post`')
    expect(row(markdown, LIMITS, '/kb')).toMatch(/^No Unix command changes files\./)
  })

  it('names no writer of a read-only mount', async () => {
    const ws = new Workspace({ '/kb': [dify(), MountMode.READ] })
    ws.mount('/kb').registerCommands(POST)
    expect(row(await ws.vfsMd(), SUPPORTED, '/kb')).not.toContain('`post`')
  })

  it('reads a tree leaf by leaf', async () => {
    const ws = new Workspace(
      { '/kb': [dify(), MountMode.WRITE] },
      {
        mode: MountMode.WRITE,
        profiles: {
          default: parseSessionProfile({ commands: { allow: ['cat', 'notes show'] } }),
        },
      },
    )
    ws.mount('/kb').registerCommands([NOTES])
    const markdown = await ws.vfsMd()
    expect(markdown).toContain('| `/kb` | `dify`, read |')
    expect(row(markdown, SUPPORTED, '/kb')).toContain('`notes`')
  })

  it('counts unlink as a change', async () => {
    const ws = new Workspace(
      { '/docs': [gdocs(), MountMode.WRITE] },
      {
        mode: MountMode.WRITE,
        profiles: { default: parseSessionProfile({ commands: { allow: ['cat', 'unlink'] } }) },
      },
    )
    const markdown = await ws.vfsMd()
    expect(markdown).toContain('| `/docs` | `gdocs`, write |')
    expect(row(markdown, SUPPORTED, '/docs')).toBe(
      'Commands that read files (`cat` and the rest), and `unlink`.',
    )
  })

  it('describes each path shown with its own mode', async () => {
    const ws = new Workspace(
      { '/': [new RAMVFS(), MountMode.WRITE], '/data': [new RAMVFS(), MountMode.WRITE] },
      { mode: MountMode.WRITE },
    )
    await ws.setSessionProfile(
      ws.defaultSessionId,
      parseSessionProfile({ paths: { show: { '/data/public': 'r' } } }),
    )
    const markdown = await ws.vfsMd()
    expect(row(markdown, LIMITS, '/data/public')).toMatch(/^Read only: no command changes files\./)
    expect(row(markdown, SUPPORTED, '/data/public')).toMatch(/^Commands that read files/)
    await ws.close()
  })

  it('names no search a mount turned off', async () => {
    const docs = new GDocsVFS({
      clientId: 'x',
      clientSecret: 'y',
      refreshToken: 'z',
      walkLimit: -1,
    })
    const ws = new Workspace({ '/docs': [docs, MountMode.READ] }, { mode: MountMode.READ })
    expect(await ws.vfsMd()).not.toContain('search')
  })

  it.each([
    [[]],
    [['write']],
    [['write', 'append', 'pwrite', 'truncate']],
    [['mkdir']],
    [['unlink']],
    [['rmdir']],
    [['rm_r']],
    [['rmdir', 'rm_r']],
    [['rename']],
  ])('VFS.md says what each command runs on without %j', async (ops: string[]) => {
    expect(CHANGES.map((c) => c.label)).toEqual(Object.keys(RUNS))
    const limits = row(await (await seeded(ops)).vfsMd(), LIMITS, '/m')
    const missing = limits.includes('Not supported: ')
      ? ((limits.split('Not supported: ')[1] ?? '').split('.')[0]?.split(', ') ?? [])
      : []
    for (const [label, line] of Object.entries(RUNS)) {
      const result = await (await seeded(ops)).shell(line)
      expect([label, result.exitCode === 0]).toEqual([label, !missing.includes(label)])
    }
  })

  it('says cp -r copies a whole tree in one call', async () => {
    const ws = await seeded(['mkdir'], new TreeCopyVFS())
    expect(row(await ws.vfsMd(), LIMITS, '/m')).toMatch(/^Not supported: `mkdir`\. /)
    expect((await ws.shell('cp -r /m/d1 /m/d3')).exitCode).toBe(0)
    expect((await ws.shell('cat /m/d3/a')).stdoutText).toBe('x\n')
  })

  it('judges tee -a by its own ops', async () => {
    const ws = await seeded(['write'], new RAMVFS(), { commands: { allow: ['cat', 'tee -a'] } })
    const markdown = await ws.vfsMd()
    expect(row(markdown, SUPPORTED, '/m')).toContain('`tee -a`')
    expect(row(markdown, LIMITS, '/m')).toMatch(/^Not supported: `>`\. /)
  })

  it('counts rm -r on a file where only unlink works', async () => {
    const ws = await seeded(['write', 'append', 'rmdir', 'rm_r'], new RAMVFS(), {
      commands: { allow: ['cat', 'rm -r'] },
    })
    expect(row(await ws.vfsMd(), '', '/m')).toMatch(/, write$/)
    expect((await ws.shell('rm -r /m/f')).exitCode).toBe(0)
  })
})

describe('skillMd', () => {
  it('lists the CLIs the profile allows', async () => {
    const ws = new Workspace(
      { '/': [new RAMVFS(), MountMode.WRITE] },
      { profiles: { default: parseSessionProfile({ commands: { deny: ['hidden'] } }) } },
    )
    for (const name of ['shown', 'hidden'])
      ws.registerCli(
        name,
        new CLI({
          spec: new CommandSpec({ name }),
          handlers: { '': new CLIHandler({ fn: () => null }) },
        }),
      )
    const skill = await ws.skillMd()
    expect(skill).toMatch(
      /^---\nname: workspace-commands\ndescription: The CLIs registered in this workspace and how to call them\.\n---\n\n# Available commands\n/,
    )
    expect(skill).toContain('## `shown`')
    expect(skill).not.toContain('hidden')
  })

  it('keeps the path to an allowed leaf', async () => {
    const ws = new Workspace(
      { '/': [new RAMVFS(), MountMode.WRITE] },
      { profiles: { default: parseSessionProfile({ commands: { allow: ['gws drive list'] } }) } },
    )
    ws.registerCli('gws', gws())
    const skill = await ws.skillMd()
    expect(skill).toContain('## `gws`\n')
    expect(skill).toContain('## `gws drive`\n')
    expect(skill).toContain('## `gws drive list`')
    expect(skill).not.toContain('delete')
  })

  it('keeps the options of a group above an allowed leaf', async () => {
    const ws = new Workspace(
      { '/': [new RAMVFS(), MountMode.WRITE] },
      { profiles: { default: parseSessionProfile({ commands: { allow: ['tool run'] } }) } },
    )
    ws.registerCli('tool', TOOL)
    const skill = await ws.skillMd()
    expect(skill).toContain('## `tool`\n')
    expect(skill).toContain('--token')
    expect(skill).toContain('## `tool run`')
  })

  it('names no service CLI a path-hiding profile leaves out', async () => {
    const ws = new Workspace(
      { '/': [new RAMVFS(), MountMode.WRITE] },
      {
        profiles: {
          default: parseSessionProfile({ paths: { hide: ['/vault'] }, commands: { allow: ['*'] } }),
        },
      },
    )
    ws.registerCli('acct', ACCOUNT, { token: 't' })
    expect(await ws.skillMd()).toMatch(/No CLIs are registered\.\n$/)
  })

  it('keeps a leaf its allow list names with arguments', async () => {
    const ws = new Workspace(
      { '/': [new RAMVFS(), MountMode.WRITE] },
      {
        profiles: {
          default: parseSessionProfile({ commands: { allow: ['gws drive list --id'] } }),
        },
      },
    )
    ws.registerCli('gws', gws())
    const skill = await ws.skillMd()
    expect(skill).toContain('## `gws drive list`')
    expect(skill).not.toContain('delete')
  })

  it('lists no denied subcommand', async () => {
    const ws = new Workspace(
      { '/': [new RAMVFS(), MountMode.WRITE] },
      { profiles: { default: parseSessionProfile({ commands: { deny: ['gws drive delete'] } }) } },
    )
    ws.registerCli('gws', gws())
    const skill = await ws.skillMd()
    expect(skill).toContain('## `gws drive`')
    expect(skill.toLowerCase()).not.toContain('delete')
  })

  it('says when no CLI is registered', async () => {
    const ws = new Workspace({ '/': [new RAMVFS(), MountMode.WRITE] })
    expect(await ws.skillMd()).toMatch(/No CLIs are registered\.\n$/)
  })
})
