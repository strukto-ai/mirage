import type { Mem0Accessor } from '../../accessor/mem0.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { FileStat, FileType, type PathSpec } from '../../types.ts'
import { enoent, enotdir } from '../../utils/errors.ts'
import { formatScore } from '../../utils/score.ts'
import { rstripSlash, stripSlash } from '../../utils/slash.ts'
import { getAllMemories, getMemory, searchMemories } from './api.ts'

const ENCODER = new TextEncoder()

type Mem0Scope = { level: 'root' } | { level: 'memory'; memoryId: string } | { level: 'invalid' }

function detect(path: PathSpec): Mem0Scope {
  const key = stripSlash(path.resourcePath)
  if (key === '') return { level: 'root' }
  const parts = key.split('/')
  if (parts.some((part) => part.startsWith('.'))) return { level: 'invalid' }
  if (parts.length === 1 && key.length > 5 && key.endsWith('.json')) {
    return { level: 'memory', memoryId: key.slice(0, -5) }
  }
  return { level: 'invalid' }
}

function jsonBytes(memory: Record<string, unknown>): Uint8Array {
  return ENCODER.encode(JSON.stringify(memory, null, 2))
}

function cachedMemory(
  index: IndexCacheStore | undefined,
  path: PathSpec,
): Promise<Record<string, unknown> | null> {
  if (index === undefined) return Promise.resolve(null)
  return index.get(path.virtual).then((lookup) => {
    const value = lookup.entry?.extra.memory
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  })
}

async function resolveMemory(
  accessor: Mem0Accessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<Record<string, unknown>> {
  const scope = detect(path)
  if (scope.level !== 'memory') throw enoent(path)
  return (await cachedMemory(index, path)) ?? getMemory(accessor, scope.memoryId, path)
}

export async function read(
  accessor: Mem0Accessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<Uint8Array> {
  return jsonBytes(await resolveMemory(accessor, path, index))
}

export async function* stream(
  accessor: Mem0Accessor,
  path: PathSpec,
  index?: IndexCacheStore,
): AsyncIterable<Uint8Array> {
  yield await read(accessor, path, index)
}

export async function readdir(
  accessor: Mem0Accessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<string[]> {
  const scope = detect(path)
  if (scope.level === 'invalid') throw enoent(path)
  if (scope.level !== 'root') throw enotdir(path)
  if (index !== undefined) {
    const cached = await index.listDir(path.virtual)
    if (cached.entries !== undefined && cached.entries !== null) return cached.entries
  }
  const entries: [string, IndexEntry][] = []
  const names: string[] = []
  for (const memory of await getAllMemories(accessor)) {
    const id = String(memory.id)
    const filename = `${id}.json`
    entries.push([
      filename,
      new IndexEntry({
        id,
        name: filename,
        resourceType: 'mem0/memory',
        vfsName: filename,
        size: jsonBytes(memory).length,
        remoteTime:
          typeof memory.updated_at === 'string'
            ? memory.updated_at
            : typeof memory.created_at === 'string'
              ? memory.created_at
              : '',
        extra: { memory },
      }),
    ])
    names.push(`${rstripSlash(path.virtual)}/${filename}`)
  }
  if (index !== undefined) await index.setDir(path.virtual, entries)
  return names
}

function fileStat(memory: Record<string, unknown>): FileStat {
  return new FileStat({
    name: `${String(memory.id)}.json`,
    type: FileType.JSON,
    size: jsonBytes(memory).length,
    modified:
      typeof memory.updated_at === 'string'
        ? memory.updated_at
        : typeof memory.created_at === 'string'
          ? memory.created_at
          : null,
    extra: { created_at: memory.created_at, updated_at: memory.updated_at },
  })
}

export async function stat(
  accessor: Mem0Accessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<FileStat> {
  const scope = detect(path)
  if (scope.level === 'root') return new FileStat({ name: '/', type: FileType.DIRECTORY })
  if (scope.level !== 'memory') throw enoent(path)
  return fileStat(await resolveMemory(accessor, path, index))
}

export async function searchRendered(
  accessor: Mem0Accessor,
  query: string,
  mountPrefix: string,
  topK: number,
  threshold: number,
  memoryIds?: ReadonlySet<string>,
): Promise<Uint8Array> {
  if (query === '') throw new Error('search: query is required')
  if (!Number.isInteger(topK) || topK <= 0) throw new Error('search: top-k must be positive')
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error('search: threshold must be in [0, 1]')
  }
  const lines: string[] = []
  for (const result of await searchMemories(accessor, query, topK, threshold)) {
    const id = String(result.id)
    if (memoryIds !== undefined && !memoryIds.has(id)) continue
    const path = `${rstripSlash(mountPrefix)}/${id}.json`
    const score = formatScore(result.score)
    const memory = typeof result.memory === 'string' ? result.memory : ''
    lines.push(`${score === null ? path : `${path}:${score}`}\n${memory}`)
  }
  return ENCODER.encode(lines.length === 0 ? '' : `${lines.join('\n')}\n`)
}
