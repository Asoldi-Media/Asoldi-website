const jobs = new Map();
const MAX_JOBS = 200;

export function createAssistantJob(userId, type, extra = {}) {
  const id = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    id,
    userId: String(userId || ''),
    type,
    status: 'queued',
    progress: { step: 'queued', message: 'Starter…', found: 0, pages: 0 },
    catalog: null,
    error: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...extra,
  };
  jobs.set(id, job);
  if (jobs.size > MAX_JOBS) {
    const oldest = [...jobs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (oldest) jobs.delete(oldest.id);
  }
  return job;
}

export function getAssistantJob(jobId, userId) {
  const job = jobs.get(String(jobId || ''));
  if (!job) return null;
  if (userId && job.userId !== String(userId)) return null;
  return job;
}

export function updateAssistantJob(jobId, patch = {}) {
  const job = jobs.get(String(jobId || ''));
  if (!job) return null;
  Object.assign(job, patch, {
    progress: { ...job.progress, ...(patch.progress || {}) },
    updatedAt: new Date().toISOString(),
  });
  return job;
}

export function publicJobView(job) {
  if (!job) return null;
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    progress: job.progress,
    catalog: job.catalog,
    catalogs: job.catalogs || (job.catalog ? [job.catalog] : []),
    assistantMessage: job.assistantMessage || '',
    redirectTo: job.redirectTo || '',
    nextAction: job.nextAction || '',
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}
