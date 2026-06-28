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

import type { Accessor } from '../../../accessor/base.ts'
import { type CommandFn, type ProvisionFn, type RegisteredCommand, command } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import type { Builder, CommandIO } from './adapter.ts'
import { BUILDERS } from './builders/index.ts'

export interface MakeGenericCommandsOptions<A extends Accessor = Accessor> {
  overrides?: ReadonlySet<string>
  provisionOverrides?: Record<string, ProvisionFn<A>>
}

export function makeGenericCommands<A extends Accessor = Accessor>(
  resource: string,
  ops: CommandIO<A>,
  options: MakeGenericCommandsOptions<A> = {},
): RegisteredCommand[] {
  const skip = options.overrides ?? new Set<string>()
  const provOver = options.provisionOverrides ?? {}
  const commands: RegisteredCommand[] = []
  for (const b of BUILDERS as readonly Builder<A>[]) {
    if (skip.has(b.name)) continue
    // A read-only backend (no write op) can't run byte-mutation commands
    // (cp/mv/tee/gunzip/...), so don't register a command that would crash
    // when invoked.
    if (b.write === true && ops.write === undefined) continue
    const fn: CommandFn<A> = (accessor, paths, texts, opts) =>
      b.fn(ops, accessor, paths, texts, opts)
    const provision = provOver[b.name] ?? (b.provision !== undefined ? b.provision(ops.stat) : null)
    const aggregate = ops.local !== false ? b.aggregate : undefined
    commands.push(
      ...command<A>({
        name: b.name,
        resource,
        spec: specOf(b.name),
        fn,
        provision,
        aggregate: aggregate ?? null,
        write: b.write,
      }),
    )
  }
  return commands
}
