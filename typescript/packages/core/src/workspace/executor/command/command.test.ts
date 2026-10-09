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
import { EvaluationContext } from '../../evaluation.ts'
import { describe, expect, it } from 'vitest'
import { command } from '../../../commands/config.ts'
import { CommandSpec, type FlagValue, Argument } from '../../../commands/spec/types.ts'
import { IOResult } from '../../../io/types.ts'
import { JobTable } from '../../../shell/job_table/index.ts'
import { BaseVFS } from '../../../vfs/base.ts'
import { MountMode, PathSpec } from '../../../types.ts'
import { MountRegistry } from '../../mount/registry.ts'
import { SessionState } from '../../session/session.ts'
import type { ExecuteNodeFn } from './types.ts'
import type { DispatchFn } from '../../../runtime/types.ts'
import { handleCommand } from './command.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { getTestParser } from '../../fixtures/workspace_fixture.ts'
import { Workspace } from '../../workspace/workspace.ts'

class StubVFS extends BaseVFS {
  constructor(override readonly name: string) {
    super()
  }
  override close(): Promise<void> {
    return Promise.resolve()
  }
}

const NEVER_EXECUTE: ExecuteNodeFn = () => {
  throw new Error('executeNode should not have been called')
}

const NEVER_DISPATCH: DispatchFn = () => {
  throw new Error('dispatch should not have been called')
}

function decode(b: Uint8Array | null): string {
  if (b === null) return ''
  return new TextDecoder().decode(b)
}

describe('handleCommand — command not found', () => {
  it('returns exit 127 when no mount has the command', async () => {
    const reg = new MountRegistry({ '/ram': new StubVFS('ram') }, MountMode.WRITE)
    const [, io, exec] = await handleCommand(
      NEVER_EXECUTE,
      NEVER_DISPATCH,
      reg,
      ['nope'],
      new EvaluationContext(new SessionState({ sessionId: 'test' })),
    )
    expect(io.exitCode).toBe(127)
    expect(exec.exitCode).toBe(127)
    expect(decode(io.stderr as Uint8Array)).toMatch(/command not found/)
  })
})

describe('handleCommand — dispatches to mount that has the command', () => {
  const BASIC_SPEC = new CommandSpec({
    arguments: [new Argument('paths', { metavar: '', type: 'path', nargs: '*' })],
  })

  it('routes to a mount whose VFS registered the command', async () => {
    const ram = new StubVFS('ram')
    const reg = new MountRegistry({ '/ram': ram }, MountMode.WRITE)
    const mount = reg.mountFor('/ram/x')
    const [cmd] = command({
      name: 'cat',
      vfs: 'ram',
      spec: BASIC_SPEC,
      fn: () => [new TextEncoder().encode('hello'), new IOResult()],
    })
    if (cmd === undefined) throw new Error('cmd missing')
    mount.register(cmd)

    const [stdout, io, exec] = await handleCommand(
      NEVER_EXECUTE,
      NEVER_DISPATCH,
      reg,
      ['cat', PathSpec.fromStrPath('/ram/x')],
      new EvaluationContext(new SessionState({ sessionId: 'test' })),
    )
    expect(io.exitCode).toBe(0)
    expect(exec.exitCode).toBe(0)
    expect(decode(stdout as Uint8Array)).toBe('hello')
  })

  it('parses flags through the spec and forwards them', async () => {
    const ram = new StubVFS('ram')
    const reg = new MountRegistry({ '/ram': ram }, MountMode.WRITE)
    const mount = reg.mountFor('/ram')
    const spec = new CommandSpec({
      arguments: [
        new Argument('-n'),
        new Argument('paths', { metavar: '', type: 'path', nargs: '*' }),
      ],
    })
    let seenFlags: Record<string, FlagValue> = {}
    const [cmd] = command({
      name: 'head',
      vfs: 'ram',
      spec,
      fn: (_accessor, _paths, _texts, opts) => {
        seenFlags = opts.flags
        return [null, new IOResult()]
      },
    })
    if (cmd === undefined) throw new Error('cmd missing')
    mount.register(cmd)

    await handleCommand(
      NEVER_EXECUTE,
      NEVER_DISPATCH,
      reg,
      ['head', '-n', '5', PathSpec.fromStrPath('/ram/x')],
      new EvaluationContext(new SessionState({ sessionId: 'test' })),
    )
    expect(seenFlags.n).toBe('5')
  })
})

describe('handleCommand — cross-mount', () => {
  it('rejects multi-mount paths when cmd is not cross-capable', async () => {
    const reg = new MountRegistry(
      { '/ram': new StubVFS('ram'), '/disk': new StubVFS('disk') },
      MountMode.WRITE,
    )
    const mount = reg.mountFor('/ram')
    const [cmd] = command({
      name: 'mycmd',
      vfs: 'ram',
      spec: new CommandSpec({
        arguments: [new Argument('paths', { metavar: '', type: 'path', nargs: '*' })],
      }),
      fn: () => [null, new IOResult()],
    })
    if (cmd === undefined) throw new Error('cmd missing')
    mount.register(cmd)
    const [, io, exec] = await handleCommand(
      NEVER_EXECUTE,
      NEVER_DISPATCH,
      reg,
      ['mycmd', PathSpec.fromStrPath('/ram/a'), PathSpec.fromStrPath('/disk/b')],
      new EvaluationContext(new SessionState({ sessionId: 'test' })),
    )
    expect(io.exitCode).toBe(1)
    expect(exec.exitCode).toBe(1)
    expect(decode(io.stderr as Uint8Array)).toMatch(/cross-mount not supported/)
  })
})

describe('handleCommand — job builtins', () => {
  it('routes "jobs" to handleJobs when jobTable provided', async () => {
    const reg = new MountRegistry({ '/ram': new StubVFS('ram') }, MountMode.WRITE)
    const jt = new JobTable()
    const [, io] = await handleCommand(
      NEVER_EXECUTE,
      NEVER_DISPATCH,
      reg,
      ['jobs'],
      new EvaluationContext(new SessionState({ sessionId: 'test' })),
      null,
      null,
      jt,
    )
    expect(io.exitCode).toBe(0)
  })

  it('routes "kill N" to handleKill', async () => {
    const reg = new MountRegistry({ '/ram': new StubVFS('ram') }, MountMode.WRITE)
    const jt = new JobTable()
    const [, io] = await handleCommand(
      NEVER_EXECUTE,
      NEVER_DISPATCH,
      reg,
      ['kill', '999'],
      new EvaluationContext(new SessionState({ sessionId: 'test' })),
      null,
      null,
      jt,
    )
    expect(io.exitCode).toBe(1)
    expect(decode(io.stderr as Uint8Array)).toMatch(/No such process/)
  })
})

describe('the words a handler sees', () => {
  // The words after the command name reach the handler as typed, which is
  // where GNU's `missing operand after '<word>'` reads its word. Mirrors
  // python's test_a_handler_sees_the_words_the_line_spelled.
  it.each([
    ['cmp -s', "cmp: missing operand after '-s'\n"],
    ['cmp -n 5 --', "cmp: missing operand after '--'\n"],
    ['diff -u', "diff: missing operand after '-u'\n"],
    ['cd /data && join a.txt -t ,', "join: missing operand after ','\n"],
  ])('%s', async (line, err) => {
    const ws = new Workspace(
      { '/data/': new RAMVFS() },
      { mode: MountMode.WRITE, shellParser: await getTestParser() },
    )
    await ws.shell('echo a > /data/a.txt')
    const r = await ws.shell(line)
    expect(new TextDecoder().decode(r.stderr).startsWith(err)).toBe(true)
    await ws.close()
  })
})

describe('dispatched options route nothing', () => {
  // jq's --rawfile/--slurpfile are read and curl's -o/-D written through
  // the dispatcher, so a file on another mount, or a process substitution
  // under /dev, is no cross-mount line (DISPATCH_FLAG_KEYS). Positional operands
  // still route. Mirrors python's test_dispatch_options_route_nothing.
  it.each([
    [
      "jq -c -n --slurpfile t /work/t.json --slurpfile f <(echo '{\"x\":1}') '[$t, $f]'",
      '[[{"a":1}],[{"x":1}]]\n',
    ],
    ["jq -c --slurpfile t /work/t.json '[., $t]' /data/d.json", '[{"b":2},[{"a":1}]]\n'],
    ["cd /work && jq -c -n --rawfile r /data/r.txt '$r'", '"raw\\n"\n'],
  ])('%s', async (line, out) => {
    const ws = new Workspace(
      { '/data/': new RAMVFS(), '/work/': new RAMVFS() },
      { mode: MountMode.WRITE, shellParser: await getTestParser() },
    )
    await ws.shell(
      'echo \'{"a":1}\' > /work/t.json; echo \'{"b":2}\' > /data/d.json; echo raw > /data/r.txt',
    )
    const r = await ws.shell(line)
    expect([r.exitCode, decode(r.stdout), decode(r.stderr)]).toEqual([0, out, ''])
    await ws.close()
  })
})

class CachedRAM extends RAMVFS {
  override readonly cachesReads = true
}

describe('the cross-mount entry point', () => {
  it('keeps both edited files cached', async () => {
    // The sed relay is its own write path, apart from runDispatch: it claims
    // each -i file, and the line keeps the edited bytes on both mounts, which
    // then serve a cat after the backend changes.
    const enc = new TextEncoder()
    const left = new CachedRAM()
    const right = new CachedRAM()
    left.loadState({ type: 'ram', files: { '/f': enc.encode('a1\n') } })
    right.loadState({ type: 'ram', files: { '/g': enc.encode('a2\n') } })
    const ws = new Workspace(
      { '/a': left, '/b': right },
      { mode: MountMode.WRITE, shellParser: await getTestParser() },
    )
    try {
      const result = await ws.shell('sed -i s/a/b/ /a/f /b/g')
      expect(result.exitCode).toBe(0)
      expect(await ws.cache.get('/a/f')).toEqual(enc.encode('b1\n'))
      expect(await ws.cache.get('/b/g')).toEqual(enc.encode('b2\n'))
      left.loadState({ type: 'ram', files: { '/f': enc.encode('changed\n') } })
      const again = await ws.shell('cat /a/f')
      expect(again.stdout).toEqual(enc.encode('b1\n'))
    } finally {
      await ws.close()
    }
  })
})
