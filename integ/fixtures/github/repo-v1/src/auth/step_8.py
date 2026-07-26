import logging

logger = logging.getLogger(__name__)


def auth_step_8(value: int) -> int:
    logger.debug('auth step 8')
    return value + 8
