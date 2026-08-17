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

## Limitaciones conocidas / próximos pasos

- El delegate `GPU` de MediaPipe es el más rápido pero algunos Androids
  viejos no lo soportan bien; `app.js` reintenta automáticamente en `CPU`
  si falla la creación con GPU.
- Los offsets de calibración son puntos de partida razonables, no medidos
  con precisión de laboratorio — hay que afinarlos en cámara real (ver
  arriba). Es el mismo proceso que usa cualquier probador de RA, incluido
  Camweara.
- Con la imagen plana (PNG), el costado del armazón en giros muy extremos
  (~90°) no muestra la patilla real — para eso haría falta un modelo 3D
  (`.glb`) por producto, que es un trabajo de contenido mucho mayor. Queda
  como mejora futura para modelos "hero" si hace falta ese último nivel de
  realismo.
