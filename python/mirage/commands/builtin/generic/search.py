from collections.abc import Callable
from typing import Any

from mirage.accessor.base import Accessor
from mirage.commands.builtin.utils.paths import default_paths
from mirage.commands.config import Context, command
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.runtime.types import DispatchFn
from mirage.types import JsonValue, PathSpec
from mirage.vfs.types import SearchQuery


def semantic_options(fl: FlagView) -> dict[str, JsonValue]:
    """A ranked store's search options, read off the flags.

    The store answers ``--top-k`` (its own default when absent) and
    ``--threshold``; any method but ``semantic`` is a usage error.

    Args:
        fl (FlagView): the invocation's search flags.
    """
    method = fl.as_str("method", "semantic")
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


async def search_resources(
    dispatch: DispatchFn | None,
    paths: list[PathSpec],
    query: SearchQuery,
) -> bytes:
    """Rank every scope as one query and render the records, one per hit.

    One search through the dispatcher, the scopes after the first riding
    along as ``scopes``: it ranks them as one where the mount serving
    them all ranks a batch, and searches each and joins the hits in scope
    order otherwise.

    Args:
        dispatch (DispatchFn | None): the command's dispatcher, None
            outside a workspace.
        paths (list[PathSpec]): explicit resource scopes.
        query (SearchQuery): backend query and options.
    """
    if dispatch is None:
        raise NotImplementedError(
            "search: backend does not support resource search"
        )
    if not paths:
        raise ValueError("search: at least one scope is required")
    records, _ = await dispatch(
        "search", paths[0], query=query, scopes=paths[1:]
    )
    if records is None:
        raise NotImplementedError("search: backend declined the query")
    return (
        ("\n".join(record for _, record in records) + "\n").encode()
        if records
        else b""
    )


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
        ctx: Context,
    ) -> tuple[ByteSource | None, IOResult]:
        if not texts or not texts[0]:
            raise UsageError("search: query is required")
        fl = FlagView(ctx.flags, spec=SPECS["search"])
        output = await search_resources(
            ctx.vfs.dispatch if ctx.vfs is not None else None,
            default_paths(paths, ctx.cwd),
            SearchQuery(texts[0], options=options(fl)),
        )
        return output, IOResult()

    wrapped: Callable[..., Any] = command(name, vfs=vfs, spec=SPECS["search"])(
        search
    )
    return wrapped
