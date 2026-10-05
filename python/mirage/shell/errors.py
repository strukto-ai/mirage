# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

from collections.abc import Awaitable
from typing import TYPE_CHECKING, TypeVar

from mirage.shell.bytes import encode_text

if TYPE_CHECKING:
    from mirage.io.types import ByteSource
    from mirage.shell.types import ArithWrite
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========


class ArithError(ValueError):
    """A bash arithmetic syntax or evaluation error.

    ``writes`` carries the assignments the expression made before it
    failed: bash binds each at once, so ``x=5, 1/0`` leaves ``x`` at 5
    and ``RANDOM=42, RANDOM + 1/0`` leaves the generator seeded and
    drawn from. The evaluator fills it as it raises; a caller lands
    them the way it lands a successful result's, then reports the
    error.
    """

    writes: "tuple[ArithWrite, ...]" = ()


class ReadonlyError(ValueError):
    """An arithmetic assignment to a readonly shell variable.

    Args:
        name (str): variable that was assigned to.
    """

    def __init__(self, name: str) -> None:
        self.name = name
        super().__init__(f"{name}: readonly variable")


class ExitSignal(Exception):
    """A fatal shell exit request unwinding the current execution.

    Raised by the ``exit`` builtin and by fatal expansion errors
    (``${var:?msg}``), which bash treats as an implicit ``exit 1`` in a
    non-interactive shell. Contained at subshell, pipeline-segment, and
    background-job boundaries; the top-level program loop stops the
    remaining statements and reports ``exit_code``.

    Args:
        exit_code (int): status the shell exits with.
        stderr (bytes): diagnostic already formatted for the user.
        stdout (bytes | None): output produced before the exit that
            boundary handlers accumulated while unwinding (e.g. the left
            side of ``echo a && exit 3``).
        contained_code (int | None): status a containing boundary
            reports instead of ``exit_code``. GNU bash exits 127 on a
            fatal expansion error but a subshell wrapping one returns 1;
            ``exit N`` uses N in both positions (the default).

    ``expanding`` is the id of the command whose own words were being
    expanded when it was raised. bash expands a simple command's words
    before it applies the command's redirects, so that diagnostic goes
    around them; any other goes through the redirects it was written
    under.
    """

    def __init__(
        self,
        exit_code: int = 0,
        stderr: bytes = b"",
        stdout: bytes | None = None,
        contained_code: int | None = None,
    ) -> None:
        self.exit_code = exit_code
        self.stderr = stderr
        self.stdout = stdout
        self.contained_code = (
            contained_code if contained_code is not None else exit_code
        )
        self.expanding: int | None = None


class DiscardSignal(ExitSignal):
    """An error that discards the rest of the line: bash's ``DISCARD``.

    A bad substitution, an arithmetic or assignment error, a write the
    shell refuses: the command never runs, and neither do the statements
    after it on its line, but the next line does, with ``$?`` at 1. The
    line loop of a shell, of ``eval`` and of ``source`` resumes there; a
    child shell ends on it with status 1, and so does ``set -e``.

    Args:
        stderr (bytes): the diagnostic, in the shell's voice.
    """

    def __init__(self, stderr: bytes = b"") -> None:
        super().__init__(1, stderr=stderr, contained_code=1)


class UnboundVariable(ExitSignal):
    """``set -u`` reading a name that is not set.

    ``$x``, ``${a[i]}``, or a variable an arithmetic expression reads.
    GNU bash dies on it the way it dies on ``${x:?}``: status 127 at top
    level, 1 from a containing subshell or pipeline segment.

    Args:
        name (str): the name as the message spells it (``a[i]`` for an
            element).
    """

    def __init__(self, name: str) -> None:
        super().__init__(
            127,
            stderr=encode_text(f"bash: {name}: unbound variable\n"),
            contained_code=1,
        )


class BadSubstitution(DiscardSignal):
    """A ``${...}`` bash cannot read, found as its word expands.

    bash names the text of the expansion it was running: the whole word,
    a double-quoted part's inside, an operator's word, an arithmetic
    expression, a heredoc's body. Each level the error leaves renames it
    (``within``) until one of those fixes the name.

    Args:
        text (str): the expansion as written.
    """

    def __init__(self, text: str) -> None:
        super().__init__()
        self.fixed = False
        self.within(text)

    def within(self, word: str, fixed: bool = False) -> "BadSubstitution":
        """Name the word being expanded, unless a boundary already has.

        Args:
            word (str): the text of the expansion the error leaves.
            fixed (bool): whether this level's name is final.
        """
        if not self.fixed:
            self.stderr = encode_text(f"bash: {word}: bad substitution\n")
            self.fixed = fixed
        return self


T = TypeVar("T")


async def named(word: str, pending: Awaitable[T]) -> T:
    """Await an expansion of ``word``, which a bad substitution names.

    Args:
        word (str): what bash names: a double-quoted part's inside, an
            operator's word, an arithmetic expression.
        pending (Awaitable[T]): the expansion.
    """
    try:
        return await pending
    except BadSubstitution as exc:
        raise exc.within(word, fixed=True)


class ReturnSignal(Exception):
    """``return`` unwinding to the function or sourced file it ends.

    Args:
        exit_code (int): the status it returns.
        stderr (bytes): diagnostic already formatted for the user.
        stdout (ByteSource | None): output the constructs it left had
            produced before it.
    """

    def __init__(
        self,
        exit_code: int = 0,
        stderr: bytes = b"",
        stdout: "ByteSource | None" = None,
    ) -> None:
        self.exit_code = exit_code
        self.stderr = stderr
        self.stdout = stdout


class PipeClosed(Exception):
    pass
