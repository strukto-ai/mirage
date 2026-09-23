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

from dataclasses import replace
from functools import partial

from mirage.accessor.email import EmailAccessor
from mirage.commands.builtin.email._provision import metadata_provision
from mirage.commands.builtin.email.io import resolve_glob
from mirage.commands.builtin.generic.find import (is_link, parse_find_args,
                                                  resolve_start, walk_find)
from mirage.commands.builtin.grep_pushdown import lone_operand
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.config import CommandOpts
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.core.email.client import fetch_headers
from mirage.core.email.readdir import _date_bucket, _msg_filename
from mirage.core.email.readdir import readdir as _readdir
from mirage.core.email.search import search_messages
from mirage.core.email.stat import stat as _stat
from mirage.io.types import ByteSource, IOResult
from mirage.provision.types import ProvisionResult
from mirage.types import PathSpec
from mirage.utils.fnmatch import fnmatch
from mirage.utils.key_prefix import mount_prefix_of


def _folder_operand(paths: list[PathSpec]) -> PathSpec | None:
    """The one folder operand the IMAP subject search may answer for.

    Shares ``lone_operand``'s rule with the grep/rg push-downs, for the
    same reason: the search answers one whole-folder question and prints
    its entire answer, so a second operand was dropped in silence
    (``find /mail/INBOX /mail/Sent -name '*x*'`` searched INBOX only).
    On top of that the operand must name exactly one path segment, the
    folder. The mount root used to reach here too and then answer with
    an empty result and exit 0, reporting "nothing matched" for a search
    it never ran; it now takes the walk below like any other path the
    push-down cannot serve.

    Args:
        paths (list[PathSpec]): operands, already glob-resolved.

    Returns:
        PathSpec | None: the sole folder-level operand, or None to walk.
    """
    operand = lone_operand(paths)
    if operand is None:
        return None
    parts = [x for x in operand.mount_path.strip("/").split("/") if x]
    return operand if len(parts) == 1 else None


async def find_provision(accessor: EmailAccessor, paths: list[PathSpec],
                         texts: list[str],
                         opts: CommandOpts) -> ProvisionResult:
    return await metadata_provision(
        accessor, paths, texts,
        replace(opts, command="find " + " ".join(p.virtual for p in paths)))


@command("find", vfs="email", spec=SPECS["find"], provision=find_provision)
async def find(
    accessor: EmailAccessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(opts.flags, spec=SPECS["find"])
    name = fl.as_str("name")
    type = fl.as_str("type")
    maxdepth = fl.as_str("maxdepth")
    size = fl.as_str("size")
    mtime = fl.as_str("mtime")
    iname = fl.as_str("iname")
    path = fl.as_str("path")
    mindepth = fl.as_str("mindepth")
    empty = fl.as_bool("empty")
    paths = await resolve_glob(accessor, paths, opts.index)
    # A pure -name search at folder level pushes the subject query down to
    # IMAP search instead of walking every message; any other predicate
    # falls through to the local walk so nothing is silently dropped.
    name_only = not (texts or size or mtime or type or iname or path
                     or mindepth or maxdepth or empty)
    if name and name_only:
        operand = _folder_operand(paths)
        if operand is not None:
            prefix = mount_prefix_of(operand.virtual, operand.vfs_path)
            return await _find_server_side(accessor, operand, name, prefix)

    args = parse_find_args(tuple(texts),
                           name=name,
                           type=type,
                           size=size,
                           mtime=mtime,
                           maxdepth=maxdepth,
                           iname=iname,
                           path=path,
                           mindepth=mindepth,
                           empty=empty)
    searches = paths if paths else [
        PathSpec(virtual="/", directory="/", vfs_path="")
    ]
    results: list[str] = []
    links = opts.ns.links if opts.ns is not None else None
    for search in searches:
        # Same start-point rule as every other find path: only a
        # directory has a subtree to walk.
        start = await resolve_start(search,
                                    args,
                                    opts.stat_path,
                                    is_link=is_link(links, search))
        if not start.walk:
            results.extend(start.results)
            continue
        results.extend(await walk_find(search,
                                       readdir=partial(_readdir, accessor),
                                       stat=partial(_stat, accessor),
                                       index=opts.index,
                                       args=args,
                                       links=links,
                                       follow=fl.as_bool("L")))
    return format_records(results), IOResult()


async def _find_server_side(
    accessor: EmailAccessor,
    operand: PathSpec,
    name_pattern: str,
    prefix: str,
) -> tuple[ByteSource | None, IOResult]:
    # One non-empty segment, guaranteed by _folder_operand.
    folder = operand.mount_path.strip("/")
    subject_query = name_pattern.replace("*", "").replace("?", "").replace(
        ".email.json", "").replace("__", " ").strip("_")
    if not subject_query:
        return b"", IOResult()

    uids = await search_messages(accessor,
                                 folder,
                                 subject=subject_query,
                                 max_results=accessor.config.max_messages)
    if not uids:
        return b"", IOResult()

    headers = await fetch_headers(accessor, folder, uids)
    results: list[str] = []
    for h in headers:
        date_str = _date_bucket(h)
        uid = h.get("uid", "")
        # The same builder readdir names the file with, not a second
        # spelling of it: the subject's budget depends on the uid and the
        # suffix, so a hit composed from a bare `_sanitize` pointed at a
        # path that does not exist once a long subject was trimmed.
        filename = _msg_filename(h.get("subject", "No Subject"), uid)
        if fnmatch(filename, name_pattern):
            vfs_path = "/".join(p
                                for p in [prefix, folder, date_str, filename]
                                if p)
            results.append(vfs_path)

    output = format_records(sorted(results))
    return output, IOResult()
