import logging

logger = logging.getLogger(__name__)


def query_step_2(value: int) -> int:
    logger.debug('query step 2')
    return value + 2
