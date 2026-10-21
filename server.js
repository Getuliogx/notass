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
    body: "client_id=" + TWITCH_CLIENT_ID + "&client_secret=" + TWITCH_CLIENT_SECRET + "&grant_type=client_credentials"
  });
  const data = await res.json();
  twitchToken = data.access_token;
  tokenExpires = Date.now() + (data.expires_in - 60) * 1000;
  return twitchToken;
}

async function getTwitchAvatar(username) {
  try {
    const token = await getTwitchToken();
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
        const username = data.username;
        const displayName = data.displayName;
        const score = data.score;
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
  const title = req.body.title;
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

// ---------- Search ----------
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

// ---------- Painel ----------
app.get("/painel", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Painel do Overlay</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #0f1117; color: #e2e8f0; min-height: 100vh; }
    .header { background: #161b22; border-bottom: 1px solid #21262d; padding: 16px 24px; display: flex; justify-content: space-between; align-items: center; }
    .header h1 { font-size: 18px; font-weight: 600; }
    .header p { font-size: 13px; color: #8b949e; margin-top: 2px; }
    .badges { display: flex; gap: 10px; }
    .badge { background: #21262d; padding: 5px 12px; border-radius: 20px; font-size: 12px; display: flex; align-items: center; gap: 6px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #3fb950; }
    .container { max-width: 1200px; margin: 0 auto; padding: 24px; }
    .card-box { background: #161b22; border: 1px solid #21262d; border-radius: 12px; padding: 20px; margin-bottom: 20px; }
    .card-box h2 { font-size: 15px; font-weight: 600; margin-bottom: 14px; color: #c9d1d9; }
    .search-row { display: flex; gap: 10px; margin-bottom: 8px; }
    select, input { background: #0d1117; border: 1px solid #30363d; color: #e6edf3; padding: 10px 14px; border-radius: 8px; font-size: 14px; outline: none; }
    select { width: 110px; }
    input { flex: 1; }
    input:focus, select:focus { border-color: #8b5cf6; }
    .btn { padding: 10px 18px; border-radius: 8px; border: none; font-weight: 600; font-size: 14px; cursor: pointer; }
    .btn-primary { background: #8b5cf6; color: white; }
    .btn-primary:hover { background: #7c3aed; }
    .btn-outline { background: transparent; border: 1px solid #30363d; color: #c9d1d9; }
    .btn-outline:hover { background: #21262d; }
    .btn-sm { padding: 6px 12px; font-size: 12px; }
    .hint { font-size: 12px; color: #8b949e; margin-bottom: 16px; }
    #results { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 16px; }
    .movie-card { background: #0d1117; border: 1px solid #21262d; border-radius: 10px; overflow: hidden; }
    .movie-card img { width: 100%; height: 160px; object-fit: cover; background: #161b22; }
    .movie-card .body { padding: 12px; }
    .movie-card .title { font-size: 14px; font-weight: 600; margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .movie-card .meta { font-size: 12px; color: #8b949e; margin-bottom: 10px; }
    .movie-card .actions { display: flex; flex-direction: column; gap: 6px; }
    .saved-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
    .saved-item { display: flex; gap: 12px; background: #0d1117; border: 1px solid #21262d; border-radius: 10px; padding: 10px; align-items: center; }
    .saved-item img { width: 48px; height: 72px; object-fit: cover; border-radius: 6px; background: #161b22; }
    .saved-item .info { flex: 1; min-width: 0; }
    .saved-item .title { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .saved-item .meta { font-size: 11px; color: #8b949e; }
    .empty { color: #8b949e; font-size: 14px; padding: 12px 0; }
    .status { margin-top: 12px; font-size: 13px; }
    .status.ok { color: #3fb950; }
    .status.err { color: #f85149; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1>Painel do Overlay</h1>
      <p>Pesquise, salve e atualize o "Assistindo Agora".</p>
    </div>
    <div class="badges">
      <div class="badge"><div class="dot"></div> TMDB conectado</div>
      <div class="badge"><div class="dot"></div> Overlay conectada</div>
    </div>
  </div>

  <div class="container">
    <div class="card-box">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <h2 style="margin:0">Agora na overlay</h2>
        <div style="display:flex;gap:8px;">
          <button class="btn btn-outline btn-sm" onclick="refreshState()">Atualizar estado</button>
          <button class="btn btn-outline btn-sm" style="color:#f85149;border-color:#f85149" onclick="clearOverlay()">Excluir da overlay</button>
        </div>
      </div>
      <div id="current" class="empty">Nenhum título enviado ainda.</div>
    </div>

    <div class="card-box">
      <h2>Pesquisar filme ou série</h2>
      <div class="search-row">
        <select id="type">
          <option value="movie">Filme</option>
          <option value="tv">Série</option>
        </select>
        <input type="text" id="q" placeholder="Digite o nome">
        <input type="text" id="year" placeholder="Ano" style="width:90px">
        <button class="btn btn-primary" onclick="search()">Pesquisar</button>
      </div>
      <div class="hint">"Atualizar overlay" troca o título na tela.</div>
      <div id="results"></div>
      <div id="status" class="status"></div>
    </div>

    <div class="card-box">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
        <h2 style="margin:0">Títulos salvos</h2>
        <span id="saved-count" style="font-size:13px;color:#8b949e">0 salvos</span>
      </div>
      <div id="saved" class="saved-grid"></div>
    </div>
  </div>

  <script>
    let saved = JSON.parse(localStorage.getItem("savedTitles") || "[]");

    function showStatus(msg, ok) {
      if (ok === undefined) ok = true;
      const el = document.getElementById("status");
      el.textContent = msg;
      el.className = "status " + (ok ? "ok" : "err");
    }

    async function search() {
      const q = document.getElementById("q").value.trim();
      const type = document.getElementById("type").value;
      const year = document.getElementById("year").value.trim();
      if (q.length < 2) return;

      const res = await fetch("/search?q=" + encodeURIComponent(q) + "&type=" + type + "&year=" + year);
      const data = await res.json();

      document.getElementById("results").innerHTML = data.map(function(item) {
        return '<div class="movie-card">' +
          '<img src="' + (item.poster || 'https://via.placeholder.com/220x160/161b22/8b949e?text=Sem+Poster') + '">' +
          '<div class="body">' +
            '<div class="title">' + item.title + '</div>' +
            '<div class="meta">' + (item.type === "tv" ? "Série" : "Filme") + (item.year ? " • " + item.year : "") + '</div>' +
            '<div class="actions">' +
              '<button class="btn btn-primary btn-sm" onclick=\\'activate(' + JSON.stringify(item) + ')\\'>Atualizar overlay</button>' +
              '<button class="btn btn-outline btn-sm" onclick=\\'saveItem(' + JSON.stringify(item) + ')\\'>Salvar</button>' +
            '</div>' +
          '</div>' +
        '</div>';
      }).join("") || "<div class='empty'>Nenhum resultado.</div>";
    }

    async function activate(item) {
      showStatus("Atualizando overlay...");
      const title = item.title + (item.year ? " (" + item.year + ")" : "");
      const res = await fetch("/movie-ended", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title })
      });
      if (res.ok) {
        showStatus("✓ Overlay atualizada: " + item.title);
        refreshState();
      } else {
        showStatus("Erro ao atualizar", false);
      }
    }

    function saveItem(item) {
      if (saved.some(function(s) { return s.title === item.title && s.year === item.year; })) {
        showStatus("Já está salvo");
        return;
      }
      saved.unshift(item);
      localStorage.setItem("savedTitles", JSON.stringify(saved));
      renderSaved();
      showStatus("Salvo: " + item.title);
    }

    function renderSaved() {
      document.getElementById("saved-count").textContent = saved.length + " salvos";
      document.getElementById("saved").innerHTML = saved.map(function(item, i) {
        return '<div class="saved-item">' +
          '<img src="' + (item.poster || '') + '">' +
          '<div class="info">' +
            '<div class="title">' + item.title + '</div>' +
            '<div class="meta">' + (item.type === "tv" ? "Série" : "Filme") + (item.year ? " • " + item.year : "") + '</div>' +
          '</div>' +
          '<button class="btn btn-primary btn-sm" onclick=\\'activate(' + JSON.stringify(item) + ')\\'>Usar</button>' +
          '<button class="btn btn-outline btn-sm" onclick="removeSaved(' + i + ')">✕</button>' +
        '</div>';
      }).join("") || "<div class='empty'>Nenhum título salvo.</div>";
    }

    function removeSaved(i) {
      saved.splice(i, 1);
      localStorage.setItem("savedTitles", JSON.stringify(saved));
      renderSaved();
    }

    async function refreshState() {
      const res = await fetch("/state");
      const data = await res.json();
      const el = document.getElementById("current");
      if (data && data.title) {
        el.innerHTML = "<strong>" + data.title + "</strong> " + (data.year ? "(" + data.year + ")" : "") + " — " + (data.ratings ? data.ratings.length : 0) + " votos";
      } else {
        el.innerHTML = "<div class='empty'>Nenhum título enviado ainda.</div>";
      }
    }

    async function clearOverlay() {
      await fetch("/reset", { method: "POST" });
      refreshState();
      showStatus("Overlay limpa");
    }

    document.getElementById("q").addEventListener("keydown", function(e) { if (e.key === "Enter") search(); });
    renderSaved();
    refreshState();
  </script>
</body>
</html>`);
});

server.listen(PORT, () => console.log("Backend online na porta", PORT));
