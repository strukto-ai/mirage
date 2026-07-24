import type { Mem0Accessor } from '../../../accessor/mem0.ts'
import { ResourceName } from '../../../types.ts'
import type { RegisteredCommand } from '../../config.ts'
import { makeGenericCommands } from '../generic_bind/index.ts'
import { MEM0_IO } from './io.ts'
import { MEM0_SEARCH } from './search.ts'

export const MEM0_COMMANDS: readonly RegisteredCommand[] = [
  ...makeGenericCommands<Mem0Accessor>(ResourceName.MEM0, MEM0_IO, {
    overrides: new Set(['search']),
  }),
  ...MEM0_SEARCH,
]
