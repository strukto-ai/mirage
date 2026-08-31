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

import { Prisma } from '../../../generated/gws/index.js'
import { RouteError } from '../../kit/typescript/index.ts'
import type { Ctx, Dmmf, KitHandler, KitRoute, Reply } from '../../kit/typescript/index.ts'
import type { C } from '../store/client.ts'
import { loadState } from '../store/load.ts'
import { saveState } from '../store/save.ts'
import type { GwsState } from '../store/state.ts'

// gws's own path compiler, because the kit's differs from the regexes this
// fake is a port of in two ways that are both observable.
//
// 1. The kit compiles `^...\/?$`, so every route also answers with a trailing
//    slash: `GET /drive/v3/files/` returned the whole file list where the old
//    regex (a bare `$`) answered `Unknown route`. A fake that answers a URL
//    the real API does not is a fake that hides a client bug.
// 2. Every kit parameter is `([^/]+)`, where the old fake used two classes on
//    purpose. A resource id was `[^/:]+` so that a path holding an in-segment
//    verb could never be read as an id, and only the segments that really can
//    hold a colon (an A1 range, a `<id>:batchUpdate` target) were wider. A
//    Sheets range was wider still, `(.+)`, because the range is the rest of
//    the path.
//
// So a route names the class per parameter and the default is the kit's.
export type ParamClass = 'id' | 'seg' | 'rest'

const CLASSES: Record<ParamClass, string> = {
  id: '([^/:]+)',
  seg: '([^/]+)',
  rest: '(.+)',
}

const PARAM_RE = /:([A-Za-z_][A-Za-z0-9_]*)/g
const ESCAPE_RE = /[.*+?^${}()|[\]\\]/g

const DMMF = Prisma.dmmf as unknown as Dmmf

export interface RouteOpts {
  write?: boolean
  classes?: Record<string, ParamClass>
}

// The store boundary, and the only place it exists. A handler is written
// against GwsState -- the whole tenant world in the shapes the renderers read
// -- and this is what turns one into a Prisma request: load before, call, and
// on a write route flush after. Wrapping in `route()` rather than in each
// handler is what keeps the port from touching 38 call sites, and it means a
// route CANNOT forget the flush, because declaring `write: true` is the same
// act as asking for one.
//
// A read is not flushed, so a handler on a read route must not mutate. That is
// true of every route today, and the two things a read could plausibly advance
// without looking like a mutation -- the clock and the mint counters, which a
// handler touches by calling `now()` or `nextId()` -- are checked below rather
// than trusted. Losing one silently is exactly the failure this whole port is
// meant to remove: the request that advanced the counter still answers with
// the new id, and only the NEXT request finds it handed out twice.
function stateful(handler: KitHandler<GwsState>, write: boolean): KitHandler<C> {
  return async (ctx: Ctx<C>): Promise<Reply> => {
    const st = await loadState(ctx.db, ctx.tenant)
    const before = write ? 0 : fingerprint(st)
    const reply = await handler({ ...ctx, db: st })
    if (write) {
      await saveState(ctx.db, DMMF, ctx.tenant, st)
    } else if (fingerprint(st) !== before) {
      process.stderr.write(
        `gws fake: read route advanced the clock or a mint counter and the ` +
          `advance was dropped; mark it write: true\n`,
      )
    }
    return reply
  }
}

function fingerprint(st: GwsState): number {
  let sum = st.ticks
  for (const n of st.counters.values()) sum += n
  return sum
}

export function route(
  method: string,
  path: string,
  handler: KitHandler<GwsState>,
  opts: RouteOpts = {},
): KitRoute<C> {
  if (!path.startsWith('/')) throw new RouteError(`route path must start with /: ${path}`)
  const params: string[] = []
  const classes = opts.classes ?? {}
  const body = path.replace(ESCAPE_RE, '\\$&').replace(PARAM_RE, (_all, name: string) => {
    params.push(name)
    return CLASSES[classes[name] ?? 'seg']
  })
  const write = opts.write === true
  return {
    method: method.toUpperCase(),
    path,
    pattern: new RegExp(`^${body}$`),
    params,
    handler: stateful(handler, write),
    write,
  }
}
