import logging

logger = logging.getLogger(__name__)


def watch_step_5(value: int) -> int:
    logger.debug('watch step 5')
    return value + 5
