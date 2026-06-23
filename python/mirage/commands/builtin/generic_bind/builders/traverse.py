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

from functools import partial

from mirage.commands.builtin.generic.basename import \
    basename as generic_basename
from mirage.commands.builtin.generic.dirname import dirname as generic_dirname
from mirage.commands.builtin.generic.du import du as generic_du
from mirage.commands.builtin.generic.find import find as generic_find
from mirage.commands.builtin.generic.ls import ls as generic_ls
from mirage.commands.builtin.generic.readlink import \
    readlink as generic_readlink
from mirage.commands.builtin.generic.realpath import \
    realpath as generic_realpath
from mirage.commands.builtin.generic.stat import stat as generic_stat
from mirage.commands.builtin.generic.tree import tree as generic_tree
from mirage.commands.builtin.generic_bind.adapter import CommandIO
from mirage.commands.builtin.generic_bind.provision import stat_provision
from mirage.io.types import ByteSource, IOResult
from mirage.types import LsSortBy, PathSpec


async def _ls(
    ops: CommandIO,
    accessor: object,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    args_l: bool = False,
    args_1: bool = False,
    a: bool = False,
    A: bool = False,
    h: bool = False,
    t: bool = False,
    S: bool = False,
    r: bool = False,
    R: bool = False,
    d: bool = False,
    F: bool = False,
    index: object = None,
    cwd: PathSpec | str = "/",
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if not ops.ready(accessor):
        raise ValueError("ls: no resource")
    if not paths:
        cwd_str = cwd.original if isinstance(cwd, PathSpec) else cwd
        cwd_prefix = cwd.prefix if isinstance(cwd, PathSpec) else ""
        paths = [
            PathSpec(original=cwd_str,
                     directory=cwd_str,
                     resolved=False,
                     prefix=cwd_prefix)
        ]
    paths = await ops.resolve_glob(accessor, paths, index)
    sort_by = LsSortBy.TIME if t else LsSortBy.SIZE if S else LsSortBy.NAME
    return await generic_ls(
        paths,
        readdir=partial(ops.readdir, accessor),
        stat=partial(ops.stat, accessor),
        long=args_l,
        one_per_line=args_1,
        all_files=a or A,
        human=h,
        sort_by=sort_by,
        reverse=r,
        recursive=R,
        list_dir=d,
        classify=F,
        index=index,
    )


async def _stat(
    ops: CommandIO,
    accessor: object,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    c: str | None = None,
    f: str | None = None,
    index: object = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if not ops.ready(accessor):
        raise ValueError("stat: no resource")
    paths = await ops.resolve_glob(accessor, paths, index)
    return await generic_stat(paths,
                              stat_fn=ops.stat,
                              accessor=accessor,
                              c=c,
                              f=f)


async def _tree(
    ops: CommandIO,
    accessor: object,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    L: str | None = None,
    a: bool = False,
    args_I: str | None = None,
    d: bool = False,
    P: str | None = None,
    index: object = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if not ops.ready(accessor):
        raise ValueError("tree: no resource")
    paths = await ops.resolve_glob(accessor, paths, index)
    return await generic_tree(
        paths[0],
        readdir=partial(ops.readdir, accessor),
        stat=partial(ops.stat, accessor),
        max_depth=int(L) if L is not None else None,
        show_hidden=a,
        ignore_pattern=args_I,
        dirs_only=d,
        match_pattern=P,
        index=index,
    )


async def _find(
    ops: CommandIO,
    accessor: object,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    name: str | None = None,
    type: str | None = None,
    maxdepth: str | None = None,
    size: str | None = None,
    mtime: str | None = None,
    iname: str | None = None,
    path: str | None = None,
    mindepth: str | None = None,
    empty: bool = False,
    index: object = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if not ops.ready(accessor):
        raise ValueError("find: no resource")
    paths = await ops.resolve_glob(accessor, paths, index)
    stat = partial(ops.stat, accessor) if ops.local else None
    return await generic_find(paths,
                              texts,
                              find_core=partial(ops.find, accessor),
                              stat=stat,
                              name=name,
                              type=type,
                              size=size,
                              mtime=mtime,
                              maxdepth=maxdepth,
                              iname=iname,
                              path=path,
                              mindepth=mindepth,
                              empty=empty)


async def _du(
    ops: CommandIO,
    accessor: object,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    h: bool = False,
    s: bool = False,
    a: bool = False,
    max_depth: str | None = None,
    c: bool = False,
    index: object = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if not ops.ready(accessor):
        raise ValueError("du: no resource")
    paths = await ops.resolve_glob(accessor, paths, index)
    if not paths:
        raise ValueError("du: missing operand")
    out = await generic_du(
        paths,
        compute_total=partial(ops.du_total, accessor),
        compute_all=partial(ops.du_all, accessor),
        s=s,
        a=a,
        h=h,
        max_depth=int(max_depth) if max_depth is not None else None,
        c=c,
    )
    return out.encode(), IOResult()


async def _realpath(
    ops: CommandIO,
    accessor: object,
    paths: list[PathSpec] | None = None,
    *texts: str,
    stdin: bytes | None = None,
    e: bool = False,
    m: bool = False,
    index: object = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    paths = await ops.resolve_glob(accessor, paths or [], index)
    return await generic_realpath(paths,
                                  stat_fn=ops.stat,
                                  accessor=accessor,
                                  e=e,
                                  m=m)


async def _readlink(
    ops: CommandIO,
    accessor: object,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    f: bool = False,
    e: bool = False,
    m: bool = False,
    n: bool = False,
    index: object = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if not paths:
        raise ValueError("readlink: missing operand")
    paths = await ops.resolve_glob(accessor, paths, index)
    return await generic_readlink(paths, f=f, e=e, m=m, n=n)


async def _basename(
    ops: CommandIO,
    accessor: object,
    paths: list[PathSpec] | None = None,
    *texts: str,
    stdin: bytes | None = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    return await generic_basename(*texts)


async def _dirname(
    ops: CommandIO,
    accessor: object,
    paths: list[PathSpec] | None = None,
    *texts: str,
    stdin: bytes | None = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    return await generic_dirname(*texts)


# (name, builder, provision_builder, write, aggregate)
TRAVERSE_BUILDERS = (
    ("ls", _ls, None, False, None),
    ("stat", _stat, lambda _s: stat_provision, False, None),
    ("tree", _tree, None, False, None),
    ("find", _find, None, False, None),
    ("du", _du, None, False, None),
    ("realpath", _realpath, None, False, None),
    ("readlink", _readlink, None, False, None),
    ("basename", _basename, None, False, None),
    ("dirname", _dirname, None, False, None),
)
