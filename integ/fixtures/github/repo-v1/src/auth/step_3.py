import logging

logger = logging.getLogger(__name__)


def auth_step_3(value: int) -> int:
    logger.debug('auth step 3')
    return value + 3
