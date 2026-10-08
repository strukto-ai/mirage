export interface SyntaxDiagnostic {
  readonly offending: string
  readonly message: string
  readonly status: number
}
