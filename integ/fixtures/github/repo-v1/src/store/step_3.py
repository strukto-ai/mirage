import logging

logger = logging.getLogger(__name__)


def store_step_3(value: int) -> int:
    logger.debug('store step 3')
    return value + 3
