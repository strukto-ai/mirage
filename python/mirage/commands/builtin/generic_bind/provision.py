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

from collections.abc import Callable

from mirage.accessor.base import Accessor
from mirage.cache.index import IndexCacheStore
from mirage.core.jq import is_jsonl_path, is_streamable_jsonl_expr
from mirage.provision.types import Precision, ProvisionResult
from mirage.types import PathSpec


async def _resolve_sizes(
    stat: Callable,
    accessor: Accessor,
    paths: list[PathSpec],
    index: IndexCacheStore | None,
) -> tuple[list[tuple[str, int]], int]:
    resolved: list[tuple[str, int]] = []
    missing = 0
    for p in paths:
        path_str = p.original if isinstance(p, PathSpec) else p
        size = None
        if index is not None:
            lookup = await index.get(path_str)
            if lookup.entry is not None:
                size = lookup.entry.size
        if size is None:
            try:
                file_stat = await stat(accessor, p, index)
                size = file_stat.size
            except (FileNotFoundError, ValueError):
                pass
        if size is not None:
            resolved.append((path_str, size))
        else:
            missing += 1
    return resolved, missing


def make_file_read_provision(stat: Callable) -> Callable:
    """Cost estimate for full file reads (cat, wc), generic over stat."""

    async def file_read_provision(
        accessor: Accessor,
        paths: list[PathSpec],
        *_args: str,
        command: str = "",
        index: IndexCacheStore | None = None,
        **kwargs,
    ) -> ProvisionResult:
        if not paths:
            return ProvisionResult(command=command,
                                   precision=Precision.UNKNOWN)
        resolved, missing = await _resolve_sizes(stat, accessor, paths, index)
        if missing > 0 or not resolved:
            return ProvisionResult(command=command,
                                   precision=Precision.UNKNOWN)
        total = sum(size for _, size in resolved)
        return ProvisionResult(
            command=command,
            network_read_low=total,
            network_read_high=total,
            read_ops=len(resolved),
            precision=Precision.EXACT,
        )

    return file_read_provision


def make_head_tail_provision(stat: Callable) -> Callable:
    """Cost estimate for partial reads (head, tail), generic over stat."""

    async def head_tail_provision(
        accessor: Accessor,
        paths: list[PathSpec],
        *_args: str,
        command: str = "",
        n: str | int | None = None,
        c: str | int | None = None,
        index: IndexCacheStore | None = None,
        **kwargs,
    ) -> ProvisionResult:
        if not paths:
            return ProvisionResult(command=command,
                                   precision=Precision.UNKNOWN)
        resolved, missing = await _resolve_sizes(stat, accessor, paths, index)
        if missing > 0 or not resolved:
            return ProvisionResult(command=command,
                                   precision=Precision.UNKNOWN)
        if c is not None:
            c_bytes = int(c)
            total = sum(min(c_bytes, size) for _, size in resolved)
            return ProvisionResult(
                command=command,
                network_read_low=total,
                network_read_high=total,
                read_ops=len(resolved),
                precision=Precision.EXACT,
            )
        full = sum(size for _, size in resolved)
        return ProvisionResult(
            command=command,
            network_read_low=0,
            network_read_high=full,
            read_ops=len(resolved),
            precision=Precision.RANGE,
        )

    return head_tail_provision


async def metadata_provision(
    accessor: Accessor,
    paths: list[PathSpec],
    *_args: str,
    command: str = "",
    index: IndexCacheStore | None = None,
    **kwargs,
) -> ProvisionResult:
    """Cost estimate for metadata-only ops (stat, ls, find)."""
    n = max(1, len(paths) if paths else 1)
    return ProvisionResult(
        command=command,
        network_read_low=0,
        network_read_high=0,
        read_ops=n,
        precision=Precision.EXACT,
    )


async def stat_provision(
    accessor: Accessor | None = None,
    paths: list[PathSpec] | None = None,
    *_args: str,
    **kwargs,
) -> ProvisionResult:
    """Cost estimate for stat: the command string, no reads."""
    return ProvisionResult(
        command=f"stat {paths[0].original}" if paths else "stat")


def make_jq_provision(stat: Callable) -> Callable:
    """Provision for jq: streamable jsonl reads a range, else whole file."""

    async def jq_provision(
        accessor: Accessor,
        paths: list[PathSpec] | None = None,
        *texts: str,
        index: IndexCacheStore | None = None,
        **kwargs,
    ) -> ProvisionResult:
        if not paths or not texts:
            return ProvisionResult(command="jq")
        p = paths[0]
        key = p.strip_prefix if isinstance(p, PathSpec) else p
        try:
            file_stat = await stat(accessor, p, index)
        except (FileNotFoundError, ValueError):
            return ProvisionResult(command="jq")
        file_size = file_stat.size or 0
        expr = texts[0]
        shown = p.original if isinstance(p, PathSpec) else p
        rendered = f"jq {expr!r} {shown}"
        if is_jsonl_path(key) and is_streamable_jsonl_expr(expr):
            return ProvisionResult(
                command=rendered,
                network_read_low=0,
                network_read_high=file_size,
                read_ops=1,
                precision=Precision.RANGE,
            )
        return ProvisionResult(
            command=rendered,
            network_read_low=file_size,
            network_read_high=file_size,
            read_ops=1,
            precision=Precision.EXACT,
        )

    return jq_provision


def make_search_provision(stat: Callable) -> Callable:
    """Provision for grep/rg/jq: render pattern then delegate to file_read."""
    base = make_file_read_provision(stat)

    async def search_provision(
        accessor: Accessor,
        paths: list[PathSpec],
        *texts: str,
        command: str = "",
        index: IndexCacheStore | None = None,
        **kwargs,
    ) -> ProvisionResult:
        rendered = (command or ""
                    ) + " " + " ".join(list(texts) + [str(p) for p in paths])
        return await base(accessor, paths, command=rendered, index=index)

    return search_provision
