'use strict';

const LIMITS = Object.freeze({ text: 12000, transcript: 24000, title: 160, response: 131072, audio: 20 * 1024 * 1024, timeout: 120000 });
function fail(code = 'INVALID_INPUT') {
  const messages = { INVALID_INPUT: 'Entrada inválida.', INVALID_OUTPUT: 'Resposta inválida do provedor.', CONFIG_MISSING: 'Configuração do provedor ausente ou inválida.', EXTERNAL_OUTCOME_UNKNOWN: 'Resultado externo incerto; não repetir automaticamente.', EXTERNAL_REJECTED: 'Solicitação recusada pelo provedor.', CANCELLED: 'Operação cancelada.', START_FAILED: 'Não foi possível registrar o início externo.' };
  return Object.assign(new Error(messages[code] || 'Falha no provedor.'), { code });
}
function object(value, keys, code = 'INVALID_INPUT') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw fail(code);
  if (Object.keys(value).some(k => !keys.includes(k))) throw fail(code);
  return value;
}
function str(value, max, code = 'INVALID_INPUT', empty = false) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) throw fail(code);
  return value;
}
function noSecrets(value, env, code = 'INVALID_INPUT') {
  // Defense in depth for known provider credentials, not a general secret scanner.
  const secrets = ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'ELEVENLABS_API_KEY'].map(name => env[name]).filter(s => typeof s === 'string' && s);
  const visit = item => {
    if (typeof item === 'string' && secrets.some(secret => item.includes(secret))) throw fail(code);
    if (Array.isArray(item)) item.forEach(visit);
    else if (item && typeof item === 'object') Object.values(item).forEach(visit);
  };
  visit(value);
}
function inputData(input, outputs = {}, stage) {
  object(input, ['transcript', 'script', 'title', 'channel', 'operation', 'settings']);
  const settings = object(input.settings ?? {}, ['language', 'targetLanguage', 'durationSeconds', 'credits']);
  const safe = {};
  for (const [key, cap] of Object.entries({ transcript: LIMITS.transcript, script: LIMITS.text, title: LIMITS.title, channel: 100 })) {
    if (input[key] !== undefined) safe[key] = str(input[key], cap, 'INVALID_INPUT', true);
  }
  safe.operation = input.operation ?? 'formatar';
  if (!['traduzir', 'formatar', 'remodelar', 'traduzir_remodelar'].includes(safe.operation)) throw fail();
  safe.settings = {};
  for (const key of ['language', 'targetLanguage']) {
    if (settings[key] !== undefined) {
      const language = str(settings[key], 24);
      if (!/^[a-zA-Z]{2,12}(?:-[a-zA-Z]{2,12})?$/u.test(language)) throw fail();
      safe.settings[key] = language;
    }
  }
  if (settings.durationSeconds !== undefined) {
    if (!Number.isInteger(settings.durationSeconds) || settings.durationSeconds < 5 || settings.durationSeconds > 180) throw fail();
    safe.settings.durationSeconds = settings.durationSeconds;
  }
  safe.settings.credits = str(settings.credits ?? '', 2000, 'INVALID_INPUT', true);
  if (stage !== 'roteiro') {
    safe.script = str(safe.script?.trim() ? safe.script : outputs?.roteiro?.data?.script, LIMITS.text);
    delete safe.transcript;
  } else {
    str(safe.transcript || safe.script, LIMITS.transcript);
  }
  if (stage === 'seo') safe.title = str(safe.title?.trim() ? safe.title : outputs?.titulos?.data?.title, LIMITS.title);
  return safe;
}
async function mark(context) {
  if (context.signal?.aborted) throw fail('CANCELLED');
  if (typeof context.markExternalStarted !== 'function') throw fail('START_FAILED');
  try { await context.markExternalStarted(); } catch { throw fail('START_FAILED'); }
  if (context.signal?.aborted) throw fail('CANCELLED');
}
module.exports = { LIMITS, fail, object, str, noSecrets, inputData, mark };
