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

import { concatAggregate } from '@struktoai/mirage-core/commands/builtin/aggregators'
import { CLI as CLIProgram, CLIHandler } from '@struktoai/mirage-core/commands/cli/types'
import { Argument, CommandSpec } from '@struktoai/mirage-core/commands/spec/types'
import { generic } from '@struktoai/mirage-core/commands/builtin/generic_bind/index'
import type { FileStat, PathSpec } from '@struktoai/mirage-core/types'
import { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { command, type Command } from '@struktoai/mirage-core/commands/config'
import { specOf } from '@struktoai/mirage-core/commands/spec/builtins'
import { IOResult } from '@struktoai/mirage-core/io/types'
import { eacces } from '@struktoai/mirage-core/errors/fs'

const GATE = {
  started: 0,
  active: 0,
  peak: 0,
  release: null as (() => void) | null,
  ready: null as Promise<void> | null,
}

export class CommandService extends RAMVFS {
  private readonly calls: string[] = []
  private readonly dropped: readonly string[]

  constructor(metadataOnly = false) {
    super()
    this.dropped = metadataOnly ? ['grep', 'rg'] : []
    // Without its own search it has no subtree read either. Mirrors
    // Python's `_without_tree`.
    if (metadataOnly) Object.defineProperty(this, 'readTree', { value: BaseVFS.prototype.readTree })
  }

  override commands(): readonly Command[] {
    // The service's own handlers read its store as a stream, which the
    // refusal below leaves alone; every other whole read reaches it.
    const wrapped = ['grep', 'rev', 'rg']
      .filter((name) => !this.dropped.includes(name))
      .map((name) => generic(name))
    const handlers = wrapped.flatMap((original) => {
      return command({
        name: original.name,
        vfs: 'ram',
        spec: specOf(original.name),
        fn: async (accessor, paths, texts, ctx) => {
          this.calls.push(...paths.map((p) => original.name + ' ' + p.virtual))
          if (original.name === 'rev' && paths[0]!.virtual.endsWith('.gated')) {
            GATE.ready ??= new Promise<void>((resolve) => {
              GATE.release = resolve
            })
            GATE.started++
            GATE.active++
            GATE.peak = Math.max(GATE.peak, GATE.active)
            if (GATE.started >= 4) GATE.release?.()
            await GATE.ready
            async function* gated(): AsyncGenerator<Uint8Array> {
              try {
                yield new TextEncoder().encode(paths[0]!.rawPath + '\n')
              } finally {
                GATE.active--
              }
            }
            return [gated(), new IOResult()]
          }
          if (original.name === 'rev' && paths[0]!.virtual.endsWith('.slow')) {
            const calls = this.calls
            async function* slow(): AsyncGenerator<Uint8Array> {
              try {
                yield new TextEncoder().encode(paths[0]!.rawPath + '\n')
                await new Promise<void>((resolve) => {
                  if (ctx.signal?.aborted === true) resolve()
                  else ctx.signal?.addEventListener('abort', () => resolve(), { once: true })
                })
              } finally {
                calls.push('closed ' + paths[0]!.virtual)
              }
            }
            return [slow(), new IOResult()]
          }
          if (original.name === 'rev' && paths[0]!.virtual.endsWith('.broken')) {
            async function* stream(): AsyncGenerator<Uint8Array> {
              yield new TextEncoder().encode('partial\n')
              throw eacces(paths[0]!)
            }
            return [stream(), new IOResult()]
          }
          return original.fn(accessor, paths, texts, ctx)
        },
      })
    })
    // Without its own search it has no walk of its own either: find and du
    // list through readdir, which refuses what it hides.
    const walks =
      this.dropped.length > 0 ? ['du', 'find'].map((name) => generic(name, { vfs: 'ram' })) : []
    return [
      ...handlers,
      ...walks,
      ...command({
        name: 'gate-status',
        vfs: 'ram',
        spec: specOf('cat'),
        fn: () => [
          new TextEncoder().encode(
            `started=${GATE.started} peak=${GATE.peak} active=${GATE.active}\n`,
          ),
          new IOResult(),
        ],
      }),
      ...command({
        name: 'meter',
        vfs: 'ram',
        spec: specOf('cat'),
        aggregate: concatAggregate,
        fn: (_accessor, paths) => [
          new TextEncoder().encode(paths.map((p) => p.rawPath + '\n').join('')),
          new IOResult(),
        ],
      }),
      ...command({
        name: 'calls',
        vfs: 'ram',
        spec: specOf('cat'),
        fn: async () => {
          const body = this.calls.map((line) => line + '\n').join('')
          this.calls.length = 0
          return [new TextEncoder().encode(body), new IOResult()]
        },
      }),
    ]
  }

  override read(path: PathSpec): Promise<Uint8Array> {
    return Promise.reject(eacces(path))
  }

  override readdir(path: PathSpec): Promise<FileStat[]> {
    if (path.virtual.endsWith('.deny')) return Promise.reject(eacces(path))
    return super.readdir(path)
  }
}
export const CLI = new CLIProgram({
  spec: new CommandSpec({
    name: 'scope-probe',
    arguments: [new Argument('paths', { type: 'path', nargs: '*', metavar: '' })],
  }),
  handlers: {
    '': new CLIHandler({
      fn: async (_accessor, paths, _texts, ctx) => {
        let size = 0
        for (const path of paths) {
          size += (await ctx.vfs!.stat(path)).size ?? 0
        }
        return [
          new TextEncoder().encode(`${size}:${paths.map((p) => p.virtual).join(',')}\n`),
          new IOResult(),
        ]
      },
    }),
  },
})
