import config, { NODE_ENV } from '../config';
import { Storage } from '@google-cloud/storage';
import { Logger } from 'winston';
import { writeFile, mkdir } from 'fs/promises';

interface UploadOption {
  skipTimestamp?: boolean;
}

const storage = new Storage();

async function uploadImageToGCP(
  fileName: string,
  buffer: Buffer,
  logger: Logger
): Promise<void> {
  try {
    const bucket = storage.bucket(config.miscStorageBucket ?? '');
    const file = bucket.file(fileName);
    await file.save(buffer);
  } catch (error) {
    logger.error('Error uploading buffer:', error);
  }
}

// TODO Save to local volume for development
export const uploadDebugImage = async (
  buffer: Buffer,
  fileName: string,
  userId: string,
  logger: Logger,
  botId?: string,
  opts?: UploadOption
) => {
  // Always dump a local copy to the mounted ./logs volume so operators can see
  // what the bot saw even without GCP configured. Best-effort.
  try {
    const dir = '/app/logs/debug';
    await mkdir(dir, { recursive: true });
    const stamp = opts?.skipTimestamp ? '' : `-${Date.now()}`;
    await writeFile(`${dir}/${botId ?? 'bot'}-${fileName}${stamp}.png`, buffer);
  } catch (e) {
    logger.error('Local debug image write failed', e as any);
  }

  try {
    if (NODE_ENV === 'development') {
      // TODO add disk based file saving
      return;
    }
    logger.info('Begin upload Debug Image', userId);
    if (!config.miscStorageBucket) {
      logger.error('Developer TODO: Add .env value for GCP_MISC_BUCKET', userId);
      return;
    }
    const bot = botId ?? 'bot';
    const now = opts?.skipTimestamp ? '' : `-${new Date().toISOString()}`;
    const qualifiedFile = `${config.miscStorageFolder}/${userId}/${bot}/${fileName}${now}.png`;
    await uploadImageToGCP(qualifiedFile, buffer, logger);
    logger.info(`Debug Image File uploaded successfully: ${fileName}`, userId);
  } catch (err) {
    logger.error('Error uploading debug image:', userId, err);
  }
};
