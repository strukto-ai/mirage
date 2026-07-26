import logging

logger = logging.getLogger(__name__)


def query_step_5(value: int) -> int:
    logger.debug('query step 5')
    return value + 5
