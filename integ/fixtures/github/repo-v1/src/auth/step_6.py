import logging

logger = logging.getLogger(__name__)


def auth_step_6(value: int) -> int:
    logger.debug('auth step 6')
    return value + 6
