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

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { beforeAll, describe, expect, it } from 'vitest'
import { OpsRegistry } from '../ops/registry.ts'
import { RAMResource } from '../resource/ram/ram.ts'
import { createShellParser, type ShellParser } from '../shell/parse.ts'
import { MountMode } from '../types.ts'
import { Workspace } from './workspace.ts'

const require = createRequire(import.meta.url)
const engineWasm = readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))

let parser: ShellParser

beforeAll(async () => {
  parser = await createShellParser({ engineWasm, grammarWasm })
})

function buildWorkspace(): { ws: Workspace; ram: RAMResource } {
  const ram = new RAMResource()
  const registry = new OpsRegistry()
  registry.registerResource(ram)
  const ws = new Workspace(
    { '/ram': ram },
    { mode: MountMode.WRITE, ops: registry, shellParser: parser },
  )
  return { ws, ram }
}

describe('Workspace.execute', () => {
  it('runs the `true` shell builtin with exit 0', async () => {
    const { ws } = buildWorkspace()
    const res = await ws.execute('true')
    expect(res.exitCode).toBe(0)
    expect(new TextDecoder().decode(res.stdout)).toBe('')
    await ws.close()
  })

  it('runs the `false` shell builtin with exit 1', async () => {
    const { ws } = buildWorkspace()
    const res = await ws.execute('false')
    expect(res.exitCode).toBe(1)
    await ws.close()
  })

  it('runs `pwd` and prints /', async () => {
    const { ws } = buildWorkspace()
    const res = await ws.execute('pwd')
    expect(res.exitCode).toBe(0)
    expect(new TextDecoder().decode(res.stdout)).toBe('/\n')
    await ws.close()
  })

  it('runs `echo hello` and prints hello', async () => {
    const { ws } = buildWorkspace()
    const res = await ws.execute('echo hello')
    expect(res.exitCode).toBe(0)
    expect(new TextDecoder().decode(res.stdout)).toBe('hello\n')
    await ws.close()
  })

  it('chains commands with &&', async () => {
    const { ws } = buildWorkspace()
    const res = await ws.execute('true && echo ok')
    expect(res.exitCode).toBe(0)
    expect(new TextDecoder().decode(res.stdout)).toBe('ok\n')
    await ws.close()
  })

  it('short-circuits on && after a non-zero exit', async () => {
    const { ws } = buildWorkspace()
    const res = await ws.execute('false && echo skipped')
    expect(res.exitCode).toBe(1)
    expect(new TextDecoder().decode(res.stdout)).toBe('')
    await ws.close()
  })

  it('chains commands with || on failure', async () => {
    const { ws } = buildWorkspace()
    const res = await ws.execute('false || echo recovered')
    expect(res.exitCode).toBe(0)
    expect(new TextDecoder().decode(res.stdout)).toBe('recovered\n')
    await ws.close()
  })

  it('runs `cat` against a file on RAM mount', async () => {
    const { ws, ram } = buildWorkspace()
    ram.store.files.set('/x.txt', new TextEncoder().encode('hello world'))
    const res = await ws.execute('cat /ram/x.txt')
    expect(res.exitCode).toBe(0)
    expect(new TextDecoder().decode(res.stdout)).toBe('hello world')
    await ws.close()
  })

  it('runs `cat` on multiple files and concatenates', async () => {
    const { ws, ram } = buildWorkspace()
    ram.store.files.set('/a.txt', new TextEncoder().encode('aa\n'))
    ram.store.files.set('/b.txt', new TextEncoder().encode('bb\n'))
    const res = await ws.execute('cat /ram/a.txt /ram/b.txt')
    expect(new TextDecoder().decode(res.stdout)).toBe('aa\nbb\n')
    await ws.close()
  })

  it('runs `head -n 1`', async () => {
    const { ws, ram } = buildWorkspace()
    ram.store.files.set('/x.txt', new TextEncoder().encode('line1\nline2\nline3\n'))
    const res = await ws.execute('head -n 1 /ram/x.txt')
    expect(new TextDecoder().decode(res.stdout)).toBe('line1\n')
    await ws.close()
  })

  it('runs `tail -n 1`', async () => {
    const { ws, ram } = buildWorkspace()
    ram.store.files.set('/x.txt', new TextEncoder().encode('line1\nline2\nline3\n'))
    const res = await ws.execute('tail -n 1 /ram/x.txt')
    expect(new TextDecoder().decode(res.stdout)).toBe('line3\n')
    await ws.close()
  })

  it('runs `wc -l` on a file', async () => {
    const { ws, ram } = buildWorkspace()
    ram.store.files.set('/x.txt', new TextEncoder().encode('a\nb\nc\n'))
    const res = await ws.execute('wc -l /ram/x.txt')
    expect(res.exitCode).toBe(0)
    expect(new TextDecoder().decode(res.stdout)).toMatch(/^3 /)
    await ws.close()
  })

  it('runs `stat` on a file', async () => {
    const { ws, ram } = buildWorkspace()
    ram.store.files.set('/x.txt', new TextEncoder().encode('abc'))
    const res = await ws.execute('stat /ram/x.txt')
    expect(res.exitCode).toBe(0)
    expect(new TextDecoder().decode(res.stdout)).toMatch(/name=x\.txt size=3/)
    await ws.close()
  })

  it('runs `ls` on a directory', async () => {
    const { ws, ram } = buildWorkspace()
    ram.store.files.set('/a.txt', new Uint8Array([1]))
    ram.store.files.set('/b.txt', new Uint8Array([2]))
    const res = await ws.execute('ls /ram/')
    expect(res.exitCode).toBe(0)
    expect(new TextDecoder().decode(res.stdout)).toBe('a.txt\nb.txt\n')
    await ws.close()
  })

  it('pipes cat into wc', async () => {
    const { ws, ram } = buildWorkspace()
    ram.store.files.set('/x.txt', new TextEncoder().encode('a\nb\n'))
    const res = await ws.execute('cat /ram/x.txt | wc -l')
    expect(res.exitCode).toBe(0)
    expect(new TextDecoder().decode(res.stdout)).toMatch(/^2/)
    await ws.close()
  })

  it('throws when shellParser is missing', async () => {
    const ram = new RAMResource()
    const registry = new OpsRegistry()
    registry.registerResource(ram)
    const ws = new Workspace({ '/ram': ram }, { mode: MountMode.READ, ops: registry })
    await expect(ws.execute('true')).rejects.toThrow(/shellParser/)
    await ws.close()
  })
})

describe('argv dispatch regressions', () => {
  it('timeout keeps a quoted word as one argument', async () => {
    const { ws } = buildWorkspace()
    const res = await ws.execute("timeout 5 echo 'a  b'")
    expect(new TextDecoder().decode(res.stdout)).toBe('a  b\n')
    await ws.close()
  })

  it('xargs keeps initial args before stdin words (GNU)', async () => {
    const { ws } = buildWorkspace()
    const res = await ws.execute('echo c | xargs echo a b')
    expect(new TextDecoder().decode(res.stdout)).toBe('a b c\n')
    await ws.close()
  })

  it('xargs input words stay literal argv tokens', async () => {
    const { ws } = buildWorkspace()
    const res = await ws.execute("echo '$(echo pwned)' | xargs echo")
    expect(new TextDecoder().decode(res.stdout)).toBe('$(echo pwned)\n')
    await ws.close()
  })

  it('xargs survives a quote character in input', async () => {
    const { ws } = buildWorkspace()
    const res = await ws.execute('echo "don\'t" | xargs echo')
    expect(new TextDecoder().decode(res.stdout)).toBe("don't\n")
    await ws.close()
  })

  it('runs a command named by a variable', async () => {
    const { ws } = buildWorkspace()
    const res = await ws.execute('E=echo; $E hi')
    expect(new TextDecoder().decode(res.stdout)).toBe('hi\n')
    expect(res.exitCode).toBe(0)
    await ws.close()
  })

  it('runs a quoted command name', async () => {
    const { ws } = buildWorkspace()
    const res = await ws.execute('"echo" hi')
    expect(new TextDecoder().decode(res.stdout)).toBe('hi\n')
    await ws.close()
  })
})
