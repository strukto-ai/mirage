import type { TSNodeLike } from '../types.ts'
import type { SyntaxDiagnostic } from './types.ts'
import { findSyntaxIssue, findUnterminatedBacktick, findUnterminatedQuote } from './syntax.ts'

export function diagnose(
  root: TSNodeLike,
  offsets: readonly number[],
  parse?: (command: string) => TSNodeLike,
  aliases: ReadonlySet<string> = new Set(),
): readonly SyntaxDiagnostic[] {
  let found = findSyntaxIssue(root, parse, aliases)
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
  const quote = findUnterminatedQuote(root)
  const snippet = found.offending.trim()
  const message =
    quote !== null
      ? 'mirage: unexpected EOF while looking for matching `' + quote + "'\n"
      : snippet.length > 0
        ? `mirage: syntax error near '${snippet}'\n`
        : 'mirage: syntax error in command\n'
  return [
    {
      offending: found.offending,
      message,
      span: {
        start: offsets[found.span.start] ?? found.span.start,
        end: offsets[found.span.end] ?? found.span.end,
      },
    },
  ]
}
