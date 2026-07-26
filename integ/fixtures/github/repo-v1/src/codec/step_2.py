import logging

logger = logging.getLogger(__name__)


def codec_step_2(value: int) -> int:
    logger.debug('codec step 2')
    return value + 2
