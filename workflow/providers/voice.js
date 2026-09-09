'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { LIMITS, fail, str, inputData, noSecrets, mark } = require('./validation');
const VOICE_VARS = Object.freeze(['ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID', 'ELEVENLABS_MODEL_ID', 'ELEVENLABS_SPEED', 'ELEVENLABS_STABILITY', 'ELEVENLABS_SIMILARITY_BOOST', 'ELEVENLABS_STYLE', 'ELEVENLABS_USE_SPEAKER_BOOST']);
function voiceEnv(env) {
  const result = {};
  for (const name of VOICE_VARS) {
    if (typeof env[name] !== 'string' || !env[name].trim() || env[name].length > 512) throw fail('CONFIG_MISSING');
    result[name] = env[name].trim();
  }
  if (result.ELEVENLABS_API_KEY !== undefined && !/^[\x21-\x7e]{8,512}$/u.test(result.ELEVENLABS_API_KEY)) throw fail('CONFIG_MISSING');
  for (const name of ['ELEVENLABS_VOICE_ID', 'ELEVENLABS_MODEL_ID']) if (result[name] !== undefined && !/^[a-zA-Z0-9_-]{1,100}$/u.test(result[name])) throw fail('CONFIG_MISSING');
  for (const [name, low, high] of [['ELEVENLABS_SPEED', 0.7, 1.2], ['ELEVENLABS_STABILITY', 0, 1], ['ELEVENLABS_SIMILARITY_BOOST', 0, 1], ['ELEVENLABS_STYLE', 0, 1]]) {
    const value = result[name];
    if (value === undefined) continue;
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/u.test(value) || !Number.isFinite(Number(value)) || Number(value) < low || Number(value) > high) throw fail('CONFIG_MISSING');
  }
  if (result.ELEVENLABS_USE_SPEAKER_BOOST !== undefined && !/^(true|false|1|0)$/iu.test(result.ELEVENLABS_USE_SPEAKER_BOOST)) throw fail('CONFIG_MISSING');
  // Deliberately omit proxy, PYTHONPATH, .env configuration and all other secrets.
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'LANG']) if (typeof env[name] === 'string') result[name] = env[name];
  result.PYTHON_DOTENV_DISABLED = '1';
  result.PYTHONIOENCODING = 'utf-8';
  return result;
}
function runBridge({ env, target, text, context, spawnImpl = spawn }) {
  return new Promise((resolve, reject) => {
    let child;
    let phase = 'initial';
    let paidStarted = false;
    let publicError;
    let output = '';
    let closed = false;
    function stop(code) {
      if (closed) return;
      publicError ??= fail(code);
      child?.kill();
    }
    const abort = () => stop(paidStarted ? 'EXTERNAL_OUTCOME_UNKNOWN' : 'CANCELLED');
    const timer = setTimeout(() => stop(paidStarted ? 'EXTERNAL_OUTCOME_UNKNOWN' : 'CONFIG_MISSING'), LIMITS.timeout + 10000);
    try {
      // Executable override is server configuration only, never input/model data.
      child = spawnImpl(env.WF_PYTHON || 'python', ['-I', '-B', path.join(__dirname, 'voice_bridge.py'), target], { env: voiceEnv(env), windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch { clearTimeout(timer); reject(fail('CONFIG_MISSING')); return; }
    context.signal?.addEventListener('abort', abort, { once: true });
    child.on('error', () => stop(paidStarted ? 'EXTERNAL_OUTCOME_UNKNOWN' : 'CONFIG_MISSING'));
    child.stdin.on('error', () => stop(paidStarted ? 'EXTERNAL_OUTCOME_UNKNOWN' : 'CONFIG_MISSING'));
    child.stderr.on('data', () => {}); // Never surface SDK errors or payloads.
    child.stdout.on('data', chunk => {
      output += chunk.toString('utf8');
      if (output.length > 1024) { stop(paidStarted ? 'EXTERNAL_OUTCOME_UNKNOWN' : 'CONFIG_MISSING'); return; }
      let newline;
      while ((newline = output.indexOf('\n')) >= 0) {
        const line = output.slice(0, newline).trim();
        output = output.slice(newline + 1);
        if (line === '{"ready":true}' && phase === 'initial') {
          phase = 'marking';
          mark(context).then(() => {
            if (closed || publicError) return;
            // The child has validated imports/config; GO is the only paid-call gate.
            phase = 'go';
            paidStarted = true;
            child.stdin.end('{"go":true}\n');
          }, () => stop(context.signal?.aborted ? 'CANCELLED' : 'START_FAILED'));
        } else if (line === '{"done":true}' && phase === 'go') {
          phase = 'done';
        } else if (line === '{"error":"CONFIG_MISSING"}' && phase === 'initial') {
          stop('CONFIG_MISSING');
        } else if (line === '{"error":"EXTERNAL_REJECTED"}' && phase === 'go') {
          stop('EXTERNAL_REJECTED');
        } else {
          stop(paidStarted ? 'EXTERNAL_OUTCOME_UNKNOWN' : 'INVALID_OUTPUT');
        }
      }
    });
    child.on('close', code => {
      closed = true;
      clearTimeout(timer);
      context.signal?.removeEventListener('abort', abort);
      if (publicError) reject(publicError);
      else if (code !== 0 || phase !== 'done') reject(fail(paidStarted ? 'EXTERNAL_OUTCOME_UNKNOWN' : 'CONFIG_MISSING'));
      else resolve();
    });
    if (context.signal?.aborted) abort();
    else child.stdin.write(JSON.stringify({ text }) + '\n');
  });
}
function voice(env, { spawnImpl } = {}) {
  return async context => {
    voiceEnv(env); // Fail before creating a process or marking external start.
    const safe = inputData(context.input, context.outputs, 'voz');
    const text = str(safe.script, LIMITS.text);
    noSecrets(text, env);
    if (context.signal?.aborted) throw fail('CANCELLED');
    let dir;
    try { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-voice-')); }
    catch { throw fail('CONFIG_MISSING'); }
    const target = path.join(dir, 'narracao.mp3');
    try {
      await runBridge({ env, target, text, context, spawnImpl });
      const stat = await fs.lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 3 || stat.size > LIMITS.audio) throw fail('INVALID_OUTPUT');
      const bytes = await fs.readFile(target);
      if (bytes.length > LIMITS.audio || !(bytes.subarray(0, 3).toString('ascii') === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0))) throw fail('INVALID_OUTPUT');
      return { data: { format: 'mp3', bytes: bytes.length }, files: [{ name: 'narracao.mp3', mime: 'audio/mpeg', bytes }] };
    } catch (error) {
      const codes = ['INVALID_INPUT', 'INVALID_OUTPUT', 'CONFIG_MISSING', 'EXTERNAL_OUTCOME_UNKNOWN', 'EXTERNAL_REJECTED', 'CANCELLED', 'START_FAILED'];
      throw fail(codes.includes(error?.code) ? error.code : 'INVALID_OUTPUT');
    } finally { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
  };
}
module.exports = { voice, voiceEnv, VOICE_VARS };
