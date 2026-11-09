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
}

const MAX_JOBS = 50;
const jobs = new Map<string, Job>();
/** user id -> job waiting for a Job Name typed as text */
const awaitingName = new Map<number, string>();

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
  if (jobId) awaitingName.set(userId, jobId);
  else awaitingName.delete(userId);
}

export function jobAwaitingName(userId: number): Job | undefined {
  const id = awaitingName.get(userId);
  return id ? jobs.get(id) : undefined;
}

/** for tests */
export function clearJobs() {
  jobs.clear();
  awaitingName.clear();
}
