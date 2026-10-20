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
const PORT = process.env.PORT || 3000;
// ====================================

let currentMovie = null;
let twitchToken = null;
let tokenExpires = 0;

// ---------- Twitch ----------
async function getTwitchToken() {
  if (twitchToken && Date.now() < tokenExpires) return twitchToken;
  const res = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `client_id=${TWITCH_CLIENT_ID}&client_secret=${TWITCH_CLIENT_SECRET}&grant_type=client_credentials`
  });
  const data = await res.json();
  twitchToken = data.access_token;
  tokenExpires = Date.now() + (data.expires_in - 60) * 1000;
  return twitchToken;
}

async function getTwitchAvatar(username) {
  try {
    const token = await getTwitchToken();
    const res = await fetch(`https://api.twitch.tv/helix/users?login=${username}`, {
      headers: {
        "Client-ID": TWITCH_CLIENT_ID,
        "Authorization": `Bearer ${token}`
      }
    });
    const data = await res.json();
    if (data.data?.[0]) return data.data[0].profile_image_url;
  } catch (e) {}
  return null;
}

// ---------- TMDB ----------
async function searchMovie(title) {
  try {
    // Remove ano entre parênteses para melhorar a busca
    const clean = title.replace(/\s*\(\d{4}\)\s*$/, "").trim();

    const url = `https://api.themoviedb.org/3/search/multi?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(clean)}&language=pt-BR`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.results?.length > 0) {
      // Prefere filme, depois série
      const item = data.results.find(r => r.media_type === "movie") || 
                   data.results.find(r => r.media_type === "tv") || 
                   data.results[0];

      const name = item.title || item.name;
      const year = (item.release_date || item.first_air_date || "").substring(0, 4);
      const poster = item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null;

      return { title: name, year, poster };
    }
  } catch (err) {
    console.error("TMDB error:", err.message);
  }
  return { title, year: null, poster: null };
}

// ---------- WebSocket ----------
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  });
}

wss.on("connection", (ws) => {
  if (currentMovie) ws.send(JSON.stringify({ type: "state", movie: currentMovie }));

  ws.on("message", async (raw) => {
    try {
      const data = JSON.parse(raw);
      if (data.type === "rating" && currentMovie) {
        const { username, displayName, score } = data;
        if (currentMovie.ratings.some(r => r.username.toLowerCase() === username.toLowerCase())) return;

        const avatar = await getTwitchAvatar(username);
        currentMovie.ratings.push({
          username,
          displayName: displayName || username,
          avatar,
          score: Number(score),
          time: Date.now()
        });
        currentMovie.ratings.sort((a, b) => b.score - a.score);
        broadcast({ type: "state", movie: currentMovie });
      }
    } catch (e) {}
  });
});

// ---------- Rotas ----------
app.post("/movie-ended", async (req, res) => {
  const { title } = req.body;
  if (!title) return res.status(400).json({ error: "title obrigatório" });

  const tmdb = await searchMovie(title);

  currentMovie = {
    title: tmdb.title,
    year: tmdb.year,
    poster: tmdb.poster,
    ratings: [],
    startedAt: Date.now()
  };

  broadcast({ type: "movie-started", movie: currentMovie });
  res.json({ ok: true, movie: currentMovie });
});

app.get("/state", (req, res) => res.json(currentMovie || {}));
app.post("/reset", (req, res) => {
  currentMovie = null;
  broadcast({ type: "reset" });
  res.json({ ok: true });
});

app.get("/", (req, res) => res.send("Movie Rating Backend online"));

// ---------- Painel Manual (melhorado) ----------
app.get("/painel", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Painel Manual</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #0c0c10; color: #eee; min-height: 100vh; padding: 24px; }
    .container { max-width: 1100px; margin: 0 auto; }
    h1 { font-size: 22px; margin-bottom: 20px; font-weight: 600; }
    .search-box { display: flex; gap: 10px; margin-bottom: 24px; }
    input { flex: 1; padding: 12px 16px; border-radius: 10px; border: 1px solid #2a2a35; background: #16161d; color: #fff; font-size: 15px; outline: none; }
    input:focus { border-color: #4f46e5; }
    button { padding: 12px 18px; border-radius: 10px; border: none; background: #4f46e5; color: white; font-weight: 600; cursor: pointer; }
    button:hover { background: #4338ca; }
    #results { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 16px; }
    .card { background: #16161d; border-radius: 12px; overflow: hidden; cursor: pointer; transition: 0.15s; border: 1px solid transparent; }
    .card:hover { border-color: #4f46e5; transform: translateY(-3px); }
    .card img { width: 100%; height: 225px; object-fit: cover; display: block; background: #222; }
    .card .info { padding: 10px 12px; }
    .card .title { font-size: 13px; font-weight: 600; line-height: 1.3; margin-bottom: 3px; }
    .card .meta { font-size: 11px; color: #888; }
    .status { margin-top: 18px; padding: 10px 14px; border-radius: 8px; background: #1a1a22; font-size: 14px; display: none; }
    .status.show { display: block; }
    .status.ok { color: #4ade80; }
    .status.err { color: #f87171; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Painel Manual — Filmes & Séries</h1>
    <div class="search-box">
      <input type="text" id="search" placeholder="Pesquisar filme ou série..." autofocus>
      <button onclick="search()">Buscar</button>
    </div>
    <div id="results"></div>
    <div class="status" id="status"></div>
  </div>

  <script>
    const input = document.getElementById("search");
    const results = document.getElementById("results");
    const statusEl = document.getElementById("status");
    let timer = null;

    input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(search, 350);
    });
    input.addEventListener("keydown", e => { if (e.key === "Enter") search(); });

    async function search() {
      const q = input.value.trim();
      if (q.length < 2) { results.innerHTML = ""; return; }

      const res = await fetch("/search?q=" + encodeURIComponent(q));
      const data = await res.json();

      results.innerHTML = data.map(item => \`
        <div class="card" onclick='activate(\${JSON.stringify(item).replace(/'/g, "&#39;")})'>
          <img src="\${item.poster || 'https://via.placeholder.com/150x225/222/555?text=Sem+Poster'}" loading="lazy">
          <div class="info">
            <div class="title">\${item.title}</div>
            <div class="meta">\${item.year || ""} \${item.type === "tv" ? "• Série" : "• Filme"}</div>
          </div>
        </div>
      \`).join("");
    }

    async function activate(item) {
      statusEl.className = "status show";
      statusEl.textContent = "Ativando: " + item.title + "...";
      try {
        const res = await fetch("/movie-ended", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: item.title + (item.year ? " (" + item.year + ")" : "") })
        });
        if (res.ok) {
          statusEl.className = "status show ok";
          statusEl.textContent = "✓ Ativado: " + item.title;
        } else {
          statusEl.className = "status show err";
          statusEl.textContent = "Erro ao ativar";
        }
      } catch (e) {
        statusEl.className = "status show err";
        statusEl.textContent = "Erro de conexão";
      }
    }
  </script>
</body>
</html>`);
});

app.get("/search", async (req, res) => {
  const q = req.query.q;
  if (!q) return res.json([]);

  try {
    const url = `https://api.themoviedb.org/3/search/multi?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(q)}&language=pt-BR`;
    const r = await fetch(url);
    const data = await r.json();

    const results = (data.results || [])
      .filter(i => i.media_type === "movie" || i.media_type === "tv")
      .slice(0, 18)
      .map(i => ({
        title: i.title || i.name,
        year: (i.release_date || i.first_air_date || "").substring(0, 4) || null,
        poster: i.poster_path ? `https://image.tmdb.org/t/p/w300${i.poster_path}` : null,
        type: i.media_type
      }));

    res.json(results);
  } catch (e) {
    res.json([]);
  }
});

server.listen(PORT, () => console.log("Backend online na porta", PORT));
