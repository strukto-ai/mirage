import type { WandbAccessor } from '../../accessor/wandb.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { ContentType, FileStat, FileType, type PathSpec } from '../../types.ts'
import { enoent } from '../../errors/fs.ts'
import { assertListed, resolveEntry } from '../hierarchy/probe.ts'
import { parts } from './pathing.ts'
import { readdir } from './readdir.ts'
export async function stat(
  accessor: WandbAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<FileStat> {
  const ps = parts(accessor, path)
  if (ps.length === 0) return new FileStat({ name: '/', type: FileType.DIRECTORY, size: 0 })
  index ??= new RAMIndexCacheStore()
  await assertListed(readdir, accessor, path, index)
  const found = await resolveEntry(readdir, accessor, path, index)
  if (!found) throw enoent(path)
  const name = ps.at(-1) ?? ''
  const directory = found.resourceType === 'wandb/directory'
  let content: ContentType | null = null
  if (!directory) {
    if (ps.length > 4) content = ContentType.BINARY
    else if (name.endsWith('.json')) content = ContentType.JSON
    else content = ContentType.TEXT
  }
  return new FileStat({
    name,
    type: directory ? FileType.DIRECTORY : FileType.FILE,
    size: found.size,
    content,
  })
}
