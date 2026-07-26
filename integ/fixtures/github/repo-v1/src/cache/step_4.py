import logging

logger = logging.getLogger(__name__)


def cache_step_4(value: int) -> int:
    logger.debug('cache step 4')
    return value + 4
