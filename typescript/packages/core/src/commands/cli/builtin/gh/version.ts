import type { CommandFnResult, Context } from '../../../config.ts'
import type { PathSpec } from '../../../../types.ts'
import { IOResult } from '../../../../io/types.ts'
import { VERSION } from '../../../../version.ts'

/** Report Mirage's package version instead of an upstream gh build and release URL. */
export function version(
  _config: unknown,
  _paths: PathSpec[],
  _texts: string[],
  _ctx: Context,
): CommandFnResult {
  return [new TextEncoder().encode(`gh version ${VERSION} (Mirage)\n`), new IOResult()]
}
