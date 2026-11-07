from mirage.execution.types import LineId
from mirage.utils.ids import IdSource, SystemIdSource


def new_line_id(ids: IdSource | None = None) -> LineId:
    """Mint a line's id.

    Args:
        ids (IdSource | None): the workspace's source; None means the
            system source.
    """
    source = ids if ids is not None else SystemIdSource()
    return LineId(f"line_{source.uuid7()}")
