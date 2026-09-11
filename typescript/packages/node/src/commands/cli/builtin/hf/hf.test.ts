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

import { FileType } from '@struktoai/mirage-core/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cliSpecFor } from '@struktoai/mirage-core/commands/cli/specs'
import type * as CommitModule from '../../../../core/hf_hub/commit.ts'
import type { CLIDoors, CLIInvocation, CLISpec } from '@struktoai/mirage-core/commands/cli/types'
import { UsageError } from '@struktoai/mirage-core/commands/errors'
import { materialize } from '@struktoai/mirage-core/io/types'
import { yieldBytes } from '@struktoai/mirage-core/io/stream'
import type { CommandFnResult } from '@struktoai/mirage-core/commands/config'
import type { FlagValue } from '@struktoai/mirage-core/commands/spec/types'
import { ResourceName } from '@struktoai/mirage-core/types'
import type { HfConfig } from '../../../../core/hf_hub/config.ts'
import { Absence } from '../../../../core/hf_hub/repo.ts'
import type * as RepoModule from '../../../../core/hf_hub/repo.ts'
import type * as TreeModule from '../../../../core/hf_hub/tree.ts'
import { HF } from './index.ts'
import { createCmd, tagCreateCmd, tagDeleteCmd, tagListCmd } from './repo.ts'
import { whoamiCmd } from './auth.ts'
import { downloadCmd, refuseVariadic, selected } from './download.ts'
import { inRepoBase, keep, uploadCmd } from './upload.ts'

const createRepoMock = vi.hoisted(() => vi.fn())
const createTagMock = vi.hoisted(() => vi.fn())
const deleteTagMock = vi.hoisted(() => vi.fn())
const listTagsMock = vi.hoisted(() => vi.fn())
const classifyAbsenceMock = vi.hoisted(() => vi.fn())
const fetchTreeMock = vi.hoisted(() => vi.fn())
const commitMock = vi.hoisted(() => vi.fn())
const whoamiMock = vi.hoisted(() => vi.fn())

vi.mock('../../../../core/hf_hub/repo.ts', async (orig) => ({
  ...(await orig<typeof RepoModule>()),
  classifyAbsence: classifyAbsenceMock,
}))

vi.mock('../../../../core/hf_hub/tree.ts', async (orig) => ({
  ...(await orig<typeof TreeModule>()),
  fetchTree: fetchTreeMock,
}))

vi.mock('../../../../core/hf_hub/commit.ts', async (orig) => ({
  ...(await orig<typeof CommitModule>()),
  commit: commitMock,
}))

vi.mock('../../../../core/hf_hub/account.ts', () => ({
  whoami: whoamiMock,
}))

vi.mock('../../../../core/hf_hub/admin.ts', () => ({
  createRepo: createRepoMock,
  createTag: createTagMock,
  deleteTag: deleteTagMock,
  listTags: listTagsMock,
  deleteRepo: vi.fn(),
  whoami: vi.fn(),
}))

const CONFIG: HfConfig = { token: 'hf_test', endpoint: 'https://huggingface.co' }
const ANON: HfConfig = { endpoint: 'https://huggingface.co' }

function inv(
  texts: readonly string[] = [],
  flags: Record<string, FlagValue> = {},
  config: HfConfig = CONFIG,
  doors?: CLIDoors,
  stdin?: string,
): CLIInvocation {
  return {
    config,
    argv: texts,
    paths: [],
    texts,
    flags,
    stdin: stdin === undefined ? null : yieldBytes(new TextEncoder().encode(stdin)),
    env: {},
    ...(doors !== undefined ? { doors } : {}),
  }
}

async function text(result: CommandFnResult): Promise<string> {
  if (result === null) throw new Error('verb produced no output')
  return new TextDecoder().decode(await materialize(result[0]))
}

function child(spec: CLISpec, name: string): CLISpec {
  const found = spec.subcommands.find((s) => s.name === name)
  if (found === undefined) throw new Error(`no subcommand ${name}`)
  return found
}

beforeEach(() => {
  createRepoMock.mockReset()
  createTagMock.mockReset()
  deleteTagMock.mockReset()
  listTagsMock.mockReset()
  classifyAbsenceMock.mockReset()
  fetchTreeMock.mockReset()
})

describe('hf auth whoami', () => {
  it('labels the orgs the way upstream does', async () => {
    // An unlabelled org is indistinguishable from the account itself.
    // Upstream prints the label and the joined names as two print arguments,
    // which puts a second space after the colon. Measured: printed bare, an
    // agent asked to create a repo under its own account read the org off the
    // second line and created it there instead.
    whoamiMock.mockResolvedValue({
      name: 'zoe',
      orgs: [{ name: 'acme' }, { name: 'widgets' }],
    })
    expect(await text(await whoamiCmd(inv()))).toBe('zoe\norgs:  acme,widgets\n')
  })

  it('says nothing of orgs when there are none', async () => {
    whoamiMock.mockResolvedValue({ name: 'zoe', orgs: [] })
    expect(await text(await whoamiCmd(inv()))).toBe('zoe\n')
  })

  it('names a private endpoint, which every mirage install has', async () => {
    whoamiMock.mockResolvedValue({ name: 'zoe' })
    const config: HfConfig = { token: 'hf_test', endpoint: 'http://127.0.0.1:5199' }
    expect(await text(await whoamiCmd(inv([], {}, config)))).toBe(
      'zoe\nAuthenticated through private endpoint: http://127.0.0.1:5199\n',
    )
  })

  it('reads the endpoint the way the request did', async () => {
    // An empty endpoint IS the public Hub -- hfEndpoint substitutes API_BASE
    // and that is where whoami authenticated. Compared raw, the line would
    // announce a private endpoint with nothing after it for a request that
    // went to huggingface.co.
    whoamiMock.mockResolvedValue({ name: 'zoe' })
    const config: HfConfig = { token: 'hf_test', endpoint: '' }
    expect(await text(await whoamiCmd(inv([], {}, config)))).toBe('zoe\n')
  })
})

describe('the hf program tree', () => {
  it('registers under its head word', () => {
    expect(cliSpecFor('hf')).toBe(HF)
  })

  it('declares a config model, which is what makes it an account CLI', () => {
    // git declares none and reads mounts instead; an account CLI reaches a
    // service and initializes from its install.
    expect(HF.configModel).not.toBeNull()
  })

  it('names the three repository mounts it also backs', () => {
    expect([...HF.serves].sort()).toEqual(
      [ResourceName.HF_DATASETS, ResourceName.HF_MODELS, ResourceName.HF_SPACES].sort(),
    )
  })

  it('spells repo tag as a group of three, the way upstream hf does', () => {
    // Upstream v1 had `huggingface-cli tag --list/--delete` on one leaf;
    // `hf repo tag` is a group. Getting this wrong makes every tag line
    // mirage accepts one the real binary refuses.
    const tag = child(child(HF, 'repo'), 'tag')
    expect(tag.fn).toBeNull()
    expect(tag.subcommands.map((s) => s.name)).toEqual(['create', 'list', 'delete'])
  })

  it('spells space_sdk with upstream underscore', () => {
    const create = child(child(HF, 'repo'), 'create')
    expect(create.options.map((o) => o.long)).toContain('--space_sdk')
  })
})

describe('repo create', () => {
  it('prints the url the Hub answered', async () => {
    createRepoMock.mockResolvedValue({ url: 'https://hf.co/acme/widget' })
    expect(await text(await createCmd(inv(['acme/widget'])))).toBe('https://hf.co/acme/widget\n')
  })

  it('refuses a space without an sdk, naming the flag as typed', async () => {
    await expect(createCmd(inv(['acme/demo'], { repo_type: 'space' }))).rejects.toThrow(
      '--space_sdk',
    )
  })

  it('refuses without a token', async () => {
    await expect(createCmd(inv(['acme/widget'], {}, ANON))).rejects.toThrow(UsageError)
  })

  it('passes exist-ok through', async () => {
    createRepoMock.mockResolvedValue({})
    await createCmd(inv(['acme/widget'], { exist_ok: true }))
    const options = createRepoMock.mock.calls[0]?.[2] as { existOk?: boolean }
    expect(options.existOk).toBe(true)
  })

  it('falls back to the repo url it can derive', async () => {
    // The kind decides the path segment: a model sits at the origin root,
    // a dataset and a space under a plural one.
    createRepoMock.mockResolvedValue({})
    const out = await text(await createCmd(inv(['acme/rows'], { repo_type: 'dataset' })))
    expect(out).toBe('https://huggingface.co/datasets/acme/rows\n')
  })
})

describe('upstream variadic option lines', () => {
  it('lets a real filename operand through', () => {
    refuseVariadic(['a.txt'], '--include', ['*.json'])
  })

  it('refuses a glob-shaped operand, naming the spelling that works', () => {
    // Upstream's --include is nargs='*'; mirage's grammar has no variadic
    // option value, so the second pattern would land as a filename operand
    // and be looked for literally.
    expect(() => {
      refuseVariadic(['*.txt'], '--include', ['*.json'])
    }).toThrow("write --include '*.json' --include '*.txt'")
  })
})

describe('repo tag', () => {
  it('tags the named revision', async () => {
    const out = await text(
      await tagCreateCmd(inv(['acme/widget', 'v1'], { revision: 'dev', message: 'cut' })),
    )
    expect(out).toBe('Tag v1 created on acme/widget\n')
    expect(createTagMock.mock.calls[0]?.[4]).toBe('dev')
    expect(createTagMock.mock.calls[0]?.[5]).toBe('cut')
  })

  it('defaults to the default revision', async () => {
    await tagCreateCmd(inv(['acme/widget', 'v1']))
    expect(createTagMock.mock.calls[0]?.[4]).toBe('main')
  })

  it('prints one tag per line', async () => {
    listTagsMock.mockResolvedValue(['v1', 'v2'])
    expect(await text(await tagListCmd(inv(['acme/widget'])))).toBe('v1\nv2\n')
  })

  it('needs -y to delete, having no terminal to ask on', async () => {
    await expect(tagDeleteCmd(inv(['acme/widget', 'v1']))).rejects.toThrow('-y')
    expect(deleteTagMock).not.toHaveBeenCalled()
  })

  it('takes yes on stdin, which is where upstream reads it', async () => {
    await tagDeleteCmd(inv(['acme/widget', 'v1'], {}, CONFIG, undefined, 'y\n'))
    expect(deleteTagMock).toHaveBeenCalledTimes(1)
  })

  it('declines anything but yes', async () => {
    await expect(
      tagDeleteCmd(inv(['acme/widget', 'v1'], {}, CONFIG, undefined, 'n\n')),
    ).rejects.toThrow(UsageError)
    expect(deleteTagMock).not.toHaveBeenCalled()
  })

  it('deletes the tag with -y', async () => {
    const out = await text(await tagDeleteCmd(inv(['acme/widget', 'v1'], { yes: true })))
    expect(out).toBe('Tag v1 deleted on acme/widget\n')
    expect(deleteTagMock.mock.calls[0]?.slice(1, 3)).toEqual(['acme/widget', 'v1'])
  })
})

describe('path_in_repo', () => {
  it.each([
    ['', ''],
    ['.', ''],
    ['./', ''],
    ['/', ''],
    ['docs', 'docs'],
    ['/docs/', 'docs'],
    ['./docs', 'docs'],
    ['docs/../notes', 'notes'],
    ['a/b/c', 'a/b/c'],
  ])('normalizes %s to %s', (value, expected) => {
    // A Hub path is repo-relative with no leading slash and no `.` component.
    // Taking `hf upload repo /local .` literally stored every file under
    // `./`, which the resolve endpoint could not then find.
    expect(inRepoBase(value)).toBe(expected)
  })

  it.each(['..', '../out', 'docs/../../out'])('refuses %s, which climbs out', (value) => {
    expect(() => inRepoBase(value)).toThrow('stay inside the repository')
  })
})

describe('why nothing was selected', () => {
  // fetchTree folds 401/403/404 into an empty listing so a mount can render
  // an unreadable repository as an empty directory. Three different failures
  // would otherwise all read as "no files matched", so the CLI asks the Hub
  // which one it was.
  const doors = { dispatch: vi.fn() } as unknown as CLIDoors

  it.each([
    [Absence.REPO, [] as string[], 'Repository Not Found'],
    [Absence.REVISION, [] as string[], 'Invalid rev id'],
    [Absence.PRESENT, ['nope.txt'], 'Entry Not Found'],
    [Absence.PRESENT, [] as string[], 'matched the line'],
  ])('reports %s as %s', async (absence, names, expected) => {
    fetchTreeMock.mockResolvedValue(new Map())
    classifyAbsenceMock.mockResolvedValue(absence)
    await expect(
      downloadCmd(inv(['acme/widget', ...names], { local_dir: '/work/out' }, CONFIG, doors)),
    ).rejects.toThrow(expected)
  })
})

describe('required operands', () => {
  // `Operand.required` only refuses under the clap dialect, and hf is
  // argparse, so each leaf owns the check. Without it the line reached the
  // Hub and came back as an authentication error instead of naming the slot.
  it('names the one empty slot', async () => {
    await expect(tagCreateCmd(inv(['acme/widget']))).rejects.toThrow(
      'the following arguments are required: tag',
    )
    expect(createTagMock).not.toHaveBeenCalled()
  })

  it('names every empty slot', async () => {
    await expect(tagCreateCmd(inv([]))).rejects.toThrow('required: repo_id, tag')
  })

  it('refuses a delete with no tag', async () => {
    await expect(tagDeleteCmd(inv(['acme/widget'], { yes: true }))).rejects.toThrow('required: tag')
    expect(deleteTagMock).not.toHaveBeenCalled()
  })

  it('refuses a list with no repo', async () => {
    await expect(tagListCmd(inv([]))).rejects.toThrow('required: repo_id')
    expect(listTagsMock).not.toHaveBeenCalled()
  })
})

describe('operand and glob selection', () => {
  const tree = new Map([
    ['a.txt', { path: 'a.txt', type: 'file' }],
    ['sub', { path: 'sub', type: 'directory' }],
    ['sub/b.json', { path: 'sub/b.json', type: 'file' }],
  ] as [string, never][])

  it('downloads named files verbatim, ignoring include and exclude', () => {
    // Upstream downloads exactly the named files and does not then filter
    // them, so --include only ever narrows a whole-repo download.
    expect(selected(tree, ['sub/b.json'], ['*.txt'], ['sub/*'])).toEqual(['sub/b.json'])
  })

  it('drops directories from a whole-repo download', () => {
    expect(selected(tree, [], [], [])).toEqual(['a.txt', 'sub/b.json'])
  })

  it('narrows with include and then exclude', () => {
    expect(selected(tree, [], ['sub/*'], [])).toEqual(['sub/b.json'])
    expect(selected(tree, [], [], ['sub/*'])).toEqual(['a.txt'])
  })

  it('applies the same globs to an upload', () => {
    const rows = [
      { name: 'a.txt', data: new Uint8Array() },
      { name: 'b.json', data: new Uint8Array() },
    ]
    expect(keep(rows, ['*.json'], []).map((r) => r.name)).toEqual(['b.json'])
    expect(keep(rows, [], ['*.json']).map((r) => r.name)).toEqual(['a.txt'])
  })
})

describe('where an upload lands', () => {
  // Upstream reads `path_in_repo` as the destination FILE for a file source
  // and as the destination FOLDER for a directory one; `_resolve_upload_paths`
  // only falls back to the basename when the operand is absent. Probed against
  // hf 0.35.3 pointed at the integ fake: `hf upload r ./a.txt docs` leaves a
  // tree of exactly ['docs']. Appending the basename either way stored it at
  // `docs/a.txt`, which the tree then reported as a directory and
  // `hf download` could not find at all.
  const tree: Record<string, { dir: boolean; data: string; kids: string[] }> = {
    '/work': { dir: true, data: '', kids: ['/work/a.txt', '/work/sub'] },
    '/work/sub': { dir: true, data: '', kids: ['/work/sub/b.txt'] },
    '/work/a.txt': { dir: false, data: 'alpha', kids: [] },
    '/work/sub/b.txt': { dir: false, data: 'beta', kids: [] },
  }
  const doors = {
    dispatch: vi.fn((op: string, spec: { virtual: string }) => {
      const node = tree[spec.virtual]
      if (node === undefined) {
        return Promise.reject(Object.assign(new Error('nope'), { code: 'ENOENT' }))
      }
      if (op === 'stat') {
        return Promise.resolve([{ type: node.dir ? FileType.DIRECTORY : FileType.FILE }, null])
      }
      if (op === 'readdir') return Promise.resolve([node.kids, null])
      return Promise.resolve([new TextEncoder().encode(node.data), null])
    }),
  } as unknown as CLIDoors

  const additions = (): { path: string }[] =>
    (commitMock.mock.calls[0]?.[1] as { additions: { path: string }[] }).additions

  beforeEach(() => commitMock.mockReset())

  it('puts a file AT path_in_repo', async () => {
    await uploadCmd(inv(['acme/widget', '/work/a.txt', 'docs'], {}, CONFIG, doors))
    expect(additions()[0]?.path).toBe('docs')
  })

  it('spreads a directory UNDER path_in_repo', async () => {
    await uploadCmd(inv(['acme/widget', '/work', 'docs'], {}, CONFIG, doors))
    expect(additions().map((a) => a.path)).toEqual(['docs/a.txt', 'docs/sub/b.txt'])
  })

  it('falls back to the basename when path_in_repo is absent', async () => {
    await uploadCmd(inv(['acme/widget', '/work/a.txt'], {}, CONFIG, doors))
    expect(additions()[0]?.path).toBe('a.txt')
  })
})
