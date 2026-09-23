import type { Mem0Accessor } from '../../../accessor/mem0.ts'
import { detectScope } from '../../../core/mem0/scope.ts'
import { searchMemoriesRendered } from '../../../core/mem0/search.ts'
import { IOResult } from '../../../io/types.ts'
import { VFSName, type PathSpec } from '../../../types.ts'
import { enoent } from '../../../utils/errors.ts'
import { mountPrefixOf } from '../../../utils/key_prefix.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { metadataProvision } from '../generic_bind/provision.ts'
import { resolveGlobOf } from '../generic_bind/index.ts'
import { defaultPaths } from '../utils/operands.ts'
import { MEM0_IO } from './io.ts'
import { FlagView } from '../../spec/flag_view.ts'

const ENCODER = new TextEncoder()
const resolveGlob = resolveGlobOf(MEM0_IO)

function isMountRoot(path: PathSpec): boolean {
  const prefix = mountPrefixOf(path.virtual, path.vfsPath)
  const root = rstripSlash(prefix) || '/'
  return (rstripSlash(path.virtual) || '/') === root
}

function memoryIds(paths: readonly PathSpec[]): Set<string> {
  const ids = new Set<string>()
  for (const path of paths) {
    const match = detectScope(path)
    if (match.kind !== 'memory') throw enoent(path)
    ids.add(match.slots.memory_id ?? '')
  }
  return ids
}

async function searchCommand(
  accessor: Mem0Accessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const query = texts[0]
  if (query === undefined || query === '') {
    return [
      null,
      new IOResult({ exitCode: 2, stderr: ENCODER.encode('search: query is required\n') }),
    ]
  }
  const fl = new FlagView(opts.flags, specOf('search'))
  const method = fl.asStr('method') ?? 'semantic'
  if (method !== 'semantic') {
    return [
      null,
      new IOResult({
        exitCode: 1,
        stderr: ENCODER.encode("search: only the 'semantic' method is supported\n"),
      }),
    ]
  }
  const topK = fl.asInt('top_k') ?? accessor.config.defaultSearchLimit
  const threshold = fl.asFloat('threshold') ?? 0
  const targets = defaultPaths(paths, opts.cwd, opts.mountPrefix ?? '')
  const first = targets[0]
  const mountPrefix = first === undefined ? '' : mountPrefixOf(first.virtual, first.vfsPath)
  try {
    const ids = targets.some(isMountRoot)
      ? undefined
      : memoryIds(await resolveGlob(accessor, targets, opts.index ?? undefined))
    return [
      await searchMemoriesRendered(accessor, query, mountPrefix, topK, threshold, ids),
      new IOResult(),
    ]
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return [null, new IOResult({ exitCode: 1, stderr: ENCODER.encode(`${message}\n`) })]
  }
}

export const MEM0_SEARCH = command({
  name: 'search',
  vfs: VFSName.MEM0,
  spec: specOf('search'),
  fn: searchCommand,
  provision: metadataProvision,
})
