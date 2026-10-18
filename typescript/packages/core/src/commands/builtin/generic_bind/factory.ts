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

import { SharedInput } from '../../../io/async_line_iterator.ts'
import { IOResult } from '../../../io/types.ts'
import { encodeText } from '../../../shell/bytes.ts'
import type { PathSpec } from '../../../types.ts'
import {
  type CommandFn,
  type Command,
  CommandCatalog,
  command,
  type Context,
} from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { guardInput } from '../utils/limit.ts'
import type { GenericCommand } from './adapter.ts'
import { BUILDERS } from './builders/index.ts'
import { type Reading, withReading } from './files.ts'

function bind(b: GenericCommand, vfs: string | null, stream: Reading['stream']): Command[] {
  // The builder reads its files under the command tier's guards: what it
  // reads, cut into pieces unless it passes its input through, and a stat's
  // unknown size filled from the read cache unless it only writes. Every
  // call it makes is the dispatcher's, which judges each itself. Stdin is cut
  // the same way, under the invocation's abort and deadline.
  const reading: Reading = {
    split: b.passThrough !== true,
    cachedSizes: b.write !== true || b.read === true,
    stream,
  }
  const fn: CommandFn = (accessor, paths, texts, ctx) => {
    if (ctx.vfs === undefined) {
      return [
        null,
        new IOResult({ exitCode: 1, stderr: encodeText(`${b.name}: no workspace files\n`) }),
      ]
    }
    const run: Context = {
      ...ctx,
      // head guards its own pulls and needs the descriptor cursor to return lookahead.
      stdin:
        ctx.stdin === null || (b.name === 'head' && ctx.stdin instanceof SharedInput)
          ? ctx.stdin
          : guardInput(ctx.stdin, ctx, reading.split),
    }
    return b.fn(accessor, paths, texts, withReading(run, reading))
  }
  return command({
    name: b.name,
    vfs,
    spec: specOf(b.name),
    fn,
    aggregate: b.aggregate ?? null,
    write: b.write === true,
  })
}

const BY_NAME = new Map(BUILDERS.map((b) => [b.name, b]))

/**
 * Every mount falls back to these after its VFS's own commands. Each reads
 * and writes through the session's files (`ctx.vfs`), so one set serves the
 * whole workspace. Mirrors Python's `GENERIC_COMMANDS`.
 */
export const GENERIC_COMMANDS = new CommandCatalog(BUILDERS.flatMap((b) => bind(b, null, null)))

/**
 * The default command `name`, which a mount runs when its VFS has no command
 * of that name. A VFS that replaces a command hands what the replacement does
 * not support to this one: `generic('grep').fn(accessor, paths, texts, ctx)`.
 * With `vfs`, the same command registered for that backend. Mirrors Python's
 * `generic`.
 */
export function generic(name: string, options: { vfs?: string } = {}): Command {
  if (!BY_NAME.has(name)) throw new Error(`no generic command named '${name}'`)
  if (options.vfs === undefined) return GENERIC_COMMANDS.require(name)
  return genericReading(name, { vfs: options.vfs })
}

/**
 * The generic command `name` registered for `vfs`, each operand streamed by
 * `stream` where it answers one (null keeps the dispatched read): `/dev`'s
 * endless `cat` and `head`. Mirrors Python's `generic_reading`.
 */
export function genericReading(
  name: string,
  options: {
    vfs: string
    stream?: (ctx: Context, path: PathSpec) => AsyncIterable<Uint8Array> | null
  },
): Command {
  const b = BY_NAME.get(name)
  if (b === undefined) throw new Error(`no generic command named '${name}'`)
  return new CommandCatalog(bind(b, options.vfs, options.stream ?? null)).require(name)
}
