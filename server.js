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

// ============== CONFIGURAÇÃO ==============
const TMDB_API_KEY = "b095ccbbb185d27703d007ae0ded5f7d";
const TWITCH_CLIENT_ID = "sah4oubx3irkbvh6m4jf28s2mefx46";
const TWITCH_CLIENT_SECRET = "k271wxor46h79d66wohz47v85mxdhg";
const PORT = process.env.PORT || 3000;
// ==========================================

let currentMovie = null;
let twitchToken = null;
let tokenExpires = 0;

// ---------- Twitch Token ----------
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

// ---------- Buscar avatar Twitch ----------
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
    if (data.data && data.data[0]) {
      return data.data[0].profile_image_url;
    }
  } catch (err) {
    console.error("Erro ao buscar avatar:", err.message);
  }
  return null;
}

// ---------- TMDB ----------
async function searchMovie(title) {
  try {
    const url = `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(title)}&language=pt-BR`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.results && data.results.length > 0) {
      const movie = data.results[0];
      return {
        title: movie.title || title,
        original_title: movie.original_title,
        poster: movie.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : null,
        year: movie.release_date ? movie.release_date.substring(0, 4) : null
      };
    }
  } catch (err) {
    console.error("Erro TMDB:", err.message);
  }
  return { title, poster: null, year: null };
}

// ---------- WebSocket ----------
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

wss.on("connection", (ws) => {
  console.log("Overlay conectado");

  if (currentMovie) {
    ws.send(JSON.stringify({ type: "state", movie: currentMovie }));
  }

  ws.on("message", async (raw) => {
    try {
      const data = JSON.parse(raw);

      if (data.type === "rating" && currentMovie) {
        const { username, displayName, score, platform } = data;

        // Evita nota duplicada
        const already = currentMovie.ratings.find(
          (r) => r.username.toLowerCase() === username.toLowerCase()
        );
        if (already) return;

        // Busca avatar real
        const avatar = await getTwitchAvatar(username);

        currentMovie.ratings.push({
          username,
          displayName: displayName || username,
          avatar: avatar,
          score: Number(score),
          platform: platform || "twitch",
          time: Date.now()
        });

        currentMovie.ratings.sort((a, b) => b.score - a.score);

        broadcast({ type: "state", movie: currentMovie });
        console.log(`Nota: ${displayName} → ${score}`);
      }
    } catch (e) {
      console.error("Erro WS:", e.message);
    }
  });
});

// ---------- Rotas ----------
app.post("/movie-ended", async (req, res) => {
  const { title } = req.body;
  if (!title) return res.status(400).json({ error: "title obrigatório" });

  console.log("Filme finalizado:", title);

  const tmdb = await searchMovie(title);

  currentMovie = {
    title: tmdb.title,
    original_title: tmdb.original_title || title,
    poster: tmdb.poster,
    year: tmdb.year,
    ratings: [],
    startedAt: Date.now()
  };

  broadcast({ type: "movie-started", movie: currentMovie });
  res.json({ ok: true, movie: currentMovie });
});

app.get("/state", (req, res) => {
  res.json(currentMovie || {});
});

app.post("/reset", (req, res) => {
  currentMovie = null;
  broadcast({ type: "reset" });
  res.json({ ok: true });
});

app.get("/", (req, res) => {
  res.send("Movie Rating Backend online");
});

// ---------- Painel Manual ----------
app.get("/painel", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <title>Painel Manual - Notas</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Inter, system-ui, sans-serif; background: #0f0f13; color: #fff; padding: 30px; }
    h1 { margin-bottom: 20px; font-size: 24px; }
    input { width: 100%; max-width: 500px; padding: 12px 16px; border-radius: 8px; border: none; font-size: 16px; margin-bottom: 20px; }
    #results { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 16px; }
    .card { background: #1a1a22; border-radius: 10px; overflow: hidden; cursor: pointer; transition: 0.2s; }
    .card:hover { transform: scale(1.03); background: #22222c; }
    .card img { width: 100%; height: 210px; object-fit: cover; display: block; }
    .card .info { padding: 10px; font-size: 13px; }
    .card .title { font-weight: 600; margin-bottom: 4px; }
    .card .year { color: #888; font-size: 12px; }
    .status { margin-top: 20px; color: #4ade80; }
  </style>
</head>
<body>
  <h1>Painel Manual de Filmes / Séries</h1>
  <input type="text" id="search" placeholder="Digite o nome do filme ou série..." autofocus>
  <div id="results"></div>
  <div class="status" id="status"></div>

  <script>
    const input = document.getElementById("search");
    const results = document.getElementById("results");
    const status = document.getElementById("status");
    let timeout = null;

    input.addEventListener("input", () => {
      clearTimeout(timeout);
      timeout = setTimeout(search, 400);
    });

    async function search() {
      const q = input.value.trim();
      if (q.length < 2) {
        results.innerHTML = "";
        return;
      }

      const res = await fetch("/search?q=" + encodeURIComponent(q));
      const data = await res.json();

      results.innerHTML = "";
      data.forEach(item => {
        const div = document.createElement("div");
        div.className = "card";
        div.innerHTML = \`
          <img src="\${item.poster || 'https://via.placeholder.com/140x210?text=Sem+Poster'}" alt="">
          <div class="info">
            <div class="title">\${item.title}</div>
            <div class="year">\${item.year || ""} \${item.type === "tv" ? "• Série" : ""}</div>
          </div>
        \`;
        div.onclick = () => activate(item);
        results.appendChild(div);
      });
    }

    async function activate(item) {
      status.textContent = "Ativando: " + item.title + "...";
      const res = await fetch("/movie-ended", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: item.title + (item.year ? \` (\${item.year})\` : "") })
      });
      if (res.ok) {
        status.textContent = "Ativado com sucesso: " + item.title;
      } else {
        status.textContent = "Erro ao ativar";
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
    // Busca filmes
    const movieRes = await fetch(`https://api.themoviedb.org/3/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(q)}&language=pt-BR`);
    const movieData = await movieRes.json();

    // Busca séries
    const tvRes = await fetch(`https://api.themoviedb.org/3/search/tv?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(q)}&language=pt-BR`);
    const tvData = await tvRes.json();

    const results = [];

    (movieData.results || []).slice(0, 10).forEach(m => {
      results.push({
        title: m.title,
        year: m.release_date ? m.release_date.substring(0, 4) : null,
        poster: m.poster_path ? `https://image.tmdb.org/t/p/w300${m.poster_path}` : null,
        type: "movie"
      });
    });

    (tvData.results || []).slice(0, 8).forEach(t => {
      results.push({
        title: t.name,
        year: t.first_air_date ? t.first_air_date.substring(0, 4) : null,
        poster: t.poster_path ? `https://image.tmdb.org/t/p/w300${t.poster_path}` : null,
        type: "tv"
      });
    });

    res.json(results);
  } catch (err) {
    console.error(err);
    res.json([]);
  }
});

server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
