import logging

logger = logging.getLogger(__name__)


def auth_step_4(value: int) -> int:
    logger.debug('auth step 4')
    return value + 4
