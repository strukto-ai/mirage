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

import type { util } from 'zod'
import type { PrintfKind } from '../../core/generic/types.ts'
import { YieldBudget } from '../../io/yield_budget.ts'
import { type OpenStream, openStreamSync } from '../../rs/stream.ts'
import { byteView, decodeText } from '../../shell/bytes.ts'
import { concat } from '../../utils/bytes.ts'
import type { PrintfPart } from './types.ts'
import { groupName, ownerName, type Identity } from './utils/identity.ts'

export interface PrintfStatFacts {
  size: number
  kind: PrintfKind
  mtimeEpoch: number
  // The permission bits a backend or the namespace overlay reported,
  // null for the per-kind default.
  mode: number | null
  // What %Y classifies on a symlink row: the target's kind, 'N' when the
  // link dangles. Ignored for a non-link row, where %Y is %y.
  targetKind: PrintfKind | 'N' | null
  // The owner a backend or the attr overlay reported, null when none;
  // %u %U %g %G fall back to the session's identity from there.
  uid: number | string | null
  gid: number | string | null
}

/** Own one shared formatter for all rows of an action. */
export function compilePrintf(parts: readonly PrintfPart[]): OpenStream {
  return openStreamSync('find_printf', {
    parts: parts.map((part) =>
      'lit' in part
        ? { lit: byteView(part.lit) }
        : 'dir' in part
          ? { dir: part.dir }
          : { time: part.time },
    ),
  })
}

function facts(
  row: string,
  base: string,
  st: PrintfStatFacts | null,
  identity: Identity | null,
): Record<string, util.JSONType> {
  const kind = st?.kind ?? 'U'
  return {
    path: byteView(row),
    base: byteView(base),
    size: st?.size ?? 0,
    kind,
    target: kind === 'l' ? (st?.targetKind ?? 'N') : kind,
    mode: st?.mode ?? null,
    owner: byteView(ownerName(st?.uid ?? null, identity)),
    group: byteView(groupName(st?.gid ?? null, identity)),
    timestamp: st?.mtimeEpoch ?? 0,
  }
}

/** Render a row, yielding between bounded formatting steps. */
export async function renderPrintf(
  engine: OpenStream,
  row: string,
  base: string,
  st: PrintfStatFacts | null,
  identity: Identity | null = null,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  signal?.throwIfAborted()
  engine.begin(facts(row, base, st, identity))
  const out = [engine.finish()]
  const budget = new YieldBudget(signal)
  while (engine.busy()) {
    await budget.run()
    out.push(engine.drain())
  }
  return concat(out)
}

/** Render one compiled format synchronously. */
export function expandPrintf(
  parts: readonly PrintfPart[],
  row: string,
  base: string,
  st: PrintfStatFacts | null,
  identity: Identity | null = null,
): string {
  const engine = compilePrintf(parts)
  try {
    engine.begin(facts(row, base, st, identity))
    const out = [engine.finish()]
    while (engine.busy()) out.push(engine.drain())
    return decodeText(concat(out))
  } finally {
    engine.close()
  }
}
