import type { Metadata } from 'opendal'
import {
  keep,
  optionsTree,
  rstripSlash,
  startBasename,
  stripSlash,
  treeHasEmpty,
  type FindEntry,
  type FindOptions,
  type PathSpec,
  type PredNode,
} from '@struktoai/mirage-core'
import type { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import {
  searchFiles,
  supportsQuery,
  type Bounds,
  type FilesSearchQuery,
  type SearchEntry,
} from './search/index.ts'
import { isNotFound, rawPathOf } from './util.ts'

interface FindScope {
  baseKey: string
  scanKey: string
  startName: string
}

interface Candidate {
  key: string
  name: string
  kind: 'f' | 'd'
  size: number | null
  modified: number | null
  isEmpty: boolean | null
}

interface FindCriteria {
  predicate: PredNode
  size: Bounds
  modified: Bounds
  minDepth: number | null
  maxDepth: number | null
}

function findScope(path: PathSpec): FindScope {
  const relative = stripSlash(rawPathOf(path))
  return {
    baseKey: relative !== '' ? `/${relative}` : '/',
    scanKey: relative !== '' ? `${relative}/` : '/',
    startName: startBasename(path.virtual),
  }
}

function constrained(bounds: Bounds): boolean {
  return bounds.lower !== null || bounds.upper !== null
}

function contains(bounds: Bounds, value: number): boolean {
  if (bounds.lower !== null && value < bounds.lower) return false
  if (bounds.upper !== null && value > bounds.upper) return false
  return true
}

function scopeContains(scope: FindScope, key: string): boolean {
  if (scope.baseKey === '/') return key.startsWith('/')
  return key === scope.baseKey || key.startsWith(`${scope.baseKey}/`)
}

function depth(scope: FindScope, key: string): number {
  if (key === scope.baseKey) return 0
  const baseDepth = scope.baseKey === '/' ? 0 : (scope.baseKey.match(/\//g) ?? []).length
  return (key.match(/\//g) ?? []).length - baseDepth
}

function parentKeys(scope: FindScope, key: string): string[] {
  const keys: string[] = []
  let parent = key.slice(0, key.lastIndexOf('/')) || '/'
  while (scopeContains(scope, parent)) {
    keys.push(parent)
    if (parent === scope.baseKey) break
    parent = parent.slice(0, parent.lastIndexOf('/')) || '/'
  }
  return keys
}

function basename(key: string): string {
  return rstripSlash(key).split('/').pop() ?? ''
}

function modifiedTimestamp(metadata: Metadata): number | null {
  if (metadata.lastModified === null) return null
  const milliseconds = Date.parse(metadata.lastModified)
  return Number.isNaN(milliseconds) ? null : milliseconds / 1000
}

function candidateFromMetadata(key: string, name: string, metadata: Metadata): Candidate {
  const isDirectory = metadata.isDirectory()
  return {
    key,
    name,
    kind: isDirectory ? 'd' : 'f',
    size: isDirectory ? 0 : metadata.contentLength !== null ? Number(metadata.contentLength) : null,
    modified: modifiedTimestamp(metadata),
    isEmpty: null,
  }
}

function candidateFromSearch(entry: SearchEntry): Candidate {
  return { ...entry, isEmpty: null }
}

async function statCandidate(
  accessor: NextcloudAccessor,
  key: string,
  name: string,
): Promise<Candidate | null> {
  if (key === '/') {
    return { key, name, kind: 'd', size: 0, modified: null, isEmpty: null }
  }
  const op = await accessor.operator()
  const relative = stripSlash(key)
  let metadata: Metadata
  try {
    metadata = await op.stat(relative)
  } catch (error) {
    if (!isNotFound(error)) throw error
    try {
      metadata = await op.stat(`${relative}/`)
    } catch (directoryError) {
      if (isNotFound(directoryError)) return null
      throw directoryError
    }
  }
  return candidateFromMetadata(key, name, metadata)
}

function matches(candidate: Candidate, scope: FindScope, criteria: FindCriteria): boolean {
  if (!scopeContains(scope, candidate.key)) {
    throw new Error(`Nextcloud Files Search returned an out-of-scope path: ${candidate.key}`)
  }
  const candidateDepth = depth(scope, candidate.key)
  if (criteria.maxDepth !== null && candidateDepth > criteria.maxDepth) return false
  const entry: FindEntry = {
    key: candidate.key,
    name: candidate.name,
    kind: candidate.kind,
    depth: candidateDepth,
    isEmpty: candidate.isEmpty,
  }
  if (!keep(entry, criteria.predicate, criteria.minDepth)) return false
  if (constrained(criteria.size)) {
    const size = candidate.kind === 'd' ? 0 : (candidate.size ?? 0)
    if (!contains(criteria.size, size)) return false
  }
  if (constrained(criteria.modified)) {
    if (candidate.modified === null || !contains(criteria.modified, candidate.modified))
      return false
  }
  return true
}

function matchingKeys(
  candidates: Map<string, Candidate>,
  scope: FindScope,
  criteria: FindCriteria,
): string[] {
  return [...candidates.values()]
    .filter((candidate) => matches(candidate, scope, criteria))
    .map((candidate) => candidate.key)
    .sort()
}

function searchQuery(criteria: FindCriteria): FilesSearchQuery {
  return {
    tree: criteria.predicate,
    size: criteria.size,
    modified: criteria.modified,
  }
}

async function findWithSearch(
  accessor: NextcloudAccessor,
  path: PathSpec,
  scope: FindScope,
  criteria: FindCriteria,
): Promise<string[] | null> {
  if (criteria.maxDepth === 0 && !treeHasEmpty(criteria.predicate)) {
    const start = await statCandidate(accessor, scope.baseKey, scope.startName)
    if (start === null) return []
    return matchingKeys(new Map([[scope.baseKey, start]]), scope, criteria)
  }
  const query = searchQuery(criteria)
  if (!supportsQuery(query)) return null
  const start = await statCandidate(accessor, scope.baseKey, scope.startName)
  if (start === null) return []
  if (start.kind !== 'd') return null
  const candidates = new Map<string, Candidate>([[scope.baseKey, start]])
  if (criteria.maxDepth !== 0) {
    const found = await searchFiles(accessor, path, query)
    if (found === null) return null
    for (const entry of found) {
      if (!candidates.has(entry.key)) candidates.set(entry.key, candidateFromSearch(entry))
    }
  }
  return matchingKeys(candidates, scope, criteria)
}

function scanKey(rawKey: string): string {
  return `/${stripSlash(rawKey)}`
}

function directoryCandidate(key: string): Candidate {
  return { key, name: basename(key), kind: 'd', size: 0, modified: null, isEmpty: null }
}

async function collectScanCandidates(
  accessor: NextcloudAccessor,
  scope: FindScope,
): Promise<{ candidates: Map<string, Candidate>; nonemptyDirectories: Set<string> }> {
  const candidates = new Map<string, Candidate>()
  const nonemptyDirectories = new Set<string>()
  const op = await accessor.operator()
  let entries
  try {
    entries = await op.list(scope.scanKey, { recursive: true })
  } catch (error) {
    if (isNotFound(error)) return { candidates, nonemptyDirectories }
    throw error
  }
  for (const entry of entries) {
    const rawKey = entry.path()
    if (rawKey === '') continue
    const key = scanKey(rawKey)
    candidates.set(key, candidateFromMetadata(key, basename(key), entry.metadata()))
    for (const parent of parentKeys(scope, key)) {
      nonemptyDirectories.add(parent)
      if (!candidates.has(parent)) candidates.set(parent, directoryCandidate(parent))
    }
  }
  return { candidates, nonemptyDirectories }
}

function emptyState(candidate: Candidate, nonemptyDirectories: Set<string>): boolean {
  return candidate.kind === 'd'
    ? !nonemptyDirectories.has(candidate.key)
    : (candidate.size ?? 0) === 0
}

async function hydrateScanCandidate(
  accessor: NextcloudAccessor,
  candidate: Candidate,
  nonemptyDirectories: Set<string>,
  criteria: FindCriteria,
): Promise<Candidate> {
  let hydrated = candidate
  if (constrained(criteria.modified) && candidate.kind === 'd' && candidate.modified === null) {
    hydrated = (await statCandidate(accessor, candidate.key, candidate.name)) ?? candidate
  }
  return { ...hydrated, isEmpty: emptyState(hydrated, nonemptyDirectories) }
}

async function findWithScan(
  accessor: NextcloudAccessor,
  scope: FindScope,
  criteria: FindCriteria,
): Promise<string[]> {
  const { candidates, nonemptyDirectories } = await collectScanCandidates(accessor, scope)
  const start = await statCandidate(accessor, scope.baseKey, scope.startName)
  if (start === null) return []
  candidates.set(scope.baseKey, start)
  const hydrated = new Map<string, Candidate>()
  for (const candidate of candidates.values()) {
    const entry = await hydrateScanCandidate(accessor, candidate, nonemptyDirectories, criteria)
    hydrated.set(entry.key, entry)
  }
  return matchingKeys(hydrated, scope, criteria)
}

export async function find(
  accessor: NextcloudAccessor,
  path: PathSpec,
  options: FindOptions = {},
): Promise<string[]> {
  const scope = findScope(path)
  const criteria: FindCriteria = {
    predicate: optionsTree(options),
    size: { lower: options.minSize ?? null, upper: options.maxSize ?? null },
    modified: { lower: options.mtimeMin ?? null, upper: options.mtimeMax ?? null },
    minDepth: options.minDepth ?? null,
    maxDepth: options.maxDepth ?? null,
  }
  const searchResults = await findWithSearch(accessor, path, scope, criteria)
  return searchResults ?? findWithScan(accessor, scope, criteria)
}
