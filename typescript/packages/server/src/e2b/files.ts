import { ensureDir } from '@struktoai/mirage-core/commands/cli/operand'
import { classify } from '@struktoai/mirage-core/errors/classify'
import type { FsCondition } from '@struktoai/mirage-core/errors/types'
import { type FileStat, FileType, PathSpec } from '@struktoai/mirage-core/types'
import { rfc3339Of } from '@struktoai/mirage-core/utils/dates'
import { entryName } from '@struktoai/mirage-core/utils/remnants'
import { fileMode, posixMode } from '@struktoai/mirage-core/utils/stat_view'
import { type Files, readerOf } from '@struktoai/mirage-core/workspace/files'

const HOME = '/home/user'

type FileCode =
  | 'already_exists'
  | 'failed_precondition'
  | 'internal'
  | 'invalid_argument'
  | 'not_found'
  | 'permission_denied'
  | 'resource_exhausted'
  | 'unimplemented'

export class FileError extends Error {
  constructor(
    readonly code: FileCode,
    message: string,
  ) {
    super(message)
    this.name = 'FileError'
  }
}

const ERRORS: Partial<Record<FsCondition, [FileCode, string]>> = {
  ENOENT: ['not_found', 'file not found'],
  EEXIST: ['already_exists', 'file or directory already exists'],
  EACCES: ['permission_denied', 'permission denied'],
  EPERM: ['permission_denied', 'permission denied'],
  EROFS: ['permission_denied', 'read-only filesystem'],
  ENOTDIR: ['failed_precondition', 'not a directory'],
  EISDIR: ['failed_precondition', 'is a directory'],
  ENOTEMPTY: ['failed_precondition', 'directory is not empty'],
  EBUSY: ['failed_precondition', 'path is busy'],
  ELOOP: ['invalid_argument', 'symbolic link loop'],
  EINVAL: ['invalid_argument', 'invalid path'],
  EDQUOT: ['resource_exhausted', 'disk quota exceeded'],
  EFBIG: ['resource_exhausted', 'file is too large'],
  ENOTSUP: ['unimplemented', 'filesystem operation is unsupported'],
}

export function fileError(error: unknown): FileError {
  if (error instanceof FileError) return error
  const condition = classify(error)
  const entry = condition === null ? undefined : ERRORS[condition]
  if (entry !== undefined) return new FileError(...entry)
  return new FileError('internal', 'filesystem operation failed')
}

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

const TYPES: Partial<Record<FileType, string>> = {
  [FileType.FILE]: 'FILE_TYPE_FILE',
  [FileType.DIRECTORY]: 'FILE_TYPE_DIRECTORY',
  [FileType.SYMLINK]: 'FILE_TYPE_SYMLINK',
}

function filePath(value: string): PathSpec {
  if (value === '' || value.includes('\0')) {
    throw new FileError('invalid_argument', 'invalid path')
  }
  return PathSpec.fromStrPath(value, undefined, HOME)
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

  async listDir(path: string, depth = 1): Promise<EntryInfo[]> {
    if (depth !== 1 && depth !== 2) {
      throw new FileError('invalid_argument', 'list depth must be one or two')
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

  remove(path: string): Promise<void> {
    return this.removeEntry(filePath(path))
  }

  private async entry(spec: PathSpec, info: FileStat): Promise<EntryInfo> {
    const mode = posixMode(info)
    const result: EntryInfo = {
      name: entryName(spec.virtual) || '/',
      type: TYPES[info.type] ?? 'FILE_TYPE_UNSPECIFIED',
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
    for (const child of await this.children(spec)) {
      let info: FileStat
      try {
        info = await this.files.stat(child, undefined, { nofollow: true })
      } catch (error) {
        if (classify(error) === 'ENOENT') continue
        throw error
      }
      entries.push(await this.entry(child, info))
      if (depth > 1 && info.type === FileType.DIRECTORY) {
        for (const entry of await this.listEntries(child, depth - 1)) entries.push(entry)
      }
    }
    return entries
  }

  private async removeEntry(spec: PathSpec): Promise<void> {
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
      for (const child of await this.children(spec)) await this.removeEntry(child)
      await this.files.rmdir(spec)
    } catch (error) {
      if (classify(error) !== 'ENOENT') throw error
    }
  }
}
