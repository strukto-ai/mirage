import { afterEach, expect, it, vi } from 'vitest'
import * as github from '../../../../core/github/repo.ts'
import { IOResult } from '../../../../io/types.ts'
import { MountMode, PathSpec } from '../../../../types.ts'
import { RAMVFS } from '../../../../vfs/ram/ram.ts'
import type { ExecuteResult } from '../../../../workspace/workspace/types.ts'
import { Workspace } from '../../../../workspace/workspace/workspace.ts'
import type { Context } from '../../../config.ts'
import * as git from '../git/clone.ts'
import { GH } from './index.ts'

const WORK = PathSpec.fromStrPath('/w')

afterEach(() => vi.restoreAllMocks())

function clones(): [string[], Context][] {
  const calls: [string[], Context][] = []
  vi.spyOn(github, 'login').mockResolvedValue('alice')
  vi.spyOn(git, 'clone').mockImplementation((_config, _paths, texts, ctx) => {
    calls.push([texts, ctx])
    return Promise.resolve([null, new IOResult()])
  })
  return calls
}

async function run(line: string, base?: string): Promise<ExecuteResult> {
  const ws = new Workspace({ '/w': new RAMVFS() }, { mode: MountMode.WRITE })
  ws.registerCli('gh', GH, {
    token: 'secret-never-print',
    ...(base === undefined ? {} : { base_url: base }),
  })
  try {
    return await ws.shell(line)
  } finally {
    await ws.close()
  }
}

it.each([
  ['cd /w && gh repo clone o/r', undefined, ['https://github.com/o/r.git', 'r'], { C: WORK }],
  [
    'cd /w && gh repo clone https://github.com/o/r.git dest',
    undefined,
    ['https://github.com/o/r.git', 'dest'],
    { C: WORK },
  ],
  [
    'cd /w && gh repo clone mine -- -q --branch dev',
    undefined,
    ['https://github.com/alice/mine.git', 'mine'],
    { quiet: true, branch: 'dev', C: WORK },
  ],
  [
    'cd /w && gh repo clone ghe.test/o/r',
    'https://ghe.test/api/v3',
    ['https://ghe.test/o/r.git', 'r'],
    { C: WORK },
  ],
])('hands git clone the url and flags of %s', async (line, base, texts, flags) => {
  const calls = clones()
  const result = await run(line, base)
  expect([result.exitCode, result.stderr.length]).toEqual([0, 0])
  expect([calls[0]?.[0], calls[0]?.[1].flags]).toEqual([texts, flags])
})
