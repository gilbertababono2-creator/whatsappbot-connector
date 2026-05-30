# NEXUS-PAIR — WhatsApp Bot Pairing System

A full-stack WhatsApp bot pairing tool built with Baileys, Node.js, and a dark futuristic frontend.

---

## 📁 Project Structure

```
whatsapp-pair-bot/
├── backend/           ← Node.js + Express + Baileys server
│   ├── server.js      ← Main pairing server
│   ├── package.json
│   └── .env.example
└── frontend/
    └── index.html     ← Standalone pairing UI (deploy to Vercel)
```

---

## 🚀 Backend Deployment (Render — Free)

### 1. Push backend to GitHub
```bash
cd backend
git init
git add .
git commit -m "init: WhatsApp pair server"
git remote add origin https://github.com/YOUR_USERNAME/nexus-pair-backend.git
git push -u origin main
```

### 2. Deploy on Render
1. Go to [render.com](https://render.com) → New → **Web Service**
2. Connect your GitHub repo
3. Set these:
   - **Environment**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Node Version**: 18+

### 3. Environment Variables on Render
```
PORT=3000
FRONTEND_URL=https://your-frontend.vercel.app
```

### 4. Note your Render URL
It will be something like: `https://nexus-pair-backend.onrender.com`

---

## 🌐 Frontend Deployment (Vercel — Free)

### 1. Edit the SERVER_URL in index.html
```js
// Line ~5 of the <script> block:
const SERVER_URL = "https://your-backend.onrender.com";
// Replace with your actual Render URL ☝️
```

### 2. Push frontend to GitHub
```bash
cd frontend
git init
git add .
git commit -m "init: pairing UI"
git remote add origin https://github.com/YOUR_USERNAME/nexus-pair-frontend.git
git push -u origin main
```

### 3. Deploy on Vercel
1. Go to [vercel.com](https://vercel.com) → New Project
2. Import your frontend repo
3. Framework: **Other** (it's plain HTML)
4. Root Directory: `/` (leave default)
5. Deploy ✅

---

## 🔌 API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Health check + server info |
| GET | `/status` | Active sessions & capacity |
| POST | `/generate-pair` | Generate WhatsApp pairing code |
| GET | `/session/:phone` | Check session status |

### POST /generate-pair
```json
// Request
{ "phone": "923001234567" }

// Response (success)
{ "pairingCode": "ABCD-EFGH", "phone": "923001234567" }

// Response (error)
{ "error": "Server is at capacity." }
```

---

## ⚙️ How It Works

1. User enters phone number on the frontend
2. Frontend POSTs to `/generate-pair` on your Render backend
3. Backend creates a Baileys socket for that phone number
4. Baileys requests a pairing code from WhatsApp's servers
5. Code is returned to the frontend and displayed
6. User enters the code in WhatsApp → Linked Devices
7. Bot session is now active

---

## ⚠️ Important Notes

- **WhatsApp ToS**: Baileys uses the unofficial WhatsApp Web API. Use responsibly.
- **Sessions expire** after 5 minutes if the code isn't used
- **Max 50 concurrent sessions** per server instance (configurable in server.js)
- **Render free tier** spins down after inactivity — use UptimeRobot to ping it

---

## 🛠 Tech Stack

| Layer | Tech |
|-------|------|
| Frontend | Vanilla HTML/CSS/JS |
| Backend | Node.js + Express |
| WA Library | @whiskeysockets/baileys |
| Hosting (FE) | Vercel (free) |
| Hosting (BE) | Render (free) |
