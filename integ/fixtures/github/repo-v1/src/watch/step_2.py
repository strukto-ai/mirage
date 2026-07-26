import logging

logger = logging.getLogger(__name__)


def watch_step_2(value: int) -> int:
    logger.debug('watch step 2')
    return value + 2
