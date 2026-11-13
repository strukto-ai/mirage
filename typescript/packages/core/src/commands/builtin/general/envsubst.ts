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

import type { PathSpec } from '../../../types.ts'
import type { Accessor } from '../../../accessor/base.ts'
import { IOResult } from '../../../io/types.ts'
import { openStream, closeStream } from '../../../rs/stream.ts'
import { chunks } from '../../../io/cooperative.ts'
import { YieldBudget } from '../../../io/yield_budget.ts'
import { command, type CommandFnResult, type Context } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { resolveSource } from '../utils/stream.ts'
import { byteView } from '../../../shell/bytes.ts'
import { FlagView } from '../../spec/flag_view.ts'

async function* substituted(
  source: Uint8Array | AsyncIterable<Uint8Array>,
  args: string[],
  variables: boolean,
  env: Readonly<Record<string, string>>,
): AsyncGenerator<Uint8Array> {
  const stream = await openStream('envsubst', {
    args,
    variables,
    names: Object.keys(env).map((name) => byteView(name)),
  })
  const budget = new YieldBudget()
  async function* progress(first: Uint8Array): AsyncGenerator<Uint8Array> {
    let output = first
    for (;;) {
      if (output.length) yield output
      await budget.run()
      if (stream.busy()) {
        output = stream.drain()
        continue
      }
      const request = stream.request()
      if (request === null) return
      const [header] = request
      const names = header.names
      if (header.op !== 'env' || !Array.isArray(names))
        throw new Error('invalid environment binding request')
      const values: [string, string][] = []
      for (const name of names) {
        if (typeof name !== 'string') throw new Error('invalid environment binding name')
        values.push([name, byteView(env[name] ?? '')])
      }
      output = stream.respond({ env: Object.fromEntries(values) }, new Uint8Array())
    }
  }
  try {
    for await (const chunk of chunks(source)) yield* progress(stream.feed(chunk))
    yield* progress(stream.finish())
  } finally {
    await closeStream(stream)
  }
}

function envsubst(
  _accessor: Accessor,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): CommandFnResult {
  const variables = new FlagView(ctx.flags, specOf('envsubst')).asBool('variables')
  const env = variables ? {} : { ...ctx.env }
  return [
    substituted(
      variables ? new Uint8Array() : resolveSource(ctx.stdin),
      texts.map((text) => byteView(text)),
      variables,
      env,
    ),
    new IOResult(),
  ]
}

export const GENERAL_ENVSUBST = command({
  name: 'envsubst',
  vfs: null,
  spec: specOf('envsubst'),
  fn: envsubst,
})
