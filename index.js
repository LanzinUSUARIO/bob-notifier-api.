const express = require("express");
const http = require("http" );
const { Server } = require("socket.io");
const { Client, GatewayIntentBits } = require("discord.js");

const app = express();
const server = http.createServer(app );

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
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || "1494529159484149801";

const keys = {};
const brainrots = []; // Array para armazenar os brainrots 

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

// --- DISCORD BOT --- //
const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.MessageContent
    ] 
});

client.on("ready", () => {
    console.log(`[BOT] Conectado com sucesso como: ${client.user.tag}`);
    console.log(`[BOT] Monitorando canal: ${DISCORD_CHANNEL_ID}`);
});

client.on("messageCreate", async message => {
    // 1. MONITOR DE BRAINROTS (EMBEDS)
    if (message.channel.id === DISCORD_CHANNEL_ID) {
        if (message.embeds.length > 0) {
            const embed = message.embeds[0];
            const payload = { 
                title: embed.title || "Bob!", 
                description: embed.description || "Novo Alerta Recebido!" 
            };
            
            io.emit("brainrot", payload);
            brainrots.push({ id: Date.now().toString(), ...payload }); // Armazena o brainrot com um ID único
            console.log(`[LOG] Brainrot enviado do Discord para ${io.engine.clientsCount} scripts!`);
        }
        return;
    }

    // 2. COMANDOS ADMINISTRATIVOS
    if (!message.content.startsWith("!")) return;
    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    switch (command) {
        case "test":
            io.emit("brainrot", { title: "TESTE", description: "O APITO ESTÁ FUNCIONANDO!" });
            message.reply("✅ Sinal de teste enviado para todos os scripts conectados!");
            console.log("[LOG] Sinal de teste disparado manualmente.");
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

client.login(DISCORD_TOKEN).catch(err => {
    console.error("[ERRO] Falha crítica ao conectar o Bot do Discord:");
    console.error(err);
});

// --- API REST & SOCKET.IO --- //

app.get("/validate", (req, res) => {
    const { key, secret, hwid } = req.query;
    if (secret !== SCRIPT_SECRET) return res.status(403).send("Anti-Dualhook: Segredo Inválido");
    
    const data = keys[key];
    if (!data) return res.status(404).send("Chave Inválida");
    if (data.paused) return res.status(403).send("Chave Pausada");
    
    if (!data.hwid) {
        data.hwid = hwid;
    } else if (data.hwid !== hwid) {
        return res.status(403).send("HWID Inválido (Chave em uso em outro PC)");
    }

    const left = data.expiry - Date.now();
    if (left <= 0) { 
        delete keys[key]; 
        return res.status(403).send("Chave Expirada"); 
    }
    
    res.json({ status: "success", time_left: left });
});

app.get("/get-brainrots", (req, res) => {
    const { key, secret, hwid, lastId } = req.query;

    // Validação básica (pode ser mais robusta)
    if (secret !== SCRIPT_SECRET) return res.status(403).json({ status: "error", message: "Anti-Dualhook: Segredo Inválido" });
    const data = keys[key];
    if (!data) return res.status(404).json({ status: "error", message: "Chave Inválida" });
    if (data.paused) return res.status(403).json({ status: "error", message: "Chave Pausada" });
    if (data.hwid && data.hwid !== hwid) return res.status(403).json({ status: "error", message: "HWID Inválido (Chave em uso em outro PC)" });

    let latestBrainrot = null;
    if (brainrots.length > 0) {
        const lastBrainrotIndex = brainrots.findIndex(br => br.id === lastId);
        if (lastBrainrotIndex !== -1 && lastBrainrotIndex < brainrots.length - 1) {
            latestBrainrot = brainrots[brainrots.length - 1]; // Retorna o mais recente se houver novos após o lastId
        } else if (lastBrainrotIndex === -1) {
            latestBrainrot = brainrots[brainrots.length - 1]; // Retorna o mais recente se lastId não for encontrado
        }
    }

    if (latestBrainrot) {
        res.json({ status: "success", brainrot: latestBrainrot });
    } else {
        res.json({ status: "success", message: "Nenhum brainrot novo." });
    }

});

io.on("connection", (socket) => {
    console.log(`[SOCKET] Novo script conectado. ID: ${socket.id}`);
    
    socket.on("authenticate", ({ key, secret, hwid }) => {
        const d = keys[key];
        if (secret === SCRIPT_SECRET && d && !d.paused && (d.hwid === hwid || !d.hwid)) {
            socket.emit("authenticated", { message: "Conectado com sucesso!" });
            console.log(`[SOCKET] Script autenticado: ${key}`);
        } else {
            console.log(`[SOCKET] Falha de autenticação para chave: ${key}`);
            socket.emit("auth_error", { message: "Falha na autenticação." });
            socket.disconnect();
        }
    });

    socket.on("disconnect", () => {
        console.log(`[SOCKET] Script desconectado. ID: ${socket.id}`);
    });
});

app.get("/", (req, res) => res.send("<h1>API Bob Notifier Online!</h1><p>O Bot do Discord e o sistema de Socket estão ativos.</p>"));

server.listen(port, () => {
    console.log(`[SERVER] Servidor rodando na porta ${port}`);
});