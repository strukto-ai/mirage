import type * as BindModule from '../generic_bind/index.ts'
import type * as SearchModule from '../../../core/gmail/search.ts'
import { beforeEach, expect, it, vi } from 'vitest'
vi.mock('../../../core/gmail/search.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof SearchModule>()),
  searchMessages: vi.fn(),
}))
vi.mock('../generic/grep.ts', () => ({ grepGeneric: vi.fn() }))
vi.mock('../generic_bind/index.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof BindModule>()),
  resolveGlobOf: () => (_accessor: GmailAccessor, paths: PathSpec[]) => Promise.resolve(paths),
}))

import { GmailAccessor } from '../../../accessor/gmail.ts'
import type { TokenManager } from '../../../core/google/client.ts'
import { searchMessages } from '../../../core/gmail/search.ts'
import { IOResult } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import type { FlagValue } from '../../spec/types.ts'
import { grepGeneric } from '../generic/grep.ts'
import { GMAIL_GREP } from './grep.ts'
import { ioFor } from '../../../test-utils.ts'
import { GmailVFS } from '../../../vfs/gmail/gmail.ts'

const search = vi.mocked(searchMessages)
const generic = vi.mocked(grepGeneric)
const path = new PathSpec({
  virtual: '/gmail/INBOX',
  directory: '/gmail/INBOX',
  vfsPath: 'INBOX',
})

async function run(flags: Record<string, FlagValue>) {
  const cmd = GMAIL_GREP[0]
  if (cmd === undefined) throw new Error('grep not registered')
  const accessor = new GmailAccessor({ tokenManager: {} as TokenManager })
  return cmd.fn(accessor, [path], ['needle'], {
    stdin: null,
    flags: { w: true, ...flags },
    filetypeFns: null,
    io: ioFor(GmailVFS, accessor),
    cwd: '/',
  })
}

beforeEach(() => {
  search.mockReset()
  generic.mockReset()
  search.mockResolvedValue([
    {
      id: 'm1',
      subject: 'needle',
      snippet: 'needle',
      sender: 'test@example.com',
      bodyText: '',
      date: '2026-01-01',
      label: 'INBOX',
    },
  ])
  generic.mockResolvedValue([new Uint8Array(), new IOResult()])
})

it('falls back when a service snippet contains binary bytes', async () => {
  search.mockResolvedValue([
    {
      id: 'm1',
      subject: '',
      snippet: 'needle\0tail',
      sender: 'test@example.com',
      bodyText: '',
      date: '2026-01-01',
      label: 'INBOX',
    },
  ])
  await run({})
  expect(generic).toHaveBeenCalledOnce()
})
