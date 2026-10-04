import type { Accessor } from '../accessor/base.ts'
import type { CommandIO } from '../commands/builtin/generic_bind/adapter.ts'
import { streamFromBytes } from '../commands/builtin/utils/wrap.ts'
import { eisdir, isEnoent, isEnotdir } from '../utils/errors.ts'
import { type FileStat, FileType } from '../types.ts'
import type {
  ContentSearchOps,
  NativeReadOps,
  ReadOps,
  WriteOps,
  SearchOps,
  ReadBytesOp,
  StatOp,
  WriteOp,
} from './types.ts'

export interface VFSAdapterOptions<A extends Accessor = Accessor> {
  read: ReadOps<A>
  native?: NativeReadOps<A>
  writes?: WriteOps<A>
  search?: SearchOps<A>
  contentSearch?: ContentSearchOps<A>
  local?: boolean
  isMounted?: CommandIO<A>['isMounted']
  maxGlobMatches?: number
  maxDuEntries?: number | null
}

/** Compose capabilities into one table for commands and filesystem ops. */
export class VFSAdapter<A extends Accessor = Accessor> {
  constructor(readonly options: VFSAdapterOptions<A>) {}

  toCommandIO(): CommandIO<A> {
    const { read, native, writes, ...settings } = this.options
    return {
      ...read,
      streamsBytes: native?.readStream === undefined,
      readStream: (a, p, i) => streamFromBytes(read.readBytes, a, p, i),
      exists: async (a, p) => {
        try {
          await read.stat(a, p)
          return true
        } catch (error) {
          if (isEnoent(error) || isEnotdir(error)) return false
          throw error
        }
      },
      local: false,
      isMounted: () => true,
      ...settings,
      ...native,
      ...writes,
    }
  }
}

/**
 * Explicit non-atomic read/modify/write append for byte stores.
 *
 * A zero-byte append is an open for appending with nothing written after it
 * (`cmd >> f` opens `f` before `cmd` runs): it creates a missing file and leaves
 * an existing one alone, so it costs a stat rather than moving the whole object
 * twice to add nothing.
 */
export function appendFromRead<A extends Accessor>(
  read: ReadBytesOp<A>,
  write: WriteOp<A>,
  stat: StatOp<A>,
): WriteOp<A> {
  return async (accessor, path, data) => {
    if (data.length === 0) {
      let found: FileStat
      try {
        found = await stat(accessor, path)
      } catch (error) {
        if (!isEnoent(error)) throw error
        await write(accessor, path, data)
        return
      }
      if (found.type === FileType.DIRECTORY) throw eisdir(path)
      return
    }
    let previous: Uint8Array
    try {
      previous = await read(accessor, path)
    } catch (error) {
      if (!isEnoent(error)) throw error
      previous = new Uint8Array()
    }
    const merged = new Uint8Array(previous.length + data.length)
    merged.set(previous)
    merged.set(data, previous.length)
    await write(accessor, path, merged)
  }
}
