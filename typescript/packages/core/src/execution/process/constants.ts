/**
 * The live processes a session holds when no block names a cap: at the 125
 * to 235 KiB each one costs, about what `max_memory`'s 32 MB default holds,
 * so a fork bomb meets the cap before it meets the host's memory. Mirrors
 * Python's `MAX_PROCESSES`.
 */
export const MAX_PROCESSES = 128

/**
 * Mirage numbers its processes past 4194304, the most pids a Linux kernel
 * hands out (2**22), so a number at or under it names a machine's process
 * and a number above it a Mirage one, wherever either is written. Mirrors
 * Python's `FIRST_PID`.
 */
export const FIRST_PID = 4194305
