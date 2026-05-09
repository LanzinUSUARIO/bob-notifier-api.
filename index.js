const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Client, GatewayIntentBits,
    ActionRowBuilder, ButtonBuilder, ButtonStyle,
    EmbedBuilder, Events, ChannelType, Partials
} = require("discord.js");
const mongoose = require("mongoose");

// ─── XOR OBFUSCATION ──────────────────────────────────────────────────────────
const XOR_KEY = "AnarcoLinduKey2026Seilasoubonitoegostosohahahha";

function xorObfuscate(value) {
    if (!value) return value;
    const str = String(value);
    const key = XOR_KEY;
    let result = "";
    for (let i = 0; i < str.length; i++) {
        result += String.fromCharCode(str.charCodeAt(i) ^ key.charCodeAt(i % key.length));
    }
    return Buffer.from(result, "binary").toString("base64");
}

// ─── MONGODB ──────────────────────────────────────────────────────────────────
const MONGODB_URI = process.env.MONGODB_URI;
if (MONGODB_URI) {
    mongoose.connect(MONGODB_URI)
        .then(() => console.log("[DB] MongoDB conectado!"))
        .catch(e => console.error("[DB] Erro:", e.message));
} else {
    console.warn("[DB] MONGODB_URI não definido — keys não persistem!");
}

const KeySchema = new mongoose.Schema({
    name:      { type: String, required: true, unique: true },
    expiry:    { type: Number, default: Infinity },
    paused:    { type: Boolean, default: false },
    remaining: { type: Number, default: 0 },
    hwid:      { type: String, default: null },
    discordId: { type: String, default: null }
});
const KeyModel = mongoose.model("Key", KeySchema);

async function loadKeys() {
    try {
        const docs = await KeyModel.find({});
        let expired = 0;
        for (const d of docs) {
            // Já remove expiradas ao carregar
            if (d.expiry !== Infinity && d.expiry - Date.now() <= 0) {
                await KeyModel.deleteOne({ name: d.name });
                expired++;
                continue;
            }
            keys[d.name] = {
                expiry:    d.expiry,
                paused:    d.paused,
                remaining: d.remaining,
                hwid:      d.hwid,
                discordId: d.discordId
            };
        }
        console.log(`[DB] ${Object.keys(keys).length} keys carregadas. ${expired} expiradas removidas.`);
    } catch (e) {
        console.error("[DB] Erro ao carregar keys:", e.message);
    }
}

async function saveKey(name) {
    try {
        await KeyModel.findOneAndUpdate(
            { name },
            { name, ...keys[name] },
            { upsert: true, new: true }
        );
    } catch (e) {
        console.error("[DB] Erro ao salvar key:", e.message);
    }
}

async function deleteKey(name) {
    try {
        await KeyModel.deleteOne({ name });
    } catch (e) {
        console.error("[DB] Erro ao deletar key:", e.message);
    }
}

// ─── Limpa keys expiradas periodicamente ─────────────────────────────────────
setInterval(async () => {
    const now = Date.now();
    for (const [name, data] of Object.entries(keys)) {
        if (data.expiry !== Infinity && !data.paused && data.expiry - now <= 0) {
            delete keys[name];
            await deleteKey(name);
            console.log(`[CLEANUP] Key expirada removida: ${name}`);
        }
    }
}, 60000); // roda a cada 1 minuto

// ─── EXPRESS + SOCKET.IO ──────────────────────────────────────────────────────
const app = express();
app.use(express.json());
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    allowEIO3: true,
    transports: ['polling', 'websocket']
});

const port = process.env.PORT || 3000;

// ─── ENV VARS ─────────────────────────────────────────────────────────────────
const ADMIN_PASS    = process.env.ADMIN_PASS    || "ADMIN_PADRAO_MUDE_NO_RENDER";
const SCRIPT_SECRET = process.env.SCRIPT_SECRET || "BOB_SECURE_2024_XYZ";
const CLIENT_HEADER = process.env.CLIENT_HEADER || "BobJoiner-v2";

const DISCORD_TOKEN_NOTIFIER = process.env.DISCORD_TOKEN_NOTIFIER;
const DISCORD_TOKEN_LOGS     = process.env.DISCORD_TOKEN_LOGS;
const DISCORD_TOKEN_PANEL    = process.env.DISCORD_TOKEN_PANEL;
const DISCORD_CHANNEL_ID     = process.env.DISCORD_CHANNEL_ID || "1494529159484149801";
const PANEL_CHANNEL_ID       = process.env.PANEL_CHANNEL_ID   || "1502373185125875873"; // ← ATUALIZADO
const LOGS_CHANNEL_ID        = process.env.LOGS_CHANNEL_ID    || "";
const SCRIPT_URL             = process.env.SCRIPT_URL         || "";

// ─── STATE ────────────────────────────────────────────────────────────────────
const keys      = {};
const brainrots = [];
const presence  = {};
const kicked    = {};

// ─── Mapa de jobIds por usuário Roblox (name → jobId) ─────────────────────────
const userJobIds = {};

// ─── RATE LIMITER ─────────────────────────────────────────────────────────────
const RATE_LIMIT_MAX    = 60;
const RATE_LIMIT_WINDOW = 60000;
const BLOCK_DURATION    = 300000;

const rateLimitMap = {};
const blockedIPs   = {};

function getRealIP(req) {
    return (req.headers["x-forwarded-for"] || "").split(",")[0].trim()
        || req.socket.remoteAddress
        || "unknown";
}

async function logSecurityAlert(message) {
    if (!LOGS_CHANNEL_ID) return;
    try {
        const ch = await clientLogs.channels.fetch(LOGS_CHANNEL_ID);
        if (ch) {
            const embed = new EmbedBuilder()
                .setTitle("🚨 Alerta de Segurança")
                .setColor(0xFF3C3C)
                .setDescription(message)
                .setTimestamp();
            await ch.send({ embeds: [embed] });
        }
    } catch (_) {}
}

function rateLimitMiddleware(req, res, next) {
    const openRoutes = ["/health", "/"];
    if (openRoutes.includes(req.path)) return next();

    const ip  = getRealIP(req);
    const now = Date.now();

    if (blockedIPs[ip] && now < blockedIPs[ip]) {
        const remaining = Math.ceil((blockedIPs[ip] - now) / 1000);
        return res.status(429).json({ status: "error", message: `IP bloqueado. Tente em ${remaining}s.` });
    }
    if (blockedIPs[ip]) delete blockedIPs[ip];

    if (!rateLimitMap[ip] || now - rateLimitMap[ip].windowStart > RATE_LIMIT_WINDOW) {
        rateLimitMap[ip] = { count: 1, windowStart: now };
        return next();
    }

    rateLimitMap[ip].count++;

    if (rateLimitMap[ip].count > RATE_LIMIT_MAX) {
        blockedIPs[ip] = now + BLOCK_DURATION;
        console.warn(`[SECURITY] IP bloqueado: ${ip}`);
        logSecurityAlert(`🔴 IP \`${ip}\` bloqueado por rate limit (${rateLimitMap[ip].count} req/60s)`);
        return res.status(429).json({ status: "error", message: "Muitas requisições. IP bloqueado por 5 minutos." });
    }

    next();
}

function requireClientHeader(req, res, next) {
    const header = req.headers["x-bob-client"];
    if (!header || header !== CLIENT_HEADER) {
        const ip = getRealIP(req);
        console.warn(`[SECURITY] Header inválido de ${ip}: "${header}" em ${req.path}`);
        logSecurityAlert(`⚠️ Acesso sem header válido de \`${ip}\` em \`${req.path}\``);
        return res.status(403).json({ status: "error", message: "Acesso negado." });
    }
    next();
}

app.use(rateLimitMiddleware);

// ─── UTILS ────────────────────────────────────────────────────────────────────
const formatTime = (ms) => {
    if (ms === Infinity) return "Lifetime ♾️";
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
        deleteKey(keyName);
        return { ok: false, error: "Chave expirada" };
    }
    if (!data.hwid) { data.hwid = hwid; saveKey(keyName); }
    else if (data.hwid !== hwid) return { ok: false, error: "HWID invalido" };
    return { ok: true, data, keyName };
};

// ─── BOT NOTIFIER ─────────────────────────────────────────────────────────────
// ℹ️ O Bob Notifier ainda é necessário se você usa um canal do Discord para
//    receber alertas de brainrots via embed. Se os brainrots chegam SOMENTE
//    via POST /push-brainrot, pode remover o token DISCORD_TOKEN_NOTIFIER.
const clientNotifier = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildWebhooks
    ]
});

clientNotifier.on("ready", () => console.log(`[NOTIFIER] Online: ${clientNotifier.user.tag}`));

clientNotifier.on("messageCreate", async (message) => {
    if (message.author.bot && message.author.id === clientNotifier.user?.id) return;
    if (message.channel.id !== DISCORD_CHANNEL_ID) return;
    if (!message.embeds.length) return;

    const embed = message.embeds[0];
    let jobId = null, value = "0", players = "N/A";

    if (embed.fields) {
        for (const f of embed.fields) {
            const fn = f.name.toLowerCase();
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
        jobId: xorObfuscate(jobId), value, players
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

    // ── Helper: verifica senha ──────────────────────────────────────────────
    const wrongPass = (pass) => pass !== ADMIN_PASS;

    switch (cmd) {

        // ══════════════════════════════════════════════════════════════════
        // !online — atualiza sem limite de tempo (para com !stoponline)
        // ══════════════════════════════════════════════════════════════════
        case "online": {
            const buildOnlineEmbed = () => {
                const now = Date.now();
                for (const [sid, info] of Object.entries(presence)) {
                    if (now - info.lastSeen >= 30000) delete presence[sid];
                }
                const userMap = {};
                for (const [, info] of Object.entries(presence)) {
                    if (now - info.lastSeen >= 30000) continue;
                    const robloxName = info.name || "?";
                    if (userMap[robloxName]) continue;
                    const keyName = info.key ? findKey(info.key) : null;
                    const keyData = keyName ? keys[keyName] : null;
                    let timeLeft = "?", status = "✅";
                    if (keyData) {
                        if (keyData.paused) { timeLeft = formatTime(keyData.remaining); status = "⏸️"; }
                        else { timeLeft = keyData.expiry === Infinity ? "Lifetime ♾️" : formatTime(keyData.expiry - now); }
                    }
                    const discordId = keyData?.discordId || null;
                    const jobId = userJobIds[robloxName] || null;
                    userMap[robloxName] = { timeLeft, status, discordId, jobId };
                }
                const userList = Object.entries(userMap);
                const embed = new EmbedBuilder()
                    .setTitle("🟢 Usuários Online no Script")
                    .setColor(0x00C853)
                    .setFooter({ text: `Bob Joiner • ${userList.length} usuário(s) online • Atualiza a cada 5s • Digite !stoponline para parar` })
                    .setTimestamp();
                if (userList.length === 0) {
                    embed.setDescription("Nenhum usuário online no momento.");
                } else {
                    const lines = userList.map(([robloxName, data]) => {
                        const mention  = data.discordId ? `<@${data.discordId}>` : "*(sem Discord)*";
                        const jobPart  = data.jobId ? ` | 🎮 \`${data.jobId.substring(0,8)}...\`` : "";
                        return `${data.status} **${robloxName}** — ${mention} — ⏱️ \`${data.timeLeft}\`${jobPart}`;
                    });
                    embed.setDescription(lines.join("\n"));
                }
                return embed;
            };

            const sentMsg = await message.reply({ embeds: [buildOnlineEmbed()] });

            // Guarda o interval no mapa para poder parar depois
            if (!global.onlineIntervals) global.onlineIntervals = {};
            if (global.onlineIntervals[message.channel.id]) {
                clearInterval(global.onlineIntervals[message.channel.id]);
            }

            global.onlineIntervals[message.channel.id] = setInterval(async () => {
                await sentMsg.edit({ embeds: [buildOnlineEmbed()] }).catch(() => {
                    clearInterval(global.onlineIntervals[message.channel.id]);
                    delete global.onlineIntervals[message.channel.id];
                });
            }, 5000);
            break;
        }

        // ══════════════════════════════════════════════════════════════════
        // !stoponline — para atualização do !online neste canal
        // ══════════════════════════════════════════════════════════════════
        case "stoponline": {
            if (global.onlineIntervals && global.onlineIntervals[message.channel.id]) {
                clearInterval(global.onlineIntervals[message.channel.id]);
                delete global.onlineIntervals[message.channel.id];
                message.reply("⏹️ Atualização do !online parada.");
            } else {
                message.reply("Nenhuma atualização ativa neste canal.");
            }
            break;
        }

        // ══════════════════════════════════════════════════════════════════
        // !blocked — lista IPs bloqueados
        // ══════════════════════════════════════════════════════════════════
        case "blocked": {
            const now = Date.now();
            const active = Object.entries(blockedIPs).filter(([, until]) => now < until);
            if (!active.length) { message.reply("Nenhum IP bloqueado no momento."); break; }
            const lines = active.map(([ip, until]) => `• \`${ip}\` — ainda ${Math.ceil((until - now)/1000)}s bloqueado`);
            message.reply("🔒 **IPs Bloqueados:**\n" + lines.join("\n"));
            break;
        }

        // ══════════════════════════════════════════════════════════════════
        // !unblock <ip> <senha>
        // ══════════════════════════════════════════════════════════════════
        case "unblock": {
            const [ip, pass] = args;
            if (wrongPass(pass)) { message.reply("❌ Senha incorreta!"); break; }
            if (blockedIPs[ip]) { delete blockedIPs[ip]; message.reply(`✅ IP \`${ip}\` desbloqueado.`); }
            else message.reply("IP não estava bloqueado.");
            break;
        }

        // ══════════════════════════════════════════════════════════════════
        // !test — brainrot de teste
        // ══════════════════════════════════════════════════════════════════
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

        // ══════════════════════════════════════════════════════════════════
        // !info — lista todas as keys
        // ══════════════════════════════════════════════════════════════════
        case "info": {
            const ks = Object.keys(keys);
            if (!ks.length) { message.reply("Nenhuma chave ativa."); break; }
            const embed = new EmbedBuilder()
                .setTitle("🔑 Chaves Ativas")
                .setColor(0x5865F2)
                .setTimestamp();
            const lines = ks.map(k => {
                const d = keys[k];
                const t = d.paused ? d.remaining : (d.expiry === Infinity ? Infinity : d.expiry - Date.now());
                const discord = d.discordId ? `<@${d.discordId}>` : "*(sem Discord)*";
                const hwid    = d.hwid ? `HWID: ${d.hwid.substring(0,6)}...` : "Livre";
                return `• \`${k}\`: \`${formatTime(t)}\` ${d.paused ? "⏸️" : "✅"} ${discord} *(${hwid})*`;
            });
            embed.setDescription(lines.join("\n"));
            message.reply({ embeds: [embed] });
            break;
        }

        // ══════════════════════════════════════════════════════════════════
        // !create <h> <m> <nome> <senha>
        // ══════════════════════════════════════════════════════════════════
        case "create": {
            if (args.length < 4) { message.reply("Uso: `!create <h> <m> <nome> <senha>`"); break; }
            const [h, m, name, pass] = args;
            if (wrongPass(pass)) { message.reply("❌ Senha incorreta!"); break; }
            if (findKey(name)) { message.reply(`❌ Chave \`${name}\` já existe!`); break; }
            const dur = (parseInt(h) * 3600 + parseInt(m) * 60) * 1000;
            if (dur <= 0) { message.reply("❌ Duração inválida!"); break; }
            keys[name] = { expiry: Date.now() + dur, paused: false, remaining: dur, hwid: null, discordId: null };
            await saveKey(name);
            message.reply(`✅ Chave \`${name}\` criada! Duração: **${formatTime(dur)}**`);
            break;
        }

        // ══════════════════════════════════════════════════════════════════
        // !lifetime <nome> <senha>
        // ══════════════════════════════════════════════════════════════════
        case "lifetime": {
            const [name, pass] = args;
            if (wrongPass(pass)) { message.reply("❌ Senha incorreta!"); break; }
            keys[name] = { expiry: Infinity, paused: false, remaining: Infinity, hwid: null, discordId: null };
            await saveKey(name);
            message.reply(`✅ Chave \`${name}\` criada como **Lifetime ♾️**!`);
            break;
        }

        // ══════════════════════════════════════════════════════════════════
        // !reset <nome|all> <senha>  — reseta HWID
        // ══════════════════════════════════════════════════════════════════
        case "reset": {
            const [name, pass] = args;
            if (wrongPass(pass)) { message.reply("❌ Senha incorreta!"); break; }
            if (name.toLowerCase() === "all") {
                let count = 0;
                for (const k of Object.keys(keys)) {
                    keys[k].hwid = null;
                    kicked[k.toLowerCase()] = Date.now();
                    await saveKey(k);
                    count++;
                }
                message.reply(`✅ HWID de **${count} chaves** resetado!`);
            } else {
                const t = findKey(name);
                if (!t) { message.reply("❌ Chave não encontrada."); break; }
                keys[t].hwid = null;
                kicked[t.toLowerCase()] = Date.now();
                await saveKey(t);
                message.reply(`✅ HWID de \`${t}\` resetado!`);
            }
            break;
        }

        // ══════════════════════════════════════════════════════════════════
        // !pause <nome|all> <senha>  — pausa/retoma
        // ══════════════════════════════════════════════════════════════════
        case "pause": {
            const [name, pass] = args;
            if (wrongPass(pass)) { message.reply("❌ Senha incorreta!"); break; }
            if (name.toLowerCase() === "all") {
                let paused = 0, resumed = 0;
                for (const k of Object.keys(keys)) {
                    const d = keys[k];
                    if (d.paused) {
                        d.expiry = Date.now() + d.remaining; d.paused = false; resumed++;
                    } else {
                        d.remaining = d.expiry === Infinity ? Infinity : d.expiry - Date.now();
                        d.paused = true; paused++;
                    }
                    await saveKey(k);
                }
                message.reply(`⏸️ **${paused}** chaves pausadas, **${resumed}** retomadas.`);
            } else {
                const t = findKey(name);
                if (!t) { message.reply("❌ Chave não encontrada."); break; }
                const d = keys[t];
                if (d.paused) {
                    d.expiry = Date.now() + d.remaining; d.paused = false;
                    await saveKey(t);
                    message.reply(`▶️ \`${t}\` retomada! Tempo restante: **${formatTime(d.remaining)}**`);
                } else {
                    d.remaining = d.expiry === Infinity ? Infinity : d.expiry - Date.now();
                    d.paused = true;
                    await saveKey(t);
                    message.reply(`⏸️ \`${t}\` pausada! Tempo salvo: **${formatTime(d.remaining)}**`);
                }
            }
            break;
        }

        // ══════════════════════════════════════════════════════════════════
        // !revoke <nome|all> <senha>
        // ══════════════════════════════════════════════════════════════════
        case "revoke": {
            const [name, pass] = args;
            if (wrongPass(pass)) { message.reply("❌ Senha incorreta!"); break; }
            if (name.toLowerCase() === "all") {
                const count = Object.keys(keys).length;
                for (const k of Object.keys(keys)) {
                    delete keys[k];
                    await deleteKey(k);
                }
                message.reply(`🗑️ **${count} chaves** removidas.`);
            } else {
                const t = findKey(name);
                if (!t) { message.reply("❌ Chave não encontrada."); break; }
                delete keys[t];
                await deleteKey(t);
                message.reply(`🗑️ Chave \`${t}\` removida.`);
            }
            break;
        }

        // ══════════════════════════════════════════════════════════════════
        // !extend <nome> <h> <m> <senha>
        // ══════════════════════════════════════════════════════════════════
        case "extend": {
            if (args.length < 4) { message.reply("Uso: `!extend <nome> <h> <m> <senha>`"); break; }
            const [name, h, m, pass] = args;
            if (wrongPass(pass)) { message.reply("❌ Senha incorreta!"); break; }
            const t = findKey(name);
            if (!t) { message.reply("❌ Chave não encontrada."); break; }
            const extra = (parseInt(h) * 3600 + parseInt(m) * 60) * 1000;
            const d = keys[t];
            if (d.paused) d.remaining += extra;
            else if (d.expiry !== Infinity) d.expiry += extra;
            await saveKey(t);
            message.reply(`✅ \`${t}\` estendida em **${formatTime(extra)}**!`);
            break;
        }

        // ══════════════════════════════════════════════════════════════════
        // !addtime <nome|all> <h> <m> <senha>  — igual ao extend mas suporta "all"
        // ══════════════════════════════════════════════════════════════════
        case "addtime": {
            if (args.length < 4) { message.reply("Uso: `!addtime <nome|all> <h> <m> <senha>`"); break; }
            const [name, h, m, pass] = args;
            if (wrongPass(pass)) { message.reply("❌ Senha incorreta!"); break; }
            const extra = (parseInt(h) * 3600 + parseInt(m) * 60) * 1000;
            if (extra <= 0) { message.reply("❌ Tempo inválido!"); break; }
            if (name.toLowerCase() === "all") {
                let count = 0;
                for (const k of Object.keys(keys)) {
                    const d = keys[k];
                    if (d.paused) d.remaining += extra;
                    else if (d.expiry !== Infinity) d.expiry += extra;
                    await saveKey(k);
                    count++;
                }
                message.reply(`✅ **${formatTime(extra)}** adicionado a **${count} chaves**!`);
            } else {
                const t = findKey(name);
                if (!t) { message.reply("❌ Chave não encontrada."); break; }
                const d = keys[t];
                if (d.paused) d.remaining += extra;
                else if (d.expiry !== Infinity) d.expiry += extra;
                await saveKey(t);
                message.reply(`✅ **${formatTime(extra)}** adicionado a \`${t}\`!`);
            }
            break;
        }

        // ══════════════════════════════════════════════════════════════════
        // !setexpiry <nome> <h> <m> <senha>  — redefine o tempo da key
        // ══════════════════════════════════════════════════════════════════
        case "setexpiry": {
            if (args.length < 4) { message.reply("Uso: `!setexpiry <nome> <h> <m> <senha>`"); break; }
            const [name, h, m, pass] = args;
            if (wrongPass(pass)) { message.reply("❌ Senha incorreta!"); break; }
            const t = findKey(name);
            if (!t) { message.reply("❌ Chave não encontrada."); break; }
            const dur = (parseInt(h) * 3600 + parseInt(m) * 60) * 1000;
            if (dur <= 0) { message.reply("❌ Duração inválida!"); break; }
            const d = keys[t];
            if (d.paused) { d.remaining = dur; }
            else { d.expiry = Date.now() + dur; d.remaining = dur; }
            await saveKey(t);
            message.reply(`✅ Expiração de \`${t}\` redefinida para **${formatTime(dur)}**!`);
            break;
        }

        // ══════════════════════════════════════════════════════════════════
        // !sethwid <nome> <hwid> <senha>  — força um HWID manualmente
        // ══════════════════════════════════════════════════════════════════
        case "sethwid": {
            if (args.length < 3) { message.reply("Uso: `!sethwid <nome> <hwid> <senha>`"); break; }
            const [name, hwid, pass] = args;
            if (wrongPass(pass)) { message.reply("❌ Senha incorreta!"); break; }
            const t = findKey(name);
            if (!t) { message.reply("❌ Chave não encontrada."); break; }
            keys[t].hwid = hwid;
            await saveKey(t);
            message.reply(`✅ HWID de \`${t}\` definido para \`${hwid}\`!`);
            break;
        }

        // ══════════════════════════════════════════════════════════════════
        // !transfer <nomeAntigo> <nomeNovo> <senha>  — renomeia uma key
        // ══════════════════════════════════════════════════════════════════
        case "transfer": {
            if (args.length < 3) { message.reply("Uso: `!transfer <nomeAntigo> <nomeNovo> <senha>`"); break; }
            const [oldName, newName, pass] = args;
            if (wrongPass(pass)) { message.reply("❌ Senha incorreta!"); break; }
            const t = findKey(oldName);
            if (!t) { message.reply("❌ Chave não encontrada."); break; }
            if (findKey(newName)) { message.reply(`❌ Chave \`${newName}\` já existe!`); break; }
            keys[newName] = { ...keys[t] };
            delete keys[t];
            await deleteKey(t);
            await saveKey(newName);
            message.reply(`✅ Chave transferida de \`${t}\` para \`${newName}\`!`);
            break;
        }

        // ══════════════════════════════════════════════════════════════════
        // !lookup <nome>  — info detalhada de uma key (sem precisar de senha)
        // ══════════════════════════════════════════════════════════════════
        case "lookup": {
            const [name] = args;
            if (!name) { message.reply("Uso: `!lookup <nome>`"); break; }
            const t = findKey(name);
            if (!t) { message.reply("❌ Chave não encontrada."); break; }
            const d = keys[t];
            const timeLeft = d.expiry === Infinity ? "Lifetime ♾️" : formatTime(d.expiry - Date.now());
            const status   = d.paused ? "⏸️ Pausada" : "✅ Ativa";
            const hwid     = d.hwid ? `\`${d.hwid.substring(0,12)}...\`` : "Nenhum (Livre)";
            const discord  = d.discordId ? `<@${d.discordId}>` : "*(não vinculado)*";
            const jobId    = d.discordId ? (userJobIds[d.discordId] || "Nenhum") : "Nenhum";
            const embed = new EmbedBuilder()
                .setTitle(`🔍 Info: ${t}`)
                .setColor(d.paused ? 0xFFA000 : 0x00C853)
                .addFields(
                    { name: "⏱️ Tempo Restante", value: timeLeft,  inline: true  },
                    { name: "📌 Status",          value: status,    inline: true  },
                    { name: "💻 HWID",            value: hwid,      inline: false },
                    { name: "👤 Discord",          value: discord,   inline: true  },
                    { name: "🎮 JobID",            value: String(jobId), inline: true }
                )
                .setTimestamp();
            message.reply({ embeds: [embed] });
            break;
        }

        // ══════════════════════════════════════════════════════════════════
        // !stats  — estatísticas gerais
        // ══════════════════════════════════════════════════════════════════
        case "stats": {
            const all    = Object.values(keys);
            const active = all.filter(k => !k.paused && (k.expiry === Infinity || k.expiry - Date.now() > 0));
            const paused = all.filter(k => k.paused);
            const lt     = all.filter(k => k.expiry === Infinity);
            const online = Object.values(presence).filter(p => Date.now() - p.lastSeen < 30000);
            const embed = new EmbedBuilder()
                .setTitle("📊 Estatísticas Bob Joiner")
                .setColor(0x5865F2)
                .addFields(
                    { name: "🔑 Total de Keys",   value: String(all.length),    inline: true },
                    { name: "✅ Ativas",           value: String(active.length), inline: true },
                    { name: "⏸️ Pausadas",         value: String(paused.length), inline: true },
                    { name: "♾️ Lifetime",         value: String(lt.length),     inline: true },
                    { name: "🟢 Online agora",     value: String(online.length), inline: true },
                    { name: "📡 Brainrots (fila)", value: String(brainrots.length), inline: true }
                )
                .setTimestamp();
            message.reply({ embeds: [embed] });
            break;
        }

        // ══════════════════════════════════════════════════════════════════
        // !kick <nome|all> <senha>  — força desconexão (via HWID reset + kicked flag)
        // ══════════════════════════════════════════════════════════════════
        case "kick": {
            const [name, pass] = args;
            if (wrongPass(pass)) { message.reply("❌ Senha incorreta!"); break; }
            if (name.toLowerCase() === "all") {
                let count = 0;
                for (const k of Object.keys(keys)) {
                    kicked[k.toLowerCase()] = Date.now();
                    count++;
                }
                message.reply(`👢 **${count} usuários** marcados para kick!`);
            } else {
                const t = findKey(name);
                if (!t) { message.reply("❌ Chave não encontrada."); break; }
                kicked[t.toLowerCase()] = Date.now();
                message.reply(`👢 \`${t}\` será kickado na próxima checagem.`);
            }
            break;
        }

        // ══════════════════════════════════════════════════════════════════
        // !cleanlogs  — limpa fila de brainrots
        // ══════════════════════════════════════════════════════════════════
        case "cleanlogs": {
            const [pass] = args;
            if (wrongPass(pass)) { message.reply("❌ Senha incorreta!"); break; }
            const count = brainrots.length;
            brainrots.length = 0;
            message.reply(`🧹 **${count}** brainrots removidos da fila.`);
            break;
        }

        // ══════════════════════════════════════════════════════════════════
        // !jobids  — mostra jobids recentes de usuários online
        // ══════════════════════════════════════════════════════════════════
        case "jobids": {
            const entries = Object.entries(userJobIds);
            if (!entries.length) { message.reply("Nenhum JobID registrado."); break; }
            const lines = entries.map(([name, jobId]) => `• **${name}**: \`${jobId}\``);
            message.reply("🎮 **JobIDs conhecidos:**\n" + lines.join("\n"));
            break;
        }

        // ══════════════════════════════════════════════════════════════════
        // !help — lista de comandos
        // ══════════════════════════════════════════════════════════════════
        case "help": {
            const embed = new EmbedBuilder()
                .setTitle("📋 Comandos Bob Logs")
                .setColor(0x5865F2)
                .addFields(
                    {
                        name: "🔑 Gerenciar Keys",
                        value:
                            "`!create <h> <m> <nome> <senha>` — Cria chave\n" +
                            "`!lifetime <nome> <senha>` — Cria chave lifetime\n" +
                            "`!revoke <nome|all> <senha>` — Remove chave(s)\n" +
                            "`!reset <nome|all> <senha>` — Reseta HWID\n" +
                            "`!pause <nome|all> <senha>` — Pausa/retoma\n" +
                            "`!extend <nome> <h> <m> <senha>` — Adiciona tempo\n" +
                            "`!addtime <nome|all> <h> <m> <senha>` — Adiciona tempo (suporta all)\n" +
                            "`!setexpiry <nome> <h> <m> <senha>` — Redefine tempo\n" +
                            "`!sethwid <nome> <hwid> <senha>` — Define HWID\n" +
                            "`!transfer <old> <new> <senha>` — Renomeia key\n" +
                            "`!kick <nome|all> <senha>` — Força desconexão",
                        inline: false
                    },
                    {
                        name: "📊 Informações",
                        value:
                            "`!info` — Lista todas as chaves\n" +
                            "`!lookup <nome>` — Info detalhada de uma key\n" +
                            "`!online` — Usuários online (tempo real, sem limite)\n" +
                            "`!stoponline` — Para atualização do !online\n" +
                            "`!stats` — Estatísticas gerais\n" +
                            "`!jobids` — JobIDs dos usuários online\n" +
                            "`!blocked` — IPs bloqueados",
                        inline: false
                    },
                    {
                        name: "🛠️ Administração",
                        value:
                            "`!unblock <ip> <senha>` — Desbloqueia IP\n" +
                            "`!cleanlogs <senha>` — Limpa fila de brainrots\n" +
                            "`!test` — Brainrot de teste",
                        inline: false
                    }
                )
                .setFooter({ text: "Suporte: all = afeta todas as keys" })
                .setTimestamp();
            message.reply({ embeds: [embed] });
            break;
        }
    }
});

// ─── BOT PAINEL ───────────────────────────────────────────────────────────────
const clientPanel = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages
    ],
    partials: [Partials.Channel, Partials.Message]
});

const awaitingInput = {};

function buildPanelEmbed() {
    return new EmbedBuilder()
        .setTitle("Bob Auto Joiner")
        .setColor(0x5865F2)
        .setDescription(
            "This control panel is for the project: **Bob Joiner**\n\n" +
            "If you're a buyer, click on the buttons below to redeem your key, get the script or get your role"
        )
        .addFields(
            { name: "🔑 Redeem Key", value: "Place to validate your Key", inline: false },
            { name: "📋 View Script", value: "Shows the **Bob Joiner** Script (Key Required)", inline: false },
            { name: "📊 Key Info", value: "Shows your Key Status (Key Required)", inline: false },
            { name: "⚙️ Reset HWID", value: "Reset the Hardware Identification of your Key (Key Required)", inline: false }
        );
}

function buildPanelRows() {
    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("panel_redeem").setLabel("Redeem Key").setEmoji("🔑").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("panel_script").setLabel("Get Script").setEmoji("📋").setStyle(ButtonStyle.Primary),
    );
    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("panel_role").setLabel("Get Role").setEmoji("👤").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("panel_hwid").setLabel("Reset HWID").setEmoji("⚙️").setStyle(ButtonStyle.Secondary),
    );
    const row3 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("panel_stats").setLabel("Get Stats").setEmoji("📊").setStyle(ButtonStyle.Secondary),
    );
    return [row1, row2, row3];
}

clientPanel.on("ready", async () => {
    console.log(`[PANEL] Online: ${clientPanel.user.tag}`);
    if (PANEL_CHANNEL_ID) {
        try {
            const ch = await clientPanel.channels.fetch(PANEL_CHANNEL_ID);
            if (ch) {
                const msgs = await ch.messages.fetch({ limit: 10 });
                for (const [, msg] of msgs) {
                    if (msg.author.id === clientPanel.user.id) await msg.delete().catch(() => {});
                }
                await ch.send({ embeds: [buildPanelEmbed()], components: buildPanelRows() });
                console.log("[PANEL] Painel enviado!");
            }
        } catch (e) {
            console.error("[PANEL] Erro ao enviar painel:", e.message);
        }
    }
});

clientPanel.on("messageCreate", async (message) => {
    if (message.author.bot) return;

    if (message.channel.type === ChannelType.DM) {
        const state = awaitingInput[message.author.id];
        if (!state) return;

        if (state.step === "redeem_key") {
            const key = message.content.trim();
            const keyName = findKey(key);
            if (!keyName) return message.reply("❌ Key não encontrada!");
            const d = keys[keyName];
            if (d.paused) return message.reply("⏸️ Sua key está pausada.");
            if (d.expiry !== Infinity && d.expiry - Date.now() <= 0) return message.reply("⌛ Sua key expirou!");
            delete awaitingInput[message.author.id];
            const timeLeft = d.expiry === Infinity ? "Lifetime ♾️" : formatTime(d.expiry - Date.now());
            return message.reply(`✅ Key válida! Tempo restante: **${timeLeft}**`);
        }

        if (state.step === "script_key") {
            const key = message.content.trim();
            const keyName = findKey(key);
            if (!keyName) return message.reply("❌ Key não encontrada!");
            const d = keys[keyName];
            if (d.paused) return message.reply("⏸️ Sua key está pausada.");
            if (d.expiry !== Infinity && d.expiry - Date.now() <= 0) return message.reply("⌛ Sua key expirou!");
            delete awaitingInput[message.author.id];
            return message.reply(
                "📋 **Bob Joiner Script**\n\n" +
                (SCRIPT_URL
                    ? `Execute no seu executor:\n\`\`\`\nloadstring(game:HttpGet('${SCRIPT_URL}'))()\n\`\`\``
                    : "❌ Script URL não configurada. Contate o administrador.")
            );
        }

        if (state.step === "role_key") {
            const key = message.content.trim();
            const keyName = findKey(key);
            if (!keyName) return message.reply("❌ Key não encontrada!");
            const d = keys[keyName];
            if (d.paused) return message.reply("⏸️ Sua key está pausada.");
            if (d.expiry !== Infinity && d.expiry - Date.now() <= 0) return message.reply("⌛ Sua key expirou!");
            if (d.discordId && d.discordId !== message.author.id)
                return message.reply("❌ Essa key já está vinculada a outro Discord!");
            d.discordId = message.author.id;
            await saveKey(keyName);
            delete awaitingInput[message.author.id];
            const ROLE_ID = process.env.BUYER_ROLE_ID;
            if (ROLE_ID && state.guildId) {
                try {
                    const guild = await clientPanel.guilds.fetch(state.guildId);
                    const member = await guild.members.fetch(message.author.id);
                    await member.roles.add(ROLE_ID);
                    return message.reply(`✅ Discord vinculado à key \`${keyName}\` e cargo adicionado!`);
                } catch (e) {
                    console.error("[PANEL] Erro ao dar cargo:", e.message);
                    return message.reply(`✅ Discord vinculado à key \`${keyName}\`! (Cargo não adicionado automaticamente)`);
                }
            }
            return message.reply(`✅ Discord vinculado à key \`${keyName}\` com sucesso!`);
        }

        if (state.step === "hwid_key") {
            const key = message.content.trim();
            const keyName = findKey(key);
            if (!keyName) return message.reply("❌ Key não encontrada!");
            keys[keyName].hwid = null;
            kicked[keyName.toLowerCase()] = Date.now();
            await saveKey(keyName);
            delete awaitingInput[message.author.id];
            return message.reply("✅ HWID resetado! Já pode logar em outro dispositivo.");
        }

        if (state.step === "stats_key") {
            const key = message.content.trim();
            const keyName = findKey(key);
            if (!keyName) return message.reply("❌ Key não encontrada!");
            const d = keys[keyName];
            const timeLeft = d.expiry === Infinity ? "Lifetime ♾️" : formatTime(d.expiry - Date.now());
            const status   = d.paused ? "⏸️ Pausada" : "✅ Ativa";
            const hwid     = d.hwid ? `\`${d.hwid.substring(0,8)}...\`` : "Nenhum (Livre)";
            const discord  = d.discordId ? `<@${d.discordId}>` : "*(não vinculado)*";
            delete awaitingInput[message.author.id];
            const embed = new EmbedBuilder()
                .setTitle("📊 Key Info")
                .setColor(0x5865F2)
                .addFields(
                    { name: "🔑 Key",            value: `\`${keyName}\``, inline: true  },
                    { name: "⏱️ Tempo Restante", value: timeLeft,         inline: true  },
                    { name: "📌 Status",          value: status,           inline: true  },
                    { name: "💻 HWID",            value: hwid,             inline: false },
                    { name: "👤 Discord",          value: discord,          inline: false }
                );
            return message.reply({ embeds: [embed] });
        }
    }

    if (message.content === "!panel") {
        try {
            await message.channel.send({ embeds: [buildPanelEmbed()], components: buildPanelRows() });
            message.reply("✅ Painel enviado!");
        } catch (e) {
            message.reply("❌ Erro: " + e.message);
        }
    }
});

clientPanel.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;
    const user = interaction.user;
    await interaction.deferReply({ flags: 64 });

    switch (interaction.customId) {
        case "panel_redeem": {
            awaitingInput[user.id] = { step: "redeem_key" };
            try {
                await user.send("🔑 **Redeem Key**\nEnvie sua key aqui para validar:");
                await interaction.editReply({ content: "📩 Te mandei uma DM!" });
            } catch {
                await interaction.editReply({ content: "❌ Habilite mensagens privadas do servidor!" });
            }
            break;
        }
        case "panel_script": {
            awaitingInput[user.id] = { step: "script_key" };
            try {
                await user.send("📋 **Get Script**\nEnvie sua key para receber o script:");
                await interaction.editReply({ content: "📩 Te mandei uma DM!" });
            } catch {
                await interaction.editReply({ content: "❌ Habilite mensagens privadas do servidor!" });
            }
            break;
        }
        case "panel_role": {
            awaitingInput[user.id] = { step: "role_key", guildId: interaction.guildId };
            try {
                await user.send("👤 **Get Role**\nEnvie sua key para vincular seu Discord e receber o cargo:");
                await interaction.editReply({ content: "📩 Te mandei uma DM!" });
            } catch {
                await interaction.editReply({ content: "❌ Habilite mensagens privadas do servidor!" });
            }
            break;
        }
        case "panel_hwid": {
            awaitingInput[user.id] = { step: "hwid_key" };
            try {
                await user.send("⚙️ **Reset HWID**\nEnvie sua key:");
                await interaction.editReply({ content: "📩 Te mandei uma DM!" });
            } catch {
                await interaction.editReply({ content: "❌ Habilite mensagens privadas do servidor!" });
            }
            break;
        }
        case "panel_stats": {
            awaitingInput[user.id] = { step: "stats_key" };
            try {
                await user.send("📊 **Key Info**\nEnvie sua key:");
                await interaction.editReply({ content: "📩 Te mandei uma DM!" });
            } catch {
                await interaction.editReply({ content: "❌ Habilite mensagens privadas do servidor!" });
            }
            break;
        }
    }
});

// ─── ENDPOINTS ────────────────────────────────────────────────────────────────

app.get("/health", (req, res) => res.json({ status: "ok", time: Date.now() }));
app.get("/",       (req, res) => res.send("<h1>Bob API v10 — Online ✅</h1>"));

app.get("/validate", requireClientHeader, (req, res) => {
    const { key, secret, hwid } = req.query;
    const r = checkKey(key, secret, hwid);
    if (!r.ok) return res.status(403).send("Erro: " + r.error);
    const timeLeft = r.data.expiry === Infinity ? Infinity : r.data.expiry - Date.now();
    res.json({ status: "success", time_left: timeLeft });
});

app.get("/get-brainrots", requireClientHeader, (req, res) => {
    const { key, secret, hwid, lastId } = req.query;
    const r = checkKey(key, secret, hwid);
    if (!r.ok) return res.status(403).json({ status: "error", message: r.error });
    if (!brainrots.length) return res.json({ status: "waiting" });
    const latest = brainrots[brainrots.length - 1];
    if (latest.id === lastId) return res.json({ status: "waiting" });
    res.json({ status: "success", brainrot: latest });
});

app.get("/logs", requireClientHeader, (req, res) => {
    const { key, secret, hwid } = req.query;
    const r = checkKey(key, secret, hwid);
    if (!r.ok) return res.status(403).json({ status: "error", message: r.error });
    res.json(brainrots);
});

app.get("/api/latest", requireClientHeader, (req, res) => {
    const { key, secret, hwid } = req.query;
    const r = checkKey(key, secret, hwid);
    if (!r.ok) return res.status(403).json({ status: "error", message: r.error });
    if (!brainrots.length) return res.json({ status: "waiting" });
    res.json(brainrots[brainrots.length - 1]);
});

app.get("/kicked", requireClientHeader, (req, res) => {
    const { key, secret } = req.query;
    if (secret !== SCRIPT_SECRET) return res.json({ kicked: false });
    const keyName = findKey(key);
    if (!keyName) return res.json({ kicked: false });
    const ts = kicked[keyName.toLowerCase()];
    if (ts) { delete kicked[keyName.toLowerCase()]; return res.json({ kicked: true }); }
    res.json({ kicked: false });
});

app.post("/presence", requireClientHeader, async (req, res) => {
    const { key, secret, hwid, sessionId, name, jobId, discordId } = req.query;
    const r = checkKey(key, secret, hwid);
    if (!r.ok) return res.status(403).json({ status: "error", message: r.error });

    presence[sessionId] = { name: name || "Unknown", lastSeen: Date.now(), key: key || "" };

    // Salva jobId automaticamente
    if (jobId && name) userJobIds[name] = jobId;

    // ─── Vincula Discord ID automaticamente pela tela de login do script ──────
    if (discordId && r.keyName) {
        const d = keys[r.keyName];
        const cleanId = String(discordId).replace(/\D/g, ""); // só números
        if (cleanId.length >= 17 && cleanId.length <= 20) {   // Discord IDs têm 17-20 dígitos
            if (!d.discordId) {
                // Primeira vez — vincula direto
                d.discordId = cleanId;
                await saveKey(r.keyName);
                console.log(`[PRESENCE] Discord ${cleanId} vinculado à key ${r.keyName} via login`);
            } else if (d.discordId !== cleanId) {
                // Já vinculado a outro — rejeita silenciosamente (não impede o script)
                console.warn(`[PRESENCE] Key ${r.keyName} já vinculada ao Discord ${d.discordId}, ignorando ${cleanId}`);
            }
        }
    }

    res.json({ status: "ok" });
});

app.get("/presence", requireClientHeader, (req, res) => {
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

// ─── /push-brainrot ───────────────────────────────────────────────────────────
app.post("/push-brainrot", requireClientHeader, (req, res) => {
    const { secret, title, description, jobId, value, players } = req.body;

    if (secret !== SCRIPT_SECRET)
        return res.status(403).json({ status: "error", message: "Secret inválido" });

    const payload = {
        id:          Date.now().toString(),
        title:       title       || "Brainrot",
        description: description || "",
        brainrot:    title       || "Brainrot",
        name:        title       || "Brainrot",
        jobId:       xorObfuscate(jobId) || null,
        value:       value       || "0",
        players:     players     || "N/A"
    };

    brainrots.push(payload);
    if (brainrots.length > 100) brainrots.shift();
    io.emit("brainrot", payload);

    console.log(`[PUSH] ✅ ${payload.title} | jobId: ${payload.jobId} | Value: ${payload.value}`);
    res.json({ status: "ok", id: payload.id });
});

// ─── /link-discord — vincula Discord ID via tela de login do Lua ─────────────
app.post("/link-discord", requireClientHeader, async (req, res) => {
    const { key, secret, hwid, discordId } = req.query;
    const r = checkKey(key, secret, hwid);
    if (!r.ok) return res.status(403).json({ status: "error", message: r.error });
    const cleanId = String(discordId || "").replace(/\D/g, "");
    if (cleanId.length < 17 || cleanId.length > 20)
        return res.status(400).json({ status: "error", message: "Discord ID invalido." });
    const d = keys[r.keyName];
    if (d.discordId && d.discordId !== cleanId)
        return res.status(409).json({ status: "error", message: "Key ja vinculada a outro Discord ID." });
    d.discordId = cleanId;
    await saveKey(r.keyName);
    console.log("[LINK] Discord " + cleanId + " vinculado a key " + r.keyName);
    res.json({ status: "ok", message: "Discord vinculado!" });
});

// ─── /report-jobid — o script Lua manda o jobId do usuário automaticamente ───
// Chame assim no Lua:
//   game:HttpPost(API_URL .. "/report-jobid?key=SUAKEY&secret=SECRET&name=" .. game.Players.LocalPlayer.Name .. "&jobId=" .. game.JobId, "", "application/json", {["x-bob-client"] = CLIENT_HEADER})
app.post("/report-jobid", requireClientHeader, (req, res) => {
    const { key, secret, name, jobId } = req.query;
    if (secret !== SCRIPT_SECRET) return res.status(403).json({ status: "error", message: "Secret inválido" });
    const keyName = findKey(key);
    if (!keyName) return res.status(403).json({ status: "error", message: "Key inválida" });
    if (name && jobId) userJobIds[name] = jobId;
    res.json({ status: "ok" });
});

// ─── LOGIN ────────────────────────────────────────────────────────────────────
if (DISCORD_TOKEN_NOTIFIER) {
    clientNotifier.login(DISCORD_TOKEN_NOTIFIER)
        .then(() => console.log("[NOTIFIER] Login OK"))
        .catch(e => console.error("[NOTIFIER] Erro login:", e.message));
} else console.warn("[NOTIFIER] Token ausente — Bob Notifier desativado.");

if (DISCORD_TOKEN_LOGS) {
    clientLogs.login(DISCORD_TOKEN_LOGS)
        .then(() => console.log("[LOGS] Login OK"))
        .catch(e => console.error("[LOGS] Erro login:", e.message));
} else console.warn("[LOGS] Token ausente.");

if (DISCORD_TOKEN_PANEL) {
    clientPanel.login(DISCORD_TOKEN_PANEL)
        .then(() => console.log("[PANEL] Login OK"))
        .catch(e => console.error("[PANEL] Erro login:", e.message));
} else console.warn("[PANEL] Token ausente.");

if (MONGODB_URI) loadKeys();

server.listen(port, () => console.log(`[SERVER] Porta ${port}`));