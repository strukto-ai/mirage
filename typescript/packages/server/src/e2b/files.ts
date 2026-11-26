import { ensureDir } from '@struktoai/mirage-core/commands/cli/operand'
import { classify } from '@struktoai/mirage-core/errors/classify'
import { type FileStat, FileType, PathSpec } from '@struktoai/mirage-core/types'
import { rfc3339Of } from '@struktoai/mirage-core/utils/dates'
import { entryName } from '@struktoai/mirage-core/utils/remnants'
import { fileMode, posixMode } from '@struktoai/mirage-core/utils/stat_view'
import { type Files, readerOf } from '@struktoai/mirage-core/workspace/files'

import * as constants from './constants.ts'
import { FileError } from './errors.ts'

interface WriteInfo {
  name: string
  type: 'file'
  path: string
}

interface EntryInfo {
  name: string
  type: string
  path: string
  size: string
  mode: number
  permissions: string
  owner?: string
  group?: string
  modifiedTime?: string
  symlinkTarget?: string
}

function filePath(value: string): PathSpec {
  if (value === '' || value.includes('\0')) {
    throw new FileError('invalid_argument', 'invalid path')
  }
  return PathSpec.fromStrPath(value, undefined, constants.HOME)
}

export class SandboxFiles {
  constructor(private readonly files: Files) {}

  read(path: string): Promise<AsyncIterable<Uint8Array>> {
    return this.files.read(filePath(path), { raw: true, stream: true })
  }

  async write(path: string, data: Uint8Array): Promise<WriteInfo> {
    const spec = filePath(path)
    try {
      await this.files.write(spec, data)
    } catch (error) {
      if (classify(error) !== 'ENOENT') throw error
      await ensureDir(this.files, spec.parent)
      await this.files.write(spec, data)
    }
    return { name: entryName(spec.virtual), type: 'file', path: spec.virtual }
  }

  async stat(path: string): Promise<EntryInfo> {
    const spec = filePath(path)
    const info = await this.files.stat(spec, undefined, { nofollow: true })
    return this.entry(spec, info)
  }

  async move(source: string, destination: string): Promise<EntryInfo> {
    const target = filePath(destination)
    await this.files.rename(filePath(source), target)
    return this.entry(target, await this.files.stat(target, undefined, { nofollow: true }))
  }

  async listDir(path: string, depth = 1): Promise<EntryInfo[]> {
    if (!Number.isInteger(depth) || depth < 1 || depth > 0xffffffff) {
      throw new FileError('invalid_argument', 'list depth must be a positive uint32')
    }
    const spec = filePath(path)
    if ((await this.files.stat(spec)).type !== FileType.DIRECTORY) {
      throw new FileError('failed_precondition', 'not a directory')
    }
    return this.listEntries(spec, depth)
  }

  async mkdir(path: string): Promise<void> {
    const spec = filePath(path)
    try {
      await this.files.mkdir(spec)
    } catch (error) {
      if (classify(error) !== 'ENOENT') throw error
      await ensureDir(this.files, spec.parent)
      await this.files.mkdir(spec)
    }
  }

  async remove(path: string): Promise<void> {
    const spec = filePath(path)
    try {
      const info = await this.files.stat(spec, undefined, { nofollow: true })
      if (info.type !== FileType.DIRECTORY) {
        await this.files.unlink(spec)
        return
      }
      const target = readerOf(this.files).follow(spec.dotted ?? spec.virtual)
      if (this.files.isMount(target) || this.files.submounts(target).length > 0) {
        throw new FileError('failed_precondition', 'cannot remove a mount')
      }
      await this.files.rmdir(spec)
    } catch (error) {
      if (classify(error) !== 'ENOENT') throw error
      console.debug('sandbox file already absent during removal:', error)
    }
  }

  private async entry(spec: PathSpec, info: FileStat): Promise<EntryInfo> {
    const mode = posixMode(info)
    const result: EntryInfo = {
      name: entryName(spec.virtual) || '/',
      type: constants.TYPES[info.type] ?? 'FILE_TYPE_UNSPECIFIED',
      path: spec.virtual,
      size: String(info.size ?? 0),
      mode,
      permissions: fileMode(mode).slice(1),
    }
    const modified = rfc3339Of(info.modified)
    if (modified !== null) result.modifiedTime = modified
    if (info.uid !== null) result.owner = String(info.uid)
    if (info.gid !== null) result.group = String(info.gid)
    if (info.type === FileType.SYMLINK) {
      result.symlinkTarget = await this.files.readlink(spec)
    }
    return result
  }

  private async children(spec: PathSpec): Promise<PathSpec[]> {
    const names = (await this.files.readdir(spec)).map(entryName)
    return names
      .filter((name) => name !== '' && name !== '.' && name !== '..')
      .map((name) => spec.join(name))
  }

  private async listEntries(spec: PathSpec, depth: number): Promise<EntryInfo[]> {
    const entries: EntryInfo[] = []
    const pending: [PathSpec, number][] = (await this.children(spec))
      .reverse()
      .map((child) => [child, depth])
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      const [child, left] = next
      let info: FileStat
      try {
        info = await this.files.stat(child, undefined, { nofollow: true })
      } catch (error) {
        if (classify(error) !== 'ENOENT') throw error
        console.debug('sandbox file disappeared during listing:', error)
        continue
      }
      entries.push(await this.entry(child, info))
      if (left > 1 && info.type === FileType.DIRECTORY) {
        for (const nested of (await this.children(child)).reverse()) {
          pending.push([nested, left - 1])
        }
      }
    }
    return entries
  }
}
