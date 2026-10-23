from mirage.utils.ids import IdSource, SystemIdSource


def new_execution_id(ids: IdSource | None = None) -> str:
    """Mint the id an execution's records name.

    Args:
        ids (IdSource | None): the workspace's source; None means the
            system source.
    """
    source = ids if ids is not None else SystemIdSource()
    return f"exec_{source.uuid7()}"
