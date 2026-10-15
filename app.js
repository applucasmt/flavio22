/* =============================================================
   MOLDURAS IA — App completo em um arquivo
   
   IA de geração: Pollinations.ai modo kontext
   - Aceita imagem de referência
   - Preserva identidade
   - Sem CORS, sem token, grátis
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
const AI_PROMPT = 'Professional close-up portrait photograph, maintaining rigorously the same identity, face, expression and physical characteristics of the person in the reference image. Outdoor setting with softly blurred background (bokeh), natural warm lighting, ultra-realistic, 8k professional photography, shoulder-up framing.';

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
let frameImg = null;
let frames = [];
let frameIdx = 0;

let zoom = 1, panX = 0, panY = 0;
let dragging = false, startX, startY, lastPanX, lastPanY;
let pinchStart = 0, pinchZoomStart = 1, pinchCX = 0, pinchCY = 0;

let cameraStream = null;
let segmenter = null;

/* =============================================================
   HELPERS
   ============================================================= */
function toast(msg, type = '') {
  toastEl.textContent = msg;
  toastEl.className = 'toast show ' + type;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.remove('show'), 3000);
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
   DETECÇÃO DE MOLDURAS
   ============================================================= */
function frameUrl(i) {
  return 'frames/mold-' + String(i).padStart(2, '0') + '.png';
}

function testImage(url) {
  return new Promise(resolve => {
    const img = new Image();
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve(false); } }, 3000);
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
   RENDER — Moldura ATRÁS, foto NA FRENTE
   ============================================================= */
function render() {
  ctx.clearRect(0, 0, SIZE, SIZE);
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, SIZE, SIZE);

  // 1. Foto
  if (photo) {
    const aspect = photo.width / photo.height;
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
    ctx.drawImage(photo, x, y, fw, fh);
    ctx.restore();
  }

  // 2. Moldura por cima
  if (frameImg && frameImg.complete && frameImg.naturalWidth > 0) {
    ctx.drawImage(frameImg, 0, 0, SIZE, SIZE);
  }

  // UI
  emptyEl.style.display = photo ? 'none' : 'flex';
  zoomWrap.hidden = !photo;
  $('reset').hidden = !photo;
  $('cut').disabled = !photo;
  $('save').disabled = !photo;
  $('generate').disabled = !photo;
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
   IA DE GERAÇÃO (Pollinations kontext - preserva identidade)
   ============================================================= */
async function generateWithAI() {
  if (!photo) return;

  loading(true, 'Preparando...', 10);

  try {
    // 1. Redimensiona a foto para envio (máx 512px, economiza tempo)
    const MAX = 512;
    const s = Math.min(1, MAX / Math.max(photo.width, photo.height));
    const w = Math.round(photo.width * s);
    const h = Math.round(photo.height * s);

    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    off.getContext('2d').drawImage(photo, 0, 0, w, h);
    const dataUrl = off.toDataURL('image/jpeg', 0.85);

    loading(true, 'Enviando imagem...', 25);

    // 2. Faz upload para a Pollinations (aceita data URL direto via POST)
    // A Pollinations suporta envio via POST em /upload
    const uploadRes = await fetch('https://image.pollinations.ai/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: dataUrl })
    });

    let imageUrl = dataUrl; // fallback: usar data URL direto

    if (uploadRes.ok) {
      try {
        const uploadData = await uploadRes.json();
        if (uploadData.url) {
          imageUrl = uploadData.url;
          console.log('[AI] Upload OK:', imageUrl);
        }
      } catch (e) {
        console.log('[AI] Upload falhou, usando dataURL direto');
      }
    }

    loading(true, '🎨 IA gerando... (30-60s)', 40);

    // 3. Monta URL da Pollinations com modo kontext (image-to-image)
    const encodedPrompt = encodeURIComponent(AI_PROMPT);
    const seed = Math.floor(Math.random() * 1000000);
    const aiUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}` +
                  `?model=kontext&image=${encodeURIComponent(imageUrl)}` +
                  `&width=1024&height=1024&seed=${seed}&nologo=true`;

    console.log('[AI] URL:', aiUrl);

    // Simula progresso
    let pct = 40;
    const progressInterval = setInterval(() => {
      pct = Math.min(pct + 2, 90);
      setProgress(pct);
    }, 1500);

    // 4. Carrega resultado
    const newImg = await new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      const timeout = setTimeout(() => reject(new Error('Timeout na geração')), 120000);
      img.onload = () => { clearTimeout(timeout); resolve(img); };
      img.onerror = () => { clearTimeout(timeout); reject(new Error('Falha na geração')); };
      img.src = aiUrl;
    });

    clearInterval(progressInterval);
    setProgress(100);

    // 5. Aplica resultado
    photo = newImg;
    zoom = 1; panX = 0; panY = 0;
    zoomInput.value = 1;
    zoomLabel.textContent = '100%';

    loading(false);
    render();
    toast('✨ Imagem gerada com IA!', 'ok');

  } catch (err) {
    console.error('[AI] Erro:', err);
    loading(false);
    toast('Erro na IA: ' + err.message, 'err');
  }
}

/* =============================================================
   RECORTAR FUNDO (MediaPipe)
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
  if (!photo) return;
  loading(true, 'Analisando...', 20);

  try {
    const seg = await initSegmenter();
    setProgress(40);

    const MAX = 1024;
    const s = Math.min(1, MAX / Math.max(photo.width, photo.height));
    const w = Math.round(photo.width * s);
    const h = Math.round(photo.height * s);

    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const octx = off.getContext('2d');
    octx.drawImage(photo, 0, 0, w, h);

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
   SALVAR / COMPARTILHAR
   ============================================================= */
async function saveImage() {
  if (!photo) return;
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
        toast('Compartilhado!
