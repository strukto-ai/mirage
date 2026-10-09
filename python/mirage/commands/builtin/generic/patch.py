import re
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from enum import Enum

from mirage.commands.builtin.utils.lines import split_lines
from mirage.commands.builtin.utils.stream import read_stdin_async
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import CommandName, FlagValue
from mirage.commands.spec.usage import extra_operand_error
from mirage.errors.constants import FS_ERRORS, READ_FAILURES
from mirage.errors.fs import fs_strerror
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.quote import shell_quote


def _strip_name(name: str, strip_count: int) -> str | None:
    """A patch name with ``-p`` leading components dropped, GNU's way.

    A run of slashes is one separator, and a name with fewer components
    than ``-p`` drops leaves no name at all.

    Args:
        name (str): the name a header gives.
        strip_count (int): ``-p``.
    """
    rest = name
    for _ in range(strip_count):
        cut = rest.find("/")
        if cut < 0:
            return None
        rest = rest[cut:].lstrip("/")
    return rest


def _label(line: str, strip_count: int) -> tuple[str, str]:
    """A ``---``/``+++`` line's name, and what a reject file says for it.

    The reject file names the file as ``-p`` leaves it (``/dev/null``
    when it leaves nothing) and keeps the timestamp the header carried.

    Args:
        line (str): the header line.
        strip_count (int): ``-p``.
    """
    rest = line[4:]
    tab = rest.find("\t")
    name = (rest if tab < 0 else rest[:tab]).strip()
    stamp = "" if tab < 0 else rest[tab:]
    stripped = None if name == "/dev/null" else _strip_name(name, strip_count)
    return name, ("/dev/null" if stripped is None else stripped) + stamp


_HUNK_HEADER = re.compile(r"@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")
# GNU patch's default fuzz factor: how many context lines at each end of
# a hunk may be ignored to place it.
_MAX_FUZZ = 2


def _span(start: int, count: int) -> str:
    return str(start) if count == 1 else f"{start},{count}"


@dataclass(frozen=True, slots=True)
class _Hunk:
    """One ``@@`` hunk: where it claims to start, and its lines.

    Args:
        old_start (int): the line its header says the old side starts at.
        new_start (int): the line its header says the new side starts at.
        note (str): what its header carries after the closing ``@@``.
        body (tuple[str, ...]): its lines, each led by ' ', '-' or '+'.
    """

    old_start: int
    new_start: int
    note: str
    body: tuple[str, ...]

    def swapped(self) -> "_Hunk":
        flip = {"-": "+", "+": "-"}
        return _Hunk(
            self.new_start,
            self.old_start,
            self.note,
            tuple(
                flip.get(line[:1], line[:1]) + line[1:] for line in self.body
            ),
        )

    def pattern(self) -> list[str]:
        return [line[1:] for line in self.body if line[:1] != "+"]

    def sizes(self) -> tuple[int, int]:
        """Its old and new sides' line counts."""
        return (
            sum(1 for line in self.body if line[:1] != "+"),
            sum(1 for line in self.body if line[:1] != "-"),
        )

    def first(self) -> int:
        """The line its old side starts at, GNU's ``pch_first``.

        An empty old side (``-3,0``) goes in after the line it names.
        """
        return self.old_start + (0 if self.pattern() else 1)

    def context(self) -> tuple[int, int]:
        """The context lines before its first change and after its last."""
        kinds = [line[:1] for line in self.body]
        prefix = next((i for i, k in enumerate(kinds) if k != " "), len(kinds))
        suffix = next(
            (i for i, k in enumerate(reversed(kinds)) if k != " "), len(kinds)
        )
        return prefix, suffix

    def rejected(self, out_offset: int) -> list[str]:
        """Its lines in a reject file, as GNU writes a hunk back.

        The ``@@`` line is moved by the output offset, and each run of
        changes lists its removed lines before its added ones.

        Args:
            out_offset (int): the lines the hunks applied before it added.
        """
        old, new = self.sizes()
        lines = [
            f"@@ -{_span(self.old_start + out_offset, old)} "
            f"+{_span(self.new_start + out_offset, new)} @@{self.note}"
        ]
        added: list[str] = []
        for line in self.body:
            if line[:1] == "+":
                added.append(line)
                continue
            if line[:1] == " ":
                lines.extend(added)
                added = []
            lines.append(line)
        return lines + added


@dataclass(frozen=True, slots=True)
class _Section:
    """One file's part of a patch.

    Args:
        old_label (str): what its reject file's ``---`` line says.
        new_label (str): what its reject file's ``+++`` line says.
        target (str): the file it patches by its headers, ``-p`` applied.
        hunks (tuple[_Hunk, ...]): its hunks in order.
    """

    old_label: str
    new_label: str
    target: str
    hunks: tuple[_Hunk, ...]


def _parse_hunks(lines: list[str], index: int) -> tuple[list[_Hunk], int]:
    """The hunks that start at ``lines[index]``, and the index after them.

    A hunk ends when its header's line counts are used up, as GNU reads
    it, so a removed line that reads ``-- x`` is never taken for the next
    file's header.

    Args:
        lines (list[str]): the patch's lines.
        index (int): where the first hunk header is expected.
    """
    hunks: list[_Hunk] = []
    while index < len(lines):
        match = _HUNK_HEADER.match(lines[index])
        if match is None:
            break
        note = lines[index][match.end() :]
        old_left = 1 if match.group(2) is None else int(match.group(2))
        new_left = 1 if match.group(4) is None else int(match.group(4))
        body: list[str] = []
        index += 1
        while index < len(lines) and (old_left > 0 or new_left > 0):
            line = lines[index]
            kind = line[:1]
            if kind in (" ", ""):
                old_left -= 1
                new_left -= 1
                body.append(" " + line[1:])
            elif kind == "-":
                old_left -= 1
                body.append(line)
            elif kind == "+":
                new_left -= 1
                body.append(line)
            elif kind != "\\":
                break
            index += 1
        while index < len(lines) and lines[index].startswith("\\"):
            index += 1
        hunks.append(
            _Hunk(int(match.group(1)), int(match.group(3)), note, tuple(body))
        )
    return hunks, index


def _parse_patch(patch_text: str, strip_count: int) -> list[_Section]:
    """The patch's file sections in the order it gives them.

    Two sections may name one file, and each is applied in turn, as GNU
    does; a section is never folded into another by its name.

    Args:
        patch_text (str): the patch.
        strip_count (int): ``-p``, leading components to drop.
    """
    sections: list[_Section] = []
    lines = split_lines(patch_text)
    old_label = "/dev/null"
    index = 0
    while index < len(lines):
        line = lines[index]
        index += 1
        if line.startswith("--- "):
            old_label = _label(line, strip_count)[1]
            continue
        if not line.startswith("+++ "):
            continue
        new_name, new_label = _label(line, strip_count)
        hunks, index = _parse_hunks(lines, index)
        target = _strip_name(new_name, strip_count)
        if target is None:
            target = new_name.rsplit("/", 1)[-1]
        sections.append(
            _Section(
                old_label, new_label, "/" + target.lstrip("/"), tuple(hunks)
            )
        )
        old_label = "/dev/null"
    return sections


def _matches(
    lines: list[str],
    pattern: list[str],
    where: int,
    prefix_fuzz: int,
    suffix_fuzz: int,
) -> bool:
    for k in range(prefix_fuzz, len(pattern) - suffix_fuzz):
        line_no = where + k
        if not 1 <= line_no <= len(lines) or lines[line_no - 1] != pattern[k]:
            return False
    return True


def _locate(
    lines: list[str], hunk: _Hunk, in_offset: int, fuzz: int, frozen: int
) -> int | None:
    """Where a hunk's old side is in ``lines``, GNU's ``locate_hunk``.

    The claimed line first, then alternately after and before it. With
    fuzz, that many context lines at each end go unchecked; a hunk with
    less context at one end is anchored there (a hunk that starts at the
    top of the file with no leading context can only match the top, one
    with no trailing context only the end).

    Args:
        lines (list[str]): the file's lines.
        hunk (_Hunk): the hunk, in the orientation being applied.
        in_offset (int): how far the hunks before it were found moved.
        fuzz (int): context lines each end may ignore.
        frozen (int): the lines already copied out, which it cannot use.
    """
    first = hunk.first() + in_offset
    pattern = hunk.pattern()
    if not pattern:
        return first
    prefix, suffix = hunk.context()
    context = max(prefix, suffix)
    prefix_fuzz = fuzz + prefix - context
    suffix_fuzz = fuzz + suffix - context
    max_pos = len(lines) - (len(pattern) - suffix_fuzz) + 1 - first
    max_neg = min(first - (frozen + 1 - (prefix - prefix_fuzz)), first - 1)
    if prefix_fuzz < 0:
        if hunk.first() > 1:
            prefix_fuzz = 0
        elif (
            frozen <= prefix
            and 1 - first <= max_pos
            and _matches(lines, pattern, 1, 0, suffix_fuzz)
        ):
            return 1
        else:
            return None
    if suffix_fuzz < 0:
        # GNU's rule, kept on purpose: diff writes a shorter trailing
        # context only at the end of a file, so a hunk with less context
        # after its change than before belongs at the end, even where its
        # lines also sit at the line its header names. GNU patch 2.8 edits
        # the last occurrence then, and fuzzes or fails a hunk the end of
        # the file no longer matches.
        at_end = len(lines) - len(pattern) + 1
        if first - at_end <= max_neg and _matches(
            lines, pattern, at_end, prefix_fuzz, 0
        ):
            return at_end
        return None
    for offset in range(max(max_pos, max_neg) + 1):
        if offset <= max_pos and _matches(
            lines, pattern, first + offset, prefix_fuzz, suffix_fuzz
        ):
            return first + offset
        if 0 < offset <= max_neg and _matches(
            lines, pattern, first - offset, prefix_fuzz, suffix_fuzz
        ):
            return first - offset
    return None


class _Reversed(Enum):
    """The first hunk fits only the other way round."""

    DETECTED = "detected"


def _place(
    lines: list[str], hunk: _Hunk, in_offset: int, frozen: int, probe: bool
) -> tuple[int, int] | _Reversed | None:
    """The line and fuzz a hunk applies at, None when it does not.

    Each fuzz level is tried in turn, and with ``probe`` a level the
    hunk misses is tried the other way round too, as GNU does for a
    file's first hunk: a patch already applied is caught there before
    more fuzz lets it in somewhere else.

    Args:
        lines (list[str]): the file's lines.
        hunk (_Hunk): the hunk, in the orientation being applied.
        in_offset (int): how far the hunks before it were found moved.
        frozen (int): the lines already copied out.
        probe (bool): try the other orientation at each level.
    """
    prefix, suffix = hunk.context()
    for fuzz in range(min(_MAX_FUZZ, max(prefix, suffix)) + 1):
        where = _locate(lines, hunk, in_offset, fuzz, frozen)
        if where is not None:
            return where, fuzz
        if (
            probe
            and _locate(lines, hunk.swapped(), in_offset, fuzz, frozen)
            is not None
        ):
            return _Reversed.DETECTED
    return None


def _splice(
    out: list[str], lines: list[str], src: int, where: int, hunk: _Hunk
) -> int:
    """Copy the file up to a hunk, then the hunk itself; the next line.

    Context lines are the file's own, as GNU's ``apply_hunk`` copies
    them, so a line fuzz let through keeps what the file says.

    Args:
        out (list[str]): the patched lines so far.
        lines (list[str]): the file's lines.
        src (int): the first line not yet copied, zero-based.
        where (int): the line the hunk's old side starts at.
        hunk (_Hunk): the hunk, in the orientation being applied.
    """
    out.extend(lines[src : max(where - 1, src)])
    at = where - 1
    for line in hunk.body:
        kind = line[:1]
        if kind == " ":
            if src <= at < len(lines):
                out.append(lines[at])
            at += 1
        elif kind == "-":
            at += 1
        else:
            out.append(line[1:])
    return max(at, src)


@dataclass(frozen=True, slots=True)
class _Outcome:
    """What applying one section did.

    Args:
        lines (list[str] | None): the patched lines, None when skipped.
        notes (list[str]): the lines GNU prints after ``patching file``.
        rejected (list[tuple[_Hunk, int]]): the hunks for the reject
            file as they were tried (``-R`` swaps them), each with the
            output offset it was refused at.
        exact (bool): every hunk applied where it said, with no fuzz.
    """

    lines: list[str] | None
    notes: list[str]
    rejected: list[tuple[_Hunk, int]]
    exact: bool


def _reversed_notes(reverse: bool, forward: bool) -> list[str]:
    """GNU's lines for a patch that reads as the other direction.

    Standard input is never a terminal here, so every question is
    answered with its default and the file is skipped.

    Args:
        reverse (bool): ``-R`` was given.
        forward (bool): ``-N`` was given.
    """
    seen = (
        "Unreversed patch detected!"
        if reverse
        else "Reversed (or previously applied) patch detected!"
    )
    if forward:
        return [f"{seen}  Skipping patch."]
    ask = "Ignore" if reverse else "Assume"
    return [f"{seen}  {ask} -R? [n] ", "Apply anyway? [n] ", "Skipping patch."]


def _as_tried(
    hunks: tuple[_Hunk, ...], reverse: bool
) -> list[tuple[_Hunk, int]]:
    return [(hunk.swapped() if reverse else hunk, 0) for hunk in hunks]


def _apply_section(
    lines: list[str], hunks: tuple[_Hunk, ...], reverse: bool, forward: bool
) -> _Outcome:
    """Apply one section's hunks to a file's lines, GNU patch's way.

    A hunk is placed by its context, at an offset or with fuzz when it
    has to be, and one that fits nowhere is rejected, never forced in.
    When the first hunk fits only the other way round the file is
    skipped as already applied (or reversed). Lines are reported in the
    output file's numbering: the input offset GNU found, plus what the
    hunks applied so far added.

    Args:
        lines (list[str]): the file's lines.
        hunks (tuple[_Hunk, ...]): the section's hunks.
        reverse (bool): ``-R``.
        forward (bool): ``-N``.
    """
    out: list[str] = []
    notes: list[str] = []
    rejected: list[tuple[_Hunk, int]] = []
    src = 0
    in_offset = 0
    out_offset = 0
    exact = True
    for number, hunk in enumerate(hunks, 1):
        active = hunk.swapped() if reverse else hunk
        placed = _place(lines, active, in_offset, src, number == 1)
        if placed is _Reversed.DETECTED:
            return _Outcome(
                None,
                _reversed_notes(reverse, forward),
                _as_tried(hunks, reverse),
                False,
            )
        if placed is None:
            notes.append(
                f"Hunk #{number} FAILED at "
                f"{active.first() + in_offset + out_offset}."
            )
            rejected.append((active, out_offset))
            exact = False
            continue
        where, fuzz = placed
        in_offset = where - active.first()
        src = _splice(out, lines, src, where, active)
        if fuzz or in_offset:
            exact = False
            note = f"Hunk #{number} succeeded at {where + out_offset}"
            if fuzz:
                note += f" with fuzz {fuzz}"
            if in_offset:
                note += (
                    f" (offset {in_offset} "
                    f"line{'' if in_offset == 1 else 's'})"
                )
            notes.append(note + ".")
        old, new = active.sizes()
        out_offset += new - old
    out.extend(lines[src:])
    return _Outcome(out, notes, rejected, exact)


def _reject_text(
    section: _Section, rejected: list[tuple[_Hunk, int]], reverse: bool
) -> bytes:
    """GNU's reject file: the section's names, then each hunk as tried.

    Args:
        section (_Section): the section the hunks are from.
        rejected (list[tuple[_Hunk, int]]): the hunks, each with the
            output offset it was refused at.
        reverse (bool): ``-R``, which swaps the names as it did the hunks.
    """
    names = (
        (section.new_label, section.old_label)
        if reverse
        else (section.old_label, section.new_label)
    )
    lines = [f"--- {names[0]}", f"+++ {names[1]}"]
    for hunk, out_offset in rejected:
        lines.extend(hunk.rejected(out_offset))
    return "".join(f"{line}\n" for line in lines).encode()


def _companion(spec: PathSpec, suffix: str) -> PathSpec:
    return PathSpec.from_str_path(
        spec.virtual + suffix, spec.vfs_path + suffix
    )


async def _load_patch_data(
    source: PathSpec | None,
    stdin: ByteSource | None,
    read_bytes: Callable[..., Awaitable[bytes]],
) -> bytes | str:
    """The patch text, or GNU's fatal line when it cannot be had.

    GNU opens the patch file before anything else and gives up on the
    whole run when it cannot (exit 2): an open that fails names the file
    (``Can't open patch file x : ...``), a read that fails does not
    (``read error : ...``), since only one patch file is ever read.

    Args:
        source (PathSpec | None): the patch file, None for stdin.
        stdin (ByteSource | None): standard input.
        read_bytes (Callable): bound reader.
    """
    if source is None:
        data = await read_stdin_async(stdin)
        return b"" if data is None else data
    try:
        return await read_bytes(source)
    except READ_FAILURES as exc:
        return f"patch: **** read error : {fs_strerror(exc)}\n"
    except FS_ERRORS as exc:
        label = shell_quote(source.raw_path or source.virtual)
        return (
            f"patch: **** Can't open patch file {label} : {fs_strerror(exc)}\n"
        )


async def patch(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    write_bytes: Callable[..., Awaitable[None]],
    has_vfs: bool,
    stdin: ByteSource | None = None,
    p: str | None = None,
    R: bool = False,
    i: PathSpec | None = None,
    N: bool = False,
    mount_prefix: str = "",
) -> tuple[ByteSource | None, IOResult]:
    if len(paths) > 2:
        raise extra_operand_error(
            CommandName.PATCH, paths[2].raw_path or paths[2].virtual
        )
    strip_count = int(p) if p else 0
    # `patch [ORIGFILE [PATCHFILE]]`: the second operand is the patch
    # file, ahead of -i, and the first is the one file every hunk goes to
    # in place of the names the patch's headers carry.
    source = paths[1] if len(paths) > 1 else i
    patch_data = await _load_patch_data(
        source if has_vfs else None, stdin, read_bytes
    )
    if isinstance(patch_data, str):
        return None, IOResult(exit_code=2, stderr=patch_data.encode())
    patch_text = patch_data.decode(errors="replace")
    sections = _parse_patch(patch_text, strip_count)
    orig = paths[0] if paths else None
    report: list[str] = []
    failed = False
    written: set[str] = set()
    for section in sections:
        if orig is not None:
            file_spec, shown = orig, orig.raw_path or orig.virtual
        else:
            file_spec = PathSpec.from_str_path(
                mount_prefix.rstrip("/") + "/" + section.target.lstrip("/"),
                section.target.lstrip("/"),
            )
            shown = section.target.lstrip("/")
        refused = await _patch_file(
            section,
            file_spec,
            shown,
            reverse=R,
            forward=N,
            read_bytes=read_bytes,
            write_bytes=write_bytes,
            report=report,
            written=written,
        )
        failed = failed or refused
    out = "".join(f"{line}\n" for line in report).encode() if report else None
    return out, IOResult(exit_code=1 if failed else 0)


async def _patch_file(
    section: _Section,
    spec: PathSpec,
    shown: str,
    *,
    reverse: bool,
    forward: bool,
    read_bytes: Callable[..., Awaitable[bytes]],
    write_bytes: Callable[..., Awaitable[None]],
    report: list[str],
    written: set[str],
) -> bool:
    """Apply one section to its file, GNU patch's way; True when a hunk
    of it was refused.

    A file that does not match the patch exactly is backed up to
    ``.orig`` the first time this run writes it, and the hunks that did
    not go in are saved to ``.rej``. A file that is not there is not
    made unless a hunk applied, and a directory is refused whole.

    Args:
        section (_Section): the section.
        spec (PathSpec): the file it patches.
        shown (str): that file as GNU names it.
        reverse (bool): ``-R``.
        forward (bool): ``-N``.
        read_bytes (Callable): bound reader.
        write_bytes (Callable): bound writer.
        report (list[str]): the lines printed so far, extended here.
        written (set[str]): the files this run has written already.
    """
    original: bytes | None = None
    try:
        original = await read_bytes(spec)
    except IsADirectoryError:
        report.append(
            f"File {shown} is not a regular file -- refusing to patch"
        )
        await _save_rejects(
            section,
            _as_tried(section.hunks, reverse),
            "ignored",
            spec,
            shown,
            reverse,
            write_bytes,
            report,
        )
        return True
    except FileNotFoundError:
        pass
    report.append(f"patching file {shown}")
    outcome = _apply_section(
        split_lines((original or b"").decode(errors="replace")),
        section.hunks,
        reverse,
        forward,
    )
    report.extend(outcome.notes)
    if outcome.lines is not None:
        if not outcome.exact and spec.virtual not in written:
            if original is None:
                report.append(f"Cannot stat file {shown}, skipping backup")
            else:
                backup = _companion(spec, ".orig")
                await write_bytes(backup, original)
        if original is not None or len(outcome.rejected) < len(section.hunks):
            data = "".join(f"{line}\n" for line in outcome.lines).encode()
            await write_bytes(spec, data)
            written.add(spec.virtual)
    if not outcome.rejected:
        return False
    await _save_rejects(
        section,
        outcome.rejected,
        "ignored" if outcome.lines is None else "FAILED",
        spec,
        shown,
        reverse,
        write_bytes,
        report,
    )
    return True


async def _save_rejects(
    section: _Section,
    rejected: list[tuple[_Hunk, int]],
    verb: str,
    spec: PathSpec,
    shown: str,
    reverse: bool,
    write_bytes: Callable[..., Awaitable[None]],
    report: list[str],
) -> None:
    """Write the hunks that did not go in to ``.rej``, and say so.

    Args:
        section (_Section): their section, whose names head the file.
        rejected (list[tuple[_Hunk, int]]): the hunks as they were tried,
            each with the output offset it was refused at.
        verb (str): ``FAILED``, or ``ignored`` for a skipped file.
        spec (PathSpec): the file they were for.
        shown (str): that file as GNU names it.
        reverse (bool): ``-R``.
        write_bytes (Callable): bound writer.
        report (list[str]): the lines printed so far, extended here.
    """
    total = len(section.hunks)
    report.append(
        f"{len(rejected)} out of {total} "
        f"hunk{'' if total == 1 else 's'} {verb} -- "
        f"saving rejects to file {shown}.rej"
    )
    reject = _companion(spec, ".rej")
    data = _reject_text(section, rejected, reverse)
    await write_bytes(reject, data)


__all__ = ["patch"]


@dataclass(frozen=True, slots=True)
class PatchFlags:
    strip: str | None = None
    reverse: bool = False
    input_path: PathSpec | None = None
    forward: bool = False


def parse_flags(flags: Mapping[str, FlagValue]) -> PatchFlags:
    fl = FlagView(flags, spec=SPECS["patch"])
    input_flag = fl.raw("i")
    return PatchFlags(
        strip=fl.as_str("p"),
        reverse=fl.as_bool("R"),
        input_path=input_flag if isinstance(input_flag, PathSpec) else None,
        forward=fl.as_bool("N"),
    )


async def patch_generic(
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
    read_bytes: Callable[..., Awaitable[bytes]],
    write_bytes: Callable[..., Awaitable[None]],
    has_vfs: bool,
) -> tuple[ByteSource | None, IOResult]:
    parsed = parse_flags(opts.flags)
    return await patch(
        paths,
        read_bytes=read_bytes,
        write_bytes=write_bytes,
        has_vfs=has_vfs,
        stdin=opts.stdin,
        p=parsed.strip,
        R=parsed.reverse,
        i=parsed.input_path,
        N=parsed.forward,
        mount_prefix=opts.mount_prefix or "",
    )
