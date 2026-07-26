import logging

logger = logging.getLogger(__name__)


def route_step_5(value: int) -> int:
    logger.debug('route step 5')
    return value + 5
