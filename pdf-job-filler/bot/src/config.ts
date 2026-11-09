import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
export const BOT_DIR = path.resolve(here, '..');
export const PROJECT_DIR = path.resolve(BOT_DIR, '..');

// .env in the project root first, then bot/.env (bot/.env wins).
dotenv.config({ path: path.join(PROJECT_DIR, '.env'), quiet: true } as any);
dotenv.config({ path: path.join(BOT_DIR, '.env'), override: true, quiet: true } as any);

function resolvePath(p: string | undefined, fallback: string): string {
  const v = (p ?? '').trim() || fallback;
  return path.isAbsolute(v) ? v : path.resolve(PROJECT_DIR, v);
}

function bool(v: string | undefined): boolean | undefined {
  if (v === undefined || v.trim() === '') return undefined;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

/** Same rule as the web app: empty -> the entry is removed from the PDF. */
function meta(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

export const config = {
  token: (process.env.BOT_TOKEN ?? '').trim(),
  allowedUserIds: (process.env.ALLOWED_USER_ID ?? '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0),
  templatePath: resolvePath(process.env.TEMPLATE_PATH, 'bot/data/template.json'),
  formPath: process.env.FORM_PATH?.trim() ? resolvePath(process.env.FORM_PATH, '') : undefined,
  fontPath: process.env.FONT_PATH?.trim() ? resolvePath(process.env.FONT_PATH, '') : undefined,
  flatten: bool(process.env.FLATTEN),
  stripXmp: bool(process.env.STRIP_XMP) ?? true,
  titleFromJobName: bool(process.env.TITLE_FROM_JOB_NAME) ?? false,
  metadata: {
    author: meta('PDF_AUTHOR', 'Alex'),
    creator: meta('PDF_CREATOR'),
    producer: meta('PDF_PRODUCER'),
  },
};

export function checkConfig(): string[] {
  const problems: string[] = [];
  if (!config.token) problems.push('BOT_TOKEN is missing in .env');
  if (!config.allowedUserIds.length) problems.push('ALLOWED_USER_ID is missing in .env (your numeric Telegram user id)');
  return problems;
}
