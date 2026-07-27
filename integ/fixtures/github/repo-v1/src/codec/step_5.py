import logging

logger = logging.getLogger(__name__)


def codec_step_5(value: int) -> int:
    logger.debug('codec step 5')
    return value + 5
