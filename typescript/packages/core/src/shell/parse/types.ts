/** Offsets use UTF-16 code units in TypeScript and UTF-8 bytes in Python. */
export interface SourceSpan {
  readonly start: number
  readonly end: number
}
export interface SyntaxIssue {
  readonly offending: string
  readonly span: SourceSpan
}
export interface SyntaxDiagnostic extends SyntaxIssue {
  readonly message: string
}
