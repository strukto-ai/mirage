import type { ByteSource } from '../io/types.ts'

export type DiffMode = 'normal' | 'unified' | 'ed' | 'context' | 'rcs' | 'sides'

/** One pair's comparison and output, as the diff engine reads them; each
 * pattern and width is spelled one character per byte. */
export interface DiffOptions {
  readonly mode: DiffMode
  readonly context: number
  readonly ignore_case: boolean
  readonly ignore_all_space: boolean
  readonly ignore_space_change: boolean
  readonly ignore_tab_expansion: boolean
  readonly ignore_trailing_space: boolean
  readonly strip_trailing_cr: boolean
  readonly ignore_blank_lines: boolean
  readonly ignore_lines: string[]
  readonly function_lines: string[]
  readonly show_c_function: boolean
  readonly expand_tabs: boolean
  readonly initial_tab: boolean
  readonly widths: string[]
  readonly suppress_common: boolean
  readonly left_column: boolean
  readonly text: boolean
  readonly brief: boolean
  readonly utf8: boolean
  readonly old_label: string
  readonly new_label: string
  readonly old_header: string
  readonly new_header: string
}
export type PairOutcome = 'equal' | 'different'
export interface PairResult {
  readonly outcome: PairOutcome
  readonly status: 0 | 1 | 2
  readonly output: readonly ByteSource[]
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
