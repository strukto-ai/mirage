import { MachineName } from './types.ts'

/**
 * Where a process runs when nothing names its machine: the machine the
 * workspace itself runs on, before the host gives its name.
 */
export const LOCAL_MACHINE = new MachineName('host', 'localhost')

/** The ended records a table keeps: the newest of them, for at most an hour. */
export const HISTORY_MAX_RECORDS = 1024
export const HISTORY_SECONDS = 3600

/** What a line a cancel or an abort stopped ends with: an interrupt, as a shell's line ends on ^C. */
export const LINE_STOP_SIGNAL = 2
