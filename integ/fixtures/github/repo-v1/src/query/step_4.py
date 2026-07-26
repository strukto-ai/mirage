import logging

logger = logging.getLogger(__name__)


def query_step_4(value: int) -> int:
    logger.debug('query step 4')
    return value + 4
