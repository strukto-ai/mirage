import logging

logger = logging.getLogger(__name__)


def watch_step_6(value: int) -> int:
    logger.debug('watch step 6')
    return value + 6
