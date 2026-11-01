import { decodeText } from '../../../../shell/bytes.ts'
import type { Refusal } from '../../../../types.ts'

/**
 * A test/[/[[ usage error: bash prints the message and returns 2. A `[[`
 * grammar error is a parse error that kills the line; an arithmetic error
 * inside a numeric operand (`[[ 0 -eq 1/0 ]]`) is not: bash prints it and
 * the test answers 1, the line going on, so it carries its own status and
 * is never fatal.
 */
export class CondError extends Error {
  constructor(
    message: string,
    readonly exitCode = 2,
    readonly fatal = true,
  ) {
    super(message)
  }
}

/**
 * The gate refused a `[ ]` or a `[[ ]]` leaf: it answers that refusal, as
 * `test` refused whole does. `stderr` is the refusal's message,
 * newline-terminated; `exitCode` the status it answers with; `refusal` the
 * record the result carries.
 */
export class CondRefused extends Error {
  constructor(
    readonly stderr: Uint8Array,
    readonly exitCode: number,
    readonly refusal: Refusal | null,
  ) {
    super(decodeText(stderr))
  }
}
