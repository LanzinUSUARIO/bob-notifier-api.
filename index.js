const express = require("express");
const http = require("http");
const https = require("https");
const { Server } = require("socket.io");
const {
    Client, GatewayIntentBits,
    ActionRowBuilder, ButtonBuilder, ButtonStyle,
    EmbedBuilder, Events
} = require("discord.js");

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
const DISCORD_TOKEN_PANEL    = process.env.DISCORD_TOKEN_PANEL; // novo bot do painel
const DISCORD_CHANNEL_ID     = process.env.DISCORD_CHANNEL_ID || "1494529159484149801";
const PANEL_CHANNEL_ID       = process.env.PANEL_CHANNEL_ID   || ""; // canal onde o painel fica

const keys      = {};
const brainrots = [];
const presence  = {};
const kicked    = {};

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

// ─── KEEP-ALIVE (pinga a própria API a cada 4 minutos) ────────────────────────
setInterval(() => {
    https.get(`https://bob-notifier-api.onrender.com/health`, (res) => {
        console.log(`[KEEP-ALIVE] ping ok: ${res.statusCode}`);
    }).on("error", (e) => {
        console.log(`[KEEP-ALIVE] erro: ${e.message}`);
    });
}, 4 * 60 * 1000);

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
});

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
        jobId, value, players
    };

    brainrots.push(payload);
    if (brainrots.length > 100) brainrots.shift();
    io.emit("brainrot", payload);
    console.log(`[NOTIFIER] ✅ ${payload.title} | jobId: ${jobId}`);
});

// ─── BOT LOGS (comandos de texto) ─────────────────────────────────────────────
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
            kicked[t.toLowerCase()] = Date.now();
            message.reply(`✅ HWID de \`${t}\` resetado!`);
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
                message.reply(`⏸️ \`${t}\` pausada!`);
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
                "`!reset <nome> <senha>` — Reseta HWID\n" +
                "`!pause <nome> <senha>` — Pausa/retoma\n" +
                "`!extend <nome> <h> <m> <senha>` — Adiciona tempo\n" +
                "`!info` — Lista chaves\n" +
                "`!test` — Brainrot de teste"
            );
            break;
        }
    }
});

// ─── BOT PAINEL (botões interativos) ──────────────────────────────────────────
const clientPanel = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Mapa de usuários aguardando input: { userId: { step, data } }
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

    // Envia o painel no canal configurado ao iniciar
    if (PANEL_CHANNEL_ID) {
        try {
            const ch = await clientPanel.channels.fetch(PANEL_CHANNEL_ID);
            if (ch) {
                // Deleta mensagens antigas do bot no canal para não duplicar
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

// Escuta comandos de texto para reenviar o painel manualmente
clientPanel.on("messageCreate", async (message) => {
    if (message.author.bot) return;

    // Coleta respostas de usuários aguardando input via DM
    if (message.channel.type === 1) { // DM
        const state = awaitingInput[message.author.id];
        if (!state) return;

        if (state.step === "redeem_key") {
            const key = message.content.trim();
            const keyName = findKey(key);
            if (!keyName) {
                return message.reply("❌ Key não encontrada! Verifique e tente novamente.");
            }
            const d = keys[keyName];
            if (d.paused) return message.reply("⏸️ Sua key está pausada. Contate o suporte.");
            if (d.expiry !== Infinity && d.expiry - Date.now() <= 0) {
                return message.reply("⌛ Sua key expirou!");
            }
            delete awaitingInput[message.author.id];
            const timeLeft = d.expiry === Infinity ? "Lifetime ♾️" : formatTime(d.expiry - Date.now());
            return message.reply(`✅ Key válida! Tempo restante: **${timeLeft}**`);
        }

        if (state.step === "hwid_key") {
            const key = message.content.trim();
            const keyName = findKey(key);
            if (!keyName) return message.reply("❌ Key não encontrada!");
            keys[keyName].hwid = null;
            kicked[keyName.toLowerCase()] = Date.now();
            delete awaitingInput[message.author.id];
            return message.reply("✅ HWID resetado com sucesso! Você já pode logar em outro dispositivo.");
        }

        if (state.step === "stats_key") {
            const key = message.content.trim();
            const keyName = findKey(key);
            if (!keyName) return message.reply("❌ Key não encontrada!");
            const d = keys[keyName];
            const timeLeft = d.expiry === Infinity ? "Lifetime ♾️" : formatTime(d.expiry - Date.now());
            const status = d.paused ? "⏸️ Pausada" : "✅ Ativa";
            const hwid = d.hwid ? `\`${d.hwid.substring(0,8)}...\`` : "Nenhum (Livre)";
            delete awaitingInput[message.author.id];
            const embed = new EmbedBuilder()
                .setTitle("📊 Key Info")
                .setColor(0x5865F2)
                .addFields(
                    { name: "🔑 Key", value: `\`${keyName}\``, inline: true },
                    { name: "⏱️ Tempo Restante", value: timeLeft, inline: true },
                    { name: "📌 Status", value: status, inline: true },
                    { name: "💻 HWID", value: hwid, inline: false }
                );
            return message.reply({ embeds: [embed] });
        }
    }

    // Comando para reenviar o painel (admin)
    if (message.content === "!panel" && PANEL_CHANNEL_ID) {
        try {
            const ch = await clientPanel.channels.fetch(PANEL_CHANNEL_ID);
            if (ch) {
                await ch.send({ embeds: [buildPanelEmbed()], components: buildPanelRows() });
                message.reply("✅ Painel enviado!");
            }
        } catch (e) {
            message.reply("❌ Erro: " + e.message);
        }
    }
});

// Interações dos botões
clientPanel.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;

    const user = interaction.user;
    await interaction.deferReply({ ephemeral: true });

    switch (interaction.customId) {

        case "panel_redeem": {
            awaitingInput[user.id] = { step: "redeem_key" };
            try {
                await user.send("🔑 **Redeem Key**\nEnvie sua key aqui para validar:");
                await interaction.editReply({ content: "📩 Te mandei uma DM! Verifique suas mensagens privadas." });
            } catch {
                await interaction.editReply({ content: "❌ Não consegui te mandar DM. Habilite mensagens privadas do servidor!" });
            }
            break;
        }

        case "panel_script": {
            // Verifica se o usuário tem key válida — pede a key em DM
            awaitingInput[user.id] = { step: "script_key" };
            try {
                await user.send(
                    "📋 **Get Script**\n" +
                    "Aqui está o script do Bob Joiner:\n\n" +
                    "```\nhttps://bob-notifier-api.onrender.com/get-script\n```\n" +
                    "Execute no seu executor Roblox!"
                );
                await interaction.editReply({ content: "📩 Script enviado na DM!" });
            } catch {
                await interaction.editReply({ content: "❌ Não consegui te mandar DM. Habilite mensagens privadas do servidor!" });
            }
            break;
        }

        case "panel_role": {
            // Tenta dar um cargo ao usuário (configure o ROLE_ID no .env)
            const ROLE_ID = process.env.BUYER_ROLE_ID;
            if (!ROLE_ID) {
                await interaction.editReply({ content: "⚠️ Cargo não configurado. Contate o admin." });
                break;
            }
            try {
                const member = await interaction.guild.members.fetch(user.id);
                await member.roles.add(ROLE_ID);
                await interaction.editReply({ content: "✅ Cargo de comprador adicionado!" });
            } catch (e) {
                await interaction.editReply({ content: "❌ Erro ao adicionar cargo: " + e.message });
            }
            break;
        }

        case "panel_hwid": {
            awaitingInput[user.id] = { step: "hwid_key" };
            try {
                await user.send("⚙️ **Reset HWID**\nEnvie sua key para resetar o HWID:");
                await interaction.editReply({ content: "📩 Te mandei uma DM!" });
            } catch {
                await interaction.editReply({ content: "❌ Não consegui te mandar DM. Habilite mensagens privadas do servidor!" });
            }
            break;
        }

        case "panel_stats": {
            awaitingInput[user.id] = { step: "stats_key" };
            try {
                await user.send("📊 **Key Info**\nEnvie sua key para ver o status:");
                await interaction.editReply({ content: "📩 Te mandei uma DM!" });
            } catch {
                await interaction.editReply({ content: "❌ Não consegui te mandar DM. Habilite mensagens privadas do servidor!" });
            }
            break;
        }
    }
});

// ─── ENDPOINTS ────────────────────────────────────────────────────────────────

app.get("/health", (req, res) => res.json({ status: "ok", time: Date.now() }));

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

app.get("/", (req, res) => res.send("<h1>Bob Dual API v7 — Online! ✅</h1>"));

// ─── LOGIN ────────────────────────────────────────────────────────────────────
if (DISCORD_TOKEN_NOTIFIER) clientNotifier.login(DISCORD_TOKEN_NOTIFIER).catch(e => console.error("[NOTIFIER]", e));
else console.warn("[NOTIFIER] Token não definido.");

if (DISCORD_TOKEN_LOGS) clientLogs.login(DISCORD_TOKEN_LOGS).catch(e => console.error("[LOGS]", e));
else console.warn("[LOGS] Token não definido.");

if (DISCORD_TOKEN_PANEL) clientPanel.login(DISCORD_TOKEN_PANEL).catch(e => console.error("[PANEL]", e));
else console.warn("[PANEL] Token não definido — crie um 3º bot e adicione DISCORD_TOKEN_PANEL no Render.");

server.listen(port, () => console.log(`[SERVER] Porta ${port}`));