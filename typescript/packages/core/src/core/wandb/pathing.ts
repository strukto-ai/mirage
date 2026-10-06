import type { WandbAccessor } from '../../accessor/wandb.ts'
import type { PathSpec } from '../../types.ts'
import { enoent } from '../../errors/fs.ts'
import type { RunVariables } from './types.ts'
import { stripSlash } from '../../utils/slash.ts'

export const LEAVES = ['run.json', 'config.json', 'summary.json', 'history.jsonl']
export function safeName(name: string): boolean {
  return (
    name.length > 0 &&
    !['.', '..'].includes(name) &&
    !['/', '\\', '\0'].some((char) => name.includes(char))
  )
}
export function parts(accessor: WandbAccessor, path: PathSpec): string[] {
  const key = stripSlash(path.mountPath)
  const result = key ? key.split('/') : []
  if (
    result.some((p) => !safeName(p)) ||
    (result.length > 0 && !accessor.config.entities.includes(result[0] ?? ''))
  )
    throw enoent(path)
  return result
}
export function runVars(segments: string[]): RunVariables {
  const [entity, project, run] = segments
  if (entity === undefined || project === undefined || run === undefined)
    throw new Error('W&B run path requires three components')
  return { entity, project, run }
}
