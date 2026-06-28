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

import { RAM_COMMANDS } from '../index.ts'
import { describe, expect, it } from 'vitest'
import { materialize } from '../../../../io/types.ts'
import { RAMResource } from '../../../../resource/ram/ram.ts'
import { PathSpec } from '../../../../types.ts'
const RAM_GREP = RAM_COMMANDS.filter((c) => c.name === 'grep' && c.filetype == null)

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function runGrep(
  resource: RAMResource,
  pattern: string,
  paths: PathSpec[],
  flags: Record<string, string | boolean | string[]> = {},
): Promise<{ text: string; exitCode: number }> {
  const cmd = RAM_GREP[0]
  if (cmd === undefined) throw new Error('grep not registered')
  const result = await cmd.fn(resource.accessor, paths, [pattern], {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
    resource,
  })
  if (result === null) return { text: '', exitCode: 0 }
  const [out, io] = result
  if (out === null) return { text: '', exitCode: io.exitCode }
  const buf = out instanceof Uint8Array ? out : await materialize(out as AsyncIterable<Uint8Array>)
  return { text: DEC.decode(buf), exitCode: io.exitCode }
}

describe('grep', () => {
  it('match found (files_only with -l)', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/a.txt', ENC.encode('hello world\nfoo bar\nhello again'))
    const { text } = await runGrep(resource, 'hello', [PathSpec.fromStrPath('/tmp/a.txt')], {
      args_l: true,
    })
    expect(text).toBe('/tmp/a.txt\n')
  })

  it('no match returns exitCode 1', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/a.txt', ENC.encode('hello world\nfoo bar'))
    const { text, exitCode } = await runGrep(resource, 'xyz', [PathSpec.fromStrPath('/tmp/a.txt')])
    expect(text).toBe('')
    expect(exitCode).toBe(1)
  })

  it('empty file returns no match', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/a.txt', new Uint8Array())
    const { text, exitCode } = await runGrep(resource, 'hello', [
      PathSpec.fromStrPath('/tmp/a.txt'),
    ])
    expect(text).toBe('')
    expect(exitCode).toBe(1)
  })

  it('-r on a single file prefixes the filename', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/log.txt', ENC.encode('one\nerror here\ntwo\nerror again\n'))
    const { text } = await runGrep(resource, 'error', [PathSpec.fromStrPath('/log.txt')], {
      r: true,
      n: true,
    })
    expect(text).toBe('/log.txt:2:error here\n/log.txt:4:error again\n')
  })

  it('-i ignore case matches', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/a.txt', ENC.encode('Hello World\nhello world\nHELLO'))
    const { text } = await runGrep(resource, 'hello', [PathSpec.fromStrPath('/tmp/a.txt')], {
      i: true,
      args_l: true,
    })
    expect(text).toBe('/tmp/a.txt\n')
  })

  it('-v invert match', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/a.txt', ENC.encode('hello\nworld\nhello again'))
    const { text } = await runGrep(resource, 'hello', [PathSpec.fromStrPath('/tmp/a.txt')], {
      v: true,
      args_l: true,
    })
    expect(text).toBe('/tmp/a.txt\n')
  })

  it('-c count only', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/a.txt', ENC.encode('foo\nbar\nfoo baz'))
    const { text } = await runGrep(resource, 'foo', [PathSpec.fromStrPath('/tmp/a.txt')], {
      c: true,
    })
    expect(text.trim()).toBe('2')
  })

  it('-n line numbers', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/a.txt', ENC.encode('x\nhello\ny'))
    const { text } = await runGrep(resource, 'hello', [PathSpec.fromStrPath('/tmp/a.txt')], {
      n: true,
    })
    expect(text.trim()).toBe('2:hello')
  })

  it('-F fixed string disables regex metachars', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/a.txt', ENC.encode('axb\na.b'))
    const { text } = await runGrep(resource, 'a.b', [PathSpec.fromStrPath('/tmp/a.txt')], {
      F: true,
    })
    expect(text.trim()).toBe('a.b')
  })

  it('-w whole word', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/a.txt', ENC.encode('foobar\nfoo bar'))
    const { text } = await runGrep(resource, 'foo', [PathSpec.fromStrPath('/tmp/a.txt')], {
      w: true,
    })
    expect(text.trim()).toBe('foo bar')
  })

  it('recursive mode (-r) searches all files under a directory', async () => {
    const resource = new RAMResource()
    resource.store.dirs.add('/tmp')
    resource.store.dirs.add('/tmp/sub')
    resource.store.files.set('/tmp/a.txt', ENC.encode('hello world\n'))
    resource.store.files.set('/tmp/sub/b.txt', ENC.encode('goodbye hello\n'))
    resource.store.files.set('/tmp/sub/c.txt', ENC.encode('nothing\n'))
    const { text } = await runGrep(resource, 'hello', [PathSpec.fromStrPath('/tmp')], { r: true })
    const lines = text.trim().split('\n').sort()
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('a.txt')
    expect(lines[1]).toContain('b.txt')
  })
})
