# FleetTrack POD — Prueba de Entrega con GPS

Módulo de **Proof of Delivery (POD)** para el despacho a domicilio:

- El **supervisor de despacho** sube las rutas del día (Excel o CSV) y monitorea en un mapa el avance, los km y las evidencias.
- El **conductor** inicia la ruta en su celular. La app registra los **km recorridos por GPS** y en cada parada guarda la **prueba de entrega**: punto georreferenciado, foto, firma, quién recibe o motivo de no entrega.
- Todo se guarda en **Google Sheets** y las fotos y firmas en **Google Drive**. No requiere servidores ni pago de API.

```
 Supervisor (Excel/CSV) ──► Apps Script ──► Google Sheets: Rutas · Paradas · Entregas_POD · Tracking_GPS
                                 ▲                 Google Drive: POD Evidencias/<fecha>/Ruta <n>/
 Conductor (celular, GPS) ───────┘  (cola offline: si no hay señal, guarda y reenvía después)
```

## 1. Instalación (una sola vez, ~10 min)

1. Crea una **Google Sheet** nueva (por ejemplo “POD Despacho Domicilio”).
2. Menú **Extensiones → Apps Script**. Borra el contenido y pega todo [`apps-script/Code.gs`](apps-script/Code.gs). Guarda.
3. Selecciona la función **`setup`** y presiona **Ejecutar**. Acepta los permisos (Sheets, Drive, Maps).
   - Crea las 4 hojas, la carpeta **“POD Evidencias — FleetTrack”** en tu Drive y el PIN inicial `1234`.
4. **Implementar → Nueva implementación → Tipo: Aplicación web**
   - *Ejecutar como:* **Yo**
   - *Quién tiene acceso:* **Cualquier usuario**
   - Copia la URL que termina en **`/exec`**.
5. Abre la app POD → ⚙ **Ajustes** → pega la URL → **Probar** → **Guardar**.

### Configuración (Apps Script → ⚙ Configuración del proyecto → Propiedades del script)

| Propiedad | Para qué sirve | Valor por defecto |
|---|---|---|
| `SUPERVISOR_PIN` | PIN para cargar rutas y ver el monitoreo. **Cámbialo.** | `1234` |
| `GEOCERCA_M` | Radio en metros para validar que el POD se tomó en el destino. | `150` |
| `PAIS` | Se agrega a las direcciones al geocodificar (ej. `El Salvador`, `Guatemala`). | *(vacío)* |
| `BODEGA_LAT` / `BODEGA_LNG` | Coordenadas del CDD. Si existen, el km plan se calcula **ida y vuelta** desde la bodega. | *(vacío)* |

> Si modificas `Code.gs`, publica de nuevo: **Implementar → Gestionar implementaciones → Editar → Nueva versión**. Así la URL no cambia.

### Publicar la app

La app es un solo archivo, [`index.html`](index.html). Necesita **HTTPS** para usar el GPS y la cámara. La opción más simple es **GitHub Pages**: Settings → Pages → rama `main`. Queda en `https://<usuario>.github.io/fleettrack/pod/`.

Desde **Cargar rutas → 🔗 Enlace para conductores**, el supervisor copia un enlace que ya incluye la URL del backend. Lo envía por WhatsApp, y el conductor solo lo abre y elige su nombre.

## 2. Formato del archivo de rutas

Descarga la plantilla desde la app o usa [`plantilla_rutas.csv`](plantilla_rutas.csv). Funciona con `.xlsx`, `.xls` y `.csv`, y los encabezados pueden ir con o sin tildes o mayúsculas.

| Columna | Obligatoria | Notas / sinónimos aceptados |
|---|---|---|
| `ruta` | ✅ | Código de ruta (R01, Norte‑1…) |
| `conductor` | ✅ | Nombre tal como lo elegirá en la app (*chofer, piloto, motorista*) |
| `pedido` o `cliente` | ✅ (uno) | *factura, guía, documento / destinatario, tienda* |
| `direccion` | ✅* | *Si la fila trae lat/lng, puede ir vacía |
| `fecha` | | `aaaa-mm-dd` o `dd/mm/aaaa`. Si no viene, se usa la fecha elegida en pantalla |
| `placa` | | *vehículo, camión, unidad* |
| `seq` | | Orden de visita. Si no viene, se usa el orden de las filas |
| `telefono` | | El conductor puede llamar con un toque |
| `lat`, `lng` | | O una sola columna `coordenadas` con `13.70, -89.24` |
| `notas` | | Referencias para el conductor |

- **Sin coordenadas:** la dirección se geocodifica con Google Maps (servicio integrado de Apps Script, sin API key). Si no se encuentra, la parada queda `SIN_COORD`: se puede entregar, pero sin validación de geocerca.
- **Volver a cargar:** si subes otra vez una ruta (misma fecha + código), se **reemplaza** mientras no tenga entregas registradas.

## 3. Flujo del conductor

1. Abre el enlace, elige la fecha y su nombre, y luego la ruta.
2. Presiona **▶ Iniciar ruta**: arranca el GPS y la pantalla se mantiene encendida.
3. En cada parada:
   - **🧭 Navegar** abre Google Maps.
   - **✍ Registrar entrega** pide lo siguiente según el resultado:

| Resultado | Requisitos |
|---|---|
| ✅ Entregado | Nombre de quien recibe + firma **o** foto |
| 🟡 Parcial | Nombre + firma **o** foto (motivo opcional) |
| ⛔ Rechazado / 🚪 No entregado | Motivo + foto (fachada o producto) |

   El GPS del momento del registro se compara con la ubicación de la parada:
   - **DENTRO**: dentro de la geocerca.
   - **FUERA**: se guarda igual, pero queda marcada para auditoría.
   - **SIN_REF**: la parada no tiene coordenadas.
   - **SIN_GPS**: no se obtuvo ubicación.
4. **🏁 Finalizar ruta**: cierra los km.
   - Las paradas *No entregado* se pueden **reintentar** mientras la ruta está activa.

**Sin señal:** todo queda en una cola en el teléfono y se envía solo cuando vuelve la conexión. El indicador ☁ muestra cuántos registros están pendientes.

## 4. Cómo se miden los km

- Los km salen de sumar la distancia entre lecturas GPS. Se descartan:
  - lecturas con precisión peor a **60 m**;
  - movimientos menores a **20 m** (ruido con el vehículo detenido);
  - saltos imposibles de más de **160 km/h**.
- El teléfono calcula `km_gps_dispositivo`. Al finalizar, el servidor recalcula con los puntos guardados en `Tracking_GPS` (`km_gps_servidor`), como control cruzado.
- `km_plan` es la distancia por carretera con Google Maps siguiendo el orden de visita. Si Maps no responde, se usa la línea recta × 1.3, marcada como `ESTIMADO_LINEAL`.
- En el monitoreo, la **desviación km GPS vs. plan** se marca en rojo si supera ±20 %.

## 5. Hojas que se generan

| Hoja | Una fila por | Columnas clave |
|---|---|---|
| `Rutas` | ruta y día | estado, inicio, fin, km_plan, km_gps_dispositivo, km_gps_servidor |
| `Paradas` | parada | pedido, cliente, dirección, lat/lng, geo_fuente, estado |
| `Entregas_POD` | evento POD | estado, motivo, receptor, lat/lng, precisión, **dist_destino_m**, **geocerca**, km acumulado, hora, links a foto, firma y mapa |
| `Tracking_GPS` | punto GPS (cada ~50 m o 2 min) | ruta, hora, lat/lng, precisión, velocidad |

Con estas hojas se pueden armar tablas dinámicas o un tablero en Looker Studio con:
- % de entregas exitosas (OTIF);
- motivos de rechazo;
- km reales vs. plan por ruta o conductor;
- % de POD fuera de geocerca;
- tiempo por parada.

## 6. Limitaciones conocidas

- **GPS en segundo plano:** es una app web, así que el navegador puede pausar el GPS si se bloquea el teléfono o se cambia de app. La app pide mantener la pantalla encendida; aun así, recomienda a los conductores dejarla abierta y conectada al cargador. Si hay pausas, el tramo se cuenta en línea recta entre el último punto y el siguiente.
- **Seguridad:** el PIN protege la carga y el monitoreo. La lista de rutas de un conductor es accesible para quien tenga el enlace. Las fotos quedan privadas en el Drive del dueño del script.
- **Volumen:** Google Sheets admite 10 millones de celdas. Con `Tracking_GPS` a unos 7 mil celdas por ruta de 50 km, conviene archivar esa hoja cada mes, o migrar a BigQuery o Firebase si la flota crece.
- **Cuotas de Google (cuenta gratuita):** unas 1,000 consultas de Maps por día (geocodificación + km plan). Es suficiente para varias decenas de rutas diarias.
