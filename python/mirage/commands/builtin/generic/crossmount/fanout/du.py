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

from mirage.commands.builtin.generic.crossmount.types import OperandRun
from mirage.commands.builtin.generic.du import rollup, separate_total
from mirage.commands.builtin.utils.formatting import _human_size
from mirage.utils.path import respell_raw


def _format_size(size: int, human: bool) -> str:
    return _human_size(size) if human else str(size)


def _parse_rows(blocks: Sequence[bytes]) -> list[tuple[str, int]]:
    """Every ``SIZE\\tPATH`` row across the per-mount blocks.

    Args:
        blocks (Sequence[bytes]): rendered du output, one per mount.
    """
    rows: list[tuple[str, int]] = []
    for data in blocks:
        for line in data.decode(errors="replace").splitlines():
            size_text, tab, label = line.partition("\t")
            if not tab or not size_text.isdigit():
                continue
            rows.append((label, int(size_text)))
    return rows


def _leaves(
    rows: Sequence[tuple[str, int]], mount_roots: Sequence[str] = ()
) -> list[tuple[str, int]]:
    """Keep the rows nothing else sits under.

    The blocks are rendered text, which does not say which row is a file
    and which is a directory, but the shape does: a directory row is an
    ancestor of some other row. mirage never emits a row for an empty
    directory (no leaf points at one, the documented divergence), so a
    row with no descendants is a file. The one exception is a mount root,
    which is a directory even when the mount is empty, so those are named
    rather than inferred.

    Args:
        rows (Sequence[tuple[str, int]]): every parsed row.
        mount_roots (Sequence[str]): paths that are directories whatever
            their shape.
    """
    paths = {path.rstrip("/") for path, _ in rows}
    known = {root.rstrip("/") for root in mount_roots}
    return [(path, size) for path, size in rows
            if path.rstrip("/") not in known and not any(
                other.startswith(path.rstrip("/") + "/") for other in paths)]


def merge_du_blocks(
        blocks: Sequence[bytes],
        root: str,
        label: str,
        *,
        a: bool,
        s: bool,
        c: bool,
        human: bool,
        max_depth: int | None,
        separate_dirs: bool = False,
        mount_roots: Sequence[str] = (),
) -> bytes:
    """Fold per-mount du blocks into one tree, GNU's way.

    A nested mount's bytes belong to every directory above it, so the
    blocks cannot simply be concatenated: pinned on coreutils 9.7 over a
    real mount, ``du base`` prints ``7 base/inner`` then ``17 base``, and
    ``du -s base`` prints the single row ``17 base``, where concatenation
    reported the parent's own ``10``. Only ``-x``, which mirage does not
    implement, gives the unfolded number.

    The per-mount runs are asked for every row (``-a``, no ``-s``, no
    depth limit) so the leaves survive the round trip; the tree is then
    derived once by the same ``rollup`` a single-mount run uses, so
    ordering, ``--max-depth`` pruning and the ``-a`` file rows all come
    out of one implementation rather than two.

    Args:
        blocks (Sequence[bytes]): rendered du output, one per mount.
        root (str): the operand's absolute virtual path.
        label (str): the operand as the user typed it.
        a (bool): -a, keep the file rows too.
        s (bool): -s, one row for the operand and nothing else.
        c (bool): -c, append the grand total row.
        human (bool): format the sizes like ``du -h`` does.
        max_depth (int | None): --max-depth, prune what is printed.
        separate_dirs (bool): -S, a directory counts only the files that
            sit directly in it. The per-mount runs are asked without it,
            because the merge needs their leaves and applies it here.
        mount_roots (Sequence[str]): the descendant mount roots, which
            are directories whether or not they hold anything. An empty
            mount contributes only its own row, which the leaf inference
            would otherwise read as a zero-byte file and hide.
    """
    leaves = _leaves(_parse_rows(blocks), mount_roots)
    total = sum(size for _, size in leaves)
    # -S scopes to the operand's own row; GNU keeps the -c grand total
    # recursive (coreutils 9.7 over a real mount: `du -bSc base` prints
    # `3 base` then `10 total`).
    own = separate_total(leaves, root) if separate_dirs else total
    lines: list[str] = []
    if not s:
        rows = rollup(leaves,
                      root,
                      a=a,
                      max_depth=max_depth,
                      dirs=mount_roots,
                      separate_dirs=separate_dirs)
        shown = respell_raw([node for node, _ in rows], root, label)
        lines = [
            _format_size(size, human) + "\t" + name
            for name, (_, size) in zip(shown, rows)
        ]
    lines.append(_format_size(own, human) + "\t" + label)
    if c:
        lines.append(_format_size(total, human) + "\ttotal")
    return ("\n".join(lines) + "\n").encode()


def _humanize_row(line: str) -> str:
    size_text, tab, label = line.partition("\t")
    if not tab:
        return line
    return _human_size(int(size_text)) + "\t" + label


def merge_du_totals(blocks: Sequence[bytes], human: bool) -> bytes:
    """Strip each block's own total row and emit one global total.

    GNU ``du -c`` prints exactly one grand total, whatever it walked
    (pinned on coreutils 9.7: ``du -c`` over a directory holding a mount
    reports the mounted filesystem's bytes inside the one total). mirage
    reaches that number by concatenating runs, so each run's own total
    row (always its last) is removed here and the values re-summed.

    The callers force the runs to report exact bytes even under ``-h``,
    and the sizes are humanized here instead. Summing already-humanized
    totals would round twice, so two 1500-byte operands read back as 1536
    each and report ``3.0K`` where one mount says ``2.9K``. Per-run totals
    cannot be replaced by summing the rows either: without ``-a`` a run
    prints a row per directory, and those nest.

    Args:
        blocks (Sequence[bytes]): rendered du output, one per run.
        human (bool): Format the sizes like ``du -h`` does.
    """
    kept: list[str] = []
    total = 0
    for data in blocks:
        body = data.decode(errors="replace").splitlines()
        if body and body[-1].endswith("\ttotal"):
            total += int(body[-1].rsplit("\t", 1)[0])
            body = body[:-1]
        kept.extend(_humanize_row(line) if human else line for line in body)
    kept.append(_format_size(total, human) + "\ttotal")
    return ("\n".join(kept) + "\n").encode()


def du_total(results: list[OperandRun], human: bool) -> bytes:
    """Re-total a per-operand fan-out, one native run per operand.

    Every native run receives ``-c`` so glob operands total natively.

    Args:
        results (list[OperandRun]): Per-operand native du runs.
        human (bool): Format the sizes like ``du -h`` does.
    """
    return merge_du_totals([run.data for run in results], human)
