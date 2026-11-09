// Jobs on disk: the source PDF + what the user chose (name, corrections, flatten, template).
// Lets buttons on old messages keep working after a restart, and powers /history.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { config } from './config.ts';
import { addJob, getJob, type Job } from './jobs.ts';
import { prepareJob, suggestJobNames } from './pdf.ts';

const KEEP = 200;

interface Meta {
  id: string;
  userId: number;
  chatId: number;
  sourceName: string;
  createdAt: number;
  updatedAt: number;
  jobName?: string | undefined;
  overrides: Record<string, string>;
  flatten?: boolean | undefined;
  skipped?: string[] | undefined;
  templateId: string;
  templateName: string;
  fileId?: string | undefined;
  fileName?: string | undefined;
  sourceHash?: string | undefined;
}

export const hashOf = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const dirOf = (id: string) => path.join(config.jobsDir, id);
const validId = (id: string) => /^[a-z0-9]{4,12}$/.test(id);

/** Save (or update) a job. The source PDF is written once. */
export async function saveJob(job: Job): Promise<void> {
  const dir = dirOf(job.id);
  await fs.mkdir(dir, { recursive: true });
  const src = path.join(dir, 'source.pdf');
  if (!(await fs.stat(src).catch(() => null))) await fs.writeFile(src, job.sourceBytes);
  const meta: Meta = {
    id: job.id,
    userId: job.userId,
    chatId: job.chatId,
    sourceName: job.sourceName,
    createdAt: job.createdAt,
    updatedAt: Date.now(),
    jobName: job.jobName,
    overrides: job.overrides,
    flatten: job.flatten,
    skipped: job.skipped,
    templateId: job.prepared.template.id,
    templateName: job.prepared.template.name,
    fileId: job.result?.fileId,
    fileName: job.result?.fileName,
    sourceHash: job.sourceHash ?? hashOf(job.sourceBytes),
  };
  await fs.writeFile(path.join(dir, 'job.json'), JSON.stringify(meta, null, 2));
}

async function readMeta(id: string): Promise<Meta | undefined> {
  try {
    return JSON.parse(await fs.readFile(path.join(dirOf(id), 'job.json'), 'utf8')) as Meta;
  } catch {
    return undefined;
  }
}

/** A job from memory, or brought back from disk (re-reads the source PDF). */
export async function findJob(id: string): Promise<Job | undefined> {
  const live = getJob(id);
  if (live || !validId(id)) return live;
  const meta = await readMeta(id);
  if (!meta) return undefined;
  try {
    const sourceBytes = new Uint8Array(await fs.readFile(path.join(dirOf(id), 'source.pdf')));
    const prepared = await prepareJob(sourceBytes, meta.templateId);
    return addJob({
      id: meta.id,
      userId: meta.userId,
      chatId: meta.chatId,
      sourceName: meta.sourceName,
      sourceBytes,
      prepared,
      createdAt: meta.createdAt,
      ...(meta.jobName ? { jobName: meta.jobName } : {}),
      overrides: meta.overrides ?? {},
      ...(meta.flatten !== undefined ? { flatten: meta.flatten } : {}),
      ...(meta.skipped ? { skipped: meta.skipped } : {}),
      ...(meta.fileId ? { result: { fileId: meta.fileId, fileName: meta.fileName ?? `${meta.jobName}.pdf` } } : {}),
      suggestions: suggestJobNames(prepared, meta.sourceName),
      ...(meta.sourceHash ? { sourceHash: meta.sourceHash } : {}),
    });
  } catch (e) {
    console.warn(`Could not restore job ${id}:`, (e as Error).message);
    return undefined;
  }
}

export interface HistoryEntry {
  id: string;
  jobName?: string | undefined;
  sourceName: string;
  templateName: string;
  updatedAt: number;
  fileId?: string | undefined;
  fileName?: string | undefined;
}

/** Newest first. Also removes the oldest jobs beyond the last 200. */
export async function history(userId: number, limit = 10): Promise<HistoryEntry[]> {
  let ids: string[] = [];
  try {
    ids = (await fs.readdir(config.jobsDir)).filter(validId);
  } catch {
    return [];
  }
  const metas = (await Promise.all(ids.map(readMeta))).filter((m): m is Meta => !!m);
  metas.sort((a, b) => b.updatedAt - a.updatedAt);
  for (const old of metas.slice(KEEP)) await fs.rm(dirOf(old.id), { recursive: true, force: true });
  return metas
    .slice(0, KEEP)
    .filter((m) => m.userId === userId)
    .slice(0, limit)
    .map((m) => ({
      id: m.id,
      jobName: m.jobName,
      sourceName: m.sourceName,
      templateName: m.templateName,
      updatedAt: m.updatedAt,
      fileId: m.fileId,
      fileName: m.fileName,
    }));
}

/** The newest earlier job of this user with the same source PDF that produced a file. */
export async function findDuplicate(userId: number, sourceHash: string, exceptId: string): Promise<HistoryEntry | undefined> {
  let ids: string[] = [];
  try {
    ids = (await fs.readdir(config.jobsDir)).filter((id) => validId(id) && id !== exceptId);
  } catch {
    return undefined;
  }
  const metas = (await Promise.all(ids.map(readMeta))).filter(
    (m): m is Meta => !!m && m.userId === userId && m.sourceHash === sourceHash && !!m.fileId,
  );
  const m = metas.sort((a, b) => b.updatedAt - a.updatedAt)[0];
  return m && { id: m.id, jobName: m.jobName, sourceName: m.sourceName, templateName: m.templateName, updatedAt: m.updatedAt, fileId: m.fileId, fileName: m.fileName };
}
