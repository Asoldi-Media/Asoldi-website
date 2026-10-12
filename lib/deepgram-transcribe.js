/**
 * Pre-recorded Deepgram Nova-3 transcription. Server-only.
 * Key from DEEPGRAM_API_KEY. Never import this from React.
 */

const LISTEN_URL = 'https://api.deepgram.com/v1/listen';
const DEFAULT_TIMEOUT_MS = 120_000;

function text(value = '') {
  return String(value ?? '').trim();
}

export function readDeepgramConfig(env = process.env) {
  return { apiKey: text(env.DEEPGRAM_API_KEY) };
}

export function isDeepgramConfigured(config = readDeepgramConfig()) {
  return Boolean(config.apiKey);
}

export function deepgramListenQuery() {
  return new URLSearchParams({
    model: 'nova-3',
    // shortcut: language=multi has no Norwegian, so Norwegian calls come out as German/English noise. language=no is the whole file.
    language: 'no',
    diarize: 'true',
    // shortcut: Nova-3 rejects diarize_model together with diarize. diarize=true is the speaker split.
    punctuate: 'true',
    utterances: 'true',
    smart_format: 'true',
  }).toString();
}

function speakerIndex(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

function chatLine(speaker, line) {
  const spoken = text(line);
  if (!spoken) return '';
  return `Taler ${speakerIndex(speaker)}: ${spoken}`;
}

function linesFromUtterances(utterances = []) {
  return (Array.isArray(utterances) ? utterances : [])
    .map((row) => chatLine(row?.speaker, row?.transcript))
    .filter(Boolean);
}

function linesFromWords(words = []) {
  const lines = [];
  let currentSpeaker = null;
  let parts = [];
  for (const word of Array.isArray(words) ? words : []) {
    const spoken = text(word?.punctuated_word || word?.word);
    if (!spoken) continue;
    const speaker = speakerIndex(word?.speaker);
    if (currentSpeaker != null && speaker !== currentSpeaker) {
      const line = chatLine(currentSpeaker, parts.join(' '));
      if (line) lines.push(line);
      parts = [];
    }
    currentSpeaker = speaker;
    parts.push(spoken);
  }
  if (parts.length) {
    const line = chatLine(currentSpeaker ?? 0, parts.join(' '));
    if (line) lines.push(line);
  }
  return lines;
}

/** Chat-like transcript from Deepgram listen JSON. Uses speaker integers. */
export function formatDeepgramChat(payload = {}) {
  const results = payload?.results && typeof payload.results === 'object' ? payload.results : payload;
  const fromUtterances = linesFromUtterances(results?.utterances);
  if (fromUtterances.length) return fromUtterances.join('\n');
  const channels = Array.isArray(results?.channels) ? results.channels : [];
  const words = channels[0]?.alternatives?.[0]?.words;
  const fromWords = linesFromWords(words);
  if (fromWords.length) return fromWords.join('\n');
  const plain = text(channels[0]?.alternatives?.[0]?.transcript);
  return plain ? chatLine(0, plain) : '';
}

export function mimeFromRecordingName(fileName = '') {
  const ext = String(fileName || '').split('.').pop()?.toLowerCase();
  if (ext === 'mp3') return 'audio/mpeg';
  if (ext === 'm4a' || ext === 'mp4') return 'audio/mp4';
  if (ext === 'ogg') return 'audio/ogg';
  if (ext === 'flac') return 'audio/flac';
  if (ext === 'webm') return 'audio/webm';
  return 'audio/wav';
}

/**
 * POST pre-recorded bytes. Does not pad duration.
 * Missing key returns { ok: false, status: 'needs-key' } and does not throw.
 */
export async function transcribePrerecordedBuffer({
  buffer,
  mime = 'audio/wav',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
  config = readDeepgramConfig(),
} = {}) {
  if (!isDeepgramConfigured(config)) {
    return { ok: false, status: 'needs-key', transcriptChat: '', error: 'DEEPGRAM_API_KEY mangler.' };
  }
  if (!buffer || !Buffer.isBuffer(buffer) || !buffer.length) {
    return { ok: false, status: 'failed', transcriptChat: '', error: 'Tom lydfil.' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${LISTEN_URL}?${deepgramListenQuery()}`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${config.apiKey}`,
        'Content-Type': mime || 'application/octet-stream',
      },
      body: buffer,
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        ok: false,
        status: 'failed',
        transcriptChat: '',
        error: text(payload?.err_msg || payload?.error || `Deepgram ${response.status}`),
      };
    }
    const transcriptChat = formatDeepgramChat(payload);
    if (!transcriptChat) {
      return { ok: false, status: 'failed', transcriptChat: '', error: 'Deepgram returnerte tomt transkript.' };
    }
    return { ok: true, status: 'ready', transcriptChat, payload };
  } catch (error) {
    const aborted = error?.name === 'AbortError';
    return {
      ok: false,
      status: 'failed',
      transcriptChat: '',
      error: aborted ? 'Deepgram tidsavbrudd.' : text(error?.message) || 'Deepgram-feil.',
    };
  } finally {
    clearTimeout(timer);
  }
}

let deepgramQueue = Promise.resolve();

/** One Deepgram POST at a time so many winners do not stampede. */
export function enqueueDeepgramJob(job) {
  const run = deepgramQueue.then(job, job);
  deepgramQueue = run.then(() => undefined, () => undefined);
  return run;
}
