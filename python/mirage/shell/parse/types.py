from dataclasses import dataclass


@dataclass(frozen=True)
class SourceSpan:
    """UTF-8 byte offsets; the TypeScript adapter uses UTF-16 code units."""

    start: int
    end: int


@dataclass(frozen=True)
class SyntaxIssue:
    offending: str
    span: SourceSpan


@dataclass(frozen=True)
class SyntaxDiagnostic(SyntaxIssue):
    message: str
    status: int = 2
