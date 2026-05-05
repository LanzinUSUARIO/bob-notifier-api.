const express = require("express");
const http = require("http" );
const { Server } = require("socket.io");
const { Client, GatewayIntentBits } = require("discord.js");

const app = express();
const server = http.createServer(app );
const io = new Server(server, { cors: { origin: "*" } });

const port = process.env.PORT || 3000;

// --- CONFIGURAÇÕES (Environment Variables) --- //
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
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] 
});

client.on("messageCreate", async message => {
    // 1. LEITOR DE EMBEDS (BRAINROTS)
    if (message.channel.id === DISCORD_CHANNEL_ID && message.embeds.length > 0) {
        const embed = message.embeds[0];
        io.emit("brainrot", { title: embed.title || "Bob!", description: embed.description || "" });
        console.log("[LOG] Embed enviada para o Roblox!");
        return;
    }

    // 2. COMANDOS
    if (!message.content.startsWith("!")) return;
    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    switch (command) {
        case "info":
            let info = Object.keys(keys).length ? "**Chaves Ativas:**\n" : "Nenhuma chave.";
            for (const k in keys) {
                const d = keys[k];
                const t = d.paused ? d.remaining : d.expiry - Date.now();
                info += `• \`${k}\`: ${formatTime(t)} ${d.paused ? "⏸️" : "✅"} ${d.hwid ? `(ID: ${d.hwid.substring(0,8)}...)` : "(Livre)"}\n`;
            }
            message.reply(info);
            break;

        case "create":
            if (args.length < 4) return message.reply("Uso: !create <horas> <minutos> <nome> <senha>");
            const [h, m, name, passCreate] = args;
            if (passCreate !== ADMIN_PASS) return message.reply("Senha incorreta!");
            const dur = (parseInt(h) * 3600 + parseInt(m) * 60) * 1000;
            keys[name] = { expiry: Date.now() + dur, paused: false, remaining: dur, hwid: null };
            message.reply(`✅ Chave \`${name}\` criada por ${formatTime(dur)}`);
            break;

        case "reset":
            const [kReset, passReset] = args;
            if (passReset !== ADMIN_PASS) return message.reply("Senha incorreta!");
            if (keys[kReset]) { keys[kReset].hwid = null; message.reply(`HWID de \`${kReset}\` resetado!`); }
            else message.reply("Chave não encontrada.");
            break;

        case "pause":
            const [kPause, passPause] = args;
            if (passPause !== ADMIN_PASS) return message.reply("Senha incorreta!");
            const d = keys[kPause];
            if (d) {
                if (d.paused) { d.expiry = Date.now() + d.remaining; d.paused = false; message.reply("Ativada!"); }
                else { d.remaining = d.expiry - Date.now(); d.paused = true; message.reply("Pausada!"); }
            } else message.reply("Chave não encontrada.");
            break;

        case "revoke":
            const [kRevoke, passRevoke] = args;
            if (passRevoke !== ADMIN_PASS) return message.reply("Senha incorreta!");
            if (keys[kRevoke]) { delete keys[kRevoke]; message.reply("Chave deletada."); }
            else message.reply("Chave não encontrada.");
            break;
    }
});

client.login(DISCORD_TOKEN);

// --- API & SOCKET --- //
app.get("/validate", (req, res) => {
    const { key, secret, hwid } = req.query;
    if (secret !== SCRIPT_SECRET) return res.status(403).send("Anti-Dualhook!");
    const data = keys[key];
    if (!data) return res.status(404).send("Invalida");
    if (data.paused) return res.status(403).send("Pausada");
    if (!data.hwid) data.hwid = hwid;
    else if (data.hwid !== hwid) return res.status(403).send("HWID Invalido");
    const left = data.expiry - Date.now();
    if (left <= 0) { delete keys[key]; return res.status(403).send("Expirada"); }
    res.json({ status: "success", time_left: left });
});

app.get("/send-brainrot", (req, res) => {
    const { secret, message } = req.query;
    if (secret !== SCRIPT_SECRET) return res.status(403).send("Erro");
    io.emit("brainrot", { title: "Teste", description: message });
    res.send("Enviado");
});

io.on("connection", (socket) => {
    socket.on("authenticate", ({ key, secret, hwid }) => {
        const d = keys[key];
        if (secret === SCRIPT_SECRET && d && !d.paused && (d.hwid === hwid || !d.hwid)) {
            socket.emit("authenticated", { message: "Sucesso!" });
        } else {
            socket.emit("auth_error", { message: "Falha." });
            socket.disconnect();
        }
    });
});

app.get("/", (req, res) => res.send("API Bob Notifier Online!"));
server.listen(port, () => console.log(`Servidor rodando na porta ${port}`));
