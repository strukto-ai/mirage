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

import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { isModulePath, loadAttr, splitRef } from './loader.ts'

const LOADER = pathToFileURL(resolve(fileURLToPath(import.meta.url), '..', 'loader.ts')).href

// Vitest imports a `.ts` file through Vite's transform, which compiles
// what Node only strips, so an in-process test cannot see the strip-only
// cliff at all (an `enum` simply works). These cases therefore run in a
// child node, which is the loader consumers actually get. The spawn is
// async on purpose: a blocking spawnSync freezes the vitest worker's
// event loop past the 60s birpc timeout on a slow runner.
function loadInNode(ref: string): Promise<string> {
  const script =
    `import {loadAttr} from ${JSON.stringify(LOADER)}\n` +
    `loadAttr(${JSON.stringify(ref)}).then(\n` +
    `  (v) => console.log('OK ' + JSON.stringify(v)),\n` +
    `  (e) => console.log('ERR ' + e.message),\n` +
    `)\n`
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script])
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()))
    child.stderr.on('data', () => undefined)
    child.on('error', fail)
    child.on('close', () => {
      done(out.trim())
    })
  })
}

// Each case imports a distinct filename: Node's ESM loader caches by URL,
// so reusing one name across tests would serve the first body every time.
let dir = ''

function write(name: string, body: string): string {
  if (dir === '') dir = mkdtempSync(join(tmpdir(), 'mirage-loader-'))
  const path = join(dir, name)
  writeFileSync(path, body)
  return path
}

afterEach(() => {
  dir = ''
})

describe('splitRef', () => {
  it('splits on the last colon', () => {
    expect(splitRef('./a/b.mjs:TALLY')).toEqual(['./a/b.mjs', 'TALLY'])
    expect(splitRef('pkg/sub:NAME')).toEqual(['pkg/sub', 'NAME'])
  })

  it('refuses a ref with no colon', () => {
    expect(() => splitRef('./a/b.mjs')).toThrow(/expected 'source:ExportName'/)
  })
})

describe('isModulePath', () => {
  it('reads a path separator or a module suffix as a file', () => {
    expect(isModulePath('./tool.mjs')).toBe(true)
    expect(isModulePath('tool.mjs')).toBe(true)
    expect(isModulePath('tool.ts')).toBe(true)
    expect(isModulePath('tool.js')).toBe(true)
    expect(isModulePath('my-clis/specs')).toBe(true)
  })

  it('reads a bare package specifier as a specifier', () => {
    expect(isModulePath('my-clis')).toBe(false)
  })
})

describe('loadAttr', () => {
  it('loads a named export from an .mjs file', async () => {
    const path = write('esm.mjs', 'export const TALLY = {kind: "mjs"}\n')
    await expect(loadAttr(`${path}:TALLY`)).resolves.toEqual({ kind: 'mjs' })
  })

  it('loads a named export from a .ts file through Node type stripping', async () => {
    const path = write('typed.ts', 'export const TALLY: {kind: string} = {kind: "ts"}\n')
    await expect(loadAttr(`${path}:TALLY`)).resolves.toEqual({ kind: 'ts' })
  })

  it('loads a named export from an ESM .js file', async () => {
    const path = write('esm.js', 'export const TALLY = {kind: "js"}\n')
    await expect(loadAttr(`${path}:TALLY`)).resolves.toEqual({ kind: 'js' })
  })

  // cjs-module-lexer misses some assignment shapes, so a CommonJS file
  // has to resolve through `default` as well as through named exports.
  it('loads through default when the file is CommonJS', async () => {
    const path = write('cjs.cjs', 'module.exports = { TALLY: {kind: "cjs"} }\n')
    await expect(loadAttr(`${path}:TALLY`)).resolves.toEqual({ kind: 'cjs' })
  })

  it('reports a missing file as a load failure', async () => {
    await expect(loadAttr('/nonexistent/path.mjs:TALLY')).rejects.toThrow(/cannot load script/)
  })

  it('reports a missing export by name', async () => {
    const path = write('other.mjs', 'export const OTHER = 1\n')
    await expect(loadAttr(`${path}:TALLY`)).rejects.toThrow(/"TALLY" not found in/)
  })

  it('refuses a ref with no colon', async () => {
    await expect(loadAttr('./tool.mjs')).rejects.toThrow(/expected 'source:ExportName'/)
  })
})

describe('loadAttr under a real node', () => {
  it('strips types off a .ts file', async () => {
    const path = write('node_typed.ts', 'export const TALLY: {kind: string} = {kind: "ts"}\n')
    await expect(loadInNode(`${path}:TALLY`)).resolves.toBe('OK {"kind":"ts"}')
  })

  // Node strips types without compiling them, so a construct needing
  // codegen is refused at load. The hint is the whole point of the
  // reword: ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX alone reads as a mirage bug.
  it('adds a hint when node refuses TypeScript it can only strip', async () => {
    const path = write('node_enum.ts', 'enum K { A }\nexport const TALLY = {k: K.A}\n')
    const out = await loadInNode(`${path}:TALLY`)
    expect(out).toMatch(/^ERR cannot load script/)
    expect(out).toMatch(/ship it as \.mjs/)
  })

  it('loads an .mjs file with no caveats', async () => {
    const path = write('node_esm.mjs', 'export const TALLY = {kind: "mjs"}\n')
    await expect(loadInNode(`${path}:TALLY`)).resolves.toBe('OK {"kind":"mjs"}')
  })
})
