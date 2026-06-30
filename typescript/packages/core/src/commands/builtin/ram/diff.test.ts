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

import { RAM_COMMANDS } from './index.ts'
import { describe, expect, it } from 'vitest'
import { materialize } from '../../../io/types.ts'
import { RAMResource } from '../../../resource/ram/ram.ts'
import { PathSpec } from '../../../types.ts'
const RAM_DIFF = RAM_COMMANDS.filter((c) => c.name === 'diff' && c.filetype == null)

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function runDiff(
  resource: RAMResource,
  paths: PathSpec[],
  flags: Record<string, string | boolean | string[]> = {},
): Promise<{ out: string; exitCode: number }> {
  const cmd = RAM_DIFF[0]
  if (cmd === undefined) throw new Error('diff not registered')
  const result = await cmd.fn((resource as { accessor?: unknown }).accessor as never, paths, [], {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
    resource,
  })
  if (result === null) return { out: '', exitCode: -1 }
  const [out, ioResult] = result
  const buf =
    out === null
      ? new Uint8Array()
      : out instanceof Uint8Array
        ? out
        : await materialize(out as AsyncIterable<Uint8Array>)
  return { out: DEC.decode(buf), exitCode: ioResult.exitCode }
}

describe('diff', () => {
  it('identical files produce empty output and exit 0', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/a.txt', ENC.encode('hello\nworld\n'))
    resource.store.files.set('/tmp/b.txt', ENC.encode('hello\nworld\n'))
    const r = await runDiff(resource, [
      PathSpec.fromStrPath('/tmp/a.txt'),
      PathSpec.fromStrPath('/tmp/b.txt'),
    ])
    expect(r.exitCode).toBe(0)
    expect(r.out).toBe('')
  })

  it('identical empty files produce empty output', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/a.txt', new Uint8Array())
    resource.store.files.set('/tmp/b.txt', new Uint8Array())
    const r = await runDiff(resource, [
      PathSpec.fromStrPath('/tmp/a.txt'),
      PathSpec.fromStrPath('/tmp/b.txt'),
    ])
    expect(r.exitCode).toBe(0)
    expect(r.out).toBe('')
  })

  it('different files show < / > lines (normal diff)', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/a.txt', ENC.encode('hello\n'))
    resource.store.files.set('/tmp/b.txt', ENC.encode('world\n'))
    const r = await runDiff(resource, [
      PathSpec.fromStrPath('/tmp/a.txt'),
      PathSpec.fromStrPath('/tmp/b.txt'),
    ])
    expect(r.exitCode).toBe(1)
    expect(r.out).toContain('< hello')
    expect(r.out).toContain('> world')
  })

  it('-i makes case-different files identical', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/a.txt', ENC.encode('Hello\n'))
    resource.store.files.set('/tmp/b.txt', ENC.encode('hello\n'))
    const r = await runDiff(
      resource,
      [PathSpec.fromStrPath('/tmp/a.txt'), PathSpec.fromStrPath('/tmp/b.txt')],
      { i: true },
    )
    expect(r.exitCode).toBe(0)
    expect(r.out).toBe('')
  })

  it('without -i case-different files show diff', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/a.txt', ENC.encode('Hello\n'))
    resource.store.files.set('/tmp/b.txt', ENC.encode('hello\n'))
    const r = await runDiff(resource, [
      PathSpec.fromStrPath('/tmp/a.txt'),
      PathSpec.fromStrPath('/tmp/b.txt'),
    ])
    expect(r.exitCode).toBe(1)
    expect(r.out.length).toBeGreaterThan(0)
  })

  it('-w ignores whitespace', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/a.txt', ENC.encode('hello world\n'))
    resource.store.files.set('/tmp/b.txt', ENC.encode('helloworld\n'))
    const r = await runDiff(
      resource,
      [PathSpec.fromStrPath('/tmp/a.txt'), PathSpec.fromStrPath('/tmp/b.txt')],
      { w: true },
    )
    expect(r.exitCode).toBe(0)
    expect(r.out).toBe('')
  })

  it('-b treats multiple spaces as equal', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/a.txt', ENC.encode('hello  world\n'))
    resource.store.files.set('/tmp/b.txt', ENC.encode('hello world\n'))
    const r = await runDiff(
      resource,
      [PathSpec.fromStrPath('/tmp/a.txt'), PathSpec.fromStrPath('/tmp/b.txt')],
      { b: true },
    )
    expect(r.exitCode).toBe(0)
    expect(r.out).toBe('')
  })

  it('-q reports files differ briefly', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/a.txt', ENC.encode('hello\n'))
    resource.store.files.set('/tmp/b.txt', ENC.encode('world\n'))
    const r = await runDiff(
      resource,
      [PathSpec.fromStrPath('/tmp/a.txt'), PathSpec.fromStrPath('/tmp/b.txt')],
      { q: true },
    )
    expect(r.exitCode).toBe(1)
    expect(r.out).toContain('/tmp/a.txt')
    expect(r.out).toContain('/tmp/b.txt')
    expect(r.out).toContain('differ')
  })

  it('missing second path returns exit code 2', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/a.txt', ENC.encode('hello\n'))
    const r = await runDiff(resource, [PathSpec.fromStrPath('/tmp/a.txt')])
    expect(r.exitCode).toBe(2)
  })

  it('-u uses GNU single-line hunk header (@@ -1 +1 @@)', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/a.txt', ENC.encode('hello\n'))
    resource.store.files.set('/tmp/b.txt', ENC.encode('world\n'))
    const r = await runDiff(
      resource,
      [PathSpec.fromStrPath('/tmp/a.txt'), PathSpec.fromStrPath('/tmp/b.txt')],
      { u: true },
    )
    expect(r.exitCode).toBe(1)
    expect(r.out).toContain('@@ -1 +1 @@')
  })
})
