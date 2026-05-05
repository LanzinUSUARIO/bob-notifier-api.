const express = require("express");
const http = require("http" );
const { Server } = require("socket.io");
const cors = require("cors");
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");

// --- CONFIGURAÇÕES ---
const ADMIN_PASS = "Bob_Notifier"; 
const SCRIPT_SECRET = "BOB_SECURE_2024_XYZ"; 
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;

let keys = {}; 

const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.MessageContent // ESSENCIAL PARA LER COMANDOS
    ] 
});

const formatTime = (ms) => {
    if (ms <= 0) return "Expirado";
    const s = Math.floor((ms / 1000) % 60), m = Math.floor((ms / 60000) % 60), h = Math.floor(ms / 3600000);
    return `${h}h ${m}m ${s}s`;
};

// --- PAINEL DE CONTROLE PELO DISCORD ---
client.on("messageCreate", async (msg) => {
    if (msg.author.bot || msg.channel.id !== LOG_CHANNEL_ID) return;
    
    const args = msg.content.split(" ");
    const cmd = args[0].toLowerCase();

    // !info - Listar tudo
    if (cmd === "!info") {
        let list = "";
        for (let k in keys) {
            const rem = keys[k].paused ? keys[k].timeLeftMs : keys[k].expires - Date.now();
            if (rem > 0 || keys[k].paused) {
                list += `**Key:** \`${k}\` | ${keys[k].paused ? "⏸️" : "✅"} | ${formatTime(rem)}\n`;
            }
        }
        msg.reply(list === "" ? "Nenhuma chave ativa." : "### 🔑 Painel de Controle:\n" + list);
    }

    // !create <h> <m> [key] - Criar chave
    if (cmd === "!create") {
        const h = parseFloat(args[1] || 0), m = parseFloat(args[2] || 0);
        let k = args[3] || "BOB-" + Math.random().toString(36).substring(2, 10).toUpperCase();
        const ms = (h * 3600000) + (m * 60000);
        keys[k] = { expires: Date.now() + ms, paused: false, timeLeftMs: ms };
        msg.reply(`✅ **Criada:** \`${k}\` por ${formatTime(ms)}`);
    }

    // !revoke <key> - Deletar chave
    if (cmd === "!revoke") {
        const k = args[1];
        if (keys[k]) { delete keys[k]; msg.reply(`🗑️ **Revogada:** \`${k}\``); }
        else msg.reply("❌ Não encontrada.");
    }

    // !pause <key> - Pausar/Despausar
    if (cmd === "!pause") {
        const k = args[1];
        if (!keys[k]) return msg.reply("❌ Não encontrada.");
        if (!keys[k].paused) {
            keys[k].paused = true;
            keys[k].timeLeftMs = keys[k].expires - Date.now();
            msg.reply(`⏸️ **Pausada:** \`${k}\``);
        } else {
            keys[k].paused = false;
            keys[k].expires = Date.now() + keys[k].timeLeftMs;
            msg.reply(`▶️ **Despausada:** \`${k}\``);
        }
    }

    // !compensate <minutos> - Adicionar tempo global
    if (cmd === "!compensate") {
        const mins = parseFloat(args[1]);
        if (isNaN(mins)) return msg.reply("❌ Use: `!compensate <minutos>`");
        for (let k in keys) {
            if (keys[k].paused) keys[k].timeLeftMs += (mins * 60000);
            else keys[k].expires += (mins * 60000);
        }
        msg.reply(`🎁 **Compensação:** +${mins}m para todos.`);
    }
});

// --- API E WEBSOCKET ---
const app = express();
app.use(cors());
app.use(express.json());
const server = http.createServer(app );
const io = new Server(server, { cors: { origin: "*" } });

app.get("/validate", (req, res) => {
    const { key, secret } = req.query;
    if (secret !== SCRIPT_SECRET) return res.json({ status: "error", message: "Anti-Dualhook" });
    if (!keys[key]) return res.json({ status: "error" });
    if (keys[key].paused) return res.json({ status: "error", message: "Pausada" });
    if (Date.now() > keys[key].expires) { delete keys[key]; return res.json({ status: "error" }); }
    res.json({ status: "success", time_left: formatTime(keys[key].expires - Date.now()) });
});

app.post("/brainrot", (req, res) => {
    if (req.headers["x-auth-token"] !== SCRIPT_SECRET) return res.status(403).send("Unauthorized");
    io.emit("brainrot", req.body);
    res.json({ success: true });
});

client.login(DISCORD_TOKEN);
server.listen(process.env.PORT || 3000, () => console.log("🔥 BOB ONLINE"));
