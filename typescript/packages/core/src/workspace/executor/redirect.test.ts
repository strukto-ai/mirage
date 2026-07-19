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

import { describe, expect, it, vi } from 'vitest'
import { IOResult } from '../../io/types.ts'
import { Redirect, RedirectKind } from '../../shell/types.ts'
import { PathSpec } from '../../types.ts'
import type { TSNodeLike } from '../expand/variable.ts'
import { makeIntegrationWS, run, runExit, runResult } from '../fixtures/integration_fixture.ts'
import { Session } from '../session/session.ts'
import { ExecutionNode } from '../types.ts'
import type { DispatchFn } from './cross_mount.ts'
import type { ExecuteNodeFn } from './jobs.ts'
import { handleRedirect } from './redirect.ts'

function encode(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function decode(b: Uint8Array | null): string {
  return b === null ? '' : new TextDecoder().decode(b)
}

const STUB_NODE: TSNodeLike = {
  type: 'command',
  text: 'x',
  children: [],
  namedChildren: [],
  isNamed: true,
}

describe('handleRedirect > / >>', () => {
  it('> writes stdout to a file (dispatch write)', async () => {
    const writes: { path: string; data: Uint8Array }[] = []
    const dispatch = vi.fn<DispatchFn>((op, path, args) => {
      if (op === 'write') {
        writes.push({ path: path.virtual, data: args?.[0] as Uint8Array })
      }
      return Promise.resolve<[unknown, IOResult]>([null, new IOResult()])
    })
    const execute: ExecuteNodeFn = () =>
      Promise.resolve([encode('hello'), new IOResult(), new ExecutionNode()])
    const redirects = [new Redirect({ fd: 1, target: '/ram/out.txt', kind: RedirectKind.STDOUT })]
    const [stdout, io] = await handleRedirect(
      execute,
      dispatch,
      STUB_NODE,
      redirects,
      new Session({ sessionId: 'test' }),
    )
    expect(stdout).toBeNull()
    expect(io.exitCode).toBe(0)
    expect(writes).toHaveLength(1)
    expect(writes[0]?.path).toBe('/ram/out.txt')
    expect(decode(writes[0]?.data ?? null)).toBe('hello')
    expect(io.writes['/ram/out.txt']).toBeDefined()
  })

  it('>> appends to existing file', async () => {
    const writes: { path: string; data: Uint8Array }[] = []
    const dispatch = vi.fn<DispatchFn>((op, path, args) => {
      if (op === 'read')
        return Promise.resolve<[unknown, IOResult]>([encode('pre-'), new IOResult()])
      if (op === 'write') writes.push({ path: path.virtual, data: args?.[0] as Uint8Array })
      return Promise.resolve<[unknown, IOResult]>([null, new IOResult()])
    })
    const execute: ExecuteNodeFn = () =>
      Promise.resolve([encode('new'), new IOResult(), new ExecutionNode()])
    const redirects = [
      new Redirect({ fd: 1, target: '/ram/log.txt', kind: RedirectKind.STDOUT, append: true }),
    ]
    await handleRedirect(
      execute,
      dispatch,
      STUB_NODE,
      redirects,
      new Session({ sessionId: 'test' }),
    )
    expect(decode(writes[0]?.data ?? null)).toBe('pre-new')
  })
})

describe('handleRedirect < (stdin)', () => {
  it('< reads a file and feeds it as stdin to the command', async () => {
    const dispatch = vi.fn<DispatchFn>((op) => {
      if (op === 'read')
        return Promise.resolve<[unknown, IOResult]>([encode('file-contents'), new IOResult()])
      return Promise.resolve<[unknown, IOResult]>([null, new IOResult()])
    })
    let receivedStdin: Uint8Array | null = null
    const execute: ExecuteNodeFn = async (_n, _s, stdin) => {
      if (stdin instanceof Uint8Array) receivedStdin = stdin
      return Promise.resolve([null, new IOResult(), new ExecutionNode()])
    }
    const redirects = [new Redirect({ fd: 0, target: '/ram/input.txt', kind: RedirectKind.STDIN })]
    await handleRedirect(
      execute,
      dispatch,
      STUB_NODE,
      redirects,
      new Session({ sessionId: 'test' }),
    )
    expect(receivedStdin).not.toBeNull()
    expect(decode(receivedStdin)).toBe('file-contents')
  })
})

describe('handleRedirect <<< (herestring)', () => {
  it('<<< feeds text+newline as stdin, strips surrounding quotes', async () => {
    const dispatch = vi.fn<DispatchFn>(() =>
      Promise.resolve<[unknown, IOResult]>([null, new IOResult()]),
    )
    let receivedStdin: Uint8Array | null = null
    const execute: ExecuteNodeFn = async (_n, _s, stdin) => {
      if (stdin instanceof Uint8Array) receivedStdin = stdin
      return Promise.resolve([null, new IOResult(), new ExecutionNode()])
    }
    const redirects = [
      new Redirect({ fd: 0, target: '"hello world"', kind: RedirectKind.HERESTRING }),
    ]
    await handleRedirect(
      execute,
      dispatch,
      STUB_NODE,
      redirects,
      new Session({ sessionId: 'test' }),
    )
    expect(decode(receivedStdin)).toBe('hello world\n')
  })
})

describe('handleRedirect 2>&1', () => {
  it('merges stderr into the file when 2>&1 follows the file redirect', async () => {
    // `cmd > f 2>&1` — fd2 follows fd1 into the file.
    const writes: { data: Uint8Array }[] = []
    const dispatch = vi.fn<DispatchFn>((op, _p, args) => {
      if (op === 'write') writes.push({ data: args?.[0] as Uint8Array })
      return Promise.resolve<[unknown, IOResult]>([null, new IOResult()])
    })
    const execute: ExecuteNodeFn = () =>
      Promise.resolve([
        encode('out-'),
        new IOResult({ stderr: encode('err-') }),
        new ExecutionNode(),
      ])
    const redirects = [
      new Redirect({ fd: 1, target: '/ram/combined', kind: RedirectKind.STDOUT }),
      new Redirect({ fd: 2, target: 1, kind: RedirectKind.STDERR_TO_STDOUT }),
    ]
    await handleRedirect(
      execute,
      dispatch,
      STUB_NODE,
      redirects,
      new Session({ sessionId: 'test' }),
    )
    expect(decode(writes[0]?.data ?? null)).toBe('out-err-')
  })

  it('keeps stderr on the original stdout when 2>&1 precedes the file redirect', async () => {
    // `cmd 2>&1 > f` — fd2 was pointed at the ORIGINAL stdout before
    // fd1 moved to the file; only stdout lands in the file.
    const writes: { data: Uint8Array }[] = []
    const dispatch = vi.fn<DispatchFn>((op, _p, args) => {
      if (op === 'write') writes.push({ data: args?.[0] as Uint8Array })
      return Promise.resolve<[unknown, IOResult]>([null, new IOResult()])
    })
    const execute: ExecuteNodeFn = () =>
      Promise.resolve([
        encode('out-'),
        new IOResult({ stderr: encode('err-') }),
        new ExecutionNode(),
      ])
    const redirects = [
      new Redirect({ fd: 2, target: 1, kind: RedirectKind.STDERR_TO_STDOUT }),
      new Redirect({ fd: 1, target: '/ram/only', kind: RedirectKind.STDOUT }),
    ]
    const [stdout] = await handleRedirect(
      execute,
      dispatch,
      STUB_NODE,
      redirects,
      new Session({ sessionId: 'test' }),
    )
    expect(decode(writes[0]?.data ?? null)).toBe('out-')
    expect(decode((stdout as Uint8Array | null) ?? null)).toBe('err-')
  })
})

describe('handleRedirect &> (both to file)', () => {
  it('writes stdout+stderr combined to the target', async () => {
    const writes: { data: Uint8Array; path: string }[] = []
    const dispatch = vi.fn<DispatchFn>((op, p, args) => {
      if (op === 'write') writes.push({ path: p.virtual, data: args?.[0] as Uint8Array })
      return Promise.resolve<[unknown, IOResult]>([null, new IOResult()])
    })
    const execute: ExecuteNodeFn = () =>
      Promise.resolve([encode('OUT'), new IOResult({ stderr: encode('ERR') }), new ExecutionNode()])
    const redirects = [new Redirect({ fd: -1, target: '/ram/all.log', kind: RedirectKind.STDOUT })]
    await handleRedirect(
      execute,
      dispatch,
      STUB_NODE,
      redirects,
      new Session({ sessionId: 'test' }),
    )
    expect(writes[0]?.path).toBe('/ram/all.log')
    expect(decode(writes[0]?.data ?? null)).toBe('OUTERR')
  })
})

describe('handleRedirect accepts PathSpec targets', () => {
  it('pre-resolved PathSpec target passes through ensureScope', async () => {
    const writes: { data: Uint8Array }[] = []
    const dispatch = vi.fn<DispatchFn>((op, _p, args) => {
      if (op === 'write') writes.push({ data: args?.[0] as Uint8Array })
      return Promise.resolve<[unknown, IOResult]>([null, new IOResult()])
    })
    const execute: ExecuteNodeFn = () =>
      Promise.resolve([encode('ok'), new IOResult(), new ExecutionNode()])
    const scope = PathSpec.fromStrPath('/ram/f')
    const redirects = [new Redirect({ fd: 1, target: scope, kind: RedirectKind.STDOUT })]
    await handleRedirect(
      execute,
      dispatch,
      STUB_NODE,
      redirects,
      new Session({ sessionId: 'test' }),
    )
    expect(decode(writes[0]?.data ?? null)).toBe('ok')
  })
})

describe('fd-table routing end-to-end', () => {
  it('bare > file creates an empty file', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      expect(await runExit(ws, '> /data/bare')).toBe(0)
      expect(await runExit(ws, 'test -f /data/bare')).toBe(0)
      expect(await run(ws, 'cat /data/bare')).toBe('')
    } finally {
      await ws.close()
    }
  })

  it('multiple stdout redirects truncate all, write last', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      await ws.execute('echo body > /data/m1 > /data/m2')
      expect(await run(ws, 'cat /data/m1')).toBe('')
      expect(await run(ws, 'cat /data/m2')).toBe('body\n')
    } finally {
      await ws.close()
    }
  })

  it('2> file creates the file even when stderr is empty', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      await ws.execute('echo fine 2> /data/errs')
      expect(await runExit(ws, 'test -f /data/errs')).toBe(0)
    } finally {
      await ws.close()
    }
  })

  it('>&2 before 2>> keeps stdout on the original stderr', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      const [exit, out, err] = await runResult(ws, 'echo a >&2 2>> /data/elog')
      expect(exit).toBe(0)
      expect(out).toBe('')
      expect(err).toBe('a\n')
      expect(await run(ws, 'cat /data/elog')).toBe('')
    } finally {
      await ws.close()
    }
  })

  it('applies the file redirect nested inside a heredoc', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      const [exit, out] = await runResult(ws, 'cat <<END > /data/hd\nwritten\nEND')
      expect(exit).toBe(0)
      expect(out).toBe('')
      expect(await run(ws, 'cat /data/hd')).toBe('written\n')
    } finally {
      await ws.close()
    }
  })

  it('&>> appends both streams', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      await ws.execute('echo one &> /data/acc')
      await ws.execute('echo three &>> /data/acc')
      expect(await run(ws, 'cat /data/acc')).toBe('one\nthree\n')
    } finally {
      await ws.close()
    }
  })
})
