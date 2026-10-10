from mirage.core.slack.config import SlackConfig as SlackCredentials
from mirage.core.time_config import TimeRangeConfig


class SlackConfig(SlackCredentials, TimeRangeConfig):
    """A Slack mount: the CLI's credentials plus the mount's time scope."""

    # Let grep -w and rg -w read only the channel days Slack search names
    # (`files_containing`). Off by default: Slack indexes a message some
    # time after it is posted, and searches only message text, file names
    # and titles and reactions, so a word elsewhere in the JSON (a profile
    # or block field) is not found.
    content_search: bool = False
