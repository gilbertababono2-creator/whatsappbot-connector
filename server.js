import express from "express";
import cors from "cors";
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: "*",,
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"],
}));
app.use(express.json());

const logger = pino({ level: "silent" });

// ── Cache the WA version so we don't fetch it on every request ─────────────
let cachedVersion = null;
async function getWAVersion() {
  if (!cachedVersion) {
    const { version } = await fetchLatestBaileysVersion();
    cachedVersion = version;
    // Refresh every 6 hours
    setTimeout(() => { cachedVersion = null; }, 6 * 60 * 60 * 1000);
  }
  return cachedVersion;
}
// Pre-fetch on startup so first user gets instant response
getWAVersion().catch(() => {});

// ── Session store ──────────────────────────────────────────────────────────
const sessions = new Map();
const MAX_SESSIONS = 50;
const SESSION_TIMEOUT_MS = 8 * 60 * 1000; // 8 minutes

function cleanupSessions() {
  const now = Date.now();
  for (const [phone, session] of sessions.entries()) {
    if (now - session.createdAt > SESSION_TIMEOUT_MS) {
      try { session.socket?.end(); } catch (_) {}
      sessions.delete(phone);
      const authDir = path.join(__dirname, "sessions", phone);
      if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
    }
  }
}
setInterval(cleanupSessions, 60_000);

// ── Self-ping to prevent Render cold starts ────────────────────────────────
const SELF_URL = process.env.RENDER_EXTERNAL_URL || null;
if (SELF_URL) {
  setInterval(async () => {
    try {
      await fetch(`${SELF_URL}/ping`);
    } catch (_) {}
  }, 4 * 60 * 1000); // every 4 minutes
}

// ── Routes ─────────────────────────────────────────────────────────────────
app.get("/ping", (_, res) => res.send("pong"));

app.get("/", (_, res) => res.json({
  status: "online",
  service: "WhatsApp Pair Server v2",
  sessions: sessions.size,
  maxSessions: MAX_SESSIONS,
  uptime: Math.floor(process.uptime()),
}));

app.get("/status", (_, res) => res.json({
  active: sessions.size,
  limit: MAX_SESSIONS,
  available: MAX_SESSIONS - sessions.size,
  uptime: Math.floor(process.uptime()),
  version: "2.0.0",
}));

// ── Generate Pairing Code ──────────────────────────────────────────────────
app.post("/generate-pair", async (req, res) => {
  let { phone } = req.body;

  if (!phone) return res.status(400).json({ error: "Phone number is required." });

  phone = phone.replace(/\D/g, "");
  if (phone.length < 7 || phone.length > 15)
    return res.status(400).json({ error: "Invalid phone number." });

  if (sessions.size >= MAX_SESSIONS && !sessions.has(phone))
    return res.status(503).json({ error: "Server at capacity. Try again later." });

  // Return cached fresh code
  if (sessions.has(phone)) {
    const ex = sessions.get(phone);
    if (ex.pairingCode && Date.now() - ex.createdAt < SESSION_TIMEOUT_MS) {
      return res.json({ pairingCode: ex.pairingCode, phone, cached: true });
    }
    try { ex.socket?.end(); } catch (_) {}
    sessions.delete(phone);
    const authDir = path.join(__dirname, "sessions", phone);
    if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
  }

  // Setup auth state
  const authDir = path.join(__dirname, "sessions", phone);
  fs.mkdirSync(authDir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  let version;
  try {
    version = await getWAVersion();
  } catch {
    version = [2, 3000, 1015901307]; // fallback version
  }

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    browser: ["Ubuntu", "Chrome", "20.0.04"],
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
    connectTimeoutMs: 20_000,
    keepAliveIntervalMs: 10_000,
    retryRequestDelayMs: 500,
  });

  sessions.set(phone, {
    socket: sock,
    pairingCode: null,
    status: "connecting",
    createdAt: Date.now(),
  });

  sock.ev.on("creds.update", saveCreds);

  try {
    const pairingCode = await Promise.race([
      new Promise((resolve, reject) => {
        let codeRequested = false;

        sock.ev.on("connection.update", async (update) => {
          const { connection, lastDisconnect, isOnline } = update;

          // Request code as soon as we get any connection signal
          if (!codeRequested && !sock.authState.creds.registered) {
            codeRequested = true;
            try {
              const code = await sock.requestPairingCode(phone);
              const formatted = code?.match(/.{1,4}/g)?.join("-") || code;
              if (sessions.has(phone)) {
                sessions.get(phone).pairingCode = formatted;
                sessions.get(phone).status = "paired";
              }
              resolve(formatted);
            } catch (err) {
              // Retry once after 1.5s
              setTimeout(async () => {
                try {
                  const code = await sock.requestPairingCode(phone);
                  const formatted = code?.match(/.{1,4}/g)?.join("-") || code;
                  if (sessions.has(phone)) {
                    sessions.get(phone).pairingCode = formatted;
                    sessions.get(phone).status = "paired";
                  }
                  resolve(formatted);
                } catch (retryErr) {
                  reject(retryErr);
                }
              }, 1500);
            }
          }

          if (connection === "open") resolve("ALREADY_LINKED");

          if (connection === "close") {
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            if (reason === DisconnectReason.loggedOut) reject(new Error("Logged out."));
          }
        });
      }),

      // 25 second timeout
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Timed out. Please try again.")), 25_000)
      ),
    ]);

    res.json({ pairingCode, phone });

  } catch (err) {
    sessions.delete(phone);
    try { sock.end(); } catch (_) {}
    const authDir2 = path.join(__dirname, "sessions", phone);
    if (fs.existsSync(authDir2)) fs.rmSync(authDir2, { recursive: true, force: true });
    res.status(500).json({ error: err.message || "Failed to generate code." });
  }
});

// ── Session info ───────────────────────────────────────────────────────────
app.get("/session/:phone", (req, res) => {
  const phone = req.params.phone.replace(/\D/g, "");
  const s = sessions.get(phone);
  if (!s) return res.json({ exists: false });
  res.json({ exists: true, status: s.status, pairingCode: s.pairingCode, age: Date.now() - s.createdAt });
});

app.listen(PORT, () => {
  console.log(`\n🤖 WhatsApp Pair Server v2 on port ${PORT}`);
  console.log(`📊 Max sessions: ${MAX_SESSIONS}`);
  console.log(`🌐 Self-ping: ${SELF_URL ? "enabled" : "disabled (set RENDER_EXTERNAL_URL)"}\n`);
});
