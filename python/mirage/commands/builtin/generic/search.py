from collections.abc import Callable
from dataclasses import replace
from typing import Any

from mirage.accessor.base import Accessor
from mirage.commands.builtin.utils.paths import default_paths
from mirage.commands.config import CommandOpts, command
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import JsonValue, PathSpec
from mirage.vfs.search import search_resources
from mirage.vfs.types import SearchQuery
from mirage.view.namespace_view import paths_scoped


def semantic_options(fl: FlagView) -> dict[str, JsonValue]:
    """A ranked store's search options, read off the flags.

    The store answers ``--top-k`` (its own default when absent) and
    ``--threshold``; any method but ``semantic`` is a usage error.

    Args:
        fl (FlagView): the invocation's search flags.
    """
    method = fl.as_str("method") or "semantic"
    if method != "semantic":
        raise UsageError("search: only the 'semantic' method is supported")
    options: dict[str, JsonValue] = {
        "method": method,
        "threshold": fl.as_float("threshold") or 0.0,
    }
    top_k = fl.as_int("top_k")
    if top_k is not None:
        options["top_k"] = top_k
    return options


def make_search(
    vfs: str,
    options: Callable[[FlagView], dict[str, JsonValue]] = semantic_options,
    *,
    name: str = "search",
) -> Callable[..., Any]:
    """Build ``NAME QUERY [PATH...]`` over a backend's native search.

    A missing query is a usage error; the backend reads the rest of its
    options off the flags.

    Args:
        vfs (str): VFS name the command registers under.
        options (Callable[[FlagView], dict[str, JsonValue]]): the search
            options for one invocation.
        name (str): the head word the command answers to.
    """

    async def search(
        accessor: Accessor,
        paths: list[PathSpec],
        texts: list[str],
        opts: CommandOpts,
    ) -> tuple[ByteSource | None, IOResult]:
        if not texts or not texts[0]:
            raise UsageError("search: query is required")
        fl = FlagView(opts.flags, spec=SPECS["search"])
        capability = opts.io.search if opts.io is not None else None
        scopes = default_paths(paths, opts.cwd)
        # A batch ranking answers for every scope in one call past the
        # dispatcher; where a hide or a path rule reaches the scopes each
        # is searched at the dispatcher, which declines one the view
        # restricts.
        if capability is not None and paths_scoped(
            opts.ns, scopes, opts.mount_prefix
        ):
            capability = replace(capability, search_many=None)
        output = await search_resources(
            capability,
            accessor,
            scopes,
            SearchQuery(texts[0], options=options(fl)),
            opts.index,
        )
        return output, IOResult()

    wrapped: Callable[..., Any] = command(name, vfs=vfs, spec=SPECS["search"])(
        search
    )
    return wrapped
