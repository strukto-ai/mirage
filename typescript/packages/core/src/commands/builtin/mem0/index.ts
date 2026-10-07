import { VFSName } from '../../../types.ts'
import type { RegisteredCommand } from '../../config.ts'
import { makeSearch } from '../generic/search.ts'
import { makeGenericCommands } from '../generic_bind/index.ts'

export const MEM0_COMMANDS: readonly RegisteredCommand[] = [
  ...makeGenericCommands(VFSName.MEM0),
  ...makeSearch(VFSName.MEM0),
]
