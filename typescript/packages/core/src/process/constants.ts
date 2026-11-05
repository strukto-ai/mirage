/**
 * The live processes a session holds when no block names a cap: at the 125
 * to 235 KiB each one costs, about what `max_memory`'s 32 MB default holds,
 * so a fork bomb meets the cap before it meets the host's memory. Mirrors
 * Python's `MAX_PROCESSES`.
 */
export const MAX_PROCESSES = 128
