import logging

logger = logging.getLogger(__name__)


def codec_step_3(value: int) -> int:
    logger.debug('codec step 3')
    return value + 3
