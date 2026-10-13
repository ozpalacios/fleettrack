// ============================================================
// FleetTrack POD — Backend en Google Apps Script
// Prueba de Entrega (Proof of Delivery) para despacho a domicilio
//
// Instalación (ver pod/README.md):
//   1. Crear una Google Sheet nueva → Extensiones → Apps Script
//   2. Pegar este archivo completo en Code.gs
//   3. Ejecutar la función setup() una vez (autoriza permisos)
//   4. Implementar → Nueva implementación → Aplicación web
//        Ejecutar como: Yo   ·   Quién tiene acceso: Cualquier usuario
//   5. Copiar la URL /exec en la app POD (Ajustes)
// ============================================================

const SHEET = {
  RUTAS: 'Rutas',
  PARADAS: 'Paradas',
  ENTREGAS: 'Entregas_POD',
  TRACKING: 'Tracking_GPS'
};

const HEADERS = {
  Rutas: ['ruta_id', 'fecha', 'ruta', 'conductor', 'placa', 'paradas', 'estado',
    'km_plan', 'km_plan_fuente', 'inicio', 'fin', 'km_gps_dispositivo', 'km_gps_servidor',
    'inicio_lat', 'inicio_lng', 'fin_lat', 'fin_lng', 'cargado_por', 'cargado_en'],
  Paradas: ['ruta_id', 'fecha', 'ruta', 'seq', 'pedido', 'cliente', 'direccion', 'telefono',
    'lat', 'lng', 'geo_fuente', 'notas', 'estado', 'pod_id', 'actualizado'],
  Entregas_POD: ['pod_id', 'ruta_id', 'fecha', 'ruta', 'seq', 'pedido', 'cliente', 'conductor',
    'placa', 'estado', 'motivo', 'receptor', 'comentario', 'lat', 'lng', 'precision_m',
    'dist_destino_m', 'geocerca', 'km_acum_ruta', 'hora_dispositivo', 'hora_servidor',
    'foto_url', 'firma_url', 'mapa'],
  Tracking_GPS: ['ruta_id', 'conductor', 'hora', 'lat', 'lng', 'precision_m', 'velocidad_kmh']
};

// Columnas que deben guardarse como texto (evita que Sheets convierta
// fechas o borre ceros a la izquierda en pedidos/teléfonos)
const TEXT_COLS = ['ruta_id', 'fecha', 'ruta', 'pedido', 'telefono', 'pod_id', 'placa'];

const ESTADOS_POD = ['ENTREGADO', 'PARCIAL', 'RECHAZADO', 'NO_ENTREGADO'];

// Filtros GPS (deben coincidir con los de la app)
const GPS_MAX_ACC_M = 60;      // descarta lecturas con precisión peor a 60 m
const GPS_MIN_STEP_KM = 0.02;  // ignora saltos menores a 20 m (ruido)
const GPS_MAX_KMH = 160;       // descarta saltos imposibles

// ============================================================
// SETUP
// ============================================================
function setup() {
  Object.keys(HEADERS).forEach(sheet_);
  const p = props_();
  if (!p.getProperty('SUPERVISOR_PIN')) p.setProperty('SUPERVISOR_PIN', '1234');
  if (!p.getProperty('GEOCERCA_M')) p.setProperty('GEOCERCA_M', '150');
  if (!p.getProperty('POD_FOLDER_ID')) {
    const folder = DriveApp.createFolder('POD Evidencias — FleetTrack');
    p.setProperty('POD_FOLDER_ID', folder.getId());
  }
  Logger.log('Listo. PIN supervisor: ' + p.getProperty('SUPERVISOR_PIN') +
    ' (cámbialo en Configuración del proyecto → Propiedades del script)');
  Logger.log('Carpeta de evidencias: ' +
    DriveApp.getFolderById(p.getProperty('POD_FOLDER_ID')).getUrl());
}

// ============================================================
// ENDPOINTS
// ============================================================
function doGet(e) {
  const prm = (e && e.parameter) || {};
  const action = prm.action || 'ping';
  try {
    if (action === 'ping') return json_({ ok: true, app: 'FleetTrack POD' });
    if (action === 'drivers') return json_({ ok: true, conductores: drivers_(prm.fecha) });
    if (action === 'routes') return json_({ ok: true, rutas: routesFor_(prm.fecha, prm.conductor),
      geocerca_m: Number(props_().getProperty('GEOCERCA_M') || 150) });
    return json_({ ok: false, error: 'Acción no válida: ' + action });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function doPost(e) {
  let data;
  try {
    data = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'JSON inválido' });
  }
  const handlers = {
    verifyPin: verifyPin_,
    uploadRoutes: uploadRoutes_,
    summary: summary_,
    startRoute: startRoute_,
    track: track_,
    pod: pod_,
    endRoute: endRoute_
  };
  const fn = handlers[data.action];
  if (!fn) return json_({ ok: false, error: 'Acción no válida: ' + data.action });

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
    return json_(fn(data));
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

// ============================================================
// SUPERVISOR
// ============================================================
function requirePin_(data) {
  const pin = props_().getProperty('SUPERVISOR_PIN') || '1234';
  if (String(data.pin || '') !== pin) throw new Error('PIN de supervisor incorrecto');
}

function verifyPin_(data) {
  requirePin_(data);
  return { ok: true };
}

/**
 * Carga de rutas desde Excel/CSV.
 * data.rows: [{ fecha, ruta, conductor, placa, seq, pedido, cliente, direccion, telefono, lat, lng, notas }]
 * Si la ruta (fecha+ruta) ya existe y no tiene entregas registradas, se reemplaza.
 */
function uploadRoutes_(data) {
  requirePin_(data);
  const rows = data.rows || [];
  if (!rows.length) throw new Error('No hay filas para cargar');

  // Agrupar por ruta
  const groups = {};
  rows.forEach(function (r) {
    const fecha = normDate_(r.fecha);
    const ruta = String(r.ruta || '').trim();
    if (!fecha || !ruta) return;
    const id = fecha + '_' + ruta;
    if (!groups[id]) groups[id] = { id: id, fecha: fecha, ruta: ruta, conductor: '', placa: '', stops: [] };
    const g = groups[id];
    if (!g.conductor && r.conductor) g.conductor = String(r.conductor).trim();
    if (!g.placa && r.placa) g.placa = String(r.placa).trim();
    g.stops.push(r);
  });

  const podRoutes = {};
  readAll_(SHEET.ENTREGAS).forEach(function (p) { podRoutes[p.ruta_id] = true; });

  const errores = [];
  const ids = Object.keys(groups).filter(function (id) {
    if (podRoutes[id]) {
      errores.push('Ruta ' + groups[id].ruta + ' (' + groups[id].fecha +
        ') ya tiene entregas registradas; no se reemplazó.');
      return false;
    }
    return true;
  });

  const now = new Date();
  const geocode = geocoder_();
  const newRutas = [];
  const newParadas = [];
  const resumen = [];

  ids.forEach(function (id) {
    const g = groups[id];
    g.stops.sort(function (a, b) { return (Number(a.seq) || 0) - (Number(b.seq) || 0); });
    let sinCoord = 0;
    const pts = [];
    g.stops.forEach(function (s, i) {
      let lat = toNum_(s.lat), lng = toNum_(s.lng), fuente = 'ARCHIVO';
      if (!validCoord_(lat, lng)) {
        const geo = geocode(String(s.direccion || ''));
        if (geo) { lat = geo.lat; lng = geo.lng; fuente = 'GEOCODER'; }
        else { lat = ''; lng = ''; fuente = 'SIN_COORD'; sinCoord++; }
      }
      if (fuente !== 'SIN_COORD') pts.push({ lat: lat, lng: lng });
      newParadas.push({
        ruta_id: id, fecha: g.fecha, ruta: g.ruta, seq: Number(s.seq) || i + 1,
        pedido: String(s.pedido || '').trim(), cliente: String(s.cliente || '').trim(),
        direccion: String(s.direccion || '').trim(), telefono: String(s.telefono || '').trim(),
        lat: lat, lng: lng, geo_fuente: fuente, notas: String(s.notas || '').trim(),
        estado: 'PENDIENTE', pod_id: '', actualizado: now
      });
    });
    const plan = planKm_(pts);
    newRutas.push({
      ruta_id: id, fecha: g.fecha, ruta: g.ruta, conductor: g.conductor, placa: g.placa,
      paradas: g.stops.length, estado: 'PENDIENTE', km_plan: plan.km, km_plan_fuente: plan.fuente,
      cargado_por: String(data.usuario || 'Supervisor'), cargado_en: now
    });
    resumen.push({ ruta_id: id, ruta: g.ruta, conductor: g.conductor, paradas: g.stops.length,
      sin_coord: sinCoord, km_plan: plan.km, km_plan_fuente: plan.fuente });
  });

  // Reemplazar rutas/paradas existentes con el mismo id
  const replace = {};
  ids.forEach(function (id) { replace[id] = true; });
  rewrite_(SHEET.RUTAS, readAll_(SHEET.RUTAS).filter(function (r) { return !replace[r.ruta_id]; }).concat(newRutas));
  rewrite_(SHEET.PARADAS, readAll_(SHEET.PARADAS).filter(function (r) { return !replace[r.ruta_id]; }).concat(newParadas));

  return { ok: true, rutas: resumen, errores: errores };
}

/** Tablero del supervisor: rutas del día con paradas, entregas y recorrido GPS. */
function summary_(data) {
  requirePin_(data);
  const fecha = normDate_(data.fecha) || today_();
  const rutas = routesFor_(fecha, '');
  const ids = {};
  rutas.forEach(function (r) { ids[r.ruta_id] = r; r.track = []; });
  readAll_(SHEET.TRACKING).forEach(function (t) {
    if (ids[t.ruta_id]) ids[t.ruta_id].track.push([Number(t.lat), Number(t.lng), iso_(t.hora)]);
  });
  rutas.forEach(function (r) {
    r.track.sort(function (a, b) { return a[2] < b[2] ? -1 : 1; });
    r.track = downsample_(r.track, 600);
  });
  return { ok: true, fecha: fecha, rutas: rutas,
    geocerca_m: Number(props_().getProperty('GEOCERCA_M') || 150) };
}

// ============================================================
// CONDUCTOR
// ============================================================
function drivers_(fecha) {
  fecha = normDate_(fecha) || today_();
  const set = {};
  readAll_(SHEET.RUTAS).forEach(function (r) {
    if (r.fecha === fecha && r.conductor) set[r.conductor] = true;
  });
  return Object.keys(set).sort();
}

function routesFor_(fecha, conductor) {
  fecha = normDate_(fecha) || today_();
  const pods = {};
  readAll_(SHEET.ENTREGAS).forEach(function (p) { if (p.fecha === fecha) pods[p.pod_id] = p; });
  const rutas = readAll_(SHEET.RUTAS).filter(function (r) {
    return r.fecha === fecha && (!conductor || norm_(r.conductor) === norm_(conductor));
  }).map(clean_);
  const byId = {};
  rutas.forEach(function (r) { r.stops = []; byId[r.ruta_id] = r; });
  readAll_(SHEET.PARADAS).forEach(function (s) {
    const r = byId[s.ruta_id];
    if (!r) return;
    const stop = clean_(s);
    if (stop.pod_id && pods[stop.pod_id]) stop.pod = clean_(pods[stop.pod_id]);
    r.stops.push(stop);
  });
  rutas.forEach(function (r) {
    r.stops.sort(function (a, b) { return Number(a.seq) - Number(b.seq); });
  });
  rutas.sort(function (a, b) { return String(a.ruta).localeCompare(String(b.ruta)); });
  return rutas;
}

function startRoute_(data) {
  const r = findRoute_(data.ruta_id);
  if (r.inicio) return { ok: true, ya_iniciada: true };
  updateRow_(SHEET.RUTAS, r._row, {
    estado: 'EN_RUTA', inicio: toDate_(data.hora), inicio_lat: data.lat || '', inicio_lng: data.lng || ''
  });
  return { ok: true };
}

function track_(data) {
  const pts = data.puntos || [];
  if (!pts.length) return { ok: true, n: 0 };
  append_(SHEET.TRACKING, pts.map(function (p) {
    return { ruta_id: data.ruta_id, conductor: data.conductor || '', hora: toDate_(p.t),
      lat: p.lat, lng: p.lng, precision_m: Math.round(p.acc || 0),
      velocidad_kmh: p.spd == null ? '' : Math.round(p.spd * 3.6) };
  }));
  return { ok: true, n: pts.length };
}

function pod_(data) {
  if (!data.pod_id) throw new Error('Falta pod_id');
  if (ESTADOS_POD.indexOf(data.estado) < 0) throw new Error('Estado inválido');
  // Idempotente: si el POD ya existe, no se duplica
  const existing = readAll_(SHEET.ENTREGAS).filter(function (p) { return p.pod_id === data.pod_id; })[0];
  if (existing) return { ok: true, duplicado: true };

  const route = findRoute_(data.ruta_id);
  const stop = readAll_(SHEET.PARADAS).filter(function (s) {
    return s.ruta_id === data.ruta_id && String(s.seq) === String(data.seq);
  })[0];
  if (!stop) throw new Error('Parada no encontrada: ' + data.ruta_id + ' #' + data.seq);

  const geocercaM = Number(props_().getProperty('GEOCERCA_M') || 150);
  let dist = '', geocerca = 'SIN_REF';
  if (validCoord_(toNum_(stop.lat), toNum_(stop.lng)) && validCoord_(data.lat, data.lng)) {
    dist = Math.round(haversineKm_(Number(stop.lat), Number(stop.lng), data.lat, data.lng) * 1000);
    geocerca = dist <= geocercaM ? 'DENTRO' : 'FUERA';
  } else if (!validCoord_(data.lat, data.lng)) {
    geocerca = 'SIN_GPS';
  }

  const folder = podFolder_(route.fecha, route.ruta);
  const base = route.ruta + '_' + stop.seq + '_' + (stop.pedido || 'sin-pedido');
  const fotoUrl = data.foto ? saveDataUrl_(folder, data.foto, base + '_foto') : '';
  const firmaUrl = data.firma ? saveDataUrl_(folder, data.firma, base + '_firma') : '';

  const now = new Date();
  append_(SHEET.ENTREGAS, [{
    pod_id: data.pod_id, ruta_id: data.ruta_id, fecha: route.fecha, ruta: route.ruta,
    seq: stop.seq, pedido: stop.pedido, cliente: stop.cliente,
    conductor: data.conductor || route.conductor, placa: route.placa,
    estado: data.estado, motivo: data.motivo || '', receptor: data.receptor || '',
    comentario: data.comentario || '', lat: data.lat || '', lng: data.lng || '',
    precision_m: data.acc == null ? '' : Math.round(data.acc),
    dist_destino_m: dist, geocerca: geocerca,
    km_acum_ruta: data.km_acum == null ? '' : Math.round(data.km_acum * 100) / 100,
    hora_dispositivo: toDate_(data.hora), hora_servidor: now,
    foto_url: fotoUrl, firma_url: firmaUrl,
    mapa: validCoord_(data.lat, data.lng) ? 'https://www.google.com/maps?q=' + data.lat + ',' + data.lng : ''
  }]);
  updateRow_(SHEET.PARADAS, stop._row, { estado: data.estado, pod_id: data.pod_id, actualizado: now });
  return { ok: true, geocerca: geocerca, dist_destino_m: dist };
}

function endRoute_(data) {
  const r = findRoute_(data.ruta_id);
  const pts = readAll_(SHEET.TRACKING)
    .filter(function (t) { return t.ruta_id === data.ruta_id; })
    .map(function (t) { return { lat: Number(t.lat), lng: Number(t.lng), acc: Number(t.precision_m) || 0, t: new Date(t.hora).getTime() }; })
    .sort(function (a, b) { return a.t - b.t; });
  const kmServer = Math.round(trackKm_(pts) * 100) / 100;
  updateRow_(SHEET.RUTAS, r._row, {
    estado: 'FINALIZADA', fin: toDate_(data.hora),
    km_gps_dispositivo: data.km == null ? '' : Math.round(data.km * 100) / 100,
    km_gps_servidor: kmServer, fin_lat: data.lat || '', fin_lng: data.lng || ''
  });
  return { ok: true, km_gps_servidor: kmServer };
}

// ============================================================
// DISTANCIAS
// ============================================================
function haversineKm_(lat1, lng1, lat2, lng2) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Km recorridos a partir de puntos GPS ordenados, filtrando ruido y saltos. */
function trackKm_(pts) {
  let km = 0, last = null;
  pts.forEach(function (p) {
    if (p.acc > GPS_MAX_ACC_M) return;
    if (!last) { last = p; return; }
    const d = haversineKm_(last.lat, last.lng, p.lat, p.lng);
    if (d < GPS_MIN_STEP_KM) return;
    const h = (p.t - last.t) / 3600000;
    if (h > 0 && d / h > GPS_MAX_KMH) return;
    km += d;
    last = p;
  });
  return km;
}

/**
 * Km planificados por carretera con el servicio Maps de Apps Script
 * (no requiere API key). Si BODEGA_LAT/BODEGA_LNG están configurados,
 * calcula ida y vuelta desde la bodega. Si falla, usa línea recta × 1.3.
 */
function planKm_(stops) {
  const p = props_();
  const bLat = toNum_(p.getProperty('BODEGA_LAT')), bLng = toNum_(p.getProperty('BODEGA_LNG'));
  let pts = stops.slice();
  if (validCoord_(bLat, bLng)) pts = [{ lat: bLat, lng: bLng }].concat(pts, [{ lat: bLat, lng: bLng }]);
  if (pts.length < 2) return { km: '', fuente: '' };
  try {
    let meters = 0;
    // Máximo 23 waypoints por consulta: se procesa por tramos
    for (let i = 0; i < pts.length - 1; i += 24) {
      const chunk = pts.slice(i, Math.min(i + 25, pts.length));
      const finder = Maps.newDirectionFinder()
        .setOrigin(chunk[0].lat, chunk[0].lng)
        .setDestination(chunk[chunk.length - 1].lat, chunk[chunk.length - 1].lng)
        .setMode(Maps.DirectionFinder.Mode.DRIVING);
      chunk.slice(1, -1).forEach(function (w) { finder.addWaypoint(w.lat, w.lng); });
      const res = finder.getDirections();
      if (!res.routes || !res.routes.length) throw new Error('Sin ruta');
      res.routes[0].legs.forEach(function (l) { meters += l.distance.value; });
    }
    return { km: Math.round(meters / 100) / 10, fuente: 'GOOGLE_MAPS' };
  } catch (err) {
    let km = 0;
    for (let i = 1; i < pts.length; i++) km += haversineKm_(pts[i - 1].lat, pts[i - 1].lng, pts[i].lat, pts[i].lng);
    return { km: Math.round(km * 1.3 * 10) / 10, fuente: 'ESTIMADO_LINEAL' };
  }
}

/** Geocodificador con caché; usa la propiedad PAIS (ej. "El Salvador") como sufijo. */
function geocoder_() {
  const cache = CacheService.getScriptCache();
  const pais = props_().getProperty('PAIS') || '';
  const geo = Maps.newGeocoder();
  let calls = 0;
  return function (address) {
    if (!address) return null;
    const q = pais && address.toLowerCase().indexOf(pais.toLowerCase()) < 0 ? address + ', ' + pais : address;
    const key = 'geo_' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, q));
    const hit = cache.get(key);
    if (hit) return hit === 'null' ? null : JSON.parse(hit);
    if (calls++ > 300) return null;
    let out = null;
    try {
      const res = geo.geocode(q);
      if (res.status === 'OK' && res.results.length) {
        const loc = res.results[0].geometry.location;
        out = { lat: loc.lat, lng: loc.lng };
      }
    } catch (err) { out = null; }
    cache.put(key, JSON.stringify(out), 21600);
    return out;
  };
}

// ============================================================
// DRIVE
// ============================================================
function podFolder_(fecha, ruta) {
  const p = props_();
  let rootId = p.getProperty('POD_FOLDER_ID');
  let root;
  try { root = DriveApp.getFolderById(rootId); }
  catch (err) {
    root = DriveApp.createFolder('POD Evidencias — FleetTrack');
    p.setProperty('POD_FOLDER_ID', root.getId());
  }
  return subfolder_(subfolder_(root, fecha), 'Ruta ' + ruta);
}

function subfolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function saveDataUrl_(folder, dataUrl, name) {
  const m = String(dataUrl).match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return '';
  const ext = m[1] === 'image/png' ? '.png' : '.jpg';
  const blob = Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], name + ext);
  return folder.createFile(blob).getUrl();
}

// ============================================================
// HOJAS
// ============================================================
function sheet_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    const h = HEADERS[name];
    sh.getRange(1, 1, 1, h.length).setValues([h]).setBackground('#F5A623').setFontWeight('bold');
    sh.setFrozenRows(1);
    h.forEach(function (k, i) {
      if (TEXT_COLS.indexOf(k) >= 0) sh.getRange(2, i + 1, sh.getMaxRows() - 1, 1).setNumberFormat('@');
    });
  }
  return sh;
}

function readAll_(name) {
  const sh = sheet_(name);
  const n = sh.getLastRow();
  if (n < 2) return [];
  const h = HEADERS[name];
  return sh.getRange(2, 1, n - 1, h.length).getValues().map(function (row, i) {
    const o = { _row: i + 2 };
    h.forEach(function (k, j) {
      let v = row[j];
      if (k === 'fecha' && v instanceof Date) v = Utilities.formatDate(v, tz_(), 'yyyy-MM-dd');
      o[k] = v;
    });
    return o;
  });
}

function append_(name, objs) {
  if (!objs.length) return;
  const h = HEADERS[name];
  const sh = sheet_(name);
  sh.getRange(sh.getLastRow() + 1, 1, objs.length, h.length)
    .setValues(objs.map(function (o) { return h.map(function (k) { return o[k] === undefined ? '' : o[k]; }); }));
}

function rewrite_(name, objs) {
  const sh = sheet_(name);
  const h = HEADERS[name];
  const n = sh.getLastRow();
  if (n > 1) sh.getRange(2, 1, n - 1, h.length).clearContent();
  append_(name, objs);
}

function updateRow_(name, row, fields) {
  const h = HEADERS[name];
  const sh = sheet_(name);
  Object.keys(fields).forEach(function (k) {
    const c = h.indexOf(k);
    if (c >= 0) sh.getRange(row, c + 1).setValue(fields[k]);
  });
}

function findRoute_(id) {
  const r = readAll_(SHEET.RUTAS).filter(function (x) { return x.ruta_id === id; })[0];
  if (!r) throw new Error('Ruta no encontrada: ' + id);
  return r;
}

// ============================================================
// UTILIDADES
// ============================================================
function props_() { return PropertiesService.getScriptProperties(); }
function tz_() { return SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(); }
function today_() { return Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd'); }
function norm_(s) { return String(s || '').trim().toLowerCase(); }
function toNum_(v) { const n = parseFloat(String(v).replace(',', '.')); return isNaN(n) ? null : n; }
function validCoord_(lat, lng) {
  return typeof lat === 'number' && typeof lng === 'number' && !isNaN(lat) && !isNaN(lng) &&
    Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
}
function toDate_(v) { const d = v ? new Date(v) : new Date(); return isNaN(d.getTime()) ? new Date() : d; }
function iso_(v) { return v instanceof Date ? v.toISOString() : String(v || ''); }

function normDate_(v) {
  if (!v) return '';
  if (v instanceof Date) return Utilities.formatDate(v, tz_(), 'yyyy-MM-dd');
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return m[1] + '-' + pad_(m[2]) + '-' + pad_(m[3]);
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/); // dd/mm/aaaa
  if (m) return m[3] + '-' + pad_(m[2]) + '-' + pad_(m[1]);
  return '';
}
function pad_(n) { return ('0' + n).slice(-2); }

/** Convierte una fila a objeto serializable (fechas → ISO, sin _row). */
function clean_(o) {
  const out = {};
  Object.keys(o).forEach(function (k) {
    if (k === '_row') return;
    out[k] = o[k] instanceof Date ? o[k].toISOString() : o[k];
  });
  return out;
}

function downsample_(arr, max) {
  if (arr.length <= max) return arr;
  const step = arr.length / max, out = [];
  for (let i = 0; i < max; i++) out.push(arr[Math.floor(i * step)]);
  out.push(arr[arr.length - 1]);
  return out;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
