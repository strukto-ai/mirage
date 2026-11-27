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

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Handed } from '../../vfs/types.ts'
import { ALL_COMMANDS } from '../../policy/builtin/output_cap.ts'
import { Limit, MountMode, type PathSpec } from '../../types.ts'
import { GmailVFS } from '../../vfs/gmail/gmail.ts'
import { Mount } from '../../workspace/mount/spec.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { GoogleAccount, MESSAGES } from '../../../tests/core/google/account.ts'
import { seed } from '../../../tests/fixtures/gmail_seed.ts'

const DEC = new TextDecoder()

let origin: string
let account: GoogleAccount
let keys: Map<string, string>

beforeAll(async () => {
  origin = await serve('gws')
})

beforeEach(async () => {
  account = new GoogleAccount(origin)
  keys = await seed(account)
})

afterEach(async () => {
  await account.run.close()
})

class CountingGmail extends GmailVFS {
  readonly reads: string[] = []
  override read(path: PathSpec, handed?: Handed): Promise<Uint8Array> {
    if (path.vfsPath.endsWith('.gmail.json')) this.reads.push(path.vfsPath.split('__').pop() ?? '')
    return super.read(path, handed)
  }
}

type Ran = [string, number, string[], string[]]

/**
 * Run a line over a Gmail mount on the fake: the output, the exit code, the
 * keys of the messages read and the queries searched.
 */
async function onGmail(line: string, walkLimit = 1000): Promise<Ran> {
  await account.run.recordRequests()
  const vfs = new CountingGmail(account.config())
  const limits = { [ALL_COMMANDS]: new Limit({ walkLimit }) }
  const ws = new Workspace(
    { '/gmail': new Mount(vfs, { mode: MountMode.READ, commandLimits: limits }) },
    {},
  )
  try {
    const result = await ws.shell(line)
    const reads = vfs.reads.map((name) => keys.get(name.replace('.gmail.json', '')) ?? name).sort()
    // A date window is asked as after:, so a search is any other query.
    const searches = (await account.run.params('GET', MESSAGES))
      .map((asked) => asked.q)
      .filter((q): q is string => q !== undefined && !q.startsWith('after:'))
    return [DEC.decode(result.stdout), result.exitCode, reads, searches]
  } finally {
    await ws.close()
  }
}

describe('filesContaining', () => {
  // Twin of test_only_the_messages_whose_text_holds_it_are_read: the listing
  // keeps each message's rendered text, so a message is read when its text
  // holds the word anywhere: e5 holds rtf only in its attachment's MIME type,
  // g7 travel only in a snippet cut inside traveler, i9 mountain only in its
  // Date header and j10 wombat only inside a link, which Gmail's search may
  // not split out. Gmail's search is never asked.
  it.each([
    ['grep -rlw deploy /gmail', ['b2', 'b2', 'c3']],
    ['grep -rl deploy /gmail', ['b2', 'b2', 'c3']],
    ['grep -rlw Ana /gmail/INBOX', ['a1']],
    ['grep -rlw plan /gmail/INBOX', ['a1']],
    ['grep -rlw deploy /gmail/INBOX/2026-01-06', ['b2']],
    ['rg -lw friday /gmail/Work', ['b2']],
    ['grep -rlw rtf /gmail/INBOX', ['e5', 'f6']],
    ['grep -rlw travel /gmail/INBOX', ['a1', 'g7']],
    ['grep -rlw mountain /gmail/INBOX', ['h8', 'i9']],
    ['grep -rlw wombat /gmail', ['j10']],
    ['grep -rlw nothing /gmail', []],
  ])('reads only the messages whose text holds it for %s', async (line, reads) => {
    const full = await onGmail(line, -1)
    const [out, code, read, searches] = await onGmail(line)
    expect([out, code]).toEqual(full.slice(0, 2))
    expect(read).toEqual(reads)
    expect(searches).toEqual([])
  })

  // Twin of test_a_word_only_in_a_snippet_is_found: g7's snippet, cut inside
  // traveler, is the one place travel is a word of its text, and the read
  // finds it there.
  it('finds a word only in a snippet', async () => {
    const [out, , read] = await onGmail('grep -rlw travel /gmail/INBOX')
    expect(read).toEqual(['a1', 'g7'])
    const found = out
      .split(/\s+/)
      .filter((line) => line !== '')
      .map((line) => (line.split('/').at(-1) ?? '').split('__')[0])
      .sort()
    expect(found).toEqual(['Budget_review', 'Trip'])
  })

  // Twin of test_a_text_a_label_may_hold_reads_every_message: a message's
  // labels change after the listing kept its text, so the kept text leaves
  // them out and a text that may lie in a labels field reads every message.
  it.each([
    'grep -rl inbox /gmail',
    'grep -rlw STARRED /gmail',
    'grep -rl Label_1 /gmail',
    'grep -rl abel /gmail',
    `grep -rlF '","' /gmail`,
  ])('reads every message for %s', async (line) => {
    const full = await onGmail(line, -1)
    expect((await onGmail(line)).slice(0, 3)).toEqual(full.slice(0, 3))
  })

  it('reads every message for a text that is not ASCII', async () => {
    const line = 'grep -rl caf\u00e9 /gmail'
    const full = await onGmail(line, -1)
    expect((await onGmail(line)).slice(0, 3)).toEqual(full.slice(0, 3))
  })
})
