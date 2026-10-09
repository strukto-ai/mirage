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
  // The session's environment, whose locale decides bytes or characters.
  env?: Record<string, string>,
): Promise<CrossResult> {
  const write = async (path: PathSpec, data: Uint8Array): Promise<void> => {
    await dispatch('write', path, [data])
  }
  return (
    (await sedGeneric(
      flatten(scopes),
      texts,
      { ...crossOpts(bag), stdin, cwd, dispatch, argv, ...(env !== undefined ? { env } : {}) },
      fileStreamOp(dispatch),
      write,
    )) ?? [null, new IOResult()]
  )
}
