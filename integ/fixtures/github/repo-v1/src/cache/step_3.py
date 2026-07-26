import logging

logger = logging.getLogger(__name__)


def cache_step_3(value: int) -> int:
    logger.debug('cache step 3')
    return value + 3
