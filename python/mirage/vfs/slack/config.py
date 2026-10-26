from mirage.core.slack.config import SlackConfig as SlackCredentials
from mirage.core.time_config import TimeRangeConfig


class SlackConfig(SlackCredentials, TimeRangeConfig):
    """A Slack mount: the CLI's credentials plus the mount's time scope."""
