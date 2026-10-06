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
import { CLISpec } from '@struktoai/mirage-core/commands/cli/types'
import { Operand } from '@struktoai/mirage-core/commands/spec/types'
import type { FileStat } from '@struktoai/mirage-core/types'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { command, type RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import { specOf } from '@struktoai/mirage-core/commands/spec/builtins'
import { IOResult } from '@struktoai/mirage-core/io/types'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'
import { eacces } from '@struktoai/mirage-core/errors/fs'

function guardedListing(original: RegisteredOp): RegisteredOp {
  return {
    ...original,
    fn: (accessor, path, ...args) => {
      if (path.virtual.endsWith('.deny')) throw eacces(path)
      return original.fn(accessor, path, ...args)
    },
  }
}

const GATE = {
  started: 0,
  active: 0,
  peak: 0,
  release: null as (() => void) | null,
  ready: null as Promise<void> | null,
}

export class CommandService extends RAMVFS {
  private readonly calls: string[] = []
  constructor(private readonly metadataOnly = false) {
    super()
  }

  override commands(): readonly RegisteredCommand[] {
    const handlers = super.commands().flatMap((original) => {
      if (this.metadataOnly && ['grep', 'rg', 'find', 'du'].includes(original.name)) return []
      if (!['grep', 'rg', 'rev'].includes(original.name)) return [original]
      return command({
        name: original.name,
        vfs: 'ram',
        spec: specOf(original.name),
        fn: async (accessor, paths, texts, opts) => {
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
                  if (opts.signal?.aborted === true) resolve()
                  else opts.signal?.addEventListener('abort', () => resolve(), { once: true })
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
          return original.fn(accessor, paths, texts, opts)
        },
      })
    })
    return [
      ...handlers,
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

  override ops(): readonly RegisteredOp[] {
    return super.ops().map((op) =>
      op.name === 'read'
        ? {
            ...op,
            fn: (_accessor, path) => {
              throw eacces(path)
            },
          }
        : op.name === 'readdir'
          ? guardedListing(op)
          : op,
    )
  }
}
export const CLI = new CLISpec({
  name: 'scope-probe',
  rest: new Operand({ type: 'path' }),
  fn: async (inv) => {
    let size = 0
    for (const path of inv.paths) {
      const [stat] = await inv.doors.dispatch('stat', path)
      size += (stat as FileStat).size ?? 0
    }
    return [
      new TextEncoder().encode(`${size}:${inv.paths.map((p) => p.virtual).join(',')}\n`),
      new IOResult(),
    ]
  },
})
