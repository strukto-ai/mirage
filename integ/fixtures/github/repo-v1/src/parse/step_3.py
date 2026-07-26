import logging

logger = logging.getLogger(__name__)


def parse_step_3(value: int) -> int:
    logger.debug('parse step 3')
    return value + 3
