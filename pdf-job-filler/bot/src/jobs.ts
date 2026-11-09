import type { Prepared } from './pdf.ts';

/** A source PDF the user sent, ready to be filled (possibly several times). */
export interface Job {
  id: string;
  userId: number;
  chatId: number;
  sourceName: string;
  sourceBytes: Uint8Array;
  prepared: Prepared;
  createdAt: number;
  jobName?: string;
  overrides: Record<string, string>;
  flatten?: boolean;
  suggestions: string[];
  /** missing fields still to ask for (guided fill) */
  walk?: string[] | undefined;
  walkTotal?: number;
  /** fields the user chose to leave empty */
  skipped?: string[];
  /** result filled ahead for the top suggestion (see fillAhead) */
  ahead?: { key: string; promise: Promise<any> } | undefined;
}

const MAX_JOBS = 50;
const jobs = new Map<string, Job>();
/** What the next typed text from a user means: a Job Name, or a new value for one field. */
export interface Awaiting {
  jobId: string;
  field?: string;
}
const awaiting = new Map<number, Awaiting>();

export function newJobId(): string {
  let id: string;
  do id = Math.random().toString(36).slice(2, 8);
  while (jobs.has(id));
  return id;
}

export function addJob(job: Job): Job {
  jobs.set(job.id, job);
  while (jobs.size > MAX_JOBS) jobs.delete(jobs.keys().next().value!);
  return job;
}

export const getJob = (id: string) => jobs.get(id);

export function waitForName(userId: number, jobId: string | undefined) {
  if (jobId) awaiting.set(userId, { jobId });
  else awaiting.delete(userId);
}

export function waitForValue(userId: number, jobId: string, field: string) {
  awaiting.set(userId, { jobId, field });
}

/** The job and field the user's next text belongs to, if any. */
export function pendingInput(userId: number): { job: Job; field?: string } | undefined {
  const a = awaiting.get(userId);
  const job = a && jobs.get(a.jobId);
  return job ? { job, ...(a.field ? { field: a.field } : {}) } : undefined;
}

export function jobAwaitingName(userId: number): Job | undefined {
  const p = pendingInput(userId);
  return p && !p.field ? p.job : undefined;
}

/** for tests */
export function clearJobs() {
  jobs.clear();
  awaiting.clear();
}
