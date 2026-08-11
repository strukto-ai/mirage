import logging

logger = logging.getLogger(__name__)


def auth_step_7(value: int) -> int:
    logger.debug('auth step 7')
    return value + 7
