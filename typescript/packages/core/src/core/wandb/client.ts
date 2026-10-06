import { apiRequest } from '../api/client.ts'
import { eacces, enoent } from '../../errors/fs.ts'
import { WandbAPIError } from './errors.ts'
import type { WandbConfig } from './config.ts'
import type { Connection, Named, Run, RunFile, FileMetadata, RunVariables } from './types.ts'
import { PROJECTS, RUNS, RUN, FILE, FILES, HISTORY, HISTORY_KEYS } from './queries.ts'

function responseError(response: Response): Error {
  if ([401, 403].includes(response.status))
    return eacces('W&B authentication or authorization failed')
  return new WandbAPIError(`W&B HTTP ${String(response.status)}`)
}

export class WandbClient {
  constructor(readonly config: WandbConfig) {}
  headers(): Record<string, string> {
    if (!this.config.apiKey) return {}
    const bytes = new TextEncoder().encode(`api:${this.config.apiKey}`)
    return {
      Authorization: `Basic ${btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''))}`,
    }
  }
  async request<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const result = (await apiRequest('POST', this.config.baseUrl.replace(/\/$/, '') + '/graphql', {
      errorOf: responseError,
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      json: { query, variables },
    })) as { data?: T; errors?: unknown[] }
    if (result.errors?.length) throw new WandbAPIError('W&B GraphQL request failed')
    if (result.data === undefined || result.data === null)
      throw new WandbAPIError('W&B response has no data')
    return result.data
  }
  async pages<T>(query: string, variables: Record<string, unknown>, keys: string[]): Promise<T[]> {
    let cursor: string | null = null
    const seen = new Set<string>()
    const rows: T[] = []
    for (let page = 0; page < this.config.maxPages; page++) {
      let data: unknown = await this.request(query, {
        ...variables,
        cursor,
        perPage: this.config.pageSize,
      })
      for (const key of keys) {
        data = (data as Record<string, unknown>)[key]
        if (data === null) throw enoent('W&B object not found')
      }
      const connection = data as Connection<T>
      rows.push(...connection.edges.map((edge) => edge.node))
      if (!connection.pageInfo.hasNextPage) return rows
      cursor = connection.pageInfo.endCursor
      if (!cursor || seen.has(cursor)) throw new WandbAPIError('W&B pagination did not advance')
      seen.add(cursor)
    }
    throw new WandbAPIError('W&B pagination limit exceeded')
  }
  projects(entity: string): Promise<Named[]> {
    return this.pages(PROJECTS, { entity }, ['models'])
  }
  runs(entity: string, project: string): Promise<Named[]> {
    return this.pages(RUNS, { entity, project }, ['project', 'runs'])
  }
  async run(variables: RunVariables, query = RUN): Promise<Run> {
    const data = await this.request<{ project: { run: Run | null } | null }>(query, {
      ...variables,
    })
    if (!data.project?.run) throw enoent('W&B run not found')
    return data.project.run
  }
  files(variables: RunVariables): Promise<FileMetadata[]> {
    return this.pages(FILES, { ...variables }, ['project', 'run', 'files'])
  }
  async file(variables: RunVariables, name: string): Promise<RunFile | null> {
    const data = await this.request<{
      project: { run: { files: { edges: { node: RunFile }[] } } | null } | null
    }>(FILE, { ...variables, names: [name] })
    if (!data.project?.run) throw enoent('W&B run not found')
    return data.project.run.files.edges[0]?.node ?? null
  }
  async *history(variables: RunVariables): AsyncGenerator<Record<string, unknown>> {
    const run = await this.run(variables, HISTORY_KEYS)
    const last = run.historyKeys?.lastStep ?? -1
    if (!Number.isSafeInteger(last) || last < -1)
      throw new WandbAPIError('W&B invalid last history step')
    const size = this.config.pageSize
    if (Math.floor((last + size) / size) > this.config.maxPages)
      throw new WandbAPIError('W&B history pagination limit exceeded')
    for (let start = 0; start <= last; start += size) {
      const stop = Math.min(start + size, last + 1)
      const queryStart = stop - start === 1 ? Math.max(0, start - 1) : start
      const queryStop = Math.max(stop, queryStart + 2)
      const data = await this.request<{ project: { run: { history: string[] } | null } | null }>(
        HISTORY,
        {
          ...variables,
          minStep: queryStart,
          maxStep: queryStop,
          pageSize: Math.max(size, queryStop - queryStart),
        },
      )
      if (!data.project?.run) throw enoent('W&B run not found')
      for (const raw of data.project.run.history) {
        const row = JSON.parse(raw) as Record<string, unknown>
        if (
          (queryStart === start && queryStop === stop) ||
          (typeof row._step === 'number' && start <= row._step && row._step < stop)
        )
          yield row
      }
    }
  }
  async *download(url: string): AsyncGenerator<Uint8Array> {
    const target = new URL(url, this.config.baseUrl + '/')
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password)
      throw new WandbAPIError('W&B invalid download URL')
    const headers = target.origin === new URL(this.config.baseUrl).origin ? this.headers() : {}
    const response = await fetch(target, { headers })
    if (!response.ok) throw responseError(response)
    if (!response.body) throw new WandbAPIError('W&B download has no body')
    const reader = response.body.getReader()
    try {
      let next = await reader.read()
      while (!next.done) {
        yield next.value
        next = await reader.read()
      }
    } finally {
      await reader.cancel()
      reader.releaseLock()
    }
  }
}
