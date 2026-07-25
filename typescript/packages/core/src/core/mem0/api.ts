import { Mem0Error, type Mem0Accessor } from '../../accessor/mem0.ts'
import type { PathSpec } from '../../types.ts'
import { enoent } from '../../utils/errors.ts'

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === 'object' && !Array.isArray(item),
      )
    : []
}

export async function getAllMemories(accessor: Mem0Accessor): Promise<Record<string, unknown>[]> {
  const results: Record<string, unknown>[] = []
  let page = 1
  for (;;) {
    const response = await accessor.request('POST', '/v3/memories/', {
      params: { page, page_size: accessor.config.defaultPageSize },
      json: { filters: accessor.config.scopeFilter },
    })
    const batch = records(response.results)
    results.push(...batch)
    if (!response.next || batch.length === 0) return results
    page += 1
  }
}

// A deleted or unknown memory id 404s; filesystem callers need ENOENT so
// `test -e`, `cat` and friends report "No such file or directory" instead
// of leaking the provider error.
export async function getMemory(
  accessor: Mem0Accessor,
  memoryId: string,
  path: PathSpec,
): Promise<Record<string, unknown>> {
  try {
    return await accessor.request('GET', `/v1/memories/${encodeURIComponent(memoryId)}/`)
  } catch (error) {
    if (error instanceof Mem0Error && error.status === 404) throw enoent(path)
    throw error
  }
}

export async function searchMemories(
  accessor: Mem0Accessor,
  query: string,
  topK: number,
  threshold: number,
): Promise<Record<string, unknown>[]> {
  const response = await accessor.request('POST', '/v3/memories/search/', {
    json: { query, filters: accessor.config.scopeFilter, top_k: topK, threshold },
  })
  return records(response.results)
}
