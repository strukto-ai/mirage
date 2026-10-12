import type { DevicePipe } from './pipe.ts'

/** Opt-in capability for a RAM byte table with virtual pipe endpoints. */
export abstract class PipeFiles extends Map<string, Uint8Array> {
  abstract pipeOf(key: string): DevicePipe | null
}
