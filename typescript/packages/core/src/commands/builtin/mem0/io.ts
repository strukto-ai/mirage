import type { Mem0Accessor } from '../../../accessor/mem0.ts'
import { read, readdir, stat, stream } from '../../../core/mem0/index.ts'
import type { CommandIO } from '../generic_bind/index.ts'

export const MEM0_IO: CommandIO<Mem0Accessor> = {
  readdir,
  readBytes: read,
  readStream: stream,
  stat,
  isMounted: () => true,
  isDirName: (_accessor, child) => !child.endsWith('.json'),
  local: false,
}
