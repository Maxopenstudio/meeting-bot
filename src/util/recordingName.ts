export const getRecordingNamePrefix = (provider: 'google' | 'microsoft' | 'zoom') => {
  switch(provider) {
    case 'google':
      return 'Google Meet Recording';
    case 'microsoft':
      return 'Microsoft Teams Recording';
    case 'zoom':
      return 'Zoom Recording';
    default:
      return 'Recording';
  }
};

export interface RecordingObjectKeyParams {
  userId: string;
  /** The meeting-bot session id; guarantees one object per meeting. */
  botId: string;
  namePrefix: string;
  /** Human-readable timestamp (minute resolution) used in the display name. */
  time: string;
  /** File extension including the leading dot, e.g. ".webm". */
  fileExtension: string;
}

/**
 * Build the object-storage key for a recording.
 *
 * The botId segment is what keeps the key unique per meeting. Without it the key
 * was `meeting-bot/{userId}/{provider prefix} {time-to-the-minute}{ext}` — and
 * since the prefix is a fixed per-provider string and the time is only
 * minute-resolution, two recordings of the same user could resolve to the same
 * key and clobber each other in the bucket (overwriting an older recording's
 * media, and with it the transcript derived from it).
 */
export const buildRecordingObjectKey = ({
  userId,
  botId,
  namePrefix,
  time,
  fileExtension,
}: RecordingObjectKeyParams): string => {
  return `meeting-bot/${userId}/${botId}/${namePrefix} ${time}${fileExtension}`;
};
