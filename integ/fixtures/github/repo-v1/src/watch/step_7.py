import logging

logger = logging.getLogger(__name__)


def watch_step_7(value: int) -> int:
    logger.debug('watch step 7')
    return value + 7
