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
// RAWG API key fornecida pelo usuário para pesquisa de jogos.
const RAWG_API_KEY = "76ba8a32afc241e7b3d0dc9acd4bb7b8";
const TWITCH_CLIENT_ID = "sah4oubx3irkbvh6m4jf28s2mefx46";
const TWITCH_CLIENT_SECRET = "k271wxor46h79d66wohz47v85mxdhg";
const CINEFY_CHANNEL_ID = "d81e634a-3ab1-4217-bf35-94e8d3c5250a";
// Kick: chave atual com fallback para a chave pública anterior.
const KICK_PUSHER_KEYS = ["34bf7a0ff419a2a775b9", "32cbd69e4b950bf97679"];
const KICK_CHANNEL_SLUG = process.env.KICK_CHANNEL_SLUG || "carolinaporto";
const PORT = process.env.PORT || 3000;

let currentMovie = null;
let twitchToken = null;
let tokenExpires = 0;
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
        poster: item.poster_path ? "https://image.tmdb.org/t/p/w500" + item.poster_path : null,
        mediaType: item.media_type
      };
    }
  } catch (err) {}
  return { title, year: null, poster: null, mediaType: null };
}

function applyEpisodeTitle(movie) {
  if (movie.mediaType === "tv") {
    movie.title = movie.baseTitle + " EP" + movie.episode + " - T" + movie.season;
  }
}

async function getTitleById(id, type) {
  try {
    const t = type === "tv" ? "tv" : "movie";
    const url = "https://api.themoviedb.org/3/" + t + "/" + encodeURIComponent(id) + "?api_key=" + TMDB_API_KEY + "&language=pt-BR";
    const res = await fetch(url);
    if (!res.ok) throw new Error("TMDB HTTP " + res.status);
    const item = await res.json();
    return {
      title: item.title || item.name,
      year: (item.release_date || item.first_air_date || "").substring(0, 4),
      poster: item.poster_path ? "https://image.tmdb.org/t/p/w500" + item.poster_path : null,
      mediaType: t
    };
  } catch (err) {
    console.error("[TMDB por ID]", err.message);
    return null;
  }
}

async function searchGames(query, year = "") {
  try {
    let url = "https://api.rawg.io/api/games?key=" + RAWG_API_KEY + "&search=" + encodeURIComponent(query) + "&page_size=16";
    if (year) url += "&dates=" + year + "-01-01," + year + "-12-31";
    const res = await fetch(url);
    if (!res.ok) throw new Error("RAWG HTTP " + res.status);
    const data = await res.json();
    return (data.results || []).map(game => ({
      title: game.name,
      year: (game.released || "").substring(0, 4) || null,
      poster: game.background_image || null,
      type: "game"
    }));
  } catch (e) {
    console.error("[RAWG pesquisa]", e.message);
    return [];
  }
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
        platform === "twitch") {
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

// Cinefy: o chat não usa mais Pusher; as mensagens vêm de /v1/threads (consulta a cada 2s).
let cinefyTimer = null;
let cinefyFirstPoll = true;
let cinefyLastError = "";
let cinefySeen = new Set();

async function handleCinefyThread(t) {
  const text = String(t.content || "").trim();
  if (!text) return;
  const author = t.author || {};
  const username = String(author.slug || author.username || "").trim().toLowerCase();
  const displayName = String(author.displayName || author.username || username).trim();
  if (!username) return;

  let avatar = null;
  if (typeof author.avatar === "string" && author.avatar) {
    avatar = author.avatar.startsWith("http") ? author.avatar : "https://cdn.cinefy.gg/avatars/" + encodeURIComponent(author.avatar);
  }

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
}

async function pollCinefy() {
  try {
    const url = "https://api.cinefy.gg/v1/threads?contextType=live&contextId=" + encodeURIComponent(CINEFY_CHANNEL_ID) + "&perPage=75";
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
        "Accept": "application/json",
        "Origin": "https://cinefy.gg",
        "Referer": "https://cinefy.gg/"
      },
      timeout: 10000
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const body = await res.json();
    const list = (Array.isArray(body) ? body : Array.isArray(body && body.data) ? body.data : [])
      .filter(t => t && t.id)
      .sort((a, b) => String(a.publishedAt || "").localeCompare(String(b.publishedAt || "")));

    if (cinefyLastError) { console.log("[Cinefy] Conexão restabelecida"); cinefyLastError = ""; }

    for (const t of list) {
      if (cinefySeen.has(t.id)) continue;
      cinefySeen.add(t.id);
      if (cinefyFirstPoll) continue; // mensagens que já estavam no chat não contam como nota
      try { await handleCinefyThread(t); } catch (e) { console.error("[Cinefy parse]", e.message); }
    }
    if (cinefyFirstPoll) {
      cinefyFirstPoll = false;
      console.log("[Cinefy] CHAT CONECTADO: lendo mensagens novas (" + list.length + " antigas ignoradas).");
    }
    if (cinefySeen.size > 2000) cinefySeen = new Set(Array.from(cinefySeen).slice(-500));
  } catch (e) {
    if (e.message !== cinefyLastError) {
      console.error("[Cinefy erro]", e.message);
      cinefyLastError = e.message;
    }
  }
  cinefyTimer = setTimeout(pollCinefy, 2000);
}

function connectCinefy() {
  if (cinefyTimer) clearTimeout(cinefyTimer);
  console.log("[Cinefy] Iniciando leitura do chat...");
  pollCinefy();
}


async function resolveKickChatroomId() {
  // A Kick mudou os formatos de resposta ao longo do tempo; tentamos primeiro
  // os endpoints diretos e depois proxies HTTP como fallback para bloqueios do servidor.
  const slug = encodeURIComponent(KICK_CHANNEL_SLUG);
  const directUrls = [
    `https://kick.com/api/v2/channels/${slug}/chatroom`,
    `https://kick.com/api/v2/channels/${slug}`,
    `https://kick.com/api/v1/channels/${slug}`
  ];
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Referer": `https://kick.com/${KICK_CHANNEL_SLUG}`,
    "Origin": "https://kick.com"
  };
  const findId = (body) => {
    const candidates = [
      body?.chatroom?.id,
      body?.data?.chatroom?.id,
      body?.channel?.chatroom?.id,
      body?.data?.id,
      body?.id
    ];
    const value = candidates.find(v => v !== undefined && v !== null && String(v).trim() !== "");
    return value ? String(value) : null;
  };

  for (const url of directUrls) {
    try {
      const res = await fetch(url, { headers, timeout: 8000 });
      if (!res.ok) {
        console.warn(`[Kick] Endpoint ${new URL(url).pathname} respondeu HTTP ${res.status}`);
        continue;
      }
      const body = await res.json();
      const id = findId(body);
      if (id) {
        console.log(`[Kick] Chatroom ID resolvido: ${id}`);
        return id;
      }
    } catch (e) {
      console.warn("[Kick] Consulta direta falhou:", e.message);
    }
  }

  const proxyUrls = [
    `https://corsproxy.io/?url=${encodeURIComponent(directUrls[1])}`,
    `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(directUrls[1])}`
  ];
  for (const url of proxyUrls) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": headers["User-Agent"], "Accept": "application/json" }, timeout: 10000 });
      if (!res.ok) continue;
      const body = await res.json();
      const id = findId(body);
      if (id) {
        console.log(`[Kick] Chatroom ID resolvido via fallback: ${id}`);
        return id;
      }
    } catch (e) {
      console.warn("[Kick] Fallback de consulta falhou:", e.message);
    }
  }
  return null;
}

function connectKick() {
  if (kickReconnectTimer) {
    clearTimeout(kickReconnectTimer);
    kickReconnectTimer = null;
  }
  if (kickWs) {
    try { kickWs.removeAllListeners(); kickWs.terminate(); } catch (e) {}
    kickWs = null;
  }

  (async () => {
    if (!kickChatroomId) kickChatroomId = await resolveKickChatroomId();
    if (!kickChatroomId) {
      console.error(`[Kick] Não consegui resolver o chatroom ID de ${KICK_CHANNEL_SLUG}. Vou tentar novamente em 15s.`);
      kickReconnectTimer = setTimeout(connectKick, 15000);
      return;
    }

    const key = KICK_PUSHER_KEYS[kickKeyIndex];
    const url = `wss://ws-us2.pusher.com/app/${key}?protocol=7&client=js&version=8.4.0&flash=false`;
    console.log(`[Kick] Conectando ao chat ${KICK_CHANNEL_SLUG} usando chave ${kickKeyIndex + 1}/${KICK_PUSHER_KEYS.length}...`);
    const ws = new WebSocket(url, { handshakeTimeout: 10000 });
    kickWs = ws;
    let subscribed = false;
    let subscribeSent = false;
    let fallbackAttempted = false;

    const scheduleReconnect = (delay = 5000) => {
      if (kickWs !== ws) return;
      kickWs = null;
      if (kickReconnectTimer) clearTimeout(kickReconnectTimer);
      kickReconnectTimer = setTimeout(connectKick, delay);
    };

    const tryFallbackKey = (reason) => {
      if (fallbackAttempted) return false;
      fallbackAttempted = true;
      if (kickKeyIndex < KICK_PUSHER_KEYS.length - 1) {
        kickKeyIndex += 1;
        console.warn(`[Kick] ${reason}; tentando chave alternativa ${kickKeyIndex + 1}/${KICK_PUSHER_KEYS.length}.`);
        if (kickWs === ws) kickWs = null;
        try { ws.close(); } catch (e) {}
        if (kickReconnectTimer) clearTimeout(kickReconnectTimer);
        kickReconnectTimer = setTimeout(connectKick, 250);
        return true;
      }
      return false;
    };

    ws.on("open", () => console.log("[Kick] WebSocket aberto; aguardando handshake Pusher."));
    ws.on("message", async (raw) => {
      try {
        const packet = JSON.parse(raw.toString());
        const event = String(packet.event || "");

        if (event === "pusher:connection_established") {
          if (!subscribeSent) {
            ws.send(JSON.stringify({
              event: "pusher:subscribe",
              data: { auth: "", channel: `chatrooms.${kickChatroomId}.v2` }
            }));
            subscribeSent = true;
            console.log("[Kick] Inscrição enviada para chatrooms." + kickChatroomId + ".v2");
          }
          return;
        }
        if (event === "pusher:ping") {
          ws.send(JSON.stringify({ event: "pusher:pong", data: {} }));
          return;
        }
        if (event === "pusher_internal:subscription_succeeded" || event === "pusher:subscription_succeeded") {
          subscribed = true;
          console.log("[Kick] CHAT CONECTADO: inscrição aceita; aguardando notas no chat.");
          return;
        }
        if (event === "pusher:subscription_error" || event === "pusher:error") {
          const detail = typeof packet.data === "string" ? packet.data : JSON.stringify(packet.data || {});
          console.error("[Kick] Erro do Pusher:", detail);
          if (!tryFallbackKey("Pusher recusou a conexão/inscrição")) scheduleReconnect(15000);
          return;
        }

        if (event !== "App\\Events\\ChatMessageEvent" && event !== "App\\Events\\ChatMessageSentEvent") return;
        let data = packet.data;
        if (typeof data === "string") {
          try { data = JSON.parse(data); } catch (e) { return; }
        }
        if (!data || typeof data !== "object") return;

        // Kick tem enviado payloads em mais de um formato. O texto às vezes fica
        // em data.content, outras vezes em data.message.message.
        const nestedMessage = data.message && typeof data.message === "object" ? data.message : null;
        const textValue = [
          data.content,
          data.text,
          data.body,
          nestedMessage?.content,
          nestedMessage?.message,
          nestedMessage?.text,
          typeof data.message === "string" ? data.message : null
        ].find(v => typeof v === "string" && v.trim());
        const text = String(textValue || "").trim();
        const sender = data.sender || data.user || data.author || nestedMessage?.sender || nestedMessage?.user || {};
        const username = String(sender.username || sender.slug || sender.name || sender.login || sender.user_name || sender.identity?.username || "").trim().toLowerCase();
        const displayName = String(sender.display_name || sender.displayName || sender.username || sender.name || sender.identity?.username || username).trim();
        let avatar = sender.profile_picture || sender.profile_pic || sender.profilePicture || sender.avatar || sender.avatar_url || sender.identity?.avatar || null;
        if (avatar && typeof avatar === "object") avatar = avatar.url || avatar.src || avatar.href || null;
        if (!text || !username) return;

        const lower = text.toLowerCase();
        let score = null;
        if (/^\d+(\.\d+)?$/.test(lower)) score = parseFloat(lower);
        else {
          const match = lower.match(/^!(?:nota|n)\s*(\d+(?:\.\d+)?)$/);
          if (match) score = parseFloat(match[1]);
        }
        if (score !== null && Number.isFinite(score) && score >= 0 && score <= 10) {
          console.log("[Kick MSG]", displayName + ":", text);
          await addRating(username, displayName, score, avatar, "kick");
        }
      } catch (e) {
        console.error("[Kick parse]", e.message);
      }
    });
    ws.on("close", (code, reason) => {
      if (kickWs !== ws) return;
      console.warn(`[Kick] WebSocket fechou (${code}${reason?.length ? ", " + reason.toString() : ""}); reconectando.`);
      if (!subscribed && !fallbackAttempted && kickKeyIndex < KICK_PUSHER_KEYS.length - 1) {
        kickKeyIndex += 1;
        console.warn(`[Kick] Tentando chave alternativa ${kickKeyIndex + 1}/${KICK_PUSHER_KEYS.length}.`);
      } else if (subscribed) {
        // Se a sessão já conectou, mantém a chave que funcionou.
      } else {
        kickKeyIndex = 0;
      }
      scheduleReconnect(5000);
    });
    ws.on("error", (err) => {
      console.error("[Kick erro]", err.message);
    });
  })().catch((e) => {
    console.error("[Kick] Falha ao iniciar conexão:", e.message);
    kickReconnectTimer = setTimeout(connectKick, 10000);
  });
}

app.post("/game-ended", (req, res) => {
  const title = req.body.title;
  if (!title) return res.status(400).json({ error: "title obrigatório" });
  const game = {
    title,
    year: req.body.year || null,
    poster: req.body.poster || null,
    ratings: [],
    startedAt: Date.now(),
    mediaType: "game"
  };
  currentMovie = game;
  broadcast({ type: "movie-started", movie: currentMovie });
  console.log(">>> Jogo:", title);
  res.json({ ok: true, movie: currentMovie });
});

app.post("/movie-ended", async (req, res) => {
  const { title, id, type } = req.body;
  if (!title && !id) return res.status(400).json({ error: "title ou id obrigatório" });
  console.log(">>> Filme/Série:", title || id, id ? "(tmdb id " + id + ", " + type + ")" : "");
  // Com ID, busca exatamente o título escolhido; sem ID, cai na busca por nome (comportamento antigo).
  let tmdb = id ? await getTitleById(id, type) : null;
  if (!tmdb) tmdb = await searchMovie(title);
  currentMovie = {
    title: tmdb.title,
    baseTitle: tmdb.title,
    year: tmdb.year,
    poster: tmdb.poster,
    mediaType: (type || tmdb.mediaType) === "tv" ? "tv" : "movie",
    season: 1,
    episode: 1,
    ratings: [],
    startedAt: Date.now()
  };
  applyEpisodeTitle(currentMovie);
  broadcast({ type: "movie-started", movie: currentMovie });
  res.json({ ok: true, movie: currentMovie });
});

// Troca episódio/temporada da série ativa e atualiza a overlay na hora (mantém as notas).
app.post("/episode", (req, res) => {
  if (!currentMovie || currentMovie.mediaType !== "tv") {
    return res.status(400).json({ error: "Nenhuma série ativa" });
  }
  const season = parseInt(req.body.season, 10);
  const episode = parseInt(req.body.episode, 10);
  if (!(season >= 1) || !(episode >= 1) || season > 999 || episode > 9999) {
    return res.status(400).json({ error: "Temporada/episódio inválidos" });
  }
  currentMovie.season = season;
  currentMovie.episode = episode;
  applyEpisodeTitle(currentMovie);
  broadcast({ type: "state", movie: currentMovie });
  console.log(">>> Episódio:", currentMovie.title);
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
  if (type === "game") return res.json(await searchGames(q, year));
  try {
    let url = "https://api.themoviedb.org/3/search/" + type + "?api_key=" + TMDB_API_KEY + "&query=" + encodeURIComponent(q) + "&language=pt-BR";
    if (year) url += "&year=" + year;
    const r = await fetch(url);
    const data = await r.json();
    res.json((data.results || []).slice(0, 16).map(i => ({
      id: i.id,
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
    #ep-box { display: none; border-top: 1px solid #21262d; margin-top: 16px; padding-top: 16px; }
    #ep-box .ep-title { font-size: 14px; font-weight: 600; margin-bottom: 12px; }
    .ep-row { display: flex; gap: 18px; flex-wrap: wrap; }
    .ep-field label { display: block; font-size: 11px; letter-spacing: 0.08em; color: #8b949e; font-weight: 700; margin-bottom: 6px; }
    .stepper { display: flex; gap: 6px; align-items: center; }
    .stepper input { flex: none; width: 76px; min-width: 0; text-align: center; font-size: 16px; font-weight: 600; -moz-appearance: textfield; }
    .stepper input::-webkit-outer-spin-button, .stepper input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
    .step-btn { width: 40px; height: 40px; border-radius: 8px; border: 1px solid #30363d; background: #21262d; color: #e6edf3; cursor: pointer; font-size: 14px; }
    .step-btn:hover { background: #30363d; border-color: #8b5cf6; }
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
      <div id="ep-box">
        <div class="ep-title">Episódio e temporada — atualiza automaticamente</div>
        <div class="ep-row">
          <div class="ep-field">
            <label>EPISÓDIO</label>
            <div class="stepper">
              <button class="step-btn" onclick="stepEp('ep-episode', -1)">▼</button>
              <input type="number" id="ep-episode" min="1" value="1" oninput="sendEpisodeSoon()">
              <button class="step-btn" onclick="stepEp('ep-episode', 1)">▲</button>
            </div>
          </div>
          <div class="ep-field">
            <label>TEMPORADA</label>
            <div class="stepper">
              <button class="step-btn" onclick="stepEp('ep-season', -1)">▼</button>
              <input type="number" id="ep-season" min="1" value="1" oninput="sendEpisodeSoon()">
              <button class="step-btn" onclick="stepEp('ep-season', 1)">▲</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Pesquisa -->
    <div class="card-box">
      <h2>Pesquisar filme, série ou jogo</h2>
      <div class="search-row">
        <select id="type">
          <option value="movie">Filme</option>
          <option value="tv">Série</option>
          <option value="game">Jogo</option>
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
            '<div class="meta">' + (item.type === "tv" ? "Série" : (item.type === "game" ? "Jogo" : "Filme")) + (item.year ? " • " + item.year : "") + '</div>' +
          '</div></div>';
      }).join("") || '<div class="empty">Nenhum resultado.</div>';
    }

    async function activate(item) {
      document.getElementById("status").textContent = "Ativando: " + item.title + "...";
      const title = item.title + (item.year ? " (" + item.year + ")" : "");
      const endpoint = item.type === "game" ? "/game-ended" : "/movie-ended";
      const payload = item.type === "game" ? { title: item.title, year: item.year, poster: item.poster } : { title: title, id: item.id, type: item.type };
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        document.getElementById("status").textContent = "✓ Ativado: " + item.title;
        refreshState();
      } else {
        document.getElementById("status").textContent = "Erro ao ativar";
      }
    }

    var epTimer = null;
    function updateEpBox(data) {
      var box = document.getElementById("ep-box");
      if (data && data.mediaType === "tv") {
        box.style.display = "block";
        var ae = document.activeElement ? document.activeElement.id : "";
        if (ae !== "ep-episode") document.getElementById("ep-episode").value = data.episode || 1;
        if (ae !== "ep-season") document.getElementById("ep-season").value = data.season || 1;
      } else {
        box.style.display = "none";
      }
    }
    function stepEp(id, delta) {
      var el = document.getElementById(id);
      el.value = Math.max(1, (parseInt(el.value, 10) || 1) + delta);
      sendEpisode();
    }
    function sendEpisodeSoon() {
      clearTimeout(epTimer);
      epTimer = setTimeout(sendEpisode, 400);
    }
    async function sendEpisode() {
      clearTimeout(epTimer);
      var episode = parseInt(document.getElementById("ep-episode").value, 10);
      var season = parseInt(document.getElementById("ep-season").value, 10);
      if (!(episode >= 1) || !(season >= 1)) return;
      var res = await fetch("/episode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ season: season, episode: episode })
      });
      if (res.ok) {
        document.getElementById("status").textContent = "✓ Overlay atualizada: EP" + episode + " - T" + season;
        refreshState();
      } else {
        document.getElementById("status").textContent = "Erro ao atualizar episódio";
      }
    }

    async function refreshState() {
      const res = await fetch("/state");
      const data = await res.json();
      updateEpBox(data);
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
