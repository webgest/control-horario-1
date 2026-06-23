// ============================================================
//  CONTROL HORARIO 1 — Webgest
//  Stack: Node.js 20 + Express + better-sqlite3 + JWT
//  ⚠️  REGLA CRÍTICA TIMEZONE: UTC en DB, Madrid en display
// ============================================================

'use strict';

const express    = require('express');
const path       = require('path');
const jwt        = require('jsonwebtoken');
const bcrypt     = require('bcryptjs');
const Database   = require('better-sqlite3');
const cron       = require('node-cron');
const PDFDocument = require('pdfkit');
const crypto     = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET   = process.env.JWT_SECRET   || 'ch1-secret-dev-2026';
const ADMIN_USER   = process.env.ADMIN_USER   || 'webgest';
const ADMIN_PASS   = process.env.ADMIN_PASSWORD || 'Webgest2026!';

// ── Base de datos ──────────────────────────────────────────
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'control.db');
const fs = require('fs');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Middleware ─────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
//  FUNCIONES DE TIMEZONE — COPIA EXACTA OBLIGATORIA
// ============================================================

/** Devuelve la fecha/hora actual UTC en formato "YYYY-MM-DD HH:MM:SS" para la DB */
function nowDB() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

/** Convierte datetime UTC de la DB ("YYYY-MM-DD HH:MM:SS") a hora Madrid "HH:MM" */
function fmtMadrid(iso) {
  if (!iso) return '—';
  const d = new Date(String(iso).replace(' ', 'T') + 'Z');
  if (isNaN(d)) return String(iso).slice(11, 16);
  const y = d.getUTCFullYear();
  const cest = new Date(Date.UTC(y, 2, 31, 1, 0, 0));
  while (cest.getUTCDay() !== 0) cest.setUTCDate(cest.getUTCDate() - 1);
  const cet = new Date(Date.UTC(y, 9, 31, 1, 0, 0));
  while (cet.getUTCDay() !== 0) cet.setUTCDate(cet.getUTCDate() - 1);
  const off = (d >= cest && d < cet) ? 2 : 1;
  return new Date(d.getTime() + off * 3600000).toISOString().slice(11, 16);
}

/** Convierte datetime UTC de la DB a fecha Madrid "YYYY-MM-DD" */
function fmtMadridDate(iso) {
  if (!iso) return '—';
  const d = new Date(String(iso).replace(' ', 'T') + 'Z');
  if (isNaN(d)) return String(iso).slice(0, 10);
  const y = d.getUTCFullYear();
  const cest = new Date(Date.UTC(y, 2, 31, 1, 0, 0));
  while (cest.getUTCDay() !== 0) cest.setUTCDate(cest.getUTCDate() - 1);
  const cet = new Date(Date.UTC(y, 9, 31, 1, 0, 0));
  while (cet.getUTCDay() !== 0) cet.setUTCDate(cet.getUTCDate() - 1);
  const off = (d >= cest && d < cet) ? 2 : 1;
  return new Date(d.getTime() + off * 3600000).toISOString().slice(0, 10);
}

/** Fecha Madrid de hoy "YYYY-MM-DD" */
function todayMadrid() {
  return fmtMadridDate(nowDB());
}

/** Suma segundos a un datetime UTC de DB y devuelve nuevo datetime UTC de DB */
function addSecondsToDBTime(isoUtc, seconds) {
  const d = new Date(String(isoUtc).replace(' ', 'T') + 'Z');
  d.setTime(d.getTime() + seconds * 1000);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

/** Diferencia en segundos entre dos datetime UTC de DB */
function diffSeconds(isoStart, isoEnd) {
  const a = new Date(String(isoStart).replace(' ', 'T') + 'Z');
  const b = new Date(String(isoEnd).replace(' ', 'T') + 'Z');
  return Math.max(0, Math.round((b - a) / 1000));
}

/**
 * Convierte hora Madrid "HH:MM" + fecha "YYYY-MM-DD" → UTC datetime DB
 * Usa aritmética pura sin librerías (misma lógica que fmtMadrid)
 */
function madridToUTC(fecha, hhmm) {
  if (!fecha || !hhmm) return null;
  const [hStr, mStr] = String(hhmm).split(':');
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  if (isNaN(h) || isNaN(m)) return null;
  const y  = parseInt(fecha.slice(0, 4), 10);
  const mo = parseInt(fecha.slice(5, 7), 10) - 1;
  const d  = parseInt(fecha.slice(8, 10), 10);
  const cest = new Date(Date.UTC(y, 2, 31, 1, 0, 0));
  while (cest.getUTCDay() !== 0) cest.setUTCDate(cest.getUTCDate() - 1);
  const cet  = new Date(Date.UTC(y, 9, 31, 1, 0, 0));
  while (cet.getUTCDay() !== 0) cet.setUTCDate(cet.getUTCDate() - 1);
  // Usamos mediodía para determinar el offset del día (evita bordes DST)
  const noon = new Date(Date.UTC(y, mo, d, 12, 0, 0));
  const off  = (noon >= cest && noon < cet) ? 2 : 1;
  return new Date(Date.UTC(y, mo, d, h - off, m, 0))
    .toISOString().replace('T', ' ').slice(0, 19);
}

// ============================================================
//  INICIALIZACIÓN BASE DE DATOS
// ============================================================

db.exec(`
  CREATE TABLE IF NOT EXISTS empresas (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre  TEXT NOT NULL,
    nif     TEXT,
    ccc     TEXT,
    activa  INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS trabajadoras (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id     INTEGER NOT NULL REFERENCES empresas(id),
    nombre         TEXT NOT NULL,
    apellidos      TEXT NOT NULL DEFAULT '',
    dni            TEXT NOT NULL UNIQUE,
    pin_hash       TEXT NOT NULL,
    horas_dia      REAL NOT NULL DEFAULT 8.0,
    dias_mes       INTEGER NOT NULL DEFAULT 30,
    telefono       TEXT,
    activa         INTEGER NOT NULL DEFAULT 1,
    situacion      TEXT NOT NULL DEFAULT 'activa',
    es_prueba      INTEGER NOT NULL DEFAULT 0,
    codigo_carnet  TEXT
  );

  CREATE TABLE IF NOT EXISTS fichajes (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    trabajadora_id       INTEGER NOT NULL REFERENCES trabajadoras(id),
    fecha                TEXT NOT NULL,
    hora_entrada         TEXT,
    hora_salida          TEXT,
    horas_trabajadas     REAL,
    completado_auto      INTEGER NOT NULL DEFAULT 0,
    observaciones        TEXT,
    modificado_por       TEXT,
    modificado_en        TEXT,
    motivo_modificacion  TEXT
  );

  CREATE TABLE IF NOT EXISTS pausas (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    fichaje_id  INTEGER NOT NULL REFERENCES fichajes(id),
    inicio      TEXT NOT NULL,
    fin         TEXT
  );

  CREATE TABLE IF NOT EXISTS auditoria (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    tabla         TEXT NOT NULL,
    registro_id   INTEGER NOT NULL,
    campo         TEXT NOT NULL,
    valor_antes   TEXT,
    valor_despues TEXT,
    usuario       TEXT NOT NULL,
    fecha         TEXT NOT NULL,
    motivo        TEXT
  );

  CREATE TABLE IF NOT EXISTS tablon (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    trabajadora_id INTEGER NOT NULL REFERENCES trabajadoras(id),
    titulo         TEXT NOT NULL,
    contenido      TEXT NOT NULL,
    fecha_creacion TEXT NOT NULL,
    activo         INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS festivos (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha   TEXT NOT NULL UNIQUE,
    nombre  TEXT NOT NULL,
    tipo    TEXT NOT NULL DEFAULT 'nacional'
  );
`);

// ── Migraciones para instancias ya existentes ──────────────
try { db.exec('ALTER TABLE trabajadoras ADD COLUMN codigo_carnet TEXT'); } catch {}

// Actualizar horas_dia: jornada completa 8.3 → 8.0 (cambio solicitado)
db.prepare('UPDATE trabajadoras SET horas_dia = 8.0 WHERE horas_dia = 8.3').run();

// Generar código de carnet para quienes no tengan
{
  const sinCarnet = db.prepare('SELECT id FROM trabajadoras WHERE codigo_carnet IS NULL').all();
  const updCarnet = db.prepare('UPDATE trabajadoras SET codigo_carnet = ? WHERE id = ?');
  for (const t of sinCarnet) {
    updCarnet.run(crypto.randomBytes(6).toString('hex'), t.id);
  }
}

// ── Insertar datos iniciales (solo si no existen) ──────────
const seedData = () => {
  const count = db.prepare('SELECT COUNT(*) as n FROM empresas').get();
  if (count.n > 0) return;

  const insEmpresa = db.prepare(`INSERT INTO empresas (nombre, nif, ccc) VALUES (?,?,?)`);
  const e1 = insEmpresa.run('CONTRATACIONES LIMPIMUR, S.L.', 'B30381230', '30/1009098-56').lastInsertRowid;
  const e2 = insEmpresa.run('GRUPO LIMPIMUR EXPANSIÓN, S.L.', 'B73579872', '30/1184917-14').lastInsertRowid;
  const e3 = insEmpresa.run('CAMPICO BLANCO SCOOP', 'F73863276', '30126518563').lastInsertRowid;
  const e4 = insEmpresa.run('GIOMUR S. COOP', 'F73869620', '30132392117').lastInsertRowid;
  const e5 = insEmpresa.run('SGN AYUDA A DOMICILIO S. COOP', 'F05546171', '30132391612').lastInsertRowid;

  const pin0000 = bcrypt.hashSync('0000', 10);

  const insTrab = db.prepare(`
    INSERT INTO trabajadoras
      (empresa_id, nombre, apellidos, dni, pin_hash, horas_dia, dias_mes, situacion, es_prueba, codigo_carnet)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `);
  const nc = () => crypto.randomBytes(6).toString('hex');

  // ── EMPRESA 1 ──
  insTrab.run(e1,'Miñarro García','Isabel Pilar','23233727R',pin0000,4.0,30,'activa',0,nc());
  insTrab.run(e1,'Monteagudo Pujalte','María Carmen','27476364N',pin0000,8.0,31,'activa',0,nc());
  insTrab.run(e1,'Navarro Rodríguez','Francisca','23226904D',pin0000,4.0,30,'activa',0,nc());
  insTrab.run(e1,'Palomeque Pérez','Vanessa Mabel','60246144J',pin0000,4.0,30,'activa',0,nc());
  insTrab.run(e1,'Sánchez Jiménez','Juana María','23280620C',pin0000,6.0,30,'activa',0,nc());

  // ── EMPRESA 2 ──
  insTrab.run(e2,'García Carrillo','Dolores','23237143J',pin0000,8.0,30,'activa',0,nc());
  insTrab.run(e2,'Moya Vas','María Agustina','23260032V',pin0000,8.0,30,'activa',0,nc());
  insTrab.run(e2,'Vargas Aguilera','José','23249444D',pin0000,4.0,30,'activa',0,nc());

  // ── EMPRESA 3 ──
  insTrab.run(e3,'Cardoso Riverol','Himilce Caridad','30296065M',pin0000,8.0,30,'activa',0,nc());
  insTrab.run(e3,'Cedillo Abrigo','Lady Jovanna','60391608W',pin0000,8.0,30,'activa',0,nc());
  insTrab.run(e3,'Celdrán Garrigós','Concepción','34800714N',pin0000,5.99,21,'activa',0,nc());
  insTrab.run(e3,'Fernández Campoy','Mercedes','23251913V',pin0000,4.0,21,'activa',0,nc());
  insTrab.run(e3,'Fernández López','Isabel','23247227T',pin0000,8.0,30,'activa',0,nc());
  insTrab.run(e3,'Fernández López','Miguel','23247228R',pin0000,8.0,30,'activa',0,nc());
  insTrab.run(e3,'González Venteo','María José','17469048L',pin0000,4.0,20,'activa',0,nc());
  insTrab.run(e3,'Leines Muquinche','Wilson Arturo','24462214N',pin0000,8.0,30,'activa',0,nc());
  insTrab.run(e3,'López Beltrán','Caridad Rosario','23251554A',pin0000,8.0,30,'activa',0,nc());
  insTrab.run(e3,'López Molina','Ángeles','23273704G',pin0000,5.99,21,'activa',0,nc());
  insTrab.run(e3,'López Molina','María','23273705M',pin0000,8.0,30,'activa',0,nc());
  insTrab.run(e3,'Lozoya Alcázar','Juana','23245046G',pin0000,8.0,30,'activa',0,nc());
  insTrab.run(e3,'Martínez Mora','Agustina','23233737B',pin0000,8.0,30,'activa',0,nc());
  insTrab.run(e3,'Poveda Hernández','Rosario','23233171C',pin0000,8.0,30,'activa',0,nc());
  insTrab.run(e3,'Quiñonero Pérez','María Luz','23293489D',pin0000,5.0,20,'activa',0,nc());
  insTrab.run(e3,'Romero Celdrán','Andrea','49854509P',pin0000,5.99,21,'activa',0,nc());
  insTrab.run(e3,'Vásquez Cortés','María del Carmen','Y1088105N',pin0000,8.0,30,'activa',0,nc());

  // ── EMPRESA 4 ──
  insTrab.run(e4,'Abellán Romera','Concepción','23224638C',pin0000,8.0,30,'activa',0,nc());
  insTrab.run(e4,'Bonillo Caballero','Juana María','23276570H',pin0000,8.0,30,'activa',0,nc());
  insTrab.run(e4,'Cardeño Hurtado','Diana Cristina','Y0630036B',pin0000,8.0,30,'activa',0,nc());
  insTrab.run(e4,'Jouilik El Habbarri','Najat','23833818E',pin0000,8.0,30,'activa',0,nc());
  insTrab.run(e4,'López Jódar','Catalina Ángel','23249849T',pin0000,8.0,30,'activa',0,nc());
  insTrab.run(e4,'Manzanares Alcázar','Andrea','23288049C',pin0000,8.0,30,'activa',0,nc());
  insTrab.run(e4,'Miñarro García','María Isabel','23224185G',pin0000,5.99,21,'activa',0,nc());
  insTrab.run(e4,'Pérez Estrada','Vilma Araceli','13381919J',pin0000,8.0,30,'activa',0,nc());
  insTrab.run(e4,'Pérez Jordán','María Carmen','23229357R',pin0000,8.0,30,'activa',0,nc());
  insTrab.run(e4,'Pérez Pérez','María','23239758Y',pin0000,8.0,30,'activa',0,nc());
  insTrab.run(e4,'Reinaldos López','Ascensión','23227468K',pin0000,8.0,30,'it',0,nc());
  insTrab.run(e4,'Salinas Macas','Lady Tamara','30296461X',pin0000,5.99,21,'activa',0,nc());
  insTrab.run(e4,'Vera Ruiz','María Isabel','23252196R',pin0000,3.99,4,'activa',0,nc());

  // ── EMPRESA 5 ──
  insTrab.run(e5,'Giner Ayén','Josefa','23245307N',pin0000,8.0,30,'activa',0,nc());
  insTrab.run(e5,'Jódar Bravo','Francisca','23258691X',pin0000,8.0,30,'activa',0,nc());
  insTrab.run(e5,'Periago Montero','María Huertas','23255645T',pin0000,4.0,21,'activa',0,nc());
  insTrab.run(e5,'Sánchez Alonso','María Carmen','23255753Q',pin0000,5.99,21,'activa',0,nc());
  insTrab.run(e5,'Sánchez Giménez','Carmen','23291722J',pin0000,6.0,21,'activa',0,nc());

  // ── TRABAJADORA DE PRUEBA ──
  insTrab.run(e1,'ZPRUEBA TEST','','00000000Z',pin0000,8.0,30,'activa',1,nc());

  console.log('✅ Datos iniciales insertados correctamente');
};

seedData();

// ── Festivos nacionales ────────────────────────────────────
{
  const ins = db.prepare("INSERT OR IGNORE INTO festivos (fecha, nombre, tipo) VALUES (?,?,'nacional')");
  const nacionales = [
    // 2025
    ['2025-01-01','Año Nuevo'],['2025-01-06','Reyes Magos'],
    ['2025-04-17','Jueves Santo'],['2025-04-18','Viernes Santo'],
    ['2025-05-01','Día del Trabajo'],['2025-08-15','Asunción de la Virgen'],
    ['2025-10-12','Fiesta Nacional de España'],['2025-11-01','Todos los Santos'],
    ['2025-12-06','Día de la Constitución'],['2025-12-08','Inmaculada Concepción'],
    ['2025-12-25','Navidad'],
    // 2026
    ['2026-01-01','Año Nuevo'],['2026-01-06','Reyes Magos'],
    ['2026-04-02','Jueves Santo'],['2026-04-03','Viernes Santo'],
    ['2026-05-01','Día del Trabajo'],['2026-08-15','Asunción de la Virgen'],
    ['2026-10-12','Fiesta Nacional de España'],['2026-11-01','Todos los Santos'],
    ['2026-12-06','Día de la Constitución'],['2026-12-08','Inmaculada Concepción'],
    ['2026-12-25','Navidad'],
    // 2027
    ['2027-01-01','Año Nuevo'],['2027-01-06','Reyes Magos'],
    ['2027-03-25','Jueves Santo'],['2027-03-26','Viernes Santo'],
    ['2027-05-01','Día del Trabajo'],['2027-08-15','Asunción de la Virgen'],
    ['2027-10-12','Fiesta Nacional de España'],['2027-11-01','Todos los Santos'],
    ['2027-12-06','Día de la Constitución'],['2027-12-08','Inmaculada Concepción'],
    ['2027-12-25','Navidad'],
  ];
  for (const [f, n] of nacionales) ins.run(f, n);
}

// ============================================================
//  HELPERS AUTENTICACIÓN
// ============================================================

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado' });
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

function adminMiddleware(req, res, next) {
  authMiddleware(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo administradores' });
    next();
  });
}

// ============================================================
//  HELPERS DE FICHAJE
// ============================================================

function calcPausasTotales(fichajeId) {
  const pausas = db.prepare(`SELECT inicio, fin FROM pausas WHERE fichaje_id = ?`).all(fichajeId);
  let total = 0;
  const ahora = nowDB();
  for (const p of pausas) {
    total += diffSeconds(p.inicio, p.fin || ahora);
  }
  return total;
}

/** Días hábiles de un mes (excluye fines de semana y festivos) */
function getWorkingDays(year, month) {
  // month: 1-indexed
  const daysInMonth = new Date(year, month, 0).getDate();
  const monthStr = `${year}-${String(month).padStart(2,'0')}`;
  const festivosSet = new Set(
    db.prepare('SELECT fecha FROM festivos WHERE fecha LIKE ?').all(monthStr + '%').map(f => f.fecha)
  );
  const days = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const dow = new Date(year, month - 1, d).getDay(); // 0=Dom, 6=Sáb
    if (dow === 0 || dow === 6) continue;
    if (festivosSet.has(dateStr)) continue;
    days.push(dateStr);
  }
  return days;
}

/**
 * Horas efectivas para un día concreto.
 * En días normales = horasDiaContrato.
 * En el último día hábil del mes = 169*(horasDia/8) − horas_ya_trabajadas (cuadre).
 */
function getHorasDiaEfectivas(trabajadoraId, horasDiaContrato, fechaMadrid) {
  const [y, m] = fechaMadrid.split('-').map(Number);
  const workingDays = getWorkingDays(y, m);
  if (workingDays.length === 0) return horasDiaContrato;
  const lastDay = workingDays[workingDays.length - 1];
  if (fechaMadrid !== lastDay) return horasDiaContrato;

  // Último día hábil → cuadre mensual
  const totalMes = (horasDiaContrato / 8.0) * 169.0;
  const { total: horasAcum } = db.prepare(`
    SELECT COALESCE(SUM(horas_trabajadas), 0) AS total
    FROM fichajes
    WHERE trabajadora_id = ? AND fecha LIKE ? AND fecha < ? AND hora_salida IS NOT NULL
  `).get(trabajadoraId, fechaMadrid.slice(0, 7) + '%', fechaMadrid);
  return Math.max(0.1, totalMes - horasAcum);
}

function calcHoraFinUTC(fichajeId, horaEntradaUTC, horasDia, trabajadoraId, fechaMadrid) {
  const horas = (trabajadoraId && fechaMadrid)
    ? getHorasDiaEfectivas(trabajadoraId, horasDia, fechaMadrid)
    : horasDia;
  const pausasSeg = calcPausasTotales(fichajeId);
  const totalSeg  = Math.round(horas * 3600) + pausasSeg;
  return addSecondsToDBTime(horaEntradaUTC, totalSeg);
}

function getEstadoTrabajadora(trabajadoraId, fechaMadrid) {
  const fichaje = db.prepare(`
    SELECT * FROM fichajes WHERE trabajadora_id = ? AND fecha = ?
  `).get(trabajadoraId, fechaMadrid);

  if (!fichaje || !fichaje.hora_entrada) {
    return { estado: 'sin_fichar', fichaje: null };
  }
  if (fichaje.hora_salida) {
    return { estado: 'completada', fichaje };
  }
  const pausaActiva = db.prepare(`
    SELECT * FROM pausas WHERE fichaje_id = ? AND fin IS NULL
  `).get(fichaje.id);

  if (pausaActiva) {
    return { estado: 'en_pausa', fichaje, pausa: pausaActiva };
  }
  return { estado: 'en_jornada', fichaje };
}

// ============================================================
//  SMS (Twilio, opcional)
// ============================================================

let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  try {
    twilioClient = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    console.log('✅ Twilio configurado');
  } catch (e) {
    console.warn('⚠️ Twilio no disponible:', e.message);
  }
}

async function enviarSMS(telefono, mensaje) {
  if (!twilioClient || !telefono) return;
  try {
    await twilioClient.messages.create({
      body: mensaje,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: telefono.startsWith('+') ? telefono : '+34' + telefono
    });
    console.log(`📱 SMS enviado a ${telefono}`);
  } catch (e) {
    console.error('Error enviando SMS:', e.message);
  }
}

// ============================================================
//  CRON — CIERRE AUTOMÁTICO DE JORNADAS
// ============================================================

cron.schedule('* * * * *', () => {
  const fecha = todayMadrid();
  const abiertos = db.prepare(`
    SELECT f.id, f.trabajadora_id, f.hora_entrada,
           t.horas_dia, t.telefono,
           t.nombre || ' ' || t.apellidos AS nombre_completo
    FROM fichajes f
    JOIN trabajadoras t ON t.id = f.trabajadora_id
    WHERE f.fecha = ? AND f.hora_salida IS NULL AND f.hora_entrada IS NOT NULL
  `).all(fecha);

  const ahora = nowDB();
  for (const f of abiertos) {
    const horaFin = calcHoraFinUTC(f.id, f.hora_entrada, f.horas_dia, f.trabajadora_id, f.fecha);
    if (ahora >= horaFin) {
      db.prepare(`UPDATE pausas SET fin = ? WHERE fichaje_id = ? AND fin IS NULL`).run(ahora, f.id);
      const pausasSeg = calcPausasTotales(f.id);
      const totalSeg  = diffSeconds(f.hora_entrada, ahora) - pausasSeg;
      const horasTrab = Math.round((totalSeg / 3600) * 100) / 100;
      db.prepare(`
        UPDATE fichajes SET hora_salida = ?, horas_trabajadas = ?, completado_auto = 1 WHERE id = ?
      `).run(ahora, horasTrab, f.id);
      const horaDisplay = fmtMadrid(ahora);
      console.log(`⏰ Jornada cerrada automáticamente: ${f.nombre_completo} a las ${horaDisplay}`);
      enviarSMS(f.telefono,
        `Tu jornada de hoy ha finalizado a las ${horaDisplay}. Descansa, ¡hasta mañana! - Webgest`);
    }
  }
});

// ============================================================
//  API — AUTENTICACIÓN TRABAJADORA
// ============================================================

app.post('/api/login', (req, res) => {
  const { dni, pin } = req.body;
  if (!dni || !pin) return res.status(400).json({ error: 'DNI y PIN requeridos' });

  const t = db.prepare(`
    SELECT t.*, e.nombre AS empresa_nombre
    FROM trabajadoras t JOIN empresas e ON e.id = t.empresa_id
    WHERE UPPER(t.dni) = UPPER(?) AND t.activa = 1
  `).get(dni.trim());

  if (!t || !bcrypt.compareSync(pin, t.pin_hash)) {
    return res.status(401).json({ error: 'DNI o PIN incorrecto' });
  }
  if (t.situacion === 'it') {
    return res.status(403).json({
      error: 'Estás en situación de Incapacidad Temporal. No puedes fichar. Contacta con Webgest: 655588770'
    });
  }

  const token = jwt.sign(
    { id: t.id, role: 'trabajadora', nombre: `${t.nombre} ${t.apellidos}`, empresa: t.empresa_nombre },
    JWT_SECRET, { expiresIn: '12h' }
  );
  res.json({ token, nombre: `${t.nombre} ${t.apellidos}`, empresa: t.empresa_nombre });
});

// ── Login por carnet (QR) ─────────────────────────────────
app.get('/api/carnet/:codigo', (req, res) => {
  const t = db.prepare(`
    SELECT t.*, e.nombre AS empresa_nombre
    FROM trabajadoras t JOIN empresas e ON e.id = t.empresa_id
    WHERE t.codigo_carnet = ? AND t.activa = 1
  `).get(req.params.codigo);

  if (!t) return res.status(404).json({ error: 'Carnet no válido o trabajadora inactiva' });

  if (t.situacion === 'it') {
    return res.status(403).json({
      error: 'Estás en situación de Incapacidad Temporal. No puedes fichar. Contacta con Webgest: 655588770'
    });
  }

  const token = jwt.sign(
    { id: t.id, role: 'trabajadora', nombre: `${t.nombre} ${t.apellidos}`, empresa: t.empresa_nombre },
    JWT_SECRET, { expiresIn: '12h' }
  );
  res.json({ token, nombre: `${t.nombre} ${t.apellidos}`, empresa: t.empresa_nombre });
});

// ============================================================
//  API — AUTENTICACIÓN ADMIN
// ============================================================

app.post('/api/admin/login', (req, res) => {
  const { usuario, password } = req.body;
  if (usuario !== ADMIN_USER || password !== ADMIN_PASS) {
    return res.status(401).json({ error: 'Credenciales incorrectas' });
  }
  const token = jwt.sign({ role: 'admin', usuario }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ token });
});

// ============================================================
//  API — ESTADO Y FICHAJE (TRABAJADORA)
// ============================================================

app.get('/api/fichar/estado', authMiddleware, (req, res) => {
  const fecha = todayMadrid();
  const { estado, fichaje, pausa } = getEstadoTrabajadora(req.user.id, fecha);

  if (estado === 'sin_fichar') return res.json({ estado });

  const t = db.prepare('SELECT horas_dia FROM trabajadoras WHERE id = ?').get(req.user.id);
  const horaFinUTC = calcHoraFinUTC(fichaje.id, fichaje.hora_entrada, t.horas_dia, req.user.id, fecha);

  const resp = {
    estado, fecha,
    fichaje_id:           fichaje.id,
    hora_entrada_display:  fmtMadrid(fichaje.hora_entrada),
    hora_salida_display:   fmtMadrid(fichaje.hora_salida),
    hora_fin_display:      fmtMadrid(horaFinUTC),
    hora_fin_prevista:     horaFinUTC,
    horas_trabajadas:      fichaje.horas_trabajadas,
    completado_auto:       fichaje.completado_auto === 1
  };
  if (pausa) {
    resp.pausa_inicio_display = fmtMadrid(pausa.inicio);
    resp.pausa_inicio_utc     = pausa.inicio;
  }
  return res.json(resp);
});

app.post('/api/fichar/entrada', authMiddleware, (req, res) => {
  const fecha = todayMadrid();
  const { estado } = getEstadoTrabajadora(req.user.id, fecha);
  if (estado !== 'sin_fichar') return res.status(400).json({ error: 'Ya tienes un fichaje activo hoy' });

  const t = db.prepare('SELECT * FROM trabajadoras WHERE id = ?').get(req.user.id);
  if (t.situacion === 'it') return res.status(403).json({ error: 'Estás en IT. No puedes fichar.' });

  const ahora = nowDB();
  const r = db.prepare(`INSERT INTO fichajes (trabajadora_id, fecha, hora_entrada) VALUES (?,?,?)`)
    .run(req.user.id, fecha, ahora);

  const horaFinUTC = calcHoraFinUTC(r.lastInsertRowid, ahora, t.horas_dia, req.user.id, fecha);
  res.json({
    estado:               'en_jornada',
    hora_entrada_display:  fmtMadrid(ahora),
    hora_fin_display:      fmtMadrid(horaFinUTC),
    hora_fin_prevista:     horaFinUTC
  });
});

app.post('/api/fichar/pausa', authMiddleware, (req, res) => {
  const fecha = todayMadrid();
  const { estado, fichaje } = getEstadoTrabajadora(req.user.id, fecha);
  if (estado !== 'en_jornada') return res.status(400).json({ error: 'No estás en jornada activa' });

  const ahora = nowDB();
  db.prepare(`INSERT INTO pausas (fichaje_id, inicio) VALUES (?,?)`).run(fichaje.id, ahora);

  const t = db.prepare('SELECT horas_dia FROM trabajadoras WHERE id = ?').get(req.user.id);
  const horaFinUTC = calcHoraFinUTC(fichaje.id, fichaje.hora_entrada, t.horas_dia, req.user.id, fecha);

  res.json({
    estado:               'en_pausa',
    pausa_inicio_display:  fmtMadrid(ahora),
    hora_fin_display:      fmtMadrid(horaFinUTC),
    hora_fin_prevista:     horaFinUTC
  });
});

app.post('/api/fichar/reanudar', authMiddleware, (req, res) => {
  const fecha = todayMadrid();
  const { estado, fichaje, pausa } = getEstadoTrabajadora(req.user.id, fecha);
  if (estado !== 'en_pausa') return res.status(400).json({ error: 'No estás en pausa' });

  const ahora = nowDB();
  db.prepare(`UPDATE pausas SET fin = ? WHERE id = ?`).run(ahora, pausa.id);

  const t = db.prepare('SELECT horas_dia FROM trabajadoras WHERE id = ?').get(req.user.id);
  const horaFinUTC = calcHoraFinUTC(fichaje.id, fichaje.hora_entrada, t.horas_dia, req.user.id, fecha);

  res.json({
    estado:               'en_jornada',
    reanudar_display:      fmtMadrid(ahora),
    hora_entrada_display:  fmtMadrid(fichaje.hora_entrada),
    hora_fin_display:      fmtMadrid(horaFinUTC),
    hora_fin_prevista:     horaFinUTC
  });
});

app.post('/api/fichar/salida', authMiddleware, (req, res) => {
  const fecha = todayMadrid();
  const { estado, fichaje, pausa } = getEstadoTrabajadora(req.user.id, fecha);
  if (estado === 'sin_fichar' || estado === 'completada') {
    return res.status(400).json({ error: 'No hay jornada activa para cerrar' });
  }

  const ahora = nowDB();
  if (pausa) db.prepare(`UPDATE pausas SET fin = ? WHERE id = ?`).run(ahora, pausa.id);

  const pausasSeg = calcPausasTotales(fichaje.id);
  const totalSeg  = diffSeconds(fichaje.hora_entrada, ahora) - pausasSeg;
  const horasTrab = Math.round((totalSeg / 3600) * 100) / 100;
  db.prepare(`UPDATE fichajes SET hora_salida = ?, horas_trabajadas = ? WHERE id = ?`)
    .run(ahora, horasTrab, fichaje.id);

  const t = db.prepare('SELECT telefono FROM trabajadoras WHERE id = ?').get(req.user.id);
  const horaDisplay = fmtMadrid(ahora);
  enviarSMS(t.telefono,
    `Tu jornada de hoy ha finalizado a las ${horaDisplay}. Descansa, ¡hasta mañana! - Webgest`);

  res.json({ estado: 'completada', hora_salida_display: horaDisplay, horas_trabajadas: horasTrab });
});

app.get('/api/fichar/historial', authMiddleware, (req, res) => {
  const mesActual = todayMadrid().slice(0, 7);
  const registros = db.prepare(`
    SELECT f.*
    FROM fichajes f
    WHERE f.trabajadora_id = ? AND f.fecha LIKE ?
    ORDER BY f.fecha DESC
  `).all(req.user.id, `${mesActual}%`);

  res.json(registros.map(r => ({
    fecha:                r.fecha,
    hora_entrada_display:  fmtMadrid(r.hora_entrada),
    hora_salida_display:   fmtMadrid(r.hora_salida),
    horas_trabajadas:      r.horas_trabajadas,
    completado_auto:       r.completado_auto === 1,
    observaciones:         r.observaciones
  })));
});

// ============================================================
//  API — TABLÓN (TRABAJADORA — solo lectura)
// ============================================================

app.get('/api/tablon', authMiddleware, (req, res) => {
  const mensajes = db.prepare(`
    SELECT id, titulo, contenido, fecha_creacion
    FROM tablon
    WHERE trabajadora_id = ? AND activo = 1
    ORDER BY fecha_creacion DESC
  `).all(req.user.id);
  res.json(mensajes);
});

// ============================================================
//  API — ADMIN — EMPRESAS
// ============================================================

app.get('/api/admin/empresas', adminMiddleware, (req, res) => {
  const todas = req.query.todas === '1';
  const sql = todas
    ? 'SELECT * FROM empresas ORDER BY nombre'
    : 'SELECT * FROM empresas WHERE activa = 1 ORDER BY nombre';
  res.json(db.prepare(sql).all());
});

app.post('/api/admin/empresas', adminMiddleware, (req, res) => {
  const { nombre, nif, ccc } = req.body;
  if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });
  const r = db.prepare(`INSERT INTO empresas (nombre, nif, ccc) VALUES (?,?,?)`)
    .run(nombre, nif || '', ccc || '');
  res.json({ id: r.lastInsertRowid, nombre, nif, ccc });
});

app.put('/api/admin/empresas/:id', adminMiddleware, (req, res) => {
  const { nombre, nif, ccc, activa } = req.body;
  db.prepare(`UPDATE empresas SET nombre=?, nif=?, ccc=?, activa=? WHERE id=?`)
    .run(nombre, nif, ccc, activa !== undefined ? activa : 1, req.params.id);
  res.json({ ok: true });
});

// ============================================================
//  API — ADMIN — TRABAJADORAS
// ============================================================

app.get('/api/admin/trabajadoras', adminMiddleware, (req, res) => {
  const { empresa_id, incluir_inactivas } = req.query;
  let sql = `
    SELECT t.*, e.nombre AS empresa_nombre
    FROM trabajadoras t JOIN empresas e ON e.id = t.empresa_id
    WHERE 1=1
  `;
  const params = [];
  if (empresa_id)        { sql += ' AND t.empresa_id = ?'; params.push(empresa_id); }
  if (!incluir_inactivas) { sql += ' AND t.activa = 1'; }
  sql += ' ORDER BY t.apellidos, t.nombre';
  res.json(db.prepare(sql).all(...params));
});

app.get('/api/admin/trabajadoras/:id', adminMiddleware, (req, res) => {
  const t = db.prepare(`
    SELECT t.*, e.nombre AS empresa_nombre
    FROM trabajadoras t JOIN empresas e ON e.id = t.empresa_id
    WHERE t.id = ?
  `).get(req.params.id);
  if (!t) return res.status(404).json({ error: 'No encontrada' });
  res.json(t);
});

app.post('/api/admin/trabajadoras', adminMiddleware, (req, res) => {
  const { empresa_id, nombre, apellidos, dni, pin, horas_dia, dias_mes, telefono, situacion } = req.body;
  if (!empresa_id || !nombre || !dni || !pin) {
    return res.status(400).json({ error: 'Faltan campos obligatorios' });
  }
  const pin_hash = bcrypt.hashSync(pin, 10);
  const codigo_carnet = crypto.randomBytes(6).toString('hex');
  try {
    const r = db.prepare(`
      INSERT INTO trabajadoras (empresa_id, nombre, apellidos, dni, pin_hash, horas_dia, dias_mes, telefono, situacion, codigo_carnet)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(empresa_id, nombre, apellidos || '', dni.toUpperCase(), pin_hash,
           horas_dia || 8.0, dias_mes || 30, telefono || null,
           situacion || 'activa', codigo_carnet);
    res.json({ id: r.lastInsertRowid });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: 'DNI ya existe' });
    throw e;
  }
});

app.put('/api/admin/trabajadoras/:id', adminMiddleware, (req, res) => {
  const { empresa_id, nombre, apellidos, horas_dia, dias_mes, telefono, situacion, activa, pin } = req.body;
  const t = db.prepare('SELECT * FROM trabajadoras WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'No encontrada' });

  const pin_hash = pin ? bcrypt.hashSync(pin, 10) : t.pin_hash;
  db.prepare(`
    UPDATE trabajadoras
    SET empresa_id=?, nombre=?, apellidos=?, horas_dia=?, dias_mes=?, telefono=?,
        situacion=?, activa=?, pin_hash=?
    WHERE id=?
  `).run(
    empresa_id !== undefined ? empresa_id : t.empresa_id,
    nombre    || t.nombre,
    apellidos !== undefined ? apellidos : t.apellidos,
    horas_dia !== undefined ? horas_dia : t.horas_dia,
    dias_mes  !== undefined ? dias_mes  : t.dias_mes,
    telefono  !== undefined ? telefono  : t.telefono,
    situacion || t.situacion,
    activa    !== undefined ? activa    : t.activa,
    pin_hash, req.params.id
  );

  db.prepare(`
    INSERT INTO auditoria (tabla, registro_id, campo, valor_antes, valor_despues, usuario, fecha, motivo)
    VALUES ('trabajadoras', ?, 'modificacion', ?, ?, 'admin', ?, ?)
  `).run(req.params.id,
    JSON.stringify({ nombre: t.nombre, situacion: t.situacion, empresa_id: t.empresa_id }),
    JSON.stringify({ nombre: nombre || t.nombre, situacion: situacion || t.situacion, empresa_id: empresa_id || t.empresa_id }),
    nowDB(), req.body.motivo || null
  );

  res.json({ ok: true });
});

// Regenerar código de carnet
app.post('/api/admin/trabajadoras/:id/regenerar-carnet', adminMiddleware, (req, res) => {
  const nuevo = crypto.randomBytes(6).toString('hex');
  db.prepare('UPDATE trabajadoras SET codigo_carnet = ? WHERE id = ?').run(nuevo, req.params.id);
  res.json({ codigo_carnet: nuevo });
});

// ============================================================
//  API — ADMIN — FESTIVOS
// ============================================================

app.get('/api/admin/festivos', adminMiddleware, (req, res) => {
  const año = req.query.año || new Date().getUTCFullYear();
  res.json(db.prepare('SELECT * FROM festivos WHERE fecha LIKE ? ORDER BY fecha').all(`${año}%`));
});

app.post('/api/admin/festivos', adminMiddleware, (req, res) => {
  const { fecha, nombre } = req.body;
  if (!fecha || !nombre) return res.status(400).json({ error: 'Fecha y nombre requeridos' });
  try {
    const r = db.prepare("INSERT INTO festivos (fecha, nombre, tipo) VALUES (?,?,'local')").run(fecha, nombre);
    res.json({ id: r.lastInsertRowid, fecha, nombre, tipo: 'local' });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: 'Ya existe un festivo en esa fecha' });
    throw e;
  }
});

app.delete('/api/admin/festivos/:id', adminMiddleware, (req, res) => {
  const f = db.prepare('SELECT tipo FROM festivos WHERE id = ?').get(req.params.id);
  if (!f) return res.status(404).json({ error: 'No encontrado' });
  if (f.tipo === 'nacional') return res.status(403).json({ error: 'No se pueden eliminar festivos nacionales predefinidos' });
  db.prepare('DELETE FROM festivos WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Días hábiles de un mes (útil para el panel admin)
app.get('/api/admin/dias-habiles', adminMiddleware, (req, res) => {
  const { año, mes } = req.query;
  if (!año || !mes) return res.status(400).json({ error: 'Parámetros año y mes requeridos' });
  const dias = getWorkingDays(parseInt(año), parseInt(mes));
  res.json({ dias, total: dias.length });
});

// ============================================================
//  API — ADMIN — CARNETS (impresión masiva QR)
// ============================================================

app.get('/api/admin/carnets', adminMiddleware, (req, res) => {
  const { empresa_id } = req.query;
  let sql = `
    SELECT t.id, t.nombre, t.apellidos, t.dni, t.horas_dia, t.situacion,
           t.codigo_carnet, e.nombre AS empresa_nombre, e.id AS empresa_id
    FROM trabajadoras t
    JOIN empresas e ON e.id = t.empresa_id
    WHERE t.activa = 1 AND t.es_prueba = 0
  `;
  const params = [];
  if (empresa_id) { sql += ' AND t.empresa_id = ?'; params.push(empresa_id); }
  sql += ' ORDER BY e.nombre, t.apellidos, t.nombre';
  res.json(db.prepare(sql).all(...params));
});

// ============================================================
//  API — ADMIN — TABLÓN
// ============================================================

app.get('/api/admin/tablon/:trabajadora_id', adminMiddleware, (req, res) => {
  const mensajes = db.prepare(`
    SELECT * FROM tablon
    WHERE trabajadora_id = ? AND activo = 1
    ORDER BY fecha_creacion DESC
  `).all(req.params.trabajadora_id);
  res.json(mensajes);
});

app.post('/api/admin/tablon/:trabajadora_id', adminMiddleware, (req, res) => {
  const { titulo, contenido } = req.body;
  if (!titulo || !contenido) return res.status(400).json({ error: 'Título y contenido requeridos' });
  const r = db.prepare(`
    INSERT INTO tablon (trabajadora_id, titulo, contenido, fecha_creacion) VALUES (?,?,?,?)
  `).run(req.params.trabajadora_id, titulo, contenido, nowDB());
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/admin/tablon/:id', adminMiddleware, (req, res) => {
  const { titulo, contenido } = req.body;
  db.prepare(`UPDATE tablon SET titulo=?, contenido=? WHERE id=?`)
    .run(titulo, contenido, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/admin/tablon/:id', adminMiddleware, (req, res) => {
  db.prepare(`UPDATE tablon SET activo = 0 WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// ============================================================
//  API — ADMIN — FICHAJES
// ============================================================

app.get('/api/admin/fichajes', adminMiddleware, (req, res) => {
  const { empresa_id, trabajadora_id, fecha_desde, fecha_hasta } = req.query;
  let sql = `
    SELECT f.*,
           t.nombre || ' ' || t.apellidos AS trabajadora_nombre,
           t.dni, e.nombre AS empresa_nombre
    FROM fichajes f
    JOIN trabajadoras t ON t.id = f.trabajadora_id
    JOIN empresas e ON e.id = t.empresa_id
    WHERE t.es_prueba = 0
  `;
  const params = [];
  if (empresa_id)     { sql += ' AND t.empresa_id = ?'; params.push(empresa_id); }
  if (trabajadora_id) { sql += ' AND f.trabajadora_id = ?'; params.push(trabajadora_id); }
  if (fecha_desde)    { sql += ' AND f.fecha >= ?'; params.push(fecha_desde); }
  if (fecha_hasta)    { sql += ' AND f.fecha <= ?'; params.push(fecha_hasta); }
  sql += ' ORDER BY f.fecha DESC, t.apellidos';

  res.json(db.prepare(sql).all(...params).map(r => ({
    ...r,
    hora_entrada_display: fmtMadrid(r.hora_entrada),
    hora_salida_display:  fmtMadrid(r.hora_salida)
  })));
});

app.get('/api/admin/estado-dia', adminMiddleware, (req, res) => {
  const fecha = todayMadrid();
  const { empresa_id } = req.query;
  let sql = `
    SELECT t.id, t.nombre, t.apellidos, t.dni, t.situacion, t.horas_dia, t.es_prueba,
           e.nombre AS empresa_nombre, e.id AS empresa_id,
           f.hora_entrada, f.hora_salida, f.id AS fichaje_id
    FROM trabajadoras t
    JOIN empresas e ON e.id = t.empresa_id
    LEFT JOIN fichajes f ON f.trabajadora_id = t.id AND f.fecha = ?
    WHERE t.activa = 1 AND t.es_prueba = 0
  `;
  const params = [fecha];
  if (empresa_id) { sql += ' AND t.empresa_id = ?'; params.push(empresa_id); }
  sql += ' ORDER BY e.nombre, t.apellidos';

  res.json(db.prepare(sql).all(...params).map(r => {
    let estado = 'sin_fichar';
    if (r.situacion === 'it') estado = 'it';
    else if (r.situacion === 'baja') estado = 'baja';
    else if (r.situacion === 'vacaciones') estado = 'vacaciones';
    else if (r.hora_salida) estado = 'completada';
    else if (r.hora_entrada) {
      const pausaActiva = r.fichaje_id
        ? db.prepare('SELECT id FROM pausas WHERE fichaje_id = ? AND fin IS NULL').get(r.fichaje_id)
        : null;
      estado = pausaActiva ? 'en_pausa' : 'en_jornada';
    }
    return {
      ...r, estado,
      hora_entrada_display: fmtMadrid(r.hora_entrada),
      hora_salida_display:  fmtMadrid(r.hora_salida)
    };
  }));
});

// Modificar fichaje (admin) — acepta hora Madrid con madrid_time:true
app.put('/api/admin/fichajes/:id', adminMiddleware, (req, res) => {
  const { hora_entrada, hora_salida, observaciones, motivo, madrid_time } = req.body;
  if (!motivo) return res.status(400).json({ error: 'El motivo de modificación es obligatorio' });

  const f = db.prepare('SELECT * FROM fichajes WHERE id = ?').get(req.params.id);
  if (!f) return res.status(404).json({ error: 'Fichaje no encontrado' });

  const ahora = nowDB();
  let nuevaEntrada = hora_entrada ? `${f.fecha} ${hora_entrada}` : f.hora_entrada;
  let nuevaSalida  = hora_salida  ? `${f.fecha} ${hora_salida}`  : f.hora_salida;

  // Si vienen en hora Madrid, convertir a UTC
  if (madrid_time) {
    if (hora_entrada) nuevaEntrada = madridToUTC(f.fecha, hora_entrada) || nuevaEntrada;
    if (hora_salida)  nuevaSalida  = madridToUTC(f.fecha, hora_salida)  || nuevaSalida;
  }

  let horasTrab = f.horas_trabajadas;
  if (nuevaEntrada && nuevaSalida) {
    const pausasSeg = calcPausasTotales(f.id);
    const totalSeg  = diffSeconds(nuevaEntrada, nuevaSalida) - pausasSeg;
    horasTrab = Math.round((totalSeg / 3600) * 100) / 100;
  }

  db.prepare(`
    UPDATE fichajes
    SET hora_entrada=?, hora_salida=?, horas_trabajadas=?,
        observaciones=?, modificado_por='admin', modificado_en=?, motivo_modificacion=?
    WHERE id=?
  `).run(nuevaEntrada, nuevaSalida, horasTrab,
         observaciones || f.observaciones, ahora, motivo, req.params.id);

  db.prepare(`
    INSERT INTO auditoria (tabla, registro_id, campo, valor_antes, valor_despues, usuario, fecha, motivo)
    VALUES ('fichajes', ?, 'modificacion', ?, ?, 'admin', ?, ?)
  `).run(req.params.id,
    JSON.stringify({ hora_entrada: f.hora_entrada, hora_salida: f.hora_salida }),
    JSON.stringify({ hora_entrada: nuevaEntrada, hora_salida: nuevaSalida }),
    ahora, motivo);

  res.json({ ok: true, horas_trabajadas: horasTrab });
});

// ============================================================
//  API — ADMIN — EXPORTACIÓN PDF (RD-ley 8/2019)
// ============================================================

app.get('/api/admin/pdf/:trabajadora_id', adminMiddleware, (req, res) => {
  const mesStr = req.query.mes || todayMadrid().slice(0, 7);
  const t = db.prepare(`
    SELECT t.*, e.nombre AS empresa_nombre, e.nif AS empresa_nif
    FROM trabajadoras t JOIN empresas e ON e.id = t.empresa_id WHERE t.id = ?
  `).get(req.params.trabajadora_id);
  if (!t) return res.status(404).json({ error: 'Trabajadora no encontrada' });

  const fichajes = db.prepare(`
    SELECT * FROM fichajes WHERE trabajadora_id = ? AND fecha LIKE ? ORDER BY fecha ASC
  `).all(req.params.trabajadora_id, `${mesStr}%`);

  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition',
    `attachment; filename="registro_jornada_${t.dni}_${mesStr}.pdf"`);
  doc.pipe(res);

  doc.fontSize(16).font('Helvetica-Bold').text('REGISTRO DE JORNADA', { align: 'center' });
  doc.fontSize(10).font('Helvetica').text('(Art. 34.9 ET — RD-ley 8/2019)', { align: 'center' });
  doc.moveDown();
  doc.fontSize(11).font('Helvetica-Bold').text('Empresa:')
     .font('Helvetica').text(`${t.empresa_nombre} — NIF: ${t.empresa_nif || '—'}`);
  doc.moveDown(0.3);
  doc.font('Helvetica-Bold').text('Trabajador/a:')
     .font('Helvetica').text(`${t.apellidos}, ${t.nombre} — DNI: ${t.dni}`);
  doc.moveDown(0.3);
  doc.font('Helvetica-Bold').text('Período:').font('Helvetica').text(mesStr);
  doc.moveDown();

  const colX = [50, 130, 210, 290, 360, 430];
  const heads = ['Fecha', 'Entrada', 'Salida', 'Horas', 'Auto', 'Observaciones'];
  doc.font('Helvetica-Bold').fontSize(10);
  heads.forEach((h, i) => doc.text(h, colX[i], doc.y, { continued: i < heads.length - 1, width: 80 }));
  doc.moveDown(0.3);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
  doc.moveDown(0.3);

  let totalHoras = 0;
  doc.font('Helvetica').fontSize(9);
  for (const f of fichajes) {
    const y = doc.y;
    doc.text(f.fecha,                         colX[0], y, { width: 75 });
    doc.text(fmtMadrid(f.hora_entrada),        colX[1], y, { width: 70 });
    doc.text(fmtMadrid(f.hora_salida),         colX[2], y, { width: 70 });
    doc.text(f.horas_trabajadas ? f.horas_trabajadas.toFixed(2) : '—', colX[3], y, { width: 60 });
    doc.text(f.completado_auto ? 'Sí' : '',    colX[4], y, { width: 55 });
    doc.text(f.observaciones || '',            colX[5], y, { width: 115 });
    doc.moveDown(0.8);
    totalHoras += f.horas_trabajadas || 0;
  }

  doc.moveDown();
  doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
  doc.moveDown(0.3);
  doc.font('Helvetica-Bold').fontSize(10)
     .text(`TOTAL HORAS MES: ${totalHoras.toFixed(2)} h`, { align: 'right' });
  doc.moveDown(2);
  doc.font('Helvetica').fontSize(9).text(
    'Este documento se genera automáticamente por el sistema de control horario de Webgest ' +
    'en cumplimiento del art. 34.9 del Estatuto de los Trabajadores (RD-ley 8/2019). ' +
    'Se conservará durante un mínimo de 4 años.', { align: 'justify' }
  );
  doc.end();
});

// ============================================================
//  SPA — Servir index para rutas no-API
// ============================================================

app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'No encontrado' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================
//  ARRANQUE
// ============================================================

app.listen(PORT, () => {
  console.log(`🚀 Control Horario 1 escuchando en puerto ${PORT}`);
  console.log(`📅 Fecha Madrid: ${todayMadrid()}`);
});
