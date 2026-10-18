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

import { chunks } from '../../io/cooperative.ts'
import { YieldBudget } from '../../io/yield_budget.ts'
import { openStream, type OpenStream } from '../../rs/stream.ts'
import type { JsonValue } from '../../types.ts'

/** Run a jq codec with bounded calls and cooperative drains. */
export async function* runCodec(
  kind: string,
  config: Readonly<Record<string, JsonValue>>,
  data: Uint8Array,
  signal?: AbortSignal,
): AsyncIterable<Uint8Array> {
  const stream = await openStream(kind, config)
  const budget = new YieldBudget(signal)
  try {
    for await (const piece of chunks(data, signal)) {
      const output = stream.feed(piece)
      if (output.length > 0) yield output
      while (stream.busy()) {
        const pending = budget.run()
        if (pending !== undefined) await pending
        const output = stream.drain()
        if (output.length > 0) yield output
      }
    }
    const output = stream.finish()
    if (output.length > 0) yield output
    while (stream.busy()) {
      const pending = budget.run()
      if (pending !== undefined) await pending
      const output = stream.drain()
      if (output.length > 0) yield output
    }
  } finally {
    await closeCodec(stream)
  }
}

/** Discard buffered jq data with cooperative, bounded cleanup. */
export async function closeCodec(stream: OpenStream): Promise<void> {
  try {
    stream.begin({ discard: true })
    const budget = new YieldBudget()
    while (stream.busy()) {
      const pending = budget.run()
      if (pending !== undefined) await pending
      stream.drain()
    }
  } finally {
    stream.close()
  }
}
