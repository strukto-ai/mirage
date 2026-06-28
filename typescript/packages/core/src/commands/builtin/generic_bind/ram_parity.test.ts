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
import { RAM_OPS } from '../ram/ops.ts'
import type { CommandFnResult, CommandOpts, RegisteredCommand } from '../../config.ts'
import { type ByteSource, IOResult, materialize } from '../../../io/types.ts'
import { RAMResource } from '../../../resource/ram/ram.ts'
import { PathSpec, ResourceName } from '../../../types.ts'
import { RAM_CAT } from '../ram/cat/cat.ts'
import { RAM_HEAD } from '../ram/head/head.ts'
import { RAM_TAIL } from '../ram/tail/tail.ts'
import { RAM_WC } from '../ram/wc/wc.ts'
import { RAM_LS } from '../ram/ls/ls.ts'
import { RAM_STAT } from '../ram/stat/stat.ts'
import { RAM_GREP } from '../ram/grep/grep.ts'
import { RAM_CUT } from '../ram/cut/cut.ts'
import { RAM_SORT } from '../ram/sort.ts'
import { RAM_NL } from '../ram/nl.ts'
import { RAM_DU } from '../ram/du.ts'
import { RAM_FIND } from '../ram/find.ts'
import { RAM_TREE } from '../ram/tree.ts'
import { RAM_REV } from '../ram/rev.ts'
import { RAM_UNIQ } from '../ram/uniq.ts'
import { makeGenericCommands } from './factory.ts'

const DEC = new TextDecoder()
const ENC = new TextEncoder()

function seed(): RAMResource {
  const r = new RAMResource()
  r.store.files.set('/a.txt', ENC.encode('banana\napple\napple\ncherry\n'))
  r.store.files.set('/b.txt', ENC.encode('one two three\nfour five six\n'))
  r.store.dirs.add('/')
  r.store.dirs.add('/sub')
  r.store.files.set('/sub/c.txt', ENC.encode('nested\n'))
  return r
}

function opts(flags: Record<string, string | boolean | string[]> = {}): CommandOpts {
  return { stdin: null, flags, filetypeFns: null, cwd: '/', resource: undefined as never }
}

async function render(result: CommandFnResult): Promise<{ out: string; exit: number }> {
  if (result === null) return { out: '', exit: 0 }
  const [body, io] = result as [ByteSource | null, IOResult]
  let out = ''
  if (body !== null) {
    const buf = body instanceof Uint8Array ? body : await materialize(body)
    out = DEC.decode(buf)
  }
  return { out, exit: io.exitCode }
}

const FACTORY = makeGenericCommands(ResourceName.RAM, RAM_OPS)

function factoryCmd(name: string): RegisteredCommand {
  const cmd = FACTORY.find((c) => c.name === name)
  if (cmd === undefined) throw new Error(`factory has no ${name}`)
  return cmd
}

interface Case {
  name: string
  wrapper: readonly RegisteredCommand[]
  paths: string[]
  texts?: string[]
  flags?: Record<string, string | boolean | string[]>
}

const CASES: Case[] = [
  { name: 'cat', wrapper: RAM_CAT, paths: ['/a.txt'] },
  { name: 'cat', wrapper: RAM_CAT, paths: ['/a.txt', '/b.txt'] },
  { name: 'cat', wrapper: RAM_CAT, paths: ['/a.txt'], flags: { n: true } },
  { name: 'head', wrapper: RAM_HEAD, paths: ['/a.txt'], flags: { n: '2' } },
  { name: 'tail', wrapper: RAM_TAIL, paths: ['/a.txt'], flags: { n: '2' } },
  { name: 'wc', wrapper: RAM_WC, paths: ['/a.txt'] },
  { name: 'wc', wrapper: RAM_WC, paths: ['/a.txt'], flags: { l: true } },
  { name: 'ls', wrapper: RAM_LS, paths: ['/'] },
  { name: 'ls', wrapper: RAM_LS, paths: ['/'], flags: { l: true } },
  { name: 'stat', wrapper: RAM_STAT, paths: ['/a.txt'] },
  { name: 'grep', wrapper: RAM_GREP, paths: ['/a.txt'], texts: ['apple'] },
  { name: 'grep', wrapper: RAM_GREP, paths: ['/a.txt'], texts: ['apple'], flags: { c: true } },
  { name: 'cut', wrapper: RAM_CUT, paths: ['/b.txt'], flags: { d: ' ', f: '2' } },
  { name: 'sort', wrapper: RAM_SORT, paths: ['/a.txt'] },
  { name: 'nl', wrapper: RAM_NL, paths: ['/a.txt'] },
  { name: 'du', wrapper: RAM_DU, paths: ['/'] },
  { name: 'find', wrapper: RAM_FIND, paths: ['/'], flags: { name: '*.txt' } },
  { name: 'tree', wrapper: RAM_TREE, paths: ['/'] },
  { name: 'rev', wrapper: RAM_REV, paths: ['/a.txt'] },
  { name: 'uniq', wrapper: RAM_UNIQ, paths: ['/a.txt'] },
]

describe('factory ram commands match wrappers', () => {
  for (const c of CASES) {
    const label = `${c.name} ${c.paths.join(' ')} ${JSON.stringify(c.flags ?? {})}`
    it(label, async () => {
      const wrapperCmd = c.wrapper[0]
      if (wrapperCmd === undefined) throw new Error(`no wrapper ${c.name}`)
      const factory = factoryCmd(c.name)
      const paths = c.paths.map((p) => PathSpec.fromStrPath(p))
      const texts = c.texts ?? []

      const rWrap = seed()
      const wrapOut = await render(
        await wrapperCmd.fn(rWrap.accessor, paths, texts, { ...opts(c.flags), resource: rWrap }),
      )
      const rFac = seed()
      const facOut = await render(
        await factory.fn(rFac.accessor, paths, texts, { ...opts(c.flags), resource: rFac }),
      )
      expect(facOut).toEqual(wrapOut)
    })
  }
})
