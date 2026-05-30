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

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || "*",
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"],
}));
app.use(express.json());

// ── Logger (silent in production to avoid noise) ───────────────────────────
const logger = pino({ level: "silent" });

// ── In-memory session tracker ──────────────────────────────────────────────
// sessions: Map<phoneNumber, { socket, pairingCode, status, createdAt }>
const sessions = new Map();
const MAX_SESSIONS = 50;
const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ── Cleanup expired sessions ───────────────────────────────────────────────
function cleanupSessions() {
  const now = Date.now();
  for (const [phone, session] of sessions.entries()) {
    if (now - session.createdAt > SESSION_TIMEOUT_MS) {
      try {
        session.socket?.end();
      } catch (_) {}
      sessions.delete(phone);
      // Remove auth files
      const authDir = path.join(__dirname, "sessions", phone);
      if (fs.existsSync(authDir)) {
        fs.rmSync(authDir, { recursive: true, force: true });
      }
    }
  }
}
setInterval(cleanupSessions, 60_000);

// ── Health check ───────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "online",
    service: "WhatsApp Pair Server",
    version: "1.0.0",
    sessions: sessions.size,
    maxSessions: MAX_SESSIONS,
  });
});

// ── Server status ──────────────────────────────────────────────────────────
app.get("/status", (req, res) => {
  res.json({
    active: sessions.size,
    limit: MAX_SESSIONS,
    available: MAX_SESSIONS - sessions.size,
    uptime: process.uptime(),
  });
});

// ── Generate Pairing Code ──────────────────────────────────────────────────
app.post("/generate-pair", async (req, res) => {
  let { phone } = req.body;

  // ── Validate phone ─────────────────────────────────────────────────────
  if (!phone) {
    return res.status(400).json({ error: "Phone number is required." });
  }

  // Strip all non-numeric characters
  phone = phone.replace(/\D/g, "");

  if (phone.length < 7 || phone.length > 15) {
    return res.status(400).json({ error: "Invalid phone number length." });
  }

  // ── Check capacity ─────────────────────────────────────────────────────
  if (sessions.size >= MAX_SESSIONS && !sessions.has(phone)) {
    return res.status(503).json({ error: "Server is at capacity. Try again later." });
  }

  // ── Reuse existing session if fresh ───────────────────────────────────
  if (sessions.has(phone)) {
    const existing = sessions.get(phone);
    if (existing.pairingCode && Date.now() - existing.createdAt < SESSION_TIMEOUT_MS) {
      return res.json({ pairingCode: existing.pairingCode, cached: true });
    }
    // Expired — clean up
    try { existing.socket?.end(); } catch (_) {}
    sessions.delete(phone);
  }

  // ── Auth state (per-phone directory) ──────────────────────────────────
  const authDir = path.join(__dirname, "sessions", phone);
  fs.mkdirSync(authDir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  // ── Fetch latest Baileys version ───────────────────────────────────────
  const { version } = await fetchLatestBaileysVersion();

  // ── Create socket ──────────────────────────────────────────────────────
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
  });

  // Register session
  sessions.set(phone, {
    socket: sock,
    pairingCode: null,
    status: "connecting",
    createdAt: Date.now(),
  });

  sock.ev.on("creds.update", saveCreds);

  // ── Wait for pairing code ──────────────────────────────────────────────
  let pairingCode = null;
  const pairingTimeout = 30_000; // 30s

  try {
    pairingCode = await Promise.race([
      new Promise((resolve, reject) => {
        sock.ev.on("connection.update", async (update) => {
          const { connection, lastDisconnect, isNewLogin } = update;

          if (connection === "open") {
            // Already registered — no code needed
            resolve("ALREADY_LINKED");
          }

          if (connection === "close") {
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            if (reason === DisconnectReason.loggedOut) {
              reject(new Error("Session logged out."));
            }
          }
        });

        // Request pairing code once socket is ready
        setTimeout(async () => {
          try {
            if (!sock.authState.creds.registered) {
              const code = await sock.requestPairingCode(phone);
              // Format as XXXX-XXXX
              const formatted = code?.match(/.{1,4}/g)?.join("-") || code;
              sessions.get(phone).pairingCode = formatted;
              sessions.get(phone).status = "paired";
              resolve(formatted);
            }
          } catch (err) {
            reject(err);
          }
        }, 3000);
      }),

      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Pairing code request timed out.")), pairingTimeout)
      ),
    ]);
  } catch (err) {
    sessions.delete(phone);
    try { sock.end(); } catch (_) {}
    return res.status(500).json({ error: err.message || "Failed to generate pairing code." });
  }

  res.json({ pairingCode, phone });
});

// ── Check session status ───────────────────────────────────────────────────
app.get("/session/:phone", (req, res) => {
  const phone = req.params.phone.replace(/\D/g, "");
  const session = sessions.get(phone);
  if (!session) {
    return res.json({ exists: false });
  }
  res.json({
    exists: true,
    status: session.status,
    pairingCode: session.pairingCode,
    age: Date.now() - session.createdAt,
  });
});

// ── Start server ───────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🤖 WhatsApp Pair Server running on port ${PORT}`);
  console.log(`📊 Max sessions: ${MAX_SESSIONS}`);
  console.log(`🌐 Health: http://localhost:${PORT}/\n`);
});
