from mirage.core.discord.config import DiscordConfig as DiscordCredentials
from mirage.core.time_config import TimeRangeConfig


class DiscordConfig(DiscordCredentials, TimeRangeConfig):
    """A Discord mount: the CLI's credentials plus the mount's time scope."""
