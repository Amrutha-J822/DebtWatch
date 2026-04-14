/** Tunable limits for uploads (zip / folder). Override via env in production. */

const mb = (n: number) => n * 1024 * 1024;

function numEnv(key: string, fallback: number): number {
  const n = Number(process.env[key]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const MAX_ZIP_BYTES = numEnv('UPLOAD_MAX_ZIP_MB', 50) * mb(1);
export const MAX_EXTRACTED_TOTAL_BYTES = numEnv('UPLOAD_MAX_EXTRACTED_MB', 200) * mb(1);
export const MAX_FILES_IN_ARCHIVE = numEnv('UPLOAD_MAX_FILES', 500);
export const MAX_SINGLE_FILE_BYTES = numEnv('UPLOAD_MAX_FILE_MB', 1) * mb(1);
