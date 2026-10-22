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

const TMDB_API_KEY = "b095ccbbb185d27703d007ae0ded5f7d";
const TWITCH_CLIENT_ID = "sah4oubx3irkbvh6m4jf28s2mefx46";
const TWITCH_CLIENT_SECRET = "k271wxor46h79d66wohz47v85mxdhg";
const CINEFY_CHANNEL_ID = "d81e634a-3ab1-4217-bf35-94e8d3c5250a";
const CINEFY_PUSHER_URL = "wss://ws-sa1.pusher.com/app/69544a8f3c11bd825651?protocol=7&client=js&version=8.4.0&flash=false";
const PORT = process.env.PORT || 3000;

let currentMovie = null;
let twitchToken = null;
let tokenExpires = 0;
let cinefyWs = null;

async function getTwitchToken() {
  if (twitchToken && Date.now() < tokenExpires) return twitchToken;
  try {
    const res = await fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "client_id=" + TWITCH_CLIENT_ID + "&client_secret=" + TWITCH_CLIENT_SECRET + "&grant_type=client_credentials"
    });
    const data = await res.json();
    if (!data.access_token) return null;
    twitchToken = data.access_token;
    tokenExpires = Date.now() + ((data.expires_in || 3600) - 60) * 1000;
    return twitchToken;
  } catch (e) { return null; }
}

async function getTwitchAvatar(username) {
  if (!username) return null;
  try {
    const token = await getTwitchToken();
    if (!token) return null;
    const res = await fetch("https://api.twitch.tv/helix/users?login=" + encodeURIComponent(username.toLowerCase()), {
      headers: { "Client-ID": TWITCH_CLIENT_ID, "Authorization": "Bearer " + token }
    });
    const data = await res.json();
    if (data.data && data.data[0] && data.data[0].profile_image_url) {
      return data.data[0].profile_image_url;
    }
  } catch (e) {}
  return null;
}

async function searchMovie(title) {
  try {
    const clean = title.replace(/\s*\(\d{4}\)\s*$/, "").trim();
    const url = "https://api.themoviedb.org/3/search/multi?api_key=" + TMDB_API_KEY + "&query=" + encodeURIComponent(clean) + "&language=pt-BR";
    const res = await fetch(url);
    const data = await res.json();
    if (data.results && data.results.length > 0) {
      const item = data.results.find(r => r.media_type === "movie") || data.results.find(r => r.media_type === "tv") || data.results[0];
      return {
        title: item.title || item.name,
        year: (item.release_date || item.first_air_date || "").substring(0, 4),
        poster: item.poster_path ? "https://image.tmdb.org/t/p/w500" + item.poster_path : null
      };
    }
  } catch (err) {}
  return { title, year: null, poster: null };
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  });
}

function makeFallbackAvatar(name) {
  return "https://ui-avatars.com/api/?name=" + encodeURIComponent(name || "?") + "&background=8b5cf6&color=fff&size=128&bold=true&rounded=true";
}

async function addRating(username, displayName, score, avatar, platform) {
  if (!currentMovie) {
    console.log("[IGNORADO] Nenhum filme ativo");
    return;
  }
  if (currentMovie.ratings.some(r => r.username.toLowerCase() === username.toLowerCase())) {
    console.log("[IGNORADO] Já votou:", username);
    return;
  }

  let finalAvatar = avatar;

  // Se veio avatar da Cinefy / mensagem, usa
  if (finalAvatar && typeof finalAvatar === "string" && finalAvatar.startsWith("http")) {
    // ok
  } else if (platform === "twitch" || platform === "kick") {
    finalAvatar = await getTwitchAvatar(username);
  }

  if (!finalAvatar || !finalAvatar.startsWith("http")) {
    finalAvatar = makeFallbackAvatar(displayName || username);
  }

  currentMovie.ratings.push({
    username,
    displayName: displayName || username,
    avatar: finalAvatar,
    score: Number(score),
    platform: platform || "unknown",
    time: Date.now()
  });

  currentMovie.ratings.sort((a, b) => b.score - a.score);
  broadcast({ type: "state", movie: currentMovie });
  console.log("[NOTA OK]", platform, "|", displayName, "→", score, "| avatar:", finalAvatar.substring(0, 60) + "...");
}

wss.on("connection", (ws) => {
  console.log("Overlay conectado | Filme:", currentMovie ? currentMovie.title : "nenhum");
  if (currentMovie) ws.send(JSON.stringify({ type: "state", movie: currentMovie }));

  ws.on("message", async (raw) => {
    try {
      const data = JSON.parse(raw);
      if (data.type === "rating") {
        await addRating(
          data.username,
          data.displayName,
          data.score,
          data.avatar || null,
          data.platform || "twitch"
        );
      }
    } catch (e) {
      console.error("WS message error:", e.message);
    }
  });
});

function connectCinefy() {
  if (cinefyWs) try { cinefyWs.terminate(); } catch (e) {}
  console.log("[Cinefy] Conectando...");
  cinefyWs = new WebSocket(CINEFY_PUSHER_URL);

  cinefyWs.on("open", () => {
    console.log("[Cinefy] Conectado");
    cinefyWs.send(JSON.stringify({
      event: "pusher:subscribe",
      data: { channel: "chatroom." + CINEFY_CHANNEL_ID }
    }));
  });

  cinefyWs.on("message", async (raw) => {
    try {
      const payload = JSON.parse(raw.toString());
      const evt = payload.event || "";

      if (evt === "pusher:pong" || evt === "pusher_internal:subscription_succeeded") return;

      let data = payload.data;
      if (typeof data === "string") {
        try { data = JSON.parse(data); } catch (e) { return; }
      }
      if (!data || typeof data !== "object") return;

      const text = (data.content || data.message || data.text || data.body || data.msg || "").toString().trim();
      if (!text) return;

      // --- EXTRAÇÃO MELHORADA DO AVATAR CINEFY ---
      const sender = data.sender || data.user || data.author || data.from || data.member || {};

      // Log completo do sender para debug (só a primeira vez / quando tiver nota)
      const lower = text.toLowerCase();
      const isNota = /^\d+(\.\d+)?$/.test(lower) || /^!(?:nota|n)\s*\d+/.test(lower);
      if (isNota) {
        console.log("[Cinefy SENDER]", JSON.stringify(sender).substring(0, 400));
      }

      const username = (
        sender.username ||
        sender.slug ||
        sender.name ||
        sender.login ||
        sender.user_name ||
        data.username ||
        ""
      ).toLowerCase();

      const displayName =
        sender.username ||
        sender.name ||
        sender.display_name ||
        sender.displayName ||
        data.username ||
        username;

      // Tenta TODOS os campos possíveis de foto
      let avatar =
        sender.profile_pic ||
        sender.profile_picture ||
        sender.profilePicture ||
        sender.avatar ||
        sender.avatar_url ||
        sender.image ||
        sender.photo ||
        sender.picture ||
        (sender.identity && (sender.identity.avatar || sender.identity.profile_pic)) ||
        null;

      // Se avatar for objeto, tenta pegar .url
      if (avatar && typeof avatar === "object") {
        avatar = avatar.url || avatar.src || avatar.href || null;
      }

      if (!username) return;

      console.log("[Cinefy MSG]", displayName + ":", text, "| avatar:", avatar ? "SIM" : "NÃO");

      let score = null;
      if (/^\d+(\.\d+)?$/.test(lower)) score = parseFloat(lower);
      else {
        const m = lower.match(/^!(?:nota|n)\s*(\d+(?:\.\d+)?)$/);
        if (m) score = parseFloat(m[1]);
      }

      if (score !== null && score >= 0 && score <= 10) {
        await addRating(username, displayName, score, avatar, "cinefy");
      }
    } catch (e) {
      console.error("[Cinefy parse]", e.message);
    }
  });

  cinefyWs.on("close", () => {
    console.log("[Cinefy] Caiu. Reconectando em 5s...");
    setTimeout(connectCinefy, 5000);
  });

  cinefyWs.on("error", (err) => console.error("[Cinefy erro]", err.message));
}

app.post("/movie-ended", async (req, res) => {
  const title = req.body.title;
  if (!title) return res.status(400).json({ error: "title obrigatório" });
  console.log(">>> Filme:", title);
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
app.get("/", (req, res) => res.send("Backend + Cinefy online"));

app.get("/search", async (req, res) => {
  const q = req.query.q, type = req.query.type || "movie", year = req.query.year || "";
  if (!q) return res.json([]);
  try {
    let url = "https://api.themoviedb.org/3/search/" + type + "?api_key=" + TMDB_API_KEY + "&query=" + encodeURIComponent(q) + "&language=pt-BR";
    if (year) url += "&year=" + year;
    const r = await fetch(url);
    const data = await r.json();
    res.json((data.results || []).slice(0, 16).map(i => ({
      title: i.title || i.name,
      year: (i.release_date || i.first_air_date || "").substring(0, 4) || null,
      poster: i.poster_path ? "https://image.tmdb.org/t/p/w300" + i.poster_path : null,
      type
    })));
  } catch (e) { res.json([]); }
});

app.get("/painel", (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Painel</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui;background:#0f1117;color:#eee;padding:24px}
input{padding:10px;border-radius:8px;border:1px solid #333;background:#161b22;color:#fff;width:300px}
button{padding:10px 16px;border:none;border-radius:8px;background:#8b5cf6;color:#fff;cursor:pointer;margin-left:8px}
#results{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px;margin-top:16px}
.card{background:#161b22;border-radius:8px;overflow:hidden;cursor:pointer}.card img{width:100%;height:180px;object-fit:cover}
.card div{padding:8px;font-size:13px}</style></head><body>
<h2>Painel Manual</h2>
<input id="q" placeholder="Filme ou série" onkeydown="if(event.key==='Enter')search()">
<button onclick="search()">Buscar</button>
<div id="results"></div><div id="status" style="margin-top:12px;color:#4ade80"></div>
<script>
async function search(){const q=document.getElementById("q").value.trim();if(q.length<2)return;
const r=await fetch("/search?q="+encodeURIComponent(q));const d=await r.json();
document.getElementById("results").innerHTML=d.map(i=>'<div class="card" onclick=\\'act('+JSON.stringify(i)+')\\'><img src="'+(i.poster||'')+'"><div>'+i.title+(i.year?' ('+i.year+')':'')+'</div></div>').join("")}
async function act(i){document.getElementById("status").textContent="Ativando...";
await fetch("/movie-ended",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({title:i.title+(i.year?" ("+i.year+")":"")})});
document.getElementById("status").textContent="OK: "+i.title}
</script></body></html>`);
});

server.listen(PORT, () => {
  console.log("Backend online porta", PORT);
  connectCinefy();
});
