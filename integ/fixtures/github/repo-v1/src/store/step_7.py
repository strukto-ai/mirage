import logging

logger = logging.getLogger(__name__)


def store_step_7(value: int) -> int:
    logger.debug('store step 7')
    return value + 7
