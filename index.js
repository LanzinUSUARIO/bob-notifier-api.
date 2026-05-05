const express = require('express');
const { Client, GatewayIntentBits } = require('discord.js');
const app = express();
const port = process.env.PORT || 3000;

// --- CONFIGURAÇÕES DE SEGURANÇA --- //
const ADMIN_PASS = process.env.ADMIN_PASS || 'ADMIN_2024_XYZ';
const SCRIPT_SECRET = process.env.SCRIPT_SECRET || 'BOB_SECURE_2024_XYZ';
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;

// --- ESTADO (EM MEMÓRIA) --- //
const keys = {}; 
const brainrots = []; 

// --- FUNÇÕES AUXILIARES --- //
const generateKey = () => `BOB-${Math.random().toString(36).substring(2, 10).toUpperCase()}`;

const formatTime = (ms) => {
    if (ms === Infinity) return "Lifetime";
    if (ms <= 0) return "Expirado";
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const parts = [];
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes % 60 > 0) parts.push(`${minutes % 60}m`);
    if (seconds % 60 > 0 || parts.length === 0) parts.push(`${seconds % 60}s`);
    return parts.join(" ");
};

// --- DISCORD BOT --- //
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

client.on("messageCreate", async message => {
    if (message.author.bot || !message.content.startsWith("!")) return;
    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    // Comandos que exigem senha (a senha deve ser o ÚLTIMO argumento)
    const adminPassInput = args[args.length - 1];
    const hasAdmin = adminPassInput === ADMIN_PASS;

    switch (command) {
        case "info":
            let info = Object.keys(keys).length ? "**Chaves:**\n" : "Nenhuma chave.";
            for (const k in keys) {
                const d = keys[k];
                const t = d.paused ? d.remaining : d.expiry - Date.now();
                info += `• \`${k}\`: ${formatTime(t)} ${d.paused ? "⏸️" : "✅"} ${d.hwid ? `(ID: ${d.hwid.substring(0,8)}...)` : "(Livre)"}\n`;
            }
            message.reply(info);
            break;

        case "create":
            if (!hasAdmin) return message.reply("Senha incorreta.");
            args.pop(); // Remove a senha dos argumentos
            const h = parseInt(args[0]) || 0;
            const m = parseInt(args[1]) || 0;
            const name = args[2] || generateKey();
            const dur = (h * 3600 + m * 60) * 1000;
            keys[name] = { expiry: Date.now() + dur, paused: false, remaining: dur, hwid: null };
            message.reply(`Chave criada: **${name}** (${formatTime(dur)})`);
            break;

        case "reset":
            if (!hasAdmin) return message.reply("Senha incorreta.");
            args.pop();
            const kReset = args[0];
            if (keys[kReset]) {
                keys[kReset].hwid = null;
                message.reply(`HWID da chave \`${kReset}\` resetado!`);
            } else message.reply("Chave não encontrada.");
            break;

        case "revoke":
            if (!hasAdmin) return message.reply("Senha incorreta.");
            args.pop();
            const kRevoke = args[0];
            if (keys[kRevoke]) {
                delete keys[kRevoke];
                message.reply(`Chave \`${kRevoke}\` deletada.`);
            } else message.reply("Chave não encontrada.");
            break;
            
        case "pause":
            if (!hasAdmin) return message.reply("Senha incorreta.");
            args.pop();
            const kPause = args[0];
            if (keys[kPause]) {
                const d = keys[kPause];
                if (d.paused) {
                    d.expiry = Date.now() + d.remaining;
                    d.paused = false;
                    message.reply(`Chave \`${kPause}\` ativa novamente!`);
                } else {
                    d.remaining = d.expiry - Date.now();
                    d.paused = true;
                    message.reply(`Chave \`${kPause}\` pausada.`);
                }
            } else message.reply("Chave não encontrada.");
            break;
    }
});

client.login(DISCORD_TOKEN);

// --- API ENDPOINTS --- //
app.get("/validate", (req, res) => {
    const { key, secret, hwid } = req.query;
    if (secret !== SCRIPT_SECRET) return res.status(403).json({ status: "error", message: "Anti-Dualhook!" });
    const data = keys[key];
    if (!data) return res.status(404).json({ status: "error", message: "Chave inválida." });
    if (data.paused) return res.status(403).json({ status: "error", message: "Chave pausada." });

    // Lógica de HWID (Aceita qualquer string enviada pelo executor)
    if (!data.hwid) {
        data.hwid = hwid; // Salva o HWID no primeiro uso
    } else if (data.hwid !== hwid) {
        return res.status(403).json({ status: "error", message: "HWID inválido! Chave presa a outro PC." });
    }

    const left = data.expiry - Date.now();
    if (left <= 0) { delete keys[key]; return res.status(403).json({ status: "error", message: "Expirada." }); }
    res.json({ status: "success", time_left: left });
});

app.get("/get-brainrots", (req, res) => {
    const { key, secret, hwid } = req.query;
    if (secret !== SCRIPT_SECRET) return res.status(403).json({ status: "error", message: "Anti-Dualhook!" });
    const data = keys[key];
    if (!data || data.hwid !== hwid || data.paused) return res.status(403).json({ status: "error", message: "Acesso negado." });
    res.json({ status: "success", data: brainrots });
});

app.get("/", (req, res) => res.send("API Bob Online!"));
app.listen(port, () => console.log(`Porta: ${port}`));