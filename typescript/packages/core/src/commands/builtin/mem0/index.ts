import type { Mem0Accessor } from '../../../accessor/mem0.ts'
import { VFSName } from '../../../types.ts'
import type { RegisteredCommand } from '../../config.ts'
import { makeSearch } from '../generic/search.ts'
import { makeGenericCommands } from '../generic_bind/index.ts'
import { IO } from './io.ts'

export const MEM0_COMMANDS: readonly RegisteredCommand[] = [
  ...makeGenericCommands<Mem0Accessor>(VFSName.MEM0, IO),
  ...makeSearch(VFSName.MEM0, IO.search),
]
