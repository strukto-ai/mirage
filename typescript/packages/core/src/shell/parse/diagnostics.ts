import type { TSNodeLike } from '../types.ts'
import type { SyntaxDiagnostic } from './types.ts'
import { findSyntaxIssue, findUnterminatedBacktick, syntaxErrorMessage } from './syntax.ts'

/** The line's syntax errors, each span mapped back into the line as typed. */
export function diagnose(
  root: TSNodeLike,
  offsets: readonly number[],
  parse?: (command: string) => TSNodeLike,
  aliases: ReadonlySet<string> = new Set(),
  own: ReadonlyMap<string, readonly [number, number]> = new Map(),
): readonly SyntaxDiagnostic[] {
  let found = findSyntaxIssue(root, parse, aliases, own, offsets)
  const unclosed = findUnterminatedBacktick(root.text)
  if (found === null && unclosed !== null)
    found = {
      offending: unclosed,
      span: {
        start: (root.startIndex ?? 0) + root.text.length - unclosed.length,
        end: root.endIndex ?? root.text.length,
      },
    }
  if (found === null) return []
  return [
    {
      offending: found.offending,
      message: syntaxErrorMessage(found.offending, root),
      span: {
        start: offsets[found.span.start] ?? found.span.start,
        end: offsets[found.span.end] ?? found.span.end,
      },
    },
  ]
}
