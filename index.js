const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Client, GatewayIntentBits } = require("discord.js");

const app = express();
const server = http.createServer(app);

// CONFIGURAÇÃO ULTRA COMPATÍVEL DO SOCKET.IO
const io = new Server(server, { 
    cors: { origin: "*", methods: ["GET", "POST"] },
    allowEIO3: true,
    transports: ['polling', 'websocket']
});

const port = process.env.PORT || 3000;

// --- CONFIGURAÇÕES VIA VARIÁVEIS DE AMBIENTE --- //
const ADMIN_PASS = process.env.ADMIN_PASS || "ADMIN_PADRAO_MUDE_NO_RENDER";
const SCRIPT_SECRET = process.env.SCRIPT_SECRET || "BOB_SECURE_2024_XYZ";

// TOKENS SEPARADOS PARA OS DOIS BOTS
const DISCORD_TOKEN_NOTIFIER = process.env.DISCORD_TOKEN_NOTIFIER; // Bot que lê embeds
const DISCORD_TOKEN_LOGS = process.env.DISCORD_TOKEN_LOGS;         // Bot que gerencia chaves

const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || "1494529159484149801";

const keys = {};
const brainrots = []; 

// --- AUXILIARES --- //
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

// --- 1. BOT: BOB NOTIFIER (Monitor de Embeds) --- //
const clientNotifier = new Client({ 
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.MessageContent
    ] 
});

clientNotifier.on("ready", () => {
    console.log(`[NOTIFIER] Conectado com sucesso como: ${clientNotifier.user.tag}`);
    console.log(`[NOTIFIER] Monitorando canal: ${DISCORD_CHANNEL_ID}`);
});

clientNotifier.on("messageCreate", async message => {
    if (message.author.bot && message.author.id === clientNotifier.user.id) return;

    if (message.channel.id === DISCORD_CHANNEL_ID) {
        if (message.embeds.length > 0) {
            const embed = message.embeds[0];
            const payload = { 
                title: embed.title || "Bob!", 
                description: embed.description || "Novo Alerta Recebido!" 
            };
            
            io.emit("brainrot", payload);
            brainrots.push({ id: Date.now().toString(), ...payload });
            console.log(`[LOG] Brainrot enviado do Discord para ${io.engine.clientsCount} scripts!`);
        }
    }
});

// --- 2. BOT: BOB LOGS (Comandos Administrativos) --- //
const clientLogs = new Client({ 
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.MessageContent
    ] 
});

clientLogs.on("ready", () => {
    console.log(`[LOGS] Conectado com sucesso como: ${clientLogs.user.tag}`);
});

clientLogs.on("messageCreate", async message => {
    if (message.author.bot) return;
    if (!message.content.startsWith("!")) return;

    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    switch (command) {
        case "test":
            io.emit("brainrot", { title: "TESTE", description: "O APITO ESTÁ FUNCIONANDO!" });
            message.reply("✅ Sinal de teste enviado para todos os scripts conectados!");
            console.log("[LOGS] Sinal de teste disparado manualmente.");
            break;

        case "info":
            let info = Object.keys(keys).length ? "**Chaves Ativas:**\n" : "Nenhuma chave ativa no momento.";
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
            if (passCreate !== ADMIN_PASS) return message.reply("❌ Senha de administrador incorreta!");
            const dur = (parseInt(h) * 3600 + parseInt(m) * 60) * 1000;
            keys[name] = { expiry: Date.now() + dur, paused: false, remaining: dur, hwid: null };
            message.reply(`✅ Chave \`${name}\` criada com sucesso por ${formatTime(dur)}`);
            break;

        case "reset":
            const [kReset, passReset] = args;
            if (passReset !== ADMIN_PASS) return message.reply("❌ Senha de administrador incorreta!");
            if (keys[kReset]) { 
                keys[kReset].hwid = null; 
                message.reply(`✅ HWID da chave \`${kReset}\` foi resetado!`); 
            } else message.reply("❌ Chave não encontrada.");
            break;

        case "pause":
            const [kPause, passPause] = args;
            if (passPause !== ADMIN_PASS) return message.reply("❌ Senha de administrador incorreta!");
            const d = keys[kPause];
            if (d) {
                if (d.paused) { 
                    d.expiry = Date.now() + d.remaining; 
                    d.paused = false; 
                    message.reply(`▶️ Chave \`${kPause}\` reativada!`); 
                } else { 
                    d.remaining = d.expiry - Date.now(); 
                    d.paused = true; 
                    message.reply(`⏸️ Chave \`${kPause}\` pausada!`); 
                }
            } else message.reply("❌ Chave não encontrada.");
            break;

        case "revoke":
            const [kRevoke, passRevoke] = args;
            if (passRevoke !== ADMIN_PASS) return message.reply("❌ Senha de administrador incorreta!");
            if (keys[kRevoke]) { 
                delete keys[kRevoke]; 
                message.reply(`🗑️ Chave \`${kRevoke}\` deletada permanentemente.`); 
            } else message.reply("❌ Chave não encontrada.");
            break;
    }
});

// --- INICIALIZAÇÃO DOS BOTS --- //
if (DISCORD_TOKEN_NOTIFIER) {
    clientNotifier.login(DISCORD_TOKEN_NOTIFIER).catch(err => console.error("[ERRO NOTIFIER]", err.message));
} else {
    console.warn("[AVISO] DISCORD_TOKEN_NOTIFIER não definido.");
}

if (DISCORD_TOKEN_LOGS) {
    clientLogs.login(DISCORD_TOKEN_LOGS).catch(err => console.error("[ERRO LOGS]", err.message));
} else {
    console.warn("[AVISO] DISCORD_TOKEN_LOGS não definido.");
}

// --- API REST & SOCKET.IO --- //
app.get("/validate", (req, res) => {
    const { key, secret, hwid } = req.query;
    if (secret !== SCRIPT_SECRET) return res.status(403).send("Anti-Dualhook: Segredo Inválido");
    const data = keys[key];
    if (!data) return res.status(404).send("Chave Inválida");
    if (data.paused) return res.status(403).send("Chave Pausada");
    if (!data.hwid) data.hwid = hwid;
    else if (data.hwid !== hwid) return res.status(403).send("HWID Inválido");
    const left = data.expiry - Date.now();
    if (left <= 0) { delete keys[key]; return res.status(403).send("Chave Expirada"); }
    res.json({ status: "success", time_left: left });
});

app.get("/get-brainrots", (req, res) => {
    const { key, secret, hwid, lastId } = req.query;
    if (secret !== SCRIPT_SECRET) return res.status(403).json({ status: "error", message: "Segredo Inválido" });
    const data = keys[key];
    if (!data) return res.status(404).json({ status: "error", message: "Chave Inválida" });
    
    let latestBrainrot = null;
    if (brainrots.length > 0) {
        const lastIndex = brainrots.findIndex(br => br.id === lastId);
        if (lastIndex === -1 || lastIndex < brainrots.length - 1) {
            latestBrainrot = brainrots[brainrots.length - 1];
        }
    }
    res.json({ status: "success", brainrot: latestBrainrot });
});

io.on("connection", (socket) => {
    console.log(`[SOCKET] Novo script conectado: ${socket.id}`);
});

app.get("/", (req, res) => res.send("<h1>API Bob Dual Online!</h1>"));

server.listen(port, () => {
    console.log(`[SERVER] Rodando na porta ${port}`);
});