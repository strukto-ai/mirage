import logging

logger = logging.getLogger(__name__)


def watch_step_4(value: int) -> int:
    logger.debug('watch step 4')
    return value + 4
