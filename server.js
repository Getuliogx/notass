const express = require("express");
const cors = require("cors");
const http = require("http");
const WebSocket = require("ws");
const fetch = require("node-fetch");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ============== CONFIG ==============
const TMDB_API_KEY = "b095ccbbb185d27703d007ae0ded5f7d";
const TWITCH_CLIENT_ID = "sah4oubx3irkbvh6m4jf28s2mefx46";
const TWITCH_CLIENT_SECRET = "k271wxor46h79d66wohz47v85mxdhg";

const CINEFY_CHANNEL_ID = "d81e634a-3ab1-4217-bf35-94e8d3c5250a";
const CINEFY_PUSHER_URL = "wss://ws-sa1.pusher.com/app/69544a8f3c11bd825651?protocol=7&client=js&version=8.4.0&flash=false";

const PORT = process.env.PORT || 3000;
// ====================================

let currentMovie = null;
let twitchToken = null;
let tokenExpires = 0;
let cinefyWs = null;

// ---------- Twitch Avatar ----------
async function getTwitchToken() {
  if (twitchToken && Date.now() < tokenExpires) return twitchToken;
  try {
    const res = await fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "client_id=" + TWITCH_CLIENT_ID + "&client_secret=" + TWITCH_CLIENT_SECRET + "&grant_type=client_credentials"
    });
    const data = await res.json();
    twitchToken = data.access_token;
    tokenExpires = Date.now() + (data.expires_in - 60) * 1000;
    return twitchToken;
  } catch (e) {
    return null;
  }
}

async function getTwitchAvatar(username) {
  try {
    const token = await getTwitchToken();
    if (!token) return null;
    const res = await fetch("https://api.twitch.tv/helix/users?login=" + username, {
      headers: {
        "Client-ID": TWITCH_CLIENT_ID,
        "Authorization": "Bearer " + token
      }
    });
    const data = await res.json();
    if (data.data && data.data[0]) return data.data[0].profile_image_url;
  } catch (e) {}
  return null;
}

// ---------- TMDB ----------
async function searchMovie(title) {
  try {
    const clean = title.replace(/\s*\(\d{4}\)\s*$/, "").trim();
    const url = "https://api.themoviedb.org/3/search/multi?api_key=" + TMDB_API_KEY + "&query=" + encodeURIComponent(clean) + "&language=pt-BR";
    const res = await fetch(url);
    const data = await res.json();

    if (data.results && data.results.length > 0) {
      const item = data.results.find(r => r.media_type === "movie") ||
                   data.results.find(r => r.media_type === "tv") ||
                   data.results[0];

      const name = item.title || item.name;
      const year = (item.release_date || item.first_air_date || "").substring(0, 4);
      const poster = item.poster_path ? "https://image.tmdb.org/t/p/w500" + item.poster_path : null;

      return { title: name, year, poster };
    }
  } catch (err) {
    console.error("TMDB error:", err.message);
  }
  return { title: title, year: null, poster: null };
}

// ---------- WebSocket (Overlay) ----------
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  });
}

function addRating(username, displayName, score, avatar, platform) {
  if (!currentMovie) {
    console.log("[Nota ignorada] Nenhum filme ativo");
    return false;
  }
  if (currentMovie.ratings.some(r => r.username.toLowerCase() === username.toLowerCase())) {
    console.log("[Nota ignorada] Usuário já votou:", username);
    return false;
  }

  currentMovie.ratings.push({
    username,
    displayName: displayName || username,
    avatar: avatar || null,
    score: Number(score),
    platform: platform || "unknown",
    time: Date.now()
  });

  currentMovie.ratings.sort((a, b) => b.score - a.score);
  broadcast({ type: "state", movie: currentMovie });
  console.log("[" + platform + "] Nota registrada: " + displayName + " → " + score);
  return true;
}

wss.on("connection", (ws) => {
  console.log("Overlay conectado. Filmes ativos:", currentMovie ? currentMovie.title : "nenhum");
  if (currentMovie) ws.send(JSON.stringify({ type: "state", movie: currentMovie }));

  ws.on("message", async (raw) => {
    try {
      const data = JSON.parse(raw);
      if (data.type === "rating" && currentMovie) {
        const avatar = data.avatar || await getTwitchAvatar(data.username);
        addRating(data.username, data.displayName, data.score, avatar, data.platform || "twitch");
      }
    } catch (e) {}
  });
});

// ---------- CINEFY ----------
function connectCinefy() {
  if (cinefyWs) {
    try { cinefyWs.terminate(); } catch (e) {}
  }

  console.log("[Cinefy] Conectando...");
  cinefyWs = new WebSocket(CINEFY_PUSHER_URL);

  cinefyWs.on("open", () => {
    console.log("[Cinefy] Conectado ao Pusher");
    cinefyWs.send(JSON.stringify({
      event: "pusher:subscribe",
      data: { channel: "chatroom." + CINEFY_CHANNEL_ID }
    }));
    console.log("[Cinefy] Inscrito no canal: chatroom." + CINEFY_CHANNEL_ID);
  });

  cinefyWs.on("message", (raw) => {
    try {
      const payload = JSON.parse(raw.toString());

      // Log de TODOS os eventos para debug
      if (payload.event && payload.event !== "pusher:pong" && payload.event !== "pusher_internal:subscription_succeeded") {
        console.log("[Cinefy EVENT]", payload.event);
      }

      // Qualquer evento que contenha "message" ou "chat"
      if (payload.event && (
          payload.event.toLowerCase().includes("message") ||
          payload.event.toLowerCase().includes("chat") ||
          payload.event.includes("ChatMessage")
      )) {
        console.log("[Cinefy RAW DATA]", JSON.stringify(payload.data).substring(0, 300));
        
        let data = payload.data;
        if (typeof data === "string") {
          try { data = JSON.parse(data); } catch (e) { return; }
        }

        handleCinefyMessage(data);
      }
    } catch (e) {
      console.error("[Cinefy parse error]", e.message);
    }
  });

  cinefyWs.on("close", () => {
    console.log("[Cinefy] Desconectado. Reconectando em 5s...");
    setTimeout(connectCinefy, 5000);
  });

  cinefyWs.on("error", (err) => {
    console.error("[Cinefy] Erro:", err.message);
  });
}

function handleCinefyMessage(data) {
  console.log("[Cinefy] Processando mensagem...");

  // Extrai texto
  const text = (data.content || data.message || data.text || data.body || "").toString().trim().toLowerCase();
  
  // Extrai usuário
  let username = "";
  let displayName = "";
  let avatar = null;

  const sender = data.sender || data.user || data.author || data.from || {};
  
  username = (sender.username || sender.slug || sender.name || sender.login || data.username || data.user_name || "").toLowerCase();
  displayName = sender.username || sender.name || sender.display_name || data.username || username;
  avatar = sender.profile_pic || sender.profile_picture || sender.avatar || sender.image || null;

  console.log("[Cinefy] Texto:", text, "| User:", displayName);

  if (!text || !username) {
    console.log("[Cinefy] Mensagem inválida (sem texto ou usuário)");
    return;
  }

  // Parse da nota
  let score = null;
  if (/^\d+(\.\d+)?$/.test(text)) {
    score = parseFloat(text);
  } else {
    const match = text.match(/^!(?:nota|n)\s*(\d+(?:\.\d+)?)$/i);
    if (match) score = parseFloat(match[1]);
  }

  if (score === null || score < 0 || score > 10) {
    console.log("[Cinefy] Não é uma nota válida:", text);
    return;
  }

  console.log("[Cinefy] Nota detectada:", score, "de", displayName);
  addRating(username, displayName, score, avatar, "cinefy");
}

// ---------- Rotas ----------
app.post("/movie-ended", async (req, res) => {
  const title = req.body.title;
  if (!title) return res.status(400).json({ error: "title obrigatório" });

  console.log(">>> Filme ativado:", title);
  const tmdb = await searchMovie(title);

  currentMovie = {
    title: tmdb.title,
    year: tmdb.year,
    poster: tmdb.poster,
    ratings: [],
    startedAt: Date.now()
  };

  broadcast({ type: "movie-started", movie: currentMovie });
  console.log(">>> Poster:", tmdb.poster ? "OK" : "NÃO ENCONTRADO");
  res.json({ ok: true, movie: currentMovie });
});

app.get("/state", (req, res) => res.json(currentMovie || {}));

app.post("/reset", (req, res) => {
  currentMovie = null;
  broadcast({ type: "reset" });
  res.json({ ok: true });
});

app.get("/", (req, res) => res.send("Movie Rating Backend online + Cinefy"));

app.get("/search", async (req, res) => {
  const q = req.query.q;
  const type = req.query.type || "movie";
  const year = req.query.year || "";
  if (!q) return res.json([]);

  try {
    let url = "https://api.themoviedb.org/3/search/" + type + "?api_key=" + TMDB_API_KEY + "&query=" + encodeURIComponent(q) + "&language=pt-BR";
    if (year) url += "&year=" + year;

    const r = await fetch(url);
    const data = await r.json();

    const results = (data.results || []).slice(0, 16).map(i => ({
      title: i.title || i.name,
      year: (i.release_date || i.first_air_date || "").substring(0, 4) || null,
      poster: i.poster_path ? "https://image.tmdb.org/t/p/w300" + i.poster_path : null,
      type: type
    }));

    res.json(results);
  } catch (e) {
    res.json([]);
  }
});

app.get("/painel", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <title>Painel do Overlay</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #0f1117; color: #e2e8f0; min-height: 100vh; padding: 24px; }
    h1 { font-size: 20px; margin-bottom: 20px; }
    .box { background: #161b22; border: 1px solid #21262d; border-radius: 12px; padding: 20px; margin-bottom: 16px; }
    input, select { background: #0d1117; border: 1px solid #30363d; color: #fff; padding: 10px 14px; border-radius: 8px; font-size: 14px; }
    input { width: 100%; max-width: 400px; }
    button { padding: 10px 16px; border-radius: 8px; border: none; background: #8b5cf6; color: white; font-weight: 600; cursor: pointer; }
    #results { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; margin-top: 16px; }
    .card { background: #0d1117; border-radius: 10px; overflow: hidden; cursor: pointer; border: 1px solid #21262d; }
    .card:hover { border-color: #8b5cf6; }
    .card img { width: 100%; height: 200px; object-fit: cover; }
    .card .info { padding: 10px; font-size: 13px; }
    .status { margin-top: 12px; color: #3fb950; }
  </style>
</head>
<body>
  <h1>Painel Manual</h1>
  <div class="box">
    <input type="text" id="q" placeholder="Nome do filme ou série..." onkeydown="if(event.key==='Enter')search()">
    <button onclick="search()" style="margin-left:8px">Buscar</button>
    <div id="results"></div>
    <div class="status" id="status"></div>
  </div>
  <script>
    async function search() {
      const q = document.getElementById("q").value.trim();
      if (q.length < 2) return;
      const res = await fetch("/search?q=" + encodeURIComponent(q) + "&type=movie");
      const data = await res.json();
      document.getElementById("results").innerHTML = data.map(item => 
        '<div class="card" onclick=\\'activate(' + JSON.stringify(item) + ')\\'>' +
          '<img src="' + (item.poster || '') + '">' +
          '<div class="info">' + item.title + (item.year ? ' (' + item.year + ')' : '') + '</div>' +
        '</div>'
      ).join("");
    }
    async function activate(item) {
      document.getElementById("status").textContent = "Ativando: " + item.title;
      const title = item.title + (item.year ? " (" + item.year + ")" : "");
      await fetch("/movie-ended", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title })
      });
      document.getElementById("status").textContent = "✓ Ativado: " + item.title;
    }
  </script>
</body>
</html>`);
});

server.listen(PORT, () => {
  console.log("Backend online na porta", PORT);
  connectCinefy();
});
