import logging

logger = logging.getLogger(__name__)


def store_step_2(value: int) -> int:
    logger.debug('store step 2')
    return value + 2
