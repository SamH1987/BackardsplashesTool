// Video/audio transcription + turning the transcript into structured notes.
//
// Transcription runs fully on this machine: ffmpeg (bundled via ffmpeg-static)
// pulls the audio out of the video, and a local Whisper speech model
// (@xenova/transformers) turns it into text. The first ever transcription
// downloads the model (~150MB) into spa-jobs/.models - after that it works
// offline. If those optional packages failed to install, the app still runs;
// the founder just types notes instead.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const storage = require('./storage');

let pipelinePromise = null;

function loadWhisper() {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const { pipeline, env } = await import('@xenova/transformers');
      env.cacheDir = path.join(storage.ROOT, '.models');
      env.allowLocalModels = false;
      return pipeline('automatic-speech-recognition', 'Xenova/whisper-base.en');
    })();
  }
  return pipelinePromise;
}

function extractAudio(videoPath) {
  return new Promise((resolve, reject) => {
    let ffmpegPath;
    try { ffmpegPath = require('ffmpeg-static'); }
    catch (e) { return reject(new Error('ffmpeg-static is not installed')); }
    const args = ['-i', videoPath, '-ar', '16000', '-ac', '1', '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1'];
    const proc = spawn(ffmpegPath, args);
    const chunks = [];
    proc.stdout.on('data', c => chunks.push(c));
    let err = '';
    proc.stderr.on('data', c => { err += c; });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code !== 0) return reject(new Error('ffmpeg failed: ' + err.slice(-400)));
      resolve(Buffer.concat(chunks));
    });
  });
}

function pcm16ToFloat32(buf) {
  const out = new Float32Array(buf.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
}

async function transcribe(videoPath) {
  const pcm = await extractAudio(videoPath);
  if (!pcm.length) throw new Error('No audio found in that file.');
  const whisper = await loadWhisper();
  const audio = pcm16ToFloat32(pcm);
  const result = await whisper(audio, { chunk_length_s: 30, stride_length_s: 5 });
  return (result.text || '').trim();
}

// ---- Structured notes -------------------------------------------------------
// Splits a spoken transcript into the buckets the rest of the system uses.
// Rule-based on purpose: predictable, free, works offline. Everything it
// produces is editable on screen.

const BUCKETS = [
  { key: 'hazards', words: ['hazard', 'careful', 'watch', 'power line', 'powerline', 'overhead', 'sewer', 'stormwater', 'gas', 'unstable', 'steep', 'slippery', 'asbestos', 'tree root', 'retaining'] },
  { key: 'access', words: ['access', 'gate', 'path', 'side of the house', 'driveway', 'crane', 'narrow', 'clearance', 'get it in', 'get in', 'carry'] },
  { key: 'position', words: ['position', 'sit ', 'sits', 'sitting', 'corner', 'against', 'next to', 'facing', 'face ', 'faces', 'spot', 'go here', 'going here', 'going in', 'place it', 'located', 'boundary', 'off the fence'] },
  { key: 'requests', words: ['wants', 'want ', 'would like', 'asked for', 'asked us', 'keen on', 'prefer', 'requested', 'budget', 'hoping'] },
  { key: 'dimensions', words: ['metre', 'meter', ' mm', 'millimetre', 'centimetre', ' cm', 'measure', 'long', 'wide', 'deep', 'width', 'length', 'depth', 'level', 'fall', 'slope', 'kilo', ' kg'] }
];

function structureNotes(transcript) {
  const notes = { position: [], dimensions: [], access: [], hazards: [], requests: [], general: [] };
  const sentences = (transcript || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean);
  for (const s of sentences) {
    const lower = ' ' + s.toLowerCase() + ' ';
    const bucket = BUCKETS.find(b => b.words.some(w => lower.includes(w)));
    notes[bucket ? bucket.key : 'general'].push(s);
  }
  return notes;
}

module.exports = { transcribe, structureNotes };
