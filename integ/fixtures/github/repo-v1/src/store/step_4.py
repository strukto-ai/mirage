import logging

logger = logging.getLogger(__name__)


def store_step_4(value: int) -> int:
    logger.debug('store step 4')
    return value + 4
