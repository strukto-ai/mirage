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

// `tvly extract` adapted from tvly 1.0.2's src/commands/extract.ts and
// src/ui/render/extract.ts (MIT; see licenses/third_party/tavily-cli.txt).

import type { TavilyAccessor } from '../../../../accessor/tavily.ts'
import { tavilyRequest, timedBody } from '../../../../core/tavily/client.ts'
import { EXTRACT_TIMEOUT } from '../../../../core/tavily/constants.ts'
import type { JsonValue, PathSpec } from '../../../../types.ts'
import type { CommandFnResult, Context } from '../../../config.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import { usage } from './failure.ts'
import { InvalidOption, clientNameOf, defined, typedChoice, typedNumber } from './options.ts'
import { Streams, emit, jsonRequested, resolveOutput } from './output.ts'
import { field, items, jsonText, memberText, pagesText, plain } from './render.ts'
import { hostnameOf } from './urls.ts'

const MAX_URLS = 20
const EXTRACT_DEPTHS = ['basic', 'advanced'] as const
const FORMATS = ['markdown', 'text'] as const

/**
 * Set what `--extract-depth`, `--format` and `--include-images` ask, the
 * content options extract and crawl share.
 */
export function pageOptions(fl: FlagView, body: Record<string, JsonValue>): void {
  defined(
    body,
    'extract_depth',
    typedChoice(fl, 'extract_depth', '--extract-depth <depth>', EXTRACT_DEPTHS),
  )
  defined(body, 'format', typedChoice(fl, 'format', '--format <format>', FORMATS))
  if (fl.asBool('include_images')) body.include_images = true
}

/** Extract the content of up to twenty URLs. */
export async function extract(
  accessor: TavilyAccessor,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags, ctx.spec)
  const body: Record<string, JsonValue> = { urls: [...texts] }
  try {
    defined(body, 'query', fl.asStr('query'))
    defined(
      body,
      'chunks_per_source',
      typedNumber(fl, 'chunks_per_source', '--chunks-per-source <n>', { integer: true }),
    )
    pageOptions(fl, body)
    defined(body, 'timeout', typedNumber(fl, 'timeout', '--timeout <seconds>'))
  } catch (err) {
    if (err instanceof InvalidOption) return usage(err.message)
    throw err
  }
  if (texts.length === 0) return usage("error: missing required argument 'urls'")
  if (texts.length > MAX_URLS) return usage(`error: Maximum ${String(MAX_URLS)} URLs per request.`)
  const output = resolveOutput(fl, ctx, 'extract', hostnameOf(texts[0] ?? ''))
  const [filled, timeout] = timedBody(body, EXTRACT_TIMEOUT)
  const data = await tavilyRequest(accessor, 'POST', 'extract', filled, {
    timeout,
    clientName: clientNameOf(fl),
  })
  const streams = new Streams()
  if (jsonRequested(fl, output)) {
    await emit(streams, ctx, jsonText(data, true), output)
    return streams.result()
  }
  streams.stdout.push(pagesText(items(field(data, 'results'))))
  for (const failed of items(field(data, 'failed_results'))) {
    streams.out(
      `Failed: ${plain(memberText(failed, 'url'))}: ${plain(memberText(failed, 'error'))}`,
    )
  }
  return streams.result()
}
