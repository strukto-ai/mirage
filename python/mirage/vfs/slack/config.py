from mirage.core.slack.config import SlackConfig as SlackCredentials
from mirage.core.time_config import TimeRangeConfig


class SlackConfig(SlackCredentials, TimeRangeConfig):
    """A Slack mount: the CLI's credentials plus the mount's time scope."""

    content_search: bool = False
    """Let `grep -rw` and `rg -w` read only the channel and DM days Slack
    search names. Needs a token that can search. Slack indexes a message
    some time after it is posted, and searches only message text, file
    names and titles and reactions."""
