from mirage.types import Refusal


class CondError(Exception):
    """A test/[/[[ usage error: bash prints the message and returns 2.

    A ``[[`` grammar error is a parse error that kills the line; an
    arithmetic error inside a numeric operand (``[[ 0 -eq 1/0 ]]``) is
    not: bash prints it and the test answers 1, the line going on, so it
    carries its own status and is never fatal.

    Args:
        message (str): diagnostic without trailing newline.
        exit_code (int): the status the test answers with.
        fatal (bool): whether a ``[[`` reports it as a parse error that
            ends the line.
    """

    def __init__(
        self, message: str, exit_code: int = 2, fatal: bool = True
    ) -> None:
        super().__init__(message)
        self.message = message
        self.exit_code = exit_code
        self.fatal = fatal


class CondRefused(Exception):
    """The gate refused a ``[ ]`` or a ``[[ ]]`` leaf: it answers that
    refusal, as ``test`` refused whole does.

    Args:
        stderr (bytes): the refusal's message, newline-terminated.
        exit_code (int): the status it answers with.
        refusal (Refusal | None): the record the result carries.
    """

    def __init__(
        self, stderr: bytes, exit_code: int, refusal: Refusal | None
    ) -> None:
        super().__init__(stderr)
        self.stderr = stderr
        self.exit_code = exit_code
        self.refusal = refusal
