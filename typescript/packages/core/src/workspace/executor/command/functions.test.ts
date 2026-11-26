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

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Action, CommandContext, Policy } from '../../../policy/index.ts'
import { Outcome, Scope, type AskHandler } from '../../../policy/index.ts'
import type { HandOff, Occurrence } from '../../../policy/types.ts'
import { NESTING_MAX } from '../../../shell/constants.ts'
import { MountMode } from '../../../types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { Workspace } from '../../workspace/workspace.ts'

const DEC = new TextDecoder()

async function run(line: string): Promise<[string, string, number]> {
  const ws = new Workspace({ '/r/': new RAMVFS() }, { mode: MountMode.WRITE })
  try {
    const io = await ws.shell(line)
    return [DEC.decode(io.stdout), DEC.decode(io.stderr), io.exitCode]
  } finally {
    await ws.close()
  }
}

function refused(name: string, limit: number): string {
  return `environment: line 1: ${name}: maximum function nesting level exceeded (${String(limit)})\n`
}

describe('function nesting limit', () => {
  it('a call past the limit abandons the line', async () => {
    const [out, err, code] = await run('f() { echo "d$1"; f $(($1+1)); }; f 1; echo same-line')
    expect(out.split('\n').filter((l) => l !== '')).toEqual(
      Array.from({ length: NESTING_MAX }, (_, i) => `d${String(i + 1)}`),
    )
    expect(err).toBe(refused('f', NESTING_MAX))
    expect(code).toBe(1)
  })

  it('substitution recursion stops at the limit', async () => {
    expect(await run('f() { echo $(f); }; f; echo "next $?"')).toEqual([
      '\nnext 0\n',
      refused('f', NESTING_MAX),
      0,
    ])
  })

  it('FUNCNEST lowers the limit', async () => {
    expect(await run('FUNCNEST=" +2 "; f() { echo "d$1"; f $(($1+1)); }; f 1')).toEqual([
      'd1\nd2\n',
      refused('f', 2),
      1,
    ])
  })

  it.each(['100', '0', '-1', '3x', '', '9'.repeat(5000)])(
    'FUNCNEST=%# never raises the limit',
    async (value) => {
      const [, err, code] = await run(`FUNCNEST="${value}"; f() { f; }; f`)
      expect([err, code]).toEqual([refused('f', NESTING_MAX), 1])
    },
  )

  it('a sourced file is not a function level', async () => {
    expect(
      await run('echo g > /r/s.sh; FUNCNEST=2; g() { echo g; }; f() { source /r/s.sh; }; f'),
    ).toEqual(['g\n', '', 0])
  })
})

class AskTouch implements Policy {
  preCommand(ctx: CommandContext): Action | null {
    return ctx.command === 'touch' ? { kind: 'ask', reason: 'touch' } : null
  }
}

function place(at: Occurrence | null): string[] {
  const texts: string[] = []
  for (let o = at; o !== null; o = o.parent) texts.push(o.source.slice(o.start, o.end))
  return texts
}

function under(handed: HandOff | null): (string | null)[] {
  const origins: (string | null)[] = []
  for (let h = handed; h !== null; h = h.parent) {
    const o = h.origin
    origins.push(o === null ? null : o.source.slice(o.start, o.end))
  }
  return origins
}

type Judged = [string, string[], (string | null)[]]

/**
 * Run a line with every `touch` asked about once, and report the asks and,
 * for each time the decisions judged one, where it stood and the origins of the
 * hand-offs it was judged under, innermost first.
 */
async function judged(line: string): Promise<[string[], Judged[]]> {
  const asks: string[] = []
  const seen: Judged[] = []
  const onAsk: AskHandler = (record) => {
    asks.push(record.argv.join(' '))
    return Promise.resolve({ ...record, outcome: Outcome.ALLOW, scope: Scope.ONCE })
  }
  const ws = new Workspace(
    { '/data/': new RAMVFS() },
    { mode: MountMode.WRITE, policies: [new AskTouch()], onAsk },
  )
  const resolve = ws.decisions.resolve.bind(ws.decisions)
  vi.spyOn(ws.decisions, 'resolve').mockImplementation((ctx, ask, signal, claimant = null) => {
    if (claimant === null) throw new Error('a command judged outside a line')
    seen.push([ctx.argv.join(' '), place(claimant.occurrence), under(claimant.line)])
    return resolve(ctx, ask, signal, claimant)
  })
  try {
    await ws.shell(line)
  } finally {
    await ws.close()
  }
  return [asks, seen]
}

describe('trap actions of a function body', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('a RETURN action set in a body is judged like the body', async () => {
    const body = "f() { trap 'touch /data/r' RETURN; touch /data/b; }"
    const [asks, seen] = await judged(`${body}; f; f`)
    expect(asks).toEqual(['/data/b', '/data/r'])
    const once: Judged[] = [
      ['/data/b', ['touch /data/b', body], [body, null]],
      ['/data/r', ['touch /data/r'], [null, body, null]],
    ]
    expect(seen).toEqual([...once, ...once])
  })

  it('an ERR action a body fires is judged under the body', async () => {
    const body = 'f() { false; }'
    const [asks, seen] = await judged(`set -E; trap 'touch /data/e' ERR; ${body}; f; f`)
    expect(asks).toEqual(['/data/e'])
    const once: Judged[] = [
      ['/data/e', ['touch /data/e'], [null, body, null]],
      ['/data/e', ['touch /data/e'], [null, null]],
    ]
    expect(seen).toEqual([...once, ...once])
  })

  it('an ERR action inside an if stands where the body one does', async () => {
    const body = 'f() { false; if :; then false; fi; }'
    const [asks, seen] = await judged(`set -E; trap 'touch /data/e' ERR; ${body}; f; f`)
    expect(asks).toEqual(['/data/e'])
    const once: Judged[] = [
      ['/data/e', ['touch /data/e'], [null, body, null]],
      ['/data/e', ['touch /data/e'], [null, body, null]],
      ['/data/e', ['touch /data/e'], [null, null]],
    ]
    expect(seen).toEqual([...once, ...once])
  })

  it('a trap outside any function is judged on the line', async () => {
    const [asks, seen] = await judged("trap 'touch /data/e' ERR; f() { :; }; f; false; false")
    expect(asks).toEqual(['/data/e'])
    const at: Judged = ['/data/e', ['touch /data/e'], [null, null]]
    expect(seen).toEqual([at, at])
  })

  it('one RETURN action text set by two functions asks once for both', async () => {
    const [asks, seen] = await judged(
      "f() { trap 'touch /data/r' RETURN; }; g() { trap 'touch /data/r' RETURN; }; f; g",
    )
    expect(asks).toEqual(['/data/r'])
    expect(seen.map(([, where]) => where)).toEqual([['touch /data/r'], ['touch /data/r']])
  })
})
