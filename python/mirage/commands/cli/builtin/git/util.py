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

from mirage.commands.cli.builtin.git.constants import HEAD
from mirage.commands.cli.builtin.git.errors import (GitError,
                                                    UnrecognizedArgumentError)
from mirage.commands.cli.types import CLIDoors, CLIInvocation
from mirage.commands.spec.types import FlagView
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.ops.types import LinkView, MountView

ROOT = "/"
STDOUT = "stdout"
# The end-of-options marker, which the parser consumes.
MARKER = "--"


def links_of(doors: CLIDoors) -> LinkView | None:
    """The name plane's link facts, None when no namespace is wired.

    git walks the working tree itself rather than through a generic, so
    it is one of the bespoke commands that has to ask for links or
    silently cannot see one: without this a symlink reads as whatever
    it points at, and a link to nothing reads as absent.

    Args:
        doors (CLIDoors): the invocation's doors, one per state plane.
    """
    return doors.ns.links if doors.ns is not None else None


def mounts_of(doors: CLIDoors) -> MountView | None:
    """The name plane's mount boundaries, None when no namespace is wired.

    A mount nested inside the repository is served by another resource
    entirely, so the backend holding the parent path cannot see it and
    cannot carry it along in a rename. A verb that moves a directory has
    to ask here or it silently leaves the mount at its old prefix with
    the index pointing at files that never moved.

    Args:
        doors (CLIDoors): the invocation's doors, one per state plane.
    """
    return doors.ns.mounts if doors.ns is not None else None


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


def escaped(argv: tuple[str, ...]) -> frozenset[str]:
    """The words a ``--`` on the line marked as operands, not options.

    ``--`` is exactly how a caller names a file whose name begins with a
    dash, and git says so in every synopsis that ends
    ``[--] [<pathspec>...]``: ``git rm -draft`` is a refused switch and
    ``git rm -- -draft`` removes the file. The parser consumes the
    marker, so the words themselves are what carries the fact forward,
    read back off the verbatim argv the record already holds.

    A set is enough. A dash word before the marker was read as an
    option and never reached the operands, so a word that is here and
    also spelled earlier on the line is still the escaped one.

    Args:
        argv (tuple[str, ...]): the line's verbatim tokens after the
            head word, subcommand words included.
    """
    if MARKER not in argv:
        return frozenset()
    return frozenset(argv[argv.index(MARKER) + 1:])


def switches(inv: CLIInvocation[None]) -> frozenset[str]:
    """The one-letter switches the leaf declares, without their dash.

    Read off the spec the line was parsed against, so the set is the
    verb's own and never a copy of it; empty where no executor built
    the record.

    Args:
        inv (CLIInvocation): the invocation, carrying its leaf.
    """
    if inv.spec is None:
        return frozenset()
    return frozenset(option.short[1:] for option in inv.spec.options
                     if option.short is not None and len(option.short) == 2)


def offending_switch(text: str, known: frozenset[str] | None) -> str:
    """The part of a dash word parse-options would refuse.

    git reads a short cluster letter by letter, consumes the ones the
    verb declares and stops at the first it does not, so ``git mv -nx``
    says `x' and ``git mv -draft`` says `d' (git 2.50.1); a verb that
    declares no switch at all (``reset``) still names the first letter.
    A long option is refused as typed, and so is a cluster for a verb
    that hands over no set: log, show and diff word the whole argument.

    Args:
        text (str): the dash word as the user spelled it.
        known (frozenset[str] | None): the verb's one-letter switches,
            None for a verb that refuses the word whole.
    """
    if known is None or text.startswith("--"):
        return text
    for letter in text[1:]:
        if letter not in known:
            return f"-{letter}"
    return text


def check_operands(
    texts: tuple[str, ...],
    error: type[GitError] = UnrecognizedArgumentError,
    marked: frozenset[str] = frozenset(),
    known: frozenset[str] | None = None,
) -> None:
    """Refuse an operand that is really an option this build lacks.

    A verb taking a revision accepts free text, so every flag mirage
    does not declare reaches it as one. Resolving it as a revision is
    the wrong answer twice over: it fails, and it fails saying the
    repository has no such commit, when what happened is that mirage
    has no such flag. Refused here, before any object is read, so the
    message names the real problem.

    Unless the caller said otherwise. A word after ``--`` is an operand
    by the caller's own instruction whatever it starts with, so it is
    never read as an option here; see ``escaped``, which is where the
    marker survives the parser.

    Which side of the marker an operand fell on says nothing about what
    it *means*: a verb taking a revision reads an escaped word as one
    and fails with git's own "unknown revision or path" wording, where
    git would narrow the walk by it instead. That divergence is
    unchanged and deliberate, because limiting by nothing would print
    every commit and look like an answer.

    Which refusal to raise is the caller's, because git words this
    differently per verb and means each one: see ``UnknownSwitchError``
    for the three.

    Args:
        texts (tuple[str, ...]): positional text operands, as typed.
        error (type[GitError]): the refusal this verb words it with.
        marked (frozenset[str]): operands a ``--`` on the line escaped.
        known (frozenset[str] | None): the verb's one-letter switches,
            which narrow a refused cluster to its first unknown letter
            the way parse-options does; None refuses the whole word.
    """
    for text in texts:
        if text.startswith("-") and text not in marked:
            raise error(offending_switch(text, known))


def fatal(exc: GitError) -> tuple[ByteSource | None, IOResult]:
    """Render a git error: ``<prefix>: <message>``, on its own stream.

    git uses 128 for a fatal, which is neither the dispatcher's usage
    exit (2) nor its generic handler-error exit (1), so leaves return
    the code rather than raising into the catch-all. A refused option
    carries its own prefix and code instead, which is git's own split,
    and a refusal that is really a report ("nothing to commit") carries
    no prefix and goes to stdout.

    An error carrying a ``report`` puts that on stdout beside the
    stderr line, because git writes some refusals to both streams at
    once: ``<path>: needs merge`` is the diagnosis and "you need to
    resolve your current index first" is the refusal.

    Args:
        exc (GitError): the error to render.
    """
    body = f"{exc}\n" if exc.prefix is None else f"{exc.prefix}: {exc}\n"
    data = body.encode()
    if exc.stream == STDOUT:
        return yield_bytes(data), IOResult(exit_code=exc.code)
    told = yield_bytes(exc.report.encode()) if exc.report else None
    return told, IOResult(exit_code=exc.code, stderr=data)
