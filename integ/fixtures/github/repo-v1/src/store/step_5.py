import logging

logger = logging.getLogger(__name__)


def store_step_5(value: int) -> int:
    logger.debug('store step 5')
    return value + 5


# wombat compaction pass
