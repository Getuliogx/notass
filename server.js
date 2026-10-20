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
const PORT = process.env.PORT || 3000;
// ==========================================

let currentMovie = null; // { title, poster, ratings: [] }

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
        poster: movie.poster_path
          ? `https://image.tmdb.org/t/p/w500${movie.poster_path}`
          : null,
        year: movie.release_date ? movie.release_date.substring(0, 4) : null
      };
    }
  } catch (err) {
    console.error("Erro TMDB:", err.message);
  }
  return { title, poster: null, year: null };
}

// ---------- WebSocket (overlay) ----------
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

  // Manda o estado atual assim que conecta
  if (currentMovie) {
    ws.send(JSON.stringify({ type: "state", movie: currentMovie }));
  }

  ws.on("message", (raw) => {
    try {
      const data = JSON.parse(raw);

      // Overlay mandando uma nota
      if (data.type === "rating" && currentMovie) {
        const { username, displayName, avatar, score, platform } = data;

        // Evita nota duplicada do mesmo usuário
        const already = currentMovie.ratings.find(
          (r) => r.username.toLowerCase() === username.toLowerCase()
        );
        if (already) return;

        currentMovie.ratings.push({
          username,
          displayName: displayName || username,
          avatar: avatar || null,
          score: Number(score),
          platform: platform || "twitch",
          time: Date.now()
        });

        // Ordena por nota (maior primeiro)
        currentMovie.ratings.sort((a, b) => b.score - a.score);

        broadcast({ type: "state", movie: currentMovie });
        console.log(`Nota recebida: ${displayName} → ${score}`);
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

// Health check (Render gosta)
app.get("/", (req, res) => {
  res.send("Movie Rating Backend online");
});

server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});