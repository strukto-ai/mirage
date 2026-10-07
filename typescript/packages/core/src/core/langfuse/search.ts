import { PathSpec } from '../../types.ts'
import type { SearchResult } from '../../vfs/types.ts'
import type { LangfuseAccessor } from '../../accessor/langfuse.ts'
import { fetchDatasets, fetchPrompts, fetchSessions, fetchTraces } from './client.ts'
import { SEARCH_KINDS } from './scope.ts'
import { queryMatcher, type LineMatcher, type Searcher } from '../hierarchy/search.ts'

function pickString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

function filterTraces(
  traces: readonly Record<string, unknown>[],
  matcher: LineMatcher,
): SearchResult[] {
  const lines: SearchResult[] = []
  for (const t of traces) {
    const traceId = pickString(t, 'id')
    const lineJson = JSON.stringify(t)
    if (!matcher(lineJson)) continue
    lines.push([
      PathSpec.fromStrPath(`/traces/${traceId}.json`),
      `traces/${traceId}.json:${lineJson}`,
    ])
  }
  return lines
}

function filterSessions(
  sessions: readonly Record<string, unknown>[],
  matcher: LineMatcher,
): SearchResult[] {
  const lines: SearchResult[] = []
  for (const s of sessions) {
    const sessionId = pickString(s, 'id')
    if (!matcher(sessionId)) continue
    lines.push([
      PathSpec.fromStrPath(`/sessions/${sessionId}`),
      `sessions/${sessionId}:${JSON.stringify(s)}`,
    ])
  }
  return lines
}

function filterPrompts(
  prompts: readonly Record<string, unknown>[],
  matcher: LineMatcher,
): SearchResult[] {
  const lines: SearchResult[] = []
  const seen = new Set<string>()
  for (const p of prompts) {
    const promptName = pickString(p, 'name')
    if (seen.has(promptName)) continue
    if (!matcher(promptName)) continue
    seen.add(promptName)
    lines.push([
      PathSpec.fromStrPath(`/prompts/${promptName}`),
      `prompts/${promptName}:${JSON.stringify(p)}`,
    ])
  }
  return lines
}

function filterDatasets(
  datasets: readonly Record<string, unknown>[],
  matcher: LineMatcher,
): SearchResult[] {
  const lines: SearchResult[] = []
  for (const d of datasets) {
    const datasetName = pickString(d, 'name')
    if (!matcher(datasetName)) continue
    lines.push([
      PathSpec.fromStrPath(`/datasets/${datasetName}`),
      `datasets/${datasetName}:${JSON.stringify(d)}`,
    ])
  }
  return lines
}

// The search push-down answers from the list endpoints (one call instead
// of one read per entry), so it greps listing summaries: a pattern that
// only occurs in a trace's observation bodies needs a file read to match.
const tracesSearcher: Searcher<LangfuseAccessor> = async (accessor, _match, query) => {
  const limit = accessor.config.defaultSearchLimit ?? 50
  const traces = await fetchTraces(accessor.transport, { limit })
  return filterTraces(traces, queryMatcher(query))
}

const sessionsSearcher: Searcher<LangfuseAccessor> = async (accessor, _match, query) => {
  const limit = accessor.config.defaultSearchLimit ?? 50
  const sessions = await fetchSessions(accessor.transport, { limit })
  return filterSessions(sessions, queryMatcher(query))
}

const promptsSearcher: Searcher<LangfuseAccessor> = async (accessor, _match, query) =>
  filterPrompts(await fetchPrompts(accessor.transport), queryMatcher(query))

const datasetsSearcher: Searcher<LangfuseAccessor> = async (accessor, _match, query) =>
  filterDatasets(await fetchDatasets(accessor.transport), queryMatcher(query))

const CONTAINERS: Readonly<Record<string, Searcher<LangfuseAccessor>>> = {
  traces: tracesSearcher,
  sessions: sessionsSearcher,
  prompts: promptsSearcher,
  datasets: datasetsSearcher,
}

export const SEARCHERS: Readonly<Record<string, Searcher<LangfuseAccessor>>> = Object.fromEntries(
  Object.entries(SEARCH_KINDS).flatMap(([kind, container]) => {
    const searcher = CONTAINERS[container]
    return searcher === undefined ? [] : [[kind, searcher] as const]
  }),
)
