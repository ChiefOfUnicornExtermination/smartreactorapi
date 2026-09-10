process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled promise rejection:', reason);
});

require('dotenv').config();
const express = require('express');
const mqtt    = require('mqtt');
const cors    = require('cors');
const mariadb = require('mariadb');

// Validate required env vars early
if (!process.env.JWT_SECRET && process.env.NODE_ENV === 'production') {
  console.error('ERROR: JWT_SECRET environment variable not set in production!');
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use(cors());

// ─────────────────────────────────────────────────────────────────────────────
// Database
// ─────────────────────────────────────────────────────────────────────────────

const dbPool = mariadb.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'smartdevice',
  password: process.env.DB_PASSWORD || 'password',
  database: 'smartdevice',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  idleTimeout: 60000
});

async function testDatabase() {
  try {
    const conn = await dbPool.getConnection();
    await conn.query('SELECT 1');
    conn.release();
    console.log('✓ Database connected successfully');
  } catch (err) {
    console.error('✗ DATABASE CONNECTION FAILED:', err.message);
  }
}
setTimeout(() => testDatabase(), 1000);

async function ensureProvisionTable() {
  try {
    const conn = await dbPool.getConnection();
    await conn.query(`
      CREATE TABLE IF NOT EXISTS provision_sessions (
        id VARCHAR(36) PRIMARY KEY,
        user_id BIGINT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME NOT NULL,
        claimed_device_id VARCHAR(64) DEFAULT NULL,
        status ENUM('active','claimed','expired') DEFAULT 'active',
        INDEX (status),
        INDEX (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    conn.release();
    console.log('✓ provision_sessions table ready');
  } catch (err) {
    console.error('Failed to ensure provision_sessions table:', err.message);
  }
}
setTimeout(() => ensureProvisionTable(), 1500);

// ─────────────────────────────────────────────────────────────────────────────
// MQTT
// ─────────────────────────────────────────────────────────────────────────────

const MQTT_HOST = process.env.MQTT_HOST || '127.0.0.1';
const MQTT_PORT = process.env.MQTT_PORT || 1883;
const MQTT_CLIENT_ID = 'rest-bridge-' + Math.random().toString(16).substr(2, 8);

const deviceState = {};
const pendingStatusWaiters = new Map();

function waitForStatus(deviceId, type, expectedValue, timeoutMs = 5000) {
  const key = `${deviceId}:${type}`;
  return new Promise((resolve, reject) => {
    const entry = { expected: expectedValue, resolve, reject };
    if (!pendingStatusWaiters.has(key)) pendingStatusWaiters.set(key, []);
    pendingStatusWaiters.get(key).push(entry);
    entry.timeoutId = setTimeout(() => {
      const arr = pendingStatusWaiters.get(key) || [];
      const idx = arr.indexOf(entry);
      if (idx !== -1) arr.splice(idx, 1);
      if (arr.length === 0) pendingStatusWaiters.delete(key);
      reject(new Error('timeout waiting for device status'));
    }, timeoutMs);
  });
}

const mqttClient = mqtt.connect({
  protocol: 'mqtt',
  host: MQTT_HOST,
  port: MQTT_PORT,
  clientId: MQTT_CLIENT_ID,
  clean: true,
  connectTimeout: 4000,
  reconnectPeriod: 1000,
  family: 4,
});

mqttClient.on('connect', () => {
  console.log('✓ Connected to MQTT broker');
  mqttClient.subscribe('device-+/light/status');
  mqttClient.subscribe('device-+/motor/status');
  mqttClient.subscribe('device-+/rgb/status');
  mqttClient.subscribe('device-+/online');
});

mqttClient.on('message', async (topic, message) => {
  const payload = message.toString();
  const parts = topic.split('/');
  const deviceId = parts[0];
  if (!deviceState[deviceId]) deviceState[deviceId] = {};

  if (parts.length === 2 && parts[1] === 'online') {
    deviceState[deviceId].online = (payload === 'online');
    if (payload === 'online') deviceState[deviceId].lastSeen = new Date().toISOString();
    return;
  }
  if (parts.length !== 3) return;

  const type = parts[1];
  deviceState[deviceId][type] = payload;
  deviceState[deviceId].lastSeen = new Date().toISOString();

  const key = `${deviceId}:${type}`;
  const waiters = pendingStatusWaiters.get(key) || [];
  for (const w of waiters.slice()) {
    if (w.expected === null || String(w.expected) === String(payload)) {
      clearTimeout(w.timeoutId);
      try { w.resolve(payload); } catch (_) {}
      const arr = pendingStatusWaiters.get(key) || [];
      const idx = arr.indexOf(w);
      if (idx !== -1) arr.splice(idx, 1);
    }
  }
  if (pendingStatusWaiters.has(key) && pendingStatusWaiters.get(key).length === 0) {
    pendingStatusWaiters.delete(key);
  }

  try {
    const conn = await dbPool.getConnection();
    await conn.query('INSERT INTO device_logs (device_id, action) VALUES (?, ?)', [deviceId, `${type}_${payload}`]);
    conn.release();
  } catch (err) {
    console.error('Failed to log device action:', err.message);
  }
});

mqttClient.on('error', (err) => console.error('MQTT error:', err.message));

// ─────────────────────────────────────────────────────────────────────────────
// Share DB pool, MQTT client, and device state with all routes via app.locals
// ─────────────────────────────────────────────────────────────────────────────

app.locals.db          = dbPool;
app.locals.mqttClient  = mqttClient;
app.locals.deviceState = deviceState;

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

app.get('/', (req, res) => res.json({ message: 'Smart Device REST API' }));

app.use('/auth',      require('./routes/auth'));
app.use('/devices',   require('./routes/devices'));
app.use('/provision', require('./routes/provision'));
app.use('/firmware',  require('./routes/ota'));
app.use('/store',     require('./routes/store.js'));
app.use('/catalog',   require('./routes/catalog'));

// ─────────────────────────────────────────────────────────────────────────────
// Health + debug
// ─────────────────────────────────────────────────────────────────────────────

app.get('/health', async (req, res) => {
  let dbStatus = 'ok', dbError = null;
  try { const conn = await dbPool.getConnection(); await conn.query('SELECT 1'); conn.release(); } catch (err) { dbStatus = 'error'; dbError = err.message; }
  res.json({ status: 'ok', mqtt: MQTT_HOST + ':' + MQTT_PORT, database: dbStatus, database_error: dbError });
});

app.get('/debug/db-test', async (req, res) => {
  const result = { config: { host: process.env.DB_HOST || 'localhost', user: process.env.DB_USER || 'smartdevice', database: 'smartdevice' }, connection: null, devices: null, error: null };
  try {
    const conn = await dbPool.getConnection();
    result.connection = 'success';
    result.devices = await conn.query('SELECT id, name, type FROM devices');
    conn.release();
  } catch (err) { result.error = err.message; }
  res.json(result);
});
// ─────────────────────────────────────────────────────────────────────────────
// 404 + Start
// ─────────────────────────────────────────────────────────────────────────────

app.use((req, res) => res.status(404).json({ error: 'endpoint not found' }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n--- Smart Device API ---`);
  console.log(`🚀 Listening on port ${PORT}`);
  console.log(`📡 MQTT: ${MQTT_HOST}:${MQTT_PORT}`);
  console.log(`🗄️  DB:   ${process.env.DB_HOST || 'localhost'}`);
});

process.on('SIGINT', () => { mqttClient.end(); process.exit(0); });
