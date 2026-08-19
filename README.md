# AURÉ · Probador Virtual

Probador virtual de lentes de sol en 3D real: la posición, rotación y escala
del lente se calculan a partir de la pose completa de la cabeza (no un
efecto 2D simulado), así que la perspectiva se mantiene correcta al girar,
inclinar o acercarte a cámara.

## Cómo está armado

- **`index.html`** — estructura y estados de UI (inicio / cargando / error).
- **`style.css`** — diseño de marca (negro / hueso / oro), mobile-first.
- **`app.js`** — toda la lógica: cámara, tracking, render 3D, captura, integración con Tiendanube.
- **`*.png`** — catálogo de lentes (PNG recortado, fondo transparente, de frente).
- **`visor360.html`** — widget aparte: spin viewer 360° de producto a partir
  de fotos en turntable, para la página de cada anteojo (ver sección propia
  más abajo). No depende de cámara ni del resto del probador.

Sin build step: todo se sirve como archivos estáticos, las librerías
(Three.js y MediaPipe Tasks Vision) se cargan por CDN vía `<script type="importmap">`.

### Motor de tracking

MediaPipe **Face Landmarker** (reemplazo activo de Face Mesh, que Google dejó
de actualizar) corre en el navegador y devuelve, por frame, una matriz de
transformación facial de la cabeza. Esa matriz se aplica directo a un grupo
de **Three.js**, y el lente (un plano con la textura PNG) cuelga de ese grupo
con un offset de calibración propio. Al girar la cabeza, la perspectiva del
plano en 3D es matemáticamente correcta — no hay que simular el giro a mano.

## Probarlo en local

```bash
python3 -m http.server 8123
```

Abrí `http://localhost:8123`. `getUserMedia` funciona en `localhost` sin HTTPS.
Para probarlo en tu iPhone **tiene que estar servido por HTTPS** (ver deploy
abajo) — Safari no da acceso a cámara en HTTP salvo `localhost`.

## Deploy (GitHub Pages o Netlify)

**GitHub Pages** (este repo ya está en GitHub):
1. Subí los cambios a `main`.
2. En el repo → *Settings → Pages* → *Source*: `main` / `/ (root)`.
3. Quedará en `https://<tu-usuario>.github.io/aure-tyron/`.

**Netlify**: arrastrá la carpeta a [app.netlify.com/drop](https://app.netlify.com/drop),
o conectá el repo — no hace falta build command (dejar vacío / "no build").

## Calibrar cada modelo

Cada producto en `app.js` (array `MODELOS`) tiene un offset propio:

```js
{ id:'terra', nombre:'Terra', img:'terra.png', sku:'', calibracion:{ escala:1, x:0, y:0, z:0 } }
```

Para calibrar en vivo (celular en mano, mirando la cámara):
1. Abrí el probador y seleccioná el modelo.
2. Tocá el ícono de sliders (dock inferior) → ajustá **Tamaño / Altura / Profundidad**.
3. Tocá **Copiar** → pega el JSON resultante en `calibracion` de ese modelo en `app.js`.

Los 3 sliders son overrides de sesión; no tocan el archivo hasta que copiás y
pegás el resultado. Así podés calibrar todo el catálogo de Auré sin tocar código,
solo ajustando en cámara y pegando el JSON al final.

**Para sumar un modelo nuevo**: sacale una foto de frente al lente, recortalo
con fondo transparente (PNG), agregalo a la carpeta y sumá una entrada en
`MODELOS` con `calibracion` en `{escala:1,x:0,y:0,z:0}` como punto de partida.

### Modelos 3D reales (`.glb`) — para que se vea correcto en cualquier ángulo

Con solo el PNG, el lente es un plano: se ve bien de frente pero "de canto"
al girar mucho la cabeza (no tiene espesor de marco ni la patilla real). El
motor ya soporta modelos 3D reales — apenas tengas un `.glb` de un producto:

1. Subilo a la carpeta del repo (ej: `terra.glb`).
2. En `MODELOS`, completá `modelo3D: 'terra.glb'` en la entrada de ese producto.
3. Listo — el tamaño se auto-normaliza al cargar, así que `escala:1` ya
   arranca razonable. Si el modelo no vino "mirando de frente", corregilo
   con `rotX/rotY/rotZ` (en grados) dentro de `calibracion`.

Los productos sin `modelo3D` siguen usando el PNG automáticamente — podés
migrar el catálogo de a poco, modelo por modelo.

**Cómo conseguir el `.glb` sin depender de un estudio de modelado 3D:**

- **Escaneo con el celular (el camino más rápido y barato)**: apps como
  [Polycam](https://poly.cam/) o Scaniverse (gratis, iOS) escanean un
  objeto físico y exportan `.glb` directo. Si tenés el par físico en mano,
  es cuestión de minutos por modelo — funciona mejor en modelos con iPhone
  con LiDAR (Pro/Pro Max de los últimos años), pero el escaneo fotográfico
  normal también sirve para un objeto chico y brilloso como un anteojo con
  un poco de paciencia (varias fotos, buena luz, fondo mate).
- **Freelancer de modelado 3D**: en Fiverr/Upwork, "3D model from photos"
  o "eyewear 3D model" es un encargo común y relativamente barato por
  producto si el escaneo no da buena calidad (vidrio/metal reflectivo
  puede costarle al escáner).
- **Generadores de imagen-a-3D por IA**: herramientas como Meshy o Tripo
  generan un `.glb` a partir de fotos del producto. Es la opción más
  rápida de todas, pero la calidad geométrica es variable — conviene
  revisar cada resultado antes de subirlo (a veces "alucinan" detalles
  que no están en la foto real).

> Nota sobre la escala: MediaPipe no publica una unidad absoluta ("cm por
> unidad 3D"), así que los valores base (`ANCHO_BASE`, `Y_BASE`, `Z_BASE` al
> principio de `app.js`) son un punto de partida calibrado a ojo. Si ves que
> TODOS los modelos quedan sistemáticamente grandes/chicos o altos/bajos,
> ajustá esas 3 constantes una sola vez; los offsets por producto son para
> las diferencias entre modelos.

## Embeber en Tiendanube

Tiendanube no permite subir backend ni instalar paquetes: la integración es
por **iframe**, abierto como overlay de pantalla completa (mismo patrón que
usan Infinit/Camweara) para no romper el layout del tema.

1. Deployá `index.html` (paso anterior) y anotá la URL pública.
2. Abrí `embed-tiendanube.html` de este repo, reemplazá `AURE_VTO_URL` por
   esa URL.
3. Pegá el bloque resultante en la página de producto de Tiendanube: editor
   de HTML de la descripción, o un bloque de "HTML personalizado" si tu
   plan lo tiene. Si estás en un plan con edición de tema (Liquid), pegalo
   directo en el template de producto para que aparezca siempre en el
   mismo lugar.
4. El atributo `allow="camera"` del iframe es obligatorio — sin eso, Safari
   bloquea el acceso a cámara dentro del iframe aunque el usuario lo permita.

### Comunicación con la página padre (`postMessage`)

El widget, corriendo con `?embed=1`, emite:

| Mensaje | Cuándo |
|---|---|
| `{ type:'aure-vto:ready' }` | al terminar de cargar |
| `{ type:'aure-vto:captured', modelId, dataUrl }` | al sacar una foto |
| `{ type:'aure-vto:close' }` | al tocar la X (visible solo embebido) |

Y escucha:

| Mensaje | Para qué |
|---|---|
| `{ type:'aure-vto:select-model', sku }` o `{ ..., id }` | preseleccionar el modelo según el producto que se está viendo |

El snippet de `embed-tiendanube.html` ya arma este intercambio; solo hace
falta completar el SKU si querés que abra directo en el modelo correcto.

## Probar en iPhone Safari (prioridad del proyecto)

1. Deployá a GitHub Pages o Netlify (HTTPS real).
2. Abrí la URL en Safari de iPhone — no en la app de Instagram/preview del
   sistema operativo, que a veces bloquean cámara.
3. Primera vez: Safari va a pedir permiso de cámara — aceptar.
4. Si algo se ve grande/chico o desplazado, usar el panel de ajuste fino
   (ver "Calibrar cada modelo" arriba) ahí mismo, en vivo.

No hay forma de emular esto 100% sin un iPhone real: el simulador de iOS no
tiene cámara real y los navegadores de escritorio no reproducen el
comportamiento de permisos/orientación de Safari mobile.

## Visor 360° de producto (fotos en turntable)

`visor360.html` es un widget aparte del probador virtual: un visor de
producto para la página de cada anteojo (como el de infinit.la), donde el
usuario arrastra para girarlo 360° a partir de una serie de fotos tomadas en
turntable — no depende de cámara ni de `.glb`, así que funciona en
cualquier navegador de escritorio o mobile.

### Preparar las fotos

- Sacá entre 24 y 72 fotos del anteojo girándolo en el mismo eje, mismo
  fondo, misma luz (una mesa giratoria/turntable manual alcanza — no hace
  falta equipo profesional, lo importante es la consistencia entre tomas).
- Recortá/centrá todas igual y exportá en el mismo tamaño. Usá **WebP**
  (o JPG si no podés convertir), ~800-1000px de lado mayor, calidad
  75-80% — a más cuadros y más resolución, más pesa el set total en 4G.
  Como referencia: 48 fotos de 900px en WebP ronda 1-2MB en total.
- Nombralas con numeración consecutiva con ceros a la izquierda, ej:
  `terra-001.webp` … `terra-048.webp`.
- Subí la carpeta al repo (o a donde vayas a alojar las fotos) y anotá la
  URL pública de la carpeta.

### Parámetros de `visor360.html` (todo por query string)

| Parámetro | Qué hace | Ejemplo |
|---|---|---|
| `carpeta` | Carpeta con las fotos (con o sin `/` final) | `360/terra/` |
| `frames` | Cantidad de fotos | `48` |
| `prefix` | Prefijo del nombre de archivo | `terra-` |
| `ext` | Extensión | `webp` |
| `pad` | Cantidad de dígitos con cero a la izquierda | `3` |
| `inicio` | Número del primer archivo (si no arranca en 1) | `1` |
| `lista` | Alternativa a `carpeta`/`frames`: lista de URLs separadas por coma, para nombres que no siguen un patrón | `a.webp,b.webp,...` |
| `sensibilidad` | Píxeles de drag por frame (default `4.5`) — subilo para que gire más lento/preciso | `6` |
| `bucle` | `0` para no dar la vuelta completa (se frena en el primer/último frame) | `0` |
| `hint` | `0` para no mostrar el cartel "Arrastrá para girar" | `0` |
| `fondo` | Color de fondo del visor, en hex sin `#` | `F5F1E8` |
| `acento` | Color del spinner de carga, en hex sin `#` | `C9A961` |

Ejemplo completo:

```
visor360.html?carpeta=360/terra/&frames=48&prefix=terra-&ext=webp&pad=3&fondo=F5F1E8&acento=C9A961
```

### Embeber en Tiendanube

Mismo patrón que el probador virtual: se embebe como `<iframe>` en la
página de producto (ver `embed-visor360-tiendanube.html` en este repo para
el snippet listo para pegar). A diferencia del probador, este widget va
**inline** en la galería del producto, no como overlay de pantalla
completa, y no necesita permiso de cámara.

Un `<iframe>` por modelo (cambiando `carpeta`/`frames`/`prefix` en el `src`
de cada uno) — como el widget es un único archivo reusable, migrás el
catálogo pegando el snippet una vez por producto con sus propios
parámetros, sin tocar código.

### Rendimiento en 4G

- El `<iframe>` del snippet lleva `loading="lazy"`: el navegador no le pide
  nada hasta que está por entrar en pantalla, así no compite con el resto
  de la página de producto ni bloquea su carga.
- Adentro del widget hay una segunda capa de lazy-load (`IntersectionObserver`):
  las fotos no arrancan a precargarse hasta que el visor mismo está cerca
  del viewport.
- Mientras precarga muestra un loader con % de avance; el primer cuadro se
  muestra apenas está listo (antes de que terminen los demás) para que se
  perciba rápido. El drag se habilita recién cuando terminó de precargar
  todo el set, para que no se note "salteado" al girar.
- Si una foto puntual falla (404, nombre mal escrito), el visor la saltea
  sola sin trabarse ni mostrar el ícono de imagen rota.

## Limitaciones conocidas / próximos pasos

- El delegate `GPU` de MediaPipe es el más rápido pero algunos Androids
  viejos no lo soportan bien; `app.js` reintenta automáticamente en `CPU`
  si falla la creación con GPU.
- Los offsets de calibración son puntos de partida razonables, no medidos
  con precisión de laboratorio — hay que afinarlos en cámara real (ver
  arriba). Es el mismo proceso que usa cualquier probador de RA, incluido
  Camweara.
- Sin `.glb`, el PNG ya no es un plano puro: `app.js` arma automáticamente
  un fallback con espesor (cara trasera) y dos patillas genéricas hacia la
  oreja, coloreadas muestreando el borde del propio PNG. Mejora bastante
  la sensación de volumen al girar, pero sigue siendo una aproximación
  genérica (misma forma de patilla para todos los modelos) — no la
  geometría real del producto. Para eso sigue haciendo falta el `.glb`
  por producto (ver "Modelos 3D reales" arriba), que es un trabajo de
  contenido mayor y queda como mejora futura para modelos "hero" si hace
  falta ese último nivel de realismo.
