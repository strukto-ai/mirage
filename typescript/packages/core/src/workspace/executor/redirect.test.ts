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
import type { TSNodeLike } from '../../shell/types.ts'
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

// GNU bash 5.2.37 pinned: both `cat < missing` and `echo x > /nosuchdir/f`
// answer "bash: line 1: <target>: No such file or directory", exit 1, and
// never name the command. mirage drops the "bash: line N:" prefix, matching
describe('handleRedirect numeric targets', () => {
  it('routes a close or dup by the descriptor claimed, not the operator', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      expect(await runResult(ws, 'cat /data/missing 2<&-; echo code=$?')).toEqual([
        0,
        'code=1\n',
        '',
      ])
      expect(await runResult(ws, 'echo x 1<&-; echo code=$?')).toEqual([
        0,
        'code=1\n',
        'echo: write error: Bad file descriptor\n',
      ])
      expect(await runResult(ws, 'cat /data/missing 2<&1; echo code=$?')).toEqual([
        0,
        'cat: /data/missing: No such file or directory\ncode=1\n',
        '',
      ])
    } finally {
      await ws.close()
    }
  })

  it('reads a bare 0 touching the operator as the descriptor', async () => {
    const { ws } = await makeIntegrationWS({ 'a.txt': 'a' })
    try {
      expect(await runResult(ws, 'echo x 0>&-; echo code=$?')).toEqual([0, 'x\ncode=0\n', ''])
      expect(await runResult(ws, 'cat 0</data/a.txt; echo code=$?')).toEqual([0, 'acode=0\n', ''])
      expect(await runResult(ws, 'echo 0 >&-; echo code=$?')).toEqual([
        0,
        'code=1\n',
        'echo: write error: Bad file descriptor\n',
      ])
      expect(await runResult(ws, 'exec 2<&-; cat /data/missing; echo code=$?')).toEqual([
        0,
        'code=1\n',
        '',
      ])
      expect(await runResult(ws, 'exec 0>&-; echo x; echo code=$?')).toEqual([0, 'x\ncode=0\n', ''])
    } finally {
      await ws.close()
    }
  })
})

// the house style of the other shell-attributed error
// ("nosuchcmd: command not found").
describe('handleRedirect missing < source', () => {
  it('is shell-attributed, not command-attributed', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      const [exit, out, err] = await runResult(ws, 'cat < /data/missing')
      expect(exit).toBe(1)
      expect(out).toBe('')
      expect(err).toBe('/data/missing: No such file or directory\n')
    } finally {
      await ws.close()
    }
  })

  it('does not run the command', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      const [exit, out, err] = await runResult(ws, 'echo hi < /data/missing')
      expect(exit).toBe(1)
      expect(out).toBe('')
      expect(err).toBe('/data/missing: No such file or directory\n')
    } finally {
      await ws.close()
    }
  })

  it('keeps the rest of the line running', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      const [exit, out, err] = await runResult(ws, 'cat < /data/missing; echo next')
      expect(exit).toBe(0)
      expect(out).toBe('next\n')
      expect(err).toBe('/data/missing: No such file or directory\n')
    } finally {
      await ws.close()
    }
  })

  it('short-circuits && and runs ||', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      const [andExit, andOut] = await runResult(ws, 'cat < /data/missing && echo YES')
      expect(andExit).toBe(1)
      expect(andOut).toBe('')
      const [orExit, orOut] = await runResult(ws, 'cat < /data/missing || echo OR')
      expect(orExit).toBe(0)
      expect(orOut).toBe('OR\n')
    } finally {
      await ws.close()
    }
  })

  it('leaves the rest of the pipeline running', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      const [exit, out, err] = await runResult(ws, 'cat < /data/missing | wc -l')
      expect(exit).toBe(0)
      expect(out.trim()).toBe('0')
      expect(err).toBe('/data/missing: No such file or directory\n')
    } finally {
      await ws.close()
    }
  })

  it('reports the target as typed, not resolved', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      const [exit, , err] = await runResult(ws, 'cd /data && cat < missing')
      expect(exit).toBe(1)
      expect(err).toBe('missing: No such file or directory\n')
    } finally {
      await ws.close()
    }
  })

  it('stops at the first failing redirect', async () => {
    const { ws } = await makeIntegrationWS({ good: 'PRE' })
    try {
      const [exit, , err] = await runResult(ws, 'cat < /data/missing < /data/good')
      expect(exit).toBe(1)
      expect(err).toBe('/data/missing: No such file or directory\n')
    } finally {
      await ws.close()
    }
  })

  it('skips a later output redirect', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      const [exit] = await runResult(ws, 'echo hi < /data/missing > /data/late')
      expect(exit).toBe(1)
      expect(await runExit(ws, 'test -e /data/late')).toBe(1)
    } finally {
      await ws.close()
    }
  })

  it('rethrows a non-filesystem read error', async () => {
    const dispatch = vi.fn(() =>
      Promise.reject(new Error('backend exploded')),
    ) as unknown as DispatchFn
    const executeNode = vi.fn() as unknown as ExecuteNodeFn
    const redirects = [new Redirect({ fd: 0, target: '/data/missing', kind: RedirectKind.STDIN })]
    await expect(
      handleRedirect(
        executeNode,
        dispatch,
        STUB_NODE,
        redirects,
        new Session({ sessionId: 'test' }),
        null,
        null,
      ),
    ).rejects.toThrow('backend exploded')
    expect(executeNode).not.toHaveBeenCalled()
  })
})

describe('handleRedirect unwritable > target', () => {
  it('is shell-attributed, not command-attributed or backend prose', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      const [exit, out, err] = await runResult(ws, 'echo x > /nodir/f')
      expect(exit).toBe(1)
      expect(out).toBe('')
      expect(err).toBe('/nodir/f: No such file or directory\n')
    } finally {
      await ws.close()
    }
  })

  it('keeps the rest of the line running', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      const [exit, out, err] = await runResult(ws, 'echo x > /nodir/f; echo next')
      expect(exit).toBe(0)
      expect(out).toBe('next\n')
      expect(err).toBe('/nodir/f: No such file or directory\n')
    } finally {
      await ws.close()
    }
  })

  it('short-circuits && and runs ||', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      const [andExit, andOut] = await runResult(ws, 'echo x > /nodir/f && echo YES')
      expect(andExit).toBe(1)
      expect(andOut).toBe('')
      const [orExit, orOut] = await runResult(ws, 'echo x > /nodir/f || echo OR')
      expect(orExit).toBe(0)
      expect(orOut).toBe('OR\n')
    } finally {
      await ws.close()
    }
  })

  it.each(['echo x >> /nodir/f', 'echo x 2> /nodir/f', '> /nodir/f'])(
    'spells %s the same way',
    async (line) => {
      const { ws } = await makeIntegrationWS()
      try {
        const [exit, , err] = await runResult(ws, line)
        expect(exit).toBe(1)
        expect(err).toBe('/nodir/f: No such file or directory\n')
      } finally {
        await ws.close()
      }
    },
  )

  it('stops at the first failure and skips the later target', async () => {
    // GNU: `echo x > /nodir/f > /data/out` reports /nodir/f once and
    // never creates /data/out.
    const { ws } = await makeIntegrationWS()
    try {
      const [exit, , err] = await runResult(ws, 'echo x > /nodir/f > /data/out')
      expect(exit).toBe(1)
      expect(err).toBe('/nodir/f: No such file or directory\n')
      expect(await runExit(ws, 'test -e /data/out')).toBe(1)
    } finally {
      await ws.close()
    }
  })

  it('keeps a target opened before the failing one', async () => {
    // GNU: `echo y > /data/out2 > /nodir/g` already truncated
    // /data/out2, so it survives as an empty file.
    const { ws } = await makeIntegrationWS()
    try {
      const [exit, , err] = await runResult(ws, 'echo y > /data/out2 > /nodir/g')
      expect(exit).toBe(1)
      expect(err).toBe('/nodir/g: No such file or directory\n')
      expect(await runExit(ws, 'test -e /data/out2')).toBe(0)
      const [, out] = await runResult(ws, 'cat /data/out2')
      expect(out).toBe('')
    } finally {
      await ws.close()
    }
  })

  it('rethrows a non-filesystem append pre-read error', async () => {
    // The `>>` pre-read swallows filesystem errors (the write reports
    // them) but must not hide a backend bug.
    const dispatch = vi.fn<DispatchFn>((op) => {
      if (op === 'read') return Promise.reject(new Error('backend exploded'))
      return Promise.resolve<[unknown, IOResult]>([null, new IOResult()])
    })
    const execute: ExecuteNodeFn = () =>
      Promise.resolve([encode('hi'), new IOResult(), new ExecutionNode()])
    const redirects = [
      new Redirect({ fd: 1, target: '/ram/out.txt', kind: RedirectKind.STDOUT, append: true }),
    ]
    await expect(
      handleRedirect(execute, dispatch, STUB_NODE, redirects, new Session({ sessionId: 'test' })),
    ).rejects.toThrow('backend exploded')
  })

  it('rethrows a non-filesystem write error', async () => {
    const dispatch = vi.fn<DispatchFn>((op) => {
      if (op === 'write') return Promise.reject(new Error('backend exploded'))
      return Promise.resolve<[unknown, IOResult]>([null, new IOResult()])
    })
    const execute: ExecuteNodeFn = () =>
      Promise.resolve([encode('hi'), new IOResult(), new ExecutionNode()])
    const redirects = [new Redirect({ fd: 1, target: '/ram/out.txt', kind: RedirectKind.STDOUT })]
    await expect(
      handleRedirect(execute, dispatch, STUB_NODE, redirects, new Session({ sessionId: 'test' })),
    ).rejects.toThrow('backend exploded')
  })
})

describe('descriptor zero duplication', () => {
  it.each([
    ['echo x 1>&0', '', 'echo: write error: Bad file descriptor\n', 1],
    // A self-dup never reopens a closed descriptor, transient or
    // persistent; a file redirect on it does.
    [
      'touch /data/marker 1>&- 1>&1 2>&1; echo rc=$? >&2; test -e /data/marker; echo e=$? >&2',
      '',
      '1: Bad file descriptor\nrc=1\ne=1\n',
      0,
    ],
    [
      'exec 1>&-; touch /data/marker 1>&1 2>&1; echo rc=$? >&2; test -e /data/marker; echo e=$? >&2',
      '',
      '1: Bad file descriptor\nrc=1\ne=1\n',
      0,
    ],
    [
      'touch /data/marker 1>&- 1>&1 >/data/f 2>&1; echo rc=$? >&2; test -e /data/marker; echo e=$? >&2',
      '',
      'rc=0\ne=0\n',
      0,
    ],
    ['echo x 2>&0 1>&2', '', '', 1],
    ['echo x 0>&1 1>&0', 'x\n', '', 0],
    ['echo x 1>&0 0>&1', '', 'echo: write error: Bad file descriptor\n', 1],
    ['echo x 1>&0 2>&1', '', '', 1],
    // A dup from a descriptor closed earlier on the line refuses the
    // line, and the command never runs; a self-dup stays a no-op.
    ['touch /data/marker 0<&- 1<&0; test -e /data/marker', '', '0: Bad file descriptor\n', 1],
    ['echo hi 1>&- 2>&1', '', '1: Bad file descriptor\n', 1],
    ['cat 0<&- 0<&0 </data/a.txt', 'a', '', 0],
    // `>&word` on a descriptor other than 1 is bash's ambiguous redirect,
    // refused before the command runs; bare and on 1 it is the both-streams
    // file.
    [
      'touch /data/marker 3>&/data/foo; test -e /data/marker || test -e /data/foo',
      '',
      '/data/foo: ambiguous redirect\n',
      1,
    ],
    ['echo x 2>&/data/foo; test -e /data/foo', '', '/data/foo: ambiguous redirect\n', 1],
    ['( echo out; echo err >&2 ) 1>&/data/both; cat /data/both', 'out\nerr\n', '', 0],
    // An output redirect leaves its descriptor write-only.
    ['cat 1>/data/out 0<&1; wc -c < /data/out', '0\n', 'cat: -: Bad file descriptor\n', 0],
    ['echo x 1>&0 2>/data/err; cat /data/err', 'echo: write error: Bad file descriptor\n', '', 0],
    ['echo x 0>/data/out 1>&0; cat /data/out', 'x\n', '', 0],
    ['cat </data/a.txt 1<&0 0<&1 1>/data/out; cat /data/out', 'a', '', 0],
    // bash 5.2: stdout is open for writing only, so the read fails.
    ['cat </data/a.txt 0<&1', '', 'cat: -: Bad file descriptor\n', 1],
    // A descriptor `exec` closed for the shell refuses a dup from it too;
    // a redirect that opens it or a rebinding takes it back.
    [
      'exec 1>&-; touch /data/marker 2>&1; echo rc=$? >&2; test -e /data/marker; echo e=$? >&2',
      '',
      '1: Bad file descriptor\nrc=1\ne=1\n',
      0,
    ],
    [
      'exec 0<&-; touch /data/marker 1<&0; echo rc=$? >&2; test -e /data/marker; echo e=$? >&2',
      '',
      '0: Bad file descriptor\nrc=1\ne=1\n',
      0,
    ],
    ['exec 1>&-; true 1>&1; echo rc=$? >&2', '', 'rc=0\n', 0],
    [
      'exec 1>&-; touch /data/marker >/data/f 2>&1; echo rc=$? >&2; test -e /data/marker; echo e=$? >&2',
      '',
      'rc=0\ne=0\n',
      0,
    ],
    [
      'exec 1>&-; exec 1>&2; touch /data/marker 2>&1; echo rc=$?; test -e /data/marker; echo e=$?',
      '',
      'rc=0\ne=0\n',
      0,
    ],
    ['exec 2>&-; touch /data/marker 1>&2; test -e /data/marker; echo e=$?', 'e=1\n', '', 0],
  ])('tracks direction and order: %s', async (line, out, err, code) => {
    const { ws } = await makeIntegrationWS({ 'a.txt': 'a' })
    try {
      expect(await runResult(ws, line)).toEqual([code, out, err])
    } finally {
      await ws.close()
    }
  })
})

it('opens a standard descriptor in the other direction', async () => {
  // bash accepts `exec 0>f` (fd 0 write-only: a read is EBADF) and `exec
  // 1<f` / `exec 2<f` (the stream read-only: a write fails), pinned on
  // 5.2; the file itself stays what the redirect made it.
  const { ws } = await makeIntegrationWS({ input: 'original\n', source: 'readable\n' })
  try {
    const zero = await ws.execute(
      '( exec 0>/data/input; echo rc=$?; cat; echo rc=$?; read v; echo rc=$? )',
    )
    expect(zero.stdoutText).toBe('rc=0\nrc=1\nrc=1\n')
    expect(zero.stderrText).toContain('cat: -: Bad file descriptor')
    expect((await ws.execute('cat /data/input')).stdoutText).toBe('')
    const one = await ws.execute('( exec 1</data/source; echo hi; echo rc=$? >&2 )')
    expect(one.stdoutText).toBe('')
    expect(one.stderrText).toBe('echo: write error: Bad file descriptor\nrc=1\n')
    const two = await ws.execute('( exec 2</data/source; echo hi >&2; echo rc=$? )')
    expect(two.stdoutText).toBe('rc=1\n')
  } finally {
    await ws.close()
  }
})

it('persists an explicit stdin file redirect', async () => {
  const { ws } = await makeIntegrationWS({ input: 'readable\n' })
  try {
    await ws.execute('exec 0</data/input')
    expect((await ws.execute('read value; echo $value')).stdoutText).toBe('readable\n')
  } finally {
    await ws.close()
  }
})

describe('descriptor identities survive dups', () => {
  // bash 5.2 on debian:stable-slim with stdin from /dev/null: a stream
  // opened for reading keeps the file through a dup (`exec 1<f; exec 0<&1`)
  // and answers a transient `<&1`; fd 0 opened for writing takes a
  // transient `>&0`, appending as bash's shared offset does.
  it.each([
    ['printf x >/data/f; exec 1</data/f; exec 0<&1; cat >&2', '', 'x', 0],
    // A stream aliased onto stdin's read end reads what stdin reads, and
    // keeps the file a `exec <f` bound even after `exec 0<&-`.
    ['printf x >/data/f; exec </data/f; exec 1<&0; cat <&1 >&2; echo rc=$? >&2', '', 'xrc=0\n', 0],
    [
      'printf x >/data/f; exec </data/f; exec 1<&0; exec 0<&-; cat <&1 >&2; echo rc=$? >&2',
      '',
      'xrc=0\n',
      0,
    ],
    ['printf x >/data/f; exec </data/f; exec 2<&0; cat <&2 >&2', '', '', 1],
    ['printf x | { exec 1<&0; cat <&1 >&2; }; echo rc=$? >&2', '', 'xrc=0\n', 0],
    ['printf xy >/data/f; exec 1</data/f; exec 0<&1; exec 1>&-; cat >&2', '', 'xy', 0],
    ['printf x >/data/f; exec 1</data/f; exec 0<&1; exec 1>&2; cat', '', 'x', 0],
    ['printf x >/data/f; exec 2</data/f; exec 0<&2; cat >&2', '', '', 1],
    ['printf x >/data/f; exec 1</data/f; cat <&1 >&2; echo rc=$? >&2', '', 'xrc=0\n', 0],
    ['exec 0>/data/f; echo x >&0; echo y >&0; cat /data/f', 'x\ny\n', '', 0],
    ['exec 0>/data/f; { echo a; echo b; } >&0; cat /data/f', 'a\nb\n', '', 0],
    ['exec 0>/data/f; echo x >&0; exec 0<&-; cat /data/f', 'x\n', '', 0],
    ['exec 0>/data/f; echo x >&0; exec 1>&0; echo y; exec 1>&2; cat /data/f >&2', '', 'x\ny\n', 0],
    ['exec 0>/data/f; echo x 1>&0 2>&0; cat /data/f', 'x\n', '', 0],
    ['exec 0<&1; echo x >&0', 'x\n', '', 0],
    ['echo x >&0; echo rc=$?', 'rc=1\n', 'echo: write error: Bad file descriptor\n', 0],
  ])('%s', async (line, out, err, code) => {
    const { ws } = await makeIntegrationWS()
    try {
      expect(await runResult(ws, line)).toEqual([code, out, err])
    } finally {
      await ws.close()
    }
  })
})
