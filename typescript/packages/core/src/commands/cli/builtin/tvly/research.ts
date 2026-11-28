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

// `tvly research` adapted from tvly 1.0.2's src/commands/research.ts,
// src/core/sse.ts and src/ui/render/research.ts (MIT; see
// licenses/third_party/tavily-cli.txt).

import type { TavilyAccessor } from '../../../../accessor/tavily.ts'
import { callerSignal } from '../../../../context/session_context.ts'
import { TavilyUnanswered, tavilyRequest } from '../../../../core/tavily/client.ts'
import { RESEARCH_GET_TIMEOUT } from '../../../../core/tavily/constants.ts'
import { isMissingPath } from '../../../../errors/fs.ts'
import { IOResult, materialize, type CommandOutput } from '../../../../io/types.ts'
import type { JsonValue, PathSpec } from '../../../../types.ts'
import { sleep } from '../../../../utils/abort.ts'
import { systemNow } from '../../../../utils/clock.ts'
import type { CommandFnResult, Context } from '../../../config.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import { UsageStyle } from '../../../spec/types.ts'
import { nodeHelp } from '../../walk.ts'
import { requireKey, usage } from './failure.ts'
import { InvalidOption, clientNameOf, typedChoice, typedNumber } from './options.ts'
import { Streams, emit, resolveOutput } from './output.ts'
import {
  field,
  items,
  jsText,
  jsTrim,
  jsonText,
  plain,
  sanitizeControl,
  truthy,
  utf16Slice,
} from './render.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const SUBCOMMANDS = new Set(['run', 'status', 'poll'])
const NEED_ID = new Set(['status', 'poll'])
const MODELS = ['mini', 'pro', 'auto'] as const
const CITATION_FORMATS = ['numbered', 'mla', 'apa', 'chicago'] as const
const DEFAULT_POLL_INTERVAL = 10
const DEFAULT_TIMEOUT = 600
const MAX_STDIN_CHARS = 100_000
const QUERY_REQUIRED =
  "error: QUERY is required. Pass a query string or use '-' to read from stdin."
// What `research status` and `research poll` do not take, by dest and
// spelling: the line names them only on `run`.
const RUN_ONLY: readonly (readonly [string, string])[] = [
  ['model', '--model'],
  ['no_wait', '--no-wait'],
  ['stream', '--stream'],
  ['output_schema', '--output-schema'],
  ['citation_format', '--citation-format'],
]
const STATUS_REFUSES: readonly (readonly [string, string])[] = [
  ...RUN_ONLY,
  ['output', '-o'],
  ['poll_interval', '--poll-interval'],
  ['timeout', '--timeout'],
]

/**
 * Which research verb a line means, and its operands. A first word that is no
 * verb is a query for `run`, and so is `status` or `poll` with no id after it;
 * `run` always stays the verb, so `run run` researches the word "run".
 */
export function route(words: readonly string[]): [string, string[]] {
  const first = words[0] ?? ''
  if (!SUBCOMMANDS.has(first)) return ['run', [...words]]
  if (NEED_ID.has(first) && words.length < 2) return ['run', [...words]]
  return [first, words.slice(1)]
}

export function isDone(response: unknown): boolean {
  const status = field(response, 'status')
  return status === 'completed' || status === 'failed'
}

export function tooMany(verb: string, words: readonly string[]): CommandOutput {
  return usage(
    `error: too many arguments for '${verb}'. Expected 1 argument but got ${String(words.length)}: ${words.join(', ')}.`,
  )
}

/** A finished task as tvly prints it to a pipe. */
export async function resultText(
  streams: Streams,
  ctx: Context,
  jsonOut: boolean,
  data: unknown,
  output: PathSpec | undefined,
): Promise<void> {
  if (jsonOut || output !== undefined) {
    await emit(streams, ctx, jsonText(data, true), output)
    return
  }
  const status = field(data, 'status')
  if (status !== 'completed') {
    streams.out(`Status: ${sanitizeControl(status ?? 'unknown')}`)
    const error = field(data, 'error')
    if (truthy(error)) streams.out(`Error: ${sanitizeControl(error)}`)
    return
  }
  const content = field(data, 'content')
  if (truthy(content)) streams.out(`${plain(content)}\n`)
  const sources = items(field(data, 'sources'))
  if (sources.length > 0) {
    streams.out('Sources:')
    sources.forEach((source, index) => {
      streams.out(
        `${String(index + 1)}. ${plain(field(source, 'title') ?? '')} ${plain(field(source, 'url') ?? '')}`,
      )
    })
  }
}

/** Poll until the task completes or fails; null once `timeout` seconds pass. */
export async function waitFor(
  accessor: TavilyAccessor,
  requestId: string,
  pollInterval: number,
  timeout: number,
  clientName: string | undefined,
): Promise<unknown> {
  const start = systemNow()
  const deadline = start + timeout
  let nextPoll = start
  while (systemNow() < deadline) {
    if (systemNow() >= nextPoll) {
      const response = await tavilyRequest(
        accessor,
        'GET',
        `research/${encodeURIComponent(requestId)}`,
        undefined,
        { timeout: RESEARCH_GET_TIMEOUT, clientName },
      )
      if (isDone(response)) return response
      nextPoll = systemNow() + Math.max(1, pollInterval)
    }
    await sleep(1000, callerSignal())
  }
  return null
}

export async function finishWait(
  streams: Streams,
  ctx: Context,
  fl: FlagView,
  response: unknown,
  requestId: string,
  output: PathSpec | undefined,
  timeout: number,
  hint = '',
): Promise<void> {
  if (response !== null) {
    await resultText(streams, ctx, fl.asBool('json'), response, output)
    return
  }
  if (fl.asBool('json')) {
    await emit(streams, ctx, jsonText({ request_id: requestId, status: 'timeout' }, false), output)
    return
  }
  streams.err(`Timed out after ${String(timeout)}s.${hint}`)
}

/**
 * The JSON payload of each SSE `data:` line; blank and non-JSON payloads
 * (`[DONE]`) are skipped.
 */
export function streamEvents(text: string): unknown[] {
  const events: unknown[] = []
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (!line.startsWith('data:')) continue
    const rest = line.slice(5)
    const payload = rest.startsWith(' ') ? rest.slice(1) : rest
    if (!jsTrim(payload)) continue
    try {
      events.push(JSON.parse(payload))
    } catch {
      continue
    }
  }
  return events
}

/** Show each tool step on stderr as it changes, then the joined content as the report. */
export async function streamed(
  streams: Streams,
  ctx: Context,
  events: readonly unknown[],
  output: PathSpec | undefined,
): Promise<void> {
  const parts: string[] = []
  let sources: unknown[] = []
  let current: string | undefined
  for (const event of events) {
    const choices = items(field(event, 'choices'))
    const delta = choices.length > 0 ? field(choices[0], 'delta') : undefined
    const toolCalls = field(delta, 'tool_calls')
    const kind = field(toolCalls, 'type')
    if (kind === 'tool_call') {
      for (const call of items(field(toolCalls, 'tool_call'))) {
        const name = jsText(field(call, 'name') ?? '')
        const args = field(call, 'arguments')
        const step = truthy(args) ? `${name}: ${jsText(args)}` : name
        if (step !== current) {
          current = step
          streams.err(`  ${sanitizeControl(step)}`)
        }
      }
    }
    if (kind === 'tool_response') {
      for (const answer of items(field(toolCalls, 'tool_response'))) {
        const count = items(field(answer, 'sources')).length
        if (field(answer, 'name') === 'WebSearch' && count) {
          streams.err(`  Found ${String(count)} sources`)
        }
      }
    }
    const content = field(delta, 'content')
    if (truthy(content)) parts.push(jsText(content))
    const found = items(field(delta, 'sources'))
    if (found.length > 0) sources = found
  }
  const report = { status: 'completed', content: parts.join(''), sources }
  await resultText(streams, ctx, false, report, output)
}

export async function run(
  accessor: TavilyAccessor,
  fl: FlagView,
  words: readonly string[],
  ctx: Context,
): Promise<CommandFnResult> {
  if (words.length > 1) return tooMany('run', words)
  let query = words[0] ?? ''
  if (query === '-') {
    const piped = ctx.stdin === null ? '' : DEC.decode(await materialize(ctx.stdin))
    query = utf16Slice(piped, MAX_STDIN_CHARS)
  }
  query = jsTrim(query)
  if (!query) return usage(QUERY_REQUIRED)
  const output = resolveOutput(fl, ctx, 'research', query)
  const body: Record<string, JsonValue> = { input: query }
  const model = typedChoice(fl, 'model', '--model <model>', MODELS)
  if (model !== undefined) body.model = model
  const schema = fl.asPath('output_schema')
  if (schema !== undefined) {
    const vfs = ctx.vfs
    if (vfs === undefined) throw new Error('no workspace files')
    let text: string
    try {
      text = DEC.decode(await vfs.read(schema))
    } catch (err) {
      if (!isMissingPath(err)) throw err
      return usage(
        `error: --output-schema must be a path to a JSON file: ENOENT: no such file or directory, open '${schema.rawPath}'`,
      )
    }
    try {
      body.output_schema = JSON.parse(text) as JsonValue
    } catch (err) {
      return usage(
        `error: --output-schema must be a path to a JSON file: ${(err as Error).message}`,
      )
    }
  }
  const citation = typedChoice(
    fl,
    'citation_format',
    '--citation-format <format>',
    CITATION_FORMATS,
  )
  if (citation !== undefined) body.citation_format = citation
  if (accessor.config.apiKey === undefined) return requireKey('research')
  const clientName = clientNameOf(fl)
  const streams = new Streams()
  if (fl.asBool('stream')) {
    const text = (await tavilyRequest(
      accessor,
      'POST',
      'research',
      { citation_format: 'numbered', ...body, stream: true },
      { clientName, read: 'text' },
    )) as string
    const events = streamEvents(text)
    if (fl.asBool('json')) {
      for (const event of events) streams.out(jsonText(event, false))
      return streams.result()
    }
    await streamed(streams, ctx, events, output)
    return streams.result()
  }
  const result = await tavilyRequest(
    accessor,
    'POST',
    'research',
    { stream: false, citation_format: 'numbered', ...body },
    { clientName },
  )
  if (isDone(result) || truthy(field(result, 'content'))) {
    await resultText(streams, ctx, fl.asBool('json'), result, output)
    return streams.result()
  }
  const requestId = field(result, 'request_id')
  if (typeof requestId !== 'string' || !requestId) {
    throw new TavilyUnanswered(`Unexpected API response: ${jsonText(result, false)}`)
  }
  if (fl.asBool('no_wait')) {
    const status = field(result, 'status')
    const pending = { request_id: requestId, status: (status ?? 'pending') as JsonValue }
    await emit(streams, ctx, jsonText(pending, false), output)
    return streams.result()
  }
  const timeout =
    typedNumber(fl, 'timeout', '--timeout <n>', { integer: true, fallback: DEFAULT_TIMEOUT }) ?? 0
  const interval =
    typedNumber(fl, 'poll_interval', '--poll-interval <n>', {
      integer: true,
      fallback: DEFAULT_POLL_INTERVAL,
    }) ?? 0
  const response = await waitFor(accessor, requestId, interval, timeout, clientName)
  const hint = ` Resume with: tvly research poll ${sanitizeControl(requestId)}`
  await finishWait(streams, ctx, fl, response, requestId, output, timeout, hint)
  return streams.result()
}

export async function status(
  accessor: TavilyAccessor,
  fl: FlagView,
  words: readonly string[],
): Promise<CommandFnResult> {
  if (words.length > 1) return tooMany('status', words)
  const requestId = words[0] ?? ''
  if (accessor.config.apiKey === undefined) return requireKey('research status')
  const response = await tavilyRequest(
    accessor,
    'GET',
    `research/${encodeURIComponent(requestId)}`,
    undefined,
    { timeout: RESEARCH_GET_TIMEOUT, clientName: clientNameOf(fl) },
  )
  const streams = new Streams()
  if (fl.asBool('json')) {
    streams.out(jsonText(response, false))
    return streams.result()
  }
  const state = field(response, 'status')
  const shown = state === undefined || state === null ? 'unknown' : jsText(state)
  const safeId = sanitizeControl(requestId)
  streams.out(`  Request:  ${safeId}`)
  streams.out(`  Status:   ${sanitizeControl(shown)}`)
  if (shown === 'completed') streams.out(`  Run 'tvly research poll ${safeId}' to view results.`)
  else if (shown === 'failed') {
    streams.out(`  Error: ${sanitizeControl(field(response, 'error') ?? 'Unknown error')}`)
  }
  return streams.result()
}

export async function poll(
  accessor: TavilyAccessor,
  fl: FlagView,
  words: readonly string[],
  ctx: Context,
): Promise<CommandFnResult> {
  if (words.length > 1) return tooMany('poll', words)
  const requestId = words[0] ?? ''
  const output = resolveOutput(fl, ctx, 'research', requestId)
  if (accessor.config.apiKey === undefined) return requireKey('research poll')
  const timeout =
    typedNumber(fl, 'timeout', '--timeout <n>', { integer: true, fallback: DEFAULT_TIMEOUT }) ?? 0
  const interval =
    typedNumber(fl, 'poll_interval', '--poll-interval <n>', {
      integer: true,
      fallback: DEFAULT_POLL_INTERVAL,
    }) ?? 0
  const response = await waitFor(accessor, requestId, interval, timeout, clientNameOf(fl))
  const streams = new Streams()
  await finishWait(streams, ctx, fl, response, requestId, output, timeout)
  return streams.result()
}

/** The first option the verb does not take, as the line spelled it. */
export function refusedOption(
  fl: FlagView,
  refused: readonly (readonly [string, string])[],
): string | undefined {
  const spelled = new Map(refused.map(([dest, spelling]) => [dest, spelling]))
  for (const [dest, value] of fl.occurrences(...spelled.keys())) {
    if (value !== false) return spelled.get(dest)
  }
  return undefined
}

/** Deep research: start a task, check one, or wait for one. */
export async function research(
  accessor: TavilyAccessor,
  _paths: PathSpec[],
  texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  if (texts.length === 0) {
    if (ctx.spec === undefined) throw new Error('research needs its spec')
    return [ENC.encode(nodeHelp('tvly research', ctx.spec, UsageStyle.COMMANDER)), new IOResult()]
  }
  const fl = new FlagView(ctx.flags, ctx.spec)
  const [verb, words] = route(texts)
  if (verb !== 'run') {
    const refused = refusedOption(fl, verb === 'status' ? STATUS_REFUSES : RUN_ONLY)
    if (refused !== undefined) return usage(`error: unknown option '${refused}'`)
  }
  try {
    typedNumber(fl, 'poll_interval', '--poll-interval <n>', { integer: true })
    typedNumber(fl, 'timeout', '--timeout <n>', { integer: true })
    if (verb === 'run') {
      typedChoice(fl, 'model', '--model <model>', MODELS)
      typedChoice(fl, 'citation_format', '--citation-format <format>', CITATION_FORMATS)
      return await run(accessor, fl, words, ctx)
    }
    if (verb === 'status') return await status(accessor, fl, words)
    return await poll(accessor, fl, words, ctx)
  } catch (err) {
    if (err instanceof InvalidOption) return usage(err.message)
    throw err
  }
}
