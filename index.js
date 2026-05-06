const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Client, GatewayIntentBits } = require("discord.js");

const app = express();
app.use(express.json());
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    allowEIO3: true,
    transports: ['polling', 'websocket']
});

const port = process.env.PORT || 3000;

const ADMIN_PASS    = process.env.ADMIN_PASS    || "ADMIN_PADRAO_MUDE_NO_RENDER";
const SCRIPT_SECRET = process.env.SCRIPT_SECRET || "BOB_SECURE_2024_XYZ";

const DISCORD_TOKEN_NOTIFIER = process.env.DISCORD_TOKEN_NOTIFIER;
const DISCORD_TOKEN_LOGS     = process.env.DISCORD_TOKEN_LOGS;
const DISCORD_CHANNEL_ID     = process.env.DISCORD_CHANNEL_ID || "1494529159484149801";

const keys      = {};
const brainrots = [];
const presence  = {};
const kicked    = {}; // { keyName: timestamp } — sinaliza reset de HWID

// ─── UTILS ────────────────────────────────────────────────────────────────────
const formatTime = (ms) => {
    if (ms === Infinity) return "Lifetime";
    if (ms <= 0) return "Expirado";
    let t = Math.floor(ms / 1000);
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    const p = [];
    if (h > 0) p.push(h + "h");
    if (m > 0) p.push(m + "m");
    if (s > 0 || !p.length) p.push(s + "s");
    return p.join(" ");
};

const findKey = (name) =>
    Object.keys(keys).find(k => k.toLowerCase() === (name || "").toLowerCase());

const checkKey = (key, secret, hwid) => {
    if (secret !== SCRIPT_SECRET) return { ok: false, error: "Secret invalido" };
    const keyName = findKey(key);
    const data = keys[keyName];
    if (!data)       return { ok: false, error: "Chave nao existe" };
    if (data.paused) return { ok: false, error: "Chave pausada" };
    if (data.expiry !== Infinity && data.expiry - Date.now() <= 0) {
        delete keys[keyName];
        return { ok: false, error: "Chave expirada" };
    }
    if (!data.hwid) { data.hwid = hwid; }
    else if (data.hwid !== hwid) return { ok: false, error: "HWID invalido" };
    return { ok: true, data, keyName };
};

// ─── BOT NOTIFIER ─────────────────────────────────────────────────────────────
const clientNotifier = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildWebhooks
    ]
});

clientNotifier.on("ready", () => {
    console.log(`[NOTIFIER] Online: ${clientNotifier.user.tag}`);
    console.log(`[NOTIFIER] Monitorando canal: ${DISCORD_CHANNEL_ID}`);
});

clientNotifier.on("messageCreate", async (message) => {
    console.log(`[DEBUG] Canal: ${message.channel.id} | Autor: ${message.author.tag} | Bot: ${message.author.bot} | Embeds: ${message.embeds.length}`);

    if (message.author.bot && message.author.id === clientNotifier.user?.id) return;
    if (message.channel.id !== DISCORD_CHANNEL_ID) return;
    if (!message.embeds.length) return;

    const embed = message.embeds[0];
    let jobId = null, value = "0", players = "N/A";

    if (embed.fields) {
        for (const f of embed.fields) {
            const fn = f.name.toLowerCase();
            console.log(`[DEBUG] Field: "${f.name}" = "${f.value}"`);
            if (fn.includes("jobid") || fn.includes("job")) jobId = f.value.trim();
            if (fn.includes("value") || fn.includes("valor")) value = f.value.trim();
            if (fn.includes("player")) players = f.value.trim();
        }
    }

    const payload = {
        id:          Date.now().toString(),
        title:       embed.title       || "Bob!",
        description: embed.description || "Novo Alerta!",
        brainrot:    embed.title       || "Brainrot",
        name:        embed.title       || "Brainrot",
        jobId, value, players
    };

    brainrots.push(payload);
    if (brainrots.length > 100) brainrots.shift();
    io.emit("brainrot", payload);
    console.log(`[NOTIFIER] ✅ ${payload.title} | jobId: ${jobId}`);
});

// ─── BOT LOGS ─────────────────────────────────────────────────────────────────
const clientLogs = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

clientLogs.on("ready", () => console.log(`[LOGS] Online: ${clientLogs.user.tag}`));

clientLogs.on("messageCreate", async (message) => {
    if (message.author.bot) return;
    if (!message.content.startsWith("!")) return;

    const args = message.content.slice(1).trim().split(/ +/);
    const cmd  = args.shift().toLowerCase();

    switch (cmd) {
        case "test": {
            const payload = {
                id: Date.now().toString(), title: "TESTE", description: "SINAL OK!",
                brainrot: "TESTE", name: "TESTE", jobId: null, value: "999999999", players: "N/A"
            };
            brainrots.push(payload);
            io.emit("brainrot", payload);
            message.reply("✅ Teste enviado!");
            break;
        }
        case "info": {
            const ks = Object.keys(keys);
            if (!ks.length) { message.reply("Nenhuma chave ativa."); break; }
            let info = "**Chaves Ativas:**\n";
            for (const k of ks) {
                const d = keys[k];
                const t = d.paused ? d.remaining : (d.expiry === Infinity ? Infinity : d.expiry - Date.now());
                info += `• \`${k}\`: ${formatTime(t)} ${d.paused ? "⏸️" : "✅"} ${d.hwid ? `(HWID: ${d.hwid.substring(0,6)}...)` : "(Livre)"}\n`;
            }
            message.reply(info);
            break;
        }
        case "create": {
            if (args.length < 4) { message.reply("Uso: `!create <h> <m> <nome> <senha>`"); break; }
            const [h, m, name, pass] = args;
            if (pass !== ADMIN_PASS) { message.reply("❌ Senha incorreta!"); break; }
            const dur = (parseInt(h) * 3600 + parseInt(m) * 60) * 1000;
            keys[name] = { expiry: Date.now() + dur, paused: false, remaining: dur, hwid: null };
            message.reply(`✅ Chave \`${name}\` criada! Duração: ${formatTime(dur)}`);
            break;
        }
        case "lifetime": {
            const [name, pass] = args;
            if (pass !== ADMIN_PASS) { message.reply("❌ Senha incorreta!"); break; }
            keys[name] = { expiry: Infinity, paused: false, remaining: Infinity, hwid: null };
            message.reply(`✅ Chave \`${name}\` criada como **Lifetime**!`);
            break;
        }
        case "reset": {
            const [name, pass] = args;
            if (pass !== ADMIN_PASS) { message.reply("❌ Senha incorreta!"); break; }
            const t = findKey(name);
            if (!t) { message.reply("❌ Chave não encontrada."); break; }
            keys[t].hwid = null;
            kicked[t.toLowerCase()] = Date.now(); // sinaliza kick imediato
            message.reply(`✅ HWID de \`${t}\` resetado! Usuário será desconectado em segundos.`);
            break;
        }
        case "pause": {
            const [name, pass] = args;
            if (pass !== ADMIN_PASS) { message.reply("❌ Senha incorreta!"); break; }
            const t = findKey(name);
            if (!t) { message.reply("❌ Chave não encontrada."); break; }
            const d = keys[t];
            if (d.paused) {
                d.expiry = Date.now() + d.remaining; d.paused = false;
                message.reply(`▶️ \`${t}\` retomada! Tempo: ${formatTime(d.remaining)}`);
            } else {
                d.remaining = d.expiry === Infinity ? Infinity : d.expiry - Date.now();
                d.paused = true;
                message.reply(`⏸️ \`${t}\` pausada! Usuário será desconectado em segundos.`);
            }
            break;
        }
        case "revoke": {
            const [name, pass] = args;
            if (pass !== ADMIN_PASS) { message.reply("❌ Senha incorreta!"); break; }
            const t = findKey(name);
            if (!t) { message.reply("❌ Chave não encontrada."); break; }
            delete keys[t];
            message.reply(`🗑️ \`${t}\` removida.`);
            break;
        }
        case "extend": {
            if (args.length < 4) { message.reply("Uso: `!extend <nome> <h> <m> <senha>`"); break; }
            const [name, h, m, pass] = args;
            if (pass !== ADMIN_PASS) { message.reply("❌ Senha incorreta!"); break; }
            const t = findKey(name);
            if (!t) { message.reply("❌ Chave não encontrada."); break; }
            const extra = (parseInt(h) * 3600 + parseInt(m) * 60) * 1000;
            const d = keys[t];
            if (d.paused) d.remaining += extra;
            else if (d.expiry !== Infinity) d.expiry += extra;
            message.reply(`✅ \`${t}\` estendida em ${formatTime(extra)}!`);
            break;
        }
        case "help": {
            message.reply(
                "**📋 Comandos:**\n" +
                "`!create <h> <m> <nome> <senha>` — Cria chave\n" +
                "`!lifetime <nome> <senha>` — Cria chave lifetime\n" +
                "`!revoke <nome> <senha>` — Remove chave\n" +
                "`!reset <nome> <senha>` — Reseta HWID e desconecta usuário\n" +
                "`!pause <nome> <senha>` — Pausa/retoma\n" +
                "`!extend <nome> <h> <m> <senha>` — Adiciona tempo\n" +
                "`!info` — Lista chaves ativas\n" +
                "`!test` — Envia brainrot de teste"
            );
            break;
        }
    }
});

// ─── ENDPOINTS ────────────────────────────────────────────────────────────────

app.get("/validate", (req, res) => {
    const { key, secret, hwid } = req.query;
    const r = checkKey(key, secret, hwid);
    if (!r.ok) return res.status(403).send("Erro: " + r.error);
    const timeLeft = r.data.expiry === Infinity ? Infinity : r.data.expiry - Date.now();
    res.json({ status: "success", time_left: timeLeft });
});

app.get("/get-brainrots", (req, res) => {
    const { key, secret, hwid, lastId } = req.query;
    const r = checkKey(key, secret, hwid);
    if (!r.ok) return res.status(403).json({ status: "error", message: r.error });
    if (!brainrots.length) return res.json({ status: "waiting" });
    const latest = brainrots[brainrots.length - 1];
    if (latest.id === lastId) return res.json({ status: "waiting" });
    res.json({ status: "success", brainrot: latest });
});

app.get("/logs", (req, res) => {
    const { key, secret, hwid } = req.query;
    const r = checkKey(key, secret, hwid);
    if (!r.ok) return res.status(403).json({ status: "error", message: r.error });
    res.json(brainrots);
});

app.get("/api/latest", (req, res) => {
    const { key, secret, hwid } = req.query;
    const r = checkKey(key, secret, hwid);
    if (!r.ok) return res.status(403).json({ status: "error", message: r.error });
    if (!brainrots.length) return res.json({ status: "waiting" });
    res.json(brainrots[brainrots.length - 1]);
});

// Verifica se o usuário foi kickado por reset de HWID
app.get("/kicked", (req, res) => {
    const { key, secret } = req.query;
    if (secret !== SCRIPT_SECRET) return res.json({ kicked: false });
    const keyName = findKey(key);
    if (!keyName) return res.json({ kicked: false });
    const ts = kicked[keyName.toLowerCase()];
    if (ts) {
        delete kicked[keyName.toLowerCase()];
        return res.json({ kicked: true });
    }
    res.json({ kicked: false });
});

app.post("/presence", (req, res) => {
    const { key, secret, hwid, sessionId, name } = req.query;
    const r = checkKey(key, secret, hwid);
    if (!r.ok) return res.status(403).json({ status: "error", message: r.error });
    presence[sessionId] = { name: name || "Unknown", lastSeen: Date.now() };
    res.json({ status: "ok" });
});

app.get("/presence", (req, res) => {
    const { key, secret, hwid } = req.query;
    const r = checkKey(key, secret, hwid);
    if (!r.ok) return res.status(403).json({ status: "error", message: r.error });
    const now = Date.now();
    const active = {};
    for (const [sid, info] of Object.entries(presence)) {
        if (now - info.lastSeen < 30000) active[info.name] = true;
        else delete presence[sid];
    }
    res.json(Object.keys(active).sort());
});

app.get("/clients", (req, res) =>
    res.send(`Socket.IO: ${io.sockets.sockets.size} | Presença: ${Object.keys(presence).length}`)
);

app.get("/test-emit", (req, res) => {
    if (req.query.secret !== SCRIPT_SECRET) return res.status(403).send("Secret invalido");
    const p = { id: Date.now().toString(), title: "TESTE MANUAL", description: "OK!", brainrot: "TESTE", name: "TESTE", jobId: null, value: "0" };
    brainrots.push(p);
    io.emit("brainrot", p);
    res.send("✅ Emit enviado!");
});

app.get("/", (req, res) => res.send("<h1>Bob Dual API v6 — Online! ✅</h1>"));

// ─── LOGIN ────────────────────────────────────────────────────────────────────
if (DISCORD_TOKEN_NOTIFIER) clientNotifier.login(DISCORD_TOKEN_NOTIFIER).catch(e => console.error("[NOTIFIER]", e));
else console.warn("[NOTIFIER] Token não definido.");

if (DISCORD_TOKEN_LOGS) clientLogs.login(DISCORD_TOKEN_LOGS).catch(e => console.error("[LOGS]", e));
else console.warn("[LOGS] Token não definido.");

server.listen(port, () => console.log(`[SERVER] Porta ${port}`));