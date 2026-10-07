import type { TSNodeLike } from '../types.ts'
import type { SyntaxDiagnostic } from './types.ts'
import { checkSyntax, findSyntaxIssue } from './syntax.ts'

/** The line's syntax errors, each span in the line as typed: bash's reading
 * of `command`, or else an error only the grammar finds in `root`, mapped
 * through its `offsets`. */
export function diagnose(
  command: string,
  root: TSNodeLike,
  offsets: readonly number[],
  aliases: ReadonlySet<string> = new Set(),
): readonly SyntaxDiagnostic[] {
  const found = checkSyntax(command, aliases)
  if (found !== null) return [found]
  const issue = findSyntaxIssue(root)
  if (issue === null) return []
  return [
    {
      ...issue,
      span: {
        start: offsets[issue.span.start] ?? issue.span.start,
        end: offsets[issue.span.end] ?? issue.span.end,
      },
    },
  ]
}
