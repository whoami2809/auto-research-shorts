// Same major CDN reference as /app, resolved and pinned on implementation.
const SUPABASE_CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.116.0/+esm';
const STAGES = { roteiro: 'Roteiro', titulos: 'Títulos', seo: 'SEO', voz: 'Voz', frames: 'Frames', busca: 'Pesquisa', downloads: 'Downloads', organizar: 'Organização' };
const STAGE_HELP = {
  roteiro: 'Traduz e remodela o roteiro para português.', titulos: 'Sugere títulos curtos e fortes para o vídeo.',
  seo: 'Cria descrição, hashtags e tags para publicação.', voz: 'Gera a narração com a voz configurada no ElevenLabs.',
  frames: 'Extrai frames PNG claros do vídeo-base.', busca: 'Organiza candidatos encontrados no Lens e nas redes permitidas.',
  downloads: 'Baixa somente links autorizados e registra os créditos.', organizar: 'Reúne os arquivos no pacote final do projeto.'
};
const STATUS = { pending: 'Pendente', queued: 'Na fila', running: 'Em execução', ready: 'Pronta', failed: 'Falhou', waiting_input: 'Aguarda sua entrada', unknown: 'Estado desconhecido', stale: 'Desatualizada' };
const FIELDS = ['name', 'transcript', 'script', 'title', 'links', 'channel'];
const OFFICIAL = ['youtube.com', 'youtu.be', 'tiktok.com', 'instagram.com', 'facebook.com'];
const LIMITS = { name: 120, channel: 80, title: 180, transcript: 20000, script: 20000 };
const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
function importMime(kind, file) {
  if (!['base', 'voice'].includes(kind)) throw new Error('Tipo de importação inválido.');
  if (!file || !Number.isFinite(file.size) || file.size <= 0) throw new Error('Selecione um arquivo não vazio.');
  if (file.size > MAX_IMPORT_BYTES) throw new Error('O arquivo excede o limite de 50 MiB.');
  const mime = file.type === 'audio/x-wav' || file.type === 'audio/wave' ? 'audio/wav' : file.type;
  if (!(kind === 'base' ? ['video/mp4'] : ['audio/mpeg', 'audio/wav']).includes(mime)) throw new Error(kind === 'base' ? 'Selecione um vídeo MP4 (video/mp4).' : 'Selecione uma narração MP3 ou WAV (audio/mpeg ou audio/wav).');
  // Browser metadata is only a precheck. The server validates the actual media.
  return mime;
}
function editorialText(output, field) {
  const data = output?.data ?? output;
  return typeof data === 'string' ? data : typeof data?.[field] === 'string' ? data[field] : null;
}
function apiErrorMessage(payload, status) {
  const detail = typeof payload?.error === 'string' ? payload.error : payload?.error?.message;
  if (status >= 500) return `Pedido não concluído (HTTP ${status}). O servidor do workflow não respondeu corretamente; verifique o backend e tente Atualizar lista novamente.`;
  return (typeof detail === 'string' && detail.trim() ? detail.slice(0, 2000) + ' ' : '') +
    (status === 401 ? 'O servidor não aceitou esta sessão. Ela foi preservada localmente. Entre novamente no /app ou atualize a página.' : `Pedido não concluído (HTTP ${status}).`);
}
function validateFields(body) {
  for (const [field, limit] of Object.entries(LIMITS)) if (typeof body[field] === 'string' && body[field].length > limit) throw new Error(`O campo ${field} permite até ${limit} caracteres. Revise o texto antes de salvar.`);
}
// One unresolved request per user/project. Reuse its complete payload on manual retry.
function pendingRun(attempts, key, endpoint, body, uuid) {
  if (!attempts.has(key)) attempts.set(key, { endpoint, body: { ...body, request_id: uuid() } });
  return attempts.get(key);
}

function officialURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !OFFICIAL.some(host => url.hostname === host || url.hostname.endsWith('.' + host))) throw new Error('Use links HTTPS oficiais de YouTube, TikTok, Instagram ou Facebook.');
  return url.href;
}
function parseLinks(value) {
  const lines = value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length > 25) throw new Error('O limite é de 25 links por projeto.');
  return lines.map(officialURL);
}
function publicConfig(config) {
  const url = new URL(config.supabaseUrl);
  const key = config.supabasePublishableKey;
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.port && url.port !== '443')) throw new Error('Configuração de autenticação inválida.');
  if (typeof key !== 'string') throw new Error('Chave pública ausente.');
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) {
    let role;
    try { role = JSON.parse(atob(key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).role; } catch { /* Reject malformed keys. */ }
    if (role !== 'anon' || key.split('.').length !== 3) throw new Error('Somente chave pública é permitida.');
  }
  return { url: url.href, key };
}
function lensURL(value, expires) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'lens.google.com' || url.port || url.username || url.password || !Number.isFinite(Date.parse(expires)) || Date.parse(expires) <= Date.now()) throw new Error('Link Lens inválido ou expirado.');
  return url.href;
}

function initThumbnailEditor() {
  const canvas = document.getElementById('thumbnail-canvas');
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  const empty = document.getElementById('thumbnail-empty');
  const layersEl = document.getElementById('thumbnail-layers');
  const propertiesEl = document.getElementById('thumbnail-properties');
  const statusEl = document.getElementById('thumbnail-status');
  const countEl = document.getElementById('thumbnail-layer-count');
  const zoomEl = document.getElementById('thumbnail-zoom-value');
  const editor = { layers: [], selected: null, history: [], future: [], zoom: 1, drag: null, images: new Map() };
  let nextId = 1;
  const uid = () => 'layer-' + nextId++;
  const copy = value => JSON.parse(JSON.stringify(value));
  const current = () => JSON.stringify(editor.layers);
  function setStatus(message) { if (statusEl) statusEl.textContent = message; }
  function remember() { editor.history.push(current()); if (editor.history.length > 40) editor.history.shift(); editor.future = []; }
  function restore(serialized) { editor.layers = JSON.parse(serialized || '[]'); editor.selected = editor.layers.at(-1)?.id || null; render(); }
  function updateHistoryControls() {
    document.getElementById('thumbnail-undo').disabled = !editor.history.length;
    document.getElementById('thumbnail-redo').disabled = !editor.future.length;
  }
  function drawText(layer) {
    ctx.save(); ctx.translate(layer.x, layer.y); ctx.rotate((layer.rotation || 0) * Math.PI / 180); ctx.globalAlpha = layer.opacity ?? 1;
    ctx.fillStyle = layer.color; ctx.font = `${layer.weight || 800} ${layer.fontSize}px ${layer.font || 'Nunito'}`; ctx.textAlign = layer.align || 'center'; ctx.textBaseline = 'middle';
    const lines = String(layer.text || '').split('\n'); const lineHeight = layer.fontSize * 1.12; lines.forEach((line, index) => ctx.fillText(line, 0, (index - (lines.length - 1) / 2) * lineHeight)); ctx.restore();
  }
  function drawLayer(layer) {
    ctx.save(); ctx.translate(layer.x, layer.y); ctx.rotate((layer.rotation || 0) * Math.PI / 180); ctx.globalAlpha = layer.opacity ?? 1;
    if (layer.type === 'image') { const image = editor.images.get(layer.id); if (image?.complete) ctx.drawImage(image, -layer.width / 2, -layer.height / 2, layer.width, layer.height); }
    if (layer.type === 'shape') { ctx.fillStyle = layer.fill; ctx.fillRect(-layer.width / 2, -layer.height / 2, layer.width, layer.height); if (layer.stroke) { ctx.strokeStyle = layer.stroke; ctx.lineWidth = layer.strokeWidth || 4; ctx.strokeRect(-layer.width / 2, -layer.height / 2, layer.width, layer.height); } }
    ctx.restore(); if (layer.type === 'text') drawText(layer);
  }
  function drawSelection(layer) {
    if (!layer) return; ctx.save(); ctx.translate(layer.x, layer.y); ctx.rotate((layer.rotation || 0) * Math.PI / 180); ctx.strokeStyle = '#cf7cff'; ctx.lineWidth = 5; ctx.setLineDash([12, 8]);
    const width = layer.type === 'text' ? Math.max(220, ctx.measureText(layer.text || '').width + 36) : layer.width; const height = layer.type === 'text' ? layer.fontSize * 1.4 : layer.height;
    ctx.strokeRect(-width / 2, -height / 2, width, height); ctx.restore();
  }
  function renderCanvas() {
    const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height); gradient.addColorStop(0, '#151027'); gradient.addColorStop(.55, '#080914'); gradient.addColorStop(1, '#05050b'); ctx.fillStyle = gradient; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.save(); ctx.globalAlpha = .12; ctx.strokeStyle = '#9b4dff'; ctx.lineWidth = 2; for (let x = 0; x < canvas.width; x += 90) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke(); } for (let y = 0; y < canvas.height; y += 90) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke(); } ctx.restore();
    editor.layers.forEach(drawLayer); drawSelection(editor.layers.find(layer => layer.id === editor.selected));
  }
  function hit(layer, point) {
    const width = layer.type === 'text' ? Math.max(220, ctx.measureText(layer.text || '').width + 36) : layer.width; const height = layer.type === 'text' ? layer.fontSize * 1.4 : layer.height;
    return point.x >= layer.x - width / 2 && point.x <= layer.x + width / 2 && point.y >= layer.y - height / 2 && point.y <= layer.y + height / 2;
  }
  function pointFromEvent(event) { const rect = canvas.getBoundingClientRect(); return { x: (event.clientX - rect.left) * canvas.width / rect.width, y: (event.clientY - rect.top) * canvas.height / rect.height }; }
  function setLayerValue(layer, property, value) { remember(); layer[property] = value; render(); }
  function field(label, type, value, onInput, attrs = {}) { const wrapper = document.createElement('label'); wrapper.className = 'thumbnail-field'; const title = document.createElement('span'); title.textContent = label; const input = document.createElement('input'); input.type = type; input.value = value; Object.entries(attrs).forEach(([key, val]) => input.setAttribute(key, val)); input.addEventListener('input', () => onInput(input.value)); wrapper.append(title, input); return wrapper; }
  function renderProperties() {
    propertiesEl.replaceChildren(); const layer = editor.layers.find(item => item.id === editor.selected); if (!layer) { propertiesEl.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: 'Selecione uma camada para editar posição, cor e tamanho.' })); return; }
    const title = document.createElement('div'); title.className = 'thumbnail-selected-title'; title.textContent = layer.type === 'text' ? 'Texto selecionado' : layer.type === 'shape' ? 'Forma selecionada' : 'Imagem selecionada'; propertiesEl.append(title);
    const position = document.createElement('div'); position.className = 'thumbnail-field-grid'; position.append(field('X', 'number', Math.round(layer.x), value => setLayerValue(layer, 'x', Number(value)), { min: 0, max: canvas.width }), field('Y', 'number', Math.round(layer.y), value => setLayerValue(layer, 'y', Number(value)), { min: 0, max: canvas.height })); propertiesEl.append(position);
    if (layer.type === 'text') { propertiesEl.append(field('Texto', 'text', layer.text, value => setLayerValue(layer, 'text', value)), field('Tamanho', 'number', layer.fontSize, value => setLayerValue(layer, 'fontSize', Math.max(12, Number(value))), { min: 12, max: 420 }), field('Cor', 'color', layer.color, value => setLayerValue(layer, 'color', value))); }
    if (layer.type === 'shape') propertiesEl.append(field('Cor', 'color', layer.fill, value => setLayerValue(layer, 'fill', value)), field('Largura', 'number', layer.width, value => setLayerValue(layer, 'width', Math.max(20, Number(value))), { min: 20, max: canvas.width }), field('Altura', 'number', layer.height, value => setLayerValue(layer, 'height', Math.max(20, Number(value))), { min: 20, max: canvas.height }));
    if (layer.type === 'image') propertiesEl.append(field('Largura', 'number', Math.round(layer.width), value => setLayerValue(layer, 'width', Math.max(40, Number(value))), { min: 40, max: canvas.width }), field('Altura', 'number', Math.round(layer.height), value => setLayerValue(layer, 'height', Math.max(40, Number(value))), { min: 40, max: canvas.height }));
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'thumbnail-delete'; remove.textContent = 'Excluir camada'; remove.addEventListener('click', () => { remember(); editor.layers = editor.layers.filter(item => item.id !== layer.id); editor.selected = editor.layers.at(-1)?.id || null; render(); }); propertiesEl.append(remove);
  }
  function renderLayers() {
    layersEl.replaceChildren(); countEl.textContent = String(editor.layers.length); [...editor.layers].reverse().forEach(layer => { const item = document.createElement('li'); const button = document.createElement('button'); button.type = 'button'; button.className = layer.id === editor.selected ? 'is-selected' : ''; button.textContent = layer.type === 'text' ? 'T  ' + (layer.text || 'Texto').slice(0, 24) : layer.type === 'shape' ? '□  Forma' : '▧  ' + (layer.name || 'Imagem'); button.addEventListener('click', () => { editor.selected = layer.id; render(); }); item.append(button); layersEl.append(item); });
  }
  function render() { renderCanvas(); renderLayers(); renderProperties(); empty.hidden = editor.layers.length > 0; updateHistoryControls(); zoomEl.textContent = Math.round(editor.zoom * 100) + '%'; canvas.style.width = Math.round(editor.zoom * 100) + '%'; }
  function addLayer(layer) { remember(); layer.id = uid(); editor.layers.push(layer); editor.selected = layer.id; render(); }
  function addText() { addLayer({ type: 'text', text: 'SEU TÍTULO', x: canvas.width / 2, y: canvas.height * .72, fontSize: 108, weight: 800, color: '#ffffff', font: 'Nunito', align: 'center', opacity: 1 }); setStatus('Texto adicionado. Arraste ou edite no painel lateral.'); }
  function addShape() { addLayer({ type: 'shape', x: canvas.width / 2, y: canvas.height * .55, width: 760, height: 220, fill: '#9b4dff', stroke: '#cf7cff', strokeWidth: 5, opacity: .86 }); setStatus('Forma adicionada.'); }
  function addImage(file, name = file.name) { if (!file || !file.type.startsWith('image/')) { setStatus('Escolha uma imagem PNG, JPG ou WebP.', true); return; } const url = URL.createObjectURL(file); const image = new Image(); image.onload = () => { const scale = Math.min(canvas.width * .86 / image.naturalWidth, canvas.height * .72 / image.naturalHeight, 1); const layer = { type: 'image', name, x: canvas.width / 2, y: canvas.height * .42, width: image.naturalWidth * scale, height: image.naturalHeight * scale, opacity: 1 }; remember(); layer.id = uid(); editor.images.set(layer.id, image); editor.layers.push(layer); editor.selected = layer.id; render(); setStatus('Imagem adicionada. Ela continua somente no navegador.'); }; image.src = url; }
  canvas.addEventListener('pointerdown', event => { const point = pointFromEvent(event); const layer = [...editor.layers].reverse().find(item => hit(item, point)); editor.selected = layer?.id || null; if (layer) { editor.drag = { layer, point, moved: false, before: current() }; canvas.setPointerCapture?.(event.pointerId); } render(); });
  canvas.addEventListener('pointermove', event => { if (!editor.drag) return; const point = pointFromEvent(event); const dx = point.x - editor.drag.point.x; const dy = point.y - editor.drag.point.y; if (Math.abs(dx) + Math.abs(dy) > 2) editor.drag.moved = true; editor.drag.layer.x += dx; editor.drag.layer.y += dy; editor.drag.point = point; renderCanvas(); });
  canvas.addEventListener('pointerup', () => { if (editor.drag?.moved) { editor.history.push(editor.drag.before); editor.future = []; } editor.drag = null; render(); });
  document.getElementById('thumbnail-image').addEventListener('change', event => addImage(event.target.files?.[0]));
  document.getElementById('thumbnail-add-text').addEventListener('click', addText); document.getElementById('thumbnail-add-shape').addEventListener('click', addShape);
  document.getElementById('thumbnail-undo').addEventListener('click', () => { if (!editor.history.length) return; editor.future.push(current()); restore(editor.history.pop()); });
  document.getElementById('thumbnail-redo').addEventListener('click', () => { if (!editor.future.length) return; editor.history.push(current()); restore(editor.future.pop()); });
  document.getElementById('thumbnail-reset').addEventListener('click', () => { if (!editor.layers.length) return; remember(); editor.layers = []; editor.selected = null; render(); setStatus('Tela limpa.'); });
  document.getElementById('thumbnail-zoom-out').addEventListener('click', () => { editor.zoom = Math.max(.55, editor.zoom - .1); render(); }); document.getElementById('thumbnail-zoom-in').addEventListener('click', () => { editor.zoom = Math.min(1.5, editor.zoom + .1); render(); });
  document.getElementById('thumbnail-export').addEventListener('click', () => { renderCanvas(); canvas.toBlob(blob => { if (!blob) return; const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'thumbnail-zuefy.png'; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 60000); setStatus('PNG exportado para o seu dispositivo.'); }, 'image/png'); });
  document.addEventListener('keydown', event => { if (event.key === 'Delete' && editor.selected && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName || '')) { remember(); editor.layers = editor.layers.filter(layer => layer.id !== editor.selected); editor.selected = editor.layers.at(-1)?.id || null; render(); } });
  render(); return { addImage };
}

async function boot() {
  const $ = id => document.getElementById(id);
  const thumbnailEditor = initThumbnailEditor();
  const state = { client: null, session: null, job: null, stages: [], capabilities: [], dirty: new Set(), selected: new Set(), requests: new Set(), generation: 0, timer: null, busy: false, refreshing: false, authRejected: false, activeStage: 'roteiro', activeView: 'start' };
  const viewHashes = { start: 'start-heading', editor: 'editor-heading', import: 'import-heading', flow: 'flow-heading', artifacts: 'artifacts-heading' };
  function viewFromHash() {
    const hash = window.location.hash.slice(1);
    return Object.entries(viewHashes).find(([, id]) => id === hash)?.[0] || 'start';
  }
  function selectWorkflowView(view, replaceHash = true) {
    if (!Object.hasOwn(viewHashes, view)) view = 'start';
    state.activeView = view;
    for (const section of document.querySelectorAll('.workflow-section')) section.classList.toggle('is-active', section.dataset.workflowView === view);
    for (const link of document.querySelectorAll('.workflow-nav-item')) link.setAttribute('aria-current', String(link.dataset.workflowView === view));
    if (replaceHash && window.location.hash !== '#' + viewHashes[view]) history.replaceState(null, '', '#' + viewHashes[view]);
  }
  for (const link of document.querySelectorAll('.workflow-nav-item')) link.addEventListener('click', event => { event.preventDefault(); selectWorkflowView(link.dataset.workflowView); });
  window.addEventListener('hashchange', () => selectWorkflowView(viewFromHash(), false));
  selectWorkflowView(viewFromHash(), false);
  const cards = new Map();
  const attempts = new Map();
  const warnings = new Map();
  const importedBases = new Set();
  const runKey = () => JSON.stringify([state.session?.user?.id, state.job?.id]);
  const node = (tag, text, className) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = String(text); if (className) el.className = className; return el; };
  const notice = (text, error = false) => { $('notice').textContent = text; $('notice').dataset.error = String(error); };
  const path = () => '/api/workflow/jobs/' + encodeURIComponent(state.job.id);
  function cancel() { clearTimeout(state.timer); state.generation++; for (const controller of state.requests) controller.abort(); state.requests.clear(); }
  async function api(url, options = {}, publicRequest = false) {
    const { rawMime, timeoutMs = 30000, blob: wantsBlob, authRetry = false, ...request } = options;
    const controller = new AbortController(); state.requests.add(controller);
    const generation = state.generation;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = { Accept: 'application/json' };
      if (!publicRequest) {
        const { data, error } = await state.client.auth.getSession();
        if (error || !data.session) throw new Error('Entre novamente em /app para continuar.');
        headers.Authorization = 'Bearer ' + data.session.access_token;
      }
      if (request.body) headers['Content-Type'] = rawMime || 'application/json';
      let response = await fetch(url, { ...request, headers, signal: controller.signal, credentials: 'same-origin', redirect: 'error', cache: 'no-store' });
      // Renova uma vez a sessão expirada sem repetir a operação do usuário.
      let recoveredSession = false;
      if (response.status === 401 && !publicRequest && !authRetry && state.client) {
        const refreshed = await state.client.auth.refreshSession();
        if (!refreshed.error && refreshed.data.session?.access_token) {
          headers.Authorization = 'Bearer ' + refreshed.data.session.access_token;
          response = await fetch(url, { ...request, headers, signal: controller.signal, credentials: 'same-origin', redirect: 'error', cache: 'no-store' });
          recoveredSession = response.ok;
        }
      }
      if (response.status === 401 && !publicRequest && !recoveredSession) {
        // Uma rejeição 401 não deve destruir a sessão local do usuário.
        // O backend continua protegido; apenas bloqueamos novas consultas
        // até que a sessão seja recuperada manualmente no /app.
        state.authRejected = true;
        clearTimeout(state.timer);
        controls();
      }
      if (!response.ok) {
        let payload;
        try { payload = await response.json(); } catch { /* Non-JSON failure uses the HTTP fallback. */ }
        const error = new Error(apiErrorMessage(payload, response.status));
        error.status = response.status;
        throw error;
      }
      const result = wantsBlob ? await response.blob() : await response.json();
      if (generation !== state.generation) throw new DOMException('Consulta interrompida', 'AbortError');
      return result;
    } finally { clearTimeout(timeout); state.requests.delete(controller); }
  }
  function controls() {
    $('app').disabled = !state.session || state.authRejected;
    $('run').disabled = state.busy || !state.job || state.dirty.size > 0 || !state.selected.size;
    const unresolved = attempts.has(runKey());
    for (const kind of ['base', 'voice']) {
      const input = $('import-' + kind + '-file');
      const preserved = kind === 'base' ? importedBases.has(runKey()) : state.stages.some(stage => stage.name === 'voz' && stage.status === 'ready');
      const blocked = state.busy || unresolved || !state.job || state.dirty.size > 0 || preserved;
      input.disabled = blocked;
      $('import-' + kind).disabled = blocked || !input.files?.length;
    }
    $('save').disabled = state.busy || unresolved;
    $('master-run').disabled = state.busy || unresolved || !state.job || state.dirty.size > 0 || !state.selected.size;
    $('retry-run').hidden = !unresolved;
    $('retry-run').disabled = state.busy;
    $('run-warning').textContent = warnings.get(runKey()) || '';
    $('run-warning').hidden = !$('run-warning').textContent;
    $('new').disabled = state.busy;
    $('base_url').disabled = state.busy;
    $('dirty').textContent = state.dirty.size ? 'Alterações não salvas' : state.job ? 'Sem alterações locais' : 'Novo projeto';
    for (const [name, card] of cards) {
      const capability = state.capabilities.find(item => item.name === name);
      const stage = state.stages.find(item => item.name === name);
      const blocked = !capability || capability.available !== true;
      const active = ['queued', 'running'].includes(stage?.status);
      if (blocked || active) { state.selected.delete(name); card.check.checked = false; }
      card.check.disabled = blocked || state.busy || active;
      card.run.disabled = blocked || unresolved || state.busy || !state.job || state.dirty.size > 0 || ['queued', 'running'].includes(stage?.status);
    }
    $('run').disabled = unresolved || state.busy || !state.job || state.dirty.size > 0 || !state.selected.size;
  }
  function schedule() {
    clearTimeout(state.timer);
    if (!document.hidden && state.session && state.job && state.stages.some(stage => ['queued', 'running'].includes(stage.status))) state.timer = setTimeout(() => { if (state.busy) schedule(); else refreshJob().catch(report); }, 4000);
  }
  function report(error) { notice(error.name === 'AbortError' ? 'Consulta interrompida. Se havia uma ação em andamento, atualize o projeto para conferir o resultado antes de repetir.' : error.message, true); }
  async function action(fn) {
    if (state.busy) return;
    cancel();
    state.busy = true; controls();
    try { await fn(); } catch (error) { report(error); } finally { state.busy = false; controls(); schedule(); }
  }
  function renderStages(stages) {
    state.stages = Array.isArray(stages) ? stages : [];
    for (const [name, card] of cards) {
      const stage = state.stages.find(item => item.name === name);
      const status = Object.hasOwn(STATUS, stage?.status) ? stage.status : 'unknown';
      const capability = state.capabilities.find(item => item.name === name);
      card.root.dataset.status = status;
      card.badge.textContent = STATUS[status] + (stage?.revision != null ? ' · revisão ' + stage.revision : '');
      card.message.textContent = [capability?.reason || (capability?.available === true ? '' : 'Etapa indisponível.'), stage?.message || '', status === 'stale' ? 'A entrada ou seu hash mudou. Revise antes de executar novamente.' : ''].filter(Boolean).join(' ');
      const output = stage?.output?.data ?? stage?.output;
      card.output.textContent = output == null ? 'Sem saída registrada.' : typeof output === 'string' ? output : JSON.stringify(output, null, 2);
      card.copy.hidden = !['roteiro', 'titulos'].includes(name) || stage?.output == null;
      if (status === 'ready' && ['roteiro', 'titulos'].includes(name)) {
        const field = name === 'titulos' ? 'title' : 'script';
        const value = editorialText(stage.output, field);
        if (!state.dirty.has(field) && !$(field).value.trim() && value?.trim()) {
          $(field).value = value; state.dirty.add(field);
        }
      }
    }
    for (const [name, card] of cards) card.root.hidden = name !== state.activeStage;
    for (const tab of document.querySelectorAll('.stage-tab')) tab.setAttribute('aria-selected', String(tab.dataset.stage === state.activeStage));
    controls(); schedule();
  }
  function fill(job) {
    for (const field of FIELDS) if (!state.dirty.has(field)) $(field).value = field === 'links' ? (Array.isArray(job.links) ? job.links.join('\n') : '') : job[field] ?? '';
    if (!state.dirty.has('base_url')) $('base_url').value = job.base_url || '';
    $('base_url').readOnly = Boolean(state.job);
    $('save').textContent = state.job ? 'Salvar alterações' : 'Criar projeto';
    controls();
  }
  async function refreshJob() {
    if (!state.job || document.hidden || state.refreshing) return;
    state.refreshing = true;
    const generation = state.generation;
    try {
      const data = await api(path());
      if (generation !== state.generation) return;
      state.job = data.job; fill(data.job); renderStages(data.stages); renderArtifacts(data.artifacts || []);
      notice('Estado atualizado pelo servidor.');
    } finally { state.refreshing = false; schedule(); }
  }
  async function listJobs() {
    const data = await api('/api/workflow/jobs');
    $('jobs').replaceChildren();
    if (!data.jobs?.length) $('jobs').append(node('li', 'Nenhum projeto. Crie o primeiro para começar.'));
    for (const job of data.jobs || []) {
      const item = node('li'); item.dataset.jobId = job.id; item.draggable = true;
      const button = node('button', job.name || job.id); button.type = 'button'; button.title = 'Abrir projeto e arrastar para reorganizar';
      button.setAttribute('aria-current', String(state.job?.id === job.id));
      const date = new Date(job.created_at); if (!Number.isNaN(date.valueOf())) button.append(node('time', date.toLocaleString('pt-BR')));
      button.addEventListener('click', () => {
        if (state.suppressJobClick) { state.suppressJobClick = false; return; }
        if (state.busy) return;
        if (state.dirty.size) { notice('Salve as alterações antes de trocar de projeto.', true); return; }
        action(async () => { cancel(); resetImports(); state.job = job; state.selected.clear(); for (const card of cards.values()) card.check.checked = false; $('allow-paid').checked = false; $('allow-frame-upload').checked = false; await refreshJob(); await listJobs(); });
      });
      let pointerStart = null; let pointerDragging = false;
      const clearDropTargets = () => document.querySelectorAll('.jobs li.is-drop-target').forEach(el => el.classList.remove('is-drop-target'));
      const moveTo = targetId => action(async () => { await api('/api/workflow/jobs/' + encodeURIComponent(job.id) + '/order', { method: 'PATCH', body: JSON.stringify({ target_id: targetId, direction: 'down' }) }); await listJobs(); notice('Ordem da fila atualizada.'); });
      item.addEventListener('dragstart', event => { state.draggingJob = job.id; item.classList.add('is-dragging'); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', job.id); });
      item.addEventListener('dragend', () => { state.draggingJob = null; item.classList.remove('is-dragging'); clearDropTargets(); });
      item.addEventListener('dragover', event => { event.preventDefault(); if (state.draggingJob && state.draggingJob !== job.id) item.classList.add('is-drop-target'); });
      item.addEventListener('dragleave', event => { if (!item.contains(event.relatedTarget)) item.classList.remove('is-drop-target'); });
      item.addEventListener('drop', event => { event.preventDefault(); const dragged = event.dataTransfer.getData('text/plain') || state.draggingJob; clearDropTargets(); if (dragged && dragged !== job.id) action(async () => { await api('/api/workflow/jobs/' + encodeURIComponent(dragged) + '/order', { method: 'PATCH', body: JSON.stringify({ target_id: job.id, direction: 'down' }) }); await listJobs(); notice('Ordem da fila atualizada.'); }); });
      item.addEventListener('pointerdown', event => { if (event.button !== 0) return; pointerStart = {x:event.clientX,y:event.clientY}; pointerDragging = false; item.setPointerCapture?.(event.pointerId); });
      item.addEventListener('pointermove', event => { if (!pointerStart) return; if (!pointerDragging && Math.hypot(event.clientX-pointerStart.x,event.clientY-pointerStart.y) > 8) { pointerDragging = true; state.draggingJob = job.id; item.classList.add('is-dragging'); } if (!pointerDragging) return; const target = document.elementFromPoint(event.clientX,event.clientY)?.closest('.jobs li'); clearDropTargets(); if (target && target !== item) target.classList.add('is-drop-target'); });
      item.addEventListener('pointerup', event => { if (!pointerDragging) { pointerStart = null; return; } const target = document.elementFromPoint(event.clientX,event.clientY)?.closest('.jobs li'); const targetId = target?.dataset.jobId; pointerStart = null; pointerDragging = false; state.draggingJob = null; state.suppressJobClick = true; item.classList.remove('is-dragging'); clearDropTargets(); if (targetId && targetId !== job.id) moveTo(targetId); });
      item.append(button); $('jobs').append(item);
    }
  }
  function resetImports() {
    for (const kind of ['base', 'voice']) $('import-' + kind + '-file').value = '';
    $('import-status').textContent = 'Escolha um arquivo e use o botão correspondente. Os estados após o envio serão informados pelo servidor.';
  }
  async function importMedia(kind) {
    if (!state.job || state.dirty.size) throw new Error('Salve o projeto e todas as alterações antes de importar.');
    if (attempts.has(runKey())) throw new Error('Resolva a solicitação de execução anterior antes de importar.');
    if (kind === 'base' && importedBases.has(runKey())) throw new Error('O vídeo-base deste projeto já foi importado e não pode ser substituído.');
    if (kind === 'voice' && state.stages.some(stage => stage.name === 'voz' && stage.status === 'ready')) throw new Error('A voz já está pronta e será preservada.');
    const input = $('import-' + kind + '-file');
    const file = input.files?.[0];
    const rawMime = importMime(kind, file);
    const key = runKey();
    $('import-status').textContent = `Enviando somente ${file.name} para o armazenamento privado deste projeto…`;
    try {
      const data = await api(path() + '/import?kind=' + kind, { method: 'POST', body: file, rawMime, timeoutMs: 130000 });
      if (!data.job || !Array.isArray(data.stages) || !Array.isArray(data.artifacts)) throw new Error('Resposta de importação incompleta. Atualize o estado antes de tentar novamente.');
      if (kind === 'base') importedBases.add(key);
      input.value = '';
      state.job = data.job; fill(data.job); renderStages(data.stages); renderArtifacts(data.artifacts);
      $('import-status').textContent = 'Importação registrada pelo servidor. Confira os estados e arquivos abaixo; nenhuma etapa foi iniciada automaticamente.';
      notice('Importação registrada pelo servidor.');
    } catch (error) {
      $('import-status').textContent = error.status === 409
        ? 'O servidor recusou a importação (409). O vídeo-base é único e uma voz pronta é preservada. Atualize o estado do projeto. ' + error.message
        : 'Importação não confirmada. Atualize o estado do projeto antes de tentar novamente. Não há reenvio automático.';
      throw error;
    }
  }
  for (const kind of ['base', 'voice']) {
    $('import-' + kind + '-file').addEventListener('change', controls);
    $('import-' + kind).addEventListener('click', () => action(() => importMedia(kind)));
  }
  async function run(steps, individual = false) {
    if (!state.job || state.dirty.size) throw new Error('Salve o conteúdo antes de executar.');
    if (attempts.has(runKey())) throw new Error('Use o botão de reenviar a mesma solicitação para resolver a execução anterior.');
    if (!steps.length || steps.some(name => !state.capabilities.some(cap => cap.name === name && cap.available === true))) throw new Error('Escolha etapas disponíveis.');
    if (steps.some(name => state.stages.some(stage => stage.name === name && ['queued', 'running'].includes(stage.status)))) throw new Error('Uma etapa escolhida já está na fila ou em execução. Atualize o estado.');
    const body = { allow_paid: $('allow-paid').checked, allow_frame_upload: $('allow-frame-upload').checked };
    if (!individual) body.steps = steps;
    const endpoint = path() + (individual ? '/stages/' + encodeURIComponent(steps[0]) + '/run' : '/run');
    const attempt = pendingRun(attempts, runKey(), endpoint, body, () => crypto.randomUUID());
    await submitRun(runKey(), attempt);
  }
  async function submitRun(key, attempt) {
    // No automatic retry. A manual retry preserves ID, endpoint, steps and consents.
    try {
      const data = await api(attempt.endpoint, { method: 'POST', body: JSON.stringify(attempt.body) });
      if (!Array.isArray(data.stages)) throw new Error('Resposta sem estados de execução.');
      attempts.delete(key);
      const warning = typeof data.warning === 'string' ? data.warning : typeof data.warning?.message === 'string' ? data.warning.message : '';
      warnings.set(key, warning);
      if (key === runKey()) {
        renderStages(data.stages); notice(warning || 'Solicitação recebida. Consulte o estado de cada etapa.');
        $('allow-paid').checked = false; $('allow-frame-upload').checked = false;
      }
    } catch (error) {
      if (error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) {
        attempts.delete(key); warnings.set(key, error.message);
      } else {
        warnings.set(key, `Resultado incerto da solicitação ${attempt.body.request_id}. Atualize o estado ou use o botão abaixo para reenviar o mesmo pedido, com as etapas e autorizações originais. Não há repetição automática. Salvar fica bloqueado até obter a resposta.`);
      }
      throw error;
    }
  }
  function renderArtifacts(artifacts) {
    $('artifacts').replaceChildren();
    if (!artifacts.length) $('artifacts').append(node('li', 'Nenhum arquivo registrado neste projeto.'));
    for (const artifact of artifacts) {
      const item = node('li'); item.append(node('strong', artifact.name));
      item.append(node('p', `${artifact.mime || 'Tipo não informado'} · ${Number.isFinite(artifact.size) ? artifact.size.toLocaleString('pt-BR') + ' bytes' : 'Tamanho não informado'}`));
      const download = node('button', 'Baixar arquivo'); download.type = 'button';
      download.addEventListener('click', () => action(async () => {
        const blob = await api(path() + '/artifacts/' + encodeURIComponent(artifact.id), { blob: true });
        const href = URL.createObjectURL(blob); const anchor = node('a'); anchor.href = href;
        anchor.download = String(artifact.name || 'arquivo').replace(/[\\/\x00-\x1f]/g, '_');
        document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(href), 60000);
      })); item.append(download);
      if (thumbnailEditor && ['image/png', 'image/jpeg', 'image/webp'].includes(artifact.mime)) {
        const edit = node('button', 'Editar thumbnail'); edit.type = 'button';
        edit.addEventListener('click', () => action(async () => { const blob = await api(path() + '/artifacts/' + encodeURIComponent(artifact.id), { blob: true }); thumbnailEditor.addImage(new File([blob], artifact.name || 'imagem.png', { type: artifact.mime })); selectWorkflowView('artifacts'); notice('Imagem aberta no editor manual.'); })); item.append(edit);
      }
      if (artifact.mime === 'image/png' && /(?:^|[\/\\])frame_\d+\.png$/i.test(artifact.name)) {
        const lens = node('button', 'Autorizar este frame no Lens: ' + artifact.name); lens.type = 'button';
        lens.addEventListener('click', () => action(async () => {
          const data = await api(path() + '/lens/' + encodeURIComponent(artifact.id), { method: 'POST' });
          const anchor = node('a', 'Abrir pesquisa no Lens'); anchor.href = lensURL(data.url, data.expires_at); anchor.target = '_blank'; anchor.rel = 'noopener noreferrer';
          anchor.addEventListener('click', event => { try { lensURL(data.url, data.expires_at); } catch (error) { event.preventDefault(); report(error); } });
          item.append(anchor); item.append(node('p', 'Link expira em ' + new Date(data.expires_at).toLocaleString('pt-BR')));
        })); item.append(lens);
      }
      $('artifacts').append(item);
    }
  }
  for (const [name, label] of Object.entries(STAGES)) {
    const tab = node('button', label, 'stage-tab'); tab.type = 'button'; tab.dataset.stage = name; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', 'stage-panel-' + name); tab.setAttribute('aria-selected', String(name === state.activeStage));
    tab.addEventListener('click', () => { state.activeStage = name; renderStages(state.stages); }); $('stage-tabs').append(tab);
    const root = node('article', undefined, 'stage'); const wrapper = node('label'); const check = node('input'); check.type = 'checkbox';
    root.id = 'stage-panel-' + name; root.setAttribute('role', 'tabpanel'); root.tabIndex = 0;
    wrapper.append(check, node('span', label)); const explain = node('p', STAGE_HELP[name], 'stage-explain'); const badge = node('span', STATUS.unknown, 'badge'); const message = node('p');
    const details = node('details'); const output = node('pre'); details.append(node('summary', 'Ver saída'), output);
    const copy = node('button', name === 'titulos' ? 'Usar saída no título' : 'Usar saída no roteiro'); copy.type = 'button'; copy.hidden = true;
    copy.addEventListener('click', () => {
      const field = name === 'titulos' ? 'title' : 'script';
      if (state.dirty.has(field) || $(field).value.trim()) { notice('O editor já contém texto. A saída não substitui seu conteúdo; copie apenas o trecho desejado.', true); return; }
      const result = state.stages.find(stage => stage.name === name)?.output;
      const value = editorialText(result, field);
      if (typeof value !== 'string') { notice('Selecione e copie o texto desejado da saída para o editor.', true); return; }
      $(field).value = value; state.dirty.add(field); controls(); $(field).focus();
    });
    const runButton = node('button', 'Executar ' + label.toLowerCase()); runButton.type = 'button';
    runButton.addEventListener('click', () => action(() => run([name], true)));
    check.addEventListener('change', () => { check.checked ? state.selected.add(name) : state.selected.delete(name); controls(); });
    root.append(wrapper, explain, badge, message, details, copy, runButton); $('flow').append(root);
    cards.set(name, { root, check, badge, message, output, copy, run: runButton });
  }
  for (const field of [...FIELDS, 'base_url']) $(field).addEventListener('input', () => { state.dirty.add(field); controls(); });
  $('editor').addEventListener('submit', event => {
    event.preventDefault(); action(async () => {
      const creating = !state.job; const body = {}; const sent = new Map();
      if (attempts.has(runKey())) throw new Error('Resolva a solicitação de execução anterior antes de salvar alterações.');
      for (const field of FIELDS) if (creating || state.dirty.has(field)) { sent.set(field, $(field).value); body[field] = field === 'links' ? parseLinks($(field).value) : $(field).value; }
      if (!body.name?.trim() && (creating || state.dirty.has('name'))) throw new Error('Informe o nome do projeto.');
      validateFields(body);
      if (creating && $('base_url').value.trim()) body.base_url = officialURL($('base_url').value.trim());
      sent.set('base_url', $('base_url').value);
      const data = await api(creating ? '/api/workflow/jobs' : path(), { method: creating ? 'POST' : 'PATCH', body: JSON.stringify(body) });
      state.job = data.job;
      for (const [field, value] of sent) if ($(field).value === value) state.dirty.delete(field);
      fill(data.job); notice('Conteúdo salvo pelo servidor.'); await listJobs(); await refreshJob();
    });
  });
  $('master-run').addEventListener('click', () => { selectWorkflowView('flow'); return action(async () => {
    if (!state.job || state.dirty.size) throw new Error('Salve o projeto antes de analisar o link-base.');
    if (!state.selected.size) throw new Error('Selecione pelo menos uma etapa nos cartões abaixo.');
    await run([...state.selected], false);
  }); });
  $('new').addEventListener('click', () => {
    selectWorkflowView('editor');
    if (state.dirty.size) { notice('Salve as alterações antes de criar outro projeto.', true); return; }
    cancel(); resetImports(); state.job = null; state.selected.clear(); $('editor').reset(); $('allow-paid').checked = false; $('allow-frame-upload').checked = false;
    for (const card of cards.values()) card.check.checked = false;
    fill({}); renderStages([]); renderArtifacts([]); $('name').focus();
  });
  $('refresh').addEventListener('click', () => action(async () => { await listJobs(); await refreshJob(); }));
  $('run').addEventListener('click', () => action(() => run([...state.selected])));
  $('retry-run').addEventListener('click', () => action(async () => {
    const key = runKey(); const attempt = attempts.get(key);
    if (attempt) await submitRun(key, attempt);
  }));
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancel(); else if (state.session) refreshJob().catch(report); });
  window.addEventListener('pagehide', cancel);
  window.addEventListener('beforeunload', event => { if (state.dirty.size || attempts.size) { event.preventDefault(); event.returnValue = ''; } });
  renderStages([]);
  try {
    const config = publicConfig(await api('/api/config', {}, true));
    const { createClient } = await import(SUPABASE_CDN);
    // Default Supabase storage shares /app's session on this origin.
    state.client = createClient(config.url, config.key);
    const { data, error } = await state.client.auth.getSession(); if (error) throw new Error('Não foi possível recuperar sua sessão. Entre em /app.');
    state.session = data.session; state.authRejected = false; controls();
    state.client.auth.onAuthStateChange((event, session) => {
      state.session = session;
      if (!session) { state.authRejected = false; cancel(); resetImports(); state.job = null; state.dirty.clear(); $('editor').reset(); renderStages([]); renderArtifacts([]); $('jobs').replaceChildren(); notice('Entre no aplicativo para acessar seus projetos.'); }
      else if (event === 'SIGNED_IN') { state.authRejected = false; setTimeout(() => initialize().catch(report), 0); }
      controls();
    });
    if (state.session) await initialize(); else notice('Entre no aplicativo e volte a esta página para acessar seus projetos.');
  } catch (error) { report(error); }
  async function initialize() {
    const data = await api('/api/workflow/capabilities'); state.capabilities = data.stages || [];
    $('storage').textContent = data.storageReady === true ? 'Armazenamento disponível' : 'Armazenamento indisponível';
    renderStages(state.stages);
    if (data.storageReady !== true) {
      $('jobs').replaceChildren(node('li', 'Persistência indisponível no backend. Configure a conexão segura do Supabase no Render e atualize esta página.'));
      notice('Backend conectado, mas o armazenamento do workflow está indisponível. Nenhuma sessão foi encerrada.', true);
      return;
    }
    await listJobs(); notice('Escolha um projeto ou crie um novo.');
  }
}
if (typeof document !== 'undefined') boot();
