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

// `tvly search` adapted from tvly 1.0.2's src/commands/search.ts,
// src/core/search-flags.ts and src/ui/render/search.ts; the flags are
// @tavily/core 1.1.0's search parameter catalog, in the order tvly lists them
// (MIT; see licenses/third_party/tavily-cli.txt).

import type { TavilyAccessor } from '../../../../accessor/tavily.ts'
import {
  TavilyAPIError,
  TavilyKeylessLimit,
  TavilyUnanswered,
  tavilyRequest,
} from '../../../../core/tavily/client.ts'
import { SEARCH_TIMEOUT } from '../../../../core/tavily/constants.ts'
import { IOResult, materialize, type CommandOutput } from '../../../../io/types.ts'
import type { JsonValue, PathSpec } from '../../../../types.ts'
import type { CommandFnResult, Context } from '../../../config.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import {
  AUTH_EXIT,
  API_EXIT,
  LIMIT_STATUSES,
  keylessCapError,
  keylessCapHit,
  usage,
} from './failure.ts'
import { InvalidOption, checkChoice, clientNameOf, parseNumber } from './options.ts'
import { Streams, emit, resolveOutput } from './output.ts'
import {
  field,
  items,
  jsText,
  jsTrim,
  jsonText,
  plain,
  snippet,
  truthy,
  utf16Slice,
} from './render.ts'

const DEC = new TextDecoder()
const MAX_QUERIES = 5
const DEFAULT_CHARS = 600
const MAX_STDIN_CHARS = 100_000
const QUERY_REQUIRED =
  "error: QUERY is required. Pass a query string or use '-' to read from stdin."
const MAX_CHARS_FLAGS = '--max-chars <n>'

export type Kind = 'value' | 'switch' | 'optional' | 'list' | 'integer' | 'number'

/** One search option, from the SDK's parameter catalog. */
export class SearchFlag {
  readonly choices: readonly string[]
  readonly minimum: number | undefined
  readonly maximum: number | undefined
  readonly bare: string | undefined

  constructor(
    readonly key: string,
    readonly flag: string,
    readonly kind: Kind,
    readonly help: string,
    extra: { choices?: readonly string[]; minimum?: number; maximum?: number; bare?: string } = {},
  ) {
    this.choices = extra.choices ?? []
    this.minimum = extra.minimum
    this.maximum = extra.maximum
    this.bare = extra.bare
  }

  get dest(): string {
    return this.flag.slice(2).replaceAll('-', '_')
  }

  /** The option as commander's help and refusals spell it. */
  get flags(): string {
    if (this.kind === 'switch') return this.flag
    if (this.kind === 'optional') return `${this.flag} [value]`
    const placeholder: Partial<Record<Kind, string>> = {
      list: '<list>',
      integer: '<n>',
      number: '<n>',
    }
    return `${this.flag} ${placeholder[this.kind] ?? '<value>'}`
  }
}

export const SEARCH_FLAGS: readonly SearchFlag[] = [
  new SearchFlag(
    'search_depth',
    '--depth',
    'value',
    'Search strategy: basic for quick retrieval, advanced for deeper coverage, fast for lower latency, or ultra-fast for the lowest latency.',
    { choices: ['basic', 'advanced', 'fast', 'ultra-fast'] },
  ),
  new SearchFlag('max_results', '--max-results', 'integer', 'Result count limit.', {
    minimum: 0,
    maximum: 20,
  }),
  new SearchFlag('topic', '--topic', 'value', 'Search category.', {
    choices: ['general', 'news', 'finance'],
  }),
  new SearchFlag(
    'time_range',
    '--time-range',
    'value',
    'Relative date window; single-letter aliases are accepted.',
    { choices: ['year', 'month', 'week', 'day', 'y', 'm', 'w', 'd'] },
  ),
  new SearchFlag('start_date', '--start-date', 'value', 'Start of the date window (YYYY-MM-DD).'),
  new SearchFlag('end_date', '--end-date', 'value', 'End of the date window (YYYY-MM-DD).'),
  new SearchFlag('include_domains', '--include-domains', 'list', 'Domains to include or prefer.'),
  new SearchFlag('exclude_domains', '--exclude-domains', 'list', 'Domains to omit.'),
  new SearchFlag('country', '--country', 'value', 'Country preference for results.'),
  new SearchFlag(
    'include_answer',
    '--include-answer',
    'optional',
    'Request a generated answer; true selects the basic answer mode.',
    { choices: ['basic', 'advanced', 'false', 'true'], bare: 'basic' },
  ),
  new SearchFlag(
    'include_raw_content',
    '--include-raw-content',
    'optional',
    'Return page content in the selected format, or disable it with false.',
    { choices: ['markdown', 'text', 'false'], bare: 'markdown' },
  ),
  new SearchFlag(
    'include_images',
    '--include-images',
    'switch',
    'Request images alongside text results.',
  ),
  new SearchFlag(
    'include_image_descriptions',
    '--include-image-descriptions',
    'switch',
    'Request descriptions for returned images.',
  ),
  new SearchFlag(
    'chunks_per_source',
    '--chunks-per-source',
    'integer',
    'Content chunks per source for advanced search.',
    { minimum: 1, maximum: 3 },
  ),
  new SearchFlag(
    'auto_parameters',
    '--auto-parameters',
    'switch',
    'Let Tavily choose search settings from the query.',
  ),
  new SearchFlag(
    'cache_fallback',
    '--cache-fallback',
    'switch',
    'Allow cached content when live fetching fails.',
  ),
  new SearchFlag('days', '--days', 'number', 'Lookback in days for news searches.'),
  new SearchFlag(
    'exact_match',
    '--exact-match',
    'switch',
    'Require exact matches for quoted phrases in the query.',
  ),
  new SearchFlag(
    'fetch_timeout',
    '--fetch-timeout',
    'number',
    'Live-fetch time budget in seconds.',
  ),
  new SearchFlag(
    'filter_by_language',
    '--filter-by-language',
    'switch',
    'Restrict results to the requested language.',
  ),
  new SearchFlag(
    'filter_by_published_date',
    '--filter-by-published-date',
    'switch',
    'Exclude undated results and results outside the requested date window; also enables publication dates.',
  ),
  new SearchFlag(
    'include_domains_mode',
    '--include-domains-mode',
    'value',
    'How to apply includeDomains.',
    { choices: ['restrict', 'prefer'] },
  ),
  new SearchFlag('include_favicon', '--include-favicon', 'switch', 'Request site icons.'),
  new SearchFlag(
    'include_published_date',
    '--include-published-date',
    'switch',
    'Request detected publication dates.',
  ),
  new SearchFlag('include_usage', '--include-usage', 'switch', 'Request credit usage details.'),
  new SearchFlag('language', '--language', 'value', 'Preferred content language.'),
  new SearchFlag(
    'max_age_hours',
    '--max-age-hours',
    'number',
    'Maximum acceptable cache age in hours.',
  ),
  new SearchFlag('safe_search', '--safe-search', 'switch', 'Filter explicit content from results.'),
]

// The SDK catalog's own key order, which is the order tvly fills the request
// body in; the flags above are listed in its help order.
export const BODY_ORDER: readonly string[] = [
  'search_depth',
  'topic',
  'days',
  'max_results',
  'include_images',
  'include_image_descriptions',
  'include_answer',
  'include_raw_content',
  'include_domains',
  'exclude_domains',
  'include_domains_mode',
  'time_range',
  'chunks_per_source',
  'country',
  'start_date',
  'end_date',
  'max_age_hours',
  'auto_parameters',
  'include_favicon',
  'include_usage',
  'exact_match',
  'fetch_timeout',
  'cache_fallback',
  'language',
  'filter_by_language',
  'safe_search',
  'include_published_date',
  'filter_by_published_date',
]

/** One typed value of a search option, as the request carries it. */
export function flagValue(flag: SearchFlag, raw: string | boolean): JsonValue {
  if (flag.kind === 'switch') return true
  if (flag.kind === 'optional') {
    const text = raw === true || raw === '' ? (flag.bare ?? '') : String(raw)
    const value = checkChoice(text, flag.flags, flag.choices)
    return value === 'true' ? true : value === 'false' ? false : value
  }
  const text = String(raw)
  if (flag.kind === 'list') {
    return text
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
  }
  if (flag.kind === 'integer' || flag.kind === 'number') {
    return parseNumber(text, flag.flags, {
      integer: flag.kind === 'integer',
      ...(flag.minimum !== undefined ? { minimum: flag.minimum } : {}),
      ...(flag.maximum !== undefined ? { maximum: flag.maximum } : {}),
    })
  }
  return flag.choices.length > 0 ? checkChoice(text, flag.flags, flag.choices) : text
}

/** The request fields the line's search options set. */
export function searchBody(fl: FlagView): Record<string, JsonValue> {
  const byDest = new Map(SEARCH_FLAGS.map((flag) => [flag.dest, flag]))
  const values = new Map<string, JsonValue>()
  for (const [dest, raw] of fl.occurrences(...byDest.keys())) {
    const flag = byDest.get(dest)
    if (flag !== undefined && (typeof raw === 'string' || typeof raw === 'boolean')) {
      values.set(flag.key, flagValue(flag, raw))
    }
  }
  const body: Record<string, JsonValue> = {}
  for (const key of BODY_ORDER) {
    const value = values.get(key)
    if (value === undefined || value === null || (Array.isArray(value) && value.length === 0)) {
      continue
    }
    body[key] = value
  }
  return body
}

/** The queries a line asks, or tvly's refusal of them. */
export async function readQueries(
  texts: readonly string[],
  ctx: Context,
): Promise<string[] | CommandOutput> {
  let queries: string[]
  if (texts.length === 1 && texts[0] === '-') {
    const piped = ctx.stdin === null ? '' : DEC.decode(await materialize(ctx.stdin))
    const query = jsTrim(utf16Slice(piped, MAX_STDIN_CHARS))
    queries = query ? [query] : []
  } else {
    queries = texts.filter((query) => jsTrim(query))
  }
  if (queries.length === 0) return usage(QUERY_REQUIRED)
  if (queries.length > MAX_QUERIES) {
    return usage(
      `error: At most ${String(MAX_QUERIES)} queries per command, got ${String(queries.length)}.`,
    )
  }
  return queries
}

export function imageUrl(image: unknown): unknown {
  if (typeof image === 'object' && image !== null) {
    const url = field(image, 'url')
    return url ?? jsonText(image, false)
  }
  return image
}

/** One search's answer as tvly prints it to a pipe. */
export function resultsText(streams: Streams, data: unknown, maxChars: number): void {
  const results = items(field(data, 'results'))
  const answer = field(data, 'answer')
  if (truthy(answer)) streams.out(`Answer: ${plain(answer)}\n`)
  results.forEach((result, index) => {
    const title = field(result, 'title')
    streams.out(`${String(index + 1)}. ${plain(truthy(title) ? title : 'Untitled')}`)
    streams.out(plain(field(result, 'url') ?? ''))
    const content = field(result, 'content')
    if (truthy(content)) streams.out(snippet(content, maxChars))
    streams.out()
  })
  if (results.length === 0) streams.out('No results found.')
  for (const image of items(field(data, 'images'))) {
    streams.out(`Image: ${plain(imageUrl(image))}`)
  }
}

/** Search the web; up to five queries run in parallel. */
export async function search(
  accessor: TavilyAccessor,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const fl = new FlagView(ctx.flags, ctx.spec)
  const json = fl.asBool('json')
  let body: Record<string, JsonValue>
  let maxChars: number | undefined
  try {
    body = searchBody(fl)
    for (const [, raw] of fl.texts('max_chars')) {
      maxChars = parseNumber(raw, MAX_CHARS_FLAGS, { integer: true, minimum: 0 })
    }
  } catch (err) {
    if (err instanceof InvalidOption) return usage(err.message)
    throw err
  }
  const asked = await readQueries(texts, ctx)
  if (asked[1] instanceof IOResult) return asked as CommandOutput
  const queries = asked as string[]
  const output = resolveOutput(fl, ctx, 'search', queries[0] ?? '')
  const chars = maxChars ?? Math.floor(DEFAULT_CHARS / queries.length)
  const clientName = clientNameOf(fl)
  const streams = new Streams()

  const one = (query: string): Promise<unknown> =>
    tavilyRequest(
      accessor,
      'POST',
      'search',
      { query, ...body },
      { timeout: SEARCH_TIMEOUT, clientName },
    )

  if (queries.length === 1) {
    const data = await one(queries[0] ?? '')
    if (json || output !== undefined) {
      await emit(streams, ctx, jsonText(data, true), output)
      if (json) return streams.result()
    }
    resultsText(streams, data, chars)
    return streams.result()
  }

  const caps: TavilyKeylessLimit[] = []
  const limits: TavilyAPIError[] = []
  const guardedOne = async (query: string): Promise<unknown> => {
    try {
      return await one(query)
    } catch (err) {
      if (err instanceof TavilyKeylessLimit) {
        caps.push(err)
        return { query, error: keylessCapError(err) }
      }
      if (err instanceof TavilyAPIError || err instanceof TavilyUnanswered) {
        if (
          err instanceof TavilyAPIError &&
          err.status !== null &&
          LIMIT_STATUSES.has(err.status)
        ) {
          limits.push(err)
        }
        return { query, error: err.message }
      }
      throw err
    }
  }
  const responses = await Promise.all(queries.map(guardedOne))
  const first = caps[0]
  if (first !== undefined && !json) {
    keylessCapHit(streams, first)
    return streams.result(AUTH_EXIT)
  }
  if (json || output !== undefined) await emit(streams, ctx, jsonText(responses, true), output)
  const failed = (response: unknown): boolean =>
    typeof response === 'object' && response !== null && 'error' in response
  if (!json) {
    responses.forEach((response, index) => {
      streams.out(
        `=== [${String(index + 1)}/${String(responses.length)}] ${plain(field(response, 'query') ?? '')}`,
      )
      if (failed(response)) {
        const error = field(response, 'error')
        const text = typeof error === 'object' && error !== null ? field(error, 'message') : error
        streams.out(`error: ${plain(jsText(text))}\n`)
      } else {
        resultsText(streams, response, chars)
      }
    })
  }
  if (responses.every(failed))
    return streams.result(caps.length > 0 || limits.length > 0 ? AUTH_EXIT : API_EXIT)
  return streams.result()
}
