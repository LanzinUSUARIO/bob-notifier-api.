const express  = require("express");
const http     = require("http");
const crypto   = require("crypto");
const path     = require("path");
const { Server } = require("socket.io");
const {
    Client, GatewayIntentBits,
    ActionRowBuilder, ButtonBuilder, ButtonStyle,
    EmbedBuilder, Events, ChannelType, Partials,
    ModalBuilder, TextInputBuilder, TextInputStyle,
} = require("discord.js");
const mongoose = require("mongoose");

// ─── CONSTANTES ───────────────────────────────────────────────────────────────
const LIFETIME_VALUE     = 9_999_999_999_999;
const BRAINROT_MAX       = 100;
const JOBID_MAX          = 500;
const PRESENCE_TTL       = 2  * 60 * 1_000;
const ONLINE_STALE_MS    = 30 * 1_000;
const RATE_LIMIT_MAX     = 60;
const RATE_LIMIT_WINDOW  = 60_000;
const BLOCK_DURATION     = 5  * 60 * 1_000;
const PENDING_EXPIRY_MS  = 15 * 60 * 1_000;   // pedido expira em 15 min
const KEY_WARN_BEFORE_MS = 30 * 60 * 1_000;   // avisa 30min antes da key expirar

// 🎨 Cores padrão do bot
const COLORS = {
    primary:  0x5865F2,
    success:  0x00E676,
    danger:   0xFF3C3C,
    warning:  0xFFA500,
    info:     0x00CCFF,
    gold:     0xFFD700,
    purple:   0x9B59B6,
    dark:     0x2F3136,
};

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
const ADMIN_ROLE_IDS         = [
    "1477885793144930496",
    "1501356382677373101",
    "1477885797553148066",
];

// ✅ PLANOS — agora carregados do banco (ou usa padrão)
const DEFAULT_PLANS = [
    { label: "1 Hora",  value: "1h",  price: 5,  hours: 1,  emoji: "🕐", active: true },
    { label: "2 Horas", value: "2h",  price: 10, hours: 2,  emoji: "⏱️", active: true },
    { label: "4 Horas", value: "4h",  price: 20, hours: 4,  emoji: "⚡", active: true },
    { label: "8 Horas", value: "8h",  price: 35, hours: 8,  emoji: "🔥", active: false },
    { label: "24 Horas",value: "24h", price: 80, hours: 24, emoji: "👑", active: false },
];
let PLANS = [...DEFAULT_PLANS];

// ─── MONGODB ──────────────────────────────────────────────────────────────────
mongoose.connect(MONGODB_URI)
    .then(() => { console.log("[DB] MongoDB conectado!"); loadPlansFromDB(); })
    .catch(e => { console.error("[DB] Erro fatal:", e.message); process.exit(1); });

const KeySchema = new mongoose.Schema({
    name:      { type: String, required: true, unique: true },
    expiry:    { type: Number, default: LIFETIME_VALUE },
    paused:    { type: Boolean, default: false },
    remaining: { type: Number, default: 0 },
    hwid:      { type: String, default: null },
    discordId: { type: String, default: null },
    warnSent:  { type: Boolean, default: false }, // ✅ aviso de expiração
});
const KeyModel = mongoose.model("Key", KeySchema);

const PendingPaymentSchema = new mongoose.Schema({
    discordId:    String,
    discordTag:   String,
    hours:        Number,
    price:        Number,
    finalPrice:   Number,   // ✅ preço após desconto
    label:        String,
    couponUsed:   String,   // ✅ cupom usado
    warningSent:  { type: Boolean, default: false },
    createdAt:    { type: Date, default: Date.now },
});
const PendingPayment = mongoose.model("PendingPayment", PendingPaymentSchema);

const SaleHistorySchema = new mongoose.Schema({
    discordId:   String,
    discordTag:  String,
    hours:       Number,
    price:       Number,
    label:       String,
    keyName:     String,
    couponUsed:  String,
    confirmedBy: { type: String, default: "auto" },
    confirmedAt: { type: Date, default: Date.now },
});
const SaleHistory = mongoose.model("SaleHistory", SaleHistorySchema);

// ✅ Schema de cupons de desconto
const CouponSchema = new mongoose.Schema({
    code:       { type: String, required: true, unique: true },
    discount:   { type: Number, required: true },   // percentual ex: 20 = 20%
    type:       { type: String, default: "percent" }, // "percent" ou "fixed"
    maxUses:    { type: Number, default: 1 },
    usedCount:  { type: Number, default: 0 },
    active:     { type: Boolean, default: true },
    expiresAt:  { type: Date, default: null },
    usedBy:     [String],
    createdAt:  { type: Date, default: Date.now },
});
const Coupon = mongoose.model("Coupon", CouponSchema);

// ✅ Schema de planos personalizáveis
const PlanSchema = new mongoose.Schema({
    label:  String,
    value:  { type: String, unique: true },
    price:  Number,
    hours:  Number,
    emoji:  String,
    active: { type: Boolean, default: true },
});
const PlanModel = mongoose.model("Plan", PlanSchema);

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
    const d = Math.floor(t / 86400);
    const h = Math.floor((t % 86400) / 3600);
    const m = Math.floor((t % 3600) / 60);
    const parts = [];
    if (d > 0) parts.push(d + "d");
    if (h > 0) parts.push(h + "h");
    parts.push(m + "m");
    return parts.join(" ");
};

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
        try { const u = await client.users.fetch(userId); if (u) return u; } catch {}
    }
    return null;
}

// ✅ Aplica cupom e retorna preço final
async function applyCoupon(code, userId, originalPrice) {
    if (!code) return { ok: false, finalPrice: originalPrice, msg: null };
    const coupon = await Coupon.findOne({ code: code.toUpperCase(), active: true });
    if (!coupon) return { ok: false, finalPrice: originalPrice, msg: "❌ Cupom inválido ou expirado." };
    if (coupon.expiresAt && new Date() > coupon.expiresAt) return { ok: false, finalPrice: originalPrice, msg: "❌ Cupom expirado." };
    if (coupon.usedCount >= coupon.maxUses) return { ok: false, finalPrice: originalPrice, msg: "❌ Cupom esgotado." };
    if (coupon.usedBy.includes(userId)) return { ok: false, finalPrice: originalPrice, msg: "❌ Você já usou este cupom." };
    let finalPrice = originalPrice;
    if (coupon.type === "percent") finalPrice = Math.max(0, originalPrice - (originalPrice * coupon.discount / 100));
    else finalPrice = Math.max(0, originalPrice - coupon.discount);
    finalPrice = Math.round(finalPrice * 100) / 100;
    return { ok: true, finalPrice, discount: coupon.discount, type: coupon.type, coupon, msg: null };
}

async function consumeCoupon(code, userId) {
    await Coupon.updateOne({ code: code.toUpperCase() }, { $inc: { usedCount: 1 }, $push: { usedBy: userId } });
}

// ─── LOAD PLANS FROM DB ───────────────────────────────────────────────────────
async function loadPlansFromDB() {
    try {
        const dbPlans = await PlanModel.find({});
        if (dbPlans.length > 0) {
            PLANS = dbPlans.map(p => ({ label: p.label, value: p.value, price: p.price, hours: p.hours, emoji: p.emoji, active: p.active }));
            console.log(`[DB] ${PLANS.length} planos carregados do banco.`);
        } else {
            // Salva planos padrão no banco na primeira execução
            for (const p of DEFAULT_PLANS) {
                await PlanModel.findOneAndUpdate({ value: p.value }, p, { upsert: true });
            }
            console.log("[DB] Planos padrão salvos no banco.");
        }
    } catch (e) { console.error("[DB] Erro ao carregar planos:", e.message); }
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
            keys[d.name] = { expiry, paused: d.paused, remaining, hwid: d.hwid || null, discordId: d.discordId || null, warnSent: d.warnSent || false };
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
    for (const [name, data] of Object.entries(keys)) {
        if (data.expiry !== Infinity && !data.paused && data.expiry - now <= 0) {
            // Notifica o usuário que a key expirou
            if (data.discordId) {
                fetchUserFromAnyClient(data.discordId).then(user => {
                    if (user) user.send({ embeds: [
                        new EmbedBuilder()
                            .setColor(COLORS.danger)
                            .setTitle("⌛ Sua key expirou!")
                            .setDescription(`Sua key \`${name}\` expirou.\n\nAcesse a loja para renovar e continuar usando o **Bob Joiner**!`)
                            .setFooter({ text: "Bob Keys • Renovação disponível na loja" })
                            .setTimestamp()
                    ]}).catch(() => {});
                });
            }
            delete keys[name];
            await deleteKey(name);
            console.log(`[CLEANUP] Key expirada removida: ${name}`);
        }
    }
    for (const [sid, info] of Object.entries(presence)) {
        if (now - info.lastSeen > PRESENCE_TTL) delete presence[sid];
    }
    const jobKeys = Object.keys(userJobIds);
    if (jobKeys.length > JOBID_MAX)
        jobKeys.slice(0, jobKeys.length - JOBID_MAX).forEach(k => delete userJobIds[k]);
}, 60_000);

// ✅ Aviso de expiração de key em breve (30min antes)
setInterval(async () => {
    const now = Date.now();
    for (const [name, data] of Object.entries(keys)) {
        if (data.expiry === Infinity || data.paused || data.warnSent) continue;
        const remaining = data.expiry - now;
        if (remaining > 0 && remaining <= KEY_WARN_BEFORE_MS) {
            data.warnSent = true;
            await saveKey(name);
            if (data.discordId) {
                fetchUserFromAnyClient(data.discordId).then(user => {
                    if (user) user.send({ embeds: [
                        new EmbedBuilder()
                            .setColor(COLORS.warning)
                            .setTitle("⚠️ Sua key vai expirar em breve!")
                            .setDescription(
                                `Sua key \`${name}\` expira **${tsRelative(data.expiry)}** (${formatTime(remaining)}).\n\n` +
                                `Acesse a loja agora para renovar e não perder o acesso!`
                            )
                            .setFooter({ text: "Bob Keys • Aviso automático" })
                            .setTimestamp()
                    ]}).catch(() => {});
                });
            }
        }
    }
}, 5 * 60_000); // roda a cada 5 min

// ✅ Cleanup de pedidos pendentes expirados
setInterval(async () => {
    const now    = Date.now();
    const cutoff = new Date(now - PENDING_EXPIRY_MS);
    try {
        const expired = await PendingPayment.find({ createdAt: { $lt: cutoff } });
        for (const p of expired) {
            fetchUserFromAnyClient(p.discordId).then(user => {
                if (user) user.send({ embeds: [
                    new EmbedBuilder()
                        .setColor(COLORS.danger)
                        .setTitle("❌ Pedido Cancelado por Inatividade")
                        .setDescription(
                            `Seu pedido de **${p.label}** (R$${p.finalPrice || p.price}) foi cancelado após **15 minutos** sem pagamento.\n\n` +
                            `Acesse a loja novamente para fazer um novo pedido.`
                        )
                        .setFooter({ text: "Bob Keys • Pedido cancelado automaticamente" })
                        .setTimestamp()
                ]}).catch(() => {});
            });
            await PendingPayment.deleteOne({ _id: p._id });
            console.log(`[PENDING CLEANUP] Pedido expirado: ${p.discordTag}`);
            if (LOGS_CHANNEL_ID) {
                clientLogs.channels.fetch(LOGS_CHANNEL_ID).then(ch => {
                    if (ch) ch.send({ embeds: [new EmbedBuilder()
                        .setColor(COLORS.danger)
                        .setTitle("🗑️ Pedido Cancelado por Inatividade")
                        .setDescription(`**Usuário:** <@${p.discordId}> (${p.discordTag})\n**Plano:** ${p.label}\n**Valor:** R$${p.price}\n**Criado:** ${tsAbsolute(p.createdAt)}`)
                        .setTimestamp()
                    ]}).catch(() => {});
                }).catch(() => {});
            }
        }
        // Aviso de 1min antes de expirar
        const toWarn = await PendingPayment.find({ warningSent: false, createdAt: { $lt: new Date(now - (PENDING_EXPIRY_MS - 60_000)) } });
        for (const p of toWarn) {
            fetchUserFromAnyClient(p.discordId).then(user => {
                if (user) user.send({ embeds: [
                    new EmbedBuilder()
                        .setColor(COLORS.warning)
                        .setTitle("⚠️ Seu pedido expira em 1 minuto!")
                        .setDescription(`Seu pedido de **${p.label}** será cancelado em breve!\nEnvie o comprovante **agora** no canal de compras.`)
                        .setTimestamp()
                ]}).catch(() => {});
            });
            await PendingPayment.updateOne({ _id: p._id }, { warningSent: true });
        }
    } catch (e) { console.error("[PENDING CLEANUP] Erro:", e.message); }
}, 60_000);

// ─── EXPRESS + SOCKET.IO ──────────────────────────────────────────────────────
const app    = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public"))); // ✅ painel web
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
    return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "unknown";
}

async function logSecurityAlert(message) {
    console.warn("[SECURITY ALERT]", message);
    if (!LOGS_CHANNEL_ID) return;
    try {
        const ch = await clientLogs.channels.fetch(LOGS_CHANNEL_ID);
        if (ch) await ch.send({ embeds: [new EmbedBuilder().setTitle("🚨 Alerta de Segurança").setColor(COLORS.danger).setDescription(message).setTimestamp()] });
    } catch {}
}

function rateLimitMiddleware(req, res, next) {
    const openRoutes = ["/health", "/", "/dashboard", "/api/dashboard"];
    if (openRoutes.some(r => req.path.startsWith(r))) return next();
    const ip = getRealIP(req); const now = Date.now();
    if (blockedIPs[ip]) {
        if (now < blockedIPs[ip]) return res.status(429).json({ status: "error", message: `IP bloqueado. Tente em ${Math.ceil((blockedIPs[ip] - now) / 1000)}s.` });
        delete blockedIPs[ip];
    }
    if (!rateLimitMap[ip] || now - rateLimitMap[ip].windowStart > RATE_LIMIT_WINDOW) { rateLimitMap[ip] = { count: 1, windowStart: now }; return next(); }
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
    if (!header || header !== CLIENT_HEADER) { logSecurityAlert(`⚠️ Acesso sem header de \`${ip}\` em \`${req.path}\``); return res.status(403).json({ status: "error", message: "Acesso negado." }); }
    if (BLOCKED_UA.some(b => ua.includes(b))) { blockedIPs[ip] = Date.now() + BLOCK_DURATION; logSecurityAlert(`🔴 Spy bloqueado de \`${ip}\``); return res.status(403).json({ status: "error", message: "Acesso negado." }); }
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
    const ip     = (socket.handshake.headers?.["x-forwarded-for"] || "").split(",")[0].trim() || socket.handshake.address || "unknown";
    if (!header || header !== CLIENT_HEADER) { logSecurityAlert(`⚠️ WS sem header de \`${ip}\``); return next(new Error("Acesso negado.")); }
    if (BLOCKED_UA.some(b => ua.includes(b))) { blockedIPs[ip] = Date.now() + BLOCK_DURATION; return next(new Error("Acesso negado.")); }
    const r = checkKey(key, secret, hwid);
    if (!r.ok) return next(new Error(r.error));
    socket.keyName = r.keyName;
    next();
});
io.on("connection", (socket) => { socket.on("disconnect", () => console.log(`[SOCKET] DC: ${socket.keyName}`)); });

// ─── KEY VALIDATION ───────────────────────────────────────────────────────────
function checkKey(key, secret, hwid) {
    if (secret !== SCRIPT_SECRET) return { ok: false, error: "Secret invalido" };
    const keyClean = (key || "").trim(), hwidClean = (hwid || "").trim() || null;
    const keyName  = findKey(keyClean), data = keys[keyName];
    if (!data)       return { ok: false, error: "Chave nao existe" };
    if (data.paused) return { ok: false, error: "Chave pausada" };
    if (data.expiry !== Infinity && data.expiry - Date.now() <= 0) { delete keys[keyName]; deleteKey(keyName); return { ok: false, error: "Chave expirada" }; }
    if (hwidClean) {
        if (!data.hwid) { data.hwid = hwidClean; saveKey(keyName); }
        else if (data.hwid !== hwidClean) return { ok: false, error: "HWID invalido" };
    }
    return { ok: true, data, keyName };
}

// ─── PAGAMENTO ────────────────────────────────────────────────────────────────
async function confirmarPagamento(user, hours, channel, confirmedBy = "admin", price = null, label = null, couponUsed = null) {
    const keyName   = generateBobKey();
    const expiresAt = Date.now() + hours * 3_600_000;

    // ✅ Renovação automática: se o usuário já tem key ativa, estende o tempo
    const existingKeyEntry = Object.entries(keys).find(([, d]) => d.discordId === String(user.id));
    let renewed = false;
    if (existingKeyEntry) {
        const [existingName, existingData] = existingKeyEntry;
        const addMs = hours * 3_600_000;
        if (existingData.paused) existingData.remaining += addMs;
        else if (existingData.expiry !== Infinity) existingData.expiry += addMs;
        existingData.warnSent = false; // reseta aviso
        await saveKey(existingName);
        renewed = true;
        console.log(`[PAYMENT] ✅ Key renovada para ${user.tag}: ${existingName} (+${hours}h)`);

        const plan = PLANS.find(p => p.hours === hours);
        price = price || plan?.price || hours * 5;
        label = label || plan?.label || `${hours}h`;

        await SaleHistory.create({ discordId: String(user.id), discordTag: user.tag, hours, price, label, keyName: existingName, couponUsed, confirmedBy: String(confirmedBy) }).catch(() => {});

        const renewEmbed = new EmbedBuilder()
            .setColor(COLORS.success)
            .setTitle("🔄 Key Renovada com Sucesso!")
            .setDescription(
                `Sua key foi **renovada** automaticamente!\n\n` +
                `**🔑 Key:** \`${existingName}\`\n` +
                `**Plano adicionado:** ${label}\n` +
                `**Nova expiração:** ${tsRelative(existingData.expiry)}\n\n` +
                `> ✅ Não precisa trocar nada — a mesma key continua funcionando!`
            )
            .setFooter({ text: "Bob Keys • Obrigado pela renovação! 🚀" })
            .setTimestamp();

        let dmOk = false;
        try { await user.send({ embeds: [renewEmbed] }); dmOk = true; } catch {}
        if (!dmOk && channel) channel.send(`⚠️ <@${user.id}> — Ativa DMs! Key renovada: \`${existingName}\``).catch(() => {});
        if (channel) channel.send({ embeds: [new EmbedBuilder().setColor(COLORS.success).setTitle("🔄 Renovação Confirmada")
            .setDescription(`**Usuário:** <@${user.id}>\n**Key:** \`${existingName}\`\n**+Tempo:** ${label}\n**Confirmado por:** ${confirmedBy === "auto" ? "🤖 Auto" : `<@${confirmedBy}>`}\n**DM:** ${dmOk ? "✅" : "❌"}`)
            .setTimestamp()] }).catch(() => {});
        return;
    }

    // Key nova
    const plan = PLANS.find(p => p.hours === hours);
    price = price || plan?.price || hours * 5;
    label = label || plan?.label || `${hours}h`;

    keys[keyName] = { expiry: expiresAt, paused: false, remaining: hours * 3_600_000, hwid: null, discordId: String(user.id), warnSent: false };
    await saveKey(keyName);
    await SaleHistory.create({ discordId: String(user.id), discordTag: user.tag, hours, price, label, keyName, couponUsed, confirmedBy: String(confirmedBy) }).catch(() => {});

    const dmEmbed = new EmbedBuilder()
        .setColor(COLORS.success)
        .setTitle("🎉 Pagamento Confirmado!")
        .setDescription(
            `Obrigado pela compra! Sua key foi gerada.\n\n` +
            `**🔑 Sua Key:**\n\`\`\`${keyName}\`\`\`\n` +
            `**Plano:** ${label}\n` +
            `**Expira:** ${tsRelative(expiresAt)}\n` +
            (couponUsed ? `**Cupom usado:** \`${couponUsed}\`\n` : ``) +
            `\n> Use essa key no painel para ativar o Bob Joiner!`
        )
        .setFooter({ text: "Bob Keys • Obrigado pela compra! 🚀" })
        .setTimestamp();

    let dmOk = false;
    try { await user.send({ embeds: [dmEmbed] }); dmOk = true; } catch {}
    if (!dmOk && channel) channel.send(`⚠️ <@${user.id}> — Ativa DMs! Key: \`${keyName}\``).catch(() => {});
    if (channel) channel.send({ embeds: [new EmbedBuilder().setColor(COLORS.success).setTitle("✅ Key Gerada")
        .setDescription(`**Usuário:** <@${user.id}> (${user.tag})\n**Plano:** ${label}\n**Key:** \`${keyName}\`\n**Expira:** ${tsRelative(expiresAt)}\n**Confirmado por:** ${confirmedBy === "auto" ? "🤖 Auto" : `<@${confirmedBy}>`}\n**DM:** ${dmOk ? "✅" : "❌"}`)
        .setTimestamp()] }).catch(() => {});

    console.log(`[PAYMENT] ✅ Key gerada para ${user.tag}: ${keyName} (${hours}h)`);
}

// ─── KEY OPERATIONS ───────────────────────────────────────────────────────────
async function opCreateKey(name, durationMs, discordId = null) {
    if (findKey(name)) return { ok: false, msg: `❌ Chave \`${name}\` já existe!` };
    if (durationMs <= 0) return { ok: false, msg: "❌ Duração inválida!" };
    keys[name] = { expiry: Date.now() + durationMs, paused: false, remaining: durationMs, hwid: null, discordId, warnSent: false };
    await saveKey(name);
    return { ok: true, msg: `✅ Chave \`${name}\` criada! Duração: **${formatTime(durationMs)}**` };
}
async function opCreateLifetime(name) {
    if (findKey(name)) return { ok: false, msg: `❌ Chave \`${name}\` já existe!` };
    keys[name] = { expiry: Infinity, paused: false, remaining: Infinity, hwid: null, discordId: null, warnSent: false };
    await saveKey(name);
    return { ok: true, msg: `✅ Chave \`${name}\` criada como **Lifetime ♾️**!` };
}
async function opRevokeKey(name) {
    if (name.toLowerCase() === "all") {
        const count = Object.keys(keys).length;
        for (const k of Object.keys(keys)) { delete keys[k]; await deleteKey(k); }
        return { ok: true, msg: `🗑️ **${count} chaves** removidas.` };
    }
    const t = findKey(name); if (!t) return { ok: false, msg: "❌ Chave não encontrada." };
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
    const t = findKey(name); if (!t) return { ok: false, msg: "❌ Chave não encontrada." };
    const d = keys[t];
    if (d.paused) { d.expiry = Date.now() + d.remaining; d.paused = false; await saveKey(t); return { ok: true, msg: `▶️ \`${t}\` retomada!` }; }
    d.remaining = d.expiry === Infinity ? Infinity : d.expiry - Date.now(); d.paused = true; await saveKey(t);
    return { ok: true, msg: `⏸️ \`${t}\` pausada!` };
}
async function opResetHwid(name) {
    if (name.toLowerCase() === "all") {
        let count = 0;
        for (const k of Object.keys(keys)) { keys[k].hwid = null; kicked[k.toLowerCase()] = Date.now(); await saveKey(k); count++; }
        return { ok: true, msg: `✅ HWID de **${count} chaves** resetado!` };
    }
    const t = findKey(name); if (!t) return { ok: false, msg: "❌ Chave não encontrada." };
    keys[t].hwid = null; kicked[t.toLowerCase()] = Date.now(); await saveKey(t);
    return { ok: true, msg: `✅ HWID de \`${t}\` resetado!` };
}
async function opAddTime(name, extraMs) {
    if (extraMs <= 0) return { ok: false, msg: "❌ Tempo inválido!" };
    if (name.toLowerCase() === "all") {
        let count = 0;
        for (const k of Object.keys(keys)) {
            const d = keys[k];
            if (d.paused) d.remaining += extraMs; else if (d.expiry !== Infinity) d.expiry += extraMs;
            d.warnSent = false; await saveKey(k); count++;
        }
        return { ok: true, msg: `✅ **${formatTime(extraMs)}** adicionado a **${count} chaves**!` };
    }
    const t = findKey(name); if (!t) return { ok: false, msg: "❌ Chave não encontrada." };
    const d = keys[t];
    if (d.paused) d.remaining += extraMs; else if (d.expiry !== Infinity) d.expiry += extraMs;
    d.warnSent = false; await saveKey(t);
    return { ok: true, msg: `✅ **${formatTime(extraMs)}** adicionado a \`${t}\`!` };
}
async function opSetExpiry(name, durationMs) {
    if (durationMs <= 0) return { ok: false, msg: "❌ Duração inválida!" };
    const t = findKey(name); if (!t) return { ok: false, msg: "❌ Chave não encontrada." };
    const d = keys[t];
    if (d.paused) d.remaining = durationMs; else { d.expiry = Date.now() + durationMs; d.remaining = durationMs; }
    d.warnSent = false; await saveKey(t);
    return { ok: true, msg: `✅ Expiração de \`${t}\` redefinida para **${formatTime(durationMs)}**!` };
}

// ─── BOT NOTIFIER ─────────────────────────────────────────────────────────────
const clientNotifier = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildWebhooks] });
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
    pushBrainrot({ id: Date.now().toString(), title: embed.title || "Bob!", description: embed.description || "Novo Alerta!", brainrot: embed.title || "Brainrot", name: embed.title || "Brainrot", jobId: xorObfuscate(jobId), value, players });
});

// ─── BOT LOGS ─────────────────────────────────────────────────────────────────
const clientLogs = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
clientLogs.on("ready", async () => { console.log(`[LOGS] Online: ${clientLogs.user.tag}`); await sendLogsPanel(); });

function buildLogsEmbed() {
    return new EmbedBuilder()
        .setTitle("⚙️ Bob Joiner — Painel Administrativo")
        .setColor(COLORS.primary)
        .setDescription(
            "```\n╔══════════════════════════════╗\n║     BOB JOINER  ADMIN PANEL    ║\n╚══════════════════════════════╝\n```\n" +
            "Gerencie keys, pagamentos, cupons e planos do sistema.\n\n" +
            "🔑 **Keys** — criar, revogar, pausar, resetar HWID\n" +
            "⏱️ **Tempo** — addtime, set expiração\n" +
            "📊 **Info** — online, stats, lookup, jobids\n" +
            "💳 **Pagamentos** — pendentes, confirmar, cancelar, histórico\n" +
            "🎟️ **Cupons** — criar e gerenciar cupons de desconto\n" +
            "📦 **Planos** — editar planos e preços da loja\n" +
            "🛡️ **Segurança** — IPs bloqueados, unblock"
        )
        .setFooter({ text: "Bob Joiner • Admin Panel • Todos os comandos exigem senha" })
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
            new ButtonBuilder().setCustomId("logs_addtime").setLabel("Add Tempo").setEmoji("⏱️").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("logs_setexpiry").setLabel("Set Expiração").setEmoji("📅").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("logs_transfer").setLabel("Transfer Key").setEmoji("🔀").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("logs_sethwid").setLabel("Set HWID").setEmoji("💻").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("logs_lookup").setLabel("Lookup").setEmoji("🔍").setStyle(ButtonStyle.Secondary),
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("logs_online").setLabel("Online").setEmoji("🟢").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("logs_stoponline").setLabel("Stop Online").setEmoji("⏹️").setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId("logs_stats").setLabel("Stats").setEmoji("📊").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("logs_info").setLabel("Listar Keys").setEmoji("📋").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("logs_jobids").setLabel("JobIDs").setEmoji("🎮").setStyle(ButtonStyle.Secondary),
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("logs_pendentes").setLabel("Pendentes").setEmoji("⏳").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("logs_confirmar_manual").setLabel("Confirmar Pgto").setEmoji("💳").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("logs_cancelar_pedido").setLabel("Cancelar Pedido").setEmoji("❌").setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId("logs_vendas").setLabel("Vendas").setEmoji("💰").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("logs_historico").setLabel("Histórico").setEmoji("📜").setStyle(ButtonStyle.Secondary),
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("logs_coupon_create").setLabel("Criar Cupom").setEmoji("🎟️").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("logs_coupon_list").setLabel("Listar Cupons").setEmoji("📋").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("logs_plan_edit").setLabel("Editar Plano").setEmoji("📦").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("logs_blocked").setLabel("IPs Bloqueados").setEmoji("🔒").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("logs_unblock").setLabel("Desbloquear IP").setEmoji("🔓").setStyle(ButtonStyle.Primary),
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
        if (keyName && !robloxByKey[keyName] && now - info.lastSeen < PRESENCE_TTL) robloxByKey[keyName] = info.name || null;
    }
    const activeKeys = Object.entries(keys).filter(([, d]) => d.paused || d.expiry === Infinity || d.expiry - now > 0);
    const onlineCount = Object.values(robloxByKey).length;
    const embed = new EmbedBuilder()
        .setTitle(`📋 Keys Ativas — ${activeKeys.length} key(s) | 🟢 ${onlineCount} online`)
        .setColor(onlineCount > 0 ? COLORS.success : COLORS.primary)
        .setFooter({ text: "Bob Joiner • Atualizado a cada 60s" })
        .setTimestamp();
    if (!activeKeys.length) { embed.setDescription("Nenhuma key ativa no momento."); return embed; }
    const lines = activeKeys.map(([keyName, d]) => {
        const isOnline   = !!robloxByKey[keyName];
        const status     = d.paused ? "⏸️" : (isOnline ? "🟢" : "✅");
        const mention    = d.discordId ? `<@${d.discordId}>` : "*(sem Discord)*";
        const robloxName = robloxByKey[keyName] || "—";
        let timeStr = d.paused ? formatTime(d.remaining) : (d.expiry === Infinity ? "Lifetime ♾️" : formatTime(d.expiry - now));
        return `${status} ${mention} **(${robloxName})** — \`${timeStr}\``;
    });
    embed.setDescription(lines.join("\n").substring(0, 4000));
    return embed;
}

function isAdmin(member) { return ADMIN_ROLE_IDS.some(id => member?.roles?.cache?.has(id)); }

if (!global.onlineIntervals) global.onlineIntervals = {};
function startOnlineInterval(channelId, messageObj) {
    stopOnlineInterval(channelId);
    global.onlineIntervals[channelId] = setInterval(async () => {
        await messageObj.edit({ embeds: [buildOnlineEmbed()] }).catch(() => stopOnlineInterval(channelId));
    }, 60_000);
}
function stopOnlineInterval(channelId) {
    if (global.onlineIntervals[channelId]) { clearInterval(global.onlineIntervals[channelId]); delete global.onlineIntervals[channelId]; }
}

// ─── LOGS — INTERACTION HANDLER ───────────────────────────────────────────────
clientLogs.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isModalSubmit()) { await handleLogsModal(interaction); return; }
    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith("logs_") && !interaction.customId.startsWith("pay_")) return;
    if (!isAdmin(interaction.member)) { await interaction.reply({ content: "❌ Sem permissão.", flags: 64 }); return; }

    const id = interaction.customId;

    if (id === "logs_online") {
        await interaction.deferReply({ ephemeral: false });
        const sentMsg = await interaction.editReply({ embeds: [buildOnlineEmbed()] });
        startOnlineInterval(interaction.channelId, sentMsg); return;
    }
    if (id === "logs_stoponline") {
        await interaction.deferReply({ flags: 64 }); stopOnlineInterval(interaction.channelId);
        await interaction.editReply({ content: "⏹️ Atualização parada." }); return;
    }
    if (id === "logs_stats") {
        await interaction.deferReply({ flags: 64 });
        const all = Object.values(keys);
        const active = all.filter(k => !k.paused && (k.expiry === Infinity || k.expiry - Date.now() > 0));
        const paused = all.filter(k => k.paused), lt = all.filter(k => k.expiry === Infinity);
        const online = Object.values(presence).filter(p => Date.now() - p.lastSeen < ONLINE_STALE_MS);
        const pendentes = await PendingPayment.countDocuments();
        const totalVendas = await SaleHistory.aggregate([{ $group: { _id: null, total: { $sum: "$price" } } }]);
        const total = totalVendas[0]?.total || 0;
        await interaction.editReply({ embeds: [new EmbedBuilder().setTitle("📊 Estatísticas — Bob Joiner").setColor(COLORS.primary)
            .addFields(
                { name: "🔑 Total de Keys",    value: `\`${all.length}\``,       inline: true },
                { name: "✅ Ativas",            value: `\`${active.length}\``,    inline: true },
                { name: "⏸️ Pausadas",          value: `\`${paused.length}\``,    inline: true },
                { name: "♾️ Lifetime",          value: `\`${lt.length}\``,        inline: true },
                { name: "🟢 Online agora",      value: `\`${online.length}\``,    inline: true },
                { name: "📡 Brainrots",         value: `\`${brainrots.length}\``, inline: true },
                { name: "⏳ Pedidos Pendentes", value: `\`${pendentes}\``,        inline: true },
                { name: "💰 Receita Total",     value: `\`R$${total}\``,          inline: true },
            ).setTimestamp()] }); return;
    }
    if (id === "logs_info") {
        await interaction.deferReply({ flags: 64 });
        const ks = Object.keys(keys);
        if (!ks.length) { await interaction.editReply({ content: "Nenhuma chave ativa." }); return; }
        const now   = Date.now();
        const lines = ks.map(k => {
            const d = keys[k], t = d.paused ? d.remaining : (d.expiry === Infinity ? Infinity : d.expiry - now);
            return `• \`${k}\`: \`${formatTime(t)}\` ${d.paused ? "⏸️" : "✅"} ${d.discordId ? `<@${d.discordId}>` : "*(sem Discord)*"}`;
        });
        await interaction.editReply({ embeds: [new EmbedBuilder().setTitle("🔑 Chaves Ativas").setColor(COLORS.primary).setDescription(lines.join("\n").substring(0, 4000)).setTimestamp()] }); return;
    }
    if (id === "logs_jobids") {
        await interaction.deferReply({ flags: 64 });
        const entries = Object.entries(userJobIds);
        if (!entries.length) { await interaction.editReply({ content: "Nenhum JobID registrado." }); return; }
        await interaction.editReply({ content: "🎮 **JobIDs:**\n" + entries.map(([n, j]) => `• **${n}**: \`${j}\``).join("\n") }); return;
    }
    if (id === "logs_blocked") {
        await interaction.deferReply({ flags: 64 });
        const now = Date.now(), active = Object.entries(blockedIPs).filter(([, u]) => now < u);
        if (!active.length) { await interaction.editReply({ content: "Nenhum IP bloqueado." }); return; }
        await interaction.editReply({ content: "🔒 **IPs Bloqueados:**\n" + active.map(([ip, u]) => `• \`${ip}\` — ${Math.ceil((u - now) / 1000)}s`).join("\n") }); return;
    }
    if (id === "logs_pendentes") {
        await interaction.deferReply({ flags: 64 });
        const pendentes = await PendingPayment.find().sort({ createdAt: -1 });
        if (!pendentes.length) { await interaction.editReply({ content: "✅ Nenhum pedido pendente!" }); return; }
        const now  = Date.now();
        const list = pendentes.map(p => {
            const rem = PENDING_EXPIRY_MS - (now - new Date(p.createdAt).getTime());
            return `• **${p.discordTag}** — ${p.label} (R$${p.finalPrice || p.price}) ${p.couponUsed ? `🎟️\`${p.couponUsed}\`` : ""} — ⏳ ${rem > 0 ? formatTimeShort(rem) : "expirando..."}`;
        }).join("\n");
        const rows = [];
        const confirmRow = new ActionRowBuilder();
        pendentes.slice(0, 4).forEach(p => confirmRow.addComponents(new ButtonBuilder().setCustomId(`pay_confirm_${p.discordId}_${p.hours}`).setLabel(`✅ ${p.discordTag.split("#")[0].slice(0, 15)}`).setStyle(ButtonStyle.Success)));
        rows.push(confirmRow);
        const cancelRow = new ActionRowBuilder();
        pendentes.slice(0, 4).forEach(p => cancelRow.addComponents(new ButtonBuilder().setCustomId(`pay_cancel_${p.discordId}`).setLabel(`❌ ${p.discordTag.split("#")[0].slice(0, 15)}`).setStyle(ButtonStyle.Danger)));
        rows.push(cancelRow);
        await interaction.editReply({ embeds: [new EmbedBuilder().setColor(COLORS.warning).setTitle(`⏳ Pedidos Pendentes (${pendentes.length})`)
            .setDescription(list).setFooter({ text: "Pedidos expiram automaticamente após 15 minutos" })], components: rows }); return;
    }
    if (id === "logs_confirmar_manual") {
        await interaction.showModal(new ModalBuilder().setCustomId("modal_pay_confirm").setTitle("Confirmar Pagamento Manual").addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("user_id").setLabel("ID do usuário Discord:").setStyle(TextInputStyle.Short).setPlaceholder("123456789012345678").setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("horas").setLabel("Quantidade de horas:").setStyle(TextInputStyle.Short).setPlaceholder("2").setRequired(true)),
        )); return;
    }
    if (id === "logs_cancelar_pedido") {
        await interaction.showModal(new ModalBuilder().setCustomId("modal_cancel_pedido").setTitle("❌ Cancelar Pedido").addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("user_id").setLabel("ID do usuário Discord:").setStyle(TextInputStyle.Short).setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("motivo").setLabel("Motivo (opcional):").setStyle(TextInputStyle.Short).setRequired(false)),
        )); return;
    }
    if (id === "logs_vendas") {
        await interaction.deferReply({ flags: 64 });
        const sales = await SaleHistory.find().sort({ confirmedAt: -1 });
        const totalR = sales.reduce((a, s) => a + (s.price || 0), 0);
        const hoje   = sales.filter(s => new Date(s.confirmedAt).toDateString() === new Date().toDateString());
        const hojeR  = hoje.reduce((a, s) => a + (s.price || 0), 0);
        await interaction.editReply({ embeds: [new EmbedBuilder().setColor(COLORS.success).setTitle("💰 Relatório de Vendas")
            .addFields(
                { name: "📦 Total de Vendas",   value: `\`${sales.length}\``,  inline: true },
                { name: "💰 Receita Total",      value: `\`R$${totalR}\``,     inline: true },
                { name: "📅 Vendas Hoje",        value: `\`${hoje.length}\``,  inline: true },
                { name: "💵 Receita Hoje",       value: `\`R$${hojeR}\``,      inline: true },
                { name: "⏳ Pendentes",          value: `\`${await PendingPayment.countDocuments()}\``, inline: true },
            ).setTimestamp()] }); return;
    }
    if (id === "logs_historico") {
        await interaction.deferReply({ flags: 64 });
        const sales = await SaleHistory.find().sort({ confirmedAt: -1 }).limit(20);
        if (!sales.length) { await interaction.editReply({ content: "Nenhuma venda registrada." }); return; }
        const total = await SaleHistory.aggregate([{ $group: { _id: null, t: { $sum: "$price" } } }]);
        const lines = sales.map(s => `• <@${s.discordId}> — **${s.label}** R$${s.price}${s.couponUsed ? ` 🎟️\`${s.couponUsed}\`` : ""} — \`${s.keyName}\` — ${tsRelative(s.confirmedAt)}`).join("\n");
        await interaction.editReply({ embeds: [new EmbedBuilder().setColor(COLORS.success).setTitle("📜 Histórico de Vendas (últimas 20)")
            .setDescription(lines.substring(0, 4000)).addFields({ name: "💰 Total Arrecadado", value: `R$${total[0]?.t || 0}` }).setTimestamp()] }); return;
    }
    // ✅ Cupons
    if (id === "logs_coupon_create") {
        await interaction.showModal(new ModalBuilder().setCustomId("modal_coupon_create").setTitle("🎟️ Criar Cupom de Desconto").addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("code").setLabel("Código do cupom:").setStyle(TextInputStyle.Short).setPlaceholder("EX: PROMO20").setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("discount").setLabel("Desconto (% ou valor fixo):").setStyle(TextInputStyle.Short).setPlaceholder("Ex: 20 (para 20% ou R$20)").setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("type").setLabel("Tipo: 'percent' ou 'fixed':").setStyle(TextInputStyle.Short).setPlaceholder("percent").setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("maxuses").setLabel("Máximo de usos:").setStyle(TextInputStyle.Short).setPlaceholder("1").setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("key_pass").setLabel("Senha de admin:").setStyle(TextInputStyle.Short).setRequired(true)),
        )); return;
    }
    if (id === "logs_coupon_list") {
        await interaction.deferReply({ flags: 64 });
        const coupons = await Coupon.find({ active: true });
        if (!coupons.length) { await interaction.editReply({ content: "Nenhum cupom ativo." }); return; }
        const lines = coupons.map(c => `• \`${c.code}\` — **${c.discount}${c.type === "percent" ? "%" : " R$"}** — ${c.usedCount}/${c.maxUses} usos ${c.expiresAt ? tsRelative(c.expiresAt) : ""}`).join("\n");
        await interaction.editReply({ embeds: [new EmbedBuilder().setColor(COLORS.gold).setTitle("🎟️ Cupons Ativos").setDescription(lines).setTimestamp()] }); return;
    }
    // ✅ Editar plano
    if (id === "logs_plan_edit") {
        await interaction.showModal(new ModalBuilder().setCustomId("modal_plan_edit").setTitle("📦 Editar Plano da Loja").addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("value").setLabel("ID do plano (1h, 2h, 4h, 8h, 24h):").setStyle(TextInputStyle.Short).setPlaceholder("Ex: 2h").setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("price").setLabel("Novo preço (R$):").setStyle(TextInputStyle.Short).setPlaceholder("Ex: 15").setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("active").setLabel("Ativo? (sim/nao):").setStyle(TextInputStyle.Short).setPlaceholder("sim").setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("key_pass").setLabel("Senha de admin:").setStyle(TextInputStyle.Short).setRequired(true)),
        )); return;
    }
    // pay_ buttons rápidos
    if (id.startsWith("pay_confirm_")) {
        await interaction.deferReply({ flags: 64 });
        const parts = id.split("_"), targetId = parts[2], hours = parseInt(parts[3]);
        const pending = await PendingPayment.findOne({ discordId: targetId });
        const target  = await fetchUserFromAnyClient(targetId);
        if (!target) { await interaction.editReply({ content: "❌ Usuário não encontrado!" }); return; }
        await confirmarPagamento(target, hours, interaction.channel, interaction.user.id, pending?.finalPrice || pending?.price, pending?.label, pending?.couponUsed);
        if (pending?.couponUsed) await consumeCoupon(pending.couponUsed, targetId);
        await PendingPayment.deleteOne({ discordId: targetId });
        await interaction.editReply({ content: `✅ Confirmado para **${target.tag}** (${hours}h)!` }); return;
    }
    if (id.startsWith("pay_cancel_")) {
        await interaction.deferReply({ flags: 64 });
        const targetId = id.replace("pay_cancel_", "");
        const pending  = await PendingPayment.findOne({ discordId: targetId });
        if (!pending) { await interaction.editReply({ content: "❌ Pedido não encontrado." }); return; }
        await PendingPayment.deleteOne({ discordId: targetId });
        fetchUserFromAnyClient(targetId).then(u => { if (u) u.send({ embeds: [new EmbedBuilder().setColor(COLORS.danger).setTitle("❌ Pedido Cancelado").setDescription(`Seu pedido de **${pending.label}** foi cancelado por um administrador.`).setTimestamp()] }).catch(() => {}); });
        await interaction.editReply({ content: `🗑️ Pedido de **${pending.discordTag}** cancelado.` }); return;
    }

    const modalMap = {
        logs_create: buildModal_create, logs_lifetime: buildModal_lifetime, logs_revoke: buildModal_revoke,
        logs_pause: buildModal_pause, logs_reset: buildModal_reset, logs_addtime: buildModal_addtime,
        logs_setexpiry: buildModal_setexpiry, logs_transfer: buildModal_transfer, logs_sethwid: buildModal_sethwid,
        logs_lookup: buildModal_lookup, logs_unblock: buildModal_unblock, logs_cleanlogs: buildModal_cleanlogs,
    };
    if (modalMap[id]) await interaction.showModal(modalMap[id]());
});

// ─── LOGS — MODAL HANDLER ─────────────────────────────────────────────────────
async function handleLogsModal(interaction) {
    await interaction.deferReply({ flags: 64 });
    const id = interaction.customId;
    const getField = (name) => { try { return interaction.fields.getTextInputValue(name); } catch { return ""; } };
    const getTime  = () => { const h = parseInt(getField("key_h")) || 0, m = parseInt(getField("key_m")) || 0; return (h * 3600 + m * 60) * 1000; };

    if (id === "modal_pay_confirm") {
        const userId = getField("user_id").trim(), hours = parseInt(getField("horas").trim());
        if (isNaN(hours) || hours <= 0) { await interaction.editReply({ content: "❌ Horas inválidas!" }); return; }
        const pending = await PendingPayment.findOne({ discordId: userId });
        const target  = await fetchUserFromAnyClient(userId);
        if (!target) { await interaction.editReply({ content: "❌ Usuário não encontrado!" }); return; }
        await confirmarPagamento(target, hours, interaction.channel, interaction.user.id, pending?.finalPrice || pending?.price, pending?.label, pending?.couponUsed);
        if (pending?.couponUsed) await consumeCoupon(pending.couponUsed, userId);
        await PendingPayment.deleteOne({ discordId: userId });
        await interaction.editReply({ content: `✅ Key gerada para **${target.tag}** (${hours}h)!` }); return;
    }
    if (id === "modal_cancel_pedido") {
        const userId = getField("user_id").replace(/\D/g, ""), motivo = getField("motivo").trim() || "Sem motivo";
        const pending = await PendingPayment.findOne({ discordId: userId });
        if (!pending) { await interaction.editReply({ content: "❌ Nenhum pedido pendente encontrado." }); return; }
        await PendingPayment.deleteOne({ discordId: userId });
        fetchUserFromAnyClient(userId).then(u => { if (u) u.send({ embeds: [new EmbedBuilder().setColor(COLORS.danger).setTitle("❌ Pedido Cancelado pelo Admin").setDescription(`Seu pedido de **${pending.label}** foi cancelado.\n**Motivo:** ${motivo}`).setTimestamp()] }).catch(() => {}); });
        await interaction.editReply({ content: `🗑️ Pedido de **${pending.discordTag}** cancelado. Motivo: *${motivo}*` }); return;
    }
    // ✅ Criar cupom
    if (id === "modal_coupon_create") {
        if (wrongPass(getField("key_pass"))) { await interaction.editReply({ content: "❌ Senha incorreta!" }); return; }
        const code     = getField("code").trim().toUpperCase();
        const discount = parseFloat(getField("discount").trim());
        const type     = getField("type").trim().toLowerCase() === "fixed" ? "fixed" : "percent";
        const maxUses  = parseInt(getField("maxuses").trim()) || 1;
        if (!code || isNaN(discount)) { await interaction.editReply({ content: "❌ Dados inválidos!" }); return; }
        const existing = await Coupon.findOne({ code });
        if (existing) { await interaction.editReply({ content: `❌ Cupom \`${code}\` já existe!` }); return; }
        await Coupon.create({ code, discount, type, maxUses });
        await interaction.editReply({ content: `✅ Cupom \`${code}\` criado! **${discount}${type === "percent" ? "%" : " R$"}** de desconto — ${maxUses} uso(s).` }); return;
    }
    // ✅ Editar plano
    if (id === "modal_plan_edit") {
        if (wrongPass(getField("key_pass"))) { await interaction.editReply({ content: "❌ Senha incorreta!" }); return; }
        const value    = getField("value").trim().toLowerCase();
        const price    = parseFloat(getField("price").trim());
        const activeRaw = getField("active").trim().toLowerCase();
        const active   = activeRaw === "sim" || activeRaw === "yes" || activeRaw === "true";
        const plan = PLANS.find(p => p.value === value);
        if (!plan) { await interaction.editReply({ content: `❌ Plano \`${value}\` não encontrado. Use: ${PLANS.map(p => p.value).join(", ")}` }); return; }
        if (!isNaN(price)) plan.price = price;
        plan.active = active;
        await PlanModel.findOneAndUpdate({ value }, { price: plan.price, active }, { upsert: true });
        await interaction.editReply({ content: `✅ Plano \`${value}\` atualizado! Preço: **R$${plan.price}** | Ativo: **${active ? "Sim" : "Não"}**` });
        // Atualiza a loja automaticamente
        if (BUY_CHANNEL) { clientPayment.channels.fetch(BUY_CHANNEL).then(ch => { if (ch) ch.send({ embeds: [new EmbedBuilder().setColor(COLORS.info).setDescription("🔄 Planos atualizados pelo admin!")] }).catch(() => {}); }).catch(() => {}); }
        return;
    }
    if (id === "modal_create")    { if (wrongPass(getField("key_pass"))) { await interaction.editReply({ content: "❌ Senha incorreta!" }); return; } const r = await opCreateKey(getField("key_name").trim(), getTime()); await interaction.editReply({ content: r.msg }); return; }
    if (id === "modal_lifetime")  { if (wrongPass(getField("key_pass"))) { await interaction.editReply({ content: "❌ Senha incorreta!" }); return; } const r = await opCreateLifetime(getField("key_name").trim()); await interaction.editReply({ content: r.msg }); return; }
    if (id === "modal_revoke")    { if (wrongPass(getField("key_pass"))) { await interaction.editReply({ content: "❌ Senha incorreta!" }); return; } const r = await opRevokeKey(getField("key_name").trim()); await interaction.editReply({ content: r.msg }); return; }
    if (id === "modal_pause")     { if (wrongPass(getField("key_pass"))) { await interaction.editReply({ content: "❌ Senha incorreta!" }); return; } const r = await opTogglePause(getField("key_name").trim()); await interaction.editReply({ content: r.msg }); return; }
    if (id === "modal_reset")     { if (wrongPass(getField("key_pass"))) { await interaction.editReply({ content: "❌ Senha incorreta!" }); return; } const r = await opResetHwid(getField("key_name").trim()); await interaction.editReply({ content: r.msg }); return; }
    if (id === "modal_addtime")   { if (wrongPass(getField("key_pass"))) { await interaction.editReply({ content: "❌ Senha incorreta!" }); return; } const r = await opAddTime(getField("key_name").trim(), getTime()); await interaction.editReply({ content: r.msg }); return; }
    if (id === "modal_setexpiry") { if (wrongPass(getField("key_pass"))) { await interaction.editReply({ content: "❌ Senha incorreta!" }); return; } const r = await opSetExpiry(getField("key_name").trim(), getTime()); await interaction.editReply({ content: r.msg }); return; }
    if (id === "modal_transfer") {
        if (wrongPass(getField("key_pass"))) { await interaction.editReply({ content: "❌ Senha incorreta!" }); return; }
        const oldName = getField("key_old").trim(), newName = getField("key_new").trim();
        const t = findKey(oldName); if (!t) { await interaction.editReply({ content: "❌ Chave não encontrada." }); return; }
        if (findKey(newName)) { await interaction.editReply({ content: `❌ \`${newName}\` já existe!` }); return; }
        keys[newName] = { ...keys[t] }; delete keys[t]; await deleteKey(t); await saveKey(newName);
        await interaction.editReply({ content: `✅ Chave transferida: \`${t}\` → \`${newName}\`!` }); return;
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
        const d = keys[t], sales = await SaleHistory.find({ keyName: t });
        await interaction.editReply({ embeds: [new EmbedBuilder().setTitle(`🔍 Info: ${t}`).setColor(d.paused ? COLORS.warning : COLORS.success)
            .addFields(
                { name: "⏱️ Tempo Restante", value: d.expiry === Infinity ? "Lifetime ♾️" : formatTime(d.expiry - Date.now()), inline: true },
                { name: "📌 Status",          value: d.paused ? "⏸️ Pausada" : "✅ Ativa",                                      inline: true },
                { name: "💻 HWID",            value: d.hwid ? `\`${d.hwid.substring(0, 12)}...\`` : "Livre",                   inline: false },
                { name: "👤 Discord",          value: d.discordId ? `<@${d.discordId}>` : "*(não vinculado)*",                  inline: true },
                { name: "🛒 Última Compra",   value: sales.length ? `${tsAbsolute(sales[0].confirmedAt)} — R$${sales[0].price}` : "*(sem registro)*", inline: true },
            ).setTimestamp()] }); return;
    }
    if (id === "modal_unblock") {
        if (wrongPass(getField("key_pass"))) { await interaction.editReply({ content: "❌ Senha incorreta!" }); return; }
        const ip = getField("ip_address").trim();
        if (blockedIPs[ip]) { delete blockedIPs[ip]; await interaction.editReply({ content: `✅ IP \`${ip}\` desbloqueado.` }); }
        else await interaction.editReply({ content: "IP não estava bloqueado." }); return;
    }
    if (id === "modal_cleanlogs") {
        if (wrongPass(getField("key_pass"))) { await interaction.editReply({ content: "❌ Senha incorreta!" }); return; }
        const count = brainrots.length; brainrots.length = 0;
        await interaction.editReply({ content: `🧹 **${count}** brainrots removidos.` }); return;
    }
}

// ─── MODAL BUILDERS ───────────────────────────────────────────────────────────
const mkInput = (id, label, placeholder = "", required = true) =>
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setRequired(required).setPlaceholder(placeholder));

function buildModal_create()    { return new ModalBuilder().setCustomId("modal_create").setTitle("🔑 Criar Key").addComponents(mkInput("key_name","Nome da key"),mkInput("key_h","Horas","Ex: 24"),mkInput("key_m","Minutos","Ex: 0",false),mkInput("key_pass","Senha de admin")); }
function buildModal_lifetime()  { return new ModalBuilder().setCustomId("modal_lifetime").setTitle("♾️ Criar Key Lifetime").addComponents(mkInput("key_name","Nome da key"),mkInput("key_pass","Senha de admin")); }
function buildModal_revoke()    { return new ModalBuilder().setCustomId("modal_revoke").setTitle("🗑️ Revogar Key").addComponents(mkInput("key_name","Nome da key (ou 'all')"),mkInput("key_pass","Senha de admin")); }
function buildModal_pause()     { return new ModalBuilder().setCustomId("modal_pause").setTitle("⏸️ Pausar / Retomar Key").addComponents(mkInput("key_name","Nome da key (ou 'all')"),mkInput("key_pass","Senha de admin")); }
function buildModal_reset()     { return new ModalBuilder().setCustomId("modal_reset").setTitle("🔄 Resetar HWID").addComponents(mkInput("key_name","Nome da key (ou 'all')"),mkInput("key_pass","Senha de admin")); }
function buildModal_addtime()   { return new ModalBuilder().setCustomId("modal_addtime").setTitle("⏱️ Adicionar Tempo").addComponents(mkInput("key_name","Nome da key (ou 'all')"),mkInput("key_h","Horas","Ex: 12"),mkInput("key_m","Minutos","Ex: 30",false),mkInput("key_pass","Senha de admin")); }
function buildModal_setexpiry() { return new ModalBuilder().setCustomId("modal_setexpiry").setTitle("📅 Redefinir Expiração").addComponents(mkInput("key_name","Nome da key"),mkInput("key_h","Novo tempo — Horas"),mkInput("key_m","Novo tempo — Minutos","0",false),mkInput("key_pass","Senha de admin")); }
function buildModal_transfer()  { return new ModalBuilder().setCustomId("modal_transfer").setTitle("🔀 Transferir Key").addComponents(mkInput("key_old","Nome atual"),mkInput("key_new","Novo nome"),mkInput("key_pass","Senha de admin")); }
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
        case "online": { const s = await message.reply({ embeds: [buildOnlineEmbed()] }); startOnlineInterval(message.channel.id, s); break; }
        case "stoponline": stopOnlineInterval(message.channel.id); message.reply("⏹️ Parado."); break;
        case "test": { const p = { id: Date.now().toString(), title: "TESTE", description: "OK!", brainrot: "TESTE", name: "TESTE", jobId: null, value: "999999999", players: "N/A" }; pushBrainrot(p); message.reply("✅ Teste!"); break; }
        case "historico": {
            const sales = await SaleHistory.find().sort({ confirmedAt: -1 }).limit(10);
            if (!sales.length) { message.reply("Nenhuma venda."); break; }
            message.reply({ embeds: [new EmbedBuilder().setTitle("📜 Últimas 10 Vendas").setColor(COLORS.success).setDescription(sales.map(s => `• <@${s.discordId}> — **${s.label}** R$${s.price} — \`${s.keyName}\` — ${tsRelative(s.confirmedAt)}`).join("\n")).setTimestamp()] }); break;
        }
        case "cupons": {
            const coupons = await Coupon.find({ active: true });
            message.reply(coupons.length ? "🎟️ **Cupons ativos:**\n" + coupons.map(c => `• \`${c.code}\` — **${c.discount}${c.type === "percent" ? "%" : "R$"}** — ${c.usedCount}/${c.maxUses}`).join("\n") : "Nenhum cupom ativo."); break;
        }
    }
});

// ─── BOT PANEL ────────────────────────────────────────────────────────────────
const clientPanel = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages], partials: [Partials.Channel, Partials.Message] });
const awaitingInput = {};

function buildPanelEmbed() {
    return new EmbedBuilder().setTitle("🤖 Bob Auto Joiner — Painel").setColor(COLORS.primary)
        .setDescription("Bem-vindo ao painel do **Bob Joiner**!\nClique nos botões abaixo para gerenciar sua key.")
        .addFields(
            { name: "🔑 Redeem Key",  value: "Validar sua key",                          inline: true },
            { name: "📋 Get Script",  value: "Receber o script do Bob",                  inline: true },
            { name: "📊 Key Info",    value: "Ver status da sua key",                    inline: true },
            { name: "⚙️ Reset HWID",  value: "Resetar HWID da key",                      inline: true },
            { name: "👤 Get Role",    value: "Vincular Discord e pegar cargo",            inline: true },
        );
}

function buildPanelRows() {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("panel_redeem").setLabel("Redeem Key").setEmoji("🔑").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("panel_script").setLabel("Get Script").setEmoji("📋").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("panel_stats").setLabel("Key Info").setEmoji("📊").setStyle(ButtonStyle.Secondary),
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("panel_role").setLabel("Get Role").setEmoji("👤").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("panel_hwid").setLabel("Reset HWID").setEmoji("⚙️").setStyle(ButtonStyle.Secondary),
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
    } catch (e) { console.error("[PANEL] Erro:", e.message); }
});

clientPanel.on("messageCreate", async (message) => {
    if (message.author.bot) return;
    if (message.channel.type === ChannelType.DM) {
        const state = awaitingInput[message.author.id];
        if (!state) return;
        const key = message.content.trim(), keyName = findKey(key);
        if (!keyName) return message.reply("❌ Key não encontrada!");
        const d = keys[keyName];
        if (d.paused) return message.reply("⏸️ Sua key está pausada.");
        if (d.expiry !== Infinity && d.expiry - Date.now() <= 0) return message.reply("⌛ Sua key expirou!");
        const { step } = state;
        delete awaitingInput[message.author.id];
        if (step === "redeem_key") return message.reply({ embeds: [new EmbedBuilder().setColor(COLORS.success).setTitle("✅ Key Válida!").addFields({ name: "⏱️ Tempo Restante", value: d.expiry === Infinity ? "Lifetime ♾️" : formatTime(d.expiry - Date.now()) }, { name: "📌 Status", value: "✅ Ativa" }).setTimestamp()] });
        if (step === "script_key") return message.reply("📋 **Bob Joiner Script**\n\n" + (SCRIPT_URL ? `\`\`\`\nloadstring(game:HttpGet('${SCRIPT_URL}'))()\n\`\`\`` : "❌ Script URL não configurada."));
        if (step === "role_key") {
            if (d.discordId && d.discordId !== message.author.id) return message.reply("❌ Key vinculada a outro Discord!");
            d.discordId = message.author.id; await saveKey(keyName);
            const ROLE_ID = process.env.BUYER_ROLE_ID;
            if (ROLE_ID && state.guildId) {
                try { const guild = await clientPanel.guilds.fetch(state.guildId); const member = await guild.members.fetch(message.author.id); await member.roles.add(ROLE_ID); return message.reply("✅ Discord vinculado e cargo adicionado!"); } catch {}
            }
            return message.reply(`✅ Discord vinculado à key \`${keyName}\`!`);
        }
        if (step === "hwid_key") { keys[keyName].hwid = null; kicked[keyName.toLowerCase()] = Date.now(); await saveKey(keyName); return message.reply("✅ HWID resetado!"); }
        if (step === "stats_key") return message.reply({ embeds: [new EmbedBuilder().setTitle("📊 Key Info").setColor(COLORS.primary).addFields({ name: "🔑 Key", value: `\`${keyName}\``, inline: true }, { name: "⏱️ Tempo", value: d.expiry === Infinity ? "Lifetime ♾️" : formatTime(d.expiry - Date.now()), inline: true }, { name: "📌 Status", value: d.paused ? "⏸️ Pausada" : "✅ Ativa", inline: true }, { name: "💻 HWID", value: d.hwid ? `\`${d.hwid.substring(0, 8)}...\`` : "Livre", inline: false })] });
        return;
    }
    if (message.content === "!panel") { try { await message.channel.send({ embeds: [buildPanelEmbed()], components: buildPanelRows() }); } catch (e) { message.reply("❌ Erro: " + e.message); } }
});

clientPanel.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;
    const user = interaction.user;
    await interaction.deferReply({ flags: 64 });
    const steps = { panel_redeem: "redeem_key", panel_script: "script_key", panel_role: "role_key", panel_hwid: "hwid_key", panel_stats: "stats_key" };
    const msgs  = { panel_redeem: "🔑 Envie sua key para validar:", panel_script: "📋 Envie sua key para receber o script:", panel_role: "👤 Envie sua key para vincular o Discord:", panel_hwid: "⚙️ Envie sua key para resetar o HWID:", panel_stats: "📊 Envie sua key para ver o status:" };
    const step = steps[interaction.customId];
    if (step) {
        awaitingInput[user.id] = { step, guildId: interaction.guildId };
        try { await user.send(msgs[interaction.customId]); await interaction.editReply({ content: "📩 Te mandei uma DM!" }); }
        catch { await interaction.editReply({ content: "❌ Habilite mensagens privadas do servidor!" }); }
    }
});

// ─── BOT PAGAMENTO ────────────────────────────────────────────────────────────
const clientPayment = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages], partials: [Partials.Channel, Partials.Message] });

function getActivePlans() { return PLANS.filter(p => p.active); }

function buildShopEmbed() {
    const activePlans = getActivePlans();
    const planList = activePlans.map(p => `${p.emoji} **${p.label}** — ~~R$${p.price}~~ → **R$${p.price},00**`).join("\n");
    return new EmbedBuilder().setColor(COLORS.success).setTitle("🛒 Bob Keys — Loja Oficial")
        .setDescription(
            `Escolha seu plano abaixo:\n\n${planList}\n\n` +
            `> ⏱️ Após escolher, você tem **15 minutos** para pagar.\n` +
            `> 🎟️ Tem cupom de desconto? Informe ao escolher o plano!\n` +
            `> ✅ Envie o comprovante e um admin confirma sua key!\n` +
            `> 🔄 Se já tiver key ativa, o tempo será **renovado automaticamente**!`
        )
        .setFooter({ text: "Bob Keys • Sistema Automático de Keys" }).setTimestamp();
}

function buildShopRows() {
    const activePlans = getActivePlans();
    const rows = [];
    // Divide planos em linhas de até 4
    for (let i = 0; i < activePlans.length; i += 4) {
        const row = new ActionRowBuilder();
        activePlans.slice(i, i + 4).forEach(p => row.addComponents(new ButtonBuilder().setCustomId(`buy_${p.value}`).setLabel(`${p.emoji} ${p.label} — R$${p.price}`).setStyle(ButtonStyle.Success)));
        rows.push(row);
    }
    const extraRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("buy_minhakey").setLabel("🔑 Minha Key").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("buy_cupom").setLabel("🎟️ Usar Cupom").setStyle(ButtonStyle.Primary),
    );
    rows.push(extraRow);
    return rows;
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

// ✅ Estado temporário de cupom pendente por usuário
const pendingCoupon = {};

clientPayment.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton() && !interaction.isModalSubmit()) return;
    const id = interaction.customId, user = interaction.user;

    // Modal de cupom
    if (interaction.isModalSubmit() && id === "modal_cupom") {
        await interaction.deferReply({ flags: 64 });
        const planValue = pendingCoupon[user.id]?.plan;
        const couponCode = interaction.fields.getTextInputValue("coupon_code").trim().toUpperCase();
        const plan = getActivePlans().find(p => p.value === planValue);
        if (!plan) { await interaction.editReply({ content: "❌ Sessão expirada. Escolha o plano novamente." }); return; }
        const result = await applyCoupon(couponCode, user.id, plan.price);
        if (!result.ok) { await interaction.editReply({ content: result.msg }); return; }
        pendingCoupon[user.id] = { plan: planValue, coupon: couponCode, finalPrice: result.finalPrice };
        await interaction.editReply({ embeds: [new EmbedBuilder().setColor(COLORS.success).setTitle("🎟️ Cupom Aplicado!")
            .setDescription(`Cupom \`${couponCode}\` aplicado com sucesso!\n\n**Plano:** ${plan.label}\n**Preço original:** R$${plan.price}\n**Desconto:** ${result.discount}${result.type === "percent" ? "%" : " R$"}\n**Preço final:** **R$${result.finalPrice}**\n\nAgora clique no botão do plano para continuar.`)
            .setTimestamp()] }); return;
    }

    if (!interaction.isButton()) return;
    await interaction.deferReply({ flags: 64 });

    // Botão de cupom
    if (id === "buy_cupom") {
        const modal = new ModalBuilder().setCustomId("modal_cupom").setTitle("🎟️ Inserir Cupom de Desconto").addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("coupon_code").setLabel("Código do cupom:").setStyle(TextInputStyle.Short).setPlaceholder("Ex: PROMO20").setRequired(true))
        );
        await interaction.deleteReply().catch(() => {});
        await interaction.showModal(modal); return;
    }

    if (id.startsWith("buy_") && id !== "buy_minhakey" && id !== "buy_cupom") {
        const planValue = id.replace("buy_", "");
        const plan      = getActivePlans().find(p => p.value === planValue);
        if (!plan) { await interaction.editReply({ content: "❌ Plano inválido!" }); return; }

        // Verifica pedido pendente ativo
        const existing = await PendingPayment.findOne({ discordId: user.id });
        const now = Date.now();
        if (existing) {
            const rem = PENDING_EXPIRY_MS - (now - new Date(existing.createdAt).getTime());
            if (rem > 0) { await interaction.editReply({ embeds: [new EmbedBuilder().setColor(COLORS.warning).setTitle("⚠️ Pedido Já Existente").setDescription(`Você já tem um pedido de **${existing.label}** ativo!\n\n⏳ Expira em **${formatTimeShort(rem)}**.\n\nEfetue o pagamento ou aguarde o cancelamento automático.`)] }); return; }
        }

        // Aplica cupom se tiver
        const couponData = pendingCoupon[user.id]?.plan === planValue ? pendingCoupon[user.id] : null;
        let finalPrice   = plan.price;
        let couponUsed   = null;
        if (couponData) { finalPrice = couponData.finalPrice; couponUsed = couponData.coupon; delete pendingCoupon[user.id]; }

        await PendingPayment.findOneAndUpdate(
            { discordId: user.id },
            { discordId: user.id, discordTag: user.tag, hours: plan.hours, price: plan.price, finalPrice, label: plan.label, couponUsed, warningSent: false, createdAt: new Date() },
            { upsert: true, new: true }
        );

        user.send({ embeds: [new EmbedBuilder().setColor(COLORS.warning).setTitle("⏳ Você tem 15 minutos para pagar!")
            .setDescription(`Seu pedido de **${plan.label}** foi registrado.\n\nEnvie o comprovante no canal em até **15 minutos** ou o pedido será cancelado.`)
            .setTimestamp()] }).catch(() => {});

        const discountLine = couponUsed ? `**Cupom:** \`${couponUsed}\` — Desconto aplicado!\n**Preço original:** ~~R$${plan.price}~~\n**Valor final:** **R$${finalPrice},00**` : `**Valor:** R$${plan.price},00`;
        await interaction.editReply({ embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle("💳 Dados para Pagamento via Pix")
            .setDescription(`**Plano:** ${plan.emoji} ${plan.label}\n${discountLine}\n\n**🔑 Chave Pix:**\n\`\`\`${PIX_KEY}\`\`\`**Nome:** ${PIX_NAME}\n\n> ✅ Pague e envie o **comprovante** aqui no canal.\n> ⏳ Você tem **15 minutos** para pagar.\n> 🔄 Se já tiver key ativa, ela será **renovada automaticamente**!`)
            .setFooter({ text: `Pedido • ${user.tag}` }).setTimestamp()] }); return;
    }

    if (id === "buy_minhakey") {
        const userKeys = Object.entries(keys).filter(([, d]) => d.discordId === user.id);
        if (!userKeys.length) { await interaction.editReply({ content: "❌ Nenhuma key ativa! Use a loja para comprar." }); return; }
        const now = Date.now();
        const list = userKeys.map(([k, d]) => {
            const rem = d.expiry === Infinity ? "Lifetime ♾️" : (d.expiry - now > 0 ? formatTime(d.expiry - now) : "❌ Expirada");
            return `\`${k}\` — ⏳ ${rem} ${d.paused ? "⏸️" : "✅"}`;
        }).join("\n");
        await interaction.editReply({ embeds: [new EmbedBuilder().setColor(COLORS.success).setTitle("🔑 Suas Keys Ativas").setDescription(list).setFooter({ text: user.tag }).setTimestamp()] }); return;
    }
});

clientPayment.on("messageCreate", async (msg) => {
    if (msg.author.bot) return;
    if (msg.content === "!loja" && msg.channel.id === BUY_CHANNEL) {
        await msg.channel.send({ embeds: [buildShopEmbed()], components: buildShopRows() });
        if (msg.deletable) msg.delete().catch(() => {});
    }
});

// ─── PAINEL WEB (DASHBOARD) ───────────────────────────────────────────────────
// Autenticação simples via query param ?pass=ADMIN_PASS
function requireDashAuth(req, res, next) {
    const pass = req.query.pass || req.headers["x-admin-pass"];
    if (!safeCompare(pass, ADMIN_PASS)) return res.status(401).json({ error: "Unauthorized" });
    next();
}

app.get("/api/dashboard", requireDashAuth, async (req, res) => {
    const now     = Date.now();
    const all     = Object.entries(keys);
    const active  = all.filter(([, d]) => !d.paused && (d.expiry === Infinity || d.expiry - now > 0));
    const paused  = all.filter(([, d]) => d.paused);
    const online  = Object.values(presence).filter(p => now - p.lastSeen < ONLINE_STALE_MS);
    const pendentes   = await PendingPayment.find().sort({ createdAt: -1 });
    const recentSales = await SaleHistory.find().sort({ confirmedAt: -1 }).limit(10);
    const totalR      = await SaleHistory.aggregate([{ $group: { _id: null, t: { $sum: "$price" } } }]);
    const coupons     = await Coupon.find({ active: true });
    const hoje        = recentSales.filter(s => new Date(s.confirmedAt).toDateString() === new Date().toDateString());

    res.json({
        stats: { totalKeys: all.length, activeKeys: active.length, pausedKeys: paused.length, onlineNow: online.length, pendingOrders: pendentes.length, totalRevenue: totalR[0]?.t || 0, todaySales: hoje.length },
        keys: active.slice(0, 50).map(([name, d]) => ({ name, expiry: d.expiry === Infinity ? null : d.expiry, discordId: d.discordId, paused: d.paused, hwid: !!d.hwid })),
        online: online.map(p => p.name),
        pendingOrders: pendentes.map(p => ({ discordTag: p.discordTag, label: p.label, price: p.finalPrice || p.price, coupon: p.couponUsed, createdAt: p.createdAt })),
        recentSales: recentSales.map(s => ({ discordTag: s.discordTag, label: s.label, price: s.price, keyName: s.keyName, confirmedAt: s.confirmedAt })),
        coupons: coupons.map(c => ({ code: c.code, discount: c.discount, type: c.type, usedCount: c.usedCount, maxUses: c.maxUses })),
        plans: PLANS,
    });
});

// Serve o dashboard HTML inline
app.get("/dashboard", (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bob Joiner — Dashboard</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',sans-serif;background:#0d1117;color:#e6edf3;min-height:100vh}
.header{background:linear-gradient(135deg,#5865F2,#9B59B6);padding:20px 30px;display:flex;align-items:center;gap:15px}
.header h1{font-size:1.5rem}
.badge{background:rgba(255,255,255,0.2);padding:4px 12px;border-radius:20px;font-size:.8rem}
.container{padding:24px;max-width:1400px;margin:0 auto}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:24px}
.card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:20px;text-align:center}
.card .val{font-size:2.2rem;font-weight:700;color:#58a6ff}
.card .lbl{font-size:.85rem;color:#8b949e;margin-top:4px}
.card.green .val{color:#3fb950}
.card.orange .val{color:#d29922}
.card.red .val{color:#f85149}
.card.purple .val{color:#bc8cff}
.section{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:20px;margin-bottom:20px}
.section h2{font-size:1rem;color:#8b949e;margin-bottom:14px;text-transform:uppercase;letter-spacing:.05em}
table{width:100%;border-collapse:collapse;font-size:.9rem}
th{text-align:left;padding:8px 12px;color:#8b949e;border-bottom:1px solid #30363d}
td{padding:8px 12px;border-bottom:1px solid #21262d}
tr:last-child td{border-bottom:none}
.badge-green{background:#1a3a1a;color:#3fb950;padding:2px 8px;border-radius:20px;font-size:.8rem}
.badge-orange{background:#3a2a00;color:#d29922;padding:2px 8px;border-radius:20px;font-size:.8rem}
.badge-blue{background:#1a2a4a;color:#58a6ff;padding:2px 8px;border-radius:20px;font-size:.8rem}
.login{display:flex;flex-direction:column;align-items:center;justify-content:center;height:80vh;gap:16px}
.login input{background:#161b22;border:1px solid #30363d;color:#e6edf3;padding:10px 16px;border-radius:8px;font-size:1rem;width:280px;outline:none}
.login button{background:#5865F2;color:#fff;border:none;padding:10px 32px;border-radius:8px;font-size:1rem;cursor:pointer}
.login button:hover{background:#4752c4}
.refresh{float:right;background:#21262d;color:#8b949e;border:1px solid #30363d;padding:6px 14px;border-radius:6px;cursor:pointer;font-size:.85rem}
.refresh:hover{background:#30363d}
</style>
</head>
<body>
<div id="app">
  <div class="login" id="loginView">
    <h2 style="color:#5865F2">🤖 Bob Joiner Dashboard</h2>
    <input type="password" id="passInput" placeholder="Senha de admin..." />
    <button onclick="doLogin()">Entrar</button>
    <span id="loginErr" style="color:#f85149;font-size:.85rem"></span>
  </div>
  <div id="mainView" style="display:none">
    <div class="header">
      <span style="font-size:1.8rem">🤖</span>
      <h1>Bob Joiner — Dashboard</h1>
      <span class="badge" id="lastUpdate">Carregando...</span>
      <button class="refresh" onclick="loadData()" style="margin-left:auto">🔄 Atualizar</button>
    </div>
    <div class="container">
      <div class="grid" id="statsGrid"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
        <div class="section"><h2>🟢 Online Agora</h2><div id="onlineList">—</div></div>
        <div class="section"><h2>⏳ Pedidos Pendentes</h2><table><thead><tr><th>Usuário</th><th>Plano</th><th>Valor</th></tr></thead><tbody id="pendingTable"></tbody></table></div>
      </div>
      <div class="section"><h2>📜 Últimas Vendas</h2><table><thead><tr><th>Usuário</th><th>Plano</th><th>Valor</th><th>Key</th><th>Quando</th></tr></thead><tbody id="salesTable"></tbody></table></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
        <div class="section"><h2>🎟️ Cupons Ativos</h2><table><thead><tr><th>Código</th><th>Desconto</th><th>Usos</th></tr></thead><tbody id="couponsTable"></tbody></table></div>
        <div class="section"><h2>📦 Planos</h2><table><thead><tr><th>Plano</th><th>Horas</th><th>Preço</th><th>Status</th></tr></thead><tbody id="plansTable"></tbody></table></div>
      </div>
    </div>
  </div>
</div>
<script>
let PASS='';
function doLogin(){
  PASS=document.getElementById('passInput').value;
  loadData();
}
async function loadData(){
  try{
    const r=await fetch('/api/dashboard?pass='+encodeURIComponent(PASS));
    if(r.status===401){document.getElementById('loginErr').textContent='Senha incorreta.';return;}
    const d=await r.json();
    document.getElementById('loginView').style.display='none';
    document.getElementById('mainView').style.display='block';
    document.getElementById('lastUpdate').textContent='Atualizado: '+new Date().toLocaleTimeString('pt-BR');
    renderStats(d.stats);
    document.getElementById('onlineList').innerHTML=d.online.length?d.online.map(n=>'<span class="badge-green" style="display:inline-block;margin:3px">🟢 '+n+'</span>').join(''):'<span style="color:#8b949e">Ninguém online</span>';
    document.getElementById('pendingTable').innerHTML=d.pendingOrders.map(p=>'<tr><td>'+p.discordTag+'</td><td>'+p.label+'</td><td><span class="badge-orange">R$'+p.price+'</span></td></tr>').join('')||'<tr><td colspan="3" style="color:#8b949e;text-align:center">Nenhum pedido pendente</td></tr>';
    document.getElementById('salesTable').innerHTML=d.recentSales.map(s=>'<tr><td>'+s.discordTag+'</td><td>'+s.label+'</td><td><span class="badge-green">R$'+s.price+'</span></td><td><code style="font-size:.8rem">'+s.keyName+'</code></td><td style="color:#8b949e">'+new Date(s.confirmedAt).toLocaleString('pt-BR')+'</td></tr>').join('')||'<tr><td colspan="5" style="color:#8b949e;text-align:center">Nenhuma venda</td></tr>';
    document.getElementById('couponsTable').innerHTML=d.coupons.map(c=>'<tr><td><code>'+c.code+'</code></td><td><span class="badge-blue">'+c.discount+(c.type==='percent'?'%':' R$')+'</span></td><td>'+c.usedCount+'/'+c.maxUses+'</td></tr>').join('')||'<tr><td colspan="3" style="color:#8b949e;text-align:center">Nenhum cupom ativo</td></tr>';
    document.getElementById('plansTable').innerHTML=d.plans.map(p=>'<tr><td>'+p.emoji+' '+p.label+'</td><td>'+p.hours+'h</td><td>R$'+p.price+'</td><td>'+(p.active?'<span class="badge-green">Ativo</span>':'<span style="background:#3a1a1a;color:#f85149;padding:2px 8px;border-radius:20px;font-size:.8rem">Inativo</span>')+'</td></tr>').join('');
  }catch(e){document.getElementById('loginErr').textContent='Erro: '+e.message;}
}
function renderStats(s){
  document.getElementById('statsGrid').innerHTML=[
    {cls:'',val:s.totalKeys,lbl:'🔑 Total de Keys'},{cls:'green',val:s.activeKeys,lbl:'✅ Keys Ativas'},
    {cls:'',val:s.pausedKeys,lbl:'⏸️ Keys Pausadas'},{cls:'green',val:s.onlineNow,lbl:'🟢 Online Agora'},
    {cls:'orange',val:s.pendingOrders,lbl:'⏳ Pedidos Pendentes'},{cls:'purple',val:'R$'+s.totalRevenue,lbl:'💰 Receita Total'},
    {cls:'green',val:s.todaySales,lbl:'📅 Vendas Hoje'},
  ].map(c=>'<div class="card '+c.cls+'"><div class="val">'+c.val+'</div><div class="lbl">'+c.lbl+'</div></div>').join('');
}
document.getElementById('passInput').addEventListener('keydown',e=>{if(e.key==='Enter')doLogin();});
</script>
</body>
</html>`);
});

// ─── ENDPOINTS API ────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({ status: "ok", time: Date.now() }));
app.get("/",       (_, res) => res.send("<h1>Bob API — Online ✅</h1><p><a href='/dashboard'>Dashboard Admin</a></p>"));

app.get("/validate", requireClientHeader, (req, res) => {
    const { key, secret, hwid } = req.query;
    const r = checkKey(key, secret, hwid);
    if (!r.ok) return res.status(403).json({ status: "error", message: r.error });
    res.json({ status: "success", time_left: r.data.expiry === Infinity ? LIFETIME_VALUE : r.data.expiry - Date.now() });
});
app.get("/get-brainrots", requireClientHeader, (req, res) => {
    const { key, secret, hwid, lastId } = req.query;
    const r = checkKey(key, secret, hwid); if (!r.ok) return res.status(403).json({ status: "error", message: r.error });
    if (!brainrots.length) return res.json({ status: "waiting" });
    const latest = brainrots[brainrots.length - 1];
    if (latest.id === lastId) return res.json({ status: "waiting" });
    res.json({ status: "success", brainrot: latest });
});
app.get("/logs", requireClientHeader, (req, res) => {
    const { key, secret, hwid } = req.query; const r = checkKey(key, secret, hwid);
    if (!r.ok) return res.status(403).json({ status: "error", message: r.error }); res.json(brainrots);
});
app.get("/api/latest", requireClientHeader, (req, res) => {
    const { key, secret, hwid } = req.query; const r = checkKey(key, secret, hwid);
    if (!r.ok) return res.status(403).json({ status: "error", message: r.error });
    if (!brainrots.length) return res.json({ status: "waiting" }); res.json(brainrots[brainrots.length - 1]);
});
app.post("/api/notify", requireClientHeader, (req, res) => {
    const { secret, name, jobId, value, description } = req.body;
    if (!secret || secret !== SCRIPT_SECRET) return res.status(403).json({ status: "error", message: "Secret inválido." });
    const payload = { id: Date.now().toString(), title: name || "Brainrot", description: description || name || "Novo Brainrot!", brainrot: name || "Brainrot", name: name || "Brainrot", jobId: xorObfuscate(jobId) || null, value: String(value || "0"), players: "N/A" };
    pushBrainrot(payload); res.json({ status: "ok", id: payload.id });
});
app.get("/kicked", requireClientHeader, (req, res) => {
    const { key, secret } = req.query; if (secret !== SCRIPT_SECRET) return res.json({ kicked: false });
    const keyName = findKey(key); if (!keyName) return res.json({ kicked: false });
    const ts = kicked[keyName.toLowerCase()];
    if (ts) { delete kicked[keyName.toLowerCase()]; return res.json({ kicked: true }); } res.json({ kicked: false });
});
app.post("/presence", requireClientHeader, async (req, res) => {
    const { key, secret, hwid, sessionId, name, jobId, discordId } = req.query;
    const r = checkKey(key, secret, hwid); if (!r.ok) return res.status(403).json({ status: "error", message: r.error });
    presence[sessionId] = { name: name || "Unknown", lastSeen: Date.now(), key: (key || "").trim() };
    if (jobId && name) userJobIds[name] = jobId;
    if (discordId && r.keyName) { const d = keys[r.keyName], cleanId = String(discordId).replace(/\D/g, ""); if (cleanId.length >= 17 && !d.discordId) { d.discordId = cleanId; await saveKey(r.keyName); } }
    res.json({ status: "ok" });
});
app.get("/presence", requireClientHeader, (req, res) => {
    const { key, secret, hwid } = req.query; const r = checkKey(key, secret, hwid);
    if (!r.ok) return res.status(403).json({ status: "error", message: r.error });
    const now = Date.now(), active = {};
    for (const [sid, info] of Object.entries(presence)) { if (now - info.lastSeen < ONLINE_STALE_MS) active[info.name] = true; else delete presence[sid]; }
    res.json(Object.keys(active).sort());
});
app.get("/clients", requireClientHeader, (req, res) => {
    if (req.query.secret !== SCRIPT_SECRET) return res.status(403).json({ status: "error", message: "Secret inválido." });
    res.send(`Socket.IO: ${io.sockets.sockets.size} | Presença: ${Object.keys(presence).length}`);
});
app.get("/test-emit", requireClientHeader, (req, res) => {
    if (req.query.secret !== SCRIPT_SECRET) return res.status(403).send("Secret invalido");
    pushBrainrot({ id: Date.now().toString(), title: "TESTE MANUAL", description: "OK!", brainrot: "TESTE", name: "TESTE", jobId: null, value: "0" });
    res.send("✅ Emit enviado!");
});
app.post("/push-brainrot", requireClientHeader, (req, res) => {
    const { secret, title, description, jobId, value, players } = req.body;
    if (secret !== SCRIPT_SECRET) return res.status(403).json({ status: "error", message: "Secret inválido" });
    const payload = { id: Date.now().toString(), title: title || "Brainrot", description: description || "", brainrot: title || "Brainrot", name: title || "Brainrot", jobId: xorObfuscate(jobId) || null, value: value || "0", players: players || "N/A" };
    pushBrainrot(payload); res.json({ status: "ok", id: payload.id });
});
app.post("/link-discord", requireClientHeader, async (req, res) => {
    const { key, secret, hwid, discordId } = req.query; const r = checkKey(key, secret, hwid);
    if (!r.ok) return res.status(403).json({ status: "error", message: r.error });
    const cleanId = String(discordId || "").replace(/\D/g, "");
    if (cleanId.length < 17 || cleanId.length > 20) return res.status(400).json({ status: "error", message: "Discord ID invalido." });
    const d = keys[r.keyName];
    if (d.discordId && d.discordId !== cleanId) return res.status(409).json({ status: "error", message: "Key ja vinculada a outro Discord ID." });
    d.discordId = cleanId; await saveKey(r.keyName); res.json({ status: "ok", message: "Discord vinculado!" });
});
app.post("/report-jobid", requireClientHeader, (req, res) => {
    const { key, secret, name, jobId } = req.query;
    if (secret !== SCRIPT_SECRET) return res.status(403).json({ status: "error", message: "Secret inválido" });
    const keyName = findKey(key); if (!keyName) return res.status(403).json({ status: "error", message: "Key inválida" });
    if (name && jobId) userJobIds[name] = jobId; res.json({ status: "ok" });
});

// ─── ERROS ────────────────────────────────────────────────────────────────────
app.use((err, req, res, next) => { console.error("[EXPRESS]", err.message); res.status(500).json({ status: "error", message: "Erro interno." }); });
process.on("unhandledRejection", r => console.error("[PROCESS] Rejeição:", r));
process.on("uncaughtException",  e => console.error("[PROCESS] Exceção:", e.message, e.stack));

// ─── LOGIN ────────────────────────────────────────────────────────────────────
async function loginBot(client, token, label) {
    if (!token) { console.warn(`[${label}] Token ausente.`); return; }
    try { await client.login(token); console.log(`[${label}] Login OK`); }
    catch (e) { console.error(`[${label}] Erro:`, e.message); }
}

loginBot(clientNotifier, DISCORD_TOKEN_NOTIFIER, "NOTIFIER");
loginBot(clientLogs,     DISCORD_TOKEN_LOGS,     "LOGS");
loginBot(clientPanel,    DISCORD_TOKEN_PANEL,    "PANEL");
loginBot(clientPayment,  DISCORD_TOKEN_PAYMENT,  "PAYMENT");

loadKeys();
server.listen(port, () => console.log(`[SERVER] Porta ${port} — Bob API online ✅\n[DASHBOARD] Acesse: http://localhost:${port}/dashboard`));