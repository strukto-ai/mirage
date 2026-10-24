from typing import Annotated

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, SecretStr

from mirage.vfs.constants import WALK_LIMIT


def entity_name(value: str) -> str:
    if value in (".", ".."):
        raise ValueError("entity must be a filesystem name")
    return value


Name = Annotated[
    str,
    Field(pattern=r"^[^/\\\x00]+$", min_length=1),
    AfterValidator(entity_name),
]


class WandbConfig(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")
    entities: list[Name] = Field(min_length=1)
    """W&B entities (users or teams) the mount shows as top-level
    directories; no other entity is reachable."""
    api_key: SecretStr = SecretStr("")
    """W&B API key, sent as HTTP Basic auth. Empty sends no credentials."""
    base_url: str = "https://api.wandb.ai"
    """W&B API root. Queries go to its `/graphql`, and only downloads from
    the same origin carry the key."""
    page_size: int = Field(default=100, ge=1, le=1000)
    """Items per GraphQL page, and steps per window when reading
    `history.jsonl`."""
    max_pages: int = Field(default=10000, ge=1)
    """The most pages one listing or history read fetches. Past it the
    read fails rather than return a partial result."""
    walk_limit: int = Field(default=WALK_LIMIT, ge=-1)
    """Most files one command walks under a folder: `grep -r`, `find` and other
    walks stop there, and a larger glob, `tar -c`, `cp -r` or `rm -r` is
    refused. `-1` lifts the limit."""
