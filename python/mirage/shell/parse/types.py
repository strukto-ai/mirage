from dataclasses import dataclass


@dataclass(frozen=True)
class SyntaxDiagnostic:
    offending: str
    message: str
    status: int = 2
