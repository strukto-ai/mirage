import { MachineId } from './types.ts'

/**
 * Where a process runs when nothing names its machine: the machine the
 * workspace itself runs on, before the host gives its name.
 */
export const LOCAL_MACHINE = new MachineId('host', 'localhost')
