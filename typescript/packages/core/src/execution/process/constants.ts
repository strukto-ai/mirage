import { CONTINUE_SIGNALS, SIGKILL, SIGSTOP, STOP_SIGNALS } from '../../shell/constants.ts'

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

// Signals a running process takes and goes on: those whose default is to
// ignore them, the terminal stops a non-interactive bash's asynchronous
// commands ignore, and STOP and CONT, which pause one and let it go on.
// Mirrors Python's KEPT_SIGNALS.
export const KEPT_SIGNALS: ReadonlySet<number> = new Set([...CONTINUE_SIGNALS, ...STOP_SIGNALS])

// What the kernel keeps for itself, which no program takes (`onSignal`).
export const NEVER_TAKEN: ReadonlySet<number> = new Set([SIGKILL, SIGSTOP])

// What `ps` names as the machine of whatever Mirage runs itself, which
// `kill -m` and `wait -m` take too. Mirrors Python's `WORKSPACE_MACHINE`.
export const WORKSPACE_MACHINE = 'mirage'
