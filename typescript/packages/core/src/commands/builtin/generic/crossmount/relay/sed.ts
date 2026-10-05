import { IOResult, type ByteSource } from '../../../../../io/types.ts'
import type { PathSpec } from '../../../../../types.ts'
import type { FlagValue } from '../../../../spec/types.ts'
import { sedGeneric } from '../../sed.ts'
import type { CrossResult, DispatchFn } from '../types.ts'
import { crossOpts, fileStreamOp, flatten } from '../utils.ts'

/**
 * GNU sed 4.9 keeps filenames and file boundaries for F and -s, and
 * shares output files and quit state even under -i. Run one machine
 * over the expanded operands through their owning mounts' dispatcher.
 */
export async function runSed(
  scopes: PathSpec[],
  texts: string[],
  bag: Record<string, FlagValue>,
  dispatch: DispatchFn,
  stdin: ByteSource | null,
  cwd: string,
  argv: readonly string[],
): Promise<CrossResult> {
  const reads = new IOResult()
  const write = async (path: PathSpec, data: Uint8Array): Promise<void> => {
    await dispatch('write', path, [data])
    Reflect.deleteProperty(reads.reads, path.virtual)
  }
  const [body, io] = (await sedGeneric(
    flatten(scopes),
    texts,
    { ...crossOpts(bag), stdin, cwd, dispatch, argv },
    fileStreamOp(dispatch, reads),
    write,
  )) ?? [null, new IOResult()]
  const merged = await reads.merge(io)
  // Every read went through the dispatcher, whose cold read keeps what the
  // file cache may hold; listing a read path again would keep a filetype
  // renderer's output there, which cat would then print. A written path
  // stays listed. Mirrors Python's run_sed.
  merged.cache = merged.cache.filter((p) => !(p in merged.reads))
  return [body, merged]
}
