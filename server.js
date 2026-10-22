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
// Kick: chave atual com fallback para a chave pública anterior.
const KICK_PUSHER_KEYS = ["34bf7a0ff419a2a775b9", "32cbd69e4b950bf97679"];
const KICK_CHANNEL_SLUG = process.env.KICK_CHANNEL_SLUG || "carolinaporto";
const PORT = process.env.PORT || 3000;

let currentMovie = null;
let twitchToken = null;
let tokenExpires = 0;
let cinefyWs = null;
let kickWs = null;
let kickReconnectTimer = null;
let kickKeyIndex = 0;
let kickChatroomId = null;
// Evita que mensagens simultâneas do mesmo usuário criem votos duplicados.
const pendingRatingKeys = new Set();

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

function normalizeRatingKey(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

async function addRating(username, displayName, score, avatar, platform) {
  if (!currentMovie) {
    console.log("[IGNORADO] Nenhum filme ativo");
    return;
  }

  const userKey = normalizeRatingKey(username);
  const nameKey = normalizeRatingKey(displayName || username);
  const keys = [userKey, nameKey].filter(Boolean);

  // Também limpa duplicatas que já possam estar no estado atual.
  const seenUsers = new Set();
  currentMovie.ratings = currentMovie.ratings.filter(r => {
    const ru = normalizeRatingKey(r.username);
    const rd = normalizeRatingKey(r.displayName || r.username);
    const identity = ru || rd;
    if ((ru && seenUsers.has("u:" + ru)) || (rd && seenUsers.has("d:" + rd)) || (identity && seenUsers.has("i:" + identity))) {
      return false;
    }
    if (ru) seenUsers.add("u:" + ru);
    if (rd) seenUsers.add("d:" + rd);
    if (identity) seenUsers.add("i:" + identity);
    return true;
  });

  const already = currentMovie.ratings.some(r => {
    const ru = normalizeRatingKey(r.username);
    const rd = normalizeRatingKey(r.displayName || r.username);
    return (userKey && (ru === userKey || rd === userKey)) ||
           (nameKey && (ru === nameKey || rd === nameKey));
  });

  // Reserva as identidades antes de qualquer await para bloquear mensagens simultâneas.
  if (already || keys.some(key => pendingRatingKeys.has(key))) {
    console.log("[IGNORADO] Voto duplicado:", displayName || username);
    return;
  }
  keys.forEach(key => pendingRatingKeys.add(key));

  try {
    let finalAvatar = avatar;
    if (!(typeof finalAvatar === "string" && finalAvatar.startsWith("http")) &&
        (platform === "twitch" || platform === "kick")) {
      finalAvatar = await getTwitchAvatar(username);
    }
    if (!(typeof finalAvatar === "string" && finalAvatar.startsWith("http"))) {
      finalAvatar = makeFallbackAvatar(displayName || username);
    }

    // Reconfere após a busca de avatar, pois o estado pode ter mudado durante o await.
    const duplicateAfterWait = currentMovie.ratings.some(r => {
      const ru = normalizeRatingKey(r.username);
      const rd = normalizeRatingKey(r.displayName || r.username);
      return (userKey && (ru === userKey || rd === userKey)) ||
             (nameKey && (ru === nameKey || rd === nameKey));
    });
    if (duplicateAfterWait) {
      console.log("[IGNORADO] Voto duplicado após espera:", displayName || username);
      return;
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
    console.log("[NOTA OK]", platform, "|", displayName, "→", score);
  } finally {
    keys.forEach(key => pendingRatingKeys.delete(key));
  }
}

wss.on("connection", (ws) => {
  console.log("Overlay conectado | Filme:", currentMovie ? currentMovie.title : "nenhum");
  if (currentMovie) ws.send(JSON.stringify({ type: "state", movie: currentMovie }));

  ws.on("message", async (raw) => {
    try {
      const data = JSON.parse(raw);
      if (data.type === "rating") {
        await addRating(data.username, data.displayName, data.score, data.avatar || null, data.platform || "twitch");
      }
    } catch (e) {}
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

      const sender = data.sender || data.user || data.author || data.from || data.member || {};
      const username = (sender.username || sender.slug || sender.name || sender.login || sender.user_name || data.username || "").toLowerCase();
      const displayName = sender.username || sender.name || sender.display_name || sender.displayName || data.username || username;

      let avatar =
        sender.profile_pic || sender.profile_picture || sender.profilePicture ||
        sender.avatar || sender.avatar_url || sender.image || sender.photo || sender.picture ||
        (sender.identity && (sender.identity.avatar || sender.identity.profile_pic)) || null;

      if (avatar && typeof avatar === "object") {
        avatar = avatar.url || avatar.src || avatar.href || null;
      }

      if (!username) return;

      const lower = text.toLowerCase();
      let score = null;
      if (/^\d+(\.\d+)?$/.test(lower)) score = parseFloat(lower);
      else {
        const m = lower.match(/^!(?:nota|n)\s*(\d+(?:\.\d+)?)$/);
        if (m) score = parseFloat(m[1]);
      }

      if (score !== null && score >= 0 && score <= 10) {
        console.log("[Cinefy MSG]", displayName + ":", text);
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


async function resolveKickChatroomId() {
  // Tenta as duas rotas públicas usadas pela Kick; a resposta pode variar.
  for (const url of [
    `https://kick.com/api/v2/channels/${encodeURIComponent(KICK_CHANNEL_SLUG)}`,
    `https://kick.com/api/v1/channels/${encodeURIComponent(KICK_CHANNEL_SLUG)}`
  ]) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } });
      if (!res.ok) continue;
      const body = await res.json();
      const id = body?.chatroom?.id || body?.data?.chatroom?.id || body?.channel?.chatroom?.id;
      if (id) return String(id);
    } catch (e) {
      console.error("[Kick] Falha ao resolver chatroom:", e.message);
    }
  }
  return null;
}

function connectKick() {
  if (kickWs) {
    try { kickWs.removeAllListeners(); kickWs.terminate(); } catch (e) {}
    kickWs = null;
  }
  if (kickReconnectTimer) clearTimeout(kickReconnectTimer);

  (async () => {
    if (!kickChatroomId) kickChatroomId = await resolveKickChatroomId();
    if (!kickChatroomId) {
      console.error(`[Kick] Não consegui obter o chatroom ID de ${KICK_CHANNEL_SLUG}. Verifique se a API da Kick está acessível.`);
      kickReconnectTimer = setTimeout(connectKick, 10000);
      return;
    }

    const key = KICK_PUSHER_KEYS[kickKeyIndex];
    const url = `wss://ws-us2.pusher.com/app/${key}?protocol=7&client=js&version=8.4.0&flash=false`;
    console.log(`[Kick] Conectando ao chat ${KICK_CHANNEL_SLUG} (chave ${kickKeyIndex + 1}/${KICK_PUSHER_KEYS.length})...`);
    const ws = new WebSocket(url);
    kickWs = ws;
    let subscribed = false;

    ws.on("open", () => console.log("[Kick] WebSocket aberto; aguardando Pusher"));
    ws.on("message", async (raw) => {
      try {
        const packet = JSON.parse(raw.toString());
        if (packet.event === "pusher:connection_established") {
          ws.send(JSON.stringify({ event: "pusher:subscribe", data: { auth: "", channel: `chatrooms.${kickChatroomId}.v2` } }));
          subscribed = true;
          console.log("[Kick] Inscrição enviada para chatrooms." + kickChatroomId + ".v2");
          return;
        }
        if (packet.event === "pusher:ping") {
          ws.send(JSON.stringify({ event: "pusher:pong", data: {} }));
          return;
        }
        if (packet.event === "pusher:subscription_error") {
          console.error("[Kick] Inscrição recusada; tentando chave alternativa.");
          kickKeyIndex = (kickKeyIndex + 1) % KICK_PUSHER_KEYS.length;
          try { ws.close(); } catch (e) {}
          return;
        }
        if (packet.event !== "App\\Events\\ChatMessageEvent" && packet.event !== "App\\Events\\ChatMessageSentEvent") return;
        let data = packet.data;
        if (typeof data === "string") {
          try { data = JSON.parse(data); } catch (e) { return; }
        }
        const text = String(data?.content || data?.message || data?.text || "").trim();
        const sender = data?.sender || data?.user || {};
        const username = String(sender.username || sender.slug || sender.name || sender.identity?.username || "").trim().toLowerCase();
        const displayName = String(sender.username || sender.name || sender.identity?.username || username).trim();
        let avatar = sender.profile_picture || sender.profile_pic || sender.avatar || sender.identity?.avatar || null;
        if (avatar && typeof avatar === "object") avatar = avatar.url || avatar.src || null;
        if (!text || !username) return;

        const lower = text.toLowerCase();
        let score = null;
        if (/^\d+(\.\d+)?$/.test(lower)) score = parseFloat(lower);
        else {
          const match = lower.match(/^!(?:nota|n)\s*(\d+(?:\.\d+)?)$/);
          if (match) score = parseFloat(match[1]);
        }
        if (score !== null && score >= 0 && score <= 10) {
          console.log("[Kick MSG]", displayName + ":", text);
          await addRating(username, displayName, score, avatar, "kick");
        }
      } catch (e) {
        console.error("[Kick parse]", e.message);
      }
    });
    ws.on("close", () => {
      if (kickWs !== ws) return;
      console.log("[Kick] Conexão fechada; reconectando em 5s...");
      if (!subscribed) kickKeyIndex = (kickKeyIndex + 1) % KICK_PUSHER_KEYS.length;
      kickReconnectTimer = setTimeout(connectKick, 5000);
    });
    ws.on("error", (err) => console.error("[Kick erro]", err.message));
  })().catch((e) => {
    console.error("[Kick] Erro de conexão:", e.message);
    kickReconnectTimer = setTimeout(connectKick, 10000);
  });
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
  console.log(">>> Overlay limpa");
  res.json({ ok: true });
});

app.get("/", (req, res) => res.send("Backend + Cinefy + Kick online"));

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

// ========== PAINEL COMPLETO ==========
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
    .container { max-width: 1100px; margin: 0 auto; padding: 24px; }
    .card-box { background: #161b22; border: 1px solid #21262d; border-radius: 12px; padding: 20px; margin-bottom: 20px; }
    .card-box h2 { font-size: 15px; font-weight: 600; margin-bottom: 14px; color: #c9d1d9; }
    .search-row { display: flex; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
    select, input { background: #0d1117; border: 1px solid #30363d; color: #e6edf3; padding: 10px 14px; border-radius: 8px; font-size: 14px; outline: none; }
    select { width: 110px; }
    input { flex: 1; min-width: 180px; }
    input:focus, select:focus { border-color: #8b5cf6; }
    .btn { padding: 10px 18px; border-radius: 8px; border: none; font-weight: 600; font-size: 14px; cursor: pointer; }
    .btn-primary { background: #8b5cf6; color: white; }
    .btn-primary:hover { background: #7c3aed; }
    .btn-outline { background: transparent; border: 1px solid #30363d; color: #c9d1d9; }
    .btn-outline:hover { background: #21262d; }
    .btn-danger { background: transparent; border: 1px solid #f85149; color: #f85149; }
    .btn-danger:hover { background: #f8514920; }
    .btn-sm { padding: 6px 12px; font-size: 12px; }
    #results { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 14px; }
    .movie-card { background: #0d1117; border: 1px solid #21262d; border-radius: 10px; overflow: hidden; cursor: pointer; transition: 0.15s; }
    .movie-card:hover { border-color: #8b5cf6; transform: translateY(-2px); }
    .movie-card img { width: 100%; height: 210px; object-fit: cover; background: #161b22; display: block; }
    .movie-card .info { padding: 10px; }
    .movie-card .title { font-size: 13px; font-weight: 600; margin-bottom: 4px; line-height: 1.3; }
    .movie-card .meta { font-size: 11px; color: #8b949e; }
    .current-box { display: flex; gap: 16px; align-items: center; }
    .current-box img { width: 60px; height: 90px; object-fit: cover; border-radius: 6px; background: #222; }
    .current-info { flex: 1; }
    .current-info strong { font-size: 16px; }
    .current-info span { display: block; font-size: 13px; color: #8b949e; margin-top: 4px; }
    .empty { color: #8b949e; font-size: 14px; }
    .status { margin-top: 12px; font-size: 13px; color: #3fb950; }
    .actions { display: flex; gap: 8px; margin-top: 10px; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1>Painel do Overlay</h1>
      <p>Pesquise, ative e limpe o que aparece na tela.</p>
    </div>
    <div class="badges">
      <div class="badge"><div class="dot"></div> TMDB</div>
      <div class="badge"><div class="dot"></div> Cinefy</div>
      <div class="badge"><div class="dot"></div> Overlay</div>
    </div>
  </div>

  <div class="container">
    <!-- Agora na overlay -->
    <div class="card-box">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
        <h2 style="margin:0">Agora na overlay</h2>
        <div style="display:flex;gap:8px;">
          <button class="btn btn-outline btn-sm" onclick="refreshState()">Atualizar</button>
          <button class="btn btn-danger btn-sm" onclick="clearOverlay()">Excluir da overlay</button>
        </div>
      </div>
      <div id="current" class="empty">Nenhum título ativo.</div>
    </div>

    <!-- Pesquisa -->
    <div class="card-box">
      <h2>Pesquisar filme ou série</h2>
      <div class="search-row">
        <select id="type">
          <option value="movie">Filme</option>
          <option value="tv">Série</option>
        </select>
        <input type="text" id="q" placeholder="Digite o nome..." autofocus>
        <input type="text" id="year" placeholder="Ano" style="width:90px;flex:0">
        <button class="btn btn-primary" onclick="search()">Pesquisar</button>
      </div>
      <div id="results"></div>
      <div class="status" id="status"></div>
    </div>
  </div>

  <script>
    async function search() {
      const q = document.getElementById("q").value.trim();
      const type = document.getElementById("type").value;
      const year = document.getElementById("year").value.trim();
      if (q.length < 2) return;

      const res = await fetch("/search?q=" + encodeURIComponent(q) + "&type=" + type + "&year=" + year);
      const data = await res.json();

      document.getElementById("results").innerHTML = data.map(function(item) {
        return '<div class="movie-card" onclick=\\'activate(' + JSON.stringify(item) + ')\\'>' +
          '<img src="' + (item.poster || 'https://via.placeholder.com/150x210/161b22/555?text=Sem') + '">' +
          '<div class="info">' +
            '<div class="title">' + item.title + '</div>' +
            '<div class="meta">' + (item.type === "tv" ? "Série" : "Filme") + (item.year ? " • " + item.year : "") + '</div>' +
          '</div></div>';
      }).join("") || '<div class="empty">Nenhum resultado.</div>';
    }

    async function activate(item) {
      document.getElementById("status").textContent = "Ativando: " + item.title + "...";
      const title = item.title + (item.year ? " (" + item.year + ")" : "");
      const res = await fetch("/movie-ended", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title })
      });
      if (res.ok) {
        document.getElementById("status").textContent = "✓ Ativado: " + item.title;
        refreshState();
      } else {
        document.getElementById("status").textContent = "Erro ao ativar";
      }
    }

    async function refreshState() {
      const res = await fetch("/state");
      const data = await res.json();
      const el = document.getElementById("current");
      if (data && data.title) {
        el.innerHTML =
          '<div class="current-box">' +
            (data.poster ? '<img src="' + data.poster + '">' : '') +
            '<div class="current-info">' +
              '<strong>' + data.title + '</strong>' +
              '<span>' + (data.year || "") + ' — ' + (data.ratings ? data.ratings.length : 0) + ' voto(s)</span>' +
            '</div>' +
          '</div>';
      } else {
        el.innerHTML = '<div class="empty">Nenhum título ativo.</div>';
      }
    }

    async function clearOverlay() {
      if (!confirm("Remover o título da overlay?")) return;
      await fetch("/reset", { method: "POST" });
      refreshState();
      document.getElementById("status").textContent = "Overlay limpa";
    }

    document.getElementById("q").addEventListener("keydown", function(e) {
      if (e.key === "Enter") search();
    });

    refreshState();
  </script>
</body>
</html>`);
});

server.listen(PORT, () => {
  console.log("Backend online porta", PORT);
  connectCinefy();
  connectKick();
});
