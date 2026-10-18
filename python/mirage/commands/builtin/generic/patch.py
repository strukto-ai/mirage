import logging
import re
from collections.abc import Awaitable, Callable, Iterator, Mapping
from dataclasses import dataclass

from mirage.commands.builtin.utils.lines import split_lines
from mirage.commands.builtin.utils.size_suffix import decimal_value
from mirage.commands.builtin.utils.stream import read_stdin_async
from mirage.commands.config import Context
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import CommandName, FlagValue
from mirage.commands.spec.usage import extra_operand_error
from mirage.errors.constants import FS_ERRORS, READ_FAILURES
from mirage.errors.fs import fs_strerror
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.quote import shell_quote

logger = logging.getLogger(__name__)


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
# The fuzz factor the manual gives as patch's default: a hunk may leave
# up to this many of its outer context lines unmatched to be placed.
_FUZZ_FACTOR = 2


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

    def sizes(self) -> tuple[int, int]:
        """Its old and new sides' line counts."""
        return (
            sum(1 for line in self.body if line[:1] != "+"),
            sum(1 for line in self.body if line[:1] != "-"),
        )

    def rejected(self, grown: int) -> list[str]:
        """Its lines in a reject file, as GNU writes a hunk back.

        The ``@@`` line is moved by what the hunks placed before it
        added, and each run of changes lists its removed lines before
        its added ones.

        Args:
            grown (int): the lines the hunks placed before it added.
        """
        old, new = self.sizes()
        lines = [
            f"@@ -{_span(self.old_start + grown, old)} "
            f"+{_span(self.new_start + grown, new)} @@{self.note}"
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


@dataclass(frozen=True, slots=True)
class _Needle:
    """What a hunk looks for in the file, and where its header puts it.

    Args:
        old (tuple[str, ...]): its old side, context and removed lines.
        lead (int): the context lines before its first change.
        trail (int): the context lines after its last change.
        claimed (int): the line its header says the old side starts at;
            an empty old side (``-3,0``) goes in after the line it names,
            so it claims the line after that.
    """

    old: tuple[str, ...]
    lead: int
    trail: int
    claimed: int


def _needle_of(hunk: _Hunk) -> _Needle:
    kinds = [line[:1] for line in hunk.body]
    lead = 0
    while lead < len(kinds) and kinds[lead] == " ":
        lead += 1
    trail = 0
    while trail < len(kinds) - lead and kinds[-1 - trail] == " ":
        trail += 1
    old = tuple(line[1:] for line in hunk.body if line[:1] != "+")
    return _Needle(old, lead, trail, hunk.old_start + (0 if old else 1))


def _compared_at(needle: _Needle, fuzz: int) -> tuple[int, int]:
    """The context lines still compared above and below at ``fuzz``.

    Fuzz is spent on the longer end first: a hunk with three lines of
    context above its change and one below compares (3, 1) at fuzz 0,
    (2, 1) at fuzz 1 and (1, 1) at fuzz 2 (GNU patch 2.8).

    Args:
        needle (_Needle): the hunk's old side.
        fuzz (int): the context lines it may leave unmatched.
    """
    most = max(needle.lead, needle.trail) - fuzz
    return max(0, min(needle.lead, most)), max(0, min(needle.trail, most))


def _sits(
    lines: list[str],
    needle: _Needle,
    at: int,
    compared: tuple[int, int],
    used: int,
) -> bool:
    """Whether the hunk's old side, starting at line ``at``, is there.

    Only the context ``compared`` keeps is read. Lines left out above
    may hang off the top of the file, but nothing may run past its end
    except what is left out below. A hunk with less context at one end
    than at the other was cut short by that end of the file, so while
    that still holds it must meet it: a short bottom ends on the file's
    last line, and a short top whose header names line 1 starts on the
    first. Such a hunk is not found at all, rather than found out of
    order, where it would reach back into what earlier hunks used up:
    one meeting the end must start at or after ``used``, and one
    meeting the start must make its first change at or after it (GNU
    patch 2.8).

    Args:
        lines (list[str]): the file.
        needle (_Needle): the hunk's old side.
        at (int): the 0-based line its first line would be on.
        compared (tuple[int, int]): context kept above and below.
        used (int): the lines the hunks placed before it used up.
    """
    above, below = compared
    top = needle.lead - above
    stop = len(needle.old) - needle.trail + below
    if at + stop > len(lines) or (top < stop and at + top < 0):
        return False
    if above > below and (at + len(needle.old) != len(lines) or at < used):
        return False
    if above < below and needle.claimed <= 1:
        if at != 0 or needle.lead < used:
            return False
    for index in range(top, stop):
        if lines[at + index] != needle.old[index]:
            return False
    return True


def _tries(expected: int, used: int, last: int) -> Iterator[int]:
    """The lines a hunk is tried at, in the order GNU patch 2.8 tries them.

    From an expected line at or past ``used`` the search fans out: the
    expected line, one line later, one earlier, two later and so on, so
    at equal distance the later line wins, and it goes no higher than
    ``used``. From an expected line above ``used`` it reaches as far
    above the expected line as ``used`` is below it, and tries that
    farthest line first, then ``used``, then the lines between them in
    file order, then the lines after ``used``: with 20 lines used and a
    hunk expected at line 15 it tries 9, 21, 10, 11, ..., 20, 22, ...
    (1-based). There, a hunk expected past the last line it fits at is
    not tried anywhere.

    Args:
        expected (int): the 0-based line the header and the hunks before
            it point at.
        used (int): the lines the hunks placed before it used up.
        last (int): the last 0-based line the hunk fits at.
    """
    if expected < used:
        if expected > last:
            return
        farthest = 2 * expected - used
        yield farthest
        yield used
        yield from range(farthest + 1, min(used, last + 1))
        yield from range(used + 1, last + 1)
        return
    yield expected
    step = 1
    while expected + step <= last or expected - step >= used:
        if expected + step <= last:
            yield expected + step
        if expected - step >= used:
            yield expected - step
        step += 1


def _is_tried(at: int, expected: int, used: int, last: int) -> bool:
    """Whether ``_tries`` ever reaches line ``at``.

    Args:
        at (int): the 0-based line.
        expected (int): the 0-based line the hunk is expected at.
        used (int): the lines the hunks placed before it used up.
        last (int): the last 0-based line the hunk fits at.
    """
    if expected < used:
        if expected > last:
            return False
        farthest = 2 * expected - used
        return (
            at in (farthest, used)
            or farthest < at < min(used, last + 1)
            or used < at <= last
        )
    return at == expected or expected < at <= last or used <= at < expected


def _forced_edge(
    lines: list[str], needle: _Needle, compared: tuple[int, int]
) -> int | None:
    """The one line a hunk held to an end of the file can start at.

    None when the hunk is free to sit anywhere; see ``_sits`` for when
    it is held.

    Args:
        lines (list[str]): the file.
        needle (_Needle): the hunk's old side.
        compared (tuple[int, int]): context kept above and below.
    """
    above, below = compared
    if above > below:
        return len(lines) - len(needle.old)
    if above < below and needle.claimed <= 1:
        return 0
    return None


def _seek(
    lines: list[str], needle: _Needle, fuzz: int, expected: int, used: int
) -> int | None:
    """The 0-based line the hunk is found at with ``fuzz``, or None.

    A hunk with no old side is not looked for: it goes where it is
    expected. One held to an end of the file is tried at that one line,
    if the search would reach it, instead of at every line the search
    tries. One that lands on the line before the first, line 0, is
    taken as not found at all, though one landing higher still is found
    there (GNU patch 2.8: ``-0,0`` expected one line up fails plainly,
    expected two lines up it fails as misordered).

    Args:
        lines (list[str]): the file.
        needle (_Needle): the hunk's old side.
        fuzz (int): the context lines it may leave unmatched.
        expected (int): the 0-based line it is expected at.
        used (int): the lines the hunks placed before it used up.
    """
    found: int | None = expected
    if needle.old:
        compared = _compared_at(needle, fuzz)
        last = len(lines) - (len(needle.old) - needle.trail + compared[1])
        edge = _forced_edge(lines, needle, compared)
        if edge is None:
            found = next(
                (
                    at
                    for at in _tries(expected, used, last)
                    if _sits(lines, needle, at, compared, used)
                ),
                None,
            )
        elif _is_tried(edge, expected, used, last) and _sits(
            lines, needle, edge, compared, used
        ):
            found = edge
        else:
            found = None
    return None if found == -1 else found


def _fuzz_steps(needle: _Needle) -> Iterator[int]:
    """The fuzz levels worth trying, each one comparing less than the last.

    Args:
        needle (_Needle): the hunk's old side.
    """
    seen: tuple[int, int] | None = None
    for fuzz in range(_FUZZ_FACTOR + 1):
        compared = _compared_at(needle, fuzz)
        if compared != seen:
            seen = compared
            yield fuzz


def _emit(
    lines: list[str], hunk: _Hunk, needle: _Needle, at: int, out: list[str]
) -> int:
    """Write the hunk's changes, placed at ``at``, onto ``out``.

    Only the part from its first change to its last is written: the
    context around it stays in the file, where a later hunk may still
    read it, and context between changes is copied from the file rather
    than from the patch.

    Args:
        lines (list[str]): the file.
        hunk (_Hunk): the hunk.
        needle (_Needle): its old side.
        at (int): the 0-based line its old side starts at.
        out (list[str]): the patched lines so far, extended here.

    Returns:
        int: the 0-based line after the last one it changed.
    """
    source = at + needle.lead
    for line in hunk.body[needle.lead : len(hunk.body) - needle.trail]:
        kind = line[:1]
        if kind == "+":
            out.append(line[1:])
            continue
        if kind == " ":
            out.append(lines[source])
        source += 1
    return source


def _placed_note(ordinal: int, line: int, fuzz: int, moved: int) -> str:
    text = f"Hunk #{ordinal} succeeded at {line}"
    if fuzz:
        text += f" with fuzz {fuzz}"
    if moved:
        text += f" (offset {moved} line{'' if moved == 1 else 's'})"
    return text + "."


@dataclass(frozen=True, slots=True)
class _Outcome:
    """What applying one section did.

    Args:
        lines (list[str] | None): the patched lines, None when skipped.
        notes (list[str]): the lines GNU prints after ``patching file``.
        rejected (list[tuple[_Hunk, int]]): the hunks for the reject
            file as they were tried (``-R`` swaps them), each with the
            lines the hunks placed before it added.
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
    lines: list[str],
    hunks: tuple[_Hunk, ...],
    reverse: bool,
    forward: bool,
) -> _Outcome:
    """Apply one section's hunks to a file's lines, as GNU patch does.

    Each hunk is looked for where its header and the hunks before it
    point, at fuzz 0 and then with more of its outer context left out;
    one found nowhere is rejected. A hunk found where its change would
    land on lines an earlier hunk already changed is rejected too, and
    no further fuzz is tried for it. When the first hunk is not found
    but reads at that same fuzz the other way round, the file is
    skipped as already applied (or reversed). Lines are reported in the
    patched file's numbering.

    Args:
        lines (list[str]): the file's lines.
        hunks (tuple[_Hunk, ...]): the section's hunks.
        reverse (bool): ``-R``, which swaps each hunk first.
        forward (bool): ``-N``.
    """
    out: list[str] = []
    notes: list[str] = []
    rejected: list[tuple[_Hunk, int]] = []
    exact = True
    used = 0
    shift = 0
    grown = 0
    for ordinal, given in enumerate(hunks, 1):
        hunk = given.swapped() if reverse else given
        needle = _needle_of(hunk)
        other = _needle_of(hunk.swapped()) if ordinal == 1 else None
        expected = needle.claimed - 1 + shift
        at: int | None = None
        fuzz = 0
        for fuzz in _fuzz_steps(needle):
            at = _seek(lines, needle, fuzz, expected, used)
            if at is not None:
                break
            if (
                other is not None
                and _seek(lines, other, fuzz, other.claimed - 1, 0) is not None
            ):
                return _Outcome(
                    None,
                    _reversed_notes(reverse, forward),
                    _as_tried(hunks, reverse),
                    False,
                )
        if at is None or at + needle.lead < used:
            if at is None:
                line = needle.claimed
            else:
                notes.append("misordered hunks! output would be garbled")
                line = at + 1
                shift = at + 1 - needle.claimed
            notes.append(f"Hunk #{ordinal} FAILED at {line + grown}.")
            rejected.append((hunk, grown))
            exact = False
            continue
        shift = at + 1 - needle.claimed
        if fuzz or shift:
            notes.append(_placed_note(ordinal, at + 1 + grown, fuzz, shift))
            exact = False
        out.extend(lines[used : at + needle.lead])
        used = _emit(lines, hunk, needle, at, out)
        old, new = hunk.sizes()
        grown += new - old
    out.extend(lines[used:])
    return _Outcome(out, notes, rejected, exact)


def _reject_text(
    section: _Section, rejected: list[tuple[_Hunk, int]], reverse: bool
) -> bytes:
    """GNU's reject file: the section's names, then each hunk as tried.

    Args:
        section (_Section): the section the hunks are from.
        rejected (list[tuple[_Hunk, int]]): the hunks, each with the
            lines the hunks placed before it added.
        reverse (bool): ``-R``, which swaps the names as it did the hunks.
    """
    names = (
        (section.new_label, section.old_label)
        if reverse
        else (section.old_label, section.new_label)
    )
    lines = [f"--- {names[0]}", f"+++ {names[1]}"]
    for hunk, grown in rejected:
        lines.extend(hunk.rejected(grown))
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
    p: int = 0,
    R: bool = False,
    i: PathSpec | None = None,
    N: bool = False,
    mount_prefix: str = "",
) -> tuple[ByteSource | None, IOResult]:
    if len(paths) > 2:
        raise extra_operand_error(
            CommandName.PATCH, paths[2].raw_path or paths[2].virtual
        )
    strip_count = p
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
    rejects: dict[str, bytes] = {}
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
            rejects=rejects,
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
    rejects: dict[str, bytes],
) -> bool:
    """Apply one section to its file, GNU patch's way; True when a hunk
    of it was refused.

    A file that does not match the patch exactly is backed up to
    ``.orig`` the first time this run writes it, and the hunks that did
    not go in are saved to ``.rej``, after those an earlier section of
    this run saved for it. A file that is not there is not made unless a
    hunk applied, and a directory is refused whole.

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
        rejects (dict[str, bytes]): each file's ``.rej`` text so far.
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
            rejects,
        )
        return True
    except FileNotFoundError as exc:
        logger.debug("nothing to patch yet at %s: %s", spec.virtual, exc)
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
        rejects,
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
    rejects: dict[str, bytes],
) -> None:
    """Write the hunks that did not go in to ``.rej``, and say so.

    A file patched by several sections of one patch keeps one ``.rej``:
    each section's rejects follow the last, under their own names.

    Args:
        section (_Section): their section, whose names head the file.
        rejected (list[tuple[_Hunk, int]]): the hunks as they were tried,
            each with the lines the hunks placed before it added.
        verb (str): ``FAILED``, or ``ignored`` for a skipped file.
        spec (PathSpec): the file they were for.
        shown (str): that file as GNU names it.
        reverse (bool): ``-R``.
        write_bytes (Callable): bound writer.
        report (list[str]): the lines printed so far, extended here.
        rejects (dict[str, bytes]): each file's ``.rej`` text so far.
    """
    total = len(section.hunks)
    report.append(
        f"{len(rejected)} out of {total} "
        f"hunk{'' if total == 1 else 's'} {verb} -- "
        f"saving rejects to file {shown}.rej"
    )
    reject = _companion(spec, ".rej")
    data = rejects.get(reject.virtual, b"") + _reject_text(
        section, rejected, reverse
    )
    rejects[reject.virtual] = data
    await write_bytes(reject, data)


__all__ = ["patch"]


# A -p value is one optional sign, then digits to the end of the word:
# GNU patch 2.8 refuses `3x` and ` 1`, and takes `+0`.
STRIP_COUNT = re.compile(r"[+-]?[0-9]+")


def _strip_count(text: str) -> int | None:
    """``-p`` as GNU patch scans it, None for no number.

    Args:
        text (str): the value as typed.
    """
    if STRIP_COUNT.fullmatch(text) is None:
        return None
    value = decimal_value(text.lstrip("+-"))
    return -value if text.startswith("-") else value


def _strip_refusal(text: str, value: int | None) -> str:
    """GNU patch's fatal line for a -p value that is no number or negative.

    Args:
        text (str): the value as typed.
        value (int | None): what it scanned to, None for no number.
    """
    problem = "is not a number" if value is None else "is negative"
    return f"patch: **** strip count {shell_quote(text)} {problem}"


@dataclass(frozen=True, slots=True)
class PatchFlags:
    strip: int = 0
    reverse: bool = False
    input_path: PathSpec | None = None
    forward: bool = False


def parse_flags(flags: Mapping[str, FlagValue]) -> PatchFlags:
    fl = FlagView(flags, spec=SPECS["patch"])
    input_flag = fl.raw("i")
    strip = fl.as_number("p", _strip_count, _strip_refusal, low=0, exit_code=2)
    return PatchFlags(
        strip=0 if strip is None else strip,
        reverse=fl.as_bool("R"),
        input_path=input_flag if isinstance(input_flag, PathSpec) else None,
        forward=fl.as_bool("N"),
    )


async def patch_generic(
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
    read_bytes: Callable[..., Awaitable[bytes]],
    write_bytes: Callable[..., Awaitable[None]],
    has_vfs: bool,
) -> tuple[ByteSource | None, IOResult]:
    parsed = parse_flags(ctx.flags)
    return await patch(
        paths,
        read_bytes=read_bytes,
        write_bytes=write_bytes,
        has_vfs=has_vfs,
        stdin=ctx.stdin,
        p=parsed.strip,
        R=parsed.reverse,
        i=parsed.input_path,
        N=parsed.forward,
        mount_prefix=ctx.mount_prefix or "",
    )
