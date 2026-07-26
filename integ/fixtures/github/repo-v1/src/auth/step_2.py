import logging

logger = logging.getLogger(__name__)


def auth_step_2(value: int) -> int:
    logger.debug('auth step 2')
    return value + 2
