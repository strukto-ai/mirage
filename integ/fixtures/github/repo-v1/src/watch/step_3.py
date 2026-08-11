import logging

logger = logging.getLogger(__name__)


def watch_step_3(value: int) -> int:
    logger.debug('watch step 3')
    return value + 3
