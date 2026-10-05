from typing import Annotated, Any

from pydantic import BaseModel, ConfigDict, Field, StrictInt, model_validator

from mirage.types import ProcessScope

_SCOPES: tuple[ProcessScope, ...] = ("session", "workspace")


class ProcessPermissions(BaseModel):
    """How far past its own session a profile reaches into processes.

    A session always sees and stops its own processes. ``list`` widens
    what ``ps`` and a handler's process view see; ``kill`` widens what
    they may stop, and never past ``list``. ``max`` caps the live
    processes the session holds, its running line included, as
    ``ulimit -u`` counts the shell. A bare scope sets both.

    Args:
        list (ProcessScope): whose processes the session sees.
        kill (ProcessScope): whose processes the session may stop.
        max (int | None): most live processes, None for no cap.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    list: ProcessScope = "session"
    kill: ProcessScope = "session"
    max: Annotated[StrictInt, Field(ge=1)] | None = None

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

    def restrict(self, other: "ProcessPermissions") -> "ProcessPermissions":
        caps = [cap for cap in (self.max, other.max) if cap is not None]
        return ProcessPermissions(
            list=_SCOPES[
                min(_SCOPES.index(self.list), _SCOPES.index(other.list))
            ],
            kill=_SCOPES[
                min(_SCOPES.index(self.kill), _SCOPES.index(other.kill))
            ],
            max=min(caps) if caps else None,
        )
