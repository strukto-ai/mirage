from pydantic import Field

from mirage.core.slack.config import SlackConfig as SlackCredentials
from mirage.core.time_config import TimeRangeConfig
from mirage.vfs.constants import WALK_LIMIT


class SlackConfig(SlackCredentials, TimeRangeConfig):
    """A Slack mount: the CLI's credentials plus the mount's time scope."""

    walk_limit: int = Field(default=WALK_LIMIT, ge=-1)
    """Most files one command walks under a folder: `grep -r`, `find` and other
    walks stop there, and a larger glob, `tar -c`, `cp -r` or `rm -r` is
    refused. `-1` lifts the limit and reads every file without asking Slack
    search, which lags posts and covers only message text, file names, titles
    and reactions."""
