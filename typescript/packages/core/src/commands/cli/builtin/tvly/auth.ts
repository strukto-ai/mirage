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

// `tvly auth` keeps tvly 1.0.2's shape (src/commands/auth.ts; MIT, see
// licenses/third_party/tavily-cli.txt). A workspace has no environment
// variable or config file the key came from: the install carries it, so that
// is the source it names, and the key itself is never shown, not even in part.

import type { TavilyAccessor } from '../../../../accessor/tavily.ts'
import type { PathSpec } from '../../../../types.ts'
import type { CommandFnResult, Context } from '../../../config.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import { NO_KEY } from './failure.ts'
import { Streams } from './output.ts'
import { jsonText } from './render.ts'

const METHOD = 'api_key'
const SOURCE = "the tvly install's api_key"

/** Say whether the install carries a key. */
export function auth(
  accessor: TavilyAccessor,
  _paths: PathSpec[],
  _texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const keyed = accessor.config.apiKey !== undefined
  const streams = new Streams()
  if (new FlagView(ctx.flags, ctx.spec).asBool('json')) {
    streams.out(
      jsonText(
        {
          authenticated: keyed,
          method: keyed ? METHOD : null,
          source: keyed ? SOURCE : null,
        },
        false,
      ),
    )
    return Promise.resolve(streams.result())
  }
  streams.out()
  if (keyed) {
    streams.out(`  > Authenticated via ${SOURCE}`)
    streams.out('    Key: ***')
  } else {
    streams.out('  > Not authenticated')
    streams.out()
    streams.out(NO_KEY)
  }
  streams.out()
  return Promise.resolve(streams.result())
}
