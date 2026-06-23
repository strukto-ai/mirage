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

from collections.abc import AsyncIterator

from mirage.commands.builtin.generic.awk import awk as generic_awk
from mirage.commands.builtin.generic.base64_cmd import \
    base64_cmd as generic_base64
from mirage.commands.builtin.generic.column import column as generic_column
from mirage.commands.builtin.generic.comm import comm as generic_comm
from mirage.commands.builtin.generic.expand import expand as generic_expand
from mirage.commands.builtin.generic.file import file_cmd as generic_file
from mirage.commands.builtin.generic.fmt import fmt as generic_fmt
from mirage.commands.builtin.generic.fold import fold as generic_fold
from mirage.commands.builtin.generic.iconv import iconv as generic_iconv
from mirage.commands.builtin.generic.join import join_cmd as generic_join
from mirage.commands.builtin.generic.jq import jq as generic_jq
from mirage.commands.builtin.generic.look import look as generic_look
from mirage.commands.builtin.generic.md5 import md5 as generic_md5
from mirage.commands.builtin.generic.paste import paste as generic_paste
from mirage.commands.builtin.generic.sha256sum import \
    sha256sum as generic_sha256sum
from mirage.commands.builtin.generic.strings import strings as generic_strings
from mirage.commands.builtin.generic.tac import tac as generic_tac
from mirage.commands.builtin.generic.tee import tee as generic_tee
from mirage.commands.builtin.generic.tr import tr as generic_tr
from mirage.commands.builtin.generic.unexpand import \
    unexpand as generic_unexpand
from mirage.commands.builtin.generic.xxd import xxd as generic_xxd
from mirage.commands.builtin.generic_bind.adapter import CommandIO
from mirage.commands.builtin.generic_bind.builders.read import \
    _resolve_or_empty
from mirage.commands.builtin.generic_bind.provision import make_jq_provision
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def _tac(
    ops: CommandIO,
    accessor: object,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    index: object = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    paths = await _resolve_or_empty(ops, accessor, paths, index)
    return await generic_tac(paths,
                             read_stream=ops.read_stream,
                             accessor=accessor,
                             stdin=stdin)


async def _tr(
    ops: CommandIO,
    accessor: object,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    d: bool = False,
    s: bool = False,
    c: bool = False,
    index: object = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    paths = await _resolve_or_empty(ops, accessor, paths, index)
    return await generic_tr(
        paths,
        texts,
        read_stream=ops.read_stream,
        accessor=accessor,
        stdin=stdin,
        delete=d,
        squeeze=s,
        complement=c,
    )


async def _xxd(
    ops: CommandIO,
    accessor: object,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    r: bool = False,
    p: bool = False,
    args_l: str | bool = False,
    c: str | bool = False,
    s: str | bool = False,
    g: str | bool = False,
    u: bool = False,
    index: object = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    paths = await _resolve_or_empty(ops, accessor, paths, index)
    skip = int(s) if s and s is not True else 0
    limit = int(args_l) if args_l and args_l is not True else 0
    cols = int(c) if c and c is not True else 16
    group = int(g) if g and g is not True else 2
    return await generic_xxd(paths,
                             read_stream=ops.read_stream,
                             accessor=accessor,
                             stdin=stdin,
                             reverse=r,
                             plain=p,
                             uppercase=u,
                             cols=cols,
                             group=group,
                             skip=skip,
                             limit=limit)


async def _base64(
    ops: CommandIO,
    accessor: object,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    d: bool = False,
    D: bool = False,
    w: str | None = None,
    index: object = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    paths = await _resolve_or_empty(ops, accessor, paths, index)
    return await generic_base64(paths,
                                read_stream=ops.read_stream,
                                accessor=accessor,
                                stdin=stdin,
                                decode=d or D,
                                wrap=int(w) if w is not None else None)


async def _strings(
    ops: CommandIO,
    accessor: object,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    n: str | None = None,
    index: object = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    paths = await _resolve_or_empty(ops, accessor, paths, index)
    return await generic_strings(paths,
                                 read_bytes=ops.read_bytes,
                                 accessor=accessor,
                                 stdin=stdin,
                                 min_len=int(n) if n else 4)


async def _fold(
    ops: CommandIO,
    accessor: object,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    w: str | None = None,
    s: bool = False,
    index: object = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    paths = await _resolve_or_empty(ops, accessor, paths, index)
    return await generic_fold(paths,
                              read_bytes=ops.read_bytes,
                              accessor=accessor,
                              stdin=stdin,
                              width=int(w) if w is not None else 80,
                              break_spaces=s)


async def _fmt(
    ops: CommandIO,
    accessor: object,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    w: str | None = None,
    index: object = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    paths = await _resolve_or_empty(ops, accessor, paths, index)
    return await generic_fmt(paths,
                             read_bytes=ops.read_bytes,
                             accessor=accessor,
                             stdin=stdin,
                             width=int(w) if w is not None else 75)


async def _expand(
    ops: CommandIO,
    accessor: object,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    t: str | None = None,
    i: bool = False,
    index: object = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    paths = await _resolve_or_empty(ops, accessor, paths, index)
    return await generic_expand(paths,
                                read_bytes=ops.read_bytes,
                                accessor=accessor,
                                stdin=stdin,
                                tabsize=int(t) if t is not None else 8,
                                initial_only=i)


async def _unexpand(
    ops: CommandIO,
    accessor: object,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    t: str | None = None,
    a: bool = False,
    index: object = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    paths = await _resolve_or_empty(ops, accessor, paths, index)
    return await generic_unexpand(paths,
                                  read_bytes=ops.read_bytes,
                                  accessor=accessor,
                                  stdin=stdin,
                                  tabsize=int(t) if t is not None else 8,
                                  all_spaces=a)


async def _paste(
    ops: CommandIO,
    accessor: object,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    d: str | None = None,
    s: bool = False,
    index: object = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    paths = await _resolve_or_empty(ops, accessor, paths, index)
    return await generic_paste(paths,
                               read_bytes=ops.read_bytes,
                               accessor=accessor,
                               stdin=stdin,
                               delimiter=d if d else "\t",
                               serial=s)


async def _column(
    ops: CommandIO,
    accessor: object,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    t: bool = False,
    s: str | None = None,
    o: str | None = None,
    index: object = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    paths = await _resolve_or_empty(ops, accessor, paths, index)
    return await generic_column(paths,
                                read_bytes=ops.read_bytes,
                                accessor=accessor,
                                stdin=stdin,
                                table=t,
                                separator=s,
                                output_separator=o)


async def _look(
    ops: CommandIO,
    accessor: object,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    f: bool = False,
    index: object = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if not texts:
        raise ValueError("look: missing prefix")
    paths = await _resolve_or_empty(ops, accessor, paths, index)
    return await generic_look(paths,
                              texts[0],
                              read_bytes=ops.read_bytes,
                              accessor=accessor,
                              stdin=stdin,
                              fold_case=f)


async def _md5(
    ops: CommandIO,
    accessor: object,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    index: object = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    paths = await _resolve_or_empty(ops, accessor, paths, index)
    return await generic_md5(paths,
                             read_bytes=ops.read_bytes,
                             accessor=accessor,
                             stdin=stdin)


async def _sha256sum(
    ops: CommandIO,
    accessor: object,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    c: bool = False,
    index: object = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    paths = await _resolve_or_empty(ops, accessor, paths, index)
    return await generic_sha256sum(paths,
                                   read_bytes=ops.read_bytes,
                                   read_stream=ops.read_stream,
                                   accessor=accessor,
                                   stdin=stdin,
                                   check=c)


async def _comm(
    ops: CommandIO,
    accessor: object,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    check_order: bool = False,
    nocheck_order: bool = False,
    index: object = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if not ops.ready(accessor) or len(paths) < 2:
        raise ValueError("comm: requires two paths")
    paths = await ops.resolve_glob(accessor, paths, index)
    return await generic_comm(
        paths,
        read_bytes=ops.read_bytes,
        accessor=accessor,
        suppress1=bool(_extra.get("args_1", False)),
        suppress2=bool(_extra.get("2", False)),
        suppress3=bool(_extra.get("3", False)),
        check_order=check_order,
    )


async def _join(
    ops: CommandIO,
    accessor: object,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    t: str | None = None,
    a: str | None = None,
    v: str | None = None,
    e: str | None = None,
    o: str | None = None,
    index: object = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if not ops.ready(accessor) or len(paths) < 2:
        raise ValueError("join: requires two paths")
    paths = await ops.resolve_glob(accessor, paths, index)
    return await generic_join(paths,
                              read_bytes=ops.read_bytes,
                              accessor=accessor,
                              field1=int(_extra.get("args_1", 1)) - 1,
                              field2=int(_extra.get("2", 1)) - 1,
                              separator=t,
                              also_unpairable=a,
                              only_unpairable=v,
                              empty_value=e,
                              output_format=o)


async def _file(
    ops: CommandIO,
    accessor: object,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    b: bool = False,
    i: bool = False,
    index: object = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if not ops.ready(accessor) or not paths:
        raise ValueError("file: missing operand")
    paths = await ops.resolve_glob(accessor, paths, index)
    return await generic_file(paths,
                              read_bytes=ops.read_bytes,
                              stat_fn=ops.stat,
                              accessor=accessor,
                              b=b,
                              i=i)


async def _awk(
    ops: CommandIO,
    accessor: object,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    F: str | None = None,
    v: str | None = None,
    f: PathSpec | None = None,
    index: object = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    paths = await _resolve_or_empty(ops, accessor, paths, index)
    return await generic_awk(
        paths,
        texts,
        read_bytes=ops.read_bytes,
        read_stream=ops.read_stream,
        accessor=accessor,
        stdin=stdin,
        field_separator=F,
        variable_assignment=v,
        program_file=f if ops.ready(accessor) else None,
        index=index,
    )


async def _jq(
    ops: CommandIO,
    accessor: object,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    r: bool = False,
    c: bool = False,
    s: bool = False,
    index: object = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    paths = await _resolve_or_empty(ops, accessor, paths, index)
    return await generic_jq(paths,
                            *texts,
                            read_bytes=ops.read_bytes,
                            read_stream=ops.read_stream,
                            accessor=accessor,
                            stdin=stdin,
                            r=r,
                            c=c,
                            s=s)


async def _iconv(
    ops: CommandIO,
    accessor: object,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    f: str | None = None,
    t: str | None = None,
    c: bool = False,
    o: PathSpec | None = None,
    index: object = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    paths = await _resolve_or_empty(ops, accessor, paths, index)
    return await generic_iconv(paths,
                               read_bytes=ops.read_bytes,
                               write_bytes=ops.write,
                               accessor=accessor,
                               stdin=stdin,
                               from_enc=f or "utf-8",
                               to_enc=t or "utf-8",
                               ignore_errors=c,
                               output_path=o)


async def _tee(
    ops: CommandIO,
    accessor: object,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    a: bool = False,
    index: object = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if not paths:
        raise ValueError("tee: missing operand")
    paths = await ops.resolve_glob(accessor, paths, index)
    return await generic_tee(paths,
                             texts,
                             read_stream=ops.read_stream,
                             write_bytes=ops.write,
                             accessor=accessor,
                             stdin=stdin,
                             append=a)


# (name, builder, provision_builder, write, aggregate)
TRANSFORM_BUILDERS = (
    ("tac", _tac, None, False, None),
    ("tr", _tr, None, False, None),
    ("xxd", _xxd, None, False, None),
    ("base64", _base64, None, False, None),
    ("strings", _strings, None, False, None),
    ("fold", _fold, None, False, None),
    ("fmt", _fmt, None, False, None),
    ("expand", _expand, None, False, None),
    ("unexpand", _unexpand, None, False, None),
    ("paste", _paste, None, False, None),
    ("column", _column, None, False, None),
    ("look", _look, None, False, None),
    ("md5", _md5, None, False, None),
    ("sha256sum", _sha256sum, None, False, None),
    ("comm", _comm, None, False, None),
    ("join", _join, None, False, None),
    ("file", _file, None, False, None),
    ("awk", _awk, None, False, None),
    ("jq", _jq, make_jq_provision, False, None),
    ("iconv", _iconv, None, True, None),
    ("tee", _tee, None, True, None),
)
