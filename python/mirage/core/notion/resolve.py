from typing import Any

from mirage.accessor.notion import NotionAccessor
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.notion.client import NotionAPIError
from mirage.core.notion.normalize import page_segment_name
from mirage.core.notion.pages import get_page
from mirage.errors.fs import enoent


async def resolve_row(
    accessor: NotionAccessor, match: ScopeMatch, virtual: str
) -> dict[str, Any]:
    """Fetch and validate the row named by a path, including descendants.

    Args:
        accessor (NotionAccessor): mount client.
        match (ScopeMatch): classified path with a distinct row identity.
        virtual (str): path to name in a refusal.
    """
    try:
        page = await get_page(
            accessor.config, match.slots["row_id"], session=accessor.pool
        )
    except NotionAPIError as exc:
        if exc.status == 404 or exc.code == "validation_error":
            raise enoent(virtual) from exc
        raise
    parent = page.get("parent", {})
    name = f"{match.slots['row']}__{match.slots['row_id']}"
    if (
        parent.get("data_source_id") != match.slots["data_source_id"]
        or page.get("in_trash")
        or page.get("archived")
        or page_segment_name(page) != name
    ):
        raise enoent(virtual)
    return page


async def guard_row(
    accessor: NotionAccessor, match: ScopeMatch, virtual: str
) -> None:
    """Validate a containing row when this path has one.

    Args:
        accessor (NotionAccessor): mount client.
        match (ScopeMatch): classified page or row path.
        virtual (str): path to name in a refusal.
    """
    if "row_id" in match.slots:
        await resolve_row(accessor, match, virtual)
