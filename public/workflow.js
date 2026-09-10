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
  const editor = { pages: [[]], pageIndex: 0, selected: null, history: [], future: [], zoom: 1, drag: null, images: new Map(), clipboard: null, pageClipboard: null, pageAccent: '#151027', pageComment: '', guides: { horizontal: [], vertical: [], visible: true, locked: false } };
  Object.defineProperty(editor, 'layers', { get: () => editor.pages[editor.pageIndex], set: value => { editor.pages[editor.pageIndex] = value; } });
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
  function selectedLayer() { return editor.layers.find(item => item.id === editor.selected) || null; }
  function cloneLayer(layer) { const result = copy(layer); result.id = uid(); return result; }
  function copySelectedLayer() { const layer = selectedLayer(); if (!layer) { setStatus('Selecione uma camada para copiar.'); return; } editor.clipboard = copy(layer); setStatus('Camada copiada localmente.'); }
  function pasteLayer() { if (!editor.clipboard) { setStatus('Nenhuma camada copiada.'); return; } remember(); const layer = copy(editor.clipboard); layer.id = uid(); layer.x += 28; layer.y += 28; editor.layers.push(layer); if (layer.type === 'image' && editor.images.has(editor.clipboard.id)) editor.images.set(layer.id, editor.images.get(editor.clipboard.id)); editor.selected = layer.id; render(); setStatus('Camada colada.'); }
  function duplicateLayer() { const layer = selectedLayer(); if (!layer) { setStatus('Selecione uma camada para duplicar.'); return; } remember(); const duplicate = cloneLayer(layer); duplicate.x += 28; duplicate.y += 28; editor.layers.push(duplicate); if (layer.type === 'image' && editor.images.has(layer.id)) editor.images.set(duplicate.id, editor.images.get(layer.id)); editor.selected = duplicate.id; render(); setStatus('Camada duplicada.'); }
  function deleteLayer() { const layer = selectedLayer(); if (!layer) return; remember(); editor.layers = editor.layers.filter(item => item.id !== layer.id); editor.selected = editor.layers.at(-1)?.id || null; render(); setStatus('Camada excluída.'); }
  function alignLayer(alignment) { const layer = selectedLayer(); if (!layer) return; remember(); if (alignment === 'left') layer.x = layer.width / 2; if (alignment === 'center-x') layer.x = canvas.width / 2; if (alignment === 'right') layer.x = canvas.width - layer.width / 2; if (alignment === 'top') layer.y = layer.height / 2; if (alignment === 'center-y') layer.y = canvas.height / 2; if (alignment === 'bottom') layer.y = canvas.height - layer.height / 2; render(); setStatus('Camada alinhada à página.'); }
  function toggleLayerLock() { const layer = selectedLayer(); if (!layer) return; remember(); layer.locked = !layer.locked; render(); setStatus(layer.locked ? 'Camada bloqueada.' : 'Camada desbloqueada.'); }
  function objectAction(action) { if (action === 'copy-layer') copySelectedLayer(); if (action === 'paste-layer') pasteLayer(); if (action === 'duplicate-layer') duplicateLayer(); if (action === 'delete-layer') deleteLayer(); if (action === 'lock-layer') toggleLayerLock(); if (action === 'align-menu') { closeMenus(); document.getElementById('thumbnail-align-menu').hidden = false; return; } const layer = selectedLayer(); if (!layer) return; if (action === 'component-layer') { layer.component = !layer.component; render(); setStatus(layer.component ? 'Componente local criado.' : 'Componente local desfeito.'); } if (action === 'link-layer') { const link = window.prompt('Link local da camada (opcional):', layer.link || ''); if (link !== null) { layer.link = link.trim(); setStatus(layer.link ? 'Link associado localmente.' : 'Link removido.'); } } if (action === 'comment-layer') { const comment = window.prompt('Comentário local da camada:', layer.comment || ''); if (comment !== null) { layer.comment = comment.trim(); setStatus('Comentário salvo localmente.'); } } if (action === 'hide-duration') { layer.durationHidden = !layer.durationHidden; render(); setStatus(layer.durationHidden ? 'Duração do elemento ocultada.' : 'Duração do elemento exibida.'); } if (action === 'alt-layer') { const alt = window.prompt('Texto alternativo:', layer.alt || ''); if (alt !== null) { layer.alt = alt.trim(); setStatus('Texto alternativo salvo localmente.'); } } if (action === 'background-layer' && layer.type === 'image') { remember(); layer.x = canvas.width / 2; layer.y = canvas.height / 2; layer.width = canvas.width; layer.height = canvas.height; editor.layers = [layer, ...editor.layers.filter(item => item.id !== layer.id)]; render(); setStatus('Imagem definida como plano de fundo.'); } if (action === 'apply-page-colors') { editor.pageAccent = layer.fill || '#9b4dff'; render(); setStatus('Cores da camada aplicadas à página.'); } if (action === 'download-layer') { exportThumbnail('image/png'); } if (action === 'info-layer') setStatus(`${layer.type === 'image' ? 'Imagem' : layer.type === 'text' ? 'Texto' : 'Forma'} · ${Math.round(layer.width || 0)}×${Math.round(layer.height || 0)} px`); }
  function closeMenus() { for (const id of ['thumbnail-context-menu', 'thumbnail-align-menu', 'thumbnail-page-menu']) document.getElementById(id).hidden = true; document.getElementById('thumbnail-page-actions').setAttribute('aria-expanded', 'false'); }
  function renderPages() { const pages = document.getElementById('thumbnail-pages'); if (!pages) return; pages.replaceChildren(); editor.pages.forEach((_, index) => { const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Página ' + (index + 1); button.className = index === editor.pageIndex ? 'is-active' : ''; button.addEventListener('click', () => { editor.pageIndex = index; editor.selected = null; editor.history = []; editor.future = []; render(); }); pages.append(button); }); }
  function addPage(duplicate = false) { const source = duplicate ? editor.layers : []; const layers = source.map(layer => { const result = cloneLayer(layer); if (layer.type === 'image' && editor.images.has(layer.id)) editor.images.set(result.id, editor.images.get(layer.id)); return result; }); editor.pages.push(layers); editor.pageIndex = editor.pages.length - 1; editor.selected = layers.at(-1)?.id || null; editor.history = []; editor.future = []; render(); setStatus(duplicate ? 'Página duplicada.' : 'Página adicionada.'); }
  function pageAction(action) { if (action === 'add') addPage(); if (action === 'duplicate') addPage(true); if (action === 'copy') { editor.pageClipboard = copy(editor.layers); setStatus('Página copiada localmente.'); } if (action === 'copy-style') { editor.pageStyleClipboard = { accent: editor.pageAccent }; setStatus('Estilo da página copiado localmente.'); } if (action === 'paste') { if (!editor.pageClipboard) setStatus('Nenhuma página copiada.'); else { const layers = editor.pageClipboard.map(layer => { const result = cloneLayer(layer); if (layer.type === 'image' && editor.images.has(layer.id)) editor.images.set(result.id, editor.images.get(layer.id)); return result; }); editor.pages.push(layers); editor.pageIndex = editor.pages.length - 1; editor.selected = layers.at(-1)?.id || null; editor.history = []; editor.future = []; render(); setStatus('Página colada.'); } } if (action === 'comment') { const comment = window.prompt('Comentário local da página:', editor.pageComment); if (comment !== null) { editor.pageComment = comment.trim(); setStatus('Comentário da página salvo localmente.'); } } if (action === 'guide-horizontal') { if (!editor.guides.locked) { editor.guides.horizontal.push(canvas.height / 2); render(); setStatus('Guia horizontal adicionada.'); } } if (action === 'guide-vertical') { if (!editor.guides.locked) { editor.guides.vertical.push(canvas.width / 2); render(); setStatus('Guia vertical adicionada.'); } } if (action === 'toggle-guides') { editor.guides.visible = !editor.guides.visible; render(); setStatus(editor.guides.visible ? 'Guias exibidas.' : 'Guias ocultadas.'); } if (action === 'lock-guides') { editor.guides.locked = !editor.guides.locked; setStatus(editor.guides.locked ? 'Guias bloqueadas.' : 'Guias desbloqueadas.'); } if (action === 'edit-video') setStatus('Edição como vídeo permanece disponível como referência local.'); if (action === 'info') setStatus(`Página ${editor.pageIndex + 1} · ${editor.layers.length} camadas · 1080×1920 px`); closeMenus(); }
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
    ctx.strokeRect(-width / 2, -height / 2, width, height); ctx.setLineDash([]);
    if (layer.type !== 'text') {
      ctx.fillStyle = '#f1ecff'; ctx.strokeStyle = '#9b4dff'; ctx.lineWidth = 3;
      for (const [x, y] of [[-width / 2, -height / 2], [0, -height / 2], [width / 2, -height / 2], [width / 2, 0], [width / 2, height / 2], [0, height / 2], [-width / 2, height / 2], [-width / 2, 0]]) { ctx.fillRect(x - 13, y - 13, 26, 26); ctx.strokeRect(x - 13, y - 13, 26, 26); }
    }
    ctx.restore();
  }
  function renderCanvas() {
    const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height); gradient.addColorStop(0, editor.pageAccent || '#151027'); gradient.addColorStop(.55, '#080914'); gradient.addColorStop(1, '#05050b'); ctx.fillStyle = gradient; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.save(); ctx.globalAlpha = .12; ctx.strokeStyle = '#9b4dff'; ctx.lineWidth = 2; for (let x = 0; x < canvas.width; x += 90) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke(); } for (let y = 0; y < canvas.height; y += 90) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke(); } ctx.restore();
    if (editor.guides.visible) { ctx.save(); ctx.strokeStyle = '#34d399'; ctx.lineWidth = 3; ctx.setLineDash([14, 10]); editor.guides.horizontal.forEach(y => { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke(); }); editor.guides.vertical.forEach(x => { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke(); }); ctx.restore(); }
    editor.layers.forEach(drawLayer); drawSelection(editor.layers.find(layer => layer.id === editor.selected));
  }
  function hit(layer, point) {
    const width = layer.type === 'text' ? Math.max(220, ctx.measureText(layer.text || '').width + 36) : layer.width; const height = layer.type === 'text' ? layer.fontSize * 1.4 : layer.height;
    return point.x >= layer.x - width / 2 && point.x <= layer.x + width / 2 && point.y >= layer.y - height / 2 && point.y <= layer.y + height / 2;
  }
  function resizeHandle(layer, point) {
    if (!layer || layer.type === 'text') return false;
    const halfWidth = layer.width / 2; const halfHeight = layer.height / 2;
    const handles = { nw: [-halfWidth, -halfHeight], n: [0, -halfHeight], ne: [halfWidth, -halfHeight], e: [halfWidth, 0], se: [halfWidth, halfHeight], s: [0, halfHeight], sw: [-halfWidth, halfHeight], w: [-halfWidth, 0] };
    let nearest = false; let distance = Infinity;
    for (const [name, [x, y]] of Object.entries(handles)) { const currentDistance = Math.hypot(point.x - (layer.x + x), point.y - (layer.y + y)); if (currentDistance < distance) { nearest = name; distance = currentDistance; } }
    return distance <= 36 ? nearest : false;
  }
  function pointFromEvent(event) { const rect = canvas.getBoundingClientRect(); return { x: (event.clientX - rect.left) * canvas.width / rect.width, y: (event.clientY - rect.top) * canvas.height / rect.height }; }
  function setLayerValue(layer, property, value) { remember(); layer[property] = value; render(); }
  function field(label, type, value, onInput, attrs = {}) { const wrapper = document.createElement('label'); wrapper.className = 'thumbnail-field'; const title = document.createElement('span'); title.textContent = label; const input = document.createElement('input'); input.type = type; input.value = value; Object.entries(attrs).forEach(([key, val]) => input.setAttribute(key, val)); input.addEventListener('input', () => onInput(input.value)); wrapper.append(title, input); return wrapper; }
  function selectField(label, value, options, onChange) { const wrapper = document.createElement('label'); wrapper.className = 'thumbnail-field'; const title = document.createElement('span'); title.textContent = label; const select = document.createElement('select'); options.forEach(option => { const item = document.createElement('option'); item.value = option; item.textContent = option; item.style.fontFamily = option; item.selected = option === value; select.append(item); }); select.value = options.includes(value) ? value : options[0]; select.style.fontFamily = select.value; select.addEventListener('change', () => { select.style.fontFamily = select.value; onChange(select.value); }); wrapper.append(title, select); return wrapper; }
  function renderProperties() {
    propertiesEl.replaceChildren(); const layer = editor.layers.find(item => item.id === editor.selected); if (!layer) { propertiesEl.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: 'Selecione uma camada para editar posição, cor e tamanho.' })); return; }
    const title = document.createElement('div'); title.className = 'thumbnail-selected-title'; title.textContent = layer.type === 'text' ? 'Texto selecionado' : layer.type === 'shape' ? 'Forma selecionada' : 'Imagem selecionada'; propertiesEl.append(title);
    const position = document.createElement('div'); position.className = 'thumbnail-field-grid'; position.append(field('X', 'number', Math.round(layer.x), value => setLayerValue(layer, 'x', Number(value)), { min: 0, max: canvas.width }), field('Y', 'number', Math.round(layer.y), value => setLayerValue(layer, 'y', Number(value)), { min: 0, max: canvas.height })); propertiesEl.append(position);
    if (layer.type === 'text') { propertiesEl.append(field('Texto', 'text', layer.text, value => setLayerValue(layer, 'text', value)), selectField('Fonte', layer.font || 'Nunito', ['Nunito', 'Bebas Neue', 'JetBrains Mono', 'Arial', 'Georgia', 'Verdana', 'Trebuchet MS', 'Courier New', 'Impact'], value => setLayerValue(layer, 'font', value)), field('Tamanho', 'number', layer.fontSize, value => setLayerValue(layer, 'fontSize', Math.max(12, Number(value))), { min: 12, max: 420 }), field('Cor', 'color', layer.color, value => setLayerValue(layer, 'color', value))); }
    if (layer.type === 'shape') propertiesEl.append(field('Cor', 'color', layer.fill, value => setLayerValue(layer, 'fill', value)), field('Largura', 'number', layer.width, value => setLayerValue(layer, 'width', Math.max(20, Number(value))), { min: 20, max: canvas.width }), field('Altura', 'number', layer.height, value => setLayerValue(layer, 'height', Math.max(20, Number(value))), { min: 20, max: canvas.height }));
    if (layer.type === 'image') propertiesEl.append(field('Largura', 'number', Math.round(layer.width), value => setLayerValue(layer, 'width', Math.max(40, Number(value))), { min: 40, max: canvas.width }), field('Altura', 'number', Math.round(layer.height), value => setLayerValue(layer, 'height', Math.max(40, Number(value))), { min: 40, max: canvas.height }));
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'thumbnail-delete'; remove.textContent = 'Excluir camada'; remove.addEventListener('click', () => { remember(); editor.layers = editor.layers.filter(item => item.id !== layer.id); editor.selected = editor.layers.at(-1)?.id || null; render(); }); propertiesEl.append(remove);
  }
  function renderLayers() {
    layersEl.replaceChildren(); countEl.textContent = String(editor.layers.length); [...editor.layers].reverse().forEach(layer => { const item = document.createElement('li'); const button = document.createElement('button'); button.type = 'button'; button.className = layer.id === editor.selected ? 'is-selected' : ''; button.textContent = layer.type === 'text' ? 'T  ' + (layer.text || 'Texto').slice(0, 24) : layer.type === 'shape' ? '□  Forma' : '▧  ' + (layer.name || 'Imagem'); button.addEventListener('click', () => { editor.selected = layer.id; render(); }); item.append(button); layersEl.append(item); });
  }
  function render() { renderCanvas(); renderLayers(); renderProperties(); renderPages(); empty.hidden = editor.layers.length > 0; updateHistoryControls(); zoomEl.textContent = Math.round(editor.zoom * 100) + '%'; const topZoom = document.getElementById('thumbnail-zoom-value-top'); if (topZoom) topZoom.textContent = Math.round(editor.zoom * 100) + '%'; const layer = selectedLayer(); const selection = document.getElementById('thumbnail-selection-label'); if (selection) selection.textContent = layer ? (layer.type === 'text' ? 'Texto selecionado' : layer.type === 'shape' ? 'Forma selecionada' : 'Imagem selecionada') : 'Nenhuma camada selecionada'; for (const id of ['thumbnail-copy-layer', 'thumbnail-duplicate-layer', 'thumbnail-delete-layer', 'thumbnail-more-actions']) document.getElementById(id).disabled = !layer; const lock = document.getElementById('thumbnail-lock-layer'); lock.disabled = !layer; lock.title = layer?.locked ? 'Desbloquear camada' : 'Bloquear camada'; lock.textContent = layer?.locked ? '♙' : '♙'; canvas.style.width = Math.round(editor.zoom * 100) + '%'; }
  function addLayer(layer) { remember(); layer.id = uid(); editor.layers.push(layer); editor.selected = layer.id; render(); }
  function addText() { addLayer({ type: 'text', text: 'SEU TÍTULO', x: canvas.width / 2, y: canvas.height * .72, fontSize: 108, weight: 800, color: '#ffffff', font: 'Nunito', align: 'center', opacity: 1 }); setStatus('Texto adicionado. Arraste ou edite no painel lateral.'); }
  function addShape() { addLayer({ type: 'shape', x: canvas.width / 2, y: canvas.height * .55, width: 760, height: 220, fill: '#9b4dff', stroke: '#cf7cff', strokeWidth: 5, opacity: .86 }); setStatus('Forma adicionada.'); }
  function addLine() { addLayer({ type: 'shape', x: canvas.width / 2, y: canvas.height * .55, width: 760, height: 18, fill: '#cf7cff', stroke: '#cf7cff', strokeWidth: 2, opacity: .92 }); setStatus('Linha adicionada.'); }
  function addImage(file, name = file.name) { if (!file || !file.type.startsWith('image/')) { setStatus('Escolha uma imagem PNG, JPG ou WebP.'); return; } const url = URL.createObjectURL(file); const image = new Image(); image.onload = () => { const scale = Math.min(canvas.width * .86 / image.naturalWidth, canvas.height * .72 / image.naturalHeight, 1); const layer = { type: 'image', name, x: canvas.width / 2, y: canvas.height * .42, width: image.naturalWidth * scale, height: image.naturalHeight * scale, opacity: 1 }; remember(); layer.id = uid(); editor.images.set(layer.id, image); editor.layers.push(layer); editor.selected = layer.id; render(); setStatus('Imagem adicionada localmente. Nada foi enviado ao servidor.'); URL.revokeObjectURL(url); }; image.onerror = () => { URL.revokeObjectURL(url); setStatus('Não foi possível abrir essa imagem.'); }; image.src = url; }
  canvas.addEventListener('pointerdown', event => { const point = pointFromEvent(event); const layer = [...editor.layers].reverse().find(item => hit(item, point)); editor.selected = layer?.id || null; if (layer && !layer.locked) { const resizing = resizeHandle(layer, point); editor.drag = { layer, point, startPoint: point, moved: false, type: resizing ? 'resize' : 'move', handle: resizing, before: current(), startX: layer.x, startY: layer.y, startWidth: layer.width, startHeight: layer.height }; canvas.setPointerCapture?.(event.pointerId); if (resizing) setStatus('Arraste qualquer alça para ajustar largura e altura com o mouse.'); } else if (layer?.locked) setStatus('Camada bloqueada. Desbloqueie para mover ou redimensionar.'); render(); });
  canvas.addEventListener('pointermove', event => { const point = pointFromEvent(event); if (!editor.drag) { const layer = [...editor.layers].reverse().find(item => hit(item, point)); const handle = resizeHandle(layer, point); canvas.style.cursor = handle ? (handle.length === 1 ? (handle === 'n' || handle === 's' ? 'ns-resize' : 'ew-resize') : `${handle.includes('n') ? 'n' : 's'}${handle.includes('w') ? 'w' : 'e'}-resize`) : layer ? 'move' : 'crosshair'; return; } const dx = point.x - editor.drag.point.x; const dy = point.y - editor.drag.point.y; const totalDx = point.x - editor.drag.startPoint.x; const totalDy = point.y - editor.drag.startPoint.y; if (Math.abs(dx) + Math.abs(dy) > 2) editor.drag.moved = true; if (editor.drag.type === 'resize') { const layer = editor.drag.layer; const handle = editor.drag.handle; const horizontal = handle.includes('e') || handle.includes('w'); const vertical = handle.includes('n') || handle.includes('s'); const fromLeft = handle.includes('w'); const fromTop = handle.includes('n'); if (horizontal) layer.width = Math.max(20, editor.drag.startWidth + (fromLeft ? -totalDx : totalDx)); if (vertical) layer.height = Math.max(20, editor.drag.startHeight + (fromTop ? -totalDy : totalDy)); const widthDelta = layer.width - editor.drag.startWidth; const heightDelta = layer.height - editor.drag.startHeight; if (horizontal) layer.x = editor.drag.startX + (fromLeft ? -widthDelta / 2 : widthDelta / 2); if (vertical) layer.y = editor.drag.startY + (fromTop ? -heightDelta / 2 : heightDelta / 2); } else { editor.drag.layer.x += dx; editor.drag.layer.y += dy; } editor.drag.point = point; renderCanvas(); });
  canvas.addEventListener('pointerup', () => { if (editor.drag?.moved) { editor.history.push(editor.drag.before); editor.future = []; } editor.drag = null; render(); });
  document.getElementById('thumbnail-image').addEventListener('change', event => addImage(event.target.files?.[0]));
  document.getElementById('thumbnail-add-text').addEventListener('click', addText); document.getElementById('thumbnail-add-shape').addEventListener('click', addShape);
  document.getElementById('thumbnail-tool-select').addEventListener('click', event => { event.currentTarget.classList.add('is-active'); setStatus('Modo seleção ativo. Arraste uma camada ou a alça do canto para ampliar.'); });
  document.getElementById('thumbnail-tool-image').addEventListener('click', () => document.getElementById('thumbnail-image').click());
  document.getElementById('thumbnail-tool-shape').addEventListener('click', addShape);
  document.getElementById('thumbnail-tool-line').addEventListener('click', addLine);
  document.getElementById('thumbnail-tool-text').addEventListener('click', addText);
  document.getElementById('thumbnail-undo').addEventListener('click', () => { if (!editor.history.length) return; editor.future.push(current()); restore(editor.history.pop()); });
  document.getElementById('thumbnail-redo').addEventListener('click', () => { if (!editor.future.length) return; editor.history.push(current()); restore(editor.future.pop()); });
  document.getElementById('thumbnail-reset').addEventListener('click', () => { if (!editor.layers.length) return; remember(); editor.layers = []; editor.selected = null; render(); setStatus('Tela limpa.'); });
  const zoomOut = () => { editor.zoom = Math.max(.55, editor.zoom - .1); render(); }; const zoomIn = () => { editor.zoom = Math.min(1.5, editor.zoom + .1); render(); };
  document.getElementById('thumbnail-zoom-out').addEventListener('click', zoomOut); document.getElementById('thumbnail-zoom-in').addEventListener('click', zoomIn); document.getElementById('thumbnail-zoom-out-top').addEventListener('click', zoomOut); document.getElementById('thumbnail-zoom-in-top').addEventListener('click', zoomIn);
  function exportThumbnail(format) { renderCanvas(); const extension = format === 'image/jpeg' ? 'jpg' : 'png'; canvas.toBlob(blob => { if (!blob) { setStatus('Não foi possível exportar a imagem.'); return; } const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'thumbnail-zuefy.' + extension; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 60000); setStatus(extension === 'jpg' ? 'JPEG exportado para o seu dispositivo.' : 'PNG exportado para o seu dispositivo.'); }, format, format === 'image/jpeg' ? .92 : undefined); }
  document.getElementById('thumbnail-export').addEventListener('click', () => exportThumbnail('image/png')); document.getElementById('thumbnail-export-jpeg').addEventListener('click', () => exportThumbnail('image/jpeg'));
  document.getElementById('thumbnail-copy-layer').addEventListener('click', () => objectAction('copy-layer'));
  document.getElementById('thumbnail-duplicate-layer').addEventListener('click', () => objectAction('duplicate-layer'));
  document.getElementById('thumbnail-lock-layer').addEventListener('click', () => objectAction('lock-layer'));
  document.getElementById('thumbnail-delete-layer').addEventListener('click', () => objectAction('delete-layer'));
  document.getElementById('thumbnail-more-actions').addEventListener('click', () => { closeMenus(); document.getElementById('thumbnail-context-menu').hidden = false; });
  document.querySelectorAll('[data-thumbnail-action]').forEach(button => button.addEventListener('click', () => { objectAction(button.dataset.thumbnailAction); if (button.dataset.thumbnailAction !== 'align-menu') closeMenus(); }));
  document.querySelectorAll('[data-align]').forEach(button => button.addEventListener('click', () => { alignLayer(button.dataset.align); closeMenus(); }));
  document.getElementById('thumbnail-add-page').addEventListener('click', () => addPage());
  document.getElementById('thumbnail-page-actions').addEventListener('click', () => { closeMenus(); document.getElementById('thumbnail-page-menu').hidden = false; document.getElementById('thumbnail-page-actions').setAttribute('aria-expanded', 'true'); });
  document.querySelectorAll('[data-page-action]').forEach(button => button.addEventListener('click', () => pageAction(button.dataset.pageAction)));
  canvas.addEventListener('contextmenu', event => { event.preventDefault(); closeMenus(); const menu = selectedLayer() ? document.getElementById('thumbnail-context-menu') : document.getElementById('thumbnail-page-menu'); menu.hidden = false; if (menu.id === 'thumbnail-page-menu') document.getElementById('thumbnail-page-actions').setAttribute('aria-expanded', 'true'); });
  document.addEventListener('pointerdown', event => { if (!event.target.closest('.thumbnail-floating-menu,.thumbnail-object-actions,#thumbnail-page-actions')) closeMenus(); });
  document.addEventListener('keydown', event => { if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '')) return; const key = event.key.toLowerCase(); if (event.ctrlKey && key === 'c') { event.preventDefault(); if (selectedLayer()) copySelectedLayer(); else pageAction('copy'); } else if (event.ctrlKey && key === 'v') { event.preventDefault(); if (selectedLayer() || editor.clipboard) pasteLayer(); else pageAction('paste'); } else if (event.ctrlKey && key === 'd') { event.preventDefault(); if (selectedLayer()) duplicateLayer(); else addPage(true); } else if (event.ctrlKey && event.key === 'Enter') { event.preventDefault(); addPage(); } else if (event.key === 'Delete' && editor.selected) { event.preventDefault(); deleteLayer(); } });
  render(); return { addImage };
}

async function boot() {
  const $ = id => document.getElementById(id);
  const localPreview = window.location.protocol === 'file:' || ['localhost', '127.0.0.1'].includes(window.location.hostname);
  const thumbnailEditor = initThumbnailEditor();
  const state = { client: null, session: null, job: null, stages: [], capabilities: [], dirty: new Set(), selected: new Set(), requests: new Set(), generation: 0, timer: null, busy: false, refreshing: false, authRejected: false, activeStage: 'roteiro', activeView: 'start' };
  const viewHashes = { start: 'start-heading', editor: 'editor-heading', editorial: 'editorial-heading', downloads: 'downloads-heading', import: 'import-heading', flow: 'flow-heading', artifacts: 'artifacts-heading' };
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
    const backendLocked = !state.session || state.authRejected;
    $('app').dataset.backendLocked = String(backendLocked);
    const unresolved = attempts.has(runKey());
    for (const kind of ['base', 'voice']) {
      const input = $('import-' + kind + '-file');
      const preserved = kind === 'base' ? importedBases.has(runKey()) : state.stages.some(stage => stage.name === 'voz' && stage.status === 'ready');
      const blocked = state.busy || unresolved || preserved;
      input.disabled = blocked;
      const button = $('import-' + kind);
      button.disabled = blocked || !input.files?.length;
      button.title = state.job ? (state.dirty.size ? 'Salve as alterações do projeto antes de importar.' : '') : 'Selecione ou crie um projeto e salve-o antes de importar.';
    }
    $('refresh').disabled = (!localPreview && backendLocked) || state.busy;
    const blockingDirty = [...state.dirty].some(field => field !== 'base_url');
    $('master-run').disabled = state.busy || unresolved || !state.selected.size || (!localPreview && (!state.job || blockingDirty));
    $('retry-run').hidden = !unresolved;
    $('retry-run').disabled = state.busy;
    $('run-warning').textContent = warnings.get(runKey()) || '';
    $('run-warning').hidden = !$('run-warning').textContent;
    $('new').disabled = state.busy;
    $('base_url').disabled = state.busy;
    for (const name of ['roteiro', 'titulos', 'seo']) {
      const button = $('editorial-run-' + name);
      if (!button) continue;
      const capability = state.capabilities.find(item => item.name === name);
      const stage = state.stages.find(item => item.name === name);
      button.disabled = state.busy || unresolved || (!localPreview && (!state.job || state.dirty.size > 0)) || ['queued', 'running'].includes(stage?.status);
      button.title = capability?.available === true ? '' : (capability?.reason || 'A autorização/configuração desta etapa ainda está pendente.');
    }
    syncStartStageOptions();
    syncDownloadControls();
  }
  function syncStartStageOptions() {
    const container = $('start-stage-options');
    if (!container) return;
    for (const option of container.querySelectorAll('label[data-stage]')) {
      const name = option.dataset.stage;
      const input = option.querySelector('input');
      const capability = state.capabilities.find(item => item.name === name);
      const stage = state.stages.find(item => item.name === name);
      input.checked = state.selected.has(name);
      const active = ['queued', 'running'].includes(stage?.status);
      const available = localPreview || capability?.available === true;
      input.disabled = state.busy || active;
      option.classList.toggle('is-unavailable', !available);
      option.title = available ? '' : (capability?.reason || 'Etapa indisponível no servidor. A seleção será mantida para quando a configuração estiver pronta.');
    }
  }
  function downloadEntries() {
    const input = $('download-links');
    if (!input) return [];
    return input.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(raw => {
      try { return { raw, url: officialURL(raw), error: '' }; } catch (error) { return { raw, url: '', error: error.message }; }
    });
  }
  function renderDownloadCandidates() {
    const list = $('download-candidates');
    if (!list) return;
    list.replaceChildren();
    const entries = downloadEntries();
    if (!entries.length) { list.append(node('p', 'Os links colados aparecerão aqui para uma ação individual.', 'hint')); return; }
    for (const [index, entry] of entries.entries()) {
      const row = node('article', undefined, 'download-candidate');
      const meta = node('div', undefined, 'download-candidate-meta');
      meta.append(node('strong', `Vídeo ${index + 1}`), node('span', entry.error || entry.url));
      const button = node('button', entry.error ? 'Link inválido' : 'Baixar vídeo'); button.type = 'button'; button.dataset.downloadUrl = entry.url; button.disabled = Boolean(entry.error);
      if (!entry.error) button.addEventListener('click', () => action(() => downloadVideo(entry.url, button)));
      row.append(meta, button); list.append(row);
    }
    syncDownloadControls();
  }
  function syncDownloadControls() {
    const consent = $('download-consent');
    const localBlocked = window.location.protocol === 'file:' || ['localhost', '127.0.0.1'].includes(window.location.hostname);
    const canRequest = !localBlocked && Boolean(state.session) && !state.authRejected && !state.busy;
    const enabled = Boolean(consent?.checked) && canRequest;
    for (const button of document.querySelectorAll('#download-candidates button[data-download-url]')) button.disabled = !enabled;
    const hasValidEntries = downloadEntries().some(entry => !entry.error);
    const downloadAll = $('download-all');
    downloadAll.disabled = !canRequest;
    downloadAll.title = localBlocked ? 'Downloads ficam disponíveis somente no endereço publicado.' : !state.session ? 'Entre no aplicativo antes de baixar.' : !hasValidEntries ? 'Cole pelo menos um link oficial válido.' : !consent?.checked ? 'Marque a autorização para baixar.' : '';
    const status = $('download-status');
    if (status && localBlocked) status.textContent = 'Prévia local: abra o endereço publicado para habilitar downloads autenticados.';
    else if (status && !state.session) status.textContent = 'Entre no aplicativo para habilitar downloads autenticados.';
    else if (status && !hasValidEntries) status.textContent = 'Cole pelo menos um link oficial válido para começar.';
    else if (status && !consent?.checked) status.textContent = 'Marque a confirmação para autorizar o download.';
    else if (status && canRequest) status.textContent = 'Pronto: clique em “Baixar vídeos” ou use uma ação individual.';
  }
  async function downloadVideo(url, button) {
    if (window.location.protocol === 'file:' || ['localhost', '127.0.0.1'].includes(window.location.hostname)) throw new Error('Downloads ficam disponíveis somente no endereço publicado.');
    if (!state.session) throw new Error('Entre no aplicativo antes de baixar um vídeo.');
    const quality = $('download-quality').value;
    button.textContent = 'Preparando…';
    $('download-status').textContent = 'Download solicitado manualmente. A mídia será entregue pelo servidor autenticado.';
    try {
      const query = new URLSearchParams({ url, mode: 'auto', quality });
      const blob = await api('/api/video-dl?' + query.toString(), { blob: true, timeoutMs: 180000 });
      const href = URL.createObjectURL(blob); const anchor = node('a'); anchor.href = href; anchor.download = 'video-zuefy-' + quality + '.mp4'; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(href), 60000);
      $('download-status').textContent = 'Download concluído. O arquivo foi enviado para o seu dispositivo.';
    } catch (error) {
      $('download-status').textContent = error.message;
      throw error;
    } finally { button.textContent = 'Baixar vídeo'; }
  }
  $('download-all').addEventListener('click', () => action(async () => {
    if (!$('download-consent').checked) throw new Error('Marque a confirmação de autorização antes de baixar.');
    const entries = downloadEntries().filter(entry => !entry.error);
    if (!entries.length) throw new Error('Cole pelo menos um link oficial válido antes de baixar.');
    const buttons = [...document.querySelectorAll('#download-candidates button[data-download-url]')];
    for (const [index, entry] of entries.entries()) {
      $('download-status').textContent = `Baixando vídeo ${index + 1} de ${entries.length}…`;
      const button = buttons.find(candidate => candidate.dataset.downloadUrl === entry.url);
      await downloadVideo(entry.url, button || $('download-all'));
    }
    $('download-status').textContent = `${entries.length} download${entries.length === 1 ? '' : 's'} concluído${entries.length === 1 ? '' : 's'}.`;
  }));
  function renderStartStageOptions() {
    const container = $('start-stage-options');
    if (!container || container.children.length) return;
    for (const [name, label] of Object.entries(STAGES)) {
      const option = document.createElement('label'); option.dataset.stage = name; option.setAttribute('aria-label', label);
      const input = document.createElement('input'); input.type = 'checkbox'; input.addEventListener('change', () => {
        input.checked ? state.selected.add(name) : state.selected.delete(name);
        controls();
      });
      option.append(input, document.createTextNode(label)); container.append(option);
    }
    syncStartStageOptions();
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
      if (['roteiro', 'titulos', 'seo'].includes(name)) {
        const editorialOutput = $('editorial-output-' + name); const editorialStatus = $('editorial-status-' + name);
        if (editorialOutput) editorialOutput.textContent = stage?.output == null ? (stage?.message || 'Sem saída registrada.') : typeof output === 'string' ? output : JSON.stringify(output, null, 2);
        if (editorialStatus) editorialStatus.textContent = capability?.available === true ? STATUS[status] : 'Indisponível';
      }
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
    $('base_url').readOnly = false;
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
      const item = node('li'); item.className = 'job-row'; item.dataset.jobId = job.id; item.draggable = true;
      const button = node('button', job.name || job.id); button.type = 'button'; button.className = 'job-open'; button.title = 'Abrir projeto e arrastar para reorganizar';
      button.setAttribute('aria-current', String(state.job?.id === job.id));
      const date = new Date(job.created_at); if (!Number.isNaN(date.valueOf())) button.append(node('time', date.toLocaleString('pt-BR')));
      button.addEventListener('click', () => {
        if (state.suppressJobClick) { state.suppressJobClick = false; return; }
        if (state.busy) return;
        if (state.dirty.size) { notice('Salve as alterações antes de trocar de projeto.', true); return; }
        action(async () => { cancel(); resetImports(); state.job = job; state.selected.clear(); $('allow-paid').checked = false; $('allow-frame-upload').checked = false; await refreshJob(); await listJobs(); });
      });
      const remove = node('button', '×'); remove.type = 'button'; remove.className = 'job-delete'; remove.title = 'Excluir projeto'; remove.setAttribute('aria-label', 'Excluir projeto ' + (job.name || job.id));
      const stopDrag = event => event.stopPropagation();
      remove.addEventListener('pointerdown', stopDrag);
      remove.addEventListener('click', event => {
        event.preventDefault(); event.stopPropagation();
        if (state.busy || !window.confirm(`Excluir o projeto “${job.name || job.id}”? Esta ação não pode ser desfeita.`)) return;
        action(async () => {
          await api('/api/workflow/jobs/' + encodeURIComponent(job.id), { method: 'DELETE' });
          if (state.job?.id === job.id) clearProjectSelection();
          await listJobs(); notice('Projeto excluído.');
        });
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
      item.append(button, remove); $('jobs').append(item);
    }
  }
  function clearProjectSelection() {
    cancel(); state.job = null; state.stages = []; state.dirty.clear(); state.selected.clear(); resetImports(); $('editor').reset();
    $('allow-paid').checked = false; $('allow-frame-upload').checked = false;
    renderStages([]); renderArtifacts([]); selectWorkflowView('start');
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
  async function executeStage(name) {
    if (localPreview) {
      state.activeStage = name;
      renderStages([{ name, status: 'pending', message: 'Etapa selecionada para execução local.' }]);
      selectWorkflowView('flow'); notice('Prévia local: etapa selecionada. O endereço publicado executa a etapa no servidor.');
      return;
    }
    await run([name], true);
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
    const root = node('article', undefined, 'stage');
    root.id = 'stage-panel-' + name; root.setAttribute('role', 'tabpanel'); root.tabIndex = 0;
    const heading = node('h3', label, 'stage-name'); const explain = node('p', STAGE_HELP[name], 'stage-explain'); const badge = node('span', STATUS.unknown, 'badge'); const message = node('p');
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
    root.append(heading, explain, badge, message, details, copy); $('flow').append(root);
    cards.set(name, { root, badge, message, output, copy });
  }
  renderStartStageOptions();
  $('download-links').addEventListener('input', renderDownloadCandidates);
  $('download-quality').addEventListener('change', controls);
  $('download-consent').addEventListener('change', controls);
  $('download-clear').addEventListener('click', () => { $('download-links').value = ''; renderDownloadCandidates(); $('download-links').focus(); });
  renderDownloadCandidates();
  for (const field of [...FIELDS, 'base_url']) $(field).addEventListener('input', () => { state.dirty.add(field); controls(); });
  $('editor').addEventListener('submit', event => {
    event.preventDefault(); action(async () => {
      const creating = !state.job; const body = {}; const sent = new Map();
      if (attempts.has(runKey())) throw new Error('Resolva a solicitação de execução anterior antes de salvar alterações.');
      for (const field of FIELDS) if (creating || state.dirty.has(field)) { sent.set(field, $(field).value); body[field] = field === 'links' ? parseLinks($(field).value) : $(field).value; }
      if (!body.name?.trim() && (creating || state.dirty.has('name'))) throw new Error('Informe o nome do projeto.');
      validateFields(body);
      if (creating || state.dirty.has('base_url')) body.base_url = $('base_url').value.trim() ? officialURL($('base_url').value.trim()) : '';
      sent.set('base_url', $('base_url').value);
      const data = await api(creating ? '/api/workflow/jobs' : path(), { method: creating ? 'POST' : 'PATCH', body: JSON.stringify(body) });
      state.job = data.job;
      for (const [field, value] of sent) if ($(field).value === value) state.dirty.delete(field);
      fill(data.job); notice('Conteúdo salvo pelo servidor.'); await listJobs(); await refreshJob();
    });
  });
  async function prepareAnalysis() {
    if (!state.job) throw new Error('Crie ou selecione um projeto antes de analisar o link-base.');
    const blockingDirty = [...state.dirty].filter(field => field !== 'base_url');
    if (blockingDirty.length) throw new Error('Salve as alterações do conteúdo antes de analisar o link-base.');
    const raw = $('base_url').value.trim();
    if (!raw) throw new Error('Cole um link oficial de YouTube, TikTok, Instagram ou Facebook.');
    const canonical = officialURL(raw);
    if (canonical !== (state.job.base_url || '')) {
      const data = await api(path(), { method: 'PATCH', body: JSON.stringify({ base_url: canonical }) });
      state.job = data.job; state.dirty.delete('base_url'); fill(data.job);
    } else state.dirty.delete('base_url');
  }
  $('master-run').addEventListener('click', () => {
    if (localPreview) {
      const selected = [...state.selected];
      state.activeStage = selected[0] || 'roteiro';
      renderStages(selected.map(name => ({ name, status: 'pending', message: 'Etapa selecionada para execução.' })));
      selectWorkflowView('flow');
      return;
    }
    selectWorkflowView('flow'); return action(async () => { await prepareAnalysis(); await run([...state.selected], false); });
  });
  for (const name of ['roteiro', 'titulos', 'seo']) $('editorial-run-' + name).addEventListener('click', () => action(() => executeStage(name)));
  function startNewProject(name, channel) {
    selectWorkflowView('editor');
    cancel(); resetImports(); state.job = null; state.dirty.clear(); state.selected.clear(); $('editor').reset(); $('allow-paid').checked = false; $('allow-frame-upload').checked = false;
    fill({ name, channel }); renderStages([]); renderArtifacts([]); $('name').focus();
  }
  const newProjectDialog = $('new-project-dialog');
  const newProjectForm = $('new-project-form');
  $('new-project-cancel').addEventListener('click', () => newProjectDialog.close('cancel'));
  newProjectForm.addEventListener('submit', event => {
    event.preventDefault();
    const name = $('new-project-name').value.trim(); const channel = $('new-project-channel').value.trim();
    newProjectDialog.close('confirm'); startNewProject(name, channel);
  });
  $('new').addEventListener('click', () => {
    if (state.dirty.size) { notice('Salve as alterações antes de criar outro projeto.', true); return; }
    newProjectForm.reset(); newProjectDialog.showModal(); $('new-project-name').focus();
  });
  $('refresh').addEventListener('click', () => {
    if (localPreview) { window.location.reload(); return; }
    action(async () => { await listJobs(); await refreshJob(); });
  });
  $('retry-run').addEventListener('click', () => action(async () => {
    const key = runKey(); const attempt = attempts.get(key);
    if (attempt) await submitRun(key, attempt);
  }));
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancel(); else if (state.session) refreshJob().catch(report); });
  window.addEventListener('pagehide', cancel);
  window.addEventListener('beforeunload', event => { if (state.dirty.size || attempts.size) { event.preventDefault(); event.returnValue = ''; } });
  renderStages([]);
  if (localPreview) {
    $('notice').hidden = true;
    $('master-run').textContent = 'Ver etapas selecionadas →';
    return;
  }
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
