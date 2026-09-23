import type { WandbAccessor } from '../../accessor/wandb.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { PathSpec } from '../../types.ts'
import { enoent, enotdir } from '../../utils/errors.ts'
import { WandbAPIError } from './errors.ts'
import { LEAVES, parts, runVars, safeName } from './pathing.ts'
import { RUN_EXISTS } from './queries.ts'
import type { Named, FileMetadata } from './types.ts'
import { mountPrefixOf } from '../../utils/key_prefix.ts'

function entry(name: string, directory: boolean, size: number | null = null): IndexEntry {
  return new IndexEntry({
    id: name,
    name,
    vfsName: name,
    resourceType: directory ? 'wandb/directory' : 'wandb/file',
    size: directory ? 0 : size,
  })
}
export function fileTree(files: FileMetadata[]): Map<string, [string, IndexEntry][]> {
  const directories = new Map<string, Map<string, IndexEntry>>([['', new Map()]])
  for (const file of files) {
    const segments = file.name.split('/')
    if (!segments.every(safeName)) throw new WandbAPIError('W&B unsafe run file name')
    let parent = ''
    for (const [depth, child] of segments.entries()) {
      const node = entry(child, depth < segments.length - 1, file.sizeBytes)
      const children = directories.get(parent) ?? new Map<string, IndexEntry>()
      const previous = children.get(child)
      if (previous && previous.resourceType !== node.resourceType)
        throw new WandbAPIError('W&B file and directory name collision')
      children.set(child, node)
      directories.set(parent, children)
      parent = parent ? parent + '/' + child : child
    }
  }
  return new Map([...directories].map(([parent, children]) => [parent, [...children]]))
}
export function fileEntries(files: FileMetadata[], prefix: string): [string, IndexEntry][] {
  return fileTree(files).get(prefix.replace(/\/+$/, '')) ?? []
}
export async function listing(
  accessor: WandbAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<[string, IndexEntry][]> {
  const ps = parts(accessor, path)
  if (ps.length === 0) return [...new Set(accessor.config.entities)].map((e) => [e, entry(e, true)])
  let nodes: Named[]
  if (ps.length === 1) nodes = await accessor.client.projects(ps[0] ?? '')
  else if (ps.length === 2) nodes = await accessor.client.runs(ps[0] ?? '', ps[1] ?? '')
  else if (ps.length === 3) {
    const key = path.virtual.replace(/\/+$/, '')
    const parent = key.slice(0, key.lastIndexOf('/')) || '/'
    const cached = await index?.listDir(parent)
    if (!cached?.entries?.includes(key)) await accessor.client.run(runVars(ps), RUN_EXISTS)
    return [
      ...LEAVES.map((n): [string, IndexEntry] => [n, entry(n, false)]),
      ['files', entry('files', true)],
    ]
  } else if (ps[3] === 'files') {
    const files = await accessor.client.files(runVars(ps))
    const prefix = ps.slice(4).join('/')
    if (prefix && files.some((f) => f.name === prefix)) throw enotdir(path)
    const tree = fileTree(files)
    const result = tree.get(prefix)
    if (!result) throw enoent(path)
    if (index) {
      const root = mountPrefixOf(path.virtual, path.vfsPath) + '/' + ps.slice(0, 4).join('/')
      await index.invalidatePrefix(root)
      await index.put(root, entry('files', true))
      for (const [directory, entries] of tree)
        await index.setDir(directory ? root + '/' + directory : root, entries)
    }
    return result
  } else if (LEAVES.includes(ps[3] ?? '')) throw enotdir(path)
  else throw enoent(path)
  return nodes.map((node) => {
    if (!safeName(node.name)) throw new WandbAPIError('W&B unsafe object name')
    return [node.name, entry(node.name, true)]
  })
}
export async function readdir(
  accessor: WandbAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<string[]> {
  path = path.pattern ? path.dir : path
  parts(accessor, path)
  const key = path.virtual.replace(/\/+$/, '') || '/'
  const cached = await index?.listDir(key)
  if (cached?.entries) return cached.entries
  const entries = await listing(accessor, path, index)
  await index?.setDir(key, entries)
  return entries.map(([name]) => key.replace(/\/$/, '') + '/' + name)
}
