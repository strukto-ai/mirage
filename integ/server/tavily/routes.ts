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

import { all, one, route } from '../kit/typescript/index.ts'
import type { Ctx, JsonValue, KitHandler, KitRoute, Reply } from '../kit/typescript/index.ts'
import { API_KEY } from './config.ts'
import type { C } from './config.ts'
import {
  RESPONSE_TIME,
  asked,
  chunk,
  contentPieces,
  errorBody,
  hitJson,
  imageJson,
  siteOf,
  sourceJson,
  stepDelta,
} from './views.ts'
import type { HitRow, ImageRow, PageRow, ResearchRow, RuleRow, SourceRow } from './views.ts'

const UNAUTHORIZED = 'Unauthorized: missing or invalid API key.'
const DEFAULT_MAX_RESULTS = 5
const DEFAULT_LIMIT = 50

type Body = Record<string, JsonValue>

function bodyOf(ctx: Ctx<C>): Body {
  const body = ctx.json()
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? body : {}
}

function textOf(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : ''
}

function countOf(value: JsonValue | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}

// A keyed request must carry the one key the fixture accepts; a keyless one
// (tvly with no key) is let through, as the API lets it through under a cap.
function authorized(ctx: Ctx<C>): boolean {
  if (ctx.headers['x-tavily-access-mode'] === 'keyless') return true
  return ctx.headers.authorization === `Bearer ${API_KEY}`
}

function guarded(handler: KitHandler<C>): KitHandler<C> {
  return (ctx) => (authorized(ctx) ? handler(ctx) : { status: 401, body: errorBody(UNAUTHORIZED) })
}

function matching<T extends { keywords: string }>(rows: T[], text: string): T | undefined {
  const lowered = text.toLowerCase()
  return rows.find((row) => row.keywords.split(' ').some((k) => k !== '' && lowered.includes(k)))
}

function search(ctx: Ctx<C>): Reply {
  const body = bodyOf(ctx)
  const query = textOf(body.query)
  const rules = all<RuleRow>(
    ctx.sql,
    'SELECT id, keywords, answer, status, error FROM TavilySearchRule WHERE tenant = ? ORDER BY seq',
    ctx.tenant,
  )
  const rule = matching(rules, query)
  if (rule?.status != null) {
    return { status: rule.status, body: errorBody(rule.error ?? '') }
  }
  const hits =
    rule === undefined
      ? []
      : all<HitRow>(
          ctx.sql,
          'SELECT title, url, content, rawContent, score FROM TavilySearchHit ' +
            'WHERE tenant = ? AND ruleId = ? ORDER BY seq',
          ctx.tenant,
          rule.id,
        )
  const images =
    rule === undefined || !asked(body.include_images)
      ? []
      : all<ImageRow>(
          ctx.sql,
          'SELECT url, description FROM TavilySearchImage WHERE tenant = ? AND ruleId = ? ORDER BY seq',
          ctx.tenant,
          rule.id,
        )
  const raw = asked(body.include_raw_content)
  const described = asked(body.include_image_descriptions)
  return {
    status: 200,
    body: {
      query,
      follow_up_questions: null,
      answer: asked(body.include_answer) ? (rule?.answer ?? null) : null,
      images: images.map((image) => imageJson(image, described)),
      results: hits
        .slice(0, countOf(body.max_results, DEFAULT_MAX_RESULTS))
        .map((hit) => hitJson(hit, raw)),
      response_time: RESPONSE_TIME,
      request_id: `req-search-${rule?.id ?? 'none'}`,
    },
  }
}

function extract(ctx: Ctx<C>): Reply {
  const body = bodyOf(ctx)
  const urls = Array.isArray(body.urls) ? body.urls.map(textOf) : [textOf(body.urls)]
  const images = asked(body.include_images)
  const results: JsonValue[] = []
  const failed: JsonValue[] = []
  for (const url of urls) {
    const page = one<PageRow>(
      ctx.sql,
      'SELECT url, site, rawContent FROM TavilyPage WHERE tenant = ? AND url = ?',
      ctx.tenant,
      url,
    )
    if (page === null) {
      failed.push({ url, error: 'Failed to fetch url' })
      continue
    }
    results.push(
      images
        ? { url: page.url, raw_content: page.rawContent, images: [] }
        : { url: page.url, raw_content: page.rawContent },
    )
  }
  return {
    status: 200,
    body: {
      results,
      failed_results: failed,
      response_time: RESPONSE_TIME,
      request_id: 'req-extract',
    },
  }
}

function pagesOf(ctx: Ctx<C>, body: Body): PageRow[] {
  const rows = all<PageRow>(
    ctx.sql,
    'SELECT url, site, rawContent FROM TavilyPage WHERE tenant = ? AND site = ? ORDER BY seq',
    ctx.tenant,
    siteOf(textOf(body.url)),
  )
  return rows.slice(0, countOf(body.limit, DEFAULT_LIMIT))
}

function crawl(ctx: Ctx<C>): Reply {
  const body = bodyOf(ctx)
  return {
    status: 200,
    body: {
      base_url: textOf(body.url),
      results: pagesOf(ctx, body).map((page) => ({
        url: page.url,
        raw_content: page.rawContent,
      })),
      response_time: RESPONSE_TIME,
      request_id: 'req-crawl',
    },
  }
}

function map(ctx: Ctx<C>): Reply {
  const body = bodyOf(ctx)
  return {
    status: 200,
    body: {
      base_url: textOf(body.url),
      results: pagesOf(ctx, body).map((page) => page.url),
      response_time: RESPONSE_TIME,
      request_id: 'req-map',
    },
  }
}

const RESEARCH =
  'SELECT id, keywords, status, content, error, steps, createdAt FROM TavilyResearch WHERE tenant = ?'

function sourcesOf(ctx: Ctx<C>, id: string): SourceRow[] {
  return all<SourceRow>(
    ctx.sql,
    'SELECT title, url FROM TavilyResearchSource WHERE tenant = ? AND researchId = ? ORDER BY seq',
    ctx.tenant,
    id,
  )
}

// The task the input names; a stream replays its steps and report, and a
// plain request answers it pending so the client polls GET for the result.
function startResearch(ctx: Ctx<C>): Reply {
  const body = bodyOf(ctx)
  const input = textOf(body.input)
  const task = matching(all<ResearchRow>(ctx.sql, `${RESEARCH} ORDER BY seq`, ctx.tenant), input)
  if (task === undefined) {
    return { status: 400, body: errorBody(`No research task matches: ${input}`) }
  }
  if (body.stream === true) {
    const sources = sourcesOf(ctx, task.id)
    const lines = (task.steps ?? '').split('\n').filter((line) => line !== '')
    const pieces = contentPieces(task.content ?? '')
    const events = [
      ...lines.map((line) => chunk(stepDelta(line, sources))),
      ...pieces.map((piece, i) =>
        chunk(
          i === pieces.length - 1
            ? { content: piece, sources: sources.map(sourceJson) }
            : { content: piece },
        ),
      ),
      'data: [DONE]\n\n',
    ]
    return {
      status: 200,
      body: Buffer.from(events.join(''), 'utf8'),
      headers: { 'Content-Type': 'text/event-stream' },
    }
  }
  return {
    status: 200,
    body: {
      request_id: task.id,
      created_at: task.createdAt,
      status: 'pending',
      input,
      model: textOf(body.model) || 'auto',
      response_time: RESPONSE_TIME,
    },
  }
}

function getResearch(ctx: Ctx<C>): Reply {
  const id = ctx.params.requestId ?? ''
  const task = one<ResearchRow>(ctx.sql, `${RESEARCH} AND id = ?`, ctx.tenant, id)
  if (task === null) return { status: 404, body: errorBody('Research task not found') }
  const reply: Record<string, JsonValue> = {
    request_id: task.id,
    created_at: task.createdAt,
    status: task.status,
  }
  if (task.content !== null) reply.content = task.content
  if (task.status === 'completed') reply.sources = sourcesOf(ctx, task.id).map(sourceJson)
  if (task.error !== null) reply.error = task.error
  reply.response_time = RESPONSE_TIME
  return { status: 200, body: reply }
}

export function tavilyRoutes(): KitRoute<C>[] {
  return [
    route<C>('POST', '/search', guarded(search)),
    route<C>('POST', '/extract', guarded(extract)),
    route<C>('POST', '/crawl', guarded(crawl)),
    route<C>('POST', '/map', guarded(map)),
    route<C>('POST', '/research', guarded(startResearch)),
    route<C>('GET', '/research/:requestId', guarded(getResearch)),
  ]
}
