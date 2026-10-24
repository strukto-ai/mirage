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
import { CLI, CLIHandler } from '../../commands/cli/types.ts'
import { CommandSpec } from '../../commands/spec/types.ts'
import { parseSessionProfile } from '../../policy/profile.ts'
import { MountMode } from '../../types.ts'
import { BaseVFS } from '../../vfs/base.ts'
import { methodName } from '../../vfs/call.ts'
import { DifyVFS } from '../../vfs/dify/dify.ts'
import { GDocsVFS } from '../../vfs/gdocs/gdocs.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { SharePointVFS } from '../../vfs/sharepoint/sharepoint.ts'
import { Workspace } from '../workspace/workspace.ts'
import { getTestParser } from '../../../tests/workspace/fixtures/workspace_fixture.ts'
import { CHANGES } from './constants.ts'

const SUPPORTED = '## Supported Unix Commands for VFS'
const LIMITS = '## Limitations of Unix Commands for VFS'

// The text of one path's row in one of VFS.md's tables; an empty section is
// the first table.
function row(markdown: string, section: string, path: string): string {
  const body = section === '' ? markdown : (markdown.split(section)[1] ?? '')
  return (body.split(`| \`${path}\` | `)[1] ?? '').split(' |\n')[0] ?? ''
}

function gdocs(): GDocsVFS {
  return new GDocsVFS({ clientId: 'x', clientSecret: 'y', refreshToken: 'z' })
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
      'Commands that read files (`ls`, `cat`, `grep`, `find`, `jq` and the rest), and `mv` and `rm`. ' +
        '`grep -r` and `rg` with `-w` use `gdocs` search.',
    )
    expect(row(markdown, LIMITS, '/data')).toMatch(/^Read only: no command changes files\./)
    expect(row(markdown, LIMITS, '/docs')).toMatch(
      /^Not supported: `>`, `>>`, `tee`, `touch` of a new file, `cp`, `cp -r`, `mkdir`, `rm -r`, `rmdir`, `truncate`, `sed -i`\. Without `-w`, `grep -r` and `rg` read every file\./,
    )
    expect(row(markdown, LIMITS, '/')).toMatch(
      /`grep -r`, `find` and `du` stop after 10000 files; a glob matching more, `tar -c`, `cp -r` and `rm -r` are refused\.$/,
    )
  })

  it("names a mount's own commands", async () => {
    const dify = new DifyVFS({ apiKey: 'k', baseUrl: 'https://dify.test', datasetId: 'd' })
    const ws = new Workspace({ '/kb': [dify, MountMode.READ] })
    expect(row(await ws.vfsMd(), SUPPORTED, '/kb')).toMatch(/Also `search`\.$/)
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
    const dify = new DifyVFS({ apiKey: 'k', baseUrl: 'https://dify.test', datasetId: 'd' })
    const ws = new Workspace({ '/kb': [dify, MountMode.WRITE] }, { mode: MountMode.WRITE })
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
    expect(markdown).toContain('`grep -r` with `-w` uses `gdocs` search.')
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
      fullScanLimit: -1,
    })
    const ws = new Workspace({ '/docs': [docs, MountMode.READ] }, { mode: MountMode.READ })
    expect(await ws.vfsMd()).not.toContain('search')
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

  it('keeps an allowed leaf under a denied parent', async () => {
    const ws = new Workspace(
      { '/': [new RAMVFS(), MountMode.WRITE] },
      { profiles: { default: parseSessionProfile({ commands: { allow: ['gws drive list'] } }) } },
    )
    ws.registerCli('gws', gws())
    const skill = await ws.skillMd()
    expect(skill).toContain('## `gws drive list`')
    expect(skill).not.toContain('## `gws`\n')
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

  const SETUP = 'echo hello > /m/f; mkdir /m/d0 /m/d1; echo x > /m/d1/a'
  const RUNS: Record<string, string> = {
    '`>`': 'echo hi > /m/n',
    '`>>`': 'echo hi >> /m/f',
    '`tee`': 'echo hi | tee /m/t',
    '`touch` of a new file': 'touch /m/new',
    '`cp`': 'cp /m/f /m/c',
    '`cp -r`': 'cp -r /m/d1 /m/d3',
    '`mkdir`': 'mkdir /m/d',
    '`mv`': 'mv /m/f /m/g',
    '`rm`': 'rm /m/f',
    '`rm -r`': 'rm -r /m/d1',
    '`rmdir`': 'rmdir /m/d0',
    '`truncate`': 'truncate -s 0 /m/f',
    '`sed -i`': 'sed -i s/h/j/ /m/f',
  }

  async function seeded(ops: readonly string[]): Promise<Workspace> {
    const vfs = new RAMVFS()
    const shellParser = await getTestParser()
    const seed = new Workspace({ '/m': [vfs, MountMode.WRITE] }, { shellParser })
    expect((await seed.shell(SETUP)).exitCode).toBe(0)
    const base = BaseVFS.prototype as unknown as Record<string, unknown>
    for (const op of ops)
      (vfs as unknown as Record<string, unknown>)[methodName(op)] = base[methodName(op)]
    return new Workspace({ '/m': [vfs, MountMode.WRITE] }, { mode: MountMode.WRITE, shellParser })
  }

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
})
