import logging

logger = logging.getLogger(__name__)


def auth_step_5(value: int) -> int:
    logger.debug('auth step 5')
    return value + 5
