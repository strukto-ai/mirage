import { IOResult } from '../../io/types.ts'
import { encodeText } from '../../shell/bytes.ts'
import type { SyntaxDiagnostic } from '../../shell/parse/types.ts'

/** Render the first parser diagnostic at the execution boundary. */
export function syntaxErrorResult(diagnostic: SyntaxDiagnostic): IOResult {
  return new IOResult({ exitCode: 2, stderr: encodeText(diagnostic.message) })
}
