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

import asyncio
import fnmatch
import time
from collections import Counter
from dataclasses import dataclass

from dulwich.objects import Commit, ObjectID, ShaFile, Tag
from dulwich.refs import Ref
from dulwich.repo import BaseRepo

from mirage.commands.cli.builtin.git.commit import identity
from mirage.commands.cli.builtin.git.constants import HEAD
from mirage.commands.cli.builtin.git.errors import GitError  # yapf: disable
from mirage.commands.cli.builtin.git.errors import (  # yapf: disable
    IncompatibleOptionsError, InvalidTagNameError, ListModeOnlyError,
    MissingTagMessageError, NoWorkspaceError, RefLockError,
    RefUpdateConflictError, TagExistsError, TagLinesError, TagNotFoundError,
    TagUsageError, TooManyArgumentsError, UnknownSwitchError,
    UnresolvedRefError)
from mirage.commands.cli.builtin.git.format import short
from mirage.commands.cli.builtin.git.objects import abbrev_for
from mirage.commands.cli.builtin.git.refs import (TAG_PREFIX, blocking_ref,
                                                  delete_ref, valid_ref_name,
                                                  write_ref)
from mirage.commands.cli.builtin.git.revparse import resolve_object
from mirage.commands.cli.builtin.git.session import opened
from mirage.commands.cli.builtin.git.util import (  # yapf: disable
    check_operands, escaped, fatal, switches)
from mirage.commands.cli.types import CLIDoors, CLIInvocation
from mirage.commands.spec.types import FlagView
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult

# git pads a tag name to this width before the message under -n.
NAME_WIDTH = 15
CONTINUATION = "    "
UTC = 0


@dataclass(frozen=True, slots=True)
class TagFlags:
    """The parsed shape of a ``git tag`` invocation.

    Args:
        listing (bool): ``-l``, list tags, the operands being patterns.
        delete (bool): ``-d``, delete the named tags.
        annotate (bool): ``-a``, write a tag object; implied by ``-m``.
        message (str | None): ``-m``, the tag message.
        force (bool): ``-f``, replace a tag that exists.
        lines (int | None): ``-n[<num>]``, how many message lines to
            print per tag when listing; None when ``-n`` was not given,
            which ``-n-1`` also means.
    """
    listing: bool
    delete: bool
    annotate: bool
    message: str | None
    force: bool
    lines: int | None


def parse_flags(fl: FlagView) -> TagFlags:
    """Read the raw tag flag kwargs into a frozen struct.

    ``-n`` carries its count attached or not at all, and a bare one
    means one line, which is why the value is read as an integer first
    and only then as a boolean. ``-m`` may repeat, each occurrence a
    paragraph of its own.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
    """
    lines = fl.as_int("n")
    if lines is None and fl.as_bool("n"):
        lines = 1
    # -1 is where git's own parser starts the count, so it reads as
    # "-n was never given" rather than as a count of -1: ``-n-1``
    # deletes and creates where any real ``-n`` refuses both.
    if lines == -1:
        lines = None
    # Several -m are several paragraphs, joined the way git joins them.
    paragraphs = fl.as_list("message")
    message = "\n\n".join(paragraphs) if paragraphs else None
    return TagFlags(listing=fl.as_bool("list"),
                    delete=fl.as_bool("delete"),
                    annotate=fl.as_bool("annotate") or message is not None,
                    message=message,
                    force=fl.as_bool("force"),
                    lines=lines)


def tag_names(known: set[Ref]) -> list[str]:
    """Every tag name the repository publishes, in git's listing order.

    Args:
        known (set[Ref]): every ref the repository publishes.
    """
    prefix = TAG_PREFIX.encode()
    return sorted(ref[len(prefix):].decode("utf-8", errors="replace")
                  for ref in known if ref.startswith(prefix))


def selected_names(names: list[str], patterns: tuple[str, ...]) -> list[str]:
    """The names a ``-l`` pattern list keeps: any pattern, or all.

    Args:
        names (list[str]): every tag name, already ordered.
        patterns (tuple[str, ...]): shell patterns as typed.
    """
    if not patterns:
        return names
    return [
        name for name in names if any(
            fnmatch.fnmatchcase(name, pattern) for pattern in patterns)
    ]


def message_lines(repo: BaseRepo, sha: bytes) -> list[str]:
    """The message ``-n`` prints for a tag: its own, or its commit's.

    An annotated tag carries a message; a lightweight one is a bare
    pointer, so git shows the message of what it points at. Read on a
    worker thread, since the objects come through the dispatcher.

    Args:
        repo (BaseRepo): the opened repository.
        sha (bytes): what the tag ref holds.
    """
    obj = repo.object_store[ObjectID(sha)]
    if not isinstance(obj, (Tag, Commit)):
        return []
    text: str = obj.message.decode("utf-8", errors="replace")
    return text.splitlines()


def render_listing(names: list[str], messages: dict[str, list[str]] | None,
                   count: int) -> bytes:
    """One line per tag, with up to ``count`` message lines under -n.

    Args:
        names (list[str]): the tag names to print, in order.
        messages (dict[str, list[str]] | None): each tag's message
            lines, None when ``-n`` was not given.
        count (int): how many message lines to print per tag.
    """
    lines: list[str] = []
    for name in names:
        if messages is None:
            lines.append(name)
            continue
        body = messages[name][:count]
        lines.append(f"{name:<{NAME_WIDTH}} {body[0] if body else ''}")
        lines.extend(f"{CONTINUATION}{line}" for line in body[1:])
    return "".join(f"{line}\n" for line in lines).encode()


def resolve_target(repo: BaseRepo, known: set[Ref], revision: str) -> ShaFile:
    """The object a new tag points at.

    A tag made from another tag points at the tag object itself rather
    than at what it peels to, which is git's own rule. Anything else is
    resolved as an object expression, because git tags any object and
    its usage line says so: ``HEAD^{tree}`` and ``HEAD:a.txt`` are as
    good a target as a branch, and the type resolution lands on is what
    the tag records.

    Args:
        repo (BaseRepo): the opened repository.
        known (set[Ref]): every ref the repository publishes.
        revision (str): the operand as the user spelled it.
    """
    ref = Ref(f"{TAG_PREFIX}{revision}".encode())
    if ref in known:
        return repo.object_store[ObjectID(repo.refs[ref])]
    try:
        return resolve_object(repo, revision)
    except GitError as exc:
        raise UnresolvedRefError(revision) from exc


def build_tag(repo: BaseRepo, name: str, target: ShaFile, message: str,
              tagger: bytes, when: int) -> Tag:
    """Write an annotated tag object and return it.

    Synchronous, and called on a worker thread: the object goes back
    through the dispatcher.

    Args:
        repo (BaseRepo): the opened repository.
        name (str): the tag name.
        target (ShaFile): the object tagged.
        message (str): the tag message, possibly empty.
        tagger (bytes): the identity to record.
        when (int): the timestamp, in epoch seconds.
    """
    tag = Tag()
    tag.name = name.encode()
    tag.object = (type(target), target.id)
    tag.tagger = tagger
    tag.tag_time = when
    tag.tag_timezone = UTC
    tag.message = f"{message}\n".encode() if message else b""
    repo.object_store.add_object(tag)
    return tag


async def tag(inv: CLIInvocation[None]) -> tuple[ByteSource | None, IOResult]:
    """List, create or delete tags.

    No operand lists them, a name creates one, ``-d`` deletes. A bare
    name is a lightweight tag, a pointer and nothing more; ``-a`` or
    ``-m`` writes a tag object carrying a message and a tagger, and
    ``-a`` without ``-m`` is refused for the reason ``commit`` refuses
    a missing message: there is no editor to open.

    Args:
        inv (CLIInvocation[None]): the line's invocation record.
            git declares no config_model; the planes it reads
            (data through ``dispatch``, names through ``ns``) ride
            ``inv.doors``.
    """
    doors = inv.doors or CLIDoors()
    dispatch = doors.dispatch
    texts = inv.texts
    fl = FlagView(inv.flags)
    try:
        if dispatch is None:
            raise NoWorkspaceError()
        check_operands(texts, UnknownSwitchError, escaped(inv.argv),
                       switches(inv))
        flags = parse_flags(fl)
        if flags.listing and flags.delete:
            raise IncompatibleOptionsError("-l", "-d")
        # -a, -m and -f create a tag, so a line that lists or deletes
        # instead has nothing for them to do: git prints its usage and
        # exits 129, where the same line without them lists or deletes
        # and exits 0. No operand at all is a listing, which is why it
        # counts here too.
        creating = flags.annotate or flags.force
        reading = (flags.listing or flags.delete or flags.lines is not None
                   or not texts)
        if creating and reading:
            raise TagUsageError()
        # After the two usage refusals above, which git reaches first:
        # ``-l -d -n1`` is the incompatible pair and ``-d -f -n1`` the
        # usage, both exiting 129, where ``-d -n1`` alone dies here.
        if flags.delete and flags.lines is not None:
            raise ListModeOnlyError()
        # git reads the count while parsing the format it lists with,
        # which is after both usage refusals above and before any ref
        # is read: a repository holding no tags refuses this one too.
        if flags.lines is not None and flags.lines < 0:
            raise TagLinesError(flags.lines)
        repo, location = await opened(fl, doors)
        known = repo.refs.allkeys()
        if flags.delete:
            out: list[str] = []
            err: list[str] = []
            doomed: list[tuple[str, Ref]] = []
            for name in texts:
                ref = Ref(f"{TAG_PREFIX}{name}".encode())
                if ref not in known:
                    err.append(f"error: {TagNotFoundError(name)}\n")
                    continue
                doomed.append((name, ref))
            # Every deletion on the line is one ref transaction, and a
            # name given twice makes two updates for one ref, which the
            # transaction refuses before applying any of them: the whole
            # line deletes nothing. A name that is not there never
            # reaches the transaction, so ``-d nosuch nosuch`` is two
            # ordinary reports rather than this refusal.
            seen = Counter(ref for _name, ref in doomed)
            repeated = sorted(ref for ref, count in seen.items() if count > 1)
            if repeated:
                blamed = RefUpdateConflictError(repeated[0].decode())
                err.append(f"error: {blamed}\n")
                return None, IOResult(exit_code=1,
                                      stderr="".join(err).encode())
            for name, ref in doomed:
                sha = repo.refs[ref]
                await delete_ref(dispatch, location.commondir, ref.decode())
                out.append(f"Deleted tag '{name}' "
                           f"(was {short(sha, abbrev_for(repo))})\n")
            return yield_bytes("".join(out).encode()), IOResult(
                exit_code=1 if err else 0, stderr="".join(err).encode())
        if flags.listing or flags.lines is not None or not texts:
            names = selected_names(tag_names(known), texts)
            messages = None
            # -n0 (and any other count that prints no line) is a plain
            # listing in git, so nothing is read and nothing is padded.
            if flags.lines is not None and flags.lines > 0:
                messages = {
                    name:
                    await asyncio.to_thread(
                        message_lines, repo,
                        repo.refs[Ref(f"{TAG_PREFIX}{name}".encode())])
                    for name in names
                }
            return yield_bytes(
                render_listing(names, messages, flags.lines or 0)), IOResult()
        if len(texts) > 2:
            raise TooManyArgumentsError()
        name = texts[0]
        if not valid_ref_name(name):
            raise InvalidTagNameError(name)
        ref = Ref(f"{TAG_PREFIX}{name}".encode())
        if ref in known and not flags.force:
            raise TagExistsError(name)
        if flags.annotate and flags.message is None:
            raise MissingTagMessageError()
        target = resolve_target(repo, known,
                                texts[1] if len(texts) > 1 else HEAD)
        if flags.annotate:
            written = await asyncio.to_thread(build_tag, repo, name, target,
                                              flags.message or "",
                                              identity(fl, doors.session_view),
                                              int(time.time()))
            pointed = written.id
        else:
            pointed = target.id
        was = repo.refs[ref] if ref in known else None
        # After the object is built, which is git's order: an annotated
        # tag whose ref cannot be locked has already been written to the
        # database and is left there unreferenced.
        held = blocking_ref(known, ref.decode())
        if held is not None:
            raise RefLockError(ref.decode(), held)
        await write_ref(dispatch, location.commondir, ref.decode(), pointed)
    except GitError as exc:
        return fatal(exc)
    if was is None:
        return None, IOResult()
    return yield_bytes(
        f"Updated tag '{name}' "
        f"(was {short(was, abbrev_for(repo))})\n".encode()), IOResult()
