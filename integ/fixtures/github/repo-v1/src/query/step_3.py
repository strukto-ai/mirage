import logging

logger = logging.getLogger(__name__)


def query_step_3(value: int) -> int:
    logger.debug('query step 3')
    return value + 3
