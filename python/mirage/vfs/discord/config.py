from pydantic import Field

from mirage.core.discord.config import DiscordConfig as DiscordCredentials
from mirage.core.time_config import TimeRangeConfig
from mirage.vfs.constants import WALK_LIMIT


class DiscordConfig(DiscordCredentials, TimeRangeConfig):
    """A Discord mount: the CLI's credentials plus the mount's time scope."""

    walk_limit: int = Field(default=WALK_LIMIT, ge=-1)
    """Most files one command walks under a folder: `grep -r`, `find` and other
    walks stop there, and a larger glob, `tar -c`, `cp -r` or `rm -r` is
    refused. `-1` lifts the limit."""
