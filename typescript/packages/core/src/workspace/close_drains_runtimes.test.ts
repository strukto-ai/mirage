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
import { CLISpec } from '../commands/cli/types.ts'
import { IOResult } from '../io/types.ts'
import { OpsRegistry } from '../ops/registry.ts'
import { RAMResource } from '../resource/ram/ram.ts'
import { createShellParser, type ShellParser } from '../shell/parse/index.ts'
import type { FileEvent, PathSpec } from '../types.ts'
import { MountMode } from '../types.ts'
import type { WatchRuntime } from '../watch/base.ts'
import { Workspace } from './workspace/workspace.ts'

const require = createRequire(import.meta.url)
const engineWasm = readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))

let parser: ShellParser

beforeAll(async () => {
  parser = await createShellParser({ engineWasm, grammarWasm })
})

function build(): Workspace {
  const ram = new RAMResource()
  const registry = new OpsRegistry()
  registry.registerResource(ram)
  return new Workspace(
    { '/data': ram },
    { mode: MountMode.WRITE, ops: registry, shellParser: parser },
  )
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

class BlockingWatchRuntime implements WatchRuntime {
  readonly closeStarted = deferred()
  readonly allowClose = deferred()

  watch(_path: PathSpec | readonly PathSpec[]): AsyncIterable<FileEvent> {
    throw new Error('not used')
  }

  notify(_change: FileEvent): Promise<void> {
    return Promise.resolve()
  }

  async close(): Promise<void> {
    this.closeStarted.resolve()
    await this.allowClose.promise
  }
}

describe('Workspace.close', () => {
  // Re-entry is guarded by the in-flight promise rather than by setting
  // `closed` before the first await. A runtime replaying its journal during
  // teardown writes to mounts, so it has to see an open workspace; Python has
  // always ordered it that way and sets its flags once teardown is done.
  // `closed` is only set once teardown finishes, so that a runtime can still
  // replay its journal. That would otherwise leave a window where a caller
  // could start a job after killAll, or add a mount after the close list was
  // taken, so the public doors check that a close is under way.
  it('refuses new work as soon as close starts', async () => {
    const ws = build()
    const closing = ws.close()
    expect(() => ws.addMount('/late', new RAMResource())).toThrow('Workspace is closed')
    // The top-level door too: a line that got in here could submit a
    // background job after killAll had already run, and teardown would close
    // resources out from under it.
    await expect(ws.execute('echo hi')).rejects.toThrow('Workspace is closed')
    await closing
  })

  it('refuses public filesystem operations while close is in progress', async () => {
    const ws = build()
    const watch = new BlockingWatchRuntime()
    ws.attachWatchRuntime(watch)
    const closing = ws.close()
    await watch.closeStarted.promise

    const attempts = await Promise.allSettled([
      ws.resolve('/data'),
      ws.dispatch('readdir', '/data'),
      ws.stat('/data'),
      ws.readdir('/data'),
      ws.fs.stat('/data'),
    ])

    watch.allowClose.resolve()
    await closing
    expect(
      attempts.map((attempt) =>
        attempt.status === 'rejected' && attempt.reason instanceof Error
          ? attempt.reason.message
          : attempt.status,
      ),
    ).toEqual(Array.from({ length: attempts.length }, () => 'Workspace is closed'))
  })

  it('lets an admitted line finish recursive execution during close', async () => {
    const ws = build()
    const watch = new BlockingWatchRuntime()
    const entered = deferred()
    const resume = deferred()
    ws.attachWatchRuntime(watch)
    ws.registerCli(
      'pause',
      new CLISpec({
        name: 'pause',
        fn: async () => {
          entered.resolve()
          await resume.promise
          return [null, new IOResult()]
        },
      }),
    )

    const running = ws.execute("pause; eval 'echo hi'")
    await entered.promise
    const closing = ws.close()
    await watch.closeStarted.promise
    resume.resolve()
    const result = await running
    watch.allowClose.resolve()
    await closing

    expect(result.exitCode).toBe(0)
    expect(result.stdoutText).toBe('hi\n')
  })

  it('runs teardown once when two callers race it', async () => {
    const ws = build()
    await Promise.all([ws.close(), ws.close(), ws.close()])
    await ws.close()
  })
})
