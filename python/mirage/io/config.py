from pydantic import BaseModel, ConfigDict, Field

from mirage.io.cooperative import CHUNK_SIZE
from mirage.io.pipe import CAPACITY


class IOConfig(BaseModel):
    """Workspace limits for each in-flight byte queue."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    buffer_bytes: int = Field(
        default=CAPACITY, strict=True, ge=CHUNK_SIZE, le=2**53 - 1
    )
