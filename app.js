/* =========================================================================
   AURÉ · Probador Virtual — motor 3D
   - Face Landmarker (MediaPipe Tasks Vision) entrega, por frame, una matriz
     de transformación facial (posición + rotación + escala de la cabeza)
     pensada específicamente para anclar contenido 3D como anteojos.
   - Esa matriz se aplica directo a un grupo de Three.js; el lente (un plano
     con la textura PNG recortada) cuelga de ese grupo con un offset de
     calibración por modelo. Resultado: perspectiva real al girar la cabeza,
     sin tener que simular el giro "a mano" (squash) como en la v1.
   ========================================================================= */

import * as THREE from 'three';
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

/* -------------------------------------------------------------------------
   0) CATÁLOGO DE MODELOS
   Cada producto: nombre, PNG recortado (de frente, fondo transparente) y un
   offset de calibración fino. Los offsets arrancan en valores neutros —
   se ajustan en vivo con el panel de "Ajuste fino" (ícono de sliders) y se
   copian con el botón "Copiar" para pegarlos acá una vez calibrados.
   sku es opcional: si Tiendanube te manda el producto activo por
   postMessage, se usa para preseleccionar el modelo (ver sección 9).
   ------------------------------------------------------------------------- */
const MODELOS = [
  { id: 'terra',   nombre: 'Terra',   img: 'terra.png',   sku: '', calibracion: { escala: 1.00, x: 0, y: 0, z: 0 } },
  { id: 'noir',    nombre: 'Noir',    img: 'noir.png',    sku: '', calibracion: { escala: 1.00, x: 0, y: 0, z: 0 } },
  { id: 'lumen',   nombre: 'Lumen',   img: 'lumen.png',   sku: '', calibracion: { escala: 1.00, x: 0, y: 0, z: 0 } },
  { id: 'eclipse', nombre: 'Eclipse', img: 'eclipse.png', sku: '', calibracion: { escala: 1.00, x: 0, y: 0, z: 0 } },
  { id: 'sol',     nombre: 'Sol',     img: 'sol.png',     sku: '', calibracion: { escala: 1.00, x: 0, y: 0, z: 0 } },
  { id: 'dusk',    nombre: 'Dusk',    img: 'dusk.png',    sku: '', calibracion: { escala: 1.00, x: 0, y: 0, z: 0 } },
];

/* -------------------------------------------------------------------------
   1) CONSTANTES DE CALIBRACIÓN BASE
   MediaPipe no publica una escala absoluta en "cm por unidad": son valores
   de partida razonables, pensados para afinarse en cámara con el panel de
   ajuste fino (igual que se calibra cualquier probador de RA). Tocá estos
   3 números si el punto de partida queda muy grande/chico o alto/bajo en
   TODOS los modelos por igual; los offsets por producto van en MODELOS.
   ------------------------------------------------------------------------- */
const CAMARA_FOV_VERTICAL = 63;   // grados — FOV del entorno virtual de MediaPipe
const ANCHO_BASE           = 140; // ancho de referencia del lente, en el espacio "milimétrico" del modelo canónico de MediaPipe
const Y_BASE                = -46; // nudge vertical hacia el puente de la nariz (el ancla de MediaPipe queda alta, cerca de la frente)
const Z_BASE                = 10;  // nudge en profundidad (hacia la cámara)

// Ocluye lo que quedaría "detrás" de la cabeza (ej: la patilla lejana al
// girar la cara) para que el lente no se vea flotando siempre por encima
// de todo. Es una elipsoide aproximada, invisible, que solo escribe
// profundidad — no hace falta que calce perfecto con la cabeza real.
const CABEZA_OCLUSOR = { radioX: 78, radioY: 95, radioZ: 90, offsetY: -35, offsetZ: 55 };

/* -------------------------------------------------------------------------
   2) ESTADO GLOBAL
   ------------------------------------------------------------------------- */
const $ = s => document.querySelector(s);
const video    = $('#cam');
const glCanvas = $('#glCanvas');

let modeloActivo = MODELOS[0];
let faceLandmarker = null;
let renderer, scene, camera, faceAnchor, glassesMesh;
let texturas = {};              // id -> { texture, aspect, ready }
let rafId = null;
let lastVideoTime = -1;
let framesSinCara = 0;
let ultimaFoto = null;          // blob de la última captura
let ajusteSesion = { escala: 1, y: 0, z: 0 }; // overrides en vivo de los sliders

/* modo embebido (iframe dentro de una página de producto de Tiendanube) */
const params = new URLSearchParams(location.search);
const EMBEBIDO = params.get('embed') === '1' || window.self !== window.top;

/* -------------------------------------------------------------------------
   3) ESCENA THREE.JS
   ------------------------------------------------------------------------- */
function initEscena3D() {
  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(CAMARA_FOV_VERTICAL, 16 / 9, 1, 10000);
  camera.position.set(0, 0, 0);
  camera.lookAt(0, 0, -1);

  renderer = new THREE.WebGLRenderer({ canvas: glCanvas, alpha: true, antialias: true });
  renderer.setClearColor(0x000000, 0);

  // luz suave para que el lente reaccione a la pose (no quede "plano" y
  // parejo como una calcomanía) — mejora perceptible sin pedir assets nuevos
  scene.add(new THREE.AmbientLight(0xffffff, 0.75));
  const luzDir = new THREE.DirectionalLight(0xffffff, 0.55);
  luzDir.position.set(0.4, 1, 1);
  scene.add(luzDir);

  // el grupo recibe la matriz de pose facial completa (posición+rotación+escala)
  faceAnchor = new THREE.Object3D();
  faceAnchor.matrixAutoUpdate = false;
  faceAnchor.visible = false;
  scene.add(faceAnchor);

  // oclusor de cabeza: invisible (no pinta color), solo escribe profundidad,
  // para que la patilla/el marco se escondan correctamente detrás de la
  // cabeza real al girar, en vez de flotar siempre por encima de todo.
  const ocGeo = new THREE.SphereGeometry(1, 24, 18);
  const ocMat = new THREE.MeshBasicMaterial({ colorWrite: false });
  const ocluso = new THREE.Mesh(ocGeo, ocMat);
  ocluso.scale.set(CABEZA_OCLUSOR.radioX, CABEZA_OCLUSOR.radioY, CABEZA_OCLUSOR.radioZ);
  ocluso.position.set(0, CABEZA_OCLUSOR.offsetY, CABEZA_OCLUSOR.offsetZ);
  ocluso.renderOrder = 0;
  faceAnchor.add(ocluso);

  const geo = new THREE.PlaneGeometry(1, 1);
  const mat = new THREE.MeshStandardMaterial({ transparent: true, roughness: 0.35, metalness: 0.05 });
  glassesMesh = new THREE.Mesh(geo, mat);
  glassesMesh.renderOrder = 1;
  faceAnchor.add(glassesMesh);
}

function ajustarViewport(w, h) {
  glCanvas.width = w;
  glCanvas.height = h;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

/* -------------------------------------------------------------------------
   4) TEXTURAS DE LOS MODELOS
   ------------------------------------------------------------------------- */
function precargarTexturas() {
  const loader = new THREE.TextureLoader();
  MODELOS.forEach(m => {
    texturas[m.id] = { texture: null, aspect: 0.42, ready: false };
    loader.load(
      m.img,
      tex => {
        tex.colorSpace = THREE.SRGBColorSpace;
        const img = tex.image;
        texturas[m.id] = { texture: tex, aspect: img.naturalHeight / img.naturalWidth, ready: true };
        if (m.id === modeloActivo.id) aplicarModeloAlMesh(m);
      },
      undefined,
      () => { texturas[m.id].ready = false; }
    );
  });
}

function aplicarModeloAlMesh(m) {
  const t = texturas[m.id];
  if (!t || !t.ready) return;
  glassesMesh.material.map = t.texture;
  glassesMesh.material.needsUpdate = true;
  const ancho = ANCHO_BASE * m.calibracion.escala * ajusteSesion.escala;
  const alto = ancho * t.aspect;
  glassesMesh.scale.set(ancho, alto, 1);
  glassesMesh.position.set(
    m.calibracion.x,
    Y_BASE + m.calibracion.y + ajusteSesion.y,
    Z_BASE + m.calibracion.z + ajusteSesion.z
  );
}

/* -------------------------------------------------------------------------
   5) UI: chips de modelos
   ------------------------------------------------------------------------- */
function renderChips() {
  const cont = $('#models');
  cont.innerHTML = '';
  MODELOS.forEach(m => {
    const chip = document.createElement('div');
    chip.className = 'chip' + (m.id === modeloActivo.id ? ' active' : '');
    chip.innerHTML = `<div class="swatch"><img src="${m.img}" alt="${m.nombre}" /></div>
                      <div class="name">${m.nombre}</div>`;
    chip.onclick = () => seleccionarModelo(m);
    cont.appendChild(chip);
  });
}

function seleccionarModelo(m) {
  modeloActivo = m;
  ajusteSesion = { escala: 1, y: 0, z: 0 };
  sincronizarSliders();
  renderChips();
  aplicarModeloAlMesh(m);
}

function seleccionarModeloPorSkuOId(valor) {
  const m = MODELOS.find(x => x.sku === valor || x.id === valor);
  if (m) seleccionarModelo(m);
}

/* -------------------------------------------------------------------------
   6) LOOP: video -> Face Landmarker -> pose 3D -> render
   ------------------------------------------------------------------------- */
function loop() {
  rafId = requestAnimationFrame(loop);
  if (!faceLandmarker || video.readyState < 2) return;

  if (video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const resultado = faceLandmarker.detectForVideo(video, performance.now());
    const matrices = resultado.facialTransformationMatrixes;

    if (matrices && matrices.length) {
      framesSinCara = 0;
      $('#faceHint').classList.remove('show');
      faceAnchor.visible = true;
      faceAnchor.matrix.fromArray(matrices[0].data);
    } else {
      framesSinCara++;
      if (framesSinCara > 20) {
        faceAnchor.visible = false;
        $('#faceHint').classList.add('show');
      }
    }
  }

  renderer.render(scene, camera);
}

/* -------------------------------------------------------------------------
   7) ARRANQUE: cámara + Face Landmarker
   ------------------------------------------------------------------------- */
async function iniciar() {
  mostrar('#loading');
  $('#loadingMsg').textContent = 'Encendiendo la cámara…';

  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw { code: 'unsupported' };
    }
    if (!hayWebGL()) {
      throw { code: 'no-webgl' };
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    video.srcObject = stream;
    await video.play();
    await esperarDimensiones();

    ajustarViewport(video.videoWidth, video.videoHeight);

    $('#loadingMsg').textContent = 'Cargando motor de seguimiento facial…';
    faceLandmarker = await crearFaceLandmarker();

    ocultarTodos();
    if (!rafId) loop();

    if (EMBEBIDO) {
      $('#closeBtn').classList.add('show');
      window.parent.postMessage({ type: 'aure-vto:ready' }, '*');
    }
  } catch (e) {
    fallar(traducirError(e));
  }
}

async function crearFaceLandmarker() {
  const fileset = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
  );
  const opciones = {
    baseOptions: {
      modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
      delegate: 'GPU',
    },
    outputFaceBlendshapes: false,
    outputFacialTransformationMatrixes: true,
    runningMode: 'VIDEO',
    numFaces: 1,
  };
  try {
    return await FaceLandmarker.createFromOptions(fileset, opciones);
  } catch (e) {
    // algunos navegadores/dispositivos no soportan el delegate GPU: reintenta en CPU
    opciones.baseOptions.delegate = 'CPU';
    return await FaceLandmarker.createFromOptions(fileset, opciones);
  }
}

function hayWebGL() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch (e) { return false; }
}

function esperarDimensiones() {
  return new Promise(res => {
    const check = () => {
      if (video.videoWidth > 0) res();
      else requestAnimationFrame(check);
    };
    check();
  });
}

function traducirError(e) {
  if (e && e.code === 'unsupported') return 'Este navegador no soporta acceso a cámara. Probá con Safari o Chrome actualizados.';
  if (e && e.code === 'no-webgl') return 'Este navegador no soporta gráficos 3D (WebGL), necesarios para el probador.';
  const msg = (e && e.message) || (e && e.name) || '';
  if (/Permission|NotAllowed|denied/i.test(msg)) return 'No pudimos acceder a la cámara. Habilitá el permiso en tu navegador y reintentá.';
  if (/NotFound|Requested device/i.test(msg)) return 'No se detectó ninguna cámara en este dispositivo.';
  if (/NotReadable/i.test(msg)) return 'La cámara está siendo usada por otra aplicación.';
  return 'No pudimos iniciar el probador. Probá de nuevo.';
}

/* -------------------------------------------------------------------------
   8) CAPTURA + COMPARTIR
   ------------------------------------------------------------------------- */
async function capturar() {
  if (!video.videoWidth) return;
  $('#flash').classList.remove('go');
  void $('#flash').offsetWidth;
  $('#flash').classList.add('go');

  renderer.render(scene, camera); // asegura el último frame del overlay

  const W = video.videoWidth, H = video.videoHeight;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const cc = c.getContext('2d');

  cc.translate(W, 0);
  cc.scale(-1, 1);
  cc.drawImage(video, 0, 0, W, H);
  cc.drawImage(glCanvas, 0, 0, W, H);
  cc.setTransform(1, 0, 0, 1, 0, 0);

  cc.font = `500 ${Math.round(W * 0.022)}px 'Cormorant Garamond', serif`;
  cc.fillStyle = 'rgba(245,241,232,0.9)';
  cc.textAlign = 'right';
  cc.fillText('AURÉ', W - W * 0.04, H - H * 0.04);

  c.toBlob(blob => {
    ultimaFoto = blob;
    const btn = $('#shareBtn');
    btn.disabled = false;

    if (EMBEBIDO) {
      const reader = new FileReader();
      reader.onload = () => {
        window.parent.postMessage({ type: 'aure-vto:captured', modelId: modeloActivo.id, dataUrl: reader.result }, '*');
      };
      reader.readAsDataURL(blob);
    }
  }, 'image/jpeg', 0.92);
}

async function compartirODescargar() {
  if (!ultimaFoto) return;
  const nombre = `aure-${modeloActivo.id}-${Date.now()}.jpg`;
  const file = new File([ultimaFoto], nombre, { type: 'image/jpeg' });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'AURÉ', text: `Me probé ${modeloActivo.nombre} en AURÉ` });
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return; // el usuario canceló el share sheet
    }
  }

  // fallback: iOS Safari no respeta <a download> de forma confiable,
  // así que abrimos la imagen en una pestaña para que la guarden con "mantener presionado"
  const url = URL.createObjectURL(ultimaFoto);
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent);
  if (isIOS) {
    window.open(url, '_blank');
    mostrarToast('Mantené presionada la imagen para guardarla');
  } else {
    const a = document.createElement('a');
    a.href = url;
    a.download = nombre;
    a.click();
    mostrarToast('Foto descargada');
  }
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function mostrarToast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(mostrarToast._t);
  mostrarToast._t = setTimeout(() => t.classList.remove('show'), 2600);
}

/* -------------------------------------------------------------------------
   9) INTEGRACIÓN TIENDANUBE (postMessage)
   La página padre puede mandar:
     { type: 'aure-vto:select-model', sku: '...' } o { ..., id: '...' }
   Este widget emite:
     { type: 'aure-vto:ready' }                                  al cargar
     { type: 'aure-vto:captured', modelId, dataUrl }             al capturar
     { type: 'aure-vto:close' }                                  al cerrar (si está embebido)
   ------------------------------------------------------------------------- */
window.addEventListener('message', (ev) => {
  const data = ev.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'aure-vto:select-model') {
    seleccionarModeloPorSkuOId(data.sku || data.id);
  }
});

$('#closeBtn').onclick = () => {
  if (EMBEBIDO) window.parent.postMessage({ type: 'aure-vto:close' }, '*');
};

/* -------------------------------------------------------------------------
   10) AJUSTE FINO (sliders) + copiar offsets calibrados
   ------------------------------------------------------------------------- */
function sincronizarSliders() {
  $('#sizeRange').value = 0;
  $('#yRange').value = 0;
  $('#zRange').value = 0;
}

// El slider de tamaño es exponencial (factor = 10^(valor/50)): en el centro
// no cambia nada (x1), y en los extremos llega a x0.01 / x100. Así, sea cual
// sea la unidad real de escala del modelo 3D de MediaPipe (no está
// documentada con precisión), siempre hay margen de sobra para encontrar el
// tamaño correcto sin quedarse corto — a diferencia de un rango lineal
// chico, que puede no alcanzar si la estimación de partida está lejos.
$('#sizeRange').oninput = e => { ajusteSesion.escala = Math.pow(10, e.target.value / 50); aplicarModeloAlMesh(modeloActivo); };
$('#yRange').oninput    = e => { ajusteSesion.y = +e.target.value; aplicarModeloAlMesh(modeloActivo); };
$('#zRange').oninput    = e => { ajusteSesion.z = +e.target.value; aplicarModeloAlMesh(modeloActivo); };

$('#copyOffsets').onclick = async () => {
  const combinado = {
    escala: +(modeloActivo.calibracion.escala * ajusteSesion.escala).toFixed(3),
    x: +(modeloActivo.calibracion.x).toFixed(4),
    y: +(modeloActivo.calibracion.y + ajusteSesion.y).toFixed(4),
    z: +(modeloActivo.calibracion.z + ajusteSesion.z).toFixed(4),
  };
  const texto = JSON.stringify(combinado);
  try {
    await navigator.clipboard.writeText(texto);
    mostrarToast('Offsets copiados: pegalos en MODELOS.' + modeloActivo.id);
  } catch (e) {
    mostrarToast(texto);
  }
};

/* -------------------------------------------------------------------------
   11) HELPERS DE VISTAS
   ------------------------------------------------------------------------- */
function mostrar(sel) { ocultarTodos(); $(sel).classList.remove('hidden'); }
function ocultarTodos() { document.querySelectorAll('.veil').forEach(v => v.classList.add('hidden')); }
function fallar(msg) { $('#errorMsg').textContent = msg; mostrar('#error'); }

/* -------------------------------------------------------------------------
   12) EVENTOS + INIT
   ------------------------------------------------------------------------- */
$('#startBtn').onclick = iniciar;
$('#retryBtn').onclick = iniciar;
$('#shutter').onclick = capturar;
$('#shareBtn').onclick = compartirODescargar;
$('#tuneBtn').onclick = () => $('#tune').classList.toggle('open');

window.addEventListener('resize', () => {
  if (video.videoWidth) ajustarViewport(video.videoWidth, video.videoHeight);
});

initEscena3D();
precargarTexturas();
renderChips();

if (EMBEBIDO) {
  document.body.classList.add('embebido');
}
