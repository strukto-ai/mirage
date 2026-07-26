import logging

logger = logging.getLogger(__name__)


def query_step_1(value: int) -> int:
    logger.debug('query step 1')
    return value + 1
