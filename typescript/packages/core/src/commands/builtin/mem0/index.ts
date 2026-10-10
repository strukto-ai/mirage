import { VFSName } from '../../../types.ts'
import type { Command } from '../../config.ts'
import { makeSearch } from '../generic/search.ts'

export const MEM0_COMMANDS: readonly Command[] = [...makeSearch(VFSName.MEM0)]
