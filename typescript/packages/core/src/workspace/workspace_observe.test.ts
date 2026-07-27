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
import { RAMObserverStore } from '../observe/store.ts'
import { OpsRegistry } from '../ops/registry.ts'
import { RAMResource } from '../resource/ram/ram.ts'
import { createShellParser, type ShellParser } from '../shell/parse.ts'
import { MountMode } from '../types.ts'
import { Workspace } from './workspace.ts'

const require = createRequire(import.meta.url)
const engineWasm = readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))

const DEC = new TextDecoder()

let parser: ShellParser

beforeAll(async () => {
  parser = await createShellParser({ engineWasm, grammarWasm })
})

function buildWorkspace(observe?: RAMObserverStore): Workspace {
  const ram = new RAMResource()
  const registry = new OpsRegistry()
  registry.registerResource(ram)
  return new Workspace(
    { '/data': ram },
    {
      mode: MountMode.WRITE,
      ops: registry,
      shellParser: parser,
      ...(observe !== undefined ? { observe } : {}),
    },
  )
}

function jsonlSessionFiles(store: RAMObserverStore): string[] {
  return [...store.files.keys()].filter((k) => k.endsWith('.jsonl'))
}

describe('Workspace observer wiring', () => {
  it('creates a default observer backed by a RAM store', () => {
    const ws = buildWorkspace()
    expect(ws.observer).toBeDefined()
    expect(ws.observer.store).toBeInstanceOf(RAMObserverStore)
  })

  it('uses a custom observe store when provided', () => {
    const store = new RAMObserverStore()
    const ws = buildWorkspace(store)
    expect(ws.observer.store).toBe(store)
  })

  it('writes at least one command entry after an execute', async () => {
    const store = new RAMObserverStore()
    const ws = buildWorkspace(store)
    await ws.execute('echo hello > /data/test.txt')
    const files = jsonlSessionFiles(store)
    expect(files.length).toBeGreaterThanOrEqual(1)
    const first = files[0]
    if (first === undefined) throw new Error('no session file')
    const lines = DEC.decode(store.files.get(first))
      .trim()
      .split('\n')
      .filter((l) => l !== '')
    expect(lines.length).toBeGreaterThanOrEqual(1)
    const lastLine = lines[lines.length - 1]
    if (lastLine === undefined) throw new Error('no log lines')
    const entry = JSON.parse(lastLine) as Record<string, unknown>
    expect(entry.type).toBe('command')
    await ws.close()
  })

  it('writes both op and command entries after reads and writes', async () => {
    const store = new RAMObserverStore()
    const ws = buildWorkspace(store)
    await ws.execute('echo hello > /data/test.txt')
    await ws.execute('cat /data/test.txt')
    const files = jsonlSessionFiles(store)
    const first = files[0]
    if (first === undefined) throw new Error('no session file')
    const types = new Set(
      DEC.decode(store.files.get(first))
        .trim()
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => (JSON.parse(l) as Record<string, unknown>).type),
    )
    expect(types.has('op')).toBe(true)
    expect(types.has('command')).toBe(true)
    await ws.close()
  })

  it('does not mount the observer store (only root, /data, /dev, /.bash_history)', async () => {
    const ws = buildWorkspace()
    await ws.execute('echo hi > /data/f.txt')
    const result = await ws.execute('ls /.sessions')
    expect(result.exitCode).not.toBe(0)
    const prefixes = new Set(ws.registry.allMounts().map((m) => m.prefix))
    // No `/` was mounted, so the workspace adds an empty root anchor at `/`.
    expect(prefixes).toEqual(new Set(['/', '/data/', '/dev/', '/.bash_history/']))
    await ws.close()
  })

  // The three below assert the recorded event shape on the real execute path.
  // observer.test.ts builds entries by hand, so a regression in the wiring from
  // a command to its event would not be caught there, and the /.bash_history
  // and `history` views render fine without these fields.
  it('records exitCode and cwd on every command event', async () => {
    const ws = buildWorkspace()
    await ws.execute('echo hello > /data/test.txt')
    await ws.execute('cat /data/missing.txt')
    const commands = await ws.history()
    expect(commands).toHaveLength(2)
    expect(commands.every((e) => 'exit_code' in e)).toBe(true)
    expect(commands.every((e) => 'cwd' in e)).toBe(true)
    expect(commands.map((e) => e.exit_code)).toEqual([0, 1])
    await ws.close()
  })

  // The path form is deliberately not asserted here: this host records the
  // op path mount-relative ('/test.txt') where python records the virtual path
  // ('/data/test.txt'), so the prefix set by Mount.execute is not reaching
  // record(). Python's test_execute_records_op_source pins the correct form;
  // asserting the mount-relative one here would freeze the bug in place.
  it('records a source and a read op on every op event', async () => {
    const ws = buildWorkspace()
    await ws.execute('echo hello > /data/test.txt')
    await ws.execute('cat /data/test.txt')
    const events = await ws.observer.events()
    const ops = events.filter((e) => e.type === 'op')
    expect(ops.length).toBeGreaterThan(0)
    expect(ops.every((e) => 'source' in e)).toBe(true)
    expect(ops.filter((e) => e.op === 'read').length).toBeGreaterThan(0)
    await ws.close()
  })

  it('records clear, command, delete and op event types', async () => {
    const ws = buildWorkspace()
    await ws.execute('echo hello > /data/test.txt')
    await ws.execute('history -s synthetic')
    await ws.execute('history -d 1')
    await ws.execute('history -c')
    const events = await ws.observer.events()
    const types = new Set(events.map((e) => e.type))
    for (const kind of ['clear', 'command', 'delete', 'op']) {
      expect(types.has(kind)).toBe(true)
    }
    await ws.close()
  })
})
