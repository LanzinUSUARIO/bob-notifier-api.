const express  = require("express");
const http     = require("http");
const crypto   = require("crypto");
const { Server } = require("socket.io");
const {
    Client, GatewayIntentBits,
    ActionRowBuilder, ButtonBuilder, ButtonStyle,
    EmbedBuilder, Events, ChannelType, Partials,
    ModalBuilder, TextInputBuilder, TextInputStyle,
} = require("discord.js");
const mongoose = require("mongoose");

// ─── CONSTANTES ───────────────────────────────────────────────────────────────
const LIFETIME_VALUE    = 9_999_999_999_999;
const BRAINROT_MAX      = 100;
const JOBID_MAX         = 500;
const PRESENCE_TTL      = 2  * 60 * 1_000;
const ONLINE_STALE_MS   = 30 * 1_000;
const RATE_LIMIT_MAX    = 60;
const RATE_LIMIT_WINDOW = 60_000;
const BLOCK_DURATION    = 5  * 60 * 1_000;

// ✅ NOVO: Tempo de expiração de pedidos pendentes (15 minutos)
const PENDING_EXPIRY_MS  = 15 * 60 * 1_000;  // 15 min
const PENDING_WARN_MS    = 15 * 60 * 1_000;  // Avisa 15 min antes (= na criação, para pedidos novos o aviso é imediato já que o tempo é 15min)
// Na prática: pedido criado → aviso de 0min → expira em 15min

const BLOCKED_UA = [
    "python-requests","python-httpx","curl","wget","httpie",
    "insomnia","postman","go-http-client","java/","axios",
    "okhttp","libwww-perl","scrapy","aiohttp",
];

// ─── ENV ──────────────────────────────────────────────────────────────────────
function requireEnv(name) {
    const val = process.env[name];
    if (!val) { console.error(`[FATAL] Variável obrigatória não definida: ${name}`); process.exit(1); }
    return val;
}

const ADMIN_PASS    = requireEnv("ADMIN_PASS");
const SCRIPT_SECRET = requireEnv("SCRIPT_SECRET");
const XOR_KEY       = requireEnv("XOR_KEY");
const MONGODB_URI   = requireEnv("MONGODB_URI");

const CLIENT_HEADER          = process.env.CLIENT_HEADER           || "BobJoiner-v2";
const PIX_KEY                = process.env.PIX_KEY                 || "";
const PIX_NAME               = process.env.PIX_NAME                || "";
const BUY_CHANNEL            = process.env.BUY_CHANNEL             || "";
const DISCORD_TOKEN_NOTIFIER = process.env.DISCORD_TOKEN_NOTIFIER  || "";
const DISCORD_TOKEN_LOGS     = process.env.DISCORD_TOKEN_LOGS      || "";
const DISCORD_TOKEN_PANEL    = process.env.DISCORD_TOKEN_PANEL     || "";
const DISCORD_TOKEN_PAYMENT  = process.env.DISCORD_TOKEN_PAYMENT   || "";
const DISCORD_CHANNEL_ID     = process.env.DISCORD_CHANNEL_ID      || "";
const PANEL_CHANNEL_ID       = process.env.PANEL_CHANNEL_ID        || "";
const LOGS_CHANNEL_ID        = process.env.LOGS_CHANNEL_ID         || "";
const BOB_LOGS_PANEL_CHANNEL = process.env.BOB_LOGS_PANEL_CHANNEL  || "";
const SCRIPT_URL             = process.env.SCRIPT_URL              || "";
const ADMIN_IDS              = (process.env.ADMIN_IDS || "").split(",").filter(Boolean);
const ADMIN_ROLE_IDS         = [
    "1477885793144930496",
    "1501356382677373101",
    "1477885797553148066",
];

const PLANS = [
    { label: "1 Hora",  value: "1h", price: 5,  hours: 1, emoji: "🕐" },
    { label: "2 Horas", value: "2h", price: 10, hours: 2, emoji: "⏱️" },
    { label: "4 Horas", value: "4h", price: 20, hours: 4, emoji: "⚡" },
];

// ─── MONGODB ──────────────────────────────────────────────────────────────────
mongoose.connect(MONGODB_URI)
    .then(() => console.log("[DB] MongoDB conectado!"))
    .catch(e => { console.error("[DB] Erro fatal:", e.message); process.exit(1); });

const KeySchema = new mongoose.Schema({
    name:      { type: String, required: true, unique: true },
    expiry:    { type: Number, default: LIFETIME_VALUE },
    paused:    { type: Boolean, default: false },
    remaining: { type: Number, default: 0 },
    hwid:      { type: String, default: null },
    discordId: { type: String, default: null },
});
const KeyModel = mongoose.model("Key", KeySchema);

const PendingPaymentSchema = new mongoose.Schema({
    discordId:   String,
    discordTag:  String,
    hours:       Number,
    price:       Number,
    label:       String,
    warningSent: { type: Boolean, default: false },   // ✅ NOVO: controle de aviso enviado
    createdAt:   { type: Date, default: Date.now },
});
const PendingPayment = mongoose.model("PendingPayment", PendingPaymentSchema);

// ✅ NOVO: Schema de histórico de vendas
const SaleHistorySchema = new mongoose.Schema({
    discordId:   String,
    discordTag:  String,
    hours:       Number,
    price:       Number,
    label:       String,
    keyName:     String,
    confirmedBy: { type: String, default: "auto" }, // "auto" ou ID do admin
    confirmedAt: { type: Date, default: Date.now },
});
const SaleHistory = mongoose.model("SaleHistory", SaleHistorySchema);

// ─── ESTADO ───────────────────────────────────────────────────────────────────
const keys       = {};
const brainrots  = [];
const presence   = {};
const kicked     = {};
const userJobIds = {};

// ─── UTILS ────────────────────────────────────────────────────────────────────
function xorObfuscate(value) {
    if (!value) return value;
    const str = String(value);
    let result = "";
    for (let i = 0; i < str.length; i++)
        result += String.fromCharCode(str.charCodeAt(i) ^ XOR_KEY.charCodeAt(i % XOR_KEY.length));
    return Buffer.from(result, "binary").toString("base64");
}

function safeCompare(a, b) {
    try {
        const ba = Buffer.from(String(a));
        const bb = Buffer.from(String(b));
        if (ba.length !== bb.length) return false;
        return crypto.timingSafeEqual(ba, bb);
    } catch { return false; }
}

const wrongPass = (pass) => !safeCompare(pass, ADMIN_PASS);

const formatTime = (ms) => {
    if (ms === Infinity) return "Lifetime ♾️";
    if (ms <= 0) return "Expirado";
    let t = Math.floor(ms / 1000);
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const parts = [];
    if (h > 0) parts.push(h + "h");
    parts.push(m + "m");
    return parts.join(" ");
};

// ✅ NOVO: Formata tempo restante de forma amigável
const formatTimeShort = (ms) => {
    if (ms <= 0) return "expirado";
    const m = Math.floor(ms / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
};

const findKey    = (name) => Object.keys(keys).find(k => k.toLowerCase() === (name || "").trim().toLowerCase());
const tsRelative = (date) => `<t:${Math.floor(new Date(date).getTime() / 1000)}:R>`;
const tsAbsolute = (date) => `<t:${Math.floor(new Date(date).getTime() / 1000)}:f>`;

function generateBobKey() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let r = "BOB-";
    for (let i = 0; i < 8; i++) r += chars[Math.floor(Math.random() * chars.length)];
    return r;
}

function pushBrainrot(payload) {
    brainrots.push(payload);
    if (brainrots.length > BRAINROT_MAX) brainrots.shift();
    io.emit("brainrot", payload);
}

async function fetchUserFromAnyClient(userId) {
    for (const client of [clientLogs, clientPayment, clientPanel, clientNotifier]) {
        try {
            const user = await client.users.fetch(userId);
            if (user) return user;
        } catch {}
    }
    return null;
}

// ─── DB HELPERS ───────────────────────────────────────────────────────────────
async function loadKeys() {
    try {
        const docs = await KeyModel.find({});
        let expired = 0;
        for (const d of docs) {
            const expiry    = d.expiry    >= LIFETIME_VALUE ? Infinity : d.expiry;
            const remaining = d.remaining >= LIFETIME_VALUE ? Infinity : d.remaining;
            if (expiry !== Infinity && expiry - Date.now() <= 0) {
                await KeyModel.deleteOne({ name: d.name }); expired++; continue;
            }
            keys[d.name] = { expiry, paused: d.paused, remaining, hwid: d.hwid || null, discordId: d.discordId || null };
        }
        console.log(`[DB] ${Object.keys(keys).length} keys carregadas. ${expired} expiradas removidas.`);
    } catch (e) { console.error("[DB] Erro ao carregar keys:", e.message); }
}

async function saveKey(name) {
    try {
        const raw = { ...keys[name] };
        if (raw.expiry    === Infinity) raw.expiry    = LIFETIME_VALUE;
        if (raw.remaining === Infinity) raw.remaining = LIFETIME_VALUE;
        await KeyModel.findOneAndUpdate({ name }, { name, ...raw }, { upsert: true, new: true });
    } catch (e) { console.error("[DB] Erro ao salvar key:", e.message); }
}

async function deleteKey(name) {
    try { await KeyModel.deleteOne({ name }); }
    catch (e) { console.error("[DB] Erro ao deletar key:", e.message); }
}

// ─── CLEANUP PERIÓDICO ────────────────────────────────────────────────────────
setInterval(async () => {
    const now = Date.now();

    // Keys expiradas
    for (const [name, data] of Object.entries(keys)) {
        if (data.expiry !== Infinity && !data.paused && data.expiry - now <= 0) {
            delete keys[name];
            await deleteKey(name);
            console.log(`[CLEANUP] Key expirada removida: ${name}`);
        }
    }

    // Presence antiga
    for (const [sid, info] of Object.entries(presence)) {
        if (now - info.lastSeen > PRESENCE_TTL) delete presence[sid];
    }

    // JobIDs
    const jobKeys = Object.keys(userJobIds);
    if (jobKeys.length > JOBID_MAX)
        jobKeys.slice(0, jobKeys.length - JOBID_MAX).forEach(k => delete userJobIds[k]);

}, 60_000);

// ✅ NOVO: Cleanup de pedidos pendentes expirados (roda a cada 60s)
setInterval(async () => {
    const now     = Date.now();
    const cutoff  = new Date(now - PENDING_EXPIRY_MS);
    const warnAt  = new Date(now - (PENDING_EXPIRY_MS - 60_000)); // avisa quando falta ~1min (aqui: imediatamente pois 15min = tempo total)

    try {
        // Pedidos que já passaram do tempo limite → remover e notificar
        const expired = await PendingPayment.find({ createdAt: { $lt: cutoff } });
        for (const p of expired) {
            console.log(`[PENDING CLEANUP] Pedido expirado de ${p.discordTag} (${p.discordId}) — ${p.label}`);

            // Notifica o usuário que o pedido foi cancelado
            try {
                const user = await fetchUserFromAnyClient(p.discordId);
                if (user) {
                    await user.send({ embeds: [
                        new EmbedBuilder()
                            .setColor(0xFF3C3C)
                            .setTitle("❌ Pedido Cancelado por Inatividade")
                            .setDescription(
                                `Seu pedido de **${p.label}** (R$${p.price}) foi cancelado por falta de pagamento.\n\n` +
                                `⏱️ Tempo limite: **15 minutos**\n\n` +
                                `Se deseja comprar, acesse a loja novamente e efetue o pagamento em até **15 minutos** após escolher o plano.`
                            )
                            .setFooter({ text: "Bob Keys • Pedido cancelado automaticamente" })
                            .setTimestamp(),
                    ]});
                }
            } catch {}

            await PendingPayment.deleteOne({ _id: p._id });

            // Loga no canal de logs
            if (LOGS_CHANNEL_ID) {
                try {
                    const ch = await clientLogs.channels.fetch(LOGS_CHANNEL_ID);
                    if (ch) await ch.send({ embeds: [
                        new EmbedBuilder()
                            .setColor(0xFF3C3C)
                            .setTitle("🗑️ Pedido Cancelado por Inatividade")
                            .setDescription(`**Usuário:** <@${p.discordId}> (${p.discordTag})\n**Plano:** ${p.label}\n**Valor:** R$${p.price}\n**Criado:** ${tsAbsolute(p.createdAt)}`)
                            .setTimestamp(),
                    ]});
                } catch {}
            }
        }

        // ✅ Aviso de 15min antes: como o tempo total É 15min, avisamos logo na criação.
        // Aqui fazemos o aviso para pedidos com mais de (PENDING_EXPIRY_MS - 60_000)ms (faltando ~1min)
        const toWarn = await PendingPayment.find({
            warningSent: false,
            createdAt: { $lt: new Date(now - (PENDING_EXPIRY_MS - 60_000)) },
        });
        for (const p of toWarn) {
            try {
                const user = await fetchUserFromAnyClient(p.discordId);
                if (user) {
                    await user.send({ embeds: [
                        new EmbedBuilder()
                            .setColor(0xFFA500)
                            .setTitle("⚠️ Seu pedido vai expirar em 1 minuto!")
                            .setDescription(
                                `Seu pedido de **${p.label}** (R$${p.price}) está prestes a ser cancelado!\n\n` +
                                `Envie o comprovante **agora** no canal de compras para não perder seu pedido.\n\n` +
                                `> Se não pagar em breve, o pedido será cancelado automaticamente.`
                            )
                            .setFooter({ text: "Bob Keys • Aviso automático" })
                            .setTimestamp(),
                    ]});
                }
            } catch {}
            await PendingPayment.updateOne({ _id: p._id }, { warningSent: true });
        }

    } catch (e) { console.error("[PENDING CLEANUP] Erro:", e.message); }

}, 60_000);

// ─── EXPRESS + SOCKET.IO ──────────────────────────────────────────────────────
const app    = express();
app.use(express.json());
const server = http.createServer(app);
const io     = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    allowEIO3: true,
    transports: ["polling", "websocket"],
});
const port = process.env.PORT || 3000;

// ─── RATE LIMITER ─────────────────────────────────────────────────────────────
const rateLimitMap = {};
const blockedIPs   = {};

function getRealIP(req) {
    return (req.headers["x-forwarded-for"] || "").split(",")[0].trim()
        || req.socket.remoteAddress || "unknown";
}

async function logSecurityAlert(message) {
    console.warn("[SECURITY ALERT]", message);
    if (!LOGS_CHANNEL_ID) return;
    try {
        const ch = await clientLogs.channels.fetch(LOGS_CHANNEL_ID);
        if (ch) await ch.send({ embeds: [
            new EmbedBuilder()
                .setTitle("🚨 Alerta de Segurança")
                .setColor(0xFF3C3C)
                .setDescription(message)
                .setTimestamp(),
        ]});
    } catch {}
}

function rateLimitMiddleware(req, res, next) {
    const openRoutes = ["/health", "/"];
    if (openRoutes.includes(req.path)) return next();
    const ip  = getRealIP(req);
    const now = Date.now();
    if (blockedIPs[ip]) {
        if (now < blockedIPs[ip]) {
            const remaining = Math.ceil((blockedIPs[ip] - now) / 1000);
            return res.status(429).json({ status: "error", message: `IP bloqueado. Tente em ${remaining}s.` });
        }
        delete blockedIPs[ip];
    }
    if (!rateLimitMap[ip] || now - rateLimitMap[ip].windowStart > RATE_LIMIT_WINDOW) {
        rateLimitMap[ip] = { count: 1, windowStart: now };
        return next();
    }
    rateLimitMap[ip].count++;
    if (rateLimitMap[ip].count > RATE_LIMIT_MAX) {
        blockedIPs[ip] = now + BLOCK_DURATION;
        logSecurityAlert(`🔴 IP \`${ip}\` bloqueado por rate limit`);
        return res.status(429).json({ status: "error", message: "Muitas requisições. IP bloqueado por 5 minutos." });
    }
    next();
}

function requireClientHeader(req, res, next) {
    const header = req.headers["x-bob-client"];
    const ua     = (req.headers["user-agent"] || "").toLowerCase();
    const ip     = getRealIP(req);
    if (!header || header !== CLIENT_HEADER) {
        logSecurityAlert(`⚠️ Acesso sem header válido de \`${ip}\` em \`${req.path}\``);
        return res.status(403).json({ status: "error", message: "Acesso negado." });
    }
    if (BLOCKED_UA.some(b => ua.includes(b))) {
        blockedIPs[ip] = Date.now() + BLOCK_DURATION;
        logSecurityAlert(`🔴 Ferramenta de spy bloqueada de \`${ip}\` — UA: \`${ua}\``);
        return res.status(403).json({ status: "error", message: "Acesso negado." });
    }
    next();
}

app.use(rateLimitMiddleware);

// ─── SOCKET.IO AUTH ───────────────────────────────────────────────────────────
io.use((socket, next) => {
    const key    = socket.handshake.auth?.key    || socket.handshake.query?.key;
    const secret = socket.handshake.auth?.secret || socket.handshake.query?.secret;
    const hwid   = socket.handshake.auth?.hwid   || socket.handshake.query?.hwid;
    const header = socket.handshake.headers?.["x-bob-client"];
    const ua     = (socket.handshake.headers?.["user-agent"] || "").toLowerCase();
    const ip     = (socket.handshake.headers?.["x-forwarded-for"] || "").split(",")[0].trim()
                || socket.handshake.address || "unknown";
    if (!header || header !== CLIENT_HEADER) {
        logSecurityAlert(`⚠️ WebSocket sem header válido de \`${ip}\``);
        return next(new Error("Acesso negado."));
    }
    if (BLOCKED_UA.some(b => ua.includes(b))) {
        blockedIPs[ip] = Date.now() + BLOCK_DURATION;
        logSecurityAlert(`🔴 Ferramenta de spy no WebSocket de \`${ip}\` — UA: \`${ua}\``);
        return next(new Error("Acesso negado."));
    }
    const r = checkKey(key, secret, hwid);
    if (!r.ok) { return next(new Error(r.error)); }
    socket.keyName = r.keyName;
    next();
});

io.on("connection", (socket) => {
    socket.on("disconnect", () => console.log(`[SOCKET] Desconectado: ${socket.keyName}`));
});

// ─── KEY VALIDATION ───────────────────────────────────────────────────────────
function checkKey(key, secret, hwid) {
    if (secret !== SCRIPT_SECRET) return { ok: false, error: "Secret invalido" };
    const keyClean  = (key  || "").trim();
    const hwidClean = (hwid || "").trim() || null;
    const keyName   = findKey(keyClean);
    const data      = keys[keyName];
    if (!data)       return { ok: false, error: "Chave nao existe" };
    if (data.paused) return { ok: false, error: "Chave pausada" };
    if (data.expiry !== Infinity && data.expiry - Date.now() <= 0) {
        delete keys[keyName]; deleteKey(keyName);
        return { ok: false, error: "Chave expirada" };
    }
    if (hwidClean) {
        if (!data.hwid) { data.hwid = hwidClean; saveKey(keyName); }
        else if (data.hwid !== hwidClean) return { ok: false, error: "HWID invalido" };
    }
    return { ok: true, data, keyName };
}

// ─── PAGAMENTO ────────────────────────────────────────────────────────────────
async function confirmarPagamento(user, hours, channel, confirmedBy = "admin", price = null, label = null) {
    const keyName   = generateBobKey();
    const expiresAt = Date.now() + hours * 3_600_000;

    // Detecta preço e label automaticamente se não fornecido
    if (!price || !label) {
        const plan = PLANS.find(p => p.hours === hours);
        price = price || plan?.price || hours * 5;
        label = label || plan?.label || `${hours}h`;
    }

    keys[keyName] = {
        expiry:    expiresAt,
        paused:    false,
        remaining: hours * 3_600_000,
        hwid:      null,
        discordId: String(user.id),
    };
    await saveKey(keyName);

    // ✅ NOVO: Salva no histórico de vendas
    try {
        await SaleHistory.create({
            discordId:   String(user.id),
            discordTag:  user.tag,
            hours,
            price,
            label,
            keyName,
            confirmedBy: String(confirmedBy),
        });
    } catch (e) { console.error("[SALE HISTORY] Erro ao salvar:", e.message); }

    const dmEmbed = new EmbedBuilder()
        .setColor(0x00ff88)
        .setTitle("🎉 Pagamento Confirmado!")
        .setDescription(
            `Sua key foi gerada com sucesso!\n\n` +
            `**🔑 Sua Key:**\n\`\`\`${keyName}\`\`\`\n` +
            `**Plano:** ${label}\n` +
            `**Expira:** ${tsRelative(expiresAt)}\n\n` +
            `Use essa key para ativar o Bob Joiner!`
        )
        .setFooter({ text: "Bob Keys • Obrigado pela compra! 🚀" })
        .setTimestamp();

    let dmOk = false;
    try { await user.send({ embeds: [dmEmbed] }); dmOk = true; } catch {}

    if (!dmOk && channel)
        channel.send(`⚠️ <@${user.id}> — Não consegui enviar DM! Ativa DMs do servidor.\nSua key: \`${keyName}\``).catch(() => {});

    if (channel) {
        channel.send({ embeds: [new EmbedBuilder()
            .setColor(0x00ff88)
            .setTitle("✅ Key Gerada")
            .setDescription(
                `**Usuário:** <@${user.id}> (${user.tag})\n` +
                `**Plano:** ${label}\n` +
                `**Key:** \`${keyName}\`\n` +
                `**Expira:** ${tsRelative(expiresAt)}\n` +
                `**Confirmado por:** ${confirmedBy === "auto" ? "🤖 Automático" : `<@${confirmedBy}>`}\n` +
                `**DM enviada:** ${dmOk ? "✅ Sim" : "❌ Não (DMs fechadas)"}`
            )
            .setTimestamp(),
        ]}).catch(() => {});
    }

    console.log(`[PAYMENT] ✅ Key gerada para ${user.tag} (${user.id}): ${keyName} (${hours}h) | DM: ${dmOk}`);
}

// ─── KEY OPERATIONS ────────────────────────────────────────────────────────────
async function opCreateKey(name, durationMs, discordId = null) {
    if (findKey(name)) return { ok: false, msg: `❌ Chave \`${name}\` já existe!` };
    if (durationMs <= 0) return { ok: false, msg: "❌ Duração inválida!" };
    keys[name] = { expiry: Date.now() + durationMs, paused: false, remaining: durationMs, hwid: null, discordId };
    await saveKey(name);
    return { ok: true, msg: `✅ Chave \`${name}\` criada! Duração: **${formatTime(durationMs)}**` };
}

async function opCreateLifetime(name) {
    if (findKey(name)) return { ok: false, msg: `❌ Chave \`${name}\` já existe!` };
    keys[name] = { expiry: Infinity, paused: false, remaining: Infinity, hwid: null, discordId: null };
    await saveKey(name);
    return { ok: true, msg: `✅ Chave \`${name}\` criada como **Lifetime ♾️**!` };
}

async function opRevokeKey(name) {
    if (name.toLowerCase() === "all") {
        const count = Object.keys(keys).length;
        for (const k of Object.keys(keys)) { delete keys[k]; await deleteKey(k); }
        return { ok: true, msg: `🗑️ **${count} chaves** removidas.` };
    }
    const t = findKey(name);
    if (!t) return { ok: false, msg: "❌ Chave não encontrada." };
    delete keys[t]; await deleteKey(t);
    return { ok: true, msg: `🗑️ Chave \`${t}\` removida.` };
}

async function opTogglePause(name) {
    if (name.toLowerCase() === "all") {
        let paused = 0, resumed = 0;
        for (const k of Object.keys(keys)) {
            const d = keys[k];
            if (d.paused) { d.expiry = Date.now() + d.remaining; d.paused = false; resumed++; }
            else { d.remaining = d.expiry === Infinity ? Infinity : d.expiry - Date.now(); d.paused = true; paused++; }
            await saveKey(k);
        }
        return { ok: true, msg: `⏸️ **${paused}** pausadas, **${resumed}** retomadas.` };
    }
    const t = findKey(name);
    if (!t) return { ok: false, msg: "❌ Chave não encontrada." };
    const d = keys[t];
    if (d.paused) {
        d.expiry = Date.now() + d.remaining; d.paused = false; await saveKey(t);
        return { ok: true, msg: `▶️ \`${t}\` retomada!` };
    }
    d.remaining = d.expiry === Infinity ? Infinity : d.expiry - Date.now();
    d.paused = true; await saveKey(t);
    return { ok: true, msg: `⏸️ \`${t}\` pausada!` };
}

async function opResetHwid(name) {
    if (name.toLowerCase() === "all") {
        let count = 0;
        for (const k of Object.keys(keys)) { keys[k].hwid = null; kicked[k.toLowerCase()] = Date.now(); await saveKey(k); count++; }
        return { ok: true, msg: `✅ HWID de **${count} chaves** resetado!` };
    }
    const t = findKey(name);
    if (!t) return { ok: false, msg: "❌ Chave não encontrada." };
    keys[t].hwid = null; kicked[t.toLowerCase()] = Date.now(); await saveKey(t);
    return { ok: true, msg: `✅ HWID de \`${t}\` resetado!` };
}

async function opAddTime(name, extraMs) {
    if (extraMs <= 0) return { ok: false, msg: "❌ Tempo inválido!" };
    if (name.toLowerCase() === "all") {
        let count = 0;
        for (const k of Object.keys(keys)) {
            const d = keys[k];
            if (d.paused) d.remaining += extraMs;
            else if (d.expiry !== Infinity) d.expiry += extraMs;
            await saveKey(k); count++;
        }
        return { ok: true, msg: `✅ **${formatTime(extraMs)}** adicionado a **${count} chaves**!` };
    }
    const t = findKey(name);
    if (!t) return { ok: false, msg: "❌ Chave não encontrada." };
    const d = keys[t];
    if (d.paused) d.remaining += extraMs;
    else if (d.expiry !== Infinity) d.expiry += extraMs;
    await saveKey(t);
    return { ok: true, msg: `✅ **${formatTime(extraMs)}** adicionado a \`${t}\`!` };
}

async function opSetExpiry(name, durationMs) {
    if (durationMs <= 0) return { ok: false, msg: "❌ Duração inválida!" };
    const t = findKey(name);
    if (!t) return { ok: false, msg: "❌ Chave não encontrada." };
    const d = keys[t];
    if (d.paused) { d.remaining = durationMs; }
    else { d.expiry = Date.now() + durationMs; d.remaining = durationMs; }
    await saveKey(t);
    return { ok: true, msg: `✅ Expiração de \`${t}\` redefinida para **${formatTime(durationMs)}**!` };
}

// ─── BOT NOTIFIER ─────────────────────────────────────────────────────────────
const clientNotifier = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildWebhooks],
});

clientNotifier.on("ready", () => console.log(`[NOTIFIER] Online: ${clientNotifier.user.tag}`));

clientNotifier.on("messageCreate", async (message) => {
    if (message.author.bot && message.author.id === clientNotifier.user?.id) return;
    if (message.channel.id !== DISCORD_CHANNEL_ID) return;
    if (!message.embeds.length) return;

    const embed = message.embeds[0];
    let jobId = null, value = "0", players = "N/A";

    for (const f of (embed.fields || [])) {
        const fn = f.name.toLowerCase();
        if (fn.includes("jobid") || fn.includes("job")) jobId = f.value.trim();
        if (fn.includes("value") || fn.includes("valor")) value = f.value.trim();
        if (fn.includes("player")) players = f.value.trim();
    }

    const payload = {
        id: Date.now().toString(),
        title: embed.title || "Bob!",
        description: embed.description || "Novo Alerta!",
        brainrot: embed.title || "Brainrot",
        name: embed.title || "Brainrot",
        jobId: xorObfuscate(jobId),
        value,
        players,
    };

    pushBrainrot(payload);
});

// ─── BOT LOGS ─────────────────────────────────────────────────────────────────
const clientLogs = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

clientLogs.on("ready", async () => {
    console.log(`[LOGS] Online: ${clientLogs.user.tag}`);
    await sendLogsPanel();
});

function buildLogsEmbed() {
    return new EmbedBuilder()
        .setTitle("🛠️ Bob Logs — Painel de Administração")
        .setColor(0x5865F2)
        .setDescription(
            "Painel completo de controle do **Bob Joiner**.\n" +
            "Use os botões abaixo para gerenciar keys, monitorar usuários e administrar o sistema.\n\n" +
            "**Categorias disponíveis:**\n" +
            "🔑 **Gerenciar Keys** — criar, revogar, pausar, resetar\n" +
            "⏱️ **Tempo** — addtime, setexpiry\n" +
            "📊 **Informações** — online, stats, lookup, jobids\n" +
            "🛡️ **Segurança** — blocked, unblock\n" +
            "🧹 **Utilitários** — cleanlogs, test\n" +
            "💳 **Pagamentos** — pendentes, confirmar, cancelar, histórico"
        )
        .setFooter({ text: "Bob Joiner Admin Panel • Todos os comandos requerem senha de admin" })
        .setTimestamp();
}

function buildLogsRows() {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("logs_create").setLabel("Criar Key").setEmoji("🔑").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("logs_lifetime").setLabel("Lifetime").setEmoji("♾️").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("logs_revoke").setLabel("Revogar").setEmoji("🗑️").setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId("logs_pause").setLabel("Pausar").setEmoji("⏸️").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("logs_reset").setLabel("Reset HWID").setEmoji("🔄").setStyle(ButtonStyle.Secondary),
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("logs_addtime").setLabel("Add/Extend Tempo").setEmoji("⏱️").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("logs_setexpiry").setLabel("Set Expiração").setEmoji("📅").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("logs_transfer").setLabel("Transfer Key").setEmoji("🔀").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("logs_sethwid").setLabel("Set HWID").setEmoji("💻").setStyle(ButtonStyle.Secondary),
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("logs_online").setLabel("Online").setEmoji("🟢").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("logs_stoponline").setLabel("Stop Online").setEmoji("⏹️").setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId("logs_stats").setLabel("Stats").setEmoji("📊").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("logs_info").setLabel("Listar Keys").setEmoji("📋").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("logs_lookup").setLabel("Lookup").setEmoji("🔍").setStyle(ButtonStyle.Secondary),
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("logs_jobids").setLabel("JobIDs").setEmoji("🎮").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("logs_blocked").setLabel("IPs Bloqueados").setEmoji("🔒").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("logs_unblock").setLabel("Desbloquear IP").setEmoji("🔓").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("logs_cleanlogs").setLabel("Limpar Logs").setEmoji("🧹").setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId("logs_test").setLabel("Teste").setEmoji("🧪").setStyle(ButtonStyle.Secondary),
        ),
        // ✅ NOVO: Linha de pagamentos expandida
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("logs_pendentes").setLabel("Pendentes Pix").setEmoji("⏳").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("logs_confirmar_manual").setLabel("Confirmar Pgto").setEmoji("💳").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("logs_cancelar_pedido").setLabel("Cancelar Pedido").setEmoji("❌").setStyle(ButtonStyle.Danger),  // ✅ NOVO
            new ButtonBuilder().setCustomId("logs_vendas").setLabel("Vendas").setEmoji("💰").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("logs_historico").setLabel("Histórico").setEmoji("📜").setStyle(ButtonStyle.Secondary),          // ✅ NOVO
        ),
    ];
}

async function sendLogsPanel() {
    const channelId = BOB_LOGS_PANEL_CHANNEL || LOGS_CHANNEL_ID;
    if (!channelId) return;
    try {
        const ch = await clientLogs.channels.fetch(channelId);
        if (!ch) return;
        const msgs = await ch.messages.fetch({ limit: 20 });
        for (const [, msg] of msgs) { if (msg.author.id === clientLogs.user.id) await msg.delete().catch(() => {}); }
        await ch.send({ embeds: [buildLogsEmbed()], components: buildLogsRows() });
        console.log("[LOGS] Painel enviado!");
    } catch (e) { console.error("[LOGS] Erro ao enviar painel:", e.message); }
}

function buildOnlineEmbed() {
    const now = Date.now();
    const robloxByKey = {};
    for (const [, info] of Object.entries(presence)) {
        const keyName = info.key ? findKey(info.key) : null;
        if (keyName && !robloxByKey[keyName] && now - info.lastSeen < PRESENCE_TTL)
            robloxByKey[keyName] = info.name || null;
    }
    const activeKeys = Object.entries(keys).filter(([, d]) => d.paused || d.expiry === Infinity || d.expiry - now > 0);
    const embed = new EmbedBuilder()
        .setTitle("📋 Keys Ativas — Bob Joiner")
        .setColor(0x5865F2)
        .setFooter({ text: `Bob Joiner • ${activeKeys.length} key(s) ativa(s) • Atualizado` })
        .setTimestamp();
    if (!activeKeys.length) { embed.setDescription("Nenhuma key ativa no momento."); return embed; }
    const lines = activeKeys.map(([keyName, d]) => {
        const status     = d.paused ? "⏸️" : "✅";
        const mention    = d.discordId ? `<@${d.discordId}>` : "*(sem Discord)*";
        const robloxName = robloxByKey[keyName] || "—";
        let timeStr;
        if (d.paused) timeStr = formatTime(d.remaining);
        else if (d.expiry === Infinity) timeStr = "Lifetime ♾️";
        else timeStr = formatTime(d.expiry - now);
        return `${status} ${mention} **(${robloxName})** — ⏱️ \`${timeStr}\``;
    });
    embed.setDescription(lines.join("\n").substring(0, 4000));
    return embed;
}

function isAdmin(member) {
    return ADMIN_ROLE_IDS.some(id => member?.roles?.cache?.has(id));
}

if (!global.onlineIntervals) global.onlineIntervals = {};

function startOnlineInterval(channelId, messageObj) {
    stopOnlineInterval(channelId);
    global.onlineIntervals[channelId] = setInterval(async () => {
        await messageObj.edit({ embeds: [buildOnlineEmbed()] }).catch(() => stopOnlineInterval(channelId));
    }, 60_000);
}

function stopOnlineInterval(channelId) {
    if (global.onlineIntervals[channelId]) {
        clearInterval(global.onlineIntervals[channelId]);
        delete global.onlineIntervals[channelId];
    }
}

// ─── LOGS — INTERACTION HANDLER ───────────────────────────────────────────────
clientLogs.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isModalSubmit()) { await handleLogsModal(interaction); return; }
    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith("logs_") && !interaction.customId.startsWith("pay_")) return;

    if (!isAdmin(interaction.member)) {
        await interaction.reply({ content: "❌ Você não tem permissão para usar este painel.", flags: 64 });
        return;
    }

    const id = interaction.customId;

    if (id === "logs_online") {
        await interaction.deferReply({ ephemeral: false });
        const sentMsg = await interaction.editReply({ embeds: [buildOnlineEmbed()] });
        startOnlineInterval(interaction.channelId, sentMsg);
        return;
    }
    if (id === "logs_stoponline") {
        await interaction.deferReply({ flags: 64 });
        stopOnlineInterval(interaction.channelId);
        await interaction.editReply({ content: "⏹️ Atualização do online parada." });
        return;
    }
    if (id === "logs_stats") {
        await interaction.deferReply({ flags: 64 });
        const all    = Object.values(keys);
        const active = all.filter(k => !k.paused && (k.expiry === Infinity || k.expiry - Date.now() > 0));
        const paused = all.filter(k => k.paused);
        const lt     = all.filter(k => k.expiry === Infinity);
        const online = Object.values(presence).filter(p => Date.now() - p.lastSeen < ONLINE_STALE_MS);
        const pendentes = await PendingPayment.countDocuments();
        await interaction.editReply({ embeds: [new EmbedBuilder().setTitle("📊 Estatísticas Bob Joiner").setColor(0x5865F2)
            .addFields(
                { name: "🔑 Total de Keys",     value: String(all.length),       inline: true },
                { name: "✅ Ativas",             value: String(active.length),    inline: true },
                { name: "⏸️ Pausadas",           value: String(paused.length),    inline: true },
                { name: "♾️ Lifetime",           value: String(lt.length),        inline: true },
                { name: "🟢 Online agora",       value: String(online.length),    inline: true },
                { name: "📡 Brainrots (fila)",   value: String(brainrots.length), inline: true },
                { name: "⏳ Pedidos Pendentes",  value: String(pendentes),        inline: true },
            ).setTimestamp()] });
        return;
    }
    if (id === "logs_info") {
        await interaction.deferReply({ flags: 64 });
        const ks = Object.keys(keys);
        if (!ks.length) { await interaction.editReply({ content: "Nenhuma chave ativa." }); return; }
        const now   = Date.now();
        const lines = ks.map(k => {
            const d = keys[k];
            const t = d.paused ? d.remaining : (d.expiry === Infinity ? Infinity : d.expiry - now);
            return `• \`${k}\`: \`${formatTime(t)}\` ${d.paused ? "⏸️" : "✅"} ${d.discordId ? `<@${d.discordId}>` : "*(sem Discord)*"}`;
        });
        await interaction.editReply({ embeds: [new EmbedBuilder().setTitle("🔑 Chaves Ativas").setColor(0x5865F2).setDescription(lines.join("\n").substring(0, 4000)).setTimestamp()] });
        return;
    }
    if (id === "logs_jobids") {
        await interaction.deferReply({ flags: 64 });
        const entries = Object.entries(userJobIds);
        if (!entries.length) { await interaction.editReply({ content: "Nenhum JobID registrado." }); return; }
        await interaction.editReply({ content: "🎮 **JobIDs conhecidos:**\n" + entries.map(([n, j]) => `• **${n}**: \`${j}\``).join("\n") });
        return;
    }
    if (id === "logs_blocked") {
        await interaction.deferReply({ flags: 64 });
        const now    = Date.now();
        const active = Object.entries(blockedIPs).filter(([, until]) => now < until);
        if (!active.length) { await interaction.editReply({ content: "Nenhum IP bloqueado no momento." }); return; }
        await interaction.editReply({ content: "🔒 **IPs Bloqueados:**\n" + active.map(([ip, until]) => `• \`${ip}\` — ainda ${Math.ceil((until - now) / 1000)}s`).join("\n") });
        return;
    }
    if (id === "logs_test") {
        await interaction.deferReply({ flags: 64 });
        const payload = { id: Date.now().toString(), title: "TESTE", description: "SINAL OK!", brainrot: "TESTE", name: "TESTE", jobId: null, value: "999999999", players: "N/A" };
        pushBrainrot(payload);
        await interaction.editReply({ content: "✅ Brainrot de teste enviado!" });
        return;
    }
    if (id === "logs_pendentes") {
        await interaction.deferReply({ flags: 64 });
        const pendentes = await PendingPayment.find().sort({ createdAt: -1 });
        if (!pendentes.length) { await interaction.editReply({ content: "✅ Nenhum pedido pendente!" }); return; }
        const now  = Date.now();
        const list = pendentes.map(p => {
            const age        = now - new Date(p.createdAt).getTime();
            const remaining  = PENDING_EXPIRY_MS - age;
            const timeLeft   = remaining > 0 ? `⏳ expira em ${formatTimeShort(remaining)}` : "⚠️ expirando...";
            return `• **${p.discordTag}** — ${p.label} (R$${p.price}) — ${tsRelative(p.createdAt)} — ${timeLeft}`;
        }).join("\n");
        const rows = [];
        if (pendentes.length > 0) {
            const row = new ActionRowBuilder();
            pendentes.slice(0, 4).forEach(p => {
                row.addComponents(new ButtonBuilder()
                    .setCustomId(`pay_confirm_${p.discordId}_${p.hours}`)
                    .setLabel(`✅ ${p.discordTag.split("#")[0].slice(0, 15)}`)
                    .setStyle(ButtonStyle.Success));
            });
            rows.push(row);
            // ✅ NOVO: Botões de cancelar individuais
            if (pendentes.length > 0) {
                const cancelRow = new ActionRowBuilder();
                pendentes.slice(0, 4).forEach(p => {
                    cancelRow.addComponents(new ButtonBuilder()
                        .setCustomId(`pay_cancel_${p.discordId}`)
                        .setLabel(`❌ ${p.discordTag.split("#")[0].slice(0, 15)}`)
                        .setStyle(ButtonStyle.Danger));
                });
                rows.push(cancelRow);
            }
        }
        await interaction.editReply({ embeds: [new EmbedBuilder()
            .setColor(0xffaa00)
            .setTitle(`⏳ Pedidos Pendentes (${pendentes.length}) — Expiram em 15min`)
            .setDescription(list)
            .setFooter({ text: "Pedidos são cancelados automaticamente após 15 minutos de inatividade" })
        ], components: rows });
        return;
    }
    if (id === "logs_confirmar_manual") {
        await interaction.showModal(new ModalBuilder().setCustomId("modal_pay_confirm").setTitle("Confirmar Pagamento Manual").addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("user_id").setLabel("ID do usuário Discord:").setStyle(TextInputStyle.Short).setPlaceholder("123456789012345678").setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("horas").setLabel("Quantidade de horas:").setStyle(TextInputStyle.Short).setPlaceholder("2").setRequired(true)),
        ));
        return;
    }
    // ✅ NOVO: Cancelar pedido manualmente pelo painel
    if (id === "logs_cancelar_pedido") {
        await interaction.showModal(new ModalBuilder().setCustomId("modal_cancel_pedido").setTitle("❌ Cancelar Pedido Pendente").addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("user_id").setLabel("ID ou @ do usuário:").setStyle(TextInputStyle.Short).setPlaceholder("123456789012345678").setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("motivo").setLabel("Motivo (opcional):").setStyle(TextInputStyle.Short).setPlaceholder("Ex: Comprovante inválido").setRequired(false)),
        ));
        return;
    }
    if (id === "logs_vendas") {
        await interaction.deferReply({ flags: 64 });
        const allKeys   = Object.values(keys);
        const por2h     = allKeys.filter(k => k.remaining <= 7_200_000 && k.remaining > 0).length;
        const por4h     = allKeys.filter(k => k.remaining > 7_200_000).length;
        const pendentes = await PendingPayment.countDocuments();
        const receita   = (por2h * 10) + (por4h * 20);
        await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x00ff88).setTitle("💰 Relatório de Vendas").addFields(
            { name: "⏱️ Keys 2h vendidas", value: String(por2h),     inline: true },
            { name: "⚡ Keys 4h vendidas", value: String(por4h),     inline: true },
            { name: "⏳ Pendentes",         value: String(pendentes), inline: true },
            { name: "💰 Receita Estimada",  value: `R$${receita},00`, inline: false },
        ).setTimestamp()] });
        return;
    }
    // ✅ NOVO: Histórico de vendas
    if (id === "logs_historico") {
        await interaction.deferReply({ flags: 64 });
        const sales = await SaleHistory.find().sort({ confirmedAt: -1 }).limit(20);
        if (!sales.length) { await interaction.editReply({ content: "Nenhuma venda registrada ainda." }); return; }
        const totalReceita = await SaleHistory.aggregate([{ $group: { _id: null, total: { $sum: "$price" } } }]);
        const total = totalReceita[0]?.total || 0;
        const lines = sales.map(s =>
            `• <@${s.discordId}> — **${s.label}** (R$${s.price}) — \`${s.keyName}\` — ${tsRelative(s.confirmedAt)}`
        ).join("\n");
        await interaction.editReply({ embeds: [new EmbedBuilder()
            .setColor(0x00ff88)
            .setTitle(`📜 Histórico de Vendas (últimas 20)`)
            .setDescription(lines.substring(0, 4000))
            .addFields({ name: "💰 Total Arrecadado (todas as vendas)", value: `R$${total},00`, inline: false })
            .setTimestamp()
        ]});
        return;
    }
    // Confirmação rápida via botão na lista de pendentes
    if (id.startsWith("pay_confirm_")) {
        await interaction.deferReply({ flags: 64 });
        const parts    = id.split("_");
        const targetId = parts[2];
        const hours    = parseInt(parts[3]);
        const pending  = await PendingPayment.findOne({ discordId: targetId });
        const target   = await fetchUserFromAnyClient(targetId);
        if (!target) { await interaction.editReply({ content: "❌ Usuário não encontrado!" }); return; }
        await confirmarPagamento(target, hours, interaction.channel, interaction.user.id, pending?.price, pending?.label);
        await PendingPayment.deleteOne({ discordId: targetId });
        await interaction.editReply({ content: `✅ Key gerada e enviada na DM de **${target.tag}** (${hours}h)!` });
        return;
    }
    // ✅ NOVO: Cancelamento rápido via botão na lista de pendentes
    if (id.startsWith("pay_cancel_")) {
        await interaction.deferReply({ flags: 64 });
        const targetId = id.replace("pay_cancel_", "");
        const pending  = await PendingPayment.findOne({ discordId: targetId });
        if (!pending) { await interaction.editReply({ content: "❌ Pedido não encontrado." }); return; }
        await PendingPayment.deleteOne({ discordId: targetId });
        try {
            const target = await fetchUserFromAnyClient(targetId);
            if (target) await target.send({ embeds: [new EmbedBuilder()
                .setColor(0xFF3C3C).setTitle("❌ Pedido Cancelado")
                .setDescription(`Seu pedido de **${pending.label}** (R$${pending.price}) foi cancelado por um administrador.`)
                .setTimestamp()] });
        } catch {}
        await interaction.editReply({ content: `🗑️ Pedido de **${pending.discordTag}** cancelado.` });
        return;
    }

    const modalMap = {
        logs_create:     buildModal_create,
        logs_lifetime:   buildModal_lifetime,
        logs_revoke:     buildModal_revoke,
        logs_pause:      buildModal_pause,
        logs_reset:      buildModal_reset,
        logs_addtime:    buildModal_addtime,
        logs_setexpiry:  buildModal_setexpiry,
        logs_transfer:   buildModal_transfer,
        logs_sethwid:    buildModal_sethwid,
        logs_lookup:     buildModal_lookup,
        logs_unblock:    buildModal_unblock,
        logs_cleanlogs:  buildModal_cleanlogs,
    };
    if (modalMap[id]) await interaction.showModal(modalMap[id]());
});

// ─── LOGS — MODAL HANDLER ─────────────────────────────────────────────────────
async function handleLogsModal(interaction) {
    await interaction.deferReply({ flags: 64 });
    const id       = interaction.customId;
    const getField = (name) => { try { return interaction.fields.getTextInputValue(name); } catch { return ""; } };
    const getTime  = () => {
        const h = parseInt(getField("key_h")) || 0;
        const m = parseInt(getField("key_m")) || 0;
        return (h * 3600 + m * 60) * 1000;
    };

    if (id === "modal_pay_confirm") {
        const userId  = getField("user_id").trim();
        const hours   = parseInt(getField("horas").trim());
        if (isNaN(hours) || hours <= 0) { await interaction.editReply({ content: "❌ Horas inválidas!" }); return; }
        const pending = await PendingPayment.findOne({ discordId: userId });
        const target  = await fetchUserFromAnyClient(userId);
        if (!target) { await interaction.editReply({ content: "❌ Usuário não encontrado!" }); return; }
        await confirmarPagamento(target, hours, interaction.channel, interaction.user.id, pending?.price, pending?.label);
        await PendingPayment.deleteOne({ discordId: userId });
        await interaction.editReply({ content: `✅ Key gerada para **${target.tag}** (${hours}h)!` });
        return;
    }
    // ✅ NOVO: Cancelar pedido via modal
    if (id === "modal_cancel_pedido") {
        const userId  = getField("user_id").replace(/\D/g, "");
        const motivo  = getField("motivo").trim() || "Sem motivo informado";
        const pending = await PendingPayment.findOne({ discordId: userId });
        if (!pending) { await interaction.editReply({ content: "❌ Nenhum pedido pendente encontrado para esse usuário." }); return; }
        await PendingPayment.deleteOne({ discordId: userId });
        try {
            const target = await fetchUserFromAnyClient(userId);
            if (target) await target.send({ embeds: [new EmbedBuilder()
                .setColor(0xFF3C3C).setTitle("❌ Pedido Cancelado pelo Admin")
                .setDescription(
                    `Seu pedido de **${pending.label}** (R$${pending.price}) foi cancelado.\n\n` +
                    `**Motivo:** ${motivo}\n\n` +
                    `Entre em contato com um admin se tiver dúvidas.`
                ).setTimestamp()] });
        } catch {}
        await interaction.editReply({ content: `🗑️ Pedido de **${pending.discordTag}** cancelado. Motivo: *${motivo}*` });
        return;
    }
    if (id === "modal_create") {
        if (wrongPass(getField("key_pass"))) { await interaction.editReply({ content: "❌ Senha incorreta!" }); return; }
        const r = await opCreateKey(getField("key_name").trim(), getTime());
        await interaction.editReply({ content: r.msg }); return;
    }
    if (id === "modal_lifetime") {
        if (wrongPass(getField("key_pass"))) { await interaction.editReply({ content: "❌ Senha incorreta!" }); return; }
        const r = await opCreateLifetime(getField("key_name").trim());
        await interaction.editReply({ content: r.msg }); return;
    }
    if (id === "modal_revoke") {
        if (wrongPass(getField("key_pass"))) { await interaction.editReply({ content: "❌ Senha incorreta!" }); return; }
        const r = await opRevokeKey(getField("key_name").trim());
        await interaction.editReply({ content: r.msg }); return;
    }
    if (id === "modal_pause") {
        if (wrongPass(getField("key_pass"))) { await interaction.editReply({ content: "❌ Senha incorreta!" }); return; }
        const r = await opTogglePause(getField("key_name").trim());
        await interaction.editReply({ content: r.msg }); return;
    }
    if (id === "modal_reset") {
        if (wrongPass(getField("key_pass"))) { await interaction.editReply({ content: "❌ Senha incorreta!" }); return; }
        const r = await opResetHwid(getField("key_name").trim());
        await interaction.editReply({ content: r.msg }); return;
    }
    if (id === "modal_addtime") {
        if (wrongPass(getField("key_pass"))) { await interaction.editReply({ content: "❌ Senha incorreta!" }); return; }
        const r = await opAddTime(getField("key_name").trim(), getTime());
        await interaction.editReply({ content: r.msg }); return;
    }
    if (id === "modal_setexpiry") {
        if (wrongPass(getField("key_pass"))) { await interaction.editReply({ content: "❌ Senha incorreta!" }); return; }
        const r = await opSetExpiry(getField("key_name").trim(), getTime());
        await interaction.editReply({ content: r.msg }); return;
    }
    if (id === "modal_transfer") {
        if (wrongPass(getField("key_pass"))) { await interaction.editReply({ content: "❌ Senha incorreta!" }); return; }
        const oldName = getField("key_old").trim(), newName = getField("key_new").trim();
        const t = findKey(oldName); if (!t) { await interaction.editReply({ content: "❌ Chave não encontrada." }); return; }
        if (findKey(newName)) { await interaction.editReply({ content: `❌ Chave \`${newName}\` já existe!` }); return; }
        keys[newName] = { ...keys[t] }; delete keys[t]; await deleteKey(t); await saveKey(newName);
        await interaction.editReply({ content: `✅ Chave transferida de \`${t}\` para \`${newName}\`!` }); return;
    }
    if (id === "modal_sethwid") {
        if (wrongPass(getField("key_pass"))) { await interaction.editReply({ content: "❌ Senha incorreta!" }); return; }
        const t = findKey(getField("key_name").trim()); if (!t) { await interaction.editReply({ content: "❌ Chave não encontrada." }); return; }
        keys[t].hwid = getField("key_hwid").trim() || null; await saveKey(t);
        await interaction.editReply({ content: `✅ HWID de \`${t}\` definido!` }); return;
    }
    if (id === "modal_lookup") {
        const t = findKey(getField("key_name").trim());
        if (!t) { await interaction.editReply({ content: "❌ Chave não encontrada." }); return; }
        const d = keys[t];
        // ✅ NOVO: Adiciona histórico de compras no lookup
        const sales = await SaleHistory.find({ keyName: t });
        await interaction.editReply({ embeds: [new EmbedBuilder().setTitle(`🔍 Info: ${t}`).setColor(d.paused ? 0xFFA000 : 0x00C853)
            .addFields(
                { name: "⏱️ Tempo Restante", value: d.expiry === Infinity ? "Lifetime ♾️" : formatTime(d.expiry - Date.now()), inline: true },
                { name: "📌 Status",          value: d.paused ? "⏸️ Pausada" : "✅ Ativa",                                      inline: true },
                { name: "💻 HWID",            value: d.hwid ? `\`${d.hwid.substring(0, 12)}...\`` : "Livre",                   inline: false },
                { name: "👤 Discord",          value: d.discordId ? `<@${d.discordId}>` : "*(não vinculado)*",                  inline: true },
                { name: "🛒 Compra",          value: sales.length ? `${tsAbsolute(sales[0].confirmedAt)} (R$${sales[0].price})` : "*(sem registro)*", inline: true },
            ).setTimestamp()] });
        return;
    }
    if (id === "modal_unblock") {
        if (wrongPass(getField("key_pass"))) { await interaction.editReply({ content: "❌ Senha incorreta!" }); return; }
        const ip = getField("ip_address").trim();
        if (blockedIPs[ip]) { delete blockedIPs[ip]; await interaction.editReply({ content: `✅ IP \`${ip}\` desbloqueado.` }); }
        else await interaction.editReply({ content: "IP não estava bloqueado." });
        return;
    }
    if (id === "modal_cleanlogs") {
        if (wrongPass(getField("key_pass"))) { await interaction.editReply({ content: "❌ Senha incorreta!" }); return; }
        const count = brainrots.length; brainrots.length = 0;
        await interaction.editReply({ content: `🧹 **${count}** brainrots removidos da fila.` }); return;
    }
}

// ─── MODAL BUILDERS ───────────────────────────────────────────────────────────
const mkInput = (id, label, placeholder = "", required = true) =>
    new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId(id).setLabel(label)
            .setStyle(TextInputStyle.Short).setRequired(required)
            .setPlaceholder(placeholder)
    );

function buildModal_create()    { return new ModalBuilder().setCustomId("modal_create").setTitle("🔑 Criar Key").addComponents(mkInput("key_name","Nome da key"),mkInput("key_h","Horas","Ex: 24"),mkInput("key_m","Minutos","Ex: 0",false),mkInput("key_pass","Senha de admin")); }
function buildModal_lifetime()  { return new ModalBuilder().setCustomId("modal_lifetime").setTitle("♾️ Criar Key Lifetime").addComponents(mkInput("key_name","Nome da key"),mkInput("key_pass","Senha de admin")); }
function buildModal_revoke()    { return new ModalBuilder().setCustomId("modal_revoke").setTitle("🗑️ Revogar Key").addComponents(mkInput("key_name","Nome da key (ou 'all')"),mkInput("key_pass","Senha de admin")); }
function buildModal_pause()     { return new ModalBuilder().setCustomId("modal_pause").setTitle("⏸️ Pausar / Retomar Key").addComponents(mkInput("key_name","Nome da key (ou 'all')"),mkInput("key_pass","Senha de admin")); }
function buildModal_reset()     { return new ModalBuilder().setCustomId("modal_reset").setTitle("🔄 Resetar HWID").addComponents(mkInput("key_name","Nome da key (ou 'all')"),mkInput("key_pass","Senha de admin")); }
function buildModal_addtime()   { return new ModalBuilder().setCustomId("modal_addtime").setTitle("⏱️ Adicionar / Estender Tempo").addComponents(mkInput("key_name","Nome da key (ou 'all')"),mkInput("key_h","Horas","Ex: 12"),mkInput("key_m","Minutos","Ex: 30",false),mkInput("key_pass","Senha de admin")); }
function buildModal_setexpiry() { return new ModalBuilder().setCustomId("modal_setexpiry").setTitle("📅 Redefinir Expiração").addComponents(mkInput("key_name","Nome da key"),mkInput("key_h","Novo tempo — Horas"),mkInput("key_m","Novo tempo — Minutos","0",false),mkInput("key_pass","Senha de admin")); }
function buildModal_transfer()  { return new ModalBuilder().setCustomId("modal_transfer").setTitle("🔀 Transferir Key").addComponents(mkInput("key_old","Nome atual da key"),mkInput("key_new","Novo nome da key"),mkInput("key_pass","Senha de admin")); }
function buildModal_sethwid()   { return new ModalBuilder().setCustomId("modal_sethwid").setTitle("💻 Definir HWID").addComponents(mkInput("key_name","Nome da key"),mkInput("key_hwid","Novo HWID"),mkInput("key_pass","Senha de admin")); }
function buildModal_lookup()    { return new ModalBuilder().setCustomId("modal_lookup").setTitle("🔍 Lookup Key").addComponents(mkInput("key_name","Nome da key")); }
function buildModal_unblock()   { return new ModalBuilder().setCustomId("modal_unblock").setTitle("🔓 Desbloquear IP").addComponents(mkInput("ip_address","Endereço IP"),mkInput("key_pass","Senha de admin")); }
function buildModal_cleanlogs() { return new ModalBuilder().setCustomId("modal_cleanlogs").setTitle("🧹 Limpar Logs").addComponents(mkInput("key_pass","Senha de admin")); }

// ─── LOGS — COMANDOS DE TEXTO ─────────────────────────────────────────────────
clientLogs.on("messageCreate", async (message) => {
    if (message.author.bot) return;
    if (message.content === "!logspanel") { await sendLogsPanel(); return; }
    if (!message.content.startsWith("!")) return;

    const args = message.content.slice(1).trim().split(/ +/);
    const cmd  = args.shift().toLowerCase();

    switch (cmd) {
        case "online": {
            const sentMsg = await message.reply({ embeds: [buildOnlineEmbed()] });
            startOnlineInterval(message.channel.id, sentMsg);
            break;
        }
        case "stoponline":
            stopOnlineInterval(message.channel.id);
            message.reply("⏹️ Parado.");
            break;
        case "blocked": {
            const now    = Date.now();
            const active = Object.entries(blockedIPs).filter(([, u]) => now < u);
            message.reply(active.length ? "🔒 **IPs Bloqueados:**\n" + active.map(([ip, u]) => `• \`${ip}\` — ${Math.ceil((u - now) / 1000)}s`).join("\n") : "Nenhum IP bloqueado.");
            break;
        }
        case "unblock": {
            const [ip, pass] = args;
            if (wrongPass(pass)) { message.reply("❌ Senha incorreta!"); break; }
            if (blockedIPs[ip]) { delete blockedIPs[ip]; message.reply(`✅ IP \`${ip}\` desbloqueado.`); }
            else message.reply("IP não estava bloqueado.");
            break;
        }
        case "test": {
            const p = { id: Date.now().toString(), title: "TESTE", description: "OK!", brainrot: "TESTE", name: "TESTE", jobId: null, value: "999999999", players: "N/A" };
            pushBrainrot(p);
            message.reply("✅ Teste enviado!");
            break;
        }
        case "stats": {
            const all    = Object.values(keys);
            const active = all.filter(k => !k.paused && (k.expiry === Infinity || k.expiry - Date.now() > 0));
            const paused = all.filter(k => k.paused);
            const lt     = all.filter(k => k.expiry === Infinity);
            const online = Object.values(presence).filter(p => Date.now() - p.lastSeen < ONLINE_STALE_MS);
            const pendentes = await PendingPayment.countDocuments();
            message.reply({ embeds: [new EmbedBuilder().setTitle("📊 Estatísticas").setColor(0x5865F2)
                .addFields(
                    { name: "🔑 Total",         value: String(all.length),       inline: true },
                    { name: "✅ Ativas",         value: String(active.length),    inline: true },
                    { name: "⏸️ Pausadas",       value: String(paused.length),    inline: true },
                    { name: "♾️ Lifetime",       value: String(lt.length),        inline: true },
                    { name: "🟢 Online",         value: String(online.length),    inline: true },
                    { name: "📡 Fila",           value: String(brainrots.length), inline: true },
                    { name: "⏳ Pix Pendentes",  value: String(pendentes),        inline: true },
                ).setTimestamp()] });
            break;
        }
        // ✅ NOVO: comando !historico
        case "historico": {
            const sales = await SaleHistory.find().sort({ confirmedAt: -1 }).limit(10);
            if (!sales.length) { message.reply("Nenhuma venda registrada."); break; }
            const lines = sales.map(s => `• <@${s.discordId}> — **${s.label}** R$${s.price} — \`${s.keyName}\` — ${tsRelative(s.confirmedAt)}`).join("\n");
            message.reply({ embeds: [new EmbedBuilder().setTitle("📜 Últimas 10 Vendas").setColor(0x00ff88).setDescription(lines).setTimestamp()] });
            break;
        }
    }
});

// ─── BOT PANEL ────────────────────────────────────────────────────────────────
const clientPanel = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
    partials: [Partials.Channel, Partials.Message],
});

const awaitingInput = {};

function buildPanelEmbed() {
    return new EmbedBuilder().setTitle("Bob Auto Joiner").setColor(0x5865F2)
        .setDescription("This control panel is for the project: **Bob Joiner**\n\nIf you're a buyer, click on the buttons below to redeem your key, get the script or get your role")
        .addFields(
            { name: "🔑 Redeem Key",  value: "Place to validate your Key",                                   inline: false },
            { name: "📋 View Script", value: "Shows the **Bob Joiner** Script (Key Required)",               inline: false },
            { name: "📊 Key Info",    value: "Shows your Key Status (Key Required)",                         inline: false },
            { name: "⚙️ Reset HWID",  value: "Reset the Hardware Identification of your Key (Key Required)", inline: false },
        );
}

function buildPanelRows() {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("panel_redeem").setLabel("Redeem Key").setEmoji("🔑").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("panel_script").setLabel("Get Script").setEmoji("📋").setStyle(ButtonStyle.Primary),
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("panel_role").setLabel("Get Role").setEmoji("👤").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("panel_hwid").setLabel("Reset HWID").setEmoji("⚙️").setStyle(ButtonStyle.Secondary),
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("panel_stats").setLabel("Get Stats").setEmoji("📊").setStyle(ButtonStyle.Secondary),
        ),
    ];
}

clientPanel.on("ready", async () => {
    console.log(`[PANEL] Online: ${clientPanel.user.tag}`);
    if (!PANEL_CHANNEL_ID) return;
    try {
        const ch = await clientPanel.channels.fetch(PANEL_CHANNEL_ID);
        if (!ch) return;
        const msgs = await ch.messages.fetch({ limit: 10 });
        for (const [, msg] of msgs) { if (msg.author.id === clientPanel.user.id) await msg.delete().catch(() => {}); }
        await ch.send({ embeds: [buildPanelEmbed()], components: buildPanelRows() });
    } catch (e) { console.error("[PANEL] Erro ao enviar painel:", e.message); }
});

clientPanel.on("messageCreate", async (message) => {
    if (message.author.bot) return;
    if (message.channel.type === ChannelType.DM) {
        const state = awaitingInput[message.author.id];
        if (!state) return;
        const key     = message.content.trim();
        const keyName = findKey(key);
        if (!keyName) return message.reply("❌ Key não encontrada!");
        const d = keys[keyName];
        if (d.paused) return message.reply("⏸️ Sua key está pausada.");
        if (d.expiry !== Infinity && d.expiry - Date.now() <= 0) return message.reply("⌛ Sua key expirou!");
        const { step } = state;
        delete awaitingInput[message.author.id];
        if (step === "redeem_key") {
            return message.reply(`✅ Key válida! Tempo restante: **${d.expiry === Infinity ? "Lifetime ♾️" : formatTime(d.expiry - Date.now())}**`);
        }
        if (step === "script_key") {
            return message.reply("📋 **Bob Joiner Script**\n\n" + (SCRIPT_URL ? `\`\`\`\nloadstring(game:HttpGet('${SCRIPT_URL}'))()\n\`\`\`` : "❌ Script URL não configurada."));
        }
        if (step === "role_key") {
            if (d.discordId && d.discordId !== message.author.id) return message.reply("❌ Essa key já está vinculada a outro Discord!");
            d.discordId = message.author.id; await saveKey(keyName);
            const ROLE_ID = process.env.BUYER_ROLE_ID;
            if (ROLE_ID && state.guildId) {
                try {
                    const guild  = await clientPanel.guilds.fetch(state.guildId);
                    const member = await guild.members.fetch(message.author.id);
                    await member.roles.add(ROLE_ID);
                    return message.reply("✅ Discord vinculado e cargo adicionado!");
                } catch {}
            }
            return message.reply(`✅ Discord vinculado à key \`${keyName}\`!`);
        }
        if (step === "hwid_key") {
            keys[keyName].hwid = null; kicked[keyName.toLowerCase()] = Date.now(); await saveKey(keyName);
            return message.reply("✅ HWID resetado!");
        }
        if (step === "stats_key") {
            return message.reply({ embeds: [new EmbedBuilder().setTitle("📊 Key Info").setColor(0x5865F2).addFields(
                { name: "🔑 Key",    value: `\`${keyName}\``,                                                          inline: true },
                { name: "⏱️ Tempo", value: d.expiry === Infinity ? "Lifetime ♾️" : formatTime(d.expiry - Date.now()), inline: true },
                { name: "📌 Status", value: d.paused ? "⏸️ Pausada" : "✅ Ativa",                                      inline: true },
                { name: "💻 HWID",  value: d.hwid ? `\`${d.hwid.substring(0, 8)}...\`` : "Livre",                    inline: false },
            )] });
        }
        return;
    }
    if (message.content === "!panel") {
        try { await message.channel.send({ embeds: [buildPanelEmbed()], components: buildPanelRows() }); message.reply("✅ Painel enviado!"); }
        catch (e) { message.reply("❌ Erro: " + e.message); }
    }
});

clientPanel.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;
    const user = interaction.user;
    await interaction.deferReply({ flags: 64 });
    const steps = { panel_redeem: "redeem_key", panel_script: "script_key", panel_role: "role_key", panel_hwid: "hwid_key", panel_stats: "stats_key" };
    const msgs  = {
        panel_redeem: "🔑 **Redeem Key**\nEnvie sua key aqui para validar:",
        panel_script: "📋 **Get Script**\nEnvie sua key para receber o script:",
        panel_role:   "👤 **Get Role**\nEnvie sua key para vincular seu Discord e receber o cargo:",
        panel_hwid:   "⚙️ **Reset HWID**\nEnvie sua key:",
        panel_stats:  "📊 **Key Info**\nEnvie sua key:",
    };
    const step = steps[interaction.customId];
    if (step) {
        awaitingInput[user.id] = { step, guildId: interaction.guildId };
        try { await user.send(msgs[interaction.customId]); await interaction.editReply({ content: "📩 Te mandei uma DM!" }); }
        catch { await interaction.editReply({ content: "❌ Habilite mensagens privadas do servidor!" }); }
    }
});

// ─── BOT PAGAMENTO ────────────────────────────────────────────────────────────
const clientPayment = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
    partials: [Partials.Channel, Partials.Message],
});

function buildShopEmbed() {
    const planList = PLANS.map(p => `${p.emoji} **${p.label}** — R$${p.price},00`).join("\n");
    return new EmbedBuilder().setColor(0x00ff88).setTitle("🛒 Bob Keys — Loja")
        .setDescription(
            `Escolha seu plano abaixo:\n\n${planList}\n\n` +
            `> ⏱️ Após escolher, você terá **15 minutos** para efetuar o pagamento.\n` +
            `> Após pagar, mande o comprovante aqui e um admin confirma sua key!\n` +
            `> ⚠️ Pedidos sem pagamento são cancelados automaticamente.`
        )
        .setFooter({ text: "Bob Keys • Sistema de Keys Automático" }).setTimestamp();
}

function buildShopRows() {
    const row = new ActionRowBuilder();
    PLANS.forEach(p => row.addComponents(new ButtonBuilder().setCustomId(`buy_${p.value}`).setLabel(`${p.emoji} ${p.label} — R$${p.price}`).setStyle(ButtonStyle.Success)));
    row.addComponents(new ButtonBuilder().setCustomId("buy_minhakey").setLabel("🔑 Minha Key").setStyle(ButtonStyle.Secondary));
    return [row];
}

clientPayment.on("ready", async () => {
    console.log(`[PAYMENT] Online: ${clientPayment.user.tag}`);
    if (!BUY_CHANNEL) return;
    try {
        const ch = await clientPayment.channels.fetch(BUY_CHANNEL);
        if (!ch) return;
        const msgs = await ch.messages.fetch({ limit: 10 });
        for (const [, msg] of msgs) { if (msg.author.id === clientPayment.user.id) await msg.delete().catch(() => {}); }
        await ch.send({ embeds: [buildShopEmbed()], components: buildShopRows() });
        console.log("[PAYMENT] Loja enviada!");
    } catch (e) { console.error("[PAYMENT] Erro ao enviar loja:", e.message); }
});

clientPayment.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;
    const id   = interaction.customId;
    const user = interaction.user;

    // ✅ CORREÇÃO: deferReply imediato evita timeout de 3s do Discord
    await interaction.deferReply({ flags: 64 });

    if (id.startsWith("buy_") && id !== "buy_minhakey") {
        const plan = PLANS.find(p => p.value === id.replace("buy_", ""));
        if (!plan) return interaction.editReply({ content: "❌ Plano inválido!" });

        // Verifica se já tem pedido pendente ativo
        const existing = await PendingPayment.findOne({ discordId: user.id });
        const now      = Date.now();
        if (existing) {
            const age       = now - new Date(existing.createdAt).getTime();
            const remaining = PENDING_EXPIRY_MS - age;
            if (remaining > 0) {
                return interaction.editReply({ embeds: [new EmbedBuilder()
                    .setColor(0xFFA500)
                    .setTitle("⚠️ Você já tem um pedido pendente!")
                    .setDescription(
                        `Você já tem um pedido de **${existing.label}** aguardando pagamento.\n\n` +
                        `⏳ Esse pedido expira em **${formatTimeShort(remaining)}**.\n\n` +
                        `Efetue o pagamento ou aguarde o cancelamento automático para fazer um novo pedido.`
                    )
                    .setFooter({ text: "Bob Keys" })
                ]});
            }
        }

        await PendingPayment.findOneAndUpdate(
            { discordId: user.id },
            { discordId: user.id, discordTag: user.tag, hours: plan.hours, price: plan.price, label: plan.label, warningSent: false, createdAt: new Date() },
            { upsert: true, new: true }
        );

        // Avisa o usuário via DM sobre o prazo de 15 minutos (não bloqueia a resposta)
        user.send({ embeds: [new EmbedBuilder()
            .setColor(0xFFA500)
            .setTitle("⏳ Lembrete: Você tem 15 minutos para pagar!")
            .setDescription(
                `Seu pedido de **${plan.label}** (R$${plan.price}) foi registrado.\n\n` +
                `Envie o comprovante no canal de compras em até **15 minutos** ou o pedido será cancelado automaticamente.`
            )
            .setFooter({ text: "Bob Keys • Aviso automático" })
            .setTimestamp()
        ]}).catch(() => {});

        return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x00ccff).setTitle("💳 Dados para Pagamento Pix")
            .setDescription(
                `**Plano:** ${plan.emoji} ${plan.label}\n**Valor:** R$${plan.price},00\n\n` +
                `**🔑 Chave Pix:**\n\`\`\`${PIX_KEY}\`\`\`\n**Nome:** ${PIX_NAME}\n\n` +
                `> ✅ Após pagar, mande o **comprovante** aqui no canal!\n` +
                `> ⚠️ Você tem **15 minutos** para efetuar o pagamento.\n` +
                `> Um admin confirma e a key chega no seu privado.`
            )
            .setFooter({ text: `Pedido registrado • ${user.tag}` }).setTimestamp()] });
    }

    if (id === "buy_minhakey") {
        const userKeys = Object.entries(keys).filter(([, d]) => d.discordId === user.id);
        if (!userKeys.length) return interaction.editReply({ content: "❌ Nenhuma key ativa! Use a loja para comprar." });
        const now  = Date.now();
        const list = userKeys.map(([k, d]) => {
            const rem = d.expiry === Infinity ? "Lifetime ♾️" : (d.expiry - now > 0 ? formatTime(d.expiry - now) : "❌ Expirada");
            return `\`${k}\` — ⏳ ${rem}`;
        }).join("\n");
        return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x00ff88).setTitle("🔑 Suas Keys").setDescription(list).setFooter({ text: user.tag })] });
    }
});

clientPayment.on("messageCreate", async (msg) => {
    if (msg.author.bot) return;
    if (msg.content === "!loja" && msg.channel.id === BUY_CHANNEL) {
        await msg.channel.send({ embeds: [buildShopEmbed()], components: buildShopRows() });
        if (msg.deletable) msg.delete().catch(() => {});
    }
});

// ─── ENDPOINTS ────────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({ status: "ok", time: Date.now() }));
app.get("/",       (_, res) => res.send("<h1>Bob API — Online ✅</h1>"));

app.get("/validate", requireClientHeader, (req, res) => {
    const { key, secret, hwid } = req.query;
    const r = checkKey(key, secret, hwid);
    if (!r.ok) return res.status(403).json({ status: "error", message: r.error });
    const timeLeft = r.data.expiry === Infinity ? LIFETIME_VALUE : r.data.expiry - Date.now();
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

app.post("/api/notify", requireClientHeader, (req, res) => {
    const { secret, name, jobId, value, description } = req.body;
    if (!secret || secret !== SCRIPT_SECRET) return res.status(403).json({ status: "error", message: "Secret inválido." });
    const payload = {
        id: Date.now().toString(),
        title: name || "Brainrot",
        description: description || name || "Novo Brainrot!",
        brainrot: name || "Brainrot",
        name: name || "Brainrot",
        jobId: xorObfuscate(jobId) || null,
        value: String(value || "0"),
        players: "N/A",
    };
    pushBrainrot(payload);
    res.json({ status: "ok", id: payload.id });
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
    presence[sessionId] = { name: name || "Unknown", lastSeen: Date.now(), key: (key || "").trim() };
    if (jobId && name) userJobIds[name] = jobId;
    if (discordId && r.keyName) {
        const d       = keys[r.keyName];
        const cleanId = String(discordId).replace(/\D/g, "");
        if (cleanId.length >= 17 && cleanId.length <= 20 && !d.discordId) { d.discordId = cleanId; await saveKey(r.keyName); }
    }
    res.json({ status: "ok" });
});

app.get("/presence", requireClientHeader, (req, res) => {
    const { key, secret, hwid } = req.query;
    const r = checkKey(key, secret, hwid);
    if (!r.ok) return res.status(403).json({ status: "error", message: r.error });
    const now    = Date.now();
    const active = {};
    for (const [sid, info] of Object.entries(presence)) {
        if (now - info.lastSeen < ONLINE_STALE_MS) active[info.name] = true;
        else delete presence[sid];
    }
    res.json(Object.keys(active).sort());
});

app.get("/clients", requireClientHeader, (req, res) => {
    if (req.query.secret !== SCRIPT_SECRET) return res.status(403).json({ status: "error", message: "Secret inválido." });
    res.send(`Socket.IO: ${io.sockets.sockets.size} | Presença: ${Object.keys(presence).length}`);
});

app.get("/test-emit", requireClientHeader, (req, res) => {
    if (req.query.secret !== SCRIPT_SECRET) return res.status(403).send("Secret invalido");
    const p = { id: Date.now().toString(), title: "TESTE MANUAL", description: "OK!", brainrot: "TESTE", name: "TESTE", jobId: null, value: "0" };
    pushBrainrot(p);
    res.send("✅ Emit enviado!");
});

app.post("/push-brainrot", requireClientHeader, (req, res) => {
    const { secret, title, description, jobId, value, players } = req.body;
    if (secret !== SCRIPT_SECRET) return res.status(403).json({ status: "error", message: "Secret inválido" });
    const payload = {
        id: Date.now().toString(),
        title: title || "Brainrot",
        description: description || "",
        brainrot: title || "Brainrot",
        name: title || "Brainrot",
        jobId: xorObfuscate(jobId) || null,
        value: value || "0",
        players: players || "N/A",
    };
    pushBrainrot(payload);
    res.json({ status: "ok", id: payload.id });
});

app.post("/link-discord", requireClientHeader, async (req, res) => {
    const { key, secret, hwid, discordId } = req.query;
    const r = checkKey(key, secret, hwid);
    if (!r.ok) return res.status(403).json({ status: "error", message: r.error });
    const cleanId = String(discordId || "").replace(/\D/g, "");
    if (cleanId.length < 17 || cleanId.length > 20) return res.status(400).json({ status: "error", message: "Discord ID invalido." });
    const d = keys[r.keyName];
    if (d.discordId && d.discordId !== cleanId) return res.status(409).json({ status: "error", message: "Key ja vinculada a outro Discord ID." });
    d.discordId = cleanId; await saveKey(r.keyName);
    res.json({ status: "ok", message: "Discord vinculado!" });
});

app.post("/report-jobid", requireClientHeader, (req, res) => {
    const { key, secret, name, jobId } = req.query;
    if (secret !== SCRIPT_SECRET) return res.status(403).json({ status: "error", message: "Secret inválido" });
    const keyName = findKey(key);
    if (!keyName) return res.status(403).json({ status: "error", message: "Key inválida" });
    if (name && jobId) userJobIds[name] = jobId;
    res.json({ status: "ok" });
});

// ─── HANDLER DE ERROS GLOBAL ──────────────────────────────────────────────────
app.use((err, req, res, next) => {
    console.error("[EXPRESS] Erro não tratado:", err.message);
    res.status(500).json({ status: "error", message: "Erro interno do servidor." });
});

process.on("unhandledRejection", (reason) => { console.error("[PROCESS] Rejeição não tratada:", reason); });
process.on("uncaughtException",  (err)    => { console.error("[PROCESS] Exceção não capturada:", err.message, err.stack); });

// ─── LOGIN ────────────────────────────────────────────────────────────────────
async function loginBot(client, token, label) {
    if (!token) { console.warn(`[${label}] Token ausente — bot não iniciado.`); return; }
    try { await client.login(token); console.log(`[${label}] Login OK`); }
    catch (e) { console.error(`[${label}] Erro no login:`, e.message); }
}

loginBot(clientNotifier, DISCORD_TOKEN_NOTIFIER, "NOTIFIER");
loginBot(clientLogs,     DISCORD_TOKEN_LOGS,     "LOGS");
loginBot(clientPanel,    DISCORD_TOKEN_PANEL,    "PANEL");
loginBot(clientPayment,  DISCORD_TOKEN_PAYMENT,  "PAYMENT");

loadKeys();

server.listen(port, () => console.log(`[SERVER] Porta ${port} — Bob API online ✅`));