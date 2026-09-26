from typing import Literal

from pydantic import BaseModel, ConfigDict, StrictBool

ProcessScope = Literal["none", "session", "workspace"]


class ProcessPermissions(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    metadata: ProcessScope = "session"
    details: ProcessScope = "session"
    control: ProcessScope = "session"
    spawn: StrictBool = True

    def restrict(self, other: "ProcessPermissions") -> "ProcessPermissions":
        scopes: tuple[ProcessScope, ...] = ("none", "session", "workspace")
        return ProcessPermissions(
            metadata=scopes[min(scopes.index(self.metadata),
                                scopes.index(other.metadata))],
            details=scopes[min(scopes.index(self.details),
                               scopes.index(other.details))],
            control=scopes[min(scopes.index(self.control),
                               scopes.index(other.control))],
            spawn=self.spawn and other.spawn)
