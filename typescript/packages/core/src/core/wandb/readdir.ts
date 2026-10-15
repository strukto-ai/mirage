import type { WandbAccessor } from '../../accessor/wandb.ts'
import { ContentType, DirListing, FileStat, FileType, type PathSpec } from '../../types.ts'
import { enoent, enotdir } from '../../errors/fs.ts'
import { WandbAPIError } from './errors.ts'
import { LEAVES, parts, runVars, safeName } from './pathing.ts'
import { RUN_EXISTS } from './queries.ts'
import type { Named, FileMetadata } from './types.ts'

export function row(
  name: string,
  directory: boolean,
  size: number | null = null,
  content: ContentType | null = null,
): FileStat {
  if (directory) return new FileStat({ name, type: FileType.DIRECTORY, size: 0 })
  return new FileStat({ name, type: FileType.FILE, size, content })
}
function leaf(name: string): FileStat {
  return row(name, false, null, name.endsWith('.json') ? ContentType.JSON : ContentType.TEXT)
}
export function fileTree(files: FileMetadata[]): Map<string, FileStat[]> {
  const directories = new Map<string, Map<string, FileStat>>([['', new Map()]])
  for (const file of files) {
    const segments = file.name.split('/')
    if (!segments.every(safeName)) throw new WandbAPIError('W&B unsafe run file name')
    let parent = ''
    for (const [depth, child] of segments.entries()) {
      const node = row(child, depth < segments.length - 1, file.sizeBytes, ContentType.BINARY)
      const children = directories.get(parent) ?? new Map<string, FileStat>()
      const previous = children.get(child)
      if (previous && previous.type !== node.type)
        throw new WandbAPIError('W&B file and directory name collision')
      children.set(child, node)
      directories.set(parent, children)
      parent = parent ? parent + '/' + child : child
    }
  }
  return new Map([...directories].map(([parent, children]) => [parent, [...children.values()]]))
}
/**
 * A run's `files/` directory, or one below it, from the one call that lists
 * every file of the run: each directory below the listed one is proven by the
 * same call, so it rides along as a seed. Mirrors `_run_files` in
 * `mirage/core/wandb/readdir.py`.
 */
function runFiles(path: PathSpec, prefix: string, files: FileMetadata[]): DirListing {
  if (prefix && files.some((f) => f.name === prefix)) throw enotdir(path)
  const tree = fileTree(files)
  const entries = tree.get(prefix)
  if (!entries) throw enoent(path)
  const stem = prefix ? prefix + '/' : ''
  const seeds = new Map<string, FileStat[]>()
  for (const [directory, rows] of tree) {
    if (directory.startsWith(stem) && directory !== prefix) {
      seeds.set(directory.slice(stem.length), rows)
    }
  }
  return new DirListing({ entries, seeds })
}
/** A directory's rows. Mirrors `readdir` in `mirage/core/wandb/readdir.py`. */
export async function readdir(
  accessor: WandbAccessor,
  pathSpec: PathSpec,
): Promise<FileStat[] | DirListing> {
  const path = pathSpec.pattern ? pathSpec.dir : pathSpec
  const ps = parts(accessor, path)
  if (ps.length === 0) return [...new Set(accessor.config.entities)].map((e) => row(e, true))
  let nodes: Named[]
  if (ps.length === 1) nodes = await accessor.client.projects(ps[0] ?? '')
  else if (ps.length === 2) nodes = await accessor.client.runs(ps[0] ?? '', ps[1] ?? '')
  else if (ps.length === 3) {
    await accessor.client.run(runVars(ps), RUN_EXISTS)
    return [...LEAVES.map(leaf), row('files', true)]
  } else if (ps[3] === 'files') {
    const files = await accessor.client.files(runVars(ps))
    return runFiles(path, ps.slice(4).join('/'), files)
  } else if (LEAVES.includes(ps[3] ?? '')) throw enotdir(path)
  else throw enoent(path)
  return nodes.map((node) => {
    if (!safeName(node.name)) throw new WandbAPIError('W&B unsafe object name')
    return row(node.name, true)
  })
}
