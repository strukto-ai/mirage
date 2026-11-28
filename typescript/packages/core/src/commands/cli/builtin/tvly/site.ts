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

// `tvly crawl` and `tvly map` adapted from tvly 1.0.2's src/commands/site.ts
// and src/ui/render/crawl.ts (MIT; see licenses/third_party/tavily-cli.txt).

import type { TavilyAccessor } from '../../../../accessor/tavily.ts'
import { tavilyRequest, timedBody } from '../../../../core/tavily/client.ts'
import { SITE_TIMEOUT } from '../../../../core/tavily/constants.ts'
import type { JsonValue, PathSpec } from '../../../../types.ts'
import type { CommandOutput } from '../../../../io/types.ts'
import type { CommandFnResult, Context } from '../../../config.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import { ensureDir } from '../../operand.ts'
import { pageOptions } from './extract.ts'
import { requireKey, usage } from './failure.ts'
import { InvalidOption, clientNameOf, defined, splitCsv, typedNumber } from './options.ts'
import { Streams, emit, jsonRequested, resolveOutput } from './output.ts'
import { field, items, jsText, jsonText, pagesText, plain, truthy } from './render.ts'
import { hostOf, pageSlug } from './urls.ts'

const ENC = new TextEncoder()
const LISTS = ['select_paths', 'exclude_paths', 'select_domains', 'exclude_domains'] as const

/** The request fields crawl and map share, unset ones left out. */
export function siteBody(fl: FlagView, url: string): Record<string, JsonValue> {
  const body: Record<string, JsonValue> = { url }
  defined(body, 'max_depth', typedNumber(fl, 'max_depth', '--max-depth <n>', { integer: true }))
  defined(
    body,
    'max_breadth',
    typedNumber(fl, 'max_breadth', '--max-breadth <n>', { integer: true }),
  )
  defined(body, 'limit', typedNumber(fl, 'limit', '--limit <n>', { integer: true }))
  defined(body, 'instructions', fl.asStr('instructions'))
  for (const key of LISTS) defined(body, key, splitCsv(fl.asStr(key)))
  if (fl.asBool('no_external')) body.allow_external = false
  else if (fl.asBool('allow_external')) body.allow_external = true
  defined(body, 'timeout', typedNumber(fl, 'timeout', '--timeout <seconds>'))
  return body
}

/** The one URL a site verb takes, or commander's refusal. */
export function singleUrl(texts: readonly string[], verb: string): string | CommandOutput {
  if (texts.length === 0) return usage("error: missing required argument 'url'")
  if (texts.length > 1) {
    return usage(
      `error: too many arguments for '${verb}'. Expected 1 argument but got ${String(texts.length)}: ${texts.join(', ')}.`,
    )
  }
  return texts[0] ?? ''
}

/**
 * Write each page with content to `<folder>/<slug>.md`. A slug already used
 * in this crawl takes the first free `-2`, `-3`... suffix, compared without
 * case so a case-insensitive filesystem cannot collide either.
 */
export async function savePages(
  streams: Streams,
  ctx: Context,
  data: unknown,
  folder: PathSpec,
): Promise<void> {
  const vfs = ctx.vfs
  if (vfs === undefined) throw new Error('no workspace files')
  await ensureDir(vfs, folder)
  const used = new Set<string>()
  for (const page of items(field(data, 'results'))) {
    const content = field(page, 'raw_content')
    if (!truthy(content)) continue
    const url = field(page, 'url')
    const urlText = url === undefined || url === null ? '' : jsText(url)
    const slug = pageSlug(urlText)
    let name = slug
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${slug}-${String(n)}`
    used.add(name.toLowerCase())
    await vfs.write(folder.join(`${name}.md`), ENC.encode(`# ${urlText}\n\n${jsText(content)}\n`))
  }
  streams.err(`Saved ${String(used.size)} pages to ${folder.rawPath}/`)
}

/** Crawl a website from a URL, every page with its content. */
export async function crawl(
  accessor: TavilyAccessor,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags, ctx.spec)
  const urlOrRefusal = singleUrl(texts, 'crawl')
  const url = typeof urlOrRefusal === 'string' ? urlOrRefusal : ''
  let body: Record<string, JsonValue>
  try {
    body = siteBody(fl, url)
    defined(
      body,
      'chunks_per_source',
      typedNumber(fl, 'chunks_per_source', '--chunks-per-source <n>', { integer: true }),
    )
    pageOptions(fl, body)
  } catch (err) {
    if (err instanceof InvalidOption) return usage(err.message)
    throw err
  }
  if (typeof urlOrRefusal !== 'string') return urlOrRefusal
  const output = resolveOutput(fl, ctx, 'crawl', hostOf(url))
  if (accessor.config.apiKey === undefined) return requireKey('crawl')
  const [filled, timeout] = timedBody(body, SITE_TIMEOUT)
  const data = await tavilyRequest(accessor, 'POST', 'crawl', filled, {
    timeout,
    clientName: clientNameOf(fl),
  })
  const streams = new Streams()
  const folder = fl.asPath('output_dir')
  if (folder !== undefined) {
    await savePages(streams, ctx, data, folder)
    if (jsonRequested(fl, output)) await emit(streams, ctx, jsonText(data, true), output)
    return streams.result()
  }
  if (jsonRequested(fl, output)) {
    await emit(streams, ctx, jsonText(data, true), output)
    return streams.result()
  }
  streams.stdout.push(pagesText(items(field(data, 'results'))))
  return streams.result()
}

/** Discover the URLs of a website, without their content. */
export async function mapSite(
  accessor: TavilyAccessor,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags, ctx.spec)
  const urlOrRefusal = singleUrl(texts, 'map')
  const url = typeof urlOrRefusal === 'string' ? urlOrRefusal : ''
  let body: Record<string, JsonValue>
  try {
    body = siteBody(fl, url)
  } catch (err) {
    if (err instanceof InvalidOption) return usage(err.message)
    throw err
  }
  if (typeof urlOrRefusal !== 'string') return urlOrRefusal
  const output = resolveOutput(fl, ctx, 'map', hostOf(url))
  if (accessor.config.apiKey === undefined) return requireKey('map')
  const [filled, timeout] = timedBody(body, SITE_TIMEOUT)
  const data = await tavilyRequest(accessor, 'POST', 'map', filled, {
    timeout,
    clientName: clientNameOf(fl),
  })
  const streams = new Streams()
  if (jsonRequested(fl, output)) {
    await emit(streams, ctx, jsonText(data, true), output)
    return streams.result()
  }
  for (const found of items(field(data, 'results'))) streams.out(plain(found))
  return streams.result()
}
