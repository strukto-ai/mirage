import logging

logger = logging.getLogger(__name__)


def watch_step_8(value: int) -> int:
    logger.debug('watch step 8')
    return value + 8
