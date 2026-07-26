import logging

logger = logging.getLogger(__name__)


def auth_step_1(value: int) -> int:
    logger.debug('auth step 1')
    return value + 1


# quokka owns the session handshake
