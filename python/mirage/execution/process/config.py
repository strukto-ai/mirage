from collections.abc import Iterable
from typing import Annotated, Any

from pydantic import BaseModel, ConfigDict, Field, StrictInt, model_validator

from mirage.execution.process.constants import MAX_PROCESSES
from mirage.types import ProcessScope

_SCOPES: tuple[ProcessScope, ...] = ("session", "workspace")


class ProcessPermissions(BaseModel):
    """How far past its own session a profile reaches into processes.

    A session always sees and stops its own processes. ``list`` widens
    what ``ps`` and a handler's ``ctx.processes`` see; ``kill`` widens what
    they may stop, and never past ``list``. ``max`` caps the live
    processes the session holds, its running line included, as
    ``ulimit -u`` counts the shell. A bare scope sets both. The workspace
    states one for every session and a profile's overrides it field by
    field (``layered``).

    Args:
        list (ProcessScope): whose processes the session sees.
        kill (ProcessScope): whose processes the session may stop.
        max (int | None): most live processes, ``MAX_PROCESSES`` unless
            stated, None for no cap.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    list: ProcessScope = "session"
    kill: ProcessScope = "session"
    max: Annotated[StrictInt, Field(ge=1)] | None = MAX_PROCESSES

    @model_validator(mode="before")
    @classmethod
    def _v_scope(cls, data: Any) -> Any:
        if isinstance(data, str):
            return {"list": data, "kill": data}
        return data

    @model_validator(mode="after")
    def _v_kill_within_list(self) -> "ProcessPermissions":
        if _SCOPES.index(self.kill) > _SCOPES.index(self.list):
            raise ValueError("processes.kill cannot reach past processes.list")
        return self

    @classmethod
    def layered(
        cls, layers: Iterable["ProcessPermissions | None"]
    ) -> "ProcessPermissions":
        """Each field from the first layer that states it, else its
        default, as ``Limit.layered`` resolves ``command_limits``: a
        profile naming only ``max`` keeps the workspace's scopes, one
        naming ``max`` as None lifts the workspace's cap, and an
        inherited ``kill`` never reaches past the ``list`` above it.

        Args:
            layers (Iterable[ProcessPermissions | None]): the blocks, most
                specific first, None for a layer that states none.
        """
        merged: dict[str, Any] = cls().model_dump()
        stated: set[str] = set()
        for layer in layers:
            if layer is not None:
                for name in layer.model_fields_set - stated:
                    merged[name] = getattr(layer, name)
                stated |= layer.model_fields_set
        merged["kill"] = nearer(merged["kill"], merged["list"])
        return cls(**merged)

    def restrict(self, other: "ProcessPermissions") -> "ProcessPermissions":
        """This block narrowed by the fields ``other`` states: the
        nearer scope of each, ``kill`` never past ``list``, the lower cap.

        Args:
            other (ProcessPermissions): an inline document's block.
        """
        merged: dict[str, Any] = self.model_dump()
        for name in other.model_fields_set:
            mine, theirs = getattr(self, name), getattr(other, name)
            if name == "max":
                caps = [cap for cap in (mine, theirs) if cap is not None]
                merged[name] = min(caps) if caps else None
            else:
                merged[name] = nearer(mine, theirs)
        merged["kill"] = nearer(merged["kill"], merged["list"])
        return ProcessPermissions(**merged)


def nearer(a: ProcessScope, b: ProcessScope) -> ProcessScope:
    """The narrower of two scopes.

    Args:
        a (ProcessScope): one scope.
        b (ProcessScope): the other.
    """
    return _SCOPES[min(_SCOPES.index(a), _SCOPES.index(b))]
