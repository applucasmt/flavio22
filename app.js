/* =============================================================
   MOLDURAS IA — Hugging Face Inference Providers
   Endpoint correto (2025): router.huggingface.co
   Modelo: FLUX.1-dev (schnell foi descontinuado)
   ============================================================= */

import {
  ImageSegmenter,
  FilesetResolver
} from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';

/* =============================================================
   CONFIG
   ============================================================= */
const SIZE = 1080;
const MAX_FRAMES = 50;

// ✅ Modelo válido (schnell foi descontinuado)
const HF_MODEL = 'black-forest-labs/FLUX.1-dev';
const HF_PROVIDER = 'fal-ai';  // Provedor que suporta text-to-image

// ✅ Endpoint correto (router novo)
const HF_API = 'https://router.huggingface.co/hf-inference/models/' + HF_MODEL;

const $ = id => document.getElementById(id);

/* =============================================================
   REFS
   ============================================================= */
const canvas = $('canvas');
const ctx = canvas.getContext('2d');
const stage = $('stage');
const emptyEl = $('empty');
const loadingEl = $('loading');
const loadingText = $('loadingText');
const progressBar = $('progressBar');
const zoomWrap = $('zoomWrap');
const zoomInput = $('zoom');
const zoomLabel = $('zoomLabel');
const framesEl = $('frames');
const toastEl = $('toast');

/* =============================================================
   STATE
   ============================================================= */
let photo = null;
let cutout = null;
let aiBackground = null;
let frameImg = null;
let frames = [];
let frameIdx = 0;

let zoom = 1, panX = 0, panY = 0;
let dragging = false, startX, startY, lastPanX, lastPanY;
let pinchStart = 0, pinchZoomStart = 1, pinchCX = 0, pinchCY = 0;

let cameraStream = null;
let segmenter = null;

let selectedPrompt = 'professional studio photography backdrop, empty blurred bokeh background, soft warm lighting, neutral gray colors, no people, no person, no face, ultra realistic, high quality';

/* =============================================================
   TOKEN
   ============================================================= */
function getToken() {
  return localStorage.getItem('hf_token') || '';
}
function setToken(t) {
  localStorage.setItem('hf_token', t);
}

/* =============================================================
   HELPERS
   ============================================================= */
function toast(msg, type = '') {
  toastEl.textContent = msg;
  toastEl.className = 'toast show ' + type;
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => toastEl.classList.remove('show'), 3500);
}

function loading(on, text = 'Processando...', pct = 0) {
  loadingText.textContent = text;
  loadingEl.classList.toggle('active', on);
  progressBar.style.width = (on ? pct : 0) + '%';
}

function setProgress(pct) {
  progressBar.style.width = pct + '%';
}

/* =============================================================
   IA — Hugging Face Inference
   ============================================================= */
async function generateBackground() {
  const token = getToken();
  if (!token) {
    openConfig();
    toast('Configure seu token do Hugging Face', 'info');
    return;
  }
  if (!photo && !cutout) {
    toast('Carregue uma foto primeiro', 'err');
    return;
  }

  loading(true, '🎨 IA gerando fundo... (20-40s)', 5);

  try {
    console.log('[AI] Modelo:', HF_MODEL);
    console.log('[AI] Provider:', HF_PROVIDER);
    console.log('[AI] API:', HF_API);
    console.log('[AI] Prompt:', selectedPrompt);

    let pct = 5;
    const interval = setInterval(() => {
      pct = Math.min(pct + 2, 90);
      setProgress(pct);
    }, 1000);

    // ✅ Chamada correta conforme documentação
    const response = await fetch(HF_API, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'x-use-cache': 'false'
      },
      body: JSON.stringify({
        inputs: selectedPrompt + ', high quality, 8k, professional, no people, empty background',
        parameters: {
          width: 1024,
          height: 1024,
          num_inference_steps: 25,
          guidance_scale: 7.5
        }
      })
    });

    clearInterval(interval);

    if (!response.ok) {
      let errMsg = 'Erro ' + response.status;

      if (response.status === 401) {
        errMsg = 'Token inválido. Reconfigure em ⚙️';
      } else if (response.status === 403) {
        errMsg = 'Token sem permissão. Crie token "Fine-grained" com permissão "Make calls to Inference Providers"';
      } else if (response.status === 404) {
        errMsg = 'Modelo não encontrado.';
      } else if (response.status === 410) {
        errMsg = 'Modelo descontinuado.';
      } else if (response.status === 503) {
        errMsg = 'Modelo carregando. Aguarde 20s e tente novamente.';
      } else if (response.status === 429) {
        errMsg = 'Muitas requisições. Aguarde 1 minuto.';
      } else {
        try {
          const errJson = await response.json();
          if (errJson.error) errMsg = errJson.error;
        } catch (e) {}
      }

      throw new Error(errMsg);
    }

    setProgress(95);

    const blob = await response.blob();
    console.log('[AI] Blob recebido:', blob.size, 'bytes');

    if (blob.size < 1000) {
      throw new Error('Resposta muito pequena — modelo pode estar carregando');
    }

    const img = new Image();
    img.crossOrigin = 'anonymous';

    await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      img.onload = () => { URL.revokeObjectURL(url); resolve(); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Erro ao carregar imagem')); };
      img.src = url;
    });

    aiBackground = img;
    setProgress(100);
    loading(false);
    render();
    toast('✨ Fundo gerado!', 'ok');

  } catch (err) {
    console.error('[AI] Erro:', err);
    loading(false);
    toast('Erro: ' + err.message, 'err');
  }
}

/* =============================================================
   DETECÇÃO DE MOLDURAS
   ============================================================= */
function frameUrl(i) {
  return 'frames/mold-' + String(i).padStart(2, '0') + '.png';
}

function testImage(url) {
  return new Promise(resolve => {
    const img = new Image();
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve(false); } }, 2500);
    img.onload = () => { if (!done) { done = true; clearTimeout(t); resolve(img.naturalWidth > 0); } };
    img.onerror = () => { if (!done) { done = true; clearTimeout(t); resolve(false); } };
    img.src = url;
  });
}

async function detectFrames() {
  const found = [];
  for (let i = 1; i <= MAX_FRAMES; i++) {
    const ok = await testImage(frameUrl(i));
    if (!ok) break;
    found.push(frameUrl(i));
  }
  return found;
}

async function initFrames(forceRefresh = false) {
  framesEl.innerHTML = '<div style="padding:20px;color:#8B93A1;font-size:12px">Detectando...</div>';

  let list = [];
  if (!forceRefresh) {
    try {
      const cached = JSON.parse(localStorage.getItem('frames_cache') || 'null');
      if (cached && Date.now() - cached.t < 3600000 && cached.list && cached.list.length) {
        list = cached.list;
        console.log('[Frames] Cache:', list.length);
      }
    } catch (e) {}
  }

  if (list.length === 0) {
    list = await detectFrames();
    console.log('[Frames] Detectadas:', list.length);
    try {
      localStorage.setItem('frames_cache', JSON.stringify({ list, t: Date.now() }));
    } catch (e) {}
  }

  frames = list;
  framesEl.innerHTML = '';

  if (frames.length === 0) {
    framesEl.innerHTML = '<div style="padding:20px;color:#8B93A1;font-size:12px">Nenhuma moldura em /frames/</div>';
    return;
  }

  frameIdx = frames.length - 1;

  frames.forEach((url, i) => {
    const el = document.createElement('div');
    el.className = 'frame' + (i === frameIdx ? ' active' : '');
    el.innerHTML = '<img src="' + url + '" alt="Moldura ' + (i + 1) + '"><span class="num">' + (i + 1) + '</span>';
    el.onclick = () => {
      document.querySelectorAll('.frame').forEach(f => f.classList.remove('active'));
      el.classList.add('active');
      frameIdx = i;
      loadFrame();
    };
    framesEl.appendChild(el);
  });

  loadFrame();
}

function loadFrame() {
  if (!frames[frameIdx]) return;
  frameImg = new Image();
  frameImg.crossOrigin = 'anonymous';
  frameImg.onload = () => {
    const ov = $('overlay');
    if (ov) ov.src = frameImg.src;
    render();
  };
  frameImg.src = frames[frameIdx];
}

/* =============================================================
   RENDER — Ordem: Fundo IA → Moldura (atrás) → Foto (frente)
   ============================================================= */
function render() {
  ctx.clearRect(0, 0, SIZE, SIZE);

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, SIZE, SIZE);

  if (aiBackground) {
    ctx.drawImage(aiBackground, 0, 0, SIZE, SIZE);
  }

  // Moldura ATRÁS
  if (frameImg && frameImg.complete && frameImg.naturalWidth > 0) {
    ctx.drawImage(frameImg, 0, 0, SIZE, SIZE);
  }

  // Foto NA FRENTE
  const imgToDraw = cutout || photo;
  if (imgToDraw) {
    const aspect = imgToDraw.width / imgToDraw.height;
    let dw, dh;
    if (aspect > 1) { dh = SIZE; dw = SIZE * aspect; }
    else { dw = SIZE; dh = SIZE / aspect; }
    const fw = dw * zoom;
    const fh = dh * zoom;
    const x = (SIZE - fw) / 2 + panX;
    const y = (SIZE - fh) / 2 + panY;

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, SIZE, SIZE);
    ctx.clip();
    ctx.drawImage(imgToDraw, x, y, fw, fh);
    ctx.restore();
  }

  const hasPhoto = !!(photo || cutout);
  emptyEl.style.display = hasPhoto ? 'none' : 'flex';
  zoomWrap.hidden = !hasPhoto;
  $('reset').hidden = !hasPhoto;
  $('cut').disabled = !hasPhoto;
  $('save').disabled = !hasPhoto;
  $('generateBg').disabled = !hasPhoto;
}

/* =============================================================
   CARREGAR FOTO
   ============================================================= */
function loadPhoto(file) {
  if (!file || !file.type.startsWith('image/')) {
    toast('Selecione uma imagem', 'err');
    return;
  }
  loading(true, 'Carregando...', 30);
  const reader = new FileReader();
  reader.onload = e => {
    const img = new Image();
    img.onload = () => {
      photo = img;
      cutout = null;
      aiBackground = null;
      zoom = 1; panX = 0; panY = 0;
      zoomInput.value = 1;
      zoomLabel.textContent = '100%';
      loading(false);
      render();
      toast('Foto carregada!', 'ok');
    };
    img.onerror = () => { loading(false); toast('Erro ao carregar', 'err'); };
    img.src = e.target.result;
  };
  reader.onerror = () => { loading(false); toast('Erro ao ler', 'err'); };
  reader.readAsDataURL(file);
}

/* =============================================================
   RECORTAR FUNDO
   ============================================================= */
async function initSegmenter() {
  if (segmenter) return segmenter;
  const vision = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
  );
  segmenter = await ImageSegmenter.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite',
      delegate: 'GPU'
    },
    runningMode: 'IMAGE',
    outputConfidenceMasks: true,
    outputCategoryMask: false
  });
  return segmenter;
}

async function removeBg() {
  const source = photo;
  if (!source) return;

  loading(true, 'Analisando...', 20);

  try {
    const seg = await initSegmenter();
    setProgress(40);

    const MAX = 1024;
    const s = Math.min(1, MAX / Math.max(source.width, source.height));
    const w = Math.round(source.width * s);
    const h = Math.round(source.height * s);

    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const octx = off.getContext('2d');
    octx.drawImage(source, 0, 0, w, h);

    loading(true, 'Removendo fundo...', 60);

    const result = await new Promise(res => seg.segment(off, res));
    const mask = result.confidenceMasks[0];
    const maskData = mask.getAsFloat32Array();
    const mw = mask.width, mh = mask.height;

    const imgData = octx.getImageData(0, 0, w, h);
    const data = imgData.data;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const mx = Math.floor(x / w * mw);
        const my = Math.floor(y / h * mh);
        let a = maskData[my * mw + mx] || 0;
        a = Math.max(0, Math.min(1, a));
        a = a * a * (3 - 2 * a);
        data[(y * w + x) * 4 + 3] = Math.round(data[(y * w + x) * 4 + 3] * a);
      }
    }

    octx.putImageData(imgData, 0, 0);
    setProgress(90);

    const newImg = new Image();
    newImg.onload = () => {
      cutout = newImg;
      photo = newImg;
      loading(false);
      render();
      toast('✨ Fundo removido!', 'ok');
    };
    newImg.onerror = () => { loading(false); toast('Erro no recorte', 'err'); };
    newImg.src = off.toDataURL('image/png');

  } catch (err) {
    console.error(err);
    loading(false);
    toast('Erro: ' + err.message, 'err');
  }
}

/* =============================================================
   CÂMERA
   ============================================================= */
function stopCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
  }
  $('video')?.remove();
  $('overlay')?.remove();
  $('capture')?.remove();
}

async function openCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('Câmera não suportada', 'err');
    return;
  }
  stopCamera();

  const video = document.createElement('video');
  video.id = 'video';
  video.setAttribute('playsinline', '');
  video.setAttribute('autoplay', '');
  video.muted = true;

  const overlay = document.createElement('img');
  overlay.id = 'overlay';
  if (frameImg) overlay.src = frameImg.src;

  stage.appendChild(video);
  stage.appendChild(overlay);

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1080 }, height: { ideal: 1080 } },
      audio: false
    });
    cameraStream = stream;
    video.srcObject = stream;

    await new Promise(res => { video.onloadedmetadata = () => { video.play().then(res).catch(res); }; });

    const btn = document.createElement('button');
    btn.id = 'capture';
    btn.className = 'btn btn-green';
    btn.style.cssText = 'position:absolute;bottom:16px;left:50%;transform:translateX(-50%);width:calc(100% - 32px);z-index:10';
    btn.textContent = '📸 Capturar';
    btn.onclick = () => {
      const tmp = document.createElement('canvas');
      tmp.width = tmp.height = SIZE;
      const tctx = tmp.getContext('2d');
      const sz = Math.min(video.videoWidth, video.videoHeight);
      const sx = (video.videoWidth - sz) / 2;
      const sy = (video.videoHeight - sz) / 2;
      tctx.drawImage(video, sx, sy, sz, sz, 0, 0, SIZE, SIZE);

      const img = new Image();
      img.onload = () => {
        stopCamera();
        photo = img;
        cutout = null;
        aiBackground = null;
        zoom = 1; panX = 0; panY = 0;
        zoomInput.value = 1;
        zoomLabel.textContent = '100%';
        render();
        toast('Foto capturada!', 'ok');
      };
      img.src = tmp.toDataURL('image/png');
    };
    stage.appendChild(btn);

  } catch (err) {
    toast('Erro ao acessar câmera', 'err');
    stopCamera();
  }
}

/* =============================================================
   SALVAR
   ============================================================= */
async function saveImage() {
  if (!photo && !cutout) return;
  const btn = $('save');
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '⏳ Processando...';

  try {
    const blob = await new Promise(res => canvas.toBlob(res, 'image/png', 1.0));
    const fileName = 'moldura_' + Date.now() + '.png';
    const file = new File([blob], fileName, { type: 'image/png' });

    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

    if (isMobile && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'Minha Foto' });
        toast('Compartilhado!', 'ok');
      } catch (err) {
        if (err.name !== 'AbortError') download(blob, fileName);
      }
    } else {
      download(blob, fileName);
    }
  } catch (err) {
    toast('Erro ao salvar', 'err');
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 200);
    toast('Imagem salva!', 'ok');
  }
}

/* =============================================================
   CONFIG MODAL
   ============================================================= */
function openConfig() {
  const modal = $('configModal');
  const input = $('hfToken');
  input.value = getToken();
  modal.classList.add('active');
  setTimeout(() => input.focus(), 100);
}

function closeConfig() {
  $('configModal').classList.remove('active');
}

/* =============================================================
   GESTOS
   ============================================================= */
stage.addEventListener('touchstart', e => {
  if (!photo && !cutout) return;
  const t = e.touches;
  if (t.length === 1) {
    dragging = true;
    startX = t[0].clientX;
    startY = t[0].clientY;
    lastPanX = panX;
    lastPanY = panY;
  } else if (t.length === 2) {
    dragging = false;
    pinchStart = Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    pinchZoomStart = zoom;
    const r = stage.getBoundingClientRect();
    pinchCX = ((t[0].clientX + t[1].clientX) / 2 - r.left) * (SIZE / r.width) - SIZE / 2;
    pinchCY = ((t[0].clientY + t[1].clientY) / 2 - r.top) * (SIZE / r.height) - SIZE / 2;
  }
}, { passive: true });

stage.addEventListener('touchmove', e => {
  if (!photo && !cutout) return;
  const t = e.touches;
  const r = stage.getBoundingClientRect();
  const sx = SIZE / r.width;
  const sy = SIZE / r.height;

  if (t.length === 1 && dragging) {
    panX = lastPanX + (t[0].clientX - startX) * sx;
    panY = lastPanY + (t[0].clientY - startY) * sy;
    render();
  } else if (t.length === 2) {
    const d = Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const scale = d / pinchStart;
    const newZoom = Math.min(Math.max(pinchZoomStart * scale, 0.5), 4);
    const dz = newZoom - pinchZoomStart;
    panX -= dz * pinchCX;
    panY -= dz * pinchCY;
    zoom = newZoom;
    zoomInput.value = zoom;
    zoomLabel.textContent = Math.round(zoom * 100) + '%';
    render();
  }
}, { passive: true });

stage.addEventListener('touchend', () => { dragging = false; });

let mouseDown = false;
stage.addEventListener('mousedown', e => {
  if (!photo && !cutout) return;
  mouseDown = true;
  startX = e.clientX;
  startY = e.clientY;
  lastPanX = panX;
  lastPanY = panY;
});
window.addEventListener('mousemove', e => {
  if (!mouseDown || (!photo && !cutout)) return;
  const r = stage.getBoundingClientRect();
  panX = lastPanX + (e.clientX - startX) * (SIZE / r.width);
  panY = lastPanY + (e.clientY - startY) * (SIZE / r.height);
  render();
});
window.addEventListener('mouseup', () => { mouseDown = false; });

stage.addEventListener('wheel', e => {
  if (!photo && !cutout) return;
  e.preventDefault();
  const delta = e.deltaY > 0 ? -0.08 : 0.08;
  zoom = Math.min(Math.max(zoom + delta, 0.5), 4);
  zoomInput.value = zoom;
  zoomLabel.textContent = Math.round(zoom * 100) + '%';
  render();
}, { passive: false });

zoomInput.addEventListener('input', e => {
  zoom = parseFloat(e.target.value);
  zoomLabel.textContent = Math.round(zoom * 100) + '%';
  render();
});

['dragenter', 'dragover'].forEach(ev => {
  stage.addEventListener(ev, e => { e.preventDefault(); });
});
stage.addEventListener('drop', e => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (file) loadPhoto(file);
});

/* =============================================================
   PRESETS
   ============================================================= */
const PRESETS = {
  studio: 'professional studio photography backdrop, empty blurred bokeh background, soft warm lighting, neutral gray colors, no people, no person, no face, no silhouette, ultra realistic, high quality',
  park: 'outdoor park with trees, blurred green foliage bokeh background, natural daylight, warm golden hour lighting, no people, no person, no face, empty scene, ultra realistic',
  office: 'modern office interior, softly blurred background, professional corporate atmosphere, warm lighting, no people, no person, no face, empty room, ultra realistic',
  gradient: 'minimalist gradient background, soft pastel colors, clean aesthetic, blurred, no people, no person, no face, ultra realistic',
  neutral: 'elegant studio backdrop, soft neutral gray, professional photography, blurred vignette, no people, no person, no face, empty background, ultra realistic',
  beach: 'tropical beach at sunset, blurred ocean waves, warm golden lighting, palm trees bokeh, no people, no person, no face, empty scene, ultra realistic'
};

document.querySelectorAll('.preset').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.preset').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    const key = btn.dataset.preset || 'studio';
    selectedPrompt = PRESETS[key] || PRESETS.studio;
    console.log('[AI] Preset:', key);
  });
});

/* =============================================================
   BOTÕES
   ============================================================= */
$('file').addEventListener('change', function() {
  if (this.files?.[0]) loadPhoto(this.files[0]);
});

$('camera').addEventListener('click', openCamera);
$('cut').addEventListener('click', removeBg);
$('save').addEventListener('click', saveImage);
$('generateBg').addEventListener('click', generateBackground);
$('configAI').addEventListener('click', openConfig);
$('closeConfig').addEventListener('click', closeConfig);
$('saveConfig').addEventListener('click', () => {
  const t = $('hfToken').value.trim();
  if (!t.startsWith('hf_')) {
    toast('Token deve começar com "hf_"', 'err');
    return;
  }
  setToken(t);
  closeConfig();
  toast('✅ Token salvo!', 'ok');
});

$('configModal').addEventListener('click', e => {
  if (e.target === $('configModal')) closeConfig();
});

$('reset').addEventListener('click', () => {
  stopCamera();
  photo = null;
  cutout = null;
  aiBackground = null;
  zoom = 1; panX = 0; panY = 0;
  $('file').value = '';
  render();
  toast('Foto removida', 'info');
});

$('refresh').addEventListener('click', async () => {
  toast('🔄 Buscando novas molduras...', 'info');
  await initFrames(true);
  toast('✨ ' + frames.length + ' molduras encontradas', 'ok');
});

/* =============================================================
   SERVICE WORKER
   ============================================================= */
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

/* =============================================================
   BOOT
   ============================================================= */
initFrames();
render();

if (!getToken()) {
  setTimeout(() => {
    toast('💡 Configure seu token HF em ⚙️ para usar a IA', 'info');
  }, 2000);
}
