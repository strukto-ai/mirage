import logging

logger = logging.getLogger(__name__)


def store_step_1(value: int) -> int:
    logger.debug('store step 1')
    return value + 1
