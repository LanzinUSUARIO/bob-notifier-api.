const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const {
    Client, GatewayIntentBits,
    ActionRowBuilder, ButtonBuilder, ButtonStyle,
    EmbedBuilder, Events, ChannelType, Partials,
    ModalBuilder, TextInputBuilder, TextInputStyle,
    PermissionsBitField
} = require("discord.js");
const mongoose = require("mongoose");

// ─── XOR OBFUSCATION ─────────────────────────────────────────────────────────
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

const LIFETIME_VALUE = 9999999999999;

// ─── CONFIG PAGAMENTOS ───────────────────────────────────────────────────────
const PIX_KEY      = process.env.PIX_KEY      || "joaojanela2009@gmail.com";
const PIX_NAME     = process.env.PIX_NAME     || "João";
const BUY_CHANNEL  = process.env.BUY_CHANNEL  || "1503090485143666828";
const PLANS = [
    { label: "1 Hora",  value: "1h", price: 5,  hours: 1, emoji: "🕐" },
    { label: "2 Horas", value: "2h", price: 10, hours: 2, emoji: "⏱️" },
    { label: "4 Horas", value: "4h", price: 20, hours: 4, emoji: "⚡" },
];

// ─── MONGODB ─────────────────────────────────────────────────────────────────
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
    expiry:    { type: Number, default: LIFETIME_VALUE },
    paused:    { type: Boolean, default: false },
    remaining: { type: Number, default: 0 },
    hwid:      { type: String, default: null },
    discordId: { type: String, default: null }
});
const KeyModel = mongoose.model("Key", KeySchema);

const PendingPaymentSchema = new mongoose.Schema({
    discordId:  String,
    discordTag: String,
    hours:      Number,
    price:      Number,
    label:      String,
    createdAt:  { type: Date, default: Date.now },
});
const PendingPayment = mongoose.model("PendingPayment", PendingPaymentSchema);

async function loadKeys() {
    try {
        const docs = await KeyModel.find({});
        let expired = 0;
        for (const d of docs) {
            const expiry    = d.expiry    >= LIFETIME_VALUE ? Infinity : d.expiry;
            const remaining = d.remaining >= LIFETIME_VALUE ? Infinity : d.remaining;
            if (expiry !== Infinity && expiry - Date.now() <= 0) {
                await KeyModel.deleteOne({ name: d.name });
                expired++;
                continue;
            }
            keys[d.name] = { expiry, paused: d.paused, remaining, hwid: d.hwid || null, discordId: d.discordId || null };
        }
        console.log(`[DB] ${Object.keys(keys).length} keys carregadas. ${expired} expiradas removidas.`);
    } catch (e) {
        console.error("[DB] Erro ao carregar keys:", e.message);
    }
}

async function saveKey(name) {
    try {
        const raw = { ...keys[name] };
        if (raw.expiry    === Infinity) raw.expiry    = LIFETIME_VALUE;
        if (raw.remaining === Infinity) raw.remaining = LIFETIME_VALUE;
        await KeyModel.findOneAndUpdate({ name }, { name, ...raw }, { upsert: true, new: true });
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

setInterval(async () => {
    const now = Date.now();
    for (const [name, data] of Object.entries(keys)) {
        if (data.expiry !== Infinity && !data.paused && data.expiry - now <= 0) {
            delete keys[name];
            await deleteKey(name);
            console.log(`[CLEANUP] Key expirada removida: ${name}`);
        }
    }
}, 60000);

// ─── EXPRESS + SOCKET.IO ─────────────────────────────────────────────────────
const app    = express();
app.use(express.json());
const server = http.createServer(app);
const io     = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    allowEIO3: true,
    transports: ["polling", "websocket"]
});
const port = process.env.PORT || 3000;

// ─── ENV VARS ────────────────────────────────────────────────────────────────
const ADMIN_PASS             = process.env.ADMIN_PASS    || "ADMIN_PADRAO_MUDE_NO_RENDER";
const SCRIPT_SECRET          = process.env.SCRIPT_SECRET || "BOB_SECURE_2024_XYZ";
const CLIENT_HEADER          = process.env.CLIENT_HEADER || "BobJoiner-v2";

const DISCORD_TOKEN_NOTIFIER = process.env.DISCORD_TOKEN_NOTIFIER;
const DISCORD_TOKEN_LOGS     = process.env.DISCORD_TOKEN_LOGS;
const DISCORD_TOKEN_PANEL    = process.env.DISCORD_TOKEN_PANEL;
const DISCORD_TOKEN_PAYMENT  = process.env.DISCORD_TOKEN_PAYMENT; // token do bot de pagamento
const DISCORD_CHANNEL_ID     = process.env.DISCORD_CHANNEL_ID || "1494529159484149801";
const PANEL_CHANNEL_ID       = process.env.PANEL_CHANNEL_ID   || "1502373185125875873";
const LOGS_CHANNEL_ID        = process.env.LOGS_CHANNEL_ID    || "";
const BOB_LOGS_PANEL_CHANNEL = process.env.BOB_LOGS_PANEL_CHANNEL || "";
const SCRIPT_URL             = process.env.SCRIPT_URL         || "";
const ADMIN_IDS              = (process.env.ADMIN_IDS || "").split(",").filter(Boolean);
const ADMIN_ROLE_ID          = process.env.ADMIN_ROLE_ID || "";

// ─── STATE ───────────────────────────────────────────────────────────────────
const keys       = {};
const brainrots  = [];
const presence   = {};
const kicked     = {};
const userJobIds = {};

// ─── RATE LIMITER ────────────────────────────────────────────────────────────
const RATE_LIMIT_MAX    = 60;
const RATE_LIMIT_WINDOW = 60000;
const BLOCK_DURATION    = 300000;
const rateLimitMap      = {};
const blockedIPs        = {};

function getRealIP(req) {
    return (req.headers["x-forwarded-for"] || "").split(",")[0].trim()
        || req.socket.remoteAddress || "unknown";
}

async function logSecurityAlert(message) {
    if (!LOGS_CHANNEL_ID) return;
    try {
        const ch = await clientLogs.channels.fetch(LOGS_CHANNEL_ID);
        if (ch) {
            await ch.send({ embeds: [new EmbedBuilder().setTitle("🚨 Alerta de Segurança").setColor(0xFF3C3C).setDescription(message).setTimestamp()] });
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

// ─── UTILS ───────────────────────────────────────────────────────────────────
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

const findKey   = (name) => Object.keys(keys).find(k => k.toLowerCase() === (name || "").trim().toLowerCase());
const tsRelative = (date) => `<t:${Math.floor(new Date(date).getTime() / 1000)}:R>`;

const checkKey = (key, secret, hwid) => {
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
};

function isAdmin(member) {
    if (!member) return false;
    if (ADMIN_IDS.includes(member.id)) return true;
    if (ADMIN_ROLE_ID && member.roles.cache.has(ADMIN_ROLE_ID)) return true;
    if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
    return false;
}

// ─── GERADOR DE KEY BOB ──────────────────────────────────────────────────────
function generateBobKey() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let r = "BOB-";
    for (let i = 0; i < 8; i++) r += chars[Math.floor(Math.random() * chars.length)];
    return r;
}

// ─── CONFIRMAR PAGAMENTO (cria key e avisa usuário) ──────────────────────────
async function confirmarPagamento(user, hours, channel) {
    const keyName   = generateBobKey();
    const expiresAt = Date.now() + hours * 3600000;

    keys[keyName] = { expiry: expiresAt, paused: false, remaining: hours * 3600000, hwid: null, discordId: user.id };
    await saveKey(keyName);

    const dmEmbed = new EmbedBuilder()
        .setColor(0x00ff88)
        .setTitle("🎉 Pagamento Confirmado!")
        .setDescription(
            `Sua key foi gerada com sucesso!\n\n` +
            `**🔑 Sua Key:**\n\`\`\`${keyName}\`\`\`\n` +
            `**Plano:** ${hours}h\n` +
            `**Expira:** ${tsRelative(expiresAt)}\n\n` +
            `Use essa key para ativar o Bob Joiner!`
        )
        .setFooter({ text: "Bob Keys • Obrigado pela compra! 🚀" })
        .setTimestamp();

    try {
        await user.send({ embeds: [dmEmbed] });
    } catch {
        if (channel) channel.send(`⚠️ ${user} — Não consegui enviar DM! Ativa DMs do servidor. Sua key: \`${keyName}\``);
    }

    if (channel) {
        channel.send({ embeds: [new EmbedBuilder()
            .setColor(0x00ff88)
            .setTitle("✅ Key Gerada")
            .setDescription(`**Usuário:** ${user.tag}\n**Plano:** ${hours}h\n**Key:** \`${keyName}\`\n**Expira:** ${tsRelative(expiresAt)}`)
            .setTimestamp()] });
    }

    console.log(`[PAYMENT] ✅ Key gerada para ${user.tag}: ${keyName} (${hours}h)`);
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── BOT NOTIFIER ────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
const clientNotifier = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildWebhooks]
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
        id: Date.now().toString(), title: embed.title || "Bob!", description: embed.description || "Novo Alerta!",
        brainrot: embed.title || "Brainrot", name: embed.title || "Brainrot",
        jobId: xorObfuscate(jobId), value, players
    };
    brainrots.push(payload);
    if (brainrots.length > 100) brainrots.shift();
    io.emit("brainrot", payload);
    console.log(`[NOTIFIER] ✅ ${payload.title} | jobId: ${jobId}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// ─── BOT LOGS ────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
const clientLogs = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

clientLogs.on("ready", async () => {
    console.log(`[LOGS] Online: ${clientLogs.user.tag}`);
    await sendLogsPanel();
});

function buildLogsEmbed() {
    return new EmbedBuilder()
        .setTitle("🛠️ Bob Logs — Painel de Administração").setColor(0x5865F2)
        .setDescription(
            "Painel completo de controle do **Bob Joiner**.\n" +
            "Use os botões abaixo para gerenciar keys, monitorar usuários e administrar o sistema.\n\n" +
            "**Categorias disponíveis:**\n" +
            "🔑 **Gerenciar Keys** — criar, revogar, pausar, resetar\n" +
            "⏱️ **Tempo** — addtime, setexpiry, extend\n" +
            "📊 **Informações** — online, stats, lookup, jobids\n" +
            "🛡️ **Segurança** — blocked, unblock\n" +
            "🧹 **Utilitários** — cleanlogs, test, online ao vivo"
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
            new ButtonBuilder().setCustomId("logs_addtime").setLabel("Add Tempo").setEmoji("⏱️").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("logs_setexpiry").setLabel("Set Expiração").setEmoji("📅").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("logs_extend").setLabel("Extend").setEmoji("➕").setStyle(ButtonStyle.Primary),
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
        // ── NOVA LINHA: PAGAMENTOS ──
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("logs_pendentes").setLabel("Pendentes Pix").setEmoji("⏳").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("logs_confirmar_manual").setLabel("Confirmar Pagamento").setEmoji("💳").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("logs_vendas").setLabel("Vendas").setEmoji("💰").setStyle(ButtonStyle.Secondary),
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
        for (const [, msg] of msgs) {
            if (msg.author.id === clientLogs.user.id) await msg.delete().catch(() => {});
        }
        await ch.send({ embeds: [buildLogsEmbed()], components: buildLogsRows() });
        console.log("[LOGS] Painel enviado no canal!");
    } catch (e) { console.error("[LOGS] Erro ao enviar painel:", e.message); }
}

function buildOnlineEmbed() {
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
        userMap[robloxName] = { timeLeft, status, discordId: keyData?.discordId || null, jobId: userJobIds[robloxName] || null };
    }
    const userList = Object.entries(userMap);
    const embed = new EmbedBuilder().setTitle("🟢 Usuários Online no Script").setColor(0x00C853)
        .setFooter({ text: `Bob Joiner • ${userList.length} usuário(s) online • Atualiza a cada 5s` }).setTimestamp();
    if (!userList.length) {
        embed.setDescription("Nenhum usuário online no momento.");
    } else {
        embed.setDescription(userList.map(([n, d]) => {
            const mention = d.discordId ? `<@${d.discordId}>` : "*(sem Discord)*";
            const jobPart = d.jobId ? ` | 🎮 \`${d.jobId.substring(0, 8)}...\`` : "";
            return `${d.status} **${n}** — ${mention} — ⏱️ \`${d.timeLeft}\`${jobPart}`;
        }).join("\n"));
    }
    return embed;
}

clientLogs.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isModalSubmit()) { await handleLogsModal(interaction); return; }
    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith("logs_")) return;
    const id = interaction.customId;

    // ── ONLINE ──
    if (id === "logs_online") {
        await interaction.deferReply({ ephemeral: false });
        const sentMsg = await interaction.editReply({ embeds: [buildOnlineEmbed()] });
        if (!global.onlineIntervals) global.onlineIntervals = {};
        if (global.onlineIntervals[interaction.channelId]) clearInterval(global.onlineIntervals[interaction.channelId]);
        global.onlineIntervals[interaction.channelId] = setInterval(async () => {
            await sentMsg.edit({ embeds: [buildOnlineEmbed()] }).catch(() => {
                clearInterval(global.onlineIntervals[interaction.channelId]);
                delete global.onlineIntervals[interaction.channelId];
            });
        }, 60000);
        return;
    }
    if (id === "logs_stoponline") {
        await interaction.deferReply({ ephemeral: true });
        if (global.onlineIntervals?.[interaction.channelId]) {
            clearInterval(global.onlineIntervals[interaction.channelId]);
            delete global.onlineIntervals[interaction.channelId];
            await interaction.editReply({ content: "⏹️ Atualização do online parada." });
        } else await interaction.editReply({ content: "Nenhuma atualização ativa neste canal." });
        return;
    }

    // ── STATS ──
    if (id === "logs_stats") {
        await interaction.deferReply({ ephemeral: true });
        const all    = Object.values(keys);
        const active = all.filter(k => !k.paused && (k.expiry === Infinity || k.expiry - Date.now() > 0));
        const paused = all.filter(k => k.paused);
        const lt     = all.filter(k => k.expiry === Infinity);
        const online = Object.values(presence).filter(p => Date.now() - p.lastSeen < 30000);
        await interaction.editReply({ embeds: [new EmbedBuilder().setTitle("📊 Estatísticas Bob Joiner").setColor(0x5865F2)
            .addFields(
                { name: "🔑 Total de Keys",   value: String(all.length),       inline: true },
                { name: "✅ Ativas",           value: String(active.length),    inline: true },
                { name: "⏸️ Pausadas",         value: String(paused.length),    inline: true },
                { name: "♾️ Lifetime",         value: String(lt.length),        inline: true },
                { name: "🟢 Online agora",     value: String(online.length),    inline: true },
                { name: "📡 Brainrots (fila)", value: String(brainrots.length), inline: true }
            ).setTimestamp()] });
        return;
    }

    // ── LISTAR KEYS ──
    if (id === "logs_info") {
        await interaction.deferReply({ ephemeral: true });
        const ks = Object.keys(keys);
        if (!ks.length) { await interaction.editReply({ content: "Nenhuma chave ativa." }); return; }
        const lines = ks.map(k => {
            const d = keys[k];
            const t = d.paused ? d.remaining : (d.expiry === Infinity ? Infinity : d.expiry - Date.now());
            return `• \`${k}\`: \`${formatTime(t)}\` ${d.paused ? "⏸️" : "✅"} ${d.discordId ? `<@${d.discordId}>` : "*(sem Discord)*"}`;
        });
        await interaction.editReply({ embeds: [new EmbedBuilder().setTitle("🔑 Chaves Ativas").setColor(0x5865F2)
            .setDescription(lines.join("\n").substring(0, 4000)).setTimestamp()] });
        return;
    }

    // ── JOBIDS ──
    if (id === "logs_jobids") {
        await interaction.deferReply({ ephemeral: true });
        const entries = Object.entries(userJobIds);
        if (!entries.length) { await interaction.editReply({ content: "Nenhum JobID registrado." }); return; }
        await interaction.editReply({ content: "🎮 **JobIDs conhecidos:**\n" + entries.map(([n, j]) => `• **${n}**: \`${j}\``).join("\n") });
        return;
    }

    // ── BLOCKED ──
    if (id === "logs_blocked") {
        await interaction.deferReply({ ephemeral: true });
        const now    = Date.now();
        const active = Object.entries(blockedIPs).filter(([, until]) => now < until);
        if (!active.length) { await interaction.editReply({ content: "Nenhum IP bloqueado no momento." }); return; }
        await interaction.editReply({ content: "🔒 **IPs Bloqueados:**\n" + active.map(([ip, until]) => `• \`${ip}\` — ainda ${Math.ceil((until - now) / 1000)}s`).join("\n") });
        return;
    }

    // ── TESTE ──
    if (id === "logs_test") {
        await interaction.deferReply({ ephemeral: true });
        const payload = { id: Date.now().toString(), title: "TESTE", description: "SINAL OK!", brainrot: "TESTE", name: "TESTE", jobId: null, value: "999999999", players: "N/A" };
        brainrots.push(payload); io.emit("brainrot", payload);
        await interaction.editReply({ content: "✅ Brainrot de teste enviado!" });
        return;
    }

    // ── PENDENTES PIX ──
    if (id === "logs_pendentes") {
        await interaction.deferReply({ ephemeral: true });
        const pendentes = await PendingPayment.find().sort({ createdAt: -1 });
        if (!pendentes.length) { await interaction.editReply({ content: "✅ Nenhum pedido pendente!" }); return; }
        const list = pendentes.map(p => `• **${p.discordTag}** — ${p.label} (R$${p.price}) — ${tsRelative(p.createdAt)}`).join("\n");
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
        }
        await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xffaa00).setTitle(`⏳ Pedidos Pendentes (${pendentes.length})`).setDescription(list)], components: rows });
        return;
    }

    // ── CONFIRMAR PAGAMENTO MANUAL ──
    if (id === "logs_confirmar_manual") {
        await interaction.showModal(new ModalBuilder().setCustomId("modal_pay_confirm").setTitle("Confirmar Pagamento Manual").addComponents(
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("user_id").setLabel("ID do usuário Discord:").setStyle(TextInputStyle.Short).setPlaceholder("123456789012345678").setRequired(true)),
            new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("horas").setLabel("Quantidade de horas:").setStyle(TextInputStyle.Short).setPlaceholder("2").setRequired(true))
        ));
        return;
    }

    // ── VENDAS ──
    if (id === "logs_vendas") {
        await interaction.deferReply({ ephemeral: true });
        const allKeys   = Object.values(keys);
        const por2h     = allKeys.filter(k => k.remaining <= 7200000 && k.remaining > 0).length;
        const por4h     = allKeys.filter(k => k.remaining > 7200000).length;
        const pendentes = await PendingPayment.countDocuments();
        const receita   = (por2h * 10) + (por4h * 20);
        await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x00ff88).setTitle("💰 Relatório de Vendas").addFields(
            { name: "⏱️ Keys 2h vendidas", value: String(por2h), inline: true },
            { name: "⚡ Keys 4h vendidas", value: String(por4h), inline: true },
            { name: "⏳ Pendentes",         value: String(pendentes), inline: true },
            { name: "💰 Receita Estimada",  value: `R$${receita},00`, inline: false }
        ).setTimestamp()] });
        return;
    }

    // ── CONFIRMAR via botão rápido ──
    if (id.startsWith("pay_confirm_")) {
        const parts    = id.split("_");
        const targetId = parts[2];
        const hours    = parseInt(parts[3]);
        const target   = await clientLogs.users.fetch(targetId).catch(() => null);
        if (!target) { await interaction.reply({ content: "❌ Usuário não encontrado!", ephemeral: true }); return; }
        await confirmarPagamento(target, hours, interaction.channel);
        await PendingPayment.deleteOne({ discordId: targetId });
        await interaction.reply({ content: `✅ Key confirmada para **${target.tag}** (${hours}h)!`, ephemeral: true });
        return;
    }

    // ── MODAIS DOS BOTÕES DE KEYS ──
    const modalMap = {
        logs_create: buildModal_create, logs_lifetime: buildModal_lifetime,
        logs_revoke: buildModal_revoke, logs_pause: buildModal_pause,
        logs_reset: buildModal_reset,   logs_addtime: buildModal_addtime,
        logs_setexpiry: buildModal_setexpiry, logs_extend: buildModal_extend,
        logs_transfer: buildModal_transfer,   logs_sethwid: buildModal_sethwid,
        logs_lookup: buildModal_lookup, logs_unblock: buildModal_unblock,
        logs_cleanlogs: buildModal_cleanlogs,
    };
    if (modalMap[id]) await interaction.showModal(modalMap[id]());
});

async function handleLogsModal(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const id       = interaction.customId;
    const getField = (name) => { try { return interaction.fields.getTextInputValue(name); } catch { return ""; } };
    const wrongPass = (pass) => pass !== ADMIN_PASS;

    // ── CONFIRMAR PAGAMENTO MANUAL ──
    if (id === "modal_pay_confirm") {
        const userId = getField("user_id").trim();
        const hours  = parseInt(getField("horas").trim());
        if (isNaN(hours) || hours <= 0) { await interaction.editReply({ content: "❌ Horas inválidas!" }); return; }
        const target = await clientLogs.users.fetch(userId).catch(() => null);
        if (!target) { await interaction.editReply({ content: "❌ Usuário não encontrado! Verifique o ID." }); return; }
        await confirmarPagamento(target, hours, interaction.channel);
        await PendingPayment.deleteOne({ discordId: userId });
        await interaction.editReply({ content: `✅ Key gerada para **${target.tag}** (${hours}h)!` });
        return;
    }

    if (id === "modal_create") {
        const name = getField("key_name").trim(), h = parseInt(getField("key_h")) || 0, m = parseInt(getField("key_m")) || 0, pass = getField("key_pass");
        if (wrongPass(pass)) { await interaction.editReply({ content: "❌ Senha incorreta!" }); return; }
        if (findKey(name))   { await interaction.editReply({ content: `❌ Chave \`${name}\` já existe!` }); return; }
        const dur = (h * 3600 + m * 60) * 1000;
        if (dur <= 0) { await interaction.editReply({ content: "❌ Duração inválida!" }); return; }
        keys[name] = { expiry: Date.now() + dur, paused: false, remaining: dur, hwid: null, discordId: null };
        await saveKey(name);
        await interaction.editReply({ content: `✅ Chave \`${name}\` criada! Duração: **${formatTime(dur)}**` });
        return;
    }
    if (id === "modal_lifetime") {
        const name = getField("key_name").trim(), pass = getField("key_pass");
        if (wrongPass(pass)) { await interaction.editReply({ content: "❌ Senha incorreta!" }); return; }
        if (findKey(name)) { await interaction.editReply({ content: `❌ Chave \`${name}\` já existe!` }); return; }
        keys[name] = { expiry: Infinity, paused: false, remaining: Infinity, hwid: null, discordId: null };
        await saveKey(name);
        await interaction.editReply({ content: `✅ Chave \`${name}\` criada como **Lifetime ♾️**!` });
        return;
    }
    if (id === "modal_revoke") {
        const name = getField("key_name").trim(), pass = getField("key_pass");
        if (wrongPass(pass)) { await interaction.editReply({ content: "❌ Senha incorreta!" }); return; }
        if (name.toLowerCase() === "all") {
            const count = Object.keys(keys).length;
            for (const k of Object.keys(keys)) { delete keys[k]; await deleteKey(k); }
            await interaction.editReply({ content: `🗑️ **${count} chaves** removidas.` });
        } else {
            const t = findKey(name);
            if (!t) { await interaction.editReply({ content: "❌ Chave não encontrada." }); return; }
            delete keys[t]; await deleteKey(t);
            await interaction.editReply({ content: `🗑️ Chave \`${t}\` removida.` });
        }
        return;
    }
    if (id === "modal_pause") {
        const name = getField("key_name").trim(), pass = getField("key_pass");
        if (wrongPass(pass)) { await interaction.editReply({ content: "❌ Senha incorreta!" }); return; }
        if (name.toLowerCase() === "all") {
            let paused = 0, resumed = 0;
            for (const k of Object.keys(keys)) {
                const d = keys[k];
                if (d.paused) { d.expiry = Date.now() + d.remaining; d.paused = false; resumed++; }
                else { d.remaining = d.expiry === Infinity ? Infinity : d.expiry - Date.now(); d.paused = true; paused++; }
                await saveKey(k);
            }
            await interaction.editReply({ content: `⏸️ **${paused}** pausadas, **${resumed}** retomadas.` });
        } else {
            const t = findKey(name); if (!t) { await interaction.editReply({ content: "❌ Chave não encontrada." }); return; }
            const d = keys[t];
            if (d.paused) { d.expiry = Date.now() + d.remaining; d.paused = false; await saveKey(t); await interaction.editReply({ content: `▶️ \`${t}\` retomada!` }); }
            else { d.remaining = d.expiry === Infinity ? Infinity : d.expiry - Date.now(); d.paused = true; await saveKey(t); await interaction.editReply({ content: `⏸️ \`${t}\` pausada!` }); }
        }
        return;
    }
    if (id === "modal_reset") {
        const name = getField("key_name").trim(), pass = getField("key_pass");
        if (wrongPass(pass)) { await interaction.editReply({ content: "❌ Senha incorreta!" }); return; }
        if (name.toLowerCase() === "all") {
            let count = 0;
            for (const k of Object.keys(keys)) { keys[k].hwid = null; kicked[k.toLowerCase()] = Date.now(); await saveKey(k); count++; }
            await interaction.editReply({ content: `✅ HWID de **${count} chaves** resetado!` });
        } else {
            const t = findKey(name); if (!t) { await interaction.editReply({ content: "❌ Chave não encontrada." }); return; }
            keys[t].hwid = null; kicked[t.toLowerCase()] = Date.now(); await saveKey(t);
            await interaction.editReply({ content: `✅ HWID de \`${t}\` resetado!` });
        }
        return;
    }
    if (id === "modal_addtime") {
        const name = getField("key_name").trim(), h = parseInt(getField("key_h")) || 0, m = parseInt(getField("key_m")) || 0, pass = getField("key_pass");
        if (wrongPass(pass)) { await interaction.editReply({ content: "❌ Senha incorreta!" }); return; }
        const extra = (h * 3600 + m * 60) * 1000; if (extra <= 0) { await interaction.editReply({ content: "❌ Tempo inválido!" }); return; }
        if (name.toLowerCase() === "all") {
            let count = 0;
            for (const k of Object.keys(keys)) { const d = keys[k]; if (d.paused) d.remaining += extra; else if (d.expiry !== Infinity) d.expiry += extra; await saveKey(k); count++; }
            await interaction.editReply({ content: `✅ **${formatTime(extra)}** adicionado a **${count} chaves**!` });
        } else {
            const t = findKey(name); if (!t) { await interaction.editReply({ content: "❌ Chave não encontrada." }); return; }
            const d = keys[t]; if (d.paused) d.remaining += extra; else if (d.expiry !== Infinity) d.expiry += extra; await saveKey(t);
            await interaction.editReply({ content: `✅ **${formatTime(extra)}** adicionado a \`${t}\`!` });
        }
        return;
    }
    if (id === "modal_setexpiry") {
        const name = getField("key_name").trim(), h = parseInt(getField("key_h")) || 0, m = parseInt(getField("key_m")) || 0, pass = getField("key_pass");
        if (wrongPass(pass)) { await interaction.editReply({ content: "❌ Senha incorreta!" }); return; }
        const t = findKey(name); if (!t) { await interaction.editReply({ content: "❌ Chave não encontrada." }); return; }
        const dur = (h * 3600 + m * 60) * 1000; if (dur <= 0) { await interaction.editReply({ content: "❌ Duração inválida!" }); return; }
        const d = keys[t]; if (d.paused) { d.remaining = dur; } else { d.expiry = Date.now() + dur; d.remaining = dur; } await saveKey(t);
        await interaction.editReply({ content: `✅ Expiração de \`${t}\` redefinida para **${formatTime(dur)}**!` });
        return;
    }
    if (id === "modal_extend") {
        const name = getField("key_name").trim(), h = parseInt(getField("key_h")) || 0, m = parseInt(getField("key_m")) || 0, pass = getField("key_pass");
        if (wrongPass(pass)) { await interaction.editReply({ content: "❌ Senha incorreta!" }); return; }
        const t = findKey(name); if (!t) { await interaction.editReply({ content: "❌ Chave não encontrada." }); return; }
        const extra = (h * 3600 + m * 60) * 1000; const d = keys[t];
        if (d.paused) d.remaining += extra; else if (d.expiry !== Infinity) d.expiry += extra; await saveKey(t);
        await interaction.editReply({ content: `✅ \`${t}\` estendida em **${formatTime(extra)}**!` });
        return;
    }
    if (id === "modal_transfer") {
        const oldName = getField("key_old").trim(), newName = getField("key_new").trim(), pass = getField("key_pass");
        if (wrongPass(pass)) { await interaction.editReply({ content: "❌ Senha incorreta!" }); return; }
        const t = findKey(oldName); if (!t) { await interaction.editReply({ content: "❌ Chave não encontrada." }); return; }
        if (findKey(newName)) { await interaction.editReply({ content: `❌ Chave \`${newName}\` já existe!` }); return; }
        keys[newName] = { ...keys[t] }; delete keys[t]; await deleteKey(t); await saveKey(newName);
        await interaction.editReply({ content: `✅ Chave transferida de \`${t}\` para \`${newName}\`!` });
        return;
    }
    if (id === "modal_sethwid") {
        const name = getField("key_name").trim(), hwid = getField("key_hwid").trim() || null, pass = getField("key_pass");
        if (wrongPass(pass)) { await interaction.editReply({ content: "❌ Senha incorreta!" }); return; }
        const t = findKey(name); if (!t) { await interaction.editReply({ content: "❌ Chave não encontrada." }); return; }
        keys[t].hwid = hwid; await saveKey(t);
        await interaction.editReply({ content: `✅ HWID de \`${t}\` definido para \`${hwid}\`!` });
        return;
    }
    if (id === "modal_lookup") {
        const name = getField("key_name").trim(), t = findKey(name);
        if (!t) { await interaction.editReply({ content: "❌ Chave não encontrada." }); return; }
        const d = keys[t];
        const timeLeft = d.expiry === Infinity ? "Lifetime ♾️" : formatTime(d.expiry - Date.now());
        await interaction.editReply({ embeds: [new EmbedBuilder().setTitle(`🔍 Info: ${t}`).setColor(d.paused ? 0xFFA000 : 0x00C853)
            .addFields(
                { name: "⏱️ Tempo Restante", value: timeLeft,                                                          inline: true },
                { name: "📌 Status",          value: d.paused ? "⏸️ Pausada" : "✅ Ativa",                            inline: true },
                { name: "💻 HWID",            value: d.hwid ? `\`${d.hwid.substring(0, 12)}...\`` : "Livre",         inline: false },
                { name: "👤 Discord",          value: d.discordId ? `<@${d.discordId}>` : "*(não vinculado)*",        inline: true }
            ).setTimestamp()] });
        return;
    }
    if (id === "modal_unblock") {
        const ip = getField("ip_address").trim(), pass = getField("key_pass");
        if (wrongPass(pass)) { await interaction.editReply({ content: "❌ Senha incorreta!" }); return; }
        if (blockedIPs[ip]) { delete blockedIPs[ip]; await interaction.editReply({ content: `✅ IP \`${ip}\` desbloqueado.` }); }
        else await interaction.editReply({ content: "IP não estava bloqueado." });
        return;
    }
    if (id === "modal_cleanlogs") {
        const pass = getField("key_pass");
        if (wrongPass(pass)) { await interaction.editReply({ content: "❌ Senha incorreta!" }); return; }
        const count = brainrots.length; brainrots.length = 0;
        await interaction.editReply({ content: `🧹 **${count}** brainrots removidos da fila.` });
        return;
    }
}

// ── MODAL BUILDERS ──
function buildModal_create() { return new ModalBuilder().setCustomId("modal_create").setTitle("🔑 Criar Key").addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("key_name").setLabel("Nome da key").setStyle(TextInputStyle.Short).setRequired(true)),new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("key_h").setLabel("Horas").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("Ex: 24")),new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("key_m").setLabel("Minutos").setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder("Ex: 0")),new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("key_pass").setLabel("Senha de admin").setStyle(TextInputStyle.Short).setRequired(true))); }
function buildModal_lifetime() { return new ModalBuilder().setCustomId("modal_lifetime").setTitle("♾️ Criar Key Lifetime").addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("key_name").setLabel("Nome da key").setStyle(TextInputStyle.Short).setRequired(true)),new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("key_pass").setLabel("Senha de admin").setStyle(TextInputStyle.Short).setRequired(true))); }
function buildModal_revoke() { return new ModalBuilder().setCustomId("modal_revoke").setTitle("🗑️ Revogar Key").addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("key_name").setLabel("Nome da key (ou 'all' para todas)").setStyle(TextInputStyle.Short).setRequired(true)),new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("key_pass").setLabel("Senha de admin").setStyle(TextInputStyle.Short).setRequired(true))); }
function buildModal_pause() { return new ModalBuilder().setCustomId("modal_pause").setTitle("⏸️ Pausar / Retomar Key").addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("key_name").setLabel("Nome da key (ou 'all' para todas)").setStyle(TextInputStyle.Short).setRequired(true)),new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("key_pass").setLabel("Senha de admin").setStyle(TextInputStyle.Short).setRequired(true))); }
function buildModal_reset() { return new ModalBuilder().setCustomId("modal_reset").setTitle("🔄 Resetar HWID").addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("key_name").setLabel("Nome da key (ou 'all' para todas)").setStyle(TextInputStyle.Short).setRequired(true)),new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("key_pass").setLabel("Senha de admin").setStyle(TextInputStyle.Short).setRequired(true))); }
function buildModal_addtime() { return new ModalBuilder().setCustomId("modal_addtime").setTitle("⏱️ Adicionar Tempo").addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("key_name").setLabel("Nome da key (ou 'all' para todas)").setStyle(TextInputStyle.Short).setRequired(true)),new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("key_h").setLabel("Horas a adicionar").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("Ex: 12")),new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("key_m").setLabel("Minutos a adicionar").setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder("Ex: 30")),new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("key_pass").setLabel("Senha de admin").setStyle(TextInputStyle.Short).setRequired(true))); }
function buildModal_setexpiry() { return new ModalBuilder().setCustomId("modal_setexpiry").setTitle("📅 Redefinir Expiração").addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("key_name").setLabel("Nome da key").setStyle(TextInputStyle.Short).setRequired(true)),new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("key_h").setLabel("Novo tempo — Horas").setStyle(TextInputStyle.Short).setRequired(true)),new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("key_m").setLabel("Novo tempo — Minutos").setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder("0")),new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("key_pass").setLabel("Senha de admin").setStyle(TextInputStyle.Short).setRequired(true))); }
function buildModal_extend() { return new ModalBuilder().setCustomId("modal_extend").setTitle("➕ Estender Key").addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("key_name").setLabel("Nome da key").setStyle(TextInputStyle.Short).setRequired(true)),new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("key_h").setLabel("Horas a adicionar").setStyle(TextInputStyle.Short).setRequired(true)),new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("key_m").setLabel("Minutos a adicionar").setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder("0")),new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("key_pass").setLabel("Senha de admin").setStyle(TextInputStyle.Short).setRequired(true))); }
function buildModal_transfer() { return new ModalBuilder().setCustomId("modal_transfer").setTitle("🔀 Transferir Key").addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("key_old").setLabel("Nome atual da key").setStyle(TextInputStyle.Short).setRequired(true)),new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("key_new").setLabel("Novo nome da key").setStyle(TextInputStyle.Short).setRequired(true)),new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("key_pass").setLabel("Senha de admin").setStyle(TextInputStyle.Short).setRequired(true))); }
function buildModal_sethwid() { return new ModalBuilder().setCustomId("modal_sethwid").setTitle("💻 Definir HWID").addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("key_name").setLabel("Nome da key").setStyle(TextInputStyle.Short).setRequired(true)),new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("key_hwid").setLabel("Novo HWID").setStyle(TextInputStyle.Short).setRequired(true)),new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("key_pass").setLabel("Senha de admin").setStyle(TextInputStyle.Short).setRequired(true))); }
function buildModal_lookup() { return new ModalBuilder().setCustomId("modal_lookup").setTitle("🔍 Lookup Key").addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("key_name").setLabel("Nome da key").setStyle(TextInputStyle.Short).setRequired(true))); }
function buildModal_unblock() { return new ModalBuilder().setCustomId("modal_unblock").setTitle("🔓 Desbloquear IP").addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ip_address").setLabel("Endereço IP").setStyle(TextInputStyle.Short).setRequired(true)),new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("key_pass").setLabel("Senha de admin").setStyle(TextInputStyle.Short).setRequired(true))); }
function buildModal_cleanlogs() { return new ModalBuilder().setCustomId("modal_cleanlogs").setTitle("🧹 Limpar Logs").addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("key_pass").setLabel("Senha de admin").setStyle(TextInputStyle.Short).setRequired(true))); }

clientLogs.on("messageCreate", async (message) => {
    if (message.author.bot) return;
    if (message.content === "!logspanel") { await sendLogsPanel(); return; }
    if (!message.content.startsWith("!")) return;
    const args = message.content.slice(1).trim().split(/ +/);
    const cmd  = args.shift().toLowerCase();
    const wrongPass = (pass) => pass !== ADMIN_PASS;
    switch (cmd) {
        case "online": {
            const sentMsg = await message.reply({ embeds: [buildOnlineEmbed()] });
            if (!global.onlineIntervals) global.onlineIntervals = {};
            if (global.onlineIntervals[message.channel.id]) clearInterval(global.onlineIntervals[message.channel.id]);
            global.onlineIntervals[message.channel.id] = setInterval(async () => {
                await sentMsg.edit({ embeds: [buildOnlineEmbed()] }).catch(() => { clearInterval(global.onlineIntervals[message.channel.id]); delete global.onlineIntervals[message.channel.id]; });
            }, 5000);
            break;
        }
        case "stoponline": { if (global.onlineIntervals?.[message.channel.id]) { clearInterval(global.onlineIntervals[message.channel.id]); delete global.onlineIntervals[message.channel.id]; message.reply("⏹️ Parado."); } else message.reply("Nenhuma atualização ativa."); break; }
        case "blocked": { const now = Date.now(); const active = Object.entries(blockedIPs).filter(([, u]) => now < u); if (!active.length) { message.reply("Nenhum IP bloqueado."); break; } message.reply("🔒 **IPs Bloqueados:**\n" + active.map(([ip, u]) => `• \`${ip}\` — ${Math.ceil((u - now) / 1000)}s`).join("\n")); break; }
        case "unblock": { const [ip, pass] = args; if (wrongPass(pass)) { message.reply("❌ Senha incorreta!"); break; } if (blockedIPs[ip]) { delete blockedIPs[ip]; message.reply(`✅ IP \`${ip}\` desbloqueado.`); } else message.reply("IP não estava bloqueado."); break; }
        case "test": { const p = { id: Date.now().toString(), title: "TESTE", description: "OK!", brainrot: "TESTE", name: "TESTE", jobId: null, value: "999999999", players: "N/A" }; brainrots.push(p); io.emit("brainrot", p); message.reply("✅ Teste enviado!"); break; }
        case "stats": { const all = Object.values(keys); const active = all.filter(k => !k.paused && (k.expiry === Infinity || k.expiry - Date.now() > 0)); const paused = all.filter(k => k.paused); const lt = all.filter(k => k.expiry === Infinity); const online = Object.values(presence).filter(p => Date.now() - p.lastSeen < 30000); message.reply({ embeds: [new EmbedBuilder().setTitle("📊 Estatísticas").setColor(0x5865F2).addFields({ name: "🔑 Total", value: String(all.length), inline: true },{ name: "✅ Ativas", value: String(active.length), inline: true },{ name: "⏸️ Pausadas", value: String(paused.length), inline: true },{ name: "♾️ Lifetime", value: String(lt.length), inline: true },{ name: "🟢 Online", value: String(online.length), inline: true },{ name: "📡 Brainrots", value: String(brainrots.length), inline: true }).setTimestamp()] }); break; }
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// ─── BOT PANEL ───────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
const clientPanel = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
    partials: [Partials.Channel, Partials.Message]
});

const awaitingInput = {};

function buildPanelEmbed() {
    return new EmbedBuilder().setTitle("Bob Auto Joiner").setColor(0x5865F2)
        .setDescription("This control panel is for the project: **Bob Joiner**\n\nIf you're a buyer, click on the buttons below to redeem your key, get the script or get your role")
        .addFields(
            { name: "🔑 Redeem Key",  value: "Place to validate your Key",                                   inline: false },
            { name: "📋 View Script", value: "Shows the **Bob Joiner** Script (Key Required)",               inline: false },
            { name: "📊 Key Info",    value: "Shows your Key Status (Key Required)",                         inline: false },
            { name: "⚙️ Reset HWID",  value: "Reset the Hardware Identification of your Key (Key Required)", inline: false }
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
    if (PANEL_CHANNEL_ID) {
        try {
            const ch = await clientPanel.channels.fetch(PANEL_CHANNEL_ID);
            if (ch) {
                const msgs = await ch.messages.fetch({ limit: 10 });
                for (const [, msg] of msgs) { if (msg.author.id === clientPanel.user.id) await msg.delete().catch(() => {}); }
                await ch.send({ embeds: [buildPanelEmbed()], components: buildPanelRows() });
            }
        } catch (e) { console.error("[PANEL] Erro ao enviar painel:", e.message); }
    }
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
        if (state.step === "redeem_key") { delete awaitingInput[message.author.id]; return message.reply(`✅ Key válida! Tempo restante: **${d.expiry === Infinity ? "Lifetime ♾️" : formatTime(d.expiry - Date.now())}**`); }
        if (state.step === "script_key") { delete awaitingInput[message.author.id]; return message.reply("📋 **Bob Joiner Script**\n\n" + (SCRIPT_URL ? `\`\`\`\nloadstring(game:HttpGet('${SCRIPT_URL}'))()\n\`\`\`` : "❌ Script URL não configurada.")); }
        if (state.step === "role_key") {
            if (d.discordId && d.discordId !== message.author.id) return message.reply("❌ Essa key já está vinculada a outro Discord!");
            d.discordId = message.author.id; await saveKey(keyName); delete awaitingInput[message.author.id];
            const ROLE_ID = process.env.BUYER_ROLE_ID;
            if (ROLE_ID && state.guildId) { try { const guild = await clientPanel.guilds.fetch(state.guildId); const member = await guild.members.fetch(message.author.id); await member.roles.add(ROLE_ID); return message.reply(`✅ Discord vinculado e cargo adicionado!`); } catch { return message.reply(`✅ Discord vinculado à key \`${keyName}\`!`); } }
            return message.reply(`✅ Discord vinculado à key \`${keyName}\`!`);
        }
        if (state.step === "hwid_key") { keys[keyName].hwid = null; kicked[keyName.toLowerCase()] = Date.now(); await saveKey(keyName); delete awaitingInput[message.author.id]; return message.reply("✅ HWID resetado!"); }
        if (state.step === "stats_key") {
            delete awaitingInput[message.author.id];
            return message.reply({ embeds: [new EmbedBuilder().setTitle("📊 Key Info").setColor(0x5865F2).addFields(
                { name: "🔑 Key", value: `\`${keyName}\``, inline: true },
                { name: "⏱️ Tempo", value: d.expiry === Infinity ? "Lifetime ♾️" : formatTime(d.expiry - Date.now()), inline: true },
                { name: "📌 Status", value: d.paused ? "⏸️ Pausada" : "✅ Ativa", inline: true },
                { name: "💻 HWID", value: d.hwid ? `\`${d.hwid.substring(0, 8)}...\`` : "Livre", inline: false }
            )] });
        }
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
    const msgs  = { panel_redeem: "🔑 **Redeem Key**\nEnvie sua key aqui para validar:", panel_script: "📋 **Get Script**\nEnvie sua key para receber o script:", panel_role: "👤 **Get Role**\nEnvie sua key para vincular seu Discord e receber o cargo:", panel_hwid: "⚙️ **Reset HWID**\nEnvie sua key:", panel_stats: "📊 **Key Info**\nEnvie sua key:" };
    const step  = steps[interaction.customId];
    if (step) {
        awaitingInput[user.id] = { step, guildId: interaction.guildId };
        try { await user.send(msgs[interaction.customId]); await interaction.editReply({ content: "📩 Te mandei uma DM!" }); }
        catch { await interaction.editReply({ content: "❌ Habilite mensagens privadas do servidor!" }); }
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// ─── BOT PAGAMENTO (buy-here) ────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
const clientPayment = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
    partials: [Partials.Channel, Partials.Message]
});

function buildShopEmbed() {
    const planList = PLANS.map(p => `${p.emoji} **${p.label}** — R$${p.price},00`).join("\n");
    return new EmbedBuilder()
        .setColor(0x00ff88)
        .setTitle("🛒 Bob Keys — Loja")
        .setDescription(`Escolha seu plano abaixo:\n\n${planList}\n\n> Após escolher, você receberá os dados do Pix.\n> Mande o comprovante aqui e um admin confirma sua key!`)
        .setFooter({ text: "Bob Keys • Sistema de Keys Automático" })
        .setTimestamp();
}

function buildShopRows() {
    const row = new ActionRowBuilder();
    PLANS.forEach(p => {
        row.addComponents(new ButtonBuilder().setCustomId(`buy_${p.value}`).setLabel(`${p.emoji} ${p.label} — R$${p.price}`).setStyle(ButtonStyle.Success));
    });
    row.addComponents(new ButtonBuilder().setCustomId("buy_minhakey").setLabel("🔑 Minha Key").setStyle(ButtonStyle.Secondary));
    return [row];
}

clientPayment.on("ready", async () => {
    console.log(`[PAYMENT] Online: ${clientPayment.user.tag}`);
    try {
        const ch = await clientPayment.channels.fetch(BUY_CHANNEL);
        if (ch) {
            const msgs = await ch.messages.fetch({ limit: 10 });
            for (const [, msg] of msgs) { if (msg.author.id === clientPayment.user.id) await msg.delete().catch(() => {}); }
            await ch.send({ embeds: [buildShopEmbed()], components: buildShopRows() });
            console.log("[PAYMENT] Loja enviada no canal buy-here!");
        }
    } catch (e) { console.error("[PAYMENT] Erro ao enviar loja:", e.message); }
});

clientPayment.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;
    const id   = interaction.customId;
    const user = interaction.user;

    // ── COMPRAR PLANO ──
    if (id.startsWith("buy_") && id !== "buy_minhakey") {
        const planValue = id.replace("buy_", "");
        const plan      = PLANS.find(p => p.value === planValue);
        if (!plan) return interaction.reply({ content: "❌ Plano inválido!", ephemeral: true });

        await PendingPayment.findOneAndUpdate(
            { discordId: user.id },
            { discordId: user.id, discordTag: user.tag, hours: plan.hours, price: plan.price, label: plan.label },
            { upsert: true, new: true }
        );

        return interaction.reply({ embeds: [new EmbedBuilder()
            .setColor(0x00ccff)
            .setTitle("💳 Dados para Pagamento Pix")
            .setDescription(
                `**Plano:** ${plan.emoji} ${plan.label}\n**Valor:** R$${plan.price},00\n\n` +
                `**🔑 Chave Pix:**\n\`\`\`${PIX_KEY}\`\`\`\n` +
                `**Nome:** ${PIX_NAME}\n\n` +
                `> ✅ Após pagar, mande o **comprovante** aqui no canal!\n> Um admin confirma e a key chega no seu privado.`
            )
            .setFooter({ text: `Pedido registrado • ${user.tag}` })
            .setTimestamp()], ephemeral: true });
    }

    // ── MINHA KEY ──
    if (id === "buy_minhakey") {
        const userKeys = Object.entries(keys).filter(([, d]) => d.discordId === user.id);
        if (!userKeys.length) return interaction.reply({ content: "❌ Nenhuma key ativa! Use a loja para comprar.", ephemeral: true });
        const now  = Date.now();
        const list = userKeys.map(([k, d]) => {
            const rem = d.expiry === Infinity ? "Lifetime ♾️" : (d.expiry - now > 0 ? formatTime(d.expiry - now) : "❌ Expirada");
            return `\`${k}\` — ⏳ ${rem}`;
        }).join("\n");
        return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x00ff88).setTitle("🔑 Suas Keys").setDescription(list).setFooter({ text: user.tag })], ephemeral: true });
    }
});

clientPayment.on("messageCreate", async (msg) => {
    if (msg.author.bot) return;
    if (msg.content === "!loja" && msg.channel.id === BUY_CHANNEL) {
        await msg.channel.send({ embeds: [buildShopEmbed()], components: buildShopRows() });
        if (msg.deletable) msg.delete().catch(() => {});
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// ─── ENDPOINTS ───────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
app.get("/health", (req, res) => res.json({ status: "ok", time: Date.now() }));
app.get("/",       (req, res) => res.send("<h1>Bob API v10 — Online ✅</h1>"));

app.get("/validate", requireClientHeader, (req, res) => {
    const { key, secret, hwid } = req.query;
    const r = checkKey(key, secret, hwid);
    if (!r.ok) return res.status(403).json({ status: "error", message: r.error });
    const timeLeft = r.data.expiry === Infinity ? 9999999999999 : r.data.expiry - Date.now();
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

app.get("/logs",       requireClientHeader, (req, res) => { const { key, secret, hwid } = req.query; const r = checkKey(key, secret, hwid); if (!r.ok) return res.status(403).json({ status: "error", message: r.error }); res.json(brainrots); });
app.get("/api/latest", requireClientHeader, (req, res) => { const { key, secret, hwid } = req.query; const r = checkKey(key, secret, hwid); if (!r.ok) return res.status(403).json({ status: "error", message: r.error }); if (!brainrots.length) return res.json({ status: "waiting" }); res.json(brainrots[brainrots.length - 1]); });

app.post("/api/notify", requireClientHeader, (req, res) => {
    const { key, secret, name, jobId, value, description } = req.body;
    if (!secret || secret !== SCRIPT_SECRET) return res.status(403).json({ status: "error", message: "Secret inválido." });
    const keyName = findKey(key);
    if (!keyName) return res.status(403).json({ status: "error", message: "Chave nao existe." });
    const keyData = keys[keyName];
    if (keyData.paused) return res.status(403).json({ status: "error", message: "Chave pausada." });
    if (keyData.expiry !== Infinity && keyData.expiry - Date.now() <= 0) return res.status(403).json({ status: "error", message: "Chave expirada." });
    const payload = { id: Date.now().toString(), title: name || "Brainrot", description: description || name || "Novo Brainrot!", brainrot: name || "Brainrot", name: name || "Brainrot", jobId: xorObfuscate(jobId) || null, value: String(value || "0"), players: "N/A" };
    brainrots.push(payload); if (brainrots.length > 100) brainrots.shift(); io.emit("brainrot", payload);
    console.log(`[NOTIFY] ✅ ${payload.title} | key: ${keyName}`);
    res.json({ status: "ok", id: payload.id });
});

app.get("/kicked",  requireClientHeader, (req, res) => { const { key, secret } = req.query; if (secret !== SCRIPT_SECRET) return res.json({ kicked: false }); const keyName = findKey(key); if (!keyName) return res.json({ kicked: false }); const ts = kicked[keyName.toLowerCase()]; if (ts) { delete kicked[keyName.toLowerCase()]; return res.json({ kicked: true }); } res.json({ kicked: false }); });

app.post("/presence", requireClientHeader, async (req, res) => {
    const { key, secret, hwid, sessionId, name, jobId, discordId } = req.query;
    const r = checkKey(key, secret, hwid);
    if (!r.ok) return res.status(403).json({ status: "error", message: r.error });
    presence[sessionId] = { name: name || "Unknown", lastSeen: Date.now(), key: (key || "").trim() };
    if (jobId && name) userJobIds[name] = jobId;
    if (discordId && r.keyName) { const d = keys[r.keyName]; const cleanId = String(discordId).replace(/\D/g, ""); if (cleanId.length >= 17 && cleanId.length <= 20 && !d.discordId) { d.discordId = cleanId; await saveKey(r.keyName); } }
    res.json({ status: "ok" });
});

app.get("/presence",  requireClientHeader, (req, res) => { const { key, secret, hwid } = req.query; const r = checkKey(key, secret, hwid); if (!r.ok) return res.status(403).json({ status: "error", message: r.error }); const now = Date.now(); const active = {}; for (const [sid, info] of Object.entries(presence)) { if (now - info.lastSeen < 30000) active[info.name] = true; else delete presence[sid]; } res.json(Object.keys(active).sort()); });
app.get("/clients",   (req, res) => res.send(`Socket.IO: ${io.sockets.sockets.size} | Presença: ${Object.keys(presence).length}`));
app.get("/test-emit", (req, res) => { if (req.query.secret !== SCRIPT_SECRET) return res.status(403).send("Secret invalido"); const p = { id: Date.now().toString(), title: "TESTE MANUAL", description: "OK!", brainrot: "TESTE", name: "TESTE", jobId: null, value: "0" }; brainrots.push(p); io.emit("brainrot", p); res.send("✅ Emit enviado!"); });

app.post("/push-brainrot", requireClientHeader, (req, res) => {
    const { secret, title, description, jobId, value, players } = req.body;
    if (secret !== SCRIPT_SECRET) return res.status(403).json({ status: "error", message: "Secret inválido" });
    const payload = { id: Date.now().toString(), title: title || "Brainrot", description: description || "", brainrot: title || "Brainrot", name: title || "Brainrot", jobId: xorObfuscate(jobId) || null, value: value || "0", players: players || "N/A" };
    brainrots.push(payload); if (brainrots.length > 100) brainrots.shift(); io.emit("brainrot", payload);
    console.log(`[PUSH] ✅ ${payload.title}`); res.json({ status: "ok", id: payload.id });
});

app.post("/link-discord", requireClientHeader, async (req, res) => {
    const { key, secret, hwid, discordId } = req.query;
    const r = checkKey(key, secret, hwid); if (!r.ok) return res.status(403).json({ status: "error", message: r.error });
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

// ─── LOGIN ───────────────────────────────────────────────────────────────────
if (DISCORD_TOKEN_NOTIFIER) clientNotifier.login(DISCORD_TOKEN_NOTIFIER).then(() => console.log("[NOTIFIER] Login OK")).catch(e => console.error("[NOTIFIER] Erro:", e.message));
else console.warn("[NOTIFIER] Token ausente.");

if (DISCORD_TOKEN_LOGS) clientLogs.login(DISCORD_TOKEN_LOGS).then(() => console.log("[LOGS] Login OK")).catch(e => console.error("[LOGS] Erro:", e.message));
else console.warn("[LOGS] Token ausente.");

if (DISCORD_TOKEN_PANEL) clientPanel.login(DISCORD_TOKEN_PANEL).then(() => console.log("[PANEL] Login OK")).catch(e => console.error("[PANEL] Erro:", e.message));
else console.warn("[PANEL] Token ausente.");

if (DISCORD_TOKEN_PAYMENT) clientPayment.login(DISCORD_TOKEN_PAYMENT).then(() => console.log("[PAYMENT] Login OK")).catch(e => console.error("[PAYMENT] Erro:", e.message));
else console.warn("[PAYMENT] Token ausente — adicione DISCORD_TOKEN_PAYMENT no .env!");

if (MONGODB_URI) loadKeys();

server.listen(port, () => console.log(`[SERVER] Porta ${port}`));