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

import { GlobLimitError } from '../../../errors/types.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { runWithMountGate } from '../../../context/session_context.ts'
import type { DispatchFn } from '../../../runtime/types.ts'
import { FileStat, FileType, MountMode, PathSpec, type FileStatInit } from '../../../types.ts'
import { eacces, enoent } from '../../../errors/fs.ts'
import { IOResult } from '../../../io/types.ts'
import { Files } from '../../../workspace/files.ts'
import type { MountRow } from '../../../workspace/types.ts'
import { stripSlash } from '../../../utils/slash.ts'
import type { Context } from '../../config.ts'
import {
  type CommandFiles,
  commandFiles,
  dirAwareStat,
  dirAwareStream,
  fileSize,
  resolveOrEmpty,
  withReading,
} from './files.ts'
import { runWithRevisions } from '../../../observe/context.ts'
import { BatchedRAM, readers } from '../../../test-utils.ts'
import { getTestParser } from '../../../../tests/workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const open: Workspace[] = []

afterEach(async () => {
  for (const ws of open.splice(0)) await ws.close()
})

const at = (virtual: string): PathSpec => PathSpec.fromStrPath(virtual)
const stat = (init: Partial<FileStatInit> = {}): FileStat =>
  new FileStat({ name: 'f', type: FileType.FILE, ...init })

// A keyed store: a directory is a name its parent lists, or explicit.
interface Backend {
  stored?: Record<string, string>
  implicit?: readonly string[]
  explicit?: readonly string[]
  listing?: (p: PathSpec) => Promise<string[]>
}

// eslint-disable-next-line @typescript-eslint/require-await, require-yield
async function* throwing(err: Error): AsyncIterable<Uint8Array> {
  throw err
}

function keyed(backend: Backend, calls: string[] = []): DispatchFn {
  const { stored = {}, implicit = [], explicit = [] } = backend
  const done = (value: unknown): Promise<[unknown, IOResult]> =>
    Promise.resolve([value, new IOResult()])
  const names = [...implicit, ...explicit, ...Object.keys(stored)]
  const listing =
    backend.listing ??
    ((p: PathSpec) => {
      const target = `/${stripSlash(p.virtual)}`
      return Promise.resolve(
        names.filter((n) => (n.slice(0, n.lastIndexOf('/')) || '/') === target),
      )
    })
  return (name, p, _args, kwargs = {}) => {
    calls.push(`${name} ${p.virtual}`)
    const hit = stored[p.virtual]
    if (name === 'readdir') return listing(p).then(done)
    if (name === 'stat' && explicit.includes(p.virtual))
      return done(new FileStat({ name: p.virtual, type: FileType.DIRECTORY }))
    if (name === 'stat') return done(hit === undefined ? null : stat({ size: hit.length }))
    if (name !== 'read') return done(null)
    if (kwargs.stream === true)
      return done(hit === undefined ? throwing(enoent(p)) : [ENC.encode(hit)])
    return hit === undefined ? Promise.reject(enoent(p)) : done(ENC.encode(hit))
  }
}

function answering(st: FileStat, now: FileStat = st, warm = false): DispatchFn {
  return (name, _p, _args, kwargs = {}) =>
    Promise.resolve([
      name === 'read' ? (warm ? true : null) : kwargs.fresh === true ? now : st,
      new IOResult(),
    ])
}

interface Mounts {
  prefixes?: string[]
  row?: MountRow | null
  signal?: AbortSignal
}

function contextFor(
  dispatch: DispatchFn,
  { prefixes = [], row = null, signal }: Mounts = {},
): Context {
  const rows = [...(row === null ? [] : [row]), ...prefixes.filter((p) => p !== row?.prefix)]
  const vfs = new Files(dispatch, readers(rows), null, { ledger: false })
  return { stdin: null, flags: {}, cwd: at('/'), vfs, ...(signal === undefined ? {} : { signal }) }
}

// The command's files as the factory hands them to a builder on a mount.
function guarded(ctx: Context): Promise<CommandFiles> {
  const reading = withReading(ctx, { split: true, stream: null })
  return runWithMountGate('/', MountMode.WRITE, () => Promise.resolve(commandFiles(reading)))
}

async function drain(stream: AsyncIterable<Uint8Array>): Promise<string> {
  let text = ''
  for await (const chunk of stream) text += DEC.decode(chunk)
  return text
}

describe('commandFiles', () => {
  it('reads the stored bytes on a mount, and across mounts renders after a stat', async () => {
    const calls: [string, unknown][] = []
    const backend = keyed({ stored: { '/f': 'x' }, explicit: ['/d'] })
    const dispatch: DispatchFn = (name, p, args, kwargs) => {
      calls.push([name, kwargs ?? {}])
      return backend(name, p, args, kwargs)
    }
    const onMount = await guarded(contextFor(dispatch))
    const across = commandFiles(contextFor(dispatch))
    expect(DEC.decode(await onMount.readBytes(at('/f')))).toBe('x')
    expect(DEC.decode(await across.readBytes(at('/f')))).toBe('x')
    await expect(across.readBytes(at('/d'))).rejects.toMatchObject({ code: 'EISDIR' })
    expect(calls).toEqual([
      ['read', { filetype: null, offset: 0, size: null }],
      ['stat', {}],
      ['read', {}],
      ['stat', {}],
    ])
  })

  // Mirrors test_a_glob_past_its_mounts_limit_is_refused_and_none_is_stdin.
  it('refuses a glob past its mount limit, on a mount or across, none as stdin', async () => {
    const dispatch = keyed({ stored: { '/f0.txt': '', '/f1.txt': '', '/f2.txt': '' } })
    const row = { prefix: '/', kind: 'ram', mode: MountMode.WRITE, fullScanLimit: 2 }
    const roomyRow = { ...row, fullScanLimit: 3 }
    const word = new PathSpec({
      virtual: '/*.txt',
      directory: '/',
      vfsPath: '*.txt',
      pattern: '*.txt',
      resolved: false,
    })
    const capped = await guarded(contextFor(dispatch, { row, prefixes: ['/'] }))
    const roomy = await guarded(contextFor(dispatch, { row: roomyRow, prefixes: ['/'] }))
    const across = commandFiles(contextFor(dispatch, { row, prefixes: ['/'] }))
    for (const files of [capped, across]) {
      await expect(resolveOrEmpty(files, [word])).rejects.toThrow(new GlobLimitError('/*.txt', 2))
    }
    expect(await resolveOrEmpty(roomy, [word])).toHaveLength(3)
    expect(await resolveOrEmpty(capped, [])).toEqual([])
  })
})

// Listings for a missing name: children for any name (a postgres schema), a
// driver error (lancedb), and a refusal.
const fabricated = (p: PathSpec) =>
  Promise.resolve(stripSlash(p.virtual) === '' ? ['/real.txt'] : [`${p.virtual}/tables`])
const driver = () => Promise.reject(new Error("Table 'nope.txt' was not found"))
const refusing = (p: PathSpec) => Promise.reject(eacces(p.virtual))

describe('dirAwareStat and dirAwareStream', () => {
  it.each([
    ['an implicit directory', { implicit: ['/sub'] }, [], '/sub', 'EISDIR'],
    ['a namespace-only mount parent', {}, ['/ghost/alpha/'], '/ghost', 'EISDIR'],
    ['a path the namespace does not know either', {}, ['/else/alpha/'], '/ghost', 'ENOENT'],
    ['a path with fabricated children', { listing: fabricated }, [], '/nope.txt', 'ENOENT'],
    ['a driver error on the probe listing', { listing: driver }, [], '/nope.txt', 'ENOENT'],
    ['a refused parent listing', { listing: refusing }, [], '/locked/nope.txt', 'EACCES'],
  ])('judge %s', async (_, backend: Backend, prefixes, path, code) => {
    const calls: string[] = []
    const ctx = contextFor(keyed(backend, calls), { prefixes })
    const files = await guarded(ctx)
    await expect(dirAwareStat(files, ctx)(at(path))).rejects.toMatchObject({ code })
    await expect(drain(dirAwareStream(files, ctx)(at(path)))).rejects.toMatchObject({ code })
    expect(calls.filter((call) => call.startsWith('read '))).toEqual([])
  })
})

describe('the abort guard', () => {
  it('forwards every call while the signal is quiet and starts none once it fired', async () => {
    const calls: string[] = []
    const controller = new AbortController()
    const dispatch = keyed({ stored: { '/data/a': 'x' } }, calls)
    const files = await guarded(contextFor(dispatch, { signal: controller.signal }))
    await files.unlink(at('/data/a'))
    await files.readBytes(at('/data/a'))
    expect(calls).toEqual(['unlink /data/a', 'read /data/a'])
    controller.abort(new Error('released'))
    await expect(files.unlink(at('/data/b'))).rejects.toMatchObject({
      name: 'AbortError',
      cause: { message: 'released' },
    })
    // A presence fact or a pushed-down line answer is still a request on an API mount.
    const p = at('/t')
    for (const call of [
      () => files.write(p, new Uint8Array()),
      () => files.readdir(p),
      () => files.stat(p),
      () => files.exists(p),
      () => files.readTree(p),
      () => files.firstLines(p, 1),
      () => files.lastLines(p, 1),
      () => files.lineCount(p),
      () => files.follow(p, 1, 1),
    ])
      await expect(call()).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls).toHaveLength(2)
  })
})

describe('fileSize', () => {
  it.each([
    ['a store file', stat({ size: 7 }), undefined, false, false, 7],
    ['a file whose size moved', stat({ size: 7 }), stat({ size: 9 }), false, false, null],
    ['a file the read cache holds', stat({ size: 7 }), undefined, true, false, null],
    ['a path pinned to a revision', stat({ size: 7 }), undefined, false, true, null],
    ['a file with permission bits', stat({ size: 7, mode: 0o644 }), undefined, false, false, null],
    ['a file of unknown size', stat(), undefined, false, false, null],
    ['a device', stat({ type: FileType.CHAR_DEVICE, size: 0 }), undefined, false, false, null],
  ])('answers %s', async (_, st, now, warm, pinned, size) => {
    const ctx = contextFor(answering(st, now, warm))
    const bound = fileSize(await guarded(ctx), ctx)
    const pins = pinned ? new Map([['/f', 'v1']]) : null
    expect(await runWithRevisions(pins, () => bound(at('/f')))).toBe(size)
  })
})

it('warms the operands after a glob read', async () => {
  const vfs = new BatchedRAM()
  const names = Array.from({ length: 12 }, (_, i) => `/f${String(i).padStart(2, '0')}`)
  for (const name of names) vfs.store.files.set(name, ENC.encode('x\n'))
  const parser = await getTestParser()
  const ws = new Workspace({ '/r': vfs }, { shellParserFactory: () => Promise.resolve(parser) })
  open.push(ws)
  const out = await ws.shell('cat /r/f*')
  expect(DEC.decode(out.stdout)).toBe('x\n'.repeat(12))
  const warmed = names.slice(1).map((name) => `/r${name}`)
  expect(vfs.reads).toEqual(['/r/f00'])
  expect(vfs.batches).toEqual([warmed.slice(0, 8), warmed.slice(8)])
})
