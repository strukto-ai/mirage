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

import fnmatch

from mirage.accessor.github_ci import GitHubCIAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.github_ci.glob import resolve_glob
from mirage.core.github_ci.readdir import readdir
from mirage.core.github_ci.stat import stat
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileType, PathSpec


async def _tree_async(
    accessor: GitHubCIAccessor,
    path: PathSpec,
    _prefix: str = "",
    max_depth: int | None = None,
    show_hidden: bool = False,
    ignore_pattern: str | None = None,
    dirs_only: bool = False,
    match_pattern: str | None = None,
    _depth: int = 0,
    warnings: list[str] | None = None,
    index: IndexCacheStore = None,
) -> list[str]:
    lines: list[str] = []
    try:
        entries = await readdir(accessor, path, index)
    except (FileNotFoundError, ValueError) as exc:
        if warnings is not None:
            warnings.append(f"tree: '{path.original}': {exc}")
        return lines
    filtered = []
    for entry in entries:
        try:
            entry_spec = PathSpec(original=entry,
                                  directory=entry,
                                  resolved=False,
                                  prefix=path.prefix)
            s = await stat(accessor, entry_spec, index)
        except (FileNotFoundError, ValueError) as exc:
            if warnings is not None:
                warnings.append(f"tree: '{entry}': {exc}")
            continue
        if not show_hidden and s.name.startswith("."):
            continue
        if ignore_pattern and fnmatch.fnmatch(s.name, ignore_pattern):
            continue
        if dirs_only and s.type != FileType.DIRECTORY:
            continue
        not_dir = s.type != FileType.DIRECTORY
        if match_pattern and not_dir and not fnmatch.fnmatch(
                s.name, match_pattern):
            continue
        filtered.append((entry_spec, s))
    for i, (entry_spec, s) in enumerate(filtered):
        is_last = i == len(filtered) - 1
        connector = "\u2514\u2500\u2500 " if is_last else "\u251c\u2500\u2500 "
        lines.append(_prefix + connector + s.name)
        if s.type == FileType.DIRECTORY:
            if max_depth is not None and _depth >= max_depth:
                continue
            extension = "    " if is_last else "\u2502   "
            lines.extend(await _tree_async(accessor,
                                           entry_spec,
                                           _prefix + extension,
                                           max_depth=max_depth,
                                           show_hidden=show_hidden,
                                           ignore_pattern=ignore_pattern,
                                           dirs_only=dirs_only,
                                           match_pattern=match_pattern,
                                           _depth=_depth + 1,
                                           warnings=warnings,
                                           index=index))
    return lines


@command("tree", resource="github_ci", spec=SPECS["tree"])
async def tree(
    accessor: GitHubCIAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    L: str | None = None,
    a: bool = False,
    args_I: str | None = None,
    d: bool = False,
    P: str | None = None,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    paths = await resolve_glob(accessor, paths)
    p0 = paths[0]
    max_depth = int(L) if L is not None else None
    warnings: list[str] = []
    results = await _tree_async(
        accessor,
        p0,
        max_depth=max_depth,
        show_hidden=a,
        ignore_pattern=args_I,
        dirs_only=d,
        match_pattern=P,
        warnings=warnings,
        index=index,
    )
    stderr = "\n".join(warnings).encode() if warnings else None
    output = "\n".join(results).encode()
    return output, IOResult(stderr=stderr)
