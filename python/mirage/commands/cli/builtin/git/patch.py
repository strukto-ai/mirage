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

from collections.abc import Sequence
from difflib import SequenceMatcher

from dulwich.objects import Blob, ObjectID
from dulwich.repo import BaseRepo

from mirage.commands.cli.builtin.git.constants import FUNCNAME_START, GIT_SPACE
from mirage.commands.cli.builtin.git.render import quote_path
from mirage.commands.cli.builtin.git.summary import BINARY_SNIFF
from mirage.shell.bytes import encode_text

OID_HEX = 40
DEV_NULL = "/dev/null"
HUNK_CONTEXT = 3
FUNCNAME_BYTES = 80
HUNK_HEADER_BYTES = 128


def blob_data(repo: BaseRepo, entry: tuple[int, bytes] | None) -> bytes:
    """An entry's bytes: a blob's contents, a submodule's commit line.

    Args:
        repo (BaseRepo): repository to read blobs from.
        entry (tuple[int, bytes] | None): the (mode, id) pair, None for
            a missing side, which reads as empty.
    """
    if entry is None:
        return b""
    if entry[0] == 0o160000:
        return b"Subproject commit " + entry[1] + b"\n"
    obj = repo.object_store[ObjectID(entry[1])]
    assert isinstance(obj, Blob)
    return obj.data


def short_oid(entry: tuple[int, bytes] | None, width: int) -> str:
    """An entry's object id cut to ``width``, zeros for a missing side.

    Args:
        entry (tuple[int, bytes] | None): the (mode, id) pair or None.
        width (int): how many hex digits to keep.
    """
    return (entry[1].decode() if entry else "0" * OID_HEX)[:width]


def file_patch(
    repo: BaseRepo,
    name: str,
    origin: str,
    old: tuple[int, bytes] | None,
    new: tuple[int, bytes] | None,
    score: int | None,
    width: int,
    fully: bool = True,
    context: int = HUNK_CONTEXT,
    function_context: bool = False,
    force_text: bool = False,
) -> bytes:
    """One path's patch, headers and hunks, as git's builtin_diff writes it.

    A change between a file and a symlink is split into a deletion and
    a creation, the way git's run_diff splits a type change. A ``---``
    or ``+++`` label holding a space ends in a tab, so a patch tool can
    tell where the name stops.

    Args:
        repo (BaseRepo): repository to read blobs from.
        name (str): the destination path, surrogate-escaped.
        origin (str): the source path, surrogate-escaped.
        old (tuple[int, bytes] | None): the source (mode, id), None
            for a created path.
        new (tuple[int, bytes] | None): the destination (mode, id),
            None for a deleted path.
        score (int | None): a rename's similarity, None when the path
            was not renamed.
        width (int): how many hex digits the index line keeps.
        fully (bool): ``core.quotePath``.
        context (int): the requested number of context lines.
        function_context (bool): ``-W``, widen hunks to whole functions.
        force_text (bool): render binary blobs as text under ``--text``.
    """
    if old and new and old[0] & 0o170000 != new[0] & 0o170000:
        return file_patch(
            repo,
            name,
            origin,
            old,
            None,
            score,
            width,
            fully,
            context,
            function_context,
            force_text,
        ) + file_patch(
            repo,
            name,
            origin,
            None,
            new,
            score,
            width,
            fully,
            context,
            function_context,
            force_text,
        )
    source = quote_path(f"a/{origin}", False, fully)
    target = quote_path(f"b/{name}", False, fully)
    head = [f"diff --git {source} {target}"]
    if old is None and new:
        head.append(f"new file mode {new[0]:06o}")
    elif new is None and old:
        head.append(f"deleted file mode {old[0]:06o}")
    elif old and new and old[0] != new[0]:
        head += [f"old mode {old[0]:06o}", f"new mode {new[0]:06o}"]
    if score is not None:
        head += [
            f"similarity index {score}%",
            f"rename from {quote_path(origin, False, fully)}",
            f"rename to {quote_path(name, False, fully)}",
        ]
    if old and new and old[1] == new[1]:
        return encode_text("".join(line + "\n" for line in head))
    index = f"index {short_oid(old, width)}..{short_oid(new, width)}"
    if old and new and old[0] == new[0]:
        index += f" {old[0]:06o}"
    head.append(index)
    before, after = blob_data(repo, old), blob_data(repo, new)
    source = source if old else DEV_NULL
    target = target if new else DEV_NULL
    if not force_text and any(
        b"\0" in data[:BINARY_SNIFF] for data in (before, after)
    ):
        head.append(f"Binary files {source} and {target} differ")
        return encode_text("".join(line + "\n" for line in head))
    body = hunks(
        byte_lines(before), byte_lines(after), context, function_context
    )
    if body:
        head += [
            f"--- {source}" + ("\t" if " " in source else ""),
            f"+++ {target}" + ("\t" if " " in target else ""),
        ]
    return encode_text("".join(line + "\n" for line in head)) + body


def byte_lines(data: bytes) -> list[bytes]:
    """Split a blob at each newline only, keeping them, as xdiff does.

    Args:
        data (bytes): the blob's bytes.
    """
    *whole, rest = data.split(b"\n")
    return [line + b"\n" for line in whole] + ([rest] if rest else [])


def hunks(
    old: list[bytes],
    new: list[bytes],
    count: int = HUNK_CONTEXT,
    function_context: bool = False,
) -> bytes:
    """The ``@@`` hunks of a two-way patch, as xdiff's xdl_emit_diff emits.

    Each header carries the nearest earlier line of the old side that
    starts with a letter, ``_`` or ``$`` (git's default funcname), and
    keeps the previous hunk's when none lies between the two.

    Args:
        old (list[bytes]): the old side's lines, newlines kept.
        new (list[bytes]): the new side's lines, newlines kept.
        count (int): the requested number of context lines.
        function_context (bool): ``-W``, widen each hunk to the whole
            function around its change.
    """
    out = []
    context = b""
    searched = -1
    matcher = SequenceMatcher(a=old, b=new, autojunk=False)
    codes = list(matcher.get_opcodes())
    groups = list(matcher.get_grouped_opcodes(count))
    if function_context:
        groups = _function_groups(old, codes, groups)
    for group in groups:
        start, stop = group[0][1], group[-1][2]
        found = next(
            (
                old[k]
                for k in range(start - 1, searched, -1)
                if old[k] and chr(old[k][0]) in FUNCNAME_START
            ),
            None,
        )
        searched = start - 1
        if found is not None:
            context = found[:FUNCNAME_BYTES].rstrip(GIT_SPACE)
        head = (
            f"@@ -{_span(start, stop)} +{_span(group[0][3], group[-1][4])} @@"
        ).encode()
        if context:
            head += b" " + context[: HUNK_HEADER_BYTES - len(head) - 2]
        out.append(head + b"\n")
        for tag, i1, i2, j1, j2 in group:
            if tag == "equal":
                out.extend(_hunk_line(b" ", line) for line in old[i1:i2])
                continue
            out.extend(_hunk_line(b"-", line) for line in old[i1:i2])
            out.extend(_hunk_line(b"+", line) for line in new[j1:j2])
    return b"".join(out)


def _function_groups(
    old: list[bytes],
    codes: Sequence[tuple[str, int, int, int, int]],
    groups: list[list[tuple[str, int, int, int, int]]],
) -> list[list[tuple[str, int, int, int, int]]]:
    """Widen changed ranges to Git's default function boundaries.

    Pinned against Git 2.47.3 (Debian stable) and 2.50.1.

    Args:
        old (list[bytes]): original lines.
        codes (Sequence[tuple[str, int, int, int, int]]): diff opcodes.
        groups (list[list[tuple[str, int, int, int, int]]]): bounded hunks.
    """
    boundaries = [
        i
        for i, line in enumerate(old)
        if line and chr(line[0]) in FUNCNAME_START
    ]
    ranges: list[tuple[int, int]] = []
    for group in groups:
        changes = [code for code in group if code[0] != "equal"]
        start = min(
            group[0][1],
            max((i for i in boundaries if i <= changes[0][1]), default=0),
        )
        end = min(
            (
                i
                for i in boundaries
                if i >= max(changes[-1][2], changes[-1][1] + 1)
            ),
            default=len(old),
        )
        while (
            end < len(old)
            and end > changes[-1][2]
            and not old[end - 1].strip()
        ):
            end -= 1
        end = max(end, group[-1][2])
        if ranges and start <= ranges[-1][1]:
            ranges[-1] = (ranges[-1][0], max(end, ranges[-1][1]))
        else:
            ranges.append((start, end))
    result = []
    for start, end in ranges:
        group = []
        for tag, i1, i2, j1, j2 in codes:
            if tag == "equal":
                lo, hi = max(start, i1), min(end, i2)
                if lo < hi:
                    group.append((tag, lo, hi, j1 + lo - i1, j1 + hi - i1))
            elif i1 <= end and i2 >= start:
                group.append((tag, i1, i2, j1, j2))
        result.append(group)
    return result


def _span(start: int, stop: int) -> str:
    """A hunk range: ``start,count``, the count dropped when it is one.

    Args:
        start (int): the first line, counted from zero.
        stop (int): one past the last line.
    """
    if stop - start == 1:
        return str(start + 1)
    return f"{start + 1 if stop > start else start},{stop - start}"


def _hunk_line(marker: bytes, line: bytes) -> bytes:
    """One hunk line, with git's marker when it has no newline.

    Args:
        marker (bytes): ``b' '``, ``b'-'`` or ``b'+'``.
        line (bytes): the line, with its newline when it has one.
    """
    if line.endswith(b"\n"):
        return marker + line
    return marker + line + b"\n\\ No newline at end of file\n"
