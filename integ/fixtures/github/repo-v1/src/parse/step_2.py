import logging

logger = logging.getLogger(__name__)


def parse_step_2(value: int) -> int:
    logger.debug('parse step 2')
    return value + 2
