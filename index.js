require('dotenv').config();
const express  = require("express");
const http     = require("http");
const crypto   = require("crypto");
const path     = require("path");
const jwt      = require("jsonwebtoken");
const { Server } = require("socket.io");
const {
    Client, GatewayIntentBits,
    ActionRowBuilder, ButtonBuilder, ButtonStyle,
    EmbedBuilder, Events, ChannelType, Partials,
    ModalBuilder, TextInputBuilder, TextInputStyle,
} = require("discord.js");
const mongoose = require("mongoose");

const LIFETIME_VALUE     = 9_999_999_999_999;
const BRAINROT_MAX       = 100;
const JOBID_MAX          = 500;
const PRESENCE_TTL       = 2  * 60 * 1_000;
const ONLINE_STALE_MS    = 30 * 1_000;
const RATE_LIMIT_MAX     = 60;
const RATE_LIMIT_WINDOW  = 60_000;
const BLOCK_DURATION     = 5  * 60 * 1_000;
const PENDING_EXPIRY_MS  = 15 * 60 * 1_000;
const KEY_WARN_BEFORE_MS = 30 * 60 * 1_000;
const MAX_SLOTS          = parseInt(process.env.MAX_SLOTS || "3");

const COLORS = {
    primary:  0x5865F2, success:  0x00E676, danger:   0xFF3C3C,
    warning:  0xFFA500, info:     0x00CCFF, gold:     0xFFD700,
    purple:   0x9B59B6, dark:     0x2F3136,
};

const BLOCKED_UA = ["python-requests","python-httpx","curl","wget","httpie","insomnia","postman","go-http-client","java/","axios","okhttp","libwww-perl","scrapy","aiohttp"];

function requireEnv(name) {
    const val = process.env[name];
    if (!val) { console.error(`[FATAL] Variável obrigatória não definida: ${name}`); process.exit(1); }
    return val;
}

const ADMIN_PASS    = requireEnv("ADMIN_PASS");
const SCRIPT_SECRET = requireEnv("SCRIPT_SECRET");
const XOR_KEY       = requireEnv("XOR_KEY");
const MONGODB_URI   = requireEnv("MONGODB_URI");
const JWT_SECRET    = process.env.JWT_SECRET || "bobjoiner_jwt_secret_2026";

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
const FRONTEND_URL           = process.env.FRONTEND_URL            || "http://localhost:3001";
const DISCORD_CLIENT_ID      = process.env.DISCORD_CLIENT_ID       || "";
const DISCORD_CLIENT_SECRET  = process.env.DISCORD_CLIENT_SECRET   || "";
const REDIRECT_URI           = `${process.env.RAILWAY_PUBLIC_DOMAIN ? "https://" + process.env.RAILWAY_PUBLIC_DOMAIN : "http://localhost:3000"}/auth/callback`;

const ADMIN_ROLE_IDS = ["1477885793144930496","1501356382677373101","1477885797553148066"];
const RECHARGE_CHANNEL = "1511517095412895905";
const MIN_RECHARGE = 10;

const DEFAULT_PLANS = [
    { label: "1 Hora",   value: "1h",  price: 5,  hours: 1,  emoji: "🕐", active: true },
    { label: "2 Horas",  value: "2h",  price: 10, hours: 2,  emoji: "⏱️", active: true },
    { label: "4 Horas",  value: "4h",  price: 20, hours: 4,  emoji: "⚡", active: true },
    { label: "8 Horas",  value: "8h",  price: 35, hours: 8,  emoji: "🔥", active: false },
    { label: "24 Horas", value: "24h", price: 80, hours: 24, emoji: "👑", active: false },
];
let PLANS = [...DEFAULT_PLANS];

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
    warnSent:  { type: Boolean, default: false },
    isAutoKey: { type: Boolean, default: false },
});
const KeyModel = mongoose.model("Key", KeySchema);

const PendingPaymentSchema = new mongoose.Schema({
    discordId: String, discordTag: String, hours: Number, price: Number,
    finalPrice: Number, label: String, couponUsed: String,
    warningSent: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
});
const PendingPayment = mongoose.model("PendingPayment", PendingPaymentSchema);

const SaleHistorySchema = new mongoose.Schema({
    discordId: String, discordTag: String, hours: Number, price: Number,
    label: String, keyName: String, couponUsed: String,
    confirmedBy: { type: String, default: "auto" },
    confirmedAt: { type: Date, default: Date.now },
});
const SaleHistory = mongoose.model("SaleHistory", SaleHistorySchema);

const CouponSchema = new mongoose.Schema({
    code: { type: String, required: true, unique: true },
    discount: { type: Number, required: true },
    type: { type: String, default: "percent" },
    maxUses: { type: Number, default: 1 },
    usedCount: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
    expiresAt: { type: Date, default: null },
    usedBy: [String],
    createdAt: { type: Date, default: Date.now },
});
const Coupon = mongoose.model("Coupon", CouponSchema);

const PlanSchema = new mongoose.Schema({
    label: String, value: { type: String, unique: true },
    price: Number, hours: Number, emoji: String,
    active: { type: Boolean, default: true },
});
const PlanModel = mongoose.model("Plan", PlanSchema);

const UserSchema = new mongoose.Schema({
    discordId:  { type: String, required: true, unique: true },
    discordTag: String, avatar: String,
    balance:    { type: Number, default: 0 },
    createdAt:  { type: Date, default: Date.now },
});
const User = mongoose.model("User", UserSchema);

const TransactionSchema = new mongoose.Schema({
    discordId: String, type: String, amount: Number,
    description: String, createdAt: { type: Date, default: Date.now },
});
const Transaction = mongoose.model("Transaction", TransactionSchema);

const RechargeSchema = new mongoose.Schema({
    discordId:  { type: String, required: true },
    discordTag: String,
    amount:     { type: Number, required: true },
    code:       { type: String, required: true, unique: true },
    status:     { type: String, default: "pending" }, // pending | confirmed | cancelled
    confirmedBy: { type: String, default: null },
    createdAt:  { type: Date, default: Date.now },
});
const Recharge = mongoose.model("Recharge", RechargeSchema);

const keys = {}, brainrots = [], presence = {}, kicked = {}, userJobIds = {};

function xorObfuscate(value) {
    if (!value) return value;
    const str = String(value); let result = "";
    for (let i = 0; i < str.length; i++)
        result += String.fromCharCode(str.charCodeAt(i) ^ XOR_KEY.charCodeAt(i % XOR_KEY.length));
    return Buffer.from(result, "binary").toString("base64");
}

function safeCompare(a, b) {
    try {
        const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
        if (ba.length !== bb.length) return false;
        return crypto.timingSafeEqual(ba, bb);
    } catch { return false; }
}

const wrongPass = (pass) => !safeCompare(pass, ADMIN_PASS);

const formatTime = (ms) => {
    if (ms === Infinity) return "Lifetime ♾️";
    if (ms <= 0) return "Expirado";
    let t = Math.floor(ms / 1000);
    const d = Math.floor(t / 86400), h = Math.floor((t % 86400) / 3600), m = Math.floor((t % 3600) / 60);
    const parts = [];
    if (d > 0) parts.push(d + "d");
    if (h > 0) parts.push(h + "h");
    parts.push(m + "m");
    return parts.join(" ");
};

const formatTimeShort = (ms) => {
    if (ms <= 0) return "expirado";
    const m = Math.floor(ms / 60_000), s = Math.floor((ms % 60_000) / 1000);
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
};

const findKey    = (name) => Object.keys(keys).find(k => k.toLowerCase() === (name || "").trim().toLowerCase());
const tsRelative = (date) => `<t:${Math.floor(new Date(date).getTime() / 1000)}:R>`;

function generateBobKey() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let r = "BOB-";
    for (let i = 0; i < 8; i++) r += chars[Math.floor(Math.random() * chars.length)];
    return r;
}

function generateRechargeCode() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let r = "PIX-";
    for (let i = 0; i < 6; i++) r += chars[Math.floor(Math.random() * chars.length)];
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

async function applyCoupon(code, userId, originalPrice) {
    if (!code) return { ok: false, finalPrice: originalPrice, msg: null };
    const coupon = await Coupon.findOne({ code: code.toUpperCase(), active: true });
    if (!coupon) return { ok: false, finalPrice: originalPrice, msg: "❌ Cupom inválido." };
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

async function loadPlansFromDB() {
    try {
        const dbPlans = await PlanModel.find({});
        if (dbPlans.length > 0) {
            PLANS = dbPlans.map(p => ({ label: p.label, value: p.value, price: p.price, hours: p.hours, emoji: p.emoji, active: p.active }));
        } else {
            for (const p of DEFAULT_PLANS) await PlanModel.findOneAndUpdate({ value: p.value }, p, { upsert: true });
        }
    } catch (e) { console.error("[DB] Erro ao carregar planos:", e.message); }
}

async function loadKeys() {
    try {
        const docs = await KeyModel.find({});
        let expired = 0;
        for (const d of docs) {
            const expiry = d.expiry >= LIFETIME_VALUE ? Infinity : d.expiry;
            const remaining = d.remaining >= LIFETIME_VALUE ? Infinity : d.remaining;
            if (d.isAutoKey && d.expiry === 0 && d.paused) {
                keys[d.name] = { expiry: 0, paused: true, remaining: 0, hwid: d.hwid || null, discordId: d.discordId || null, warnSent: false, isAutoKey: true };
                continue;
            }
            if (expiry !== Infinity && !d.paused && expiry - Date.now() <= 0) {
                await KeyModel.deleteOne({ name: d.name }); expired++; continue;
            }
            keys[d.name] = {
                expiry, paused: d.paused, remaining, hwid: d.hwid || null,
                discordId: d.discordId || null, warnSent: d.warnSent || false,
                isAutoKey: d.isAutoKey || false,
            };
        }
        console.log(`[DB] ${Object.keys(keys).length} keys carregadas. ${expired} expiradas removidas.`);
    } catch (e) { console.error("[DB] Erro ao carregar keys:", e.message); }
}

async function saveKey(name) {
    try {
        const raw = { ...keys[name] };
        if (raw.expiry === Infinity) raw.expiry = LIFETIME_VALUE;
        if (raw.remaining === Infinity) raw.remaining = LIFETIME_VALUE;
        await KeyModel.findOneAndUpdate({ name }, { name, ...raw }, { upsert: true, new: true });
    } catch (e) { console.error("[DB] Erro ao salvar key:", e.message); }
}

async function deleteKey(name) {
    try { await KeyModel.deleteOne({ name }); } catch (e) { console.error("[DB] Erro ao deletar key:", e.message); }
}

async function createAutoKeyForUser(discordId, discordTag) {
    const discordIdStr = String(discordId);
    const existing = Object.entries(keys).find(([, d]) => d.discordId === discordIdStr);
    if (existing) {
        console.log(`[AUTH] Usuário ${discordTag} já tem key em memória: ${existing[0]}`);
        return existing[0];
    }
    const existingInDB = await KeyModel.findOne({ discordId: discordIdStr });
    if (existingInDB) {
        console.log(`[AUTH] Usuário ${discordTag} já tem key no banco: ${existingInDB.name}`);
        if (!keys[existingInDB.name]) {
            const expiry = existingInDB.expiry >= LIFETIME_VALUE ? Infinity : existingInDB.expiry;
            const remaining = existingInDB.remaining >= LIFETIME_VALUE ? Infinity : existingInDB.remaining;
            keys[existingInDB.name] = {
                expiry, paused: existingInDB.paused, remaining,
                hwid: existingInDB.hwid || null, discordId: discordIdStr,
                warnSent: existingInDB.warnSent || false, isAutoKey: existingInDB.isAutoKey || false,
            };
        }
        return existingInDB.name;
    }
    const keyName = generateBobKey();
    keys[keyName] = { expiry: 0, paused: true, remaining: 0, hwid: null, discordId: discordIdStr, warnSent: false, isAutoKey: true };
    await saveKey(keyName);
    console.log(`[AUTH] ✅ Key auto-gerada no login: ${keyName} → ${discordTag}`);
    return keyName;
}

setInterval(async () => {
    const now = Date.now();
    for (const [name, data] of Object.entries(keys)) {
        if (data.isAutoKey && data.expiry === 0 && data.paused) continue;
        if (data.expiry !== Infinity && !data.paused && data.expiry - now <= 0) {
            if (data.discordId) fetchUserFromAnyClient(data.discordId).then(user => {
                if (user) user.send({ embeds: [new EmbedBuilder().setColor(COLORS.danger).setTitle("⌛ Sua key expirou!").setDescription(`Sua key \`${name}\` expirou. Acesse a loja para renovar!`).setTimestamp()] }).catch(() => {});
            });
            delete keys[name]; await deleteKey(name);
        }
    }
    for (const [sid, info] of Object.entries(presence)) { if (now - info.lastSeen > PRESENCE_TTL) delete presence[sid]; }
    const jobKeys = Object.keys(userJobIds);
    if (jobKeys.length > JOBID_MAX) jobKeys.slice(0, jobKeys.length - JOBID_MAX).forEach(k => delete userJobIds[k]);
}, 60_000);

setInterval(async () => {
    const now = Date.now();
    for (const [name, data] of Object.entries(keys)) {
        if (data.expiry === Infinity || data.paused || data.warnSent) continue;
        const remaining = data.expiry - now;
        if (remaining > 0 && remaining <= KEY_WARN_BEFORE_MS) {
            data.warnSent = true; await saveKey(name);
            if (data.discordId) fetchUserFromAnyClient(data.discordId).then(user => {
                if (user) user.send({ embeds: [new EmbedBuilder().setColor(COLORS.warning).setTitle("⚠️ Sua key vai expirar!").setDescription(`Sua key \`${name}\` expira ${tsRelative(data.expiry)}. Renove agora!`).setTimestamp()] }).catch(() => {});
            });
        }
    }
}, 5 * 60_000);

setInterval(async () => {
    const now = Date.now(), cutoff = new Date(now - PENDING_EXPIRY_MS);
    try {
        const expired = await PendingPayment.find({ createdAt: { $lt: cutoff } });
        for (const p of expired) {
            fetchUserFromAnyClient(p.discordId).then(user => {
                if (user) user.send({ embeds: [new EmbedBuilder().setColor(COLORS.danger).setTitle("❌ Pedido Cancelado").setDescription(`Seu pedido de **${p.label}** foi cancelado após 15 minutos.`).setTimestamp()] }).catch(() => {});
            });
            await PendingPayment.deleteOne({ _id: p._id });
        }
        const toWarn = await PendingPayment.find({ warningSent: false, createdAt: { $lt: new Date(now - (PENDING_EXPIRY_MS - 60_000)) } });
        for (const p of toWarn) {
            fetchUserFromAnyClient(p.discordId).then(user => {
                if (user) user.send({ embeds: [new EmbedBuilder().setColor(COLORS.warning).setTitle("⚠️ Pedido expira em 1 minuto!").setDescription(`Seu pedido de **${p.label}** será cancelado em breve!`).setTimestamp()] }).catch(() => {});
            });
            await PendingPayment.updateOne({ _id: p._id }, { warningSent: true });
        }
    } catch (e) { console.error("[PENDING CLEANUP] Erro:", e.message); }
}, 60_000);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] }, allowEIO3: true, transports: ["polling", "websocket"] });
const port = process.env.PORT || 3000;

app.use((req, res, next) => {
    const allowed = [FRONTEND_URL, "http://localhost:3001", "http://localhost:3000"];
    const origin = req.headers.origin;
    if (origin && (allowed.includes(origin) || origin.endsWith(".vercel.app"))) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
        res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type,x-admin-pass,Authorization");
    }
    if (req.method === "OPTIONS") return res.sendStatus(200);
    next();
});

const rateLimitMap = {}, blockedIPs = {};

function getRealIP(req) { return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "unknown"; }

async function logSecurityAlert(message) {
    console.warn("[SECURITY]", message);
    if (!LOGS_CHANNEL_ID) return;
    try { const ch = await clientLogs.channels.fetch(LOGS_CHANNEL_ID); if (ch) await ch.send({ embeds: [new EmbedBuilder().setTitle("🚨 Alerta").setColor(COLORS.danger).setDescription(message).setTimestamp()] }); } catch {}
}

function rateLimitMiddleware(req, res, next) {
    const openRoutes = ["/health", "/", "/dashboard", "/api/dashboard", "/auth/", "/api/admin/", "/api/buy", "/api/transactions", "/auth/me", "/api/online"];
    if (openRoutes.some(r => req.path.startsWith(r))) return next();
    const ip = getRealIP(req), now = Date.now();
    if (blockedIPs[ip]) { if (now < blockedIPs[ip]) return res.status(429).json({ status: "error", message: "IP bloqueado." }); delete blockedIPs[ip]; }
    if (!rateLimitMap[ip] || now - rateLimitMap[ip].windowStart > RATE_LIMIT_WINDOW) { rateLimitMap[ip] = { count: 1, windowStart: now }; return next(); }
    rateLimitMap[ip].count++;
    if (rateLimitMap[ip].count > RATE_LIMIT_MAX) { blockedIPs[ip] = now + BLOCK_DURATION; return res.status(429).json({ status: "error", message: "Muitas requisições." }); }
    next();
}

function requireClientHeader(req, res, next) {
    const header = req.headers["x-bob-client"], ua = (req.headers["user-agent"] || "").toLowerCase(), ip = getRealIP(req);
    if (!header || header !== CLIENT_HEADER) { logSecurityAlert(`⚠️ Acesso sem header de \`${ip}\``); return res.status(403).json({ status: "error", message: "Acesso negado." }); }
    if (BLOCKED_UA.some(b => ua.includes(b))) { blockedIPs[ip] = Date.now() + BLOCK_DURATION; return res.status(403).json({ status: "error", message: "Acesso negado." }); }
    next();
}

app.use(rateLimitMiddleware);

function requireAuth(req, res, next) {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Não autenticado" });
    try { req.user = jwt.verify(token, JWT_SECRET); next(); }
    catch (e) { return res.status(401).json({ error: "Token inválido ou expirado" }); }
}

function requireAdminAuth(req, res, next) { const pass = req.headers["x-admin-pass"] || req.query.pass; if (!safeCompare(pass, ADMIN_PASS)) return res.status(401).json({ error: "Sem permissão" }); next(); }

io.use((socket, next) => {
    const key = socket.handshake.auth?.key || socket.handshake.query?.key;
    const secret = socket.handshake.auth?.secret || socket.handshake.query?.secret;
    const hwid = socket.handshake.auth?.hwid || socket.handshake.query?.hwid;
    const header = socket.handshake.headers?.["x-bob-client"];
    if (!header || header !== CLIENT_HEADER) return next(new Error("Acesso negado."));
    const r = checkKey(key, secret, hwid);
    if (!r.ok) return next(new Error(r.error));
    socket.keyName = r.keyName; next();
});
io.on("connection", (socket) => { socket.on("disconnect", () => console.log(`[SOCKET] DC: ${socket.keyName}`)); });

function checkKey(key, secret, hwid) {
    if (secret !== SCRIPT_SECRET) return { ok: false, error: "Secret invalido" };
    const keyClean = (key || "").trim(), hwidClean = (hwid || "").trim() || null;
    const keyName = findKey(keyClean), data = keys[keyName];
    if (!data) return { ok: false, error: "Chave nao existe" };
    if (data.paused) return { ok: false, error: "Chave pausada" };
    if (data.expiry !== Infinity && data.expiry - Date.now() <= 0) { delete keys[keyName]; deleteKey(keyName); return { ok: false, error: "Chave expirada" }; }
    if (hwidClean) { if (!data.hwid) { data.hwid = hwidClean; saveKey(keyName); } else if (data.hwid !== hwidClean) return { ok: false, error: "HWID invalido" }; }
    return { ok: true, data, keyName };
}

async function confirmarPagamento(user, hours, channel, confirmedBy = "admin", price = null, label = null, couponUsed = null) {
    const expiresAt = Date.now() + hours * 3_600_000;
    const addMs = hours * 3_600_000;
    const existingKeyEntry = Object.entries(keys).find(([, d]) => d.discordId === String(user.id));

    if (existingKeyEntry) {
        const [existingName, existingData] = existingKeyEntry;
        if (existingData.paused) {
            if (existingData.isAutoKey && existingData.remaining === 0) {
                existingData.remaining = addMs;
                existingData.expiry = Date.now() + addMs;
                existingData.paused = false;
                existingData.isAutoKey = false;
            } else {
                existingData.remaining += addMs;
            }
        } else if (existingData.expiry !== Infinity) {
            existingData.expiry += addMs;
        }
        existingData.warnSent = false;
        await saveKey(existingName);
        const plan = PLANS.find(p => p.hours === hours);
        price = price || plan?.price || hours * 5;
        label = label || plan?.label || `${hours}h`;
        await SaleHistory.create({ discordId: String(user.id), discordTag: user.tag, hours, price, label, keyName: existingName, couponUsed, confirmedBy: String(confirmedBy) }).catch(() => {});
        fetchUserFromAnyClient(user.id).then(u => {
            if (!u) return;
            const timeLeft = existingData.expiry === Infinity ? "Lifetime ♾️" : tsRelative(existingData.expiry);
            u.send({ embeds: [new EmbedBuilder().setColor(COLORS.success).setTitle("🔄 Key Atualizada!").setDescription(`Sua key \`${existingName}\` foi atualizada!\n**+Tempo:** ${label}\n**Expira:** ${timeLeft}`).setTimestamp()] }).catch(() => {});
        }).catch(() => {});
        if (channel) channel.send({ embeds: [new EmbedBuilder().setColor(COLORS.success).setTitle("🔄 Renovação/Ativação").setDescription(`<@${user.id}> — \`${existingName}\` +${label}`).setTimestamp()] }).catch(() => {});
        return;
    }

    const keyName = generateBobKey();
    const plan = PLANS.find(p => p.hours === hours);
    price = price || plan?.price || hours * 5;
    label = label || plan?.label || `${hours}h`;
    keys[keyName] = { expiry: expiresAt, paused: false, remaining: addMs, hwid: null, discordId: String(user.id), warnSent: false, isAutoKey: false };
    await saveKey(keyName);
    await SaleHistory.create({ discordId: String(user.id), discordTag: user.tag, hours, price, label, keyName, couponUsed, confirmedBy: String(confirmedBy) }).catch(() => {});
    fetchUserFromAnyClient(user.id).then(u => {
        if (u) u.send({ embeds: [new EmbedBuilder().setColor(COLORS.success).setTitle("🎉 Pagamento Confirmado!").setDescription(`**🔑 Sua Key:**\n\`\`\`${keyName}\`\`\`\n**Plano:** ${label}\n**Expira:** ${tsRelative(expiresAt)}`).setTimestamp()] }).catch(() => {});
    });
    if (channel) channel.send({ embeds: [new EmbedBuilder().setColor(COLORS.success).setTitle("✅ Key Gerada").setDescription(`<@${user.id}> — \`${keyName}\` — ${label}`).setTimestamp()] }).catch(() => {});
    console.log(`[PAYMENT] ✅ Key gerada: ${keyName} (${hours}h)`);
}

async function opCreateKey(name, durationMs) { if (findKey(name)) return { ok: false, msg: `❌ \`${name}\` já existe!` }; if (durationMs <= 0) return { ok: false, msg: "❌ Duração inválida!" }; keys[name] = { expiry: Date.now() + durationMs, paused: false, remaining: durationMs, hwid: null, discordId: null, warnSent: false, isAutoKey: false }; await saveKey(name); return { ok: true, msg: `✅ \`${name}\` criada! **${formatTime(durationMs)}**` }; }
async function opCreateLifetime(name) { if (findKey(name)) return { ok: false, msg: `❌ \`${name}\` já existe!` }; keys[name] = { expiry: Infinity, paused: false, remaining: Infinity, hwid: null, discordId: null, warnSent: false, isAutoKey: false }; await saveKey(name); return { ok: true, msg: `✅ \`${name}\` Lifetime ♾️` }; }
async function opRevokeKey(name) { if (name.toLowerCase() === "all") { const count = Object.keys(keys).length; for (const k of Object.keys(keys)) { delete keys[k]; await deleteKey(k); } return { ok: true, msg: `🗑️ **${count}** removidas.` }; } const t = findKey(name); if (!t) return { ok: false, msg: "❌ Não encontrada." }; delete keys[t]; await deleteKey(t); return { ok: true, msg: `🗑️ \`${t}\` removida.` }; }
async function opTogglePause(name) { if (name.toLowerCase() === "all") { let p = 0, r = 0; for (const k of Object.keys(keys)) { const d = keys[k]; if (d.paused) { d.expiry = Date.now() + d.remaining; d.paused = false; r++; } else { d.remaining = d.expiry === Infinity ? Infinity : d.expiry - Date.now(); d.paused = true; p++; } await saveKey(k); } return { ok: true, msg: `⏸️ ${p} pausadas, ${r} retomadas.` }; } const t = findKey(name); if (!t) return { ok: false, msg: "❌ Não encontrada." }; const d = keys[t]; if (d.paused) { d.expiry = Date.now() + d.remaining; d.paused = false; await saveKey(t); return { ok: true, msg: `▶️ \`${t}\` retomada!` }; } d.remaining = d.expiry === Infinity ? Infinity : d.expiry - Date.now(); d.paused = true; await saveKey(t); return { ok: true, msg: `⏸️ \`${t}\` pausada!` }; }
async function opResetHwid(name) { if (name.toLowerCase() === "all") { let count = 0; for (const k of Object.keys(keys)) { keys[k].hwid = null; kicked[k.toLowerCase()] = Date.now(); await saveKey(k); count++; } return { ok: true, msg: `✅ HWID de **${count}** resetado!` }; } const t = findKey(name); if (!t) return { ok: false, msg: "❌ Não encontrada." }; keys[t].hwid = null; kicked[t.toLowerCase()] = Date.now(); await saveKey(t); return { ok: true, msg: `✅ HWID de \`${t}\` resetado!` }; }
async function opAddTime(name, extraMs) { if (extraMs <= 0) return { ok: false, msg: "❌ Tempo inválido!" }; if (name.toLowerCase() === "all") { let count = 0; for (const k of Object.keys(keys)) { const d = keys[k]; if (d.paused) d.remaining += extraMs; else if (d.expiry !== Infinity) d.expiry += extraMs; d.warnSent = false; await saveKey(k); count++; } return { ok: true, msg: `✅ **${formatTime(extraMs)}** adicionado a **${count}**!` }; } const t = findKey(name); if (!t) return { ok: false, msg: "❌ Não encontrada." }; const d = keys[t]; if (d.paused) d.remaining += extraMs; else if (d.expiry !== Infinity) d.expiry += extraMs; d.warnSent = false; await saveKey(t); return { ok: true, msg: `✅ **${formatTime(extraMs)}** adicionado a \`${t}\`!` }; }
async function opSetExpiry(name, durationMs) { if (durationMs <= 0) return { ok: false, msg: "❌ Duração inválida!" }; const t = findKey(name); if (!t) return { ok: false, msg: "❌ Não encontrada." }; const d = keys[t]; if (d.paused) d.remaining = durationMs; else { d.expiry = Date.now() + durationMs; d.remaining = durationMs; } d.warnSent = false; await saveKey(t); return { ok: true, msg: `✅ Expiração de \`${t}\` → **${formatTime(durationMs)}**!` }; }

// ─── DISCORD OAUTH2 ───────────────────────────────────────────────────────────
app.get("/auth/discord", (req, res) => {
    const params = new URLSearchParams({ client_id: DISCORD_CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: "code", scope: "identify" });
    res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

app.get("/auth/callback", async (req, res) => {
    const { code } = req.query;
    if (!code) return res.redirect(`${FRONTEND_URL}?error=no_code`);
    try {
        const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
            method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ client_id: DISCORD_CLIENT_ID, client_secret: DISCORD_CLIENT_SECRET, grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI }),
        });
        const tokenData = await tokenRes.json();
        if (!tokenData.access_token) return res.redirect(`${FRONTEND_URL}?error=token`);
        const userRes = await fetch("https://discord.com/api/users/@me", { headers: { Authorization: `Bearer ${tokenData.access_token}` } });
        const discordUser = await userRes.json();
        await User.findOneAndUpdate({ discordId: discordUser.id }, { discordTag: discordUser.username, avatar: discordUser.avatar }, { upsert: true, new: true });
        const autoKeyName = await createAutoKeyForUser(discordUser.id, discordUser.username);
        console.log(`[AUTH] Key do usuário ${discordUser.username}: ${autoKeyName}`);
        const token = jwt.sign({ discordId: discordUser.id, discordTag: discordUser.username, avatar: discordUser.avatar }, JWT_SECRET, { expiresIn: "7d" });
        res.redirect(`${FRONTEND_URL}/?token=${token}`);
    } catch (e) { console.error("[AUTH]", e.message); res.redirect(`${FRONTEND_URL}?error=auth_failed`); }
});

app.get("/auth/logout", (req, res) => { res.json({ ok: true }); });

app.get("/auth/me", requireAuth, async (req, res) => {
    const user = await User.findOne({ discordId: req.user.discordId });
    if (!user) return res.status(404).json({ error: "Usuário não encontrado" });
    const keyEntry = Object.entries(keys).find(([, d]) => d.discordId === user.discordId);
    let keyData = null;
    if (keyEntry) {
        const [keyName, kd] = keyEntry;
        const now = Date.now();
        const hasTime = kd.expiry === Infinity || (!kd.paused && kd.expiry - now > 0) || (kd.paused && kd.remaining > 0);
        keyData = {
            name: keyName,
            expiry: kd.expiry === Infinity ? null : kd.expiry,
            expiryMs: kd.expiry === Infinity ? null : kd.expiry - now,
            paused: kd.paused,
            isAutoKey: kd.isAutoKey || false,
            hasTime,
            timeLeft: kd.expiry === Infinity ? "Lifetime" : kd.paused ? formatTime(kd.remaining) : formatTime(kd.expiry - now),
        };
    }
    res.json({ discordId: user.discordId, discordTag: user.discordTag, avatar: user.avatar, balance: user.balance, key: keyData, plans: PLANS.filter(p => p.active) });
});

app.get("/api/online", (req, res) => {
    const now = Date.now();
    const onlineByKey = {};
    for (const [, info] of Object.entries(presence)) {
        if (now - info.lastSeen > ONLINE_STALE_MS) continue;
        const keyName = info.key ? findKey(info.key) : null;
        if (keyName && !onlineByKey[keyName]) onlineByKey[keyName] = { name: info.name || "Unknown" };
    }
    const onlineUsers = [];
    for (const [keyName, info] of Object.entries(onlineByKey)) {
        const d = keys[keyName];
        if (!d) continue;
        onlineUsers.push({
            keyPrefix: keyName.substring(0, 7) + "***",
            robloxName: info.name,
            expiryMs: d.expiry === Infinity ? null : d.expiry - now,
            isLifetime: d.expiry === Infinity,
            paused: d.paused,
        });
    }
    res.json({ online: onlineUsers, count: onlineUsers.length, maxSlots: MAX_SLOTS, slotsUsed: onlineUsers.length, slotsAvailable: Math.max(0, MAX_SLOTS - onlineUsers.length), serverTime: now });
});

app.post("/api/buy", requireAuth, async (req, res) => {
    const { planValue } = req.body;
    const plan = PLANS.find(p => p.value === planValue && p.active);
    if (!plan) return res.status(400).json({ error: "Plano inválido" });
    const user = await User.findOne({ discordId: req.user.discordId });
    if (!user) return res.status(404).json({ error: "Usuário não encontrado" });
    if (user.balance < plan.price) return res.status(400).json({ error: "Saldo insuficiente" });
    user.balance -= plan.price; await user.save();
    await confirmarPagamento({ id: user.discordId, tag: user.discordTag }, plan.hours, null, "auto", plan.price, plan.label, null);
    await Transaction.create({ discordId: user.discordId, type: "purchase", amount: -plan.price, description: `Compra: ${plan.label}` });
    res.json({ ok: true, newBalance: user.balance, plan: plan.label });
});

app.get("/api/transactions", requireAuth, async (req, res) => {
    const transactions = await Transaction.find({ discordId: req.user.discordId }).sort({ createdAt: -1 }).limit(20);
    res.json(transactions);
});

// ─── RECARGA PIX MANUAL ───────────────────────────────────────────────────────
app.post("/api/recharge/create", requireAuth, async (req, res) => {
    const { amount } = req.body;
    if (!amount || isNaN(amount) || amount < MIN_RECHARGE) {
        return res.status(400).json({ error: `Valor mínimo é R$${MIN_RECHARGE}` });
    }
    const user = await User.findOne({ discordId: req.user.discordId });
    if (!user) return res.status(404).json({ error: "Usuário não encontrado" });

    // Cancela recargas pendentes antigas do mesmo usuário
    await Recharge.updateMany({ discordId: req.user.discordId, status: "pending" }, { status: "cancelled" });

    const code = generateRechargeCode();
    await Recharge.create({ discordId: req.user.discordId, discordTag: user.discordTag, amount: Number(amount), code });

    // Notifica no Discord
    try {
        const ch = await clientPayment.channels.fetch(RECHARGE_CHANNEL);
        if (ch) {
            const embed = new EmbedBuilder()
                .setColor(COLORS.info)
                .setTitle("💸 Nova Solicitação de Recarga")
                .addFields(
                    { name: "👤 Usuário", value: `${user.discordTag} (<@${user.discordId}>)`, inline: true },
                    { name: "💰 Valor", value: `**R$${Number(amount).toFixed(2)}**`, inline: true },
                    { name: "🔑 Código", value: `\`${code}\``, inline: true },
                    { name: "📋 Instrução", value: `Verifique o Pix recebido com o código **${code}** na descrição e confirme abaixo.`, inline: false }
                )
                .setTimestamp();
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`recharge_confirm_${code}`).setLabel("✅ Confirmar Pagamento").setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(`recharge_cancel_${code}`).setLabel("❌ Cancelar").setStyle(ButtonStyle.Danger),
            );
            await ch.send({ embeds: [embed], components: [row] });
        }
    } catch(e) { console.error("[RECHARGE] Erro ao notificar Discord:", e.message); }

    res.json({ ok: true, code, amount: Number(amount), pixKey: PIX_KEY, pixName: PIX_NAME });
});

app.get("/api/recharge/status", requireAuth, async (req, res) => {
    const recharge = await Recharge.findOne({ discordId: req.user.discordId, status: "pending" }).sort({ createdAt: -1 });
    res.json(recharge ? { pending: true, code: recharge.code, amount: recharge.amount, createdAt: recharge.createdAt } : { pending: false });
});

app.post("/api/admin/balance", requireAdminAuth, async (req, res) => {
    const { discordId, amount, description } = req.body;
    if (!discordId || !amount) return res.status(400).json({ error: "Dados inválidos" });
    const user = await User.findOneAndUpdate({ discordId }, { $inc: { balance: Number(amount) } }, { new: true });
    if (!user) return res.status(404).json({ error: "Usuário não encontrado. Peça para ele logar primeiro." });
    await Transaction.create({ discordId, type: "deposit", amount: Number(amount), description: description || "Depósito admin" });
    res.json({ ok: true, newBalance: user.balance, discordTag: user.discordTag });
});

app.post("/api/admin/slots", requireAdminAuth, async (req, res) => {
    const { maxSlots } = req.body;
    if (!maxSlots || isNaN(maxSlots) || maxSlots < 1) return res.status(400).json({ error: "Valor inválido" });
    process.env.MAX_SLOTS = String(maxSlots);
    res.json({ ok: true, maxSlots: parseInt(maxSlots) });
});

app.get("/api/admin/users", requireAdminAuth, async (req, res) => {
    const users = await User.find().sort({ createdAt: -1 });
    res.json(users.map(u => { const keyEntry = Object.entries(keys).find(([, d]) => d.discordId === u.discordId); return { discordId: u.discordId, discordTag: u.discordTag, balance: u.balance, hasKey: !!keyEntry, keyName: keyEntry?.[0] || null, createdAt: u.createdAt }; }));
});

// ─── BOTS (mesmos do original) ────────────────────────────────────────────────
const clientNotifier = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildWebhooks] });
clientNotifier.on("ready", () => console.log(`[NOTIFIER] Online: ${clientNotifier.user.tag}`));
clientNotifier.on("messageCreate", async (message) => {
    if (message.author.bot && message.author.id === clientNotifier.user?.id) return;
    if (message.channel.id !== DISCORD_CHANNEL_ID) return;
    if (!message.embeds.length) return;
    const embed = message.embeds[0]; let jobId = null, value = "0", players = "N/A";
    for (const f of (embed.fields || [])) { const fn = f.name.toLowerCase(); if (fn.includes("jobid") || fn.includes("job")) jobId = f.value.trim(); if (fn.includes("value") || fn.includes("valor")) value = f.value.trim(); if (fn.includes("player")) players = f.value.trim(); }
    pushBrainrot({ id: Date.now().toString(), title: embed.title || "Bob!", description: embed.description || "Novo!", brainrot: embed.title || "Brainrot", name: embed.title || "Brainrot", jobId: xorObfuscate(jobId), value, players });
});

const clientLogs = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
clientLogs.on("ready", async () => { console.log(`[LOGS] Online: ${clientLogs.user.tag}`); await sendLogsPanel(); });

function buildLogsEmbed() { return new EmbedBuilder().setTitle("⚙️ Bob Joiner — Painel Administrativo").setColor(COLORS.primary).setDescription("Gerencie keys, pagamentos, cupons e planos.").setTimestamp(); }
function buildLogsRows() {
    return [
        new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("logs_create").setLabel("Criar Key").setEmoji("🔑").setStyle(ButtonStyle.Success),new ButtonBuilder().setCustomId("logs_lifetime").setLabel("Lifetime").setEmoji("♾️").setStyle(ButtonStyle.Success),new ButtonBuilder().setCustomId("logs_revoke").setLabel("Revogar").setEmoji("🗑️").setStyle(ButtonStyle.Danger),new ButtonBuilder().setCustomId("logs_pause").setLabel("Pausar").setEmoji("⏸️").setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId("logs_reset").setLabel("Reset HWID").setEmoji("🔄").setStyle(ButtonStyle.Secondary)),
        new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("logs_addtime").setLabel("Add Tempo").setEmoji("⏱️").setStyle(ButtonStyle.Primary),new ButtonBuilder().setCustomId("logs_setexpiry").setLabel("Set Expiração").setEmoji("📅").setStyle(ButtonStyle.Primary),new ButtonBuilder().setCustomId("logs_transfer").setLabel("Transfer").setEmoji("🔀").setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId("logs_sethwid").setLabel("Set HWID").setEmoji("💻").setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId("logs_lookup").setLabel("Lookup").setEmoji("🔍").setStyle(ButtonStyle.Secondary)),
        new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("logs_online").setLabel("Online").setEmoji("🟢").setStyle(ButtonStyle.Success),new ButtonBuilder().setCustomId("logs_stoponline").setLabel("Stop Online").setEmoji("⏹️").setStyle(ButtonStyle.Danger),new ButtonBuilder().setCustomId("logs_stats").setLabel("Stats").setEmoji("📊").setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId("logs_info").setLabel("Listar Keys").setEmoji("📋").setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId("logs_jobids").setLabel("JobIDs").setEmoji("🎮").setStyle(ButtonStyle.Secondary)),
        new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("logs_pendentes").setLabel("Pendentes").setEmoji("⏳").setStyle(ButtonStyle.Primary),new ButtonBuilder().setCustomId("logs_confirmar_manual").setLabel("Confirmar Pgto").setEmoji("💳").setStyle(ButtonStyle.Success),new ButtonBuilder().setCustomId("logs_cancelar_pedido").setLabel("Cancelar Pedido").setEmoji("❌").setStyle(ButtonStyle.Danger),new ButtonBuilder().setCustomId("logs_vendas").setLabel("Vendas").setEmoji("💰").setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId("logs_historico").setLabel("Histórico").setEmoji("📜").setStyle(ButtonStyle.Secondary)),
        new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("logs_coupon_create").setLabel("Criar Cupom").setEmoji("🎟️").setStyle(ButtonStyle.Success),new ButtonBuilder().setCustomId("logs_coupon_list").setLabel("Listar Cupons").setEmoji("📋").setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId("logs_plan_edit").setLabel("Editar Plano").setEmoji("📦").setStyle(ButtonStyle.Primary),new ButtonBuilder().setCustomId("logs_blocked").setLabel("IPs Bloqueados").setEmoji("🔒").setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId("logs_unblock").setLabel("Desbloquear IP").setEmoji("🔓").setStyle(ButtonStyle.Primary)),
    ];
}

async function sendLogsPanel() {
    const channelId = BOB_LOGS_PANEL_CHANNEL || LOGS_CHANNEL_ID; if (!channelId) return;
    try { const ch = await clientLogs.channels.fetch(channelId); if (!ch) return; const msgs = await ch.messages.fetch({ limit: 20 }); for (const [, msg] of msgs) { if (msg.author.id === clientLogs.user.id) await msg.delete().catch(() => {}); } await ch.send({ embeds: [buildLogsEmbed()], components: buildLogsRows() }); } catch (e) { console.error("[LOGS] Erro:", e.message); }
}

function buildOnlineEmbed() {
    const now = Date.now(), robloxByKey = {};
    for (const [, info] of Object.entries(presence)) { const keyName = info.key ? findKey(info.key) : null; if (keyName && !robloxByKey[keyName] && now - info.lastSeen < PRESENCE_TTL) robloxByKey[keyName] = info.name || null; }
    const activeKeys = Object.entries(keys).filter(([, d]) => !d.isAutoKey || d.remaining > 0).filter(([, d]) => d.paused || d.expiry === Infinity || d.expiry - now > 0);
    const onlineCount = Object.values(robloxByKey).length;
    const embed = new EmbedBuilder().setTitle(`📋 Keys — ${activeKeys.length} | 🟢 ${onlineCount} online`).setColor(onlineCount > 0 ? COLORS.success : COLORS.primary).setTimestamp();
    if (!activeKeys.length) { embed.setDescription("Nenhuma key ativa."); return embed; }
    embed.setDescription(activeKeys.map(([keyName, d]) => `${d.paused ? "⏸️" : (robloxByKey[keyName] ? "🟢" : "✅")} ${d.discordId ? `<@${d.discordId}>` : "*(sem Discord)*"} **(${robloxByKey[keyName] || "—"})** — \`${d.paused ? formatTime(d.remaining) : (d.expiry === Infinity ? "Lifetime ♾️" : formatTime(d.expiry - now))}\``).join("\n").substring(0, 4000));
    return embed;
}

function isAdmin(member) { return ADMIN_ROLE_IDS.some(id => member?.roles?.cache?.has(id)); }
if (!global.onlineIntervals) global.onlineIntervals = {};
function startOnlineInterval(channelId, messageObj) { stopOnlineInterval(channelId); global.onlineIntervals[channelId] = setInterval(async () => { await messageObj.edit({ embeds: [buildOnlineEmbed()] }).catch(() => stopOnlineInterval(channelId)); }, 60_000); }
function stopOnlineInterval(channelId) { if (global.onlineIntervals[channelId]) { clearInterval(global.onlineIntervals[channelId]); delete global.onlineIntervals[channelId]; } }

clientLogs.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isModalSubmit()) { await handleLogsModal(interaction); return; }
    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith("logs_") && !interaction.customId.startsWith("pay_")) return;
    if (!isAdmin(interaction.member)) { await interaction.reply({ content: "❌ Sem permissão.", flags: 64 }); return; }
    const id = interaction.customId;
    if (id === "logs_online") { await interaction.deferReply({ ephemeral: false }); const sentMsg = await interaction.editReply({ embeds: [buildOnlineEmbed()] }); startOnlineInterval(interaction.channelId, sentMsg); return; }
    if (id === "logs_stoponline") { await interaction.deferReply({ flags: 64 }); stopOnlineInterval(interaction.channelId); await interaction.editReply({ content: "⏹️ Parado." }); return; }
    if (id === "logs_stats") { await interaction.deferReply({ flags: 64 }); const all = Object.values(keys).filter(k => !k.isAutoKey || k.remaining > 0), active = all.filter(k => !k.paused && (k.expiry === Infinity || k.expiry - Date.now() > 0)), paused = all.filter(k => k.paused), lt = all.filter(k => k.expiry === Infinity), online = Object.values(presence).filter(p => Date.now() - p.lastSeen < ONLINE_STALE_MS); const pendentes = await PendingPayment.countDocuments(), totalVendas = await SaleHistory.aggregate([{ $group: { _id: null, total: { $sum: "$price" } } }]); await interaction.editReply({ embeds: [new EmbedBuilder().setTitle("📊 Stats").setColor(COLORS.primary).addFields({ name: "🔑 Total", value: `\`${all.length}\``, inline: true },{ name: "✅ Ativas", value: `\`${active.length}\``, inline: true },{ name: "⏸️ Pausadas", value: `\`${paused.length}\``, inline: true },{ name: "♾️ Lifetime", value: `\`${lt.length}\``, inline: true },{ name: "🟢 Online", value: `\`${online.length}\``, inline: true },{ name: "⏳ Pendentes", value: `\`${pendentes}\``, inline: true },{ name: "💰 Receita", value: `\`R$${totalVendas[0]?.total || 0}\``, inline: true }).setTimestamp()] }); return; }
    if (id === "logs_info") { await interaction.deferReply({ flags: 64 }); const ks = Object.keys(keys); if (!ks.length) { await interaction.editReply({ content: "Nenhuma key." }); return; } const now = Date.now(); await interaction.editReply({ embeds: [new EmbedBuilder().setTitle("🔑 Keys").setColor(COLORS.primary).setDescription(ks.map(k => { const d = keys[k], t = d.paused ? d.remaining : (d.expiry === Infinity ? Infinity : d.expiry - now); return `• \`${k}\`: \`${formatTime(t)}\` ${d.paused ? "⏸️" : "✅"} ${d.discordId ? `<@${d.discordId}>` : ""}`; }).join("\n").substring(0, 4000)).setTimestamp()] }); return; }
    if (id === "logs_jobids") { await interaction.deferReply({ flags: 64 }); const entries = Object.entries(userJobIds); if (!entries.length) { await interaction.editReply({ content: "Nenhum JobID." }); return; } await interaction.editReply({ content: "🎮 **JobIDs:**\n" + entries.map(([n, j]) => `• **${n}**: \`${j}\``).join("\n") }); return; }
    if (id === "logs_blocked") { await interaction.deferReply({ flags: 64 }); const now = Date.now(), active = Object.entries(blockedIPs).filter(([, u]) => now < u); if (!active.length) { await interaction.editReply({ content: "Nenhum IP bloqueado." }); return; } await interaction.editReply({ content: "🔒 **IPs:**\n" + active.map(([ip, u]) => `• \`${ip}\` — ${Math.ceil((u - now) / 1000)}s`).join("\n") }); return; }
    if (id === "logs_pendentes") { await interaction.deferReply({ flags: 64 }); const pendentes = await PendingPayment.find().sort({ createdAt: -1 }); if (!pendentes.length) { await interaction.editReply({ content: "✅ Nenhum pendente!" }); return; } const now = Date.now(); await interaction.editReply({ embeds: [new EmbedBuilder().setColor(COLORS.warning).setTitle(`⏳ Pendentes (${pendentes.length})`).setDescription(pendentes.map(p => { const rem = PENDING_EXPIRY_MS - (now - new Date(p.createdAt).getTime()); return `• **${p.discordTag}** — ${p.label} R$${p.finalPrice || p.price} — ⏳ ${rem > 0 ? formatTimeShort(rem) : "expirando..."}`; }).join("\n")).setTimestamp()] }); return; }
    if (id === "logs_confirmar_manual") { await interaction.showModal(new ModalBuilder().setCustomId("modal_pay_confirm").setTitle("Confirmar Pagamento").addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("user_id").setLabel("ID Discord:").setStyle(TextInputStyle.Short).setRequired(true)),new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("horas").setLabel("Horas:").setStyle(TextInputStyle.Short).setRequired(true)))); return; }
    if (id === "logs_cancelar_pedido") { await interaction.showModal(new ModalBuilder().setCustomId("modal_cancel_pedido").setTitle("Cancelar Pedido").addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("user_id").setLabel("ID Discord:").setStyle(TextInputStyle.Short).setRequired(true)),new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("motivo").setLabel("Motivo:").setStyle(TextInputStyle.Short).setRequired(false)))); return; }
    if (id === "logs_vendas") { await interaction.deferReply({ flags: 64 }); const sales = await SaleHistory.find().sort({ confirmedAt: -1 }), totalR = sales.reduce((a, s) => a + (s.price || 0), 0), hoje = sales.filter(s => new Date(s.confirmedAt).toDateString() === new Date().toDateString()), hojeR = hoje.reduce((a, s) => a + (s.price || 0), 0); await interaction.editReply({ embeds: [new EmbedBuilder().setColor(COLORS.success).setTitle("💰 Vendas").addFields({ name: "📦 Total", value: `\`${sales.length}\``, inline: true },{ name: "💰 Receita", value: `\`R$${totalR}\``, inline: true },{ name: "📅 Hoje", value: `\`${hoje.length}\``, inline: true },{ name: "💵 Hoje R$", value: `\`R$${hojeR}\``, inline: true }).setTimestamp()] }); return; }
    if (id === "logs_historico") { await interaction.deferReply({ flags: 64 }); const sales = await SaleHistory.find().sort({ confirmedAt: -1 }).limit(20); if (!sales.length) { await interaction.editReply({ content: "Nenhuma venda." }); return; } await interaction.editReply({ embeds: [new EmbedBuilder().setColor(COLORS.success).setTitle("📜 Histórico").setDescription(sales.map(s => `• <@${s.discordId}> — **${s.label}** R$${s.price} — \`${s.keyName}\` — ${tsRelative(s.confirmedAt)}`).join("\n").substring(0, 4000)).setTimestamp()] }); return; }
    if (id === "logs_coupon_create") { await interaction.showModal(new ModalBuilder().setCustomId("modal_coupon_create").setTitle("🎟️ Criar Cupom").addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("code").setLabel("Código:").setStyle(TextInputStyle.Short).setRequired(true)),new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("discount").setLabel("Desconto:").setStyle(TextInputStyle.Short).setRequired(true)),new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("type").setLabel("Tipo (percent/fixed):").setStyle(TextInputStyle.Short).setRequired(true)),new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("maxuses").setLabel("Máx usos:").setStyle(TextInputStyle.Short).setRequired(true)),new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("key_pass").setLabel("Senha:").setStyle(TextInputStyle.Short).setRequired(true)))); return; }
    if (id === "logs_coupon_list") { await interaction.deferReply({ flags: 64 }); const coupons = await Coupon.find({ active: true }); if (!coupons.length) { await interaction.editReply({ content: "Nenhum cupom." }); return; } await interaction.editReply({ embeds: [new EmbedBuilder().setColor(COLORS.gold).setTitle("🎟️ Cupons").setDescription(coupons.map(c => `• \`${c.code}\` — **${c.discount}${c.type === "percent" ? "%" : " R$"}** — ${c.usedCount}/${c.maxUses}`).join("\n")).setTimestamp()] }); return; }
    if (id === "logs_plan_edit") { await interaction.showModal(new ModalBuilder().setCustomId("modal_plan_edit").setTitle("📦 Editar Plano").addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("value").setLabel("ID do plano:").setStyle(TextInputStyle.Short).setRequired(true)),new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("price").setLabel("Preço:").setStyle(TextInputStyle.Short).setRequired(true)),new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("active").setLabel("Ativo? (sim/nao):").setStyle(TextInputStyle.Short).setRequired(true)),new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("key_pass").setLabel("Senha:").setStyle(TextInputStyle.Short).setRequired(true)))); return; }
    if (id.startsWith("pay_confirm_")) { await interaction.deferReply({ flags: 64 }); const parts = id.split("_"), targetId = parts[2], hours = parseInt(parts[3]); const pending = await PendingPayment.findOne({ discordId: targetId }); const target = await fetchUserFromAnyClient(targetId); if (!target) { await interaction.editReply({ content: "❌ Não encontrado!" }); return; } await confirmarPagamento(target, hours, interaction.channel, interaction.user.id, pending?.finalPrice || pending?.price, pending?.label, pending?.couponUsed); if (pending?.couponUsed) await consumeCoupon(pending.couponUsed, targetId); await PendingPayment.deleteOne({ discordId: targetId }); await interaction.editReply({ content: `✅ Confirmado!` }); return; }
    if (id.startsWith("pay_cancel_")) { await interaction.deferReply({ flags: 64 }); const targetId = id.replace("pay_cancel_", ""); const pending = await PendingPayment.findOne({ discordId: targetId }); if (!pending) { await interaction.editReply({ content: "❌ Não encontrado." }); return; } await PendingPayment.deleteOne({ discordId: targetId }); await interaction.editReply({ content: `🗑️ Cancelado.` }); return; }
    const modalMap = { logs_create: buildModal_create, logs_lifetime: buildModal_lifetime, logs_revoke: buildModal_revoke, logs_pause: buildModal_pause, logs_reset: buildModal_reset, logs_addtime: buildModal_addtime, logs_setexpiry: buildModal_setexpiry, logs_transfer: buildModal_transfer, logs_sethwid: buildModal_sethwid, logs_lookup: buildModal_lookup, logs_unblock: buildModal_unblock, logs_cleanlogs: buildModal_cleanlogs };
    if (modalMap[id]) await interaction.showModal(modalMap[id]());
});

async function handleLogsModal(interaction) {
    await interaction.deferReply({ flags: 64 });
    const id = interaction.customId;
    const getField = (name) => { try { return interaction.fields.getTextInputValue(name); } catch { return ""; } };
    const getTime = () => { const h = parseInt(getField("key_h")) || 0, m = parseInt(getField("key_m")) || 0; return (h * 3600 + m * 60) * 1000; };
    if (id === "modal_pay_confirm") { const userId = getField("user_id").trim(), hours = parseInt(getField("horas").trim()); if (isNaN(hours) || hours <= 0) { await interaction.editReply({ content: "❌ Horas inválidas!" }); return; } const pending = await PendingPayment.findOne({ discordId: userId }); const target = await fetchUserFromAnyClient(userId); if (!target) { await interaction.editReply({ content: "❌ Não encontrado!" }); return; } await confirmarPagamento(target, hours, interaction.channel, interaction.user.id, pending?.finalPrice || pending?.price, pending?.label, pending?.couponUsed); if (pending?.couponUsed) await consumeCoupon(pending.couponUsed, userId); await PendingPayment.deleteOne({ discordId: userId }); await interaction.editReply({ content: `✅ Key gerada!` }); return; }
    if (id === "modal_cancel_pedido") { const userId = getField("user_id").replace(/\D/g, ""), motivo = getField("motivo").trim() || "Sem motivo"; const pending = await PendingPayment.findOne({ discordId: userId }); if (!pending) { await interaction.editReply({ content: "❌ Não encontrado." }); return; } await PendingPayment.deleteOne({ discordId: userId }); await interaction.editReply({ content: `🗑️ Cancelado. Motivo: *${motivo}*` }); return; }
    if (id === "modal_coupon_create") { if (wrongPass(getField("key_pass"))) { await interaction.editReply({ content: "❌ Senha incorreta!" }); return; } const code = getField("code").trim().toUpperCase(), discount = parseFloat(getField("discount").trim()), type = getField("type").trim().toLowerCase() === "fixed" ? "fixed" : "percent", maxUses = parseInt(getField("maxuses").trim()) || 1; if (!code || isNaN(discount)) { await interaction.editReply({ content: "❌ Dados inválidos!" }); return; } const existing = await Coupon.findOne({ code }); if (existing) { await interaction.editReply({ content: `❌ \`${code}\` já existe!` }); return; } await Coupon.create({ code, discount, type, maxUses }); await interaction.editReply({ content: `✅ Cupom \`${code}\` criado!` }); return; }
    if (id === "modal_plan_edit") { if (wrongPass(getField("key_pass"))) { await interaction.editReply({ content: "❌ Senha incorreta!" }); return; } const value = getField("value").trim().toLowerCase(), price = parseFloat(getField("price").trim()), activeRaw = getField("active").trim().toLowerCase(), active = activeRaw === "sim" || activeRaw === "yes" || activeRaw === "true"; const plan = PLANS.find(p => p.value === value); if (!plan) { await interaction.editReply({ content: `❌ Plano \`${value}\` não encontrado.` }); return; } if (!isNaN(price)) plan.price = price; plan.active = active; await PlanModel.findOneAndUpdate({ value }, { price: plan.price, active }, { upsert: true }); await interaction.editReply({ content: `✅ Plano \`${value}\` atualizado!` }); return; }
    if (id === "modal_create") { if (wrongPass(getField("key_pass"))) { await interaction.editReply({ content: "❌ Senha incorreta!" }); return; } await interaction.editReply({ content: (await opCreateKey(getField("key_name").trim(), getTime())).msg }); return; }
    if (id === "modal_lifetime") { if (wrongPass(getField("key_pass"))) { await interaction.editReply({ content: "❌ Senha incorreta!" }); return; } await interaction.editReply({ content: (await opCreateLifetime(getField("key_name").trim())).msg }); return; }
    if (id === "modal_revoke") { if (wrongPass(getField("key_pass"))) { await interaction.editReply({ content: "❌ Senha incorreta!" }); return; } await interaction.editReply({ content: (await opRevokeKey(getField("key_name").trim())).msg }); return; }
    if (id === "modal_pause") { if (wrongPass(getField("key_pass"))) { await interaction.editReply({ content: "❌ Senha incorreta!" }); return; } await interaction.editReply({ content: (await opTogglePause(getField("key_name").trim())).msg }); return; }
    if (id === "modal_reset") { if (wrongPass(getField("key_pass"))) { await interaction.editReply({ content: "❌ Senha incorreta!" }); return; } await interaction.editReply({ content: (await opResetHwid(getField("key_name").trim())).msg }); return; }
    if (id === "modal_addtime") { if (wrongPass(getField("key_pass"))) { await interaction.editReply({ content: "❌ Senha incorreta!" }); return; } await interaction.editReply({ content: (await opAddTime(getField("key_name").trim(), getTime())).msg }); return; }
    if (id === "modal_setexpiry") { if (wrongPass(getField("key_pass"))) { await interaction.editReply({ content: "❌ Senha incorreta!" }); return; } await interaction.editReply({ content: (await opSetExpiry(getField("key_name").trim(), getTime())).msg }); return; }
    if (id === "modal_transfer") { if (wrongPass(getField("key_pass"))) { await interaction.editReply({ content: "❌ Senha incorreta!" }); return; } const oldName = getField("key_old").trim(), newName = getField("key_new").trim(); const t = findKey(oldName); if (!t) { await interaction.editReply({ content: "❌ Não encontrada." }); return; } if (findKey(newName)) { await interaction.editReply({ content: `❌ \`${newName}\` já existe!` }); return; } keys[newName] = { ...keys[t] }; delete keys[t]; await deleteKey(t); await saveKey(newName); await interaction.editReply({ content: `✅ \`${t}\` → \`${newName}\`!` }); return; }
    if (id === "modal_sethwid") { if (wrongPass(getField("key_pass"))) { await interaction.editReply({ content: "❌ Senha incorreta!" }); return; } const t = findKey(getField("key_name").trim()); if (!t) { await interaction.editReply({ content: "❌ Não encontrada." }); return; } keys[t].hwid = getField("key_hwid").trim() || null; await saveKey(t); await interaction.editReply({ content: `✅ HWID definido!` }); return; }
    if (id === "modal_lookup") { const t = findKey(getField("key_name").trim()); if (!t) { await interaction.editReply({ content: "❌ Não encontrada." }); return; } const d = keys[t]; await interaction.editReply({ embeds: [new EmbedBuilder().setTitle(`🔍 ${t}`).setColor(d.paused ? COLORS.warning : COLORS.success).addFields({ name: "⏱️ Tempo", value: d.expiry === Infinity ? "Lifetime ♾️" : formatTime(d.expiry - Date.now()), inline: true },{ name: "📌 Status", value: d.paused ? "⏸️ Pausada" : "✅ Ativa", inline: true },{ name: "👤 Discord", value: d.discordId ? `<@${d.discordId}>` : "*(não vinculado)*", inline: true }).setTimestamp()] }); return; }
    if (id === "modal_unblock") { if (wrongPass(getField("key_pass"))) { await interaction.editReply({ content: "❌ Senha incorreta!" }); return; } const ip = getField("ip_address").trim(); if (blockedIPs[ip]) { delete blockedIPs[ip]; await interaction.editReply({ content: `✅ \`${ip}\` desbloqueado.` }); } else await interaction.editReply({ content: "IP não estava bloqueado." }); return; }
    if (id === "modal_cleanlogs") { if (wrongPass(getField("key_pass"))) { await interaction.editReply({ content: "❌ Senha incorreta!" }); return; } const count = brainrots.length; brainrots.length = 0; await interaction.editReply({ content: `🧹 **${count}** removidos.` }); return; }
}

const mkInput = (id, label, placeholder = "", required = true) => new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setRequired(required).setPlaceholder(placeholder));
function buildModal_create() { return new ModalBuilder().setCustomId("modal_create").setTitle("🔑 Criar Key").addComponents(mkInput("key_name","Nome"),mkInput("key_h","Horas","24"),mkInput("key_m","Minutos","0",false),mkInput("key_pass","Senha")); }
function buildModal_lifetime() { return new ModalBuilder().setCustomId("modal_lifetime").setTitle("♾️ Lifetime").addComponents(mkInput("key_name","Nome"),mkInput("key_pass","Senha")); }
function buildModal_revoke() { return new ModalBuilder().setCustomId("modal_revoke").setTitle("🗑️ Revogar").addComponents(mkInput("key_name","Nome (ou 'all')"),mkInput("key_pass","Senha")); }
function buildModal_pause() { return new ModalBuilder().setCustomId("modal_pause").setTitle("⏸️ Pausar").addComponents(mkInput("key_name","Nome (ou 'all')"),mkInput("key_pass","Senha")); }
function buildModal_reset() { return new ModalBuilder().setCustomId("modal_reset").setTitle("🔄 Reset HWID").addComponents(mkInput("key_name","Nome (ou 'all')"),mkInput("key_pass","Senha")); }
function buildModal_addtime() { return new ModalBuilder().setCustomId("modal_addtime").setTitle("⏱️ Add Tempo").addComponents(mkInput("key_name","Nome (ou 'all')"),mkInput("key_h","Horas","12"),mkInput("key_m","Minutos","0",false),mkInput("key_pass","Senha")); }
function buildModal_setexpiry() { return new ModalBuilder().setCustomId("modal_setexpiry").setTitle("📅 Set Expiração").addComponents(mkInput("key_name","Nome"),mkInput("key_h","Horas"),mkInput("key_m","Minutos","0",false),mkInput("key_pass","Senha")); }
function buildModal_transfer() { return new ModalBuilder().setCustomId("modal_transfer").setTitle("🔀 Transfer").addComponents(mkInput("key_old","Nome atual"),mkInput("key_new","Novo nome"),mkInput("key_pass","Senha")); }
function buildModal_sethwid() { return new ModalBuilder().setCustomId("modal_sethwid").setTitle("💻 Set HWID").addComponents(mkInput("key_name","Nome"),mkInput("key_hwid","HWID"),mkInput("key_pass","Senha")); }
function buildModal_lookup() { return new ModalBuilder().setCustomId("modal_lookup").setTitle("🔍 Lookup").addComponents(mkInput("key_name","Nome")); }
function buildModal_unblock() { return new ModalBuilder().setCustomId("modal_unblock").setTitle("🔓 Desbloquear IP").addComponents(mkInput("ip_address","IP"),mkInput("key_pass","Senha")); }
function buildModal_cleanlogs() { return new ModalBuilder().setCustomId("modal_cleanlogs").setTitle("🧹 Limpar Logs").addComponents(mkInput("key_pass","Senha")); }

clientLogs.on("messageCreate", async (message) => {
    if (message.author.bot) return;
    if (message.content === "!logspanel") await sendLogsPanel();
    if (message.content === "!online") {
        try { const msg = await message.channel.send({ embeds: [buildOnlineEmbed()] }); startOnlineInterval(message.channel.id, msg); } catch (e) { console.error("[!online]", e.message); }
    }
});

const clientPanel = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages], partials: [Partials.Channel, Partials.Message] });
const awaitingInput = {};

clientPanel.on("ready", async () => {
    console.log(`[PANEL] Online: ${clientPanel.user.tag}`);
    if (!PANEL_CHANNEL_ID) return;
    try { const ch = await clientPanel.channels.fetch(PANEL_CHANNEL_ID); if (!ch) return; const msgs = await ch.messages.fetch({ limit: 10 }); for (const [, msg] of msgs) { if (msg.author.id === clientPanel.user.id) await msg.delete().catch(() => {}); } await ch.send({ embeds: [new EmbedBuilder().setTitle("🤖 Bob Auto Joiner").setColor(COLORS.primary).setDescription("Clique nos botões para gerenciar sua key.")], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("panel_redeem").setLabel("Redeem Key").setEmoji("🔑").setStyle(ButtonStyle.Success),new ButtonBuilder().setCustomId("panel_script").setLabel("Get Script").setEmoji("📋").setStyle(ButtonStyle.Primary),new ButtonBuilder().setCustomId("panel_stats").setLabel("Key Info").setEmoji("📊").setStyle(ButtonStyle.Secondary)),new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("panel_role").setLabel("Get Role").setEmoji("👤").setStyle(ButtonStyle.Primary),new ButtonBuilder().setCustomId("panel_hwid").setLabel("Reset HWID").setEmoji("⚙️").setStyle(ButtonStyle.Secondary))] }); } catch (e) { console.error("[PANEL] Erro:", e.message); }
});

clientPanel.on("messageCreate", async (message) => {
    if (message.author.bot) return;
    if (message.channel.type === ChannelType.DM) {
        const state = awaitingInput[message.author.id]; if (!state) return;
        const key = message.content.trim(), keyName = findKey(key);
        if (!keyName) return message.reply("❌ Key não encontrada!");
        const d = keys[keyName];
        if (d.paused) return message.reply("⏸️ Key pausada.");
        if (d.expiry !== Infinity && d.expiry - Date.now() <= 0) return message.reply("⌛ Key expirada!");
        const { step } = state; delete awaitingInput[message.author.id];
        if (step === "redeem_key") return message.reply({ embeds: [new EmbedBuilder().setColor(COLORS.success).setTitle("✅ Key Válida!").addFields({ name: "⏱️ Tempo", value: d.expiry === Infinity ? "Lifetime ♾️" : formatTime(d.expiry - Date.now()) }).setTimestamp()] });
        if (step === "script_key") return message.reply(SCRIPT_URL ? `📋 Script:\n\`\`\`\nloadstring(game:HttpGet('${SCRIPT_URL}'))()\n\`\`\`` : "❌ Script URL não configurada.");
        if (step === "role_key") { if (d.discordId && d.discordId !== message.author.id) return message.reply("❌ Key vinculada a outro Discord!"); d.discordId = message.author.id; await saveKey(keyName); const ROLE_ID = process.env.BUYER_ROLE_ID; if (ROLE_ID && state.guildId) { try { const guild = await clientPanel.guilds.fetch(state.guildId); const member = await guild.members.fetch(message.author.id); await member.roles.add(ROLE_ID); return message.reply("✅ Vinculado e cargo adicionado!"); } catch {} } return message.reply("✅ Discord vinculado!"); }
        if (step === "hwid_key") { keys[keyName].hwid = null; kicked[keyName.toLowerCase()] = Date.now(); await saveKey(keyName); return message.reply("✅ HWID resetado!"); }
        if (step === "stats_key") return message.reply({ embeds: [new EmbedBuilder().setTitle("📊 Key Info").setColor(COLORS.primary).addFields({ name: "🔑 Key", value: `\`${keyName}\``, inline: true },{ name: "⏱️ Tempo", value: d.expiry === Infinity ? "Lifetime ♾️" : formatTime(d.expiry - Date.now()), inline: true },{ name: "📌 Status", value: d.paused ? "⏸️ Pausada" : "✅ Ativa", inline: true })] });
    }
});

clientPanel.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;
    const user = interaction.user; await interaction.deferReply({ flags: 64 });
    const steps = { panel_redeem: "redeem_key", panel_script: "script_key", panel_role: "role_key", panel_hwid: "hwid_key", panel_stats: "stats_key" };
    const msgs = { panel_redeem: "🔑 Envie sua key:", panel_script: "📋 Envie sua key:", panel_role: "👤 Envie sua key:", panel_hwid: "⚙️ Envie sua key:", panel_stats: "📊 Envie sua key:" };
    const step = steps[interaction.customId];
    if (step) { awaitingInput[user.id] = { step, guildId: interaction.guildId }; try { await user.send(msgs[interaction.customId]); await interaction.editReply({ content: "📩 Te mandei uma DM!" }); } catch { await interaction.editReply({ content: "❌ Habilite mensagens privadas!" }); } }
});

const clientPayment = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages], partials: [Partials.Channel, Partials.Message] });
const pendingCoupon = {};

function getActivePlans() { return PLANS.filter(p => p.active); }

clientPayment.on("ready", async () => {
    console.log(`[PAYMENT] Online: ${clientPayment.user.tag}`);
    if (!BUY_CHANNEL) return;
    try { const ch = await clientPayment.channels.fetch(BUY_CHANNEL); if (!ch) return; const msgs = await ch.messages.fetch({ limit: 10 }); for (const [, msg] of msgs) { if (msg.author.id === clientPayment.user.id) await msg.delete().catch(() => {}); } const activePlans = getActivePlans(); const rows = []; for (let i = 0; i < activePlans.length; i += 4) { const row = new ActionRowBuilder(); activePlans.slice(i, i + 4).forEach(p => row.addComponents(new ButtonBuilder().setCustomId(`buy_${p.value}`).setLabel(`${p.emoji} ${p.label} — R$${p.price}`).setStyle(ButtonStyle.Success))); rows.push(row); } rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("buy_minhakey").setLabel("🔑 Minha Key").setStyle(ButtonStyle.Secondary),new ButtonBuilder().setCustomId("buy_cupom").setLabel("🎟️ Cupom").setStyle(ButtonStyle.Primary))); await ch.send({ embeds: [new EmbedBuilder().setColor(COLORS.success).setTitle("🛒 Bob Keys").setDescription(activePlans.map(p => `${p.emoji} **${p.label}** — R$${p.price},00`).join("\n") + "\n\n> ⏱️ 15 minutos para pagar após escolher.\n> 🔄 Key ativa será renovada!").setTimestamp()], components: rows }); } catch (e) { console.error("[PAYMENT] Erro:", e.message); }
});

clientPayment.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton() && !interaction.isModalSubmit()) return;
    const id = interaction.customId, user = interaction.user;
    if (interaction.isModalSubmit() && id === "modal_cupom") { await interaction.deferReply({ flags: 64 }); const planValue = pendingCoupon[user.id]?.plan, couponCode = interaction.fields.getTextInputValue("coupon_code").trim().toUpperCase(); const plan = getActivePlans().find(p => p.value === planValue); if (!plan) { await interaction.editReply({ content: "❌ Sessão expirada." }); return; } const result = await applyCoupon(couponCode, user.id, plan.price); if (!result.ok) { await interaction.editReply({ content: result.msg }); return; } pendingCoupon[user.id] = { plan: planValue, coupon: couponCode, finalPrice: result.finalPrice }; await interaction.editReply({ embeds: [new EmbedBuilder().setColor(COLORS.success).setTitle("🎟️ Cupom Aplicado!").setDescription(`**${couponCode}** — ${result.discount}${result.type === "percent" ? "%" : " R$"} off\n**Preço final: R$${result.finalPrice}**`).setTimestamp()] }); return; }
    if (!interaction.isButton()) return;
    await interaction.deferReply({ flags: 64 });
    if (id === "buy_cupom") { await interaction.deleteReply().catch(() => {}); await interaction.showModal(new ModalBuilder().setCustomId("modal_cupom").setTitle("🎟️ Cupom").addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("coupon_code").setLabel("Código:").setStyle(TextInputStyle.Short).setRequired(true)))); return; }
    if (id.startsWith("buy_") && id !== "buy_minhakey") { const planValue = id.replace("buy_", ""), plan = getActivePlans().find(p => p.value === planValue); if (!plan) { await interaction.editReply({ content: "❌ Plano inválido!" }); return; } const existing = await PendingPayment.findOne({ discordId: user.id }); const now = Date.now(); if (existing) { const rem = PENDING_EXPIRY_MS - (now - new Date(existing.createdAt).getTime()); if (rem > 0) { await interaction.editReply({ content: `⚠️ Pedido ativo! Expira em **${formatTimeShort(rem)}**.` }); return; } } const couponData = pendingCoupon[user.id]?.plan === planValue ? pendingCoupon[user.id] : null; let finalPrice = plan.price, couponUsed = null; if (couponData) { finalPrice = couponData.finalPrice; couponUsed = couponData.coupon; delete pendingCoupon[user.id]; } await PendingPayment.findOneAndUpdate({ discordId: user.id }, { discordId: user.id, discordTag: user.tag, hours: plan.hours, price: plan.price, finalPrice, label: plan.label, couponUsed, warningSent: false, createdAt: new Date() }, { upsert: true, new: true }); await interaction.editReply({ embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle("💳 Pix").setDescription(`**${plan.emoji} ${plan.label}** — R$${finalPrice},00\n\n**Chave Pix:**\n\`\`\`${PIX_KEY}\`\`\`**Nome:** ${PIX_NAME}\n\n> Envie o comprovante aqui!\n> ⏳ **15 minutos** para pagar.`).setTimestamp()] }); return; }
    if (id === "buy_minhakey") { const userKeys = Object.entries(keys).filter(([, d]) => d.discordId === user.id); if (!userKeys.length) { await interaction.editReply({ content: "❌ Nenhuma key!" }); return; } const now = Date.now(); await interaction.editReply({ embeds: [new EmbedBuilder().setColor(COLORS.success).setTitle("🔑 Suas Keys").setDescription(userKeys.map(([k, d]) => `\`${k}\` — ${d.expiry === Infinity ? "Lifetime ♾️" : (d.expiry - now > 0 ? formatTime(d.expiry - now) : "❌")} ${d.paused ? "⏸️" : "✅"}`).join("\n")).setTimestamp()] }); return; }

    // ── RECARGA PIX MANUAL ──
    if (id.startsWith("recharge_confirm_")) {
        const code = id.replace("recharge_confirm_", "");
        const recharge = await Recharge.findOne({ code, status: "pending" });
        if (!recharge) { await interaction.editReply({ content: "❌ Recarga não encontrada ou já processada." }); return; }

        // Adiciona saldo
        const updatedUser = await User.findOneAndUpdate(
            { discordId: recharge.discordId },
            { $inc: { balance: recharge.amount } },
            { new: true }
        );
        if (!updatedUser) { await interaction.editReply({ content: "❌ Usuário não encontrado no banco." }); return; }

        await Transaction.create({
            discordId: recharge.discordId,
            type: "deposit",
            amount: recharge.amount,
            description: `Recarga Pix — ${code}`
        });

        await Recharge.updateOne({ code }, { status: "confirmed", confirmedBy: interaction.user.id });

        // DM pro usuário
        fetchUserFromAnyClient(recharge.discordId).then(u => {
            if (u) u.send({ embeds: [new EmbedBuilder()
                .setColor(COLORS.success)
                .setTitle("💰 Recarga Confirmada!")
                .setDescription(`**R$${recharge.amount.toFixed(2)}** foram adicionados ao seu saldo!\n**Novo saldo:** R$${updatedUser.balance.toFixed(2)}\n**Código:** \`${code}\``)
                .setTimestamp()] }).catch(() => {});
        });

        // Edita a mensagem do Discord desabilitando os botões
        await interaction.message.edit({
            embeds: [new EmbedBuilder()
                .setColor(COLORS.success)
                .setTitle("✅ Recarga Confirmada")
                .addFields(
                    { name: "👤 Usuário", value: `${recharge.discordTag} (<@${recharge.discordId}>)`, inline: true },
                    { name: "💰 Valor", value: `R$${recharge.amount.toFixed(2)}`, inline: true },
                    { name: "🔑 Código", value: `\`${code}\``, inline: true },
                    { name: "✅ Confirmado por", value: `<@${interaction.user.id}>`, inline: false }
                ).setTimestamp()],
            components: []
        }).catch(() => {});

        await interaction.editReply({ content: `✅ Recarga de R$${recharge.amount.toFixed(2)} confirmada para ${recharge.discordTag}!` });
        return;
    }

    if (id.startsWith("recharge_cancel_")) {
        const code = id.replace("recharge_cancel_", "");
        const recharge = await Recharge.findOne({ code, status: "pending" });
        if (!recharge) { await interaction.editReply({ content: "❌ Recarga não encontrada ou já processada." }); return; }

        await Recharge.updateOne({ code }, { status: "cancelled" });

        fetchUserFromAnyClient(recharge.discordId).then(u => {
            if (u) u.send({ embeds: [new EmbedBuilder()
                .setColor(COLORS.danger)
                .setTitle("❌ Recarga Cancelada")
                .setDescription(`Sua recarga de **R$${recharge.amount.toFixed(2)}** foi cancelada.\nCódigo: \`${code}\``)
                .setTimestamp()] }).catch(() => {});
        });

        await interaction.message.edit({
            embeds: [new EmbedBuilder()
                .setColor(COLORS.danger)
                .setTitle("❌ Recarga Cancelada")
                .addFields(
                    { name: "👤 Usuário", value: `${recharge.discordTag}`, inline: true },
                    { name: "💰 Valor", value: `R$${recharge.amount.toFixed(2)}`, inline: true },
                    { name: "🔑 Código", value: `\`${code}\``, inline: true }
                ).setTimestamp()],
            components: []
        }).catch(() => {});

        await interaction.editReply({ content: `🗑️ Recarga cancelada.` });
        return;
    }
});

function requireDashAuth(req, res, next) { const pass = req.query.pass || req.headers["x-admin-pass"]; if (!safeCompare(pass, ADMIN_PASS)) return res.status(401).json({ error: "Unauthorized" }); next(); }

app.get("/api/dashboard", requireDashAuth, async (req, res) => {
    const now = Date.now(), all = Object.entries(keys), active = all.filter(([, d]) => !d.paused && (d.expiry === Infinity || d.expiry - now > 0)), paused = all.filter(([, d]) => d.paused), online = Object.values(presence).filter(p => now - p.lastSeen < ONLINE_STALE_MS);
    const pendentes = await PendingPayment.find().sort({ createdAt: -1 }), recentSales = await SaleHistory.find().sort({ confirmedAt: -1 }).limit(10), totalR = await SaleHistory.aggregate([{ $group: { _id: null, t: { $sum: "$price" } } }]), coupons = await Coupon.find({ active: true }), hoje = recentSales.filter(s => new Date(s.confirmedAt).toDateString() === new Date().toDateString());
    res.json({ stats: { totalKeys: all.length, activeKeys: active.length, pausedKeys: paused.length, onlineNow: online.length, pendingOrders: pendentes.length, totalRevenue: totalR[0]?.t || 0, todaySales: hoje.length }, keys: active.slice(0, 50).map(([name, d]) => ({ name, expiry: d.expiry === Infinity ? null : d.expiry, discordId: d.discordId, paused: d.paused })), online: online.map(p => p.name), pendingOrders: pendentes.map(p => ({ discordTag: p.discordTag, label: p.label, price: p.finalPrice || p.price, createdAt: p.createdAt })), recentSales: recentSales.map(s => ({ discordTag: s.discordTag, label: s.label, price: s.price, keyName: s.keyName, confirmedAt: s.confirmedAt })), coupons: coupons.map(c => ({ code: c.code, discount: c.discount, type: c.type, usedCount: c.usedCount, maxUses: c.maxUses })), plans: PLANS });
});

app.get("/dashboard", (req, res) => res.send("<h1>Bob Joiner Dashboard</h1><a href='/api/dashboard'>API</a>"));
app.get("/health", (_, res) => res.json({ status: "ok", time: Date.now() }));
app.get("/", (_, res) => res.send("<h1>Bob API — Online ✅</h1>"));

app.get("/validate", requireClientHeader, (req, res) => { const r = checkKey(req.query.key, req.query.secret, req.query.hwid); if (!r.ok) return res.status(403).json({ status: "error", message: r.error }); res.json({ status: "success", time_left: r.data.expiry === Infinity ? LIFETIME_VALUE : r.data.expiry - Date.now() }); });
app.get("/get-brainrots", requireClientHeader, (req, res) => { const r = checkKey(req.query.key, req.query.secret, req.query.hwid); if (!r.ok) return res.status(403).json({ status: "error", message: r.error }); if (!brainrots.length) return res.json({ status: "waiting" }); const latest = brainrots[brainrots.length - 1]; if (latest.id === req.query.lastId) return res.json({ status: "waiting" }); res.json({ status: "success", brainrot: latest }); });
app.get("/logs", requireClientHeader, (req, res) => { const r = checkKey(req.query.key, req.query.secret, req.query.hwid); if (!r.ok) return res.status(403).json({ status: "error", message: r.error }); res.json(brainrots); });
app.get("/api/latest", requireClientHeader, (req, res) => { const r = checkKey(req.query.key, req.query.secret, req.query.hwid); if (!r.ok) return res.status(403).json({ status: "error", message: r.error }); if (!brainrots.length) return res.json({ status: "waiting" }); res.json(brainrots[brainrots.length - 1]); });
app.post("/api/notify", requireClientHeader, (req, res) => { const { secret, name, jobId, value, description } = req.body; if (secret !== SCRIPT_SECRET) return res.status(403).json({ status: "error" }); const payload = { id: Date.now().toString(), title: name || "Brainrot", description: description || name || "Novo!", brainrot: name || "Brainrot", name: name || "Brainrot", jobId: xorObfuscate(jobId) || null, value: String(value || "0"), players: "N/A" }; pushBrainrot(payload); res.json({ status: "ok", id: payload.id }); });
app.get("/kicked", requireClientHeader, (req, res) => { if (req.query.secret !== SCRIPT_SECRET) return res.json({ kicked: false }); const keyName = findKey(req.query.key); if (!keyName) return res.json({ kicked: false }); const ts = kicked[keyName.toLowerCase()]; if (ts) { delete kicked[keyName.toLowerCase()]; return res.json({ kicked: true }); } res.json({ kicked: false }); });
app.post("/presence", requireClientHeader, async (req, res) => { const { key, secret, hwid, sessionId, name, jobId, discordId } = req.query; const r = checkKey(key, secret, hwid); if (!r.ok) return res.status(403).json({ status: "error", message: r.error }); presence[sessionId] = { name: name || "Unknown", lastSeen: Date.now(), key: (key || "").trim() }; if (jobId && name) userJobIds[name] = jobId; if (discordId && r.keyName) { const d = keys[r.keyName], cleanId = String(discordId).replace(/\D/g, ""); if (cleanId.length >= 17 && !d.discordId) { d.discordId = cleanId; await saveKey(r.keyName); } } res.json({ status: "ok" }); });
app.get("/presence", requireClientHeader, (req, res) => { const r = checkKey(req.query.key, req.query.secret, req.query.hwid); if (!r.ok) return res.status(403).json({ status: "error", message: r.error }); const now = Date.now(), active = {}; for (const [sid, info] of Object.entries(presence)) { if (now - info.lastSeen < ONLINE_STALE_MS) active[info.name] = true; else delete presence[sid]; } res.json(Object.keys(active).sort()); });
app.get("/clients", requireClientHeader, (req, res) => { if (req.query.secret !== SCRIPT_SECRET) return res.status(403).json({ status: "error" }); res.send(`Socket.IO: ${io.sockets.sockets.size} | Presença: ${Object.keys(presence).length}`); });
app.post("/push-brainrot", requireClientHeader, (req, res) => { const { secret, title, description, jobId, value, players } = req.body; if (secret !== SCRIPT_SECRET) return res.status(403).json({ status: "error" }); const payload = { id: Date.now().toString(), title: title || "Brainrot", description: description || "", brainrot: title || "Brainrot", name: title || "Brainrot", jobId: xorObfuscate(jobId) || null, value: value || "0", players: players || "N/A" }; pushBrainrot(payload); res.json({ status: "ok", id: payload.id }); });
app.post("/link-discord", requireClientHeader, async (req, res) => { const r = checkKey(req.query.key, req.query.secret, req.query.hwid); if (!r.ok) return res.status(403).json({ status: "error", message: r.error }); const cleanId = String(req.query.discordId || "").replace(/\D/g, ""); if (cleanId.length < 17) return res.status(400).json({ status: "error", message: "Discord ID invalido." }); const d = keys[r.keyName]; if (d.discordId && d.discordId !== cleanId) return res.status(409).json({ status: "error", message: "Key ja vinculada." }); d.discordId = cleanId; await saveKey(r.keyName); res.json({ status: "ok" }); });
app.post("/report-jobid", requireClientHeader, (req, res) => { if (req.query.secret !== SCRIPT_SECRET) return res.status(403).json({ status: "error" }); const keyName = findKey(req.query.key); if (!keyName) return res.status(403).json({ status: "error" }); if (req.query.name && req.query.jobId) userJobIds[req.query.name] = req.query.jobId; res.json({ status: "ok" }); });

app.use((err, req, res, next) => { console.error("[EXPRESS]", err.message); res.status(500).json({ status: "error", message: "Erro interno." }); });
process.on("unhandledRejection", r => console.error("[PROCESS] Rejeição:", r));
process.on("uncaughtException", e => console.error("[PROCESS] Exceção:", e.message));

async function loginBot(client, token, label) { if (!token) { console.warn(`[${label}] Token ausente.`); return; } try { await client.login(token); } catch (e) { console.error(`[${label}] Erro:`, e.message); } }

loginBot(clientNotifier, DISCORD_TOKEN_NOTIFIER, "NOTIFIER");
loginBot(clientLogs,     DISCORD_TOKEN_LOGS,     "LOGS");
loginBot(clientPanel,    DISCORD_TOKEN_PANEL,    "PANEL");
loginBot(clientPayment,  DISCORD_TOKEN_PAYMENT,  "PAYMENT");

loadKeys();
server.listen(port, () => console.log(`[SERVER] Porta ${port} — Bob API online ✅`));