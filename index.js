const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Client, GatewayIntentBits } = require("discord.js");

const app = express();
const server = http.createServer(app);

const io = new Server(server, { 
    cors: { origin: "*", methods: ["GET", "POST"] },
    allowEIO3: true,
    transports: ['polling', 'websocket']
});

const port = process.env.PORT || 3000;

const ADMIN_PASS = process.env.ADMIN_PASS || "ADMIN_PADRAO_MUDE_NO_RENDER";
const SCRIPT_SECRET = process.env.SCRIPT_SECRET || "BOB_SECURE_2024_XYZ";

const DISCORD_TOKEN_NOTIFIER = process.env.DISCORD_TOKEN_NOTIFIER;
const DISCORD_TOKEN_LOGS = process.env.DISCORD_TOKEN_LOGS;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || "1494529159484149801";

const keys = {};
const brainrots = []; 

const formatTime = (ms) => {
    if (ms === Infinity) return "Lifetime";
    if (ms <= 0) return "Expirado";
    let totalSeconds = Math.floor(ms / 1000);
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    const p = [];
    if (h > 0) p.push(`${h}h`);
    if (m > 0) p.push(`${m}m`);
    if (s > 0 || p.length === 0) p.push(`${s}s`);
    return p.join(" ");
};

// --- 1. BOT: BOB NOTIFIER --- //
const clientNotifier = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
clientNotifier.on("ready", () => console.log(`[NOTIFIER] Online: ${clientNotifier.user.tag}`));
clientNotifier.on("messageCreate", async message => {
    if (message.author.bot) return;
    if (message.channel.id === DISCORD_CHANNEL_ID && message.embeds.length > 0) {
        const embed = message.embeds[0];
        const payload = { title: embed.title || "Bob!", description: embed.description || "Novo Alerta!" };
        io.emit("brainrot", payload);
        brainrots.push({ id: Date.now().toString(), ...payload });
    }
});

// --- 2. BOT: BOB LOGS --- //
const clientLogs = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
clientLogs.on("ready", () => console.log(`[LOGS] Online: ${clientLogs.user.tag}`));
clientLogs.on("messageCreate", async message => {
    if (message.author.bot) return;
    if (!message.content.startsWith("!")) return;

    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    switch (command) {
        case "test":
            io.emit("brainrot", { title: "TESTE", description: "SINAL OK!" });
            message.reply("✅ Teste enviado!");
            break;

        case "info":
            let info = Object.keys(keys).length ? "**Chaves Ativas:**\n" : "Nenhuma chave ativa.";
            for (const k in keys) {
                const d = keys[k];
                const t = d.paused ? d.remaining : d.expiry - Date.now();
                info += `• \`${k}\`: ${formatTime(t)} ${d.paused ? "⏸️" : "✅"} ${d.hwid ? `(ID: ${d.hwid.substring(0,6)})` : "(Livre)"}\n`;
            }
            message.reply(info);
            break;

        case "create":
            if (args.length < 4) return message.reply("Uso: !create <h> <m> <nome> <senha>");
            const [h, m, name, passCreate] = args;
            if (passCreate !== ADMIN_PASS) return message.reply("❌ Senha incorreta!");
            const dur = (parseInt(h) * 3600 + parseInt(m) * 60) * 1000;
            keys[name] = { expiry: Date.now() + dur, paused: false, remaining: dur, hwid: null };
            message.reply(`✅ Chave \`${name}\` criada!`);
            break;

        case "reset":
            const [kReset, passReset] = args;
            if (passReset !== ADMIN_PASS) return message.reply("❌ Senha incorreta!");
            // Busca insensível a maiúsculas
            const targetKey = Object.keys(keys).find(k => k.toLowerCase() === kReset.toLowerCase());
            if (targetKey) { 
                keys[targetKey].hwid = null;
                message.reply(`✅ HWID da chave \`${targetKey}\` resetado!`); 
            } else message.reply("❌ Chave não encontrada.");
            break;

        case "pause":
            const [kPause, passPause] = args;
            if (passPause !== ADMIN_PASS) return message.reply("❌ Senha incorreta!");
            const targetPause = Object.keys(keys).find(k => k.toLowerCase() === kPause.toLowerCase());
            const d = keys[targetPause];
            if (d) {
                if (d.paused) { d.expiry = Date.now() + d.remaining; d.paused = false; message.reply(`▶️ \`${targetPause}\` ativa!`); }
                else { d.remaining = d.expiry - Date.now(); d.paused = true; message.reply(`⏸️ \`${targetPause}\` pausada!`); }
            } else message.reply("❌ Não encontrada.");
            break;

        case "revoke":
            const [kRevoke, passRevoke] = args;
            if (passRevoke !== ADMIN_PASS) return message.reply("❌ Senha incorreta!");
            const targetRevoke = Object.keys(keys).find(k => k.toLowerCase() === kRevoke.toLowerCase());
            if (targetRevoke) { delete keys[targetRevoke]; message.reply(`🗑️ \`${targetRevoke}\` removida.`); }
            else message.reply("❌ Não encontrada.");
            break;
    }
});

if (DISCORD_TOKEN_NOTIFIER) clientNotifier.login(DISCORD_TOKEN_NOTIFIER).catch(e => console.error(e));
if (DISCORD_TOKEN_LOGS) clientLogs.login(DISCORD_TOKEN_LOGS).catch(e => console.error(e));

// --- API DE VALIDAÇÃO BLINDADA --- //
app.get("/validate", (req, res) => {
    const { key, secret, hwid } = req.query;
    if (secret !== SCRIPT_SECRET) return res.status(403).send("Erro: Secret Invalido");
    
    // Busca a chave ignorando maiúsculas/minúsculas
    const keyName = Object.keys(keys).find(k => k.toLowerCase() === (key || "").toLowerCase());
    const data = keys[keyName];

    if (!data) return res.status(404).send("Erro: Chave Nao Existe");
    if (data.paused) return res.status(403).send("Erro: Chave Pausada");
    
    const left = data.expiry - Date.now();
    if (left <= 0) { 
        delete keys[keyName]; 
        return res.status(403).send("Erro: Chave Expirada"); 
    }

    // Se o HWID estiver nulo (após reset), grava o novo
    if (!data.hwid) {
        data.hwid = hwid;
        console.log(`[API] Novo HWID gravado para ${keyName}`);
    } else if (data.hwid !== hwid) {
        return res.status(403).send("Erro: HWID Invalido");
    }

    res.json({ status: "success", time_left: left });
});

app.get("/", (req, res) => res.send("<h1>API Bob Dual v4 Online!</h1>"));
server.listen(port, () => console.log(`[SERVER] Porta ${port}`));