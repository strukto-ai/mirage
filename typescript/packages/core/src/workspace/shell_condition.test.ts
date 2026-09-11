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

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { IOResult } from '../io/types.ts'
import type { FileStat } from '../types.ts'
import { ContentType, FileType } from '../types.ts'
import { handleTest } from './executor/builtins/condition/index.ts'
import type { DispatchFn } from './executor/cross_mount.ts'
import type { Namespace } from './mount/namespace/namespace.ts'
import type { Session } from './session/session.ts'
import type { Workspace } from './workspace/workspace.ts'
import { makeIntegrationWS, run, runExit, runResult } from './fixtures/integration_fixture.ts'

let ws: Workspace

beforeAll(async () => {
  ws = (await makeIntegrationWS({ 'plain.txt': 'apple\nbanana\n' })).ws
  await ws.execute('mkdir -p /data/sub')
  await ws.execute("printf '' > /data/empty.txt")
})

afterAll(async () => {
  await ws.close()
})

describe('test/[ file operators', () => {
  it.each([
    ['[ -e /data/plain.txt ]', 0],
    ['[ -e /data/sub ]', 0],
    ['[ -e /data/nope ]', 1],
    ['[ -s /data/plain.txt ]', 0],
    ['[ -s /data/empty.txt ]', 1],
    ['[ -s /data/nope ]', 1],
    ['[ -f /data/plain.txt ]', 0],
    ['[ -f /data/sub ]', 1],
    ['[ -d /data/sub ]', 0],
    ['[ -d /data/plain.txt ]', 1],
    ['[ -r /data/plain.txt ]', 0],
    ['[ -w /data/plain.txt ]', 0],
    ['[ -x /data/plain.txt ]', 1],
    ['[ -x /data/sub ]', 0],
    ['[ -r /data/nope ]', 1],
  ])('%s -> %i', async (cmd, rc) => {
    expect(await runExit(ws, cmd)).toBe(rc)
  })

  it('-x true after chmod', async () => {
    await ws.execute('chmod +x /data/plain.txt')
    expect(await runExit(ws, '[ -x /data/plain.txt ]')).toBe(0)
  })

  it('-L on links, files, and dangling links', async () => {
    await ws.execute('ln -s /data/plain.txt /data/zl && ln -s /data/nope /data/zd')
    expect(await runExit(ws, '[ -L /data/zl ]')).toBe(0)
    expect(await runExit(ws, '[ -h /data/zl ]')).toBe(0)
    expect(await runExit(ws, '[ -L /data/plain.txt ]')).toBe(1)
    expect(await runExit(ws, '[ -L /data/zd ]')).toBe(0)
    expect(await runExit(ws, '[ -e /data/zd ]')).toBe(1)
  })
})

describe('test/[ arity, combinators, errors', () => {
  it.each([
    ['[ a = a ]', 0],
    ['[ a = b ]', 1],
    ['[ a == a ]', 0],
    ['[ a != b ]', 0],
    ['[ abc = a* ]', 1],
    ['[ 1 -eq 1 ]', 0],
    ['[ 010 -eq 10 ]', 0],
    ['[ -1 -lt 0 ]', 0],
    ['[ -n x -a -n y ]', 0],
    ['[ -n x -a -z x ]', 1],
    ['[ -z x -o -n y ]', 0],
    ['[ -z x -o -z y ]', 1],
    ['[ -z x -o -n x -a -z y ]', 1],
    ['[ a = a -a b = b ]', 0],
    ['[ a = a -a b = c ]', 1],
    ['[ ! -e /data/nope ]', 0],
    ['[ ! a = a ]', 1],
    ["[ ! '' ]", 0],
    ['[ hello ]', 0],
    ["[ '' ]", 1],
    ['[ ]', 1],
    ['[ -e ]', 0],
    ['test hello', 0],
    ['test', 1],
  ])('%s -> %i', async (cmd, rc) => {
    expect(await runExit(ws, cmd)).toBe(rc)
  })

  it.each([
    ['[ x -bogus y ]', '[: -bogus: binary operator expected'],
    ['[ -bogus x ]', '[: -bogus: unary operator expected'],
    ['[ a = b c ]', '[: too many arguments'],
    ['[ x -eq 1 ]', '[: x: integer expression expected'],
    ['[ 1 -eq x ]', '[: x: integer expression expected'],
    ['test x -eq 1', 'test: x: integer expression expected'],
  ])('%s errors with %s', async (cmd, message) => {
    const [rc, , stderr] = await runResult(ws, cmd)
    expect(rc).toBe(2)
    expect(stderr).toContain(message)
  })

  it('unsupported operator fails loudly', async () => {
    const [rc, , stderr] = await runResult(ws, '[ -p /data/plain.txt ]')
    expect(rc).toBe(2)
    expect(stderr).toContain('[: -p: unsupported operator')
  })
})

describe('[[ ]] semantics', () => {
  it.each([
    ['[[ abc == a* ]]', 0],
    ['[[ abc == b* ]]', 1],
    ["[[ abc == 'a*' ]]", 1],
    ["[[ 'a*' == 'a*' ]]", 0],
    ['[[ ab == a? ]]', 0],
    ['[[ abc == a? ]]', 1],
    ['[[ abc == [ab]* ]]', 0],
    ['[[ abc != a* ]]', 1],
    ['[[ abc != b* ]]', 0],
    ['[[ abc =~ ^a.c$ ]]', 0],
    ['[[ abc =~ b ]]', 0],
    ['[[ abc =~ ^b ]]', 1],
    ["[[ 'ab cd' =~ 'b c' ]]", 0],
    ["[[ axc =~ 'a.c' ]]", 1],
    ['[[ -n x && -n y ]]', 0],
    ['[[ -n x && -z x ]]', 1],
    ['[[ -z x || -n y ]]', 0],
    ['[[ ! -n x ]]', 1],
    ['[[ ( -z x || -n y ) && -n z ]]', 0],
    ['[[ a < b ]]', 0],
    ['[[ b < a ]]', 1],
    ['[[ b > a ]]', 0],
    ['[[ 1 -lt 2 ]]', 0],
    ['[[ 1+1 -eq 2 ]]', 0],
    ['[[ zqx9 -eq 0 ]]', 0],
    ['[[ -e /data/plain.txt ]]', 0],
    ['[[ -f /data/sub ]]', 1],
  ])('%s -> %i', async (cmd, rc) => {
    expect(await runExit(ws, cmd)).toBe(rc)
  })

  it('unquoted variable RHS is a pattern, quoted is literal', async () => {
    expect(await run(ws, 'p=\'a*\'; [[ abc == $p ]]; echo $?; [[ abc == "$p" ]]; echo $?')).toBe(
      '0\n1\n',
    )
  })

  it('numeric operands evaluate as arithmetic', async () => {
    expect(await run(ws, 'n=3; [[ n -eq 3 ]]; echo $?')).toBe('0\n')
  })

  it('no word splitting of unquoted expansions', async () => {
    expect(await run(ws, "v='a b'; [[ $v == 'a b' ]]; echo $?")).toBe('0\n')
  })

  it('single-bracket word-splits the same expansion', async () => {
    const [rc, stdout, stderr] = await runResult(ws, "v='a b'; [ $v = 'a b' ]; echo $?")
    expect(rc).toBe(0)
    expect(stdout).toBe('2\n')
    expect(stderr).toContain('too many arguments')
  })

  it('=~ fills BASH_REMATCH', async () => {
    expect(await run(ws, '[[ abc =~ b. ]] && echo m:${BASH_REMATCH[0]}')).toBe('m:bc\n')
  })

  it('a bad [[ operator kills the whole line', async () => {
    const [rc, stdout, stderr] = await runResult(ws, '[[ a -bogus b ]]; echo after')
    expect(rc).toBe(2)
    expect(stdout).toBe('')
    expect(stderr).toContain('conditional binary operator expected')
  })

  it('if integration', async () => {
    expect(await run(ws, 'if [ -e /data/plain.txt ]; then echo yes; else echo no; fi')).toBe(
      'yes\n',
    )
    expect(await run(ws, 'if [[ plain.txt == *.txt ]]; then echo yes; fi')).toBe('yes\n')
  })
})

const stubNamespace = {
  symlinkTargets: () => new Map<string, string>(),
  isLink: () => false,
} as unknown as Namespace

const stubSession = { cwd: '/data', env: {}, arrays: {} } as unknown as Session

/**
 * Mimics a prefix store (s3/gridfs/hf/nextcloud): stat never sees
 * directories and readdir answers a missing path with a listing
 * instead of raising.
 */
function prefixStoreDispatch(listing: string[]): DispatchFn {
  const dispatch = (op: string) => {
    if (op === 'stat') {
      return Promise.reject(Object.assign(new Error('not found'), { code: 'ENOENT' }))
    }
    if (op === 'readdir') return Promise.resolve([listing, new IOResult({})])
    return Promise.reject(new Error(`unexpected op ${op}`))
  }
  return dispatch as unknown as DispatchFn
}

/**
 * Mimics an API backend (dropbox/gdrive/box) whose stat reports
 * size-unknown for a regular file.
 */
function unknownSizeDispatch(content: Uint8Array): DispatchFn {
  const stat = {
    name: 'x',
    size: null,
    type: FileType.FILE,
    content: ContentType.TEXT,
    mode: null,
  } as unknown as FileStat
  const dispatch = (op: string) => {
    if (op === 'stat') return Promise.resolve([stat, new IOResult({})])
    if (op === 'read') return Promise.resolve([content, new IOResult({})])
    return Promise.reject(new Error(`unexpected op ${op}`))
  }
  return dispatch as unknown as DispatchFn
}

async function stubExit(dispatch: DispatchFn, argv: string[]): Promise<number> {
  const [, io] = await handleTest(dispatch, stubNamespace, argv, stubSession)
  return io.exitCode
}

describe('cloud-backend stat/readdir shapes', () => {
  it('-e/-d/-s are false when a prefix store lists a missing path as []', async () => {
    const dispatch = prefixStoreDispatch([])
    expect(await stubExit(dispatch, ['-e', '/data/znope'])).toBe(1)
    expect(await stubExit(dispatch, ['-d', '/data/znope'])).toBe(1)
    expect(await stubExit(dispatch, ['-s', '/data/znope'])).toBe(1)
  })

  it('-e/-d are true when the readdir probe lists entries', async () => {
    const dispatch = prefixStoreDispatch(['a.txt'])
    expect(await stubExit(dispatch, ['-e', '/data/sub'])).toBe(0)
    expect(await stubExit(dispatch, ['-d', '/data/sub'])).toBe(0)
  })

  it('-s reads content when stat reports size-unknown', async () => {
    expect(await stubExit(unknownSizeDispatch(new Uint8Array(0)), ['-s', '/data/zte.txt'])).toBe(1)
    expect(await stubExit(unknownSizeDispatch(new Uint8Array([120])), ['-s', '/data/zt.txt'])).toBe(
      0,
    )
  })

  it('-e/-f answer from stat alone without reading', async () => {
    const dispatch = unknownSizeDispatch(new Uint8Array(0))
    expect(await stubExit(dispatch, ['-e', '/data/zte.txt'])).toBe(0)
    expect(await stubExit(dispatch, ['-f', '/data/zte.txt'])).toBe(0)
  })
})
