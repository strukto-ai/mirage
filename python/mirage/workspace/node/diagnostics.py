from mirage.io import IOResult
from mirage.shell.bytes import encode_text
from mirage.shell.parse.types import SyntaxDiagnostic


def syntax_error_result(diagnostic: SyntaxDiagnostic) -> IOResult:
    """Render a parser diagnostic at the execution boundary.

    Args:
        diagnostic (SyntaxDiagnostic): the first error in the owned program.
    """
    return IOResult(exit_code=2, stderr=encode_text(diagnostic.message))
