import logging

logger = logging.getLogger(__name__)


def route_step_1(value: int) -> int:
    logger.debug('route step 1')
    return value + 1
