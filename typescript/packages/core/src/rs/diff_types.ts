import type { ByteSource } from '../io/types.ts'

export interface DiffOptions {
  readonly mode: 'normal' | 'unified' | 'ed'
  readonly context: number
  readonly ignore_case: boolean
  readonly ignore_all_space: boolean
  readonly ignore_space_change: boolean
  readonly text: boolean
  readonly brief: boolean
  readonly old_label: string
  readonly new_label: string
  readonly old_header: string
  readonly new_header: string
}
export type PairOutcome = 'equal' | 'different'
export interface PairResult {
  readonly outcome: PairOutcome
  readonly status: 0 | 1 | 2
  readonly output: readonly Uint8Array[]
  readonly stderr: readonly Uint8Array[]
}
export type InputFactory = () => Promise<ByteSource> | ByteSource
export interface DiffComputer {
  compare(
    options: DiffOptions,
    old: InputFactory,
    next: InputFactory,
    signal?: AbortSignal,
  ): Promise<PairResult>
}
