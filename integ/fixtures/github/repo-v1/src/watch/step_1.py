import logging

logger = logging.getLogger(__name__)


def watch_step_1(value: int) -> int:
    logger.debug('watch step 1')
    return value + 1
