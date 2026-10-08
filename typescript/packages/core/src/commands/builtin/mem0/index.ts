import { VFSName } from '../../../types.ts'
import type { Command } from '../../config.ts'
import { makeSearch } from '../generic/search.ts'
import { genericCommands } from '../generic_bind/index.ts'

export const MEM0_COMMANDS: readonly Command[] = [
  ...genericCommands(VFSName.MEM0),
  ...makeSearch(VFSName.MEM0),
]
