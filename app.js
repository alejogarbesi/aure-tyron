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
import { GLTFLoader } from 'https://cdn.jsdelivr.net/npm/three@0.160.1/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'https://cdn.jsdelivr.net/npm/three@0.160.1/examples/jsm/environments/RoomEnvironment.js';

/* -------------------------------------------------------------------------
   0) CATÁLOGO DE MODELOS
   Cada producto: nombre, PNG recortado (de frente, fondo transparente) y un
   offset de calibración fino. Los offsets arrancan en valores neutros —
   se ajustan en vivo con el panel de "Ajuste fino" (ícono de sliders) y se
   copian con el botón "Copiar" para pegarlos acá una vez calibrados.
   sku es opcional: si Tiendanube te manda el producto activo por
   postMessage, se usa para preseleccionar el modelo (ver sección 9).

   modelo3D (opcional): ruta a un archivo .glb con la geometría real del
   anteojo. Si está presente, se usa ESE modelo 3D (se ve correcto desde
   cualquier ángulo). Si está vacío, se usa el PNG plano como fallback
   (funciona, pero se nota "recorte" al girar mucho la cabeza). El tamaño
   se auto-normaliza al cargar el .glb, así que "escala:1" da un punto de
   partida razonable sin tener que adivinar la unidad del archivo.
   rotX/rotY/rotZ (grados): corrige la orientación si el .glb no viene
   mirando "de frente" — no hace falta tocar esto con el PNG.
   ------------------------------------------------------------------------- */
const MODELOS = [
  { id: 'terra',   nombre: 'Terra',   img: 'terra.png',   modelo3D: '', sku: '', calibracion: { escala: 1.00, x: 0, y: 0, z: 0, rotX: 0, rotY: 0, rotZ: 0 } },
  { id: 'noir',    nombre: 'Noir',    img: 'noir.png',    modelo3D: '', sku: '', calibracion: { escala: 1.00, x: 0, y: 0, z: 0, rotX: 0, rotY: 0, rotZ: 0 } },
  { id: 'lumen',   nombre: 'Lumen',   img: 'lumen.png',   modelo3D: '', sku: '', calibracion: { escala: 1.00, x: 0, y: 0, z: 0, rotX: 0, rotY: 0, rotZ: 0 } },
  { id: 'eclipse', nombre: 'Eclipse', img: 'eclipse.png', modelo3D: '', sku: '', calibracion: { escala: 1.00, x: 0, y: 0, z: 0, rotX: 0, rotY: 0, rotZ: 0 } },
  { id: 'sol',     nombre: 'Sol',     img: 'sol.png',     modelo3D: '', sku: '', calibracion: { escala: 1.00, x: 0, y: 0, z: 0, rotX: 0, rotY: 0, rotZ: 0 } },
  { id: 'dusk',    nombre: 'Dusk',    img: 'dusk.png',    modelo3D: '', sku: '', calibracion: { escala: 1.00, x: 0, y: 0, z: 0, rotX: 0, rotY: 0, rotZ: 0 } },
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
let renderer, scene, camera, faceAnchor, contenidoActivo;
let texturas = {};              // id -> { texture, aspect, ready, grupo }
let modelos3D = {};             // id -> { escena, escalaAuto, ready }
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

  // environment de estudio (genérico, no es una foto real): sin esto el
  // acetato brillante queda "mate" porque solo reacciona a 2 luces planas.
  // Con reflejos de ambiente, el marco levanta brillos suaves que se mueven
  // al girar la cabeza — es lo que más se nota como "objeto real" en una
  // foto de producto, y no depende de tener un .glb ni assets nuevos.
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();

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

  // contenedor intercambiable: cuelga acá el modelo 3D real (.glb) si el
  // producto tiene uno, o si no, el plano con el PNG recortado (fallback)
  contenidoActivo = new THREE.Object3D();
  contenidoActivo.renderOrder = 1;
  faceAnchor.add(contenidoActivo);
}

function ajustarViewport(w, h) {
  glCanvas.width = w;
  glCanvas.height = h;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

/* -------------------------------------------------------------------------
   4) ASSETS DE LOS MODELOS (PNG plano y, si existe, .glb real)
   ------------------------------------------------------------------------- */

// Sin .glb, el PNG por sí solo es un plano sin espesor y sin patillas — se
// nota "de canto" al girar la cabeza. Mientras no haya un modelo 3D real por
// producto, armamos un fallback procedural a partir del mismo PNG: una
// segunda cara trasera (da profundidad al marco) y dos patillas genéricas
// que van hacia la oreja, coloreadas con el tono de marco muestreado del
// propio PNG. No reemplaza a un .glb escaneado, pero se deja de ver "recorte
// de papel" al girar — y funciona para el catálogo entero sin assets nuevos.

function colorDeBorde(img) {
  const cv = document.createElement('canvas');
  cv.width = img.naturalWidth;
  cv.height = img.naturalHeight;
  const ctx = cv.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const cy = Math.max(0, Math.floor(cv.height / 2) - 1);
  const filaCentro = ctx.getImageData(0, cy, cv.width, 1).data;
  // alpha > 250 (no >0) a propósito: el borde recortado suele tener 1-2px
  // antialiaseados semitransparentes, mezclados con el fondo — un umbral
  // bajo agarra ese halo (queda gris claro) en vez del color real del marco.
  let xBorde = -1;
  for (let x = 0; x < cv.width; x++) {
    if (filaCentro[x * 4 + 3] > 250) { xBorde = x; break; }
  }
  if (xBorde < 0) return new THREE.Color(0x1a1a1a); // sin borde opaco: negro genérico

  // el primer píxel opaco puede ser un brillo/sombra de la foto de producto,
  // no el color plano del marco — promediamos un bloque un poco más adentro
  // en vez de quedarnos con ese único píxel, para un color representativo.
  const margen = 12, lado = 24;
  const x0 = Math.min(cv.width - lado, xBorde + margen);
  const y0 = Math.max(0, cy - Math.floor(lado / 2));
  const bloque = ctx.getImageData(x0, y0, lado, Math.min(lado, cv.height - y0)).data;
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < bloque.length; i += 4) {
    if (bloque[i + 3] > 250) { r += bloque[i]; g += bloque[i + 1]; b += bloque[i + 2]; n++; }
  }
  if (n === 0) return new THREE.Color(filaCentro[xBorde * 4] / 255, filaCentro[xBorde * 4 + 1] / 255, filaCentro[xBorde * 4 + 2] / 255);
  return new THREE.Color(r / n / 255, g / n / 255, b / n / 255);
}

// varilla recta entre dos puntos (usada para armar cada tramo de patilla)
function crearVarilla(desde, hacia, grosor, material) {
  const dir = new THREE.Vector3().subVectors(hacia, desde);
  const largo = dir.length();
  const geo = new THREE.CylinderGeometry(grosor, grosor, largo, 6);
  const varilla = new THREE.Mesh(geo, material);
  varilla.position.copy(desde).addScaledVector(dir, 0.5);
  varilla.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  return varilla;
}

// coordenadas en el espacio unitario del plano (x,y de -0.5 a 0.5, z=0 en
// el frente); contenidoActivo las escala luego al tamaño real del modelo.
function crearGrupoFallback(tex, colorMarco) {
  const grupo = new THREE.Group();

  const geoLente = new THREE.PlaneGeometry(1, 1);
  const frente = new THREE.Mesh(
    geoLente,
    new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.2, metalness: 0.12, envMapIntensity: 1.1, side: THREE.DoubleSide })
  );
  grupo.add(frente);

  // cara trasera, levemente hundida: le da espesor real al marco (deja de
  // ser un plano infinitamente fino) sin necesitar geometría nueva
  const fondo = new THREE.Mesh(
    geoLente,
    new THREE.MeshStandardMaterial({
      map: tex, transparent: true, side: THREE.DoubleSide,
      color: colorMarco.clone().multiplyScalar(0.45), roughness: 0.45, metalness: 0.15, envMapIntensity: 0.8,
    })
  );
  fondo.position.z = -0.06;
  grupo.add(fondo);

  // puntos calibrados a ojo contra fotos reales de producto de auresunglasses.com.ar
  // (Terra y Noir, ambas de perfil 3/4): la bisagra sale casi del borde
  // superior del marco, no del medio, y la patilla se mantiene bastante
  // recta/alta la mayor parte del recorrido — recién cae hacia la oreja
  // sobre el final (esa parte no se ve en las fotos de estudio, que
  // cortan la patilla antes, pero hace falta para que cierre visualmente).
  const matVarilla = new THREE.MeshStandardMaterial({ color: colorMarco, roughness: 0.3, metalness: 0.3, envMapIntensity: 1.1 });
  [1, -1].forEach(lado => {
    const bisagra = new THREE.Vector3(lado * 0.49, 0.40, 0);
    const codo     = new THREE.Vector3(lado * 0.56, 0.36, -0.62);
    const puntaOreja = new THREE.Vector3(lado * 0.54, 0.10, -1.15);
    grupo.add(crearVarilla(bisagra, codo, 0.018, matVarilla));
    grupo.add(crearVarilla(codo, puntaOreja, 0.018, matVarilla));
  });

  return grupo;
}

function precargarTexturas() {
  const loader = new THREE.TextureLoader();
  MODELOS.forEach(m => {
    texturas[m.id] = { texture: null, aspect: 0.42, ready: false, grupo: null };
    loader.load(
      m.img,
      tex => {
        tex.colorSpace = THREE.SRGBColorSpace;
        const img = tex.image;
        const colorMarco = colorDeBorde(img);
        texturas[m.id] = {
          texture: tex,
          aspect: img.naturalHeight / img.naturalWidth,
          ready: true,
          grupo: crearGrupoFallback(tex, colorMarco),
        };
        if (m.id === modeloActivo.id) aplicarModelo(m);
      },
      undefined,
      () => { texturas[m.id].ready = false; }
    );
  });
}

function precargarModelos3D() {
  const loader = new GLTFLoader();
  MODELOS.forEach(m => {
    if (!m.modelo3D) return;
    modelos3D[m.id] = { escena: null, escalaAuto: 1, ready: false };
    loader.load(
      m.modelo3D,
      gltf => {
        const escena = gltf.scene;
        // auto-normaliza el ancho del modelo al mismo sistema de unidades
        // que ya usa el PNG plano (ANCHO_BASE), para que "escala:1" quede
        // parecido sea cual sea la unidad en la que vino exportado el .glb
        const bbox = new THREE.Box3().setFromObject(escena);
        const anchoReal = Math.max(bbox.max.x - bbox.min.x, 0.001);
        modelos3D[m.id] = { escena, escalaAuto: ANCHO_BASE / anchoReal, ready: true };
        if (m.id === modeloActivo.id) aplicarModelo(m);
      },
      undefined,
      () => { modelos3D[m.id].ready = false; } // sin .glb todavía: sigue usando el PNG
    );
  });
}

function aplicarModelo(m) {
  const modelo3D = modelos3D[m.id];
  const usar3D = modelo3D && modelo3D.ready;

  const c = m.calibracion;
  let ancho, alto = 1;

  if (usar3D) {
    contenidoActivo.clear();
    contenidoActivo.add(modelo3D.escena);
    ancho = modelo3D.escalaAuto * c.escala * ajusteSesion.escala;
    alto = ancho;
  } else {
    const t = texturas[m.id];
    if (!t || !t.ready) return;
    contenidoActivo.clear();
    contenidoActivo.add(t.grupo);
    ancho = ANCHO_BASE * c.escala * ajusteSesion.escala;
    alto = ancho * t.aspect;
  }

  contenidoActivo.scale.set(ancho, usar3D ? ancho : alto, ancho);
  contenidoActivo.position.set(
    c.x,
    Y_BASE + c.y + ajusteSesion.y,
    Z_BASE + c.z + ajusteSesion.z
  );
  contenidoActivo.rotation.set(
    THREE.MathUtils.degToRad(c.rotX),
    THREE.MathUtils.degToRad(c.rotY),
    THREE.MathUtils.degToRad(c.rotZ)
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
  aplicarModelo(m);
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
$('#sizeRange').oninput = e => { ajusteSesion.escala = Math.pow(10, e.target.value / 50); aplicarModelo(modeloActivo); };
$('#yRange').oninput    = e => { ajusteSesion.y = +e.target.value; aplicarModelo(modeloActivo); };
$('#zRange').oninput    = e => { ajusteSesion.z = +e.target.value; aplicarModelo(modeloActivo); };

$('#copyOffsets').onclick = async () => {
  const c = modeloActivo.calibracion;
  const combinado = {
    escala: +(c.escala * ajusteSesion.escala).toFixed(3),
    x: +(c.x).toFixed(4),
    y: +(c.y + ajusteSesion.y).toFixed(4),
    z: +(c.z + ajusteSesion.z).toFixed(4),
    rotX: c.rotX, rotY: c.rotY, rotZ: c.rotZ,
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
precargarModelos3D();
renderChips();

if (EMBEBIDO) {
  document.body.classList.add('embebido');
}
