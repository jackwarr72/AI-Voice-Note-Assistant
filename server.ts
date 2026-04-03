import express from "express";
import { createServer as createViteServer } from "vite";
import { Server as SocketServer } from "socket.io";
import { createServer as createHttpServer } from "http";
import path from "path";
import { fileURLToPath } from "url";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import makeWASocket, { 
  useMultiFileAuthState, 
  DisconnectReason, 
  fetchLatestBaileysVersion, 
  downloadMediaMessage,
  AuthenticationState,
  AuthenticationCreds,
  SignalDataTypeMap,
  proto
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import fs from "fs";
import pino from "pino";

const logger = pino({ level: "info" });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load Firebase Config
const firebaseConfig = JSON.parse(fs.readFileSync(path.join(process.cwd(), "firebase-applet-config.json"), "utf8"));

// Initialize Firebase Admin
if (!getApps().length) {
  initializeApp({
    projectId: firebaseConfig.projectId,
  });
}

const db = getFirestore(firebaseConfig.firestoreDatabaseId);

async function startServer() {
  const app = express();
  const httpServer = createHttpServer(app);
  const io = new SocketServer(httpServer, {
    cors: { origin: "*" }
  });

  const PORT = 3000;

  // WhatsApp Session Management
  const sessions = new Map<string, any>();

  // Custom Firestore Auth State for Baileys
  async function getFirestoreAuthState(userId: string) {
    // For now, we'll use a local folder for simplicity in this demo, 
    // but in production we'd use the Firestore implementation.
    const sessionDir = path.join(process.cwd(), "sessions", userId);
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
    return useMultiFileAuthState(sessionDir);
  }

  async function connectToWhatsApp(userId: string, socket: any) {
    // Close existing session if any to prevent multiple concurrent connections
    const existingSock = sessions.get(userId);
    if (existingSock) {
      console.log(`Closing existing WhatsApp session for ${userId}`);
      try {
        existingSock.ev.removeAllListeners("connection.update");
        existingSock.ev.removeAllListeners("creds.update");
        existingSock.ev.removeAllListeners("messages.upsert");
        existingSock.ev.removeAllListeners("messages.update");
        existingSock.end(new Error("New connection requested"));
      } catch (err) {
        console.error("Error closing existing session:", err);
      }
    }

    console.log(`Connecting to WhatsApp for ${userId}...`);
    
    let state, saveCreds;
    try {
      const authResult = await getFirestoreAuthState(userId);
      state = authResult.state;
      saveCreds = authResult.saveCreds;
    } catch (err) {
      console.error("Error getting auth state:", err);
      socket.emit("whatsapp-status", "error");
      return;
    }

    let version;
    try {
      const versionResult = await fetchLatestBaileysVersion();
      version = versionResult.version;
    } catch (err) {
      console.warn("Failed to fetch latest Baileys version, using fallback:", err);
      version = [2, 3000, 1015901307]; // Fallback version
    }

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger,
      browser: ["AI Voice Assistant", "Chrome", "1.0.0"],
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 10000,
    });

    sessions.set(userId, sock);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      if (qr) {
        console.log(`QR code generated for user ${userId}`);
        try {
          const qrDataUrl = await QRCode.toDataURL(qr);
          socket.emit("whatsapp-qr", qrDataUrl);
        } catch (err) {
          console.error("Error generating QR Data URL:", err);
        }
      }

      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        console.log(`WhatsApp connection closed for ${userId}. Status: ${statusCode}`);
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        socket.emit("whatsapp-status", "disconnected");
        if (shouldReconnect) {
          console.log(`Reconnecting WhatsApp for ${userId}...`);
          connectToWhatsApp(userId, socket);
        }
      } else if (connection === "open") {
        socket.emit("whatsapp-status", "connected");
        console.log(`WhatsApp connected for user ${userId}`);
      }
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("messages.upsert", async (m) => {
      const msg = m.messages[0];
      if (!msg.message || msg.key.fromMe) return;

      const audioMsg = msg.message.audioMessage;
      const isVoiceNote = audioMsg?.ptt === true;

      if (isVoiceNote && audioMsg) {
        console.log("Received voice note from WhatsApp");
        try {
          const buffer = await downloadMediaMessage(msg, "buffer", {});
          const base64Audio = buffer.toString("base64");
          
          // Save to Pending Transcriptions in Firestore
          try {
            await db.collection("pending_transcriptions").add({
              userId,
              remoteJid: msg.key.remoteJid,
              audioBase64: base64Audio,
              mimeType: audioMsg.mimetype || "audio/ogg",
              filename: `WhatsApp Voice Note (${new Date().toLocaleString()})`,
              createdAt: new Date().toISOString()
            });
            socket.emit("new-whatsapp-audio", { success: true });
          } catch (dbErr) {
            console.error("Firestore Error (pending_transcriptions):", dbErr);
            socket.emit("new-whatsapp-audio", { success: false, error: dbErr.message });
          }
        } catch (err) {
          console.error("Error downloading WhatsApp media:", err);
        }
      }
    });

    sock.ev.on("messages.update", (updates) => {
      for (const update of updates) {
        if (update.update.status) {
          socket.emit("whatsapp-message-update", {
            id: update.key.id,
            status: update.update.status, // 3 = delivered, 4 = read
            remoteJid: update.key.remoteJid
          });
        }
      }
    });
  }

  io.on("connection", (socket) => {
    console.log("New socket connection:", socket.id);

    socket.on("ping", () => {
      console.log("Received ping from client");
      socket.emit("pong");
    });

    socket.on("init-whatsapp", (userId: string) => {
      console.log(`Initializing WhatsApp for user: ${userId}`);
      connectToWhatsApp(userId, socket);
    });

    socket.on("reset-whatsapp", (userId: string) => {
      console.log(`Resetting WhatsApp for user: ${userId}`);
      const sessionDir = path.join(process.cwd(), "sessions", userId);
      if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      }
      socket.emit("whatsapp-status", "disconnected");
      socket.emit("whatsapp-qr", null);
    });

    socket.on("send-whatsapp-message", async ({ userId, remoteJid, text }) => {
      const sock = sessions.get(userId);
      if (sock) {
        try {
          const sentMsg = await sock.sendMessage(remoteJid, { text });
          socket.emit("whatsapp-message-sent", { 
            success: true, 
            id: sentMsg.key.id,
            text 
          });
        } catch (err) {
          console.error("Error sending WhatsApp message:", err);
          socket.emit("whatsapp-message-sent", { success: false, error: err.message });
        }
      } else {
        socket.emit("whatsapp-message-sent", { success: false, error: "WhatsApp not connected" });
      }
    });

    socket.on("disconnect", () => {
      // Keep WhatsApp session alive in backend
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
