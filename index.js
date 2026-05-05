const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Client, GatewayIntentBits } = require("discord.js");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const port = process.env.PORT || 3000;

// --- CONFIGURAÇÕES (Pegas das Environment Variables / Secrets) --- //
const ADMIN_PASS = process.env.ADMIN_PASS || "ADMIN_2024_XYZ";
const SCRIPT_SECRET = process.env.SCRIPT_SECRET || "BOB_SECURE_2024_XYZ";
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;

const keys = {}; 

// --- AUXILIARES --- //
const generateKey = () => `BOB-${Math.random().toString(36).substring(2, 10).toUpperCase()}`;
const formatTime = (ms) => {
    if (ms === Infinity) return "Lifetime";
    if (ms <= 0) return "Expirado";
    const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
    const p = [];
    if (h > 0) p.push(`${h}h`);
    if (m % 60 > 0) p.push(`${m % 60}m`);
    if (s % 60 > 0 || p.length === 0) p.push(`${s % 60}s`);
    return p.join(" ");
};

// --- DISCORD BOT --- //
const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildPresences
    ] 
});

client.on("messageCreate", async message => {
    if (message.author.bot && message.channel.id !== DISCORD_CHANNEL_ID) return;

    // 1. MONITORAMENTO DE EMBEDS (BRAINROTS)
    if (message.channel.id === DISCORD_CHANNEL_ID && message.embeds.length > 0) {
        const embed = message.embeds[0];
        const brainrotData = {
            title: embed.title || "Bob Detectado!",
            description: embed.description || "",
            fields: embed.fields || [],
            color: embed.color || 0x3498db,
            timestamp: new Date()
        };
        console.log(`[LOG] Embed detectada! Enviando para os clientes via WebSocket...`);
        io.emit("brainrot", brainrotData); // Envia para todos os scripts conectados
        return;
    }

    // 2. COMANDOS DO BOT (Apenas se começar com !)
    if (!message.content.startsWith("!")) return;
    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();
    const adminPassInput = args[args.length - 1];
    const hasAdmin = adminPassInput === ADMIN_PASS;

    switch (command) {
        case "info":
            let info = Object.keys(keys).length ? "**Chaves Ativas:**\n" : "Nenhuma chave ativa.";
            for (const k in keys) {
                const d = keys[k];
                const t = d.paused ? d.remaining : d.expiry - Date.now();
                info += `• \`${k}\`: ${formatTime(t)} ${d.paused ? "⏸️" : "✅"} ${d.hwid ? `(ID: ${d.hwid.substring(0,8)}...)` : "(Livre)"}\n`;
            }
            message.reply(info);
            break;
        case "create":
            if (!hasAdmin) return message.reply("Senha de administrador incorreta.");
            args.pop();
            const h = parseInt(args[0]) || 0, m = parseInt(args[1]) || 0, name = args[2] || generateKey();
            const dur = (h * 3600 + m * 60) * 1000;
            keys[name] = { expiry: Date.now() + dur, paused: false, remaining: dur, hwid: null };
            message.reply(`Chave criada: **${name}** por ${formatTime(dur)}`);
            break;
        case "reset":
            if (!hasAdmin) return message.reply("Senha de administrador incorreta.");
            args.pop();
            const kReset = args[0];
            if (keys[kReset]) { keys[kReset].hwid = null; message.reply(`HWID da chave \`${kReset}\` resetado!`); }
            else message.reply("Chave não encontrada.");
            break;
        case "pause":
            if (!hasAdmin) return message.reply("Senha de administrador incorreta.");
            args.pop();
            const d = keys[args[0]];
            if (d) {
                if (d.paused) { d.expiry = Date.now() + d.remaining; d.paused = false; message.reply(`Chave \`${args[0]}\` despausada!`); }
                else { d.remaining = d.expiry - Date.now(); d.paused = true; message.reply(`Chave \`${args[0]}\` pausada!`); }
            } else message.reply("Chave não encontrada.");
            break;
    }
});

if (DISCORD_TOKEN) client.login(DISCORD_TOKEN);

// --- API ENDPOINTS (HTTP) --- //
app.get("/validate", (req, res) => {
    const { key, secret, hwid } = req.query;
    if (secret !== SCRIPT_SECRET) return res.status(403).json({ status: "error", message: "Anti-Dualhook!" });
    const data = keys[key];
    if (!data) return res.status(404).json({ status: "error", message: "Chave inválida." });
    if (data.paused) return res.status(403).json({ status: "error", message: "Chave pausada." });
    
    if (!data.hwid) data.hwid = hwid;
    else if (data.hwid !== hwid) return res.status(403).json({ status: "error", message: "HWID inválido! Chave presa a outro PC." });
    
    const left = data.expiry - Date.now();
    if (left <= 0) { delete keys[key]; return res.status(403).json({ status: "error", message: "Chave expirada." }); }
    res.json({ status: "success", time_left: left });
});

// --- SOCKET.IO (TEMPO REAL) --- //
io.on("connection", (socket) => {
    socket.on("authenticate", ({ key, secret, hwid }) => {
        const d = keys[key];
        if (secret === SCRIPT_SECRET && d && !d.paused && (d.hwid === hwid || !d.hwid)) {
            socket.authenticated = true;
            socket.emit("authenticated", { message: "Conectado ao Bob Notifier!" });
        } else {
            socket.emit("auth_error", { message: "Falha na autenticação do Socket." });
            socket.disconnect();
        }
    });
});

app.get("/", (req, res) => res.send("API Bob Notifier Online com WebSocket e Leitor de Embeds!"));
server.listen(port, () => console.log(`Servidor rodando na porta ${port}`));