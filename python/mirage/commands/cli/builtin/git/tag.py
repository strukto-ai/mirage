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
import posixpath
import time
from collections import Counter
from dataclasses import dataclass

from dulwich.objects import ShaFile, Tag
from dulwich.refs import Ref
from dulwich.repo import BaseRepo

from mirage.commands.cli.builtin.git.commit import identity
from mirage.commands.cli.builtin.git.constants import HEAD
from mirage.commands.cli.builtin.git.dates import date_clock
from mirage.commands.cli.builtin.git.errors import (
    GitError,
    IncompatibleOptionsError,
    InvalidTagNameError,
    ListModeOnlyError,
    MissingTagMessageError,
    NoWorkspaceError,
    RefDeleteReadOnlyError,
    RefLockError,
    RefReadOnlyError,
    RefUpdateConflictError,
    TagExistsError,
    TagNotFoundError,
    TagWriteReadOnlyError,
    TooManyArgumentsError,
    UnresolvedRefError,
    UsageError,
)
from mirage.commands.cli.builtin.git.format import short
from mirage.commands.cli.builtin.git.objects import abbrev_for
from mirage.commands.cli.builtin.git.ref_filter import (
    filter_words,
    list_mode_option,
    ref_filter,
    without_filter_values,
)
from mirage.commands.cli.builtin.git.ref_format import (
    format_refs,
    listing_format,
    used_fields,
)
from mirage.commands.cli.builtin.git.ref_list import (
    configured_sort,
    listing_result,
    match_short,
    read_config,
    ref_listing,
    sort_keys,
)
from mirage.commands.cli.builtin.git.refs import (
    TAG_PREFIX,
    blocking_ref,
    delete_ref,
    valid_ref_name,
    write_ref,
)
from mirage.commands.cli.builtin.git.revparse import resolve_object
from mirage.commands.cli.builtin.git.session import opened
from mirage.commands.cli.builtin.git.types import RepoLocation
from mirage.commands.cli.builtin.git.util import (
    check_switches,
    fatal,
    verb_usage,
)
from mirage.commands.cli.types import CLIDoors, CLIInvocation
from mirage.commands.spec.flag_view import FlagView
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult

# git's own formats for a tag listing: the name, or under -n<num> the
# name padded to 15 columns and that many lines of the message.
NAME_FORMAT = "%(refname:lstrip=2)"
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


def lines_format(lines: int) -> str:
    return f"%(align:15)%(refname:lstrip=2)%(end) %(contents:lines={lines})"


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
    return TagFlags(
        listing=fl.as_bool("list"),
        delete=fl.as_bool("delete"),
        annotate=fl.as_bool("annotate") or message is not None,
        message=message,
        force=fl.as_bool("force"),
        lines=lines,
    )


def resolve_target(repo: BaseRepo, revision: str) -> ShaFile:
    """The object a new tag points at.

    A tag made from another tag points at the tag object itself rather
    than at what it peels to, which is git's own rule, and the type is
    recorded as read: a lightweight tag is a ref like any other and
    points at whatever it was made from, so ``tag blobtag HEAD:a.txt``
    then ``tag -a release -m x blobtag`` records ``type blob``. Anything
    else is resolved as an object expression, because git tags any
    object and its usage line says so: ``HEAD^{tree}`` and
    ``HEAD:a.txt`` are as good a target as a branch.

    Args:
        repo (BaseRepo): the opened repository.
        revision (str): the operand as the user spelled it.
    """
    try:
        return resolve_object(repo, revision)
    except GitError as exc:
        raise UnresolvedRefError(revision) from exc


def build_tag(
    repo: BaseRepo,
    name: str,
    target: ShaFile,
    message: str,
    tagger: bytes,
    when: int,
) -> Tag:
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

    The ref filters (``--contains``, ``--merged``, ``--points-at`` and
    their negations) imply a listing the way ``-n`` does, so their
    operands are patterns.

    Args:
        inv (CLIInvocation[None]): the line's invocation record.
            git declares no config_model; the planes it reads
            (data through ``dispatch``, names through ``ns``) ride
            ``inv.doors``.
    """
    doors = inv.doors or CLIDoors()
    dispatch = doors.dispatch
    words = filter_words(inv)
    texts = without_filter_values(inv.texts, words)
    filtered = bool(words)
    fl = FlagView(inv.flags)
    try:
        if dispatch is None:
            raise NoWorkspaceError()
        check_switches(inv, texts)
        flags = parse_flags(fl)
        if flags.listing and flags.delete:
            raise IncompatibleOptionsError("-l", "-d")
        # -a, -m and -f create a tag, so a line that lists or deletes
        # instead has nothing for them to do: git prints its usage and
        # exits 129, where the same line without them lists or deletes
        # and exits 0. No operand at all is a listing, which is why it
        # counts here too.
        creating = flags.annotate or flags.force
        reading = (
            flags.listing
            or flags.delete
            or flags.lines is not None
            or filtered
            or not texts
        )
        if creating and reading:
            raise UsageError("", verb_usage(inv))
        # After the two usage refusals above, which git reaches first:
        # ``-l -d -n1`` is the incompatible pair and ``-d -f -n1`` the
        # usage, both exiting 129, where ``-d -n1`` alone dies here.
        if flags.delete and flags.lines is not None:
            raise ListModeOnlyError()
        list_only = list_mode_option(words) if flags.delete else None
        if list_only is not None:
            raise ListModeOnlyError(list_only)
        repo, location = await opened(fl, doors)
        cfg = await read_config(dispatch, location)
        keys = sort_keys(fl, configured_sort(cfg, b"tag"))
        filt = await asyncio.to_thread(ref_filter, repo, words)
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
                return None, IOResult(
                    exit_code=1, stderr="".join(err).encode()
                )
            for name, ref in doomed:
                sha = repo.refs[ref]
                await delete_ref(dispatch, location.commondir, ref.decode())
                out.append(
                    f"Deleted tag '{name}' "
                    f"(was {short(sha, abbrev_for(repo))})\n"
                )
            return yield_bytes("".join(out).encode()), IOResult(
                exit_code=1 if err else 0, stderr="".join(err).encode()
            )
        if flags.listing or flags.lines is not None or filtered or not texts:
            # git reads a -n count while building the format it lists
            # with, so a count below -1 is refused as the format's own
            # (after both usage refusals above, and in a repository
            # holding no tags), and --format drops -n altogether.
            template = fl.as_str("format")
            if template is None:
                template = (
                    lines_format(flags.lines) if flags.lines else NAME_FORMAT
                )
            fmt = listing_format(template)
            icase = fl.as_bool("ignore_case")

            def wanted(name: str) -> bool:
                return name.startswith(TAG_PREFIX) and match_short(
                    name, texts, icase
                )

            items, ctx, errors = await ref_listing(
                dispatch,
                repo,
                location,
                cfg,
                used_fields(fmt, keys or ()),
                wanted,
                filt,
                date_clock(inv.env),
            )
            rows, stopped = format_refs(
                fmt,
                items,
                ctx,
                keys,
                omit_empty=fl.as_bool("omit_empty"),
                icase=icase,
                stream=filt is None
                or (filt.merged is None and filt.no_merged is None),
            )
            return listing_result(rows, errors, stopped)
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
        target = resolve_target(repo, texts[1] if len(texts) > 1 else HEAD)
        if flags.annotate:
            written = await asyncio.to_thread(
                build_tag,
                repo,
                name,
                target,
                flags.message or "",
                identity(fl, doors.session_view),
                int(time.time()),
            )
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
        f"Updated tag '{name}' (was {short(was, abbrev_for(repo))})\n".encode()
    ), IOResult()


def tag_read_only(
    inv: CLIInvocation[None], location: RepoLocation | None
) -> GitError:
    """tag's refusal by a read-only mount: the lock on the ref it creates
    or deletes, and for an annotated tag the object it could not write
    first.

    Args:
        inv (CLIInvocation[None]): the line's invocation record.
        location (RepoLocation | None): the repository it opened.
    """
    fl = FlagView(inv.flags)
    ref = f"{TAG_PREFIX}{inv.texts[0] if inv.texts else ''}"
    root = location.commondir.virtual if location is not None else ".git"
    path = posixpath.join(root, ref)
    if fl.as_bool("delete"):
        return RefDeleteReadOnlyError(ref, path)
    if fl.as_bool("annotate") or fl.raw("message") is not None:
        return TagWriteReadOnlyError()
    return RefReadOnlyError(ref, path)
