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
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] 
});

const formatTime = (ms) => {
    if (ms <= 0) return "Expirado";
    const s = Math.floor((ms / 1000) % 60), m = Math.floor((ms / 60000) % 60), h = Math.floor(ms / 3600000);
    return `${h}h ${m}m ${s}s`;
};

// --- COMANDOS DISCORD (PAINEL DE CONTROLE) ---
client.on("messageCreate", async (msg) => {
    if (msg.author.bot || msg.channel.id !== LOG_CHANNEL_ID) return;
    const args = msg.content.split(" ");
    const cmd = args[0].toLowerCase();

    // 1. LISTAR CHAVES (!info)
    if (cmd === "!info") {
        let list = "";
        let count = 0;
        for (let k in keys) {
            const rem = keys[k].paused ? keys[k].timeLeftMs : keys[k].expires - Date.now();
            if (rem > 0 || keys[k].paused) {
                count++;
                list += `**Key:** \`${k}\` | ${keys[k].paused ? "⏸️" : "✅"} | ${formatTime(rem)}\n`;
            }
        }
        const embed = new EmbedBuilder()
            .setTitle("🔑 Painel de Chaves")
            .setDescription(count > 0 ? list : "Nenhuma chave ativa.")
            .setColor(0x0099FF).setTimestamp();
        msg.reply({ embeds: [embed] });
    }

    // 2. CRIAR CHAVE (!create <h> <m> [key])
    if (cmd === "!create") {
        const h = parseFloat(args[1] || 0), m = parseFloat(args[2] || 0);
        let k = args[3] || "BOB-" + Math.random().toString(36).substring(2, 10).toUpperCase();
        const ms = (h * 3600000) + (m * 60000);
        if (ms <= 0) return msg.reply("❌ Defina um tempo válido.");
        keys[k] = { expires: Date.now() + ms, paused: false, timeLeftMs: ms };
        msg.reply(`✅ **Chave Criada:** \`${k}\` por ${formatTime(ms)}`);
    }

    // 3. REVOGAR CHAVE (!revoke <key>)
    if (cmd === "!revoke") {
        const k = args[1];
        if (keys[k]) {
            delete keys[k];
            msg.reply(`🗑️ **Chave Revogada:** \`${k}\` foi removida.`);
        } else msg.reply("❌ Chave não encontrada.");
    }

    // 4. PAUSAR CHAVE (!pause <key>)
    if (cmd === "!pause") {
        const k = args[1];
        if (!keys[k]) return msg.reply("❌ Chave não encontrada.");
        if (!keys[k].paused) {
            keys[k].paused = true;
            keys[k].timeLeftMs = keys[k].expires - Date.now();
            msg.reply(`⏸️ **Chave Pausada:** \`${k}\``);
        } else {
            keys[k].paused = false;
            keys[k].expires = Date.now() + keys[k].timeLeftMs;
            msg.reply(`▶️ **Chave Despausada:** \`${k}\``);
        }
    }

    // 5. COMPENSAR TEMPO (!compensate <minutos>)
    if (cmd === "!compensate") {
        const mins = parseFloat(args[1]);
        if (isNaN(mins)) return msg.reply("❌ Use: `!compensate <minutos>`");
        const addMs = mins * 60000;
        let count = 0;
        for (let k in keys) {
            if (keys[k].paused) keys[k].timeLeftMs += addMs;
            else keys[k].expires += addMs;
            count++;
        }
        msg.reply(`🎁 **Compensação:** +${mins}m adicionados a ${count} chaves.`);
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
    if (!keys[key]) return res.json({ status: "error", message: "Inexistente" });
    if (keys[key].paused) return res.json({ status: "error", message: "Pausada" });
    if (Date.now() > keys[key].expires) { delete keys[key]; return res.json({ status: "error" }); }
    res.json({ status: "success", time_left: formatTime(keys[key].expires - Date.now()) });
});

// --- BRAINROT ---
let latestBrainrot = { brainrot: "Nenhum", value: "0", jobId: "", players: "", timestamp: 0 };
app.get("/api/latest", (req, res) => res.json(latestBrainrot));
app.post("/brainrot", (req, res) => {
    if (req.headers["x-auth-token"] !== SCRIPT_SECRET) return res.status(403).send("Unauthorized");
    latestBrainrot = { ...req.body, timestamp: Date.now() / 1000 };
    io.emit("brainrot", latestBrainrot);
    res.json({ success: true });
});

client.login(DISCORD_TOKEN);
server.listen(process.env.PORT || 3000, () => console.log("🔥 BOB ONLINE"));
