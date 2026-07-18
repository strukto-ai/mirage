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
import { FileStat, FileType } from '../../types.ts'
import { rgFull, type RgFullOptions } from './rg_helper.ts'

const ENC = new TextEncoder()

const FILES: Record<string, string> = {
  '/db/a.txt': 'Graph\nplain\nGraph again\n',
  '/db/b.txt': 'nothing here\n',
}

function readdirFn(path: string): Promise<string[]> {
  if (path === '/db') return Promise.resolve(['/db/a.txt', '/db/b.txt'])
  return Promise.reject(new Error(`not a dir: ${path}`))
}

function statFn(path: string): Promise<FileStat> {
  if (path === '/db') {
    return Promise.resolve(new FileStat({ name: 'db', type: FileType.DIRECTORY }))
  }
  const content = FILES[path]
  if (content === undefined) return Promise.reject(new Error(`ENOENT: ${path}`))
  const name = path.split('/').pop() ?? ''
  return Promise.resolve(new FileStat({ name, type: FileType.TEXT, size: content.length }))
}

function readBytesFn(path: string): Promise<Uint8Array> {
  const content = FILES[path]
  if (content === undefined) return Promise.reject(new Error(`ENOENT: ${path}`))
  return Promise.resolve(ENC.encode(content))
}

function opts(overrides: Partial<RgFullOptions> = {}): RgFullOptions {
  return {
    ignoreCase: false,
    invert: false,
    lineNumbers: false,
    countOnly: false,
    filesOnly: false,
    fixedString: false,
    onlyMatching: false,
    maxCount: null,
    wholeWord: false,
    contextBefore: 0,
    contextAfter: 0,
    fileType: null,
    globPattern: null,
    hidden: false,
    ...overrides,
  }
}

describe('rgFull countOnly', () => {
  it('prints path:count per matching file and omits zero-count files', async () => {
    const out = await rgFull(
      readdirFn,
      statFn,
      readBytesFn,
      '/db',
      'Graph',
      opts({ countOnly: true }),
      null,
    )
    expect(out).toEqual(['/db/a.txt:2'])
  })

  it('prints a bare count for a single file with matches', async () => {
    const out = await rgFull(
      readdirFn,
      statFn,
      readBytesFn,
      '/db/a.txt',
      'Graph',
      opts({ countOnly: true }),
      null,
    )
    expect(out).toEqual(['2'])
  })

  it('returns nothing for a single file without matches', async () => {
    const out = await rgFull(
      readdirFn,
      statFn,
      readBytesFn,
      '/db/b.txt',
      'Graph',
      opts({ countOnly: true }),
      null,
    )
    expect(out).toEqual([])
  })

  it('still prefixes content matches with the file path in directory walks', async () => {
    const out = await rgFull(readdirFn, statFn, readBytesFn, '/db', 'Graph', opts(), null)
    expect(out).toEqual(['/db/a.txt:Graph', '/db/a.txt:Graph again'])
  })
})

const LOG_FILES: Record<string, string> = {
  '/log/app.log':
    'error: disk full\nwarning: low memory\ninfo: all good\nerror: timeout\nnote: done\n',
  '/log/far.txt': 'hit\na\nb\nc\nhit\n',
}

function logReaddirFn(path: string): Promise<string[]> {
  if (path === '/log') return Promise.resolve(['/log/app.log', '/log/far.txt'])
  return Promise.reject(new Error(`not a dir: ${path}`))
}

function logStatFn(path: string): Promise<FileStat> {
  if (path === '/log') {
    return Promise.resolve(new FileStat({ name: 'log', type: FileType.DIRECTORY }))
  }
  const content = LOG_FILES[path]
  if (content === undefined) return Promise.reject(new Error(`ENOENT: ${path}`))
  const name = path.split('/').pop() ?? ''
  return Promise.resolve(new FileStat({ name, type: FileType.TEXT, size: content.length }))
}

function logReadBytesFn(path: string): Promise<Uint8Array> {
  const content = LOG_FILES[path]
  if (content === undefined) return Promise.reject(new Error(`ENOENT: ${path}`))
  return Promise.resolve(ENC.encode(content))
}

describe('rgFull single-file context', () => {
  it('renders after-context lines', async () => {
    const out = await rgFull(
      logReaddirFn,
      logStatFn,
      logReadBytesFn,
      '/log/app.log',
      'warning',
      opts({ contextAfter: 1 }),
      null,
    )
    expect(out).toEqual(['warning: low memory', 'info: all good'])
  })

  it('merges adjacent context groups without a separator', async () => {
    const out = await rgFull(
      logReaddirFn,
      logStatFn,
      logReadBytesFn,
      '/log/app.log',
      'error',
      opts({ contextBefore: 1, contextAfter: 1 }),
      null,
    )
    expect(out).toEqual([
      'error: disk full',
      'warning: low memory',
      'info: all good',
      'error: timeout',
      'note: done',
    ])
  })

  it('labels context lines with a dash under -n', async () => {
    const out = await rgFull(
      logReaddirFn,
      logStatFn,
      logReadBytesFn,
      '/log/app.log',
      'warning',
      opts({ lineNumbers: true, contextAfter: 1 }),
      null,
    )
    expect(out).toEqual(['2:warning: low memory', '3-info: all good'])
  })

  it('separates distant groups with --', async () => {
    const out = await rgFull(
      logReaddirFn,
      logStatFn,
      logReadBytesFn,
      '/log/far.txt',
      'hit',
      opts({ contextAfter: 1 }),
      null,
    )
    expect(out).toEqual(['hit', 'a', '--', 'hit'])
  })

  it('respects maxCount with context', async () => {
    const out = await rgFull(
      logReaddirFn,
      logStatFn,
      logReadBytesFn,
      '/log/app.log',
      'error',
      opts({ maxCount: 1, contextBefore: 1, contextAfter: 1 }),
      null,
    )
    expect(out).toEqual(['error: disk full', 'warning: low memory'])
  })

  it('skips context on directory walks (documented divergence)', async () => {
    const out = await rgFull(
      logReaddirFn,
      logStatFn,
      logReadBytesFn,
      '/log',
      'warning',
      opts({ contextAfter: 1 }),
      null,
    )
    expect(out).toEqual(['/log/app.log:warning: low memory'])
  })
})

describe('rgFull -I in directory walks', () => {
  it('drops per-file labels', async () => {
    const out = await rgFull(
      logReaddirFn,
      logStatFn,
      logReadBytesFn,
      '/log',
      'warning',
      opts({ noFilename: true }),
      null,
    )
    expect(out).toEqual(['warning: low memory'])
  })

  it('keeps paths for -l', async () => {
    const out = await rgFull(
      logReaddirFn,
      logStatFn,
      logReadBytesFn,
      '/log',
      'warning',
      opts({ noFilename: true, filesOnly: true }),
      null,
    )
    expect(out).toEqual(['/log/app.log'])
  })
})
