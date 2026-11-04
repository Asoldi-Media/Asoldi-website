/**
 * Splits a meeting transcript ("Speaker: text" lines) into chunks for the map step. A chunk holds
 * whole speaker turns, is at most CHUNK_MAX_CHARS long and starts with the last turns of the chunk
 * before it (at most CHUNK_OVERLAP_CHARS), so a statement on a boundary is seen whole at least once.
 * A turn longer than a chunk is cut at word boundaries and each piece keeps the speaker label.
 * Each chunk carries the sha256 of its text, which keys the extraction cache.
 */
import { sha256 } from './text.js';

export const CHUNK_MAX_CHARS = 9000;
export const CHUNK_OVERLAP_CHARS = 600;
const SPEAKER_RE = /^\s*([^:\n]{1,80}?):\s+\S/;

/** The speaker label of a line ("" when the line has none). */
export function speakerOf(line) {
  const match = SPEAKER_RE.exec(String(line ?? ''));
  return match ? match[1].trim() : '';
}

/** Speaker turns: a line with a speaker label starts a turn; other lines continue the previous one. */
export function splitSpeakerTurns(transcript) {
  const turns = [];
  for (const raw of String(transcript ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    const speaker = speakerOf(line);
    if (speaker || !turns.length) turns.push({ speaker, text: line.trim() });
    else turns[turns.length - 1].text += `\n${line.trim()}`;
  }
  return turns;
}

function cutAtWord(textValue, max) {
  if (textValue.length <= max) return [textValue, ''];
  let cut = textValue.lastIndexOf(' ', max);
  if (cut < max * 0.5) cut = max;
  return [textValue.slice(0, cut).trimEnd(), textValue.slice(cut).trimStart()];
}

/** Turns no longer than `max`; a longer turn becomes pieces that each keep "Speaker: ". */
function boundedTurns(turns, max) {
  const out = [];
  for (const turn of turns) {
    if (turn.text.length <= max) {
      out.push(turn);
      continue;
    }
    const label = turn.speaker ? `${turn.speaker}: ` : '';
    let rest = label && turn.text.startsWith(label) ? turn.text.slice(label.length) : turn.text;
    const room = Math.max(200, max - label.length);
    while (rest) {
      const [head, tail] = cutAtWord(rest, room);
      out.push({ speaker: turn.speaker, text: `${label}${head}` });
      rest = tail;
    }
  }
  return out;
}

/** The trailing part of `turns` used as the next chunk's overlap (at most `limit` characters). */
function overlapOf(turns, limit) {
  const out = [];
  let size = 0;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    const cost = turn.text.length + (out.length ? 1 : 0);
    if (size + cost <= limit) {
      out.unshift(turn);
      size += cost;
      continue;
    }
    if (!out.length && limit > 80) {
      // The last turn alone is longer than the overlap: keep its end, cut at a word, with its label.
      const label = turn.speaker ? `${turn.speaker}: ` : '';
      const body = label && turn.text.startsWith(label) ? turn.text.slice(label.length) : turn.text;
      const room = limit - label.length;
      let tail = body.slice(-room);
      const space = tail.indexOf(' ');
      if (space > 0 && space < room * 0.5) tail = tail.slice(space + 1);
      if (tail.trim()) out.unshift({ speaker: turn.speaker, text: `${label}${tail.trim()}` });
    }
    break;
  }
  return out;
}

/**
 * @returns {{index:number, sha:string, text:string, chars:number, turns:number}[]}
 */
export function chunkTranscript(transcript, { maxChars = CHUNK_MAX_CHARS, overlapChars = CHUNK_OVERLAP_CHARS } = {}) {
  const max = Math.max(1000, Number(maxChars) || CHUNK_MAX_CHARS);
  const overlap = Math.max(0, Math.min(Number(overlapChars) || 0, Math.floor(max / 3)));
  const turns = boundedTurns(splitSpeakerTurns(transcript), max - overlap - 1);
  const chunks = [];
  let current = [];
  let size = 0;
  let fresh = 0;
  const emit = () => {
    if (!fresh) return;
    const body = current.map((turn) => turn.text).join('\n');
    chunks.push({ index: chunks.length, sha: sha256(body), text: body, chars: body.length, turns: current.length });
  };
  for (const turn of turns) {
    const cost = turn.text.length + (current.length ? 1 : 0);
    if (current.length && size + cost > max) {
      emit();
      current = overlapOf(current, overlap);
      size = current.reduce((sum, item, i) => sum + item.text.length + (i ? 1 : 0), 0);
      fresh = 0;
    }
    size += turn.text.length + (current.length ? 1 : 0);
    current.push(turn);
    fresh += 1;
  }
  emit();
  return chunks;
}
