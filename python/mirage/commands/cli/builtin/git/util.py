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
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

from mirage.commands.cli.builtin.git.errors import (GitError,
                                                    UnrecognizedArgumentError)
from mirage.commands.spec.types import FlagView
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult

ROOT = "/"
HEAD = "HEAD"
STDOUT = "stdout"


def start_point(fl: FlagView) -> str:
    """Where repository discovery begins for this invocation.

    ``-C`` changes directory before anything else happens, git's own
    reading of the option. It needs no separate session-cwd fact: the
    option is declared with a ``"."`` default, and a PATH default lands
    as if typed, so an absent ``-C`` resolves to the session cwd and a
    relative ``-C build`` is already absolute by the time it arrives.

    Read as a string, not a PathSpec: group-level values are resolved by
    the walk and reach a leaf as absolute virtual paths, while a leaf's
    own PATH flags are recovered as PathSpec by ``parse_flags``.

    Args:
        fl (FlagView): spec-validated view over the leaf's flag bag.
    """
    return fl.as_str("C") or ROOT


def revision_arg(texts: tuple[str, ...], default: str = HEAD) -> str:
    """The revision operand a verb was given, or git's own default.

    Args:
        texts (tuple[str, ...]): positional text operands.
        default (str): what an absent operand means.
    """
    return texts[0] if texts else default


def check_operands(texts: tuple[str, ...],
                   error: type[GitError] = UnrecognizedArgumentError) -> None:
    """Refuse an operand that is really an option this build lacks.

    A verb taking a revision accepts free text, so every flag mirage
    does not declare reaches it as one. Resolving it as a revision is
    the wrong answer twice over: it fails, and it fails saying the
    repository has no such commit, when what happened is that mirage
    has no such flag. Refused here, before any object is read, so the
    message names the real problem.

    A pathspec is not checked for and cannot be: the shared parser
    consumes ``--`` as its end-of-options marker, so ``log -- a.txt``
    and ``log a.txt`` reach a leaf identically. Both resolve the operand
    as a revision and fail with git's own "unknown revision or path"
    wording, which is exactly right for an untracked path and a
    deliberate divergence for a tracked one, where git would narrow the
    walk instead. Erring is the safe half of that trade: limiting by
    nothing would print every commit and look like an answer.

    Which refusal to raise is the caller's, because git words this
    differently per verb and means each one: see ``UnknownSwitchError``
    for the three.

    Args:
        texts (tuple[str, ...]): positional text operands, as typed.
        error (type[GitError]): the refusal this verb words it with.
    """
    for text in texts:
        if text.startswith("-"):
            raise error(text)


def fatal(exc: GitError) -> tuple[ByteSource | None, IOResult]:
    """Render a git error: ``<prefix>: <message>``, on its own stream.

    git uses 128 for a fatal, which is neither the dispatcher's usage
    exit (2) nor its generic handler-error exit (1), so leaves return
    the code rather than raising into the catch-all. A refused option
    carries its own prefix and code instead, which is git's own split,
    and a refusal that is really a report ("nothing to commit") carries
    no prefix and goes to stdout.

    Args:
        exc (GitError): the error to render.
    """
    body = f"{exc}\n" if exc.prefix is None else f"{exc.prefix}: {exc}\n"
    data = body.encode()
    if exc.stream == STDOUT:
        return yield_bytes(data), IOResult(exit_code=exc.code)
    return None, IOResult(exit_code=exc.code, stderr=data)
