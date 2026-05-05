const express = require("express");
const http = require("http" );
const { Server } = require("socket.io");
const cors = require("cors");
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");

// --- CONFIGURAÇÕES ---
const ADMIN_PASS = "Bob_Notifier"; 
const SCRIPT_SECRET = "BOB_SECURE_2024_XYZ"; // Mantenha isso em segredo!
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;

let keys = {}; 

// --- INICIALIZAÇÃO DO BOT DO DISCORD ---
const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.MessageContent
    ] 
});

client.on("ready", () => {
    console.log(`🤖 BOT ONLINE: ${client.user.tag}`);
});

// Função para enviar logs formatados para o Discord
const sendDiscordLog = async (title, description, color = 0x0099FF) => {
    try {
        const channel = await client.channels.fetch(LOG_CHANNEL_ID);
        if (channel) {
            const embed = new EmbedBuilder()
                .setTitle(title)
                .setDescription(description)
                .setColor(color)
                .setTimestamp()
                .setFooter({ text: "Bob Notifier System" });
            channel.send({ embeds: [embed] });
        }
    } catch (err) {
        console.log("Erro ao enviar log para o Discord: " + err.message);
    }
};

// Comando !info no Discord para ver chaves
client.on("messageCreate", async (message) => {
    if (message.author.bot) return;
    if (message.content === "!info") {
        let list = "";
        let count = 0;
        for (let k in keys) {
            const remaining = keys[k].paused ? keys[k].timeLeftMs : keys[k].expires - Date.now();
            if (remaining > 0 || keys[k].paused) {
                count++;
                list += `**Key:** \`${k}\` | **Status:** ${keys[k].paused ? "⏸️ Pausada" : "✅ Ativa"} | **Tempo:** ${formatTime(remaining)}\n`;
            }
        }
        const embed = new EmbedBuilder()
            .setTitle("🔑 Status das Chaves")
            .setDescription(count > 0 ? list : "Nenhuma chave ativa no momento.")
            .setColor(0x0099FF)
            .setTimestamp();
        message.reply({ embeds: [embed] });
    }
});

// --- API E WEBSOCKET ---
const app = express();
app.use(cors());
app.use(express.json());
const server = http.createServer(app );
const io = new Server(server, { cors: { origin: "*" } });

const formatTime = (ms) => {
    if (ms <= 0) return "Expirado";
    const s = Math.floor((ms / 1000) % 60);
    const m = Math.floor((ms / (1000 * 60)) % 60);
    const h = Math.floor(ms / (1000 * 60 * 60));
    return `${h}h ${m}m ${s}s`;
};

// Rota Create
app.get("/create", (req, res) => {
    const { hours, minutes, admin_pass, key: customKey } = req.query;
    if (admin_pass !== ADMIN_PASS) return res.status(403).json({ status: "error", message: "Senha incorreta" });
    
    const durationMs = (parseFloat(hours || 0) * 3600000) + (parseFloat(minutes || 0) * 60000);
    const key = customKey || "BOB-" + Math.random().toString(36).substring(2, 10).toUpperCase();
    
    keys[key] = { expires: Date.now() + durationMs, paused: false, timeLeftMs: durationMs };
    
    sendDiscordLog("🆕 Nova Chave Gerada", `**Chave:** \`${key}\`\n**Duração:** ${formatTime(durationMs)}`, 0x00FF00);
    res.json({ status: "success", key: key });
});

// Rota Revoke
app.get("/revoke", (req, res) => {
    const { key, admin_pass } = req.query;
    if (admin_pass !== ADMIN_PASS) return res.status(403).json({ status: "error" });
    if (keys[key]) {
        delete keys[key];
        sendDiscordLog("🚫 Chave Revogada", `**Chave:** \`${key}\` foi deletada pelo administrador.`, 0xFF0000);
        res.json({ status: "success" });
    } else res.status(404).json({ status: "error" });
});

// Rota Validate (Com Proteção Anti-Dualhook)
app.get("/validate", (req, res) => {
    const { key, secret } = req.query;
    // Defesa: Bloqueia se o segredo estiver errado
    if (secret !== SCRIPT_SECRET) return res.json({ status: "error", message: "Acesso não autorizado (Anti-Dualhook)" });
    
    if (!keys[key]) return res.json({ status: "error", message: "Inexistente" });
    if (keys[key].paused) return res.json({ status: "error", message: "Pausada" });
    if (Date.now() > keys[key].expires) { delete keys[key]; return res.json({ status: "error" }); }
    
    res.json({ status: "success", time_left: formatTime(keys[key].expires - Date.now()) });
});

// --- BRAINROT ---
app.post("/brainrot", (req, res) => {
    const auth = req.headers["x-auth-token"];
    if (auth !== SCRIPT_SECRET) return res.status(403).send("Unauthorized");
    io.emit("brainrot", req.body);
    res.json({ success: true });
});

client.login(DISCORD_TOKEN);
server.listen(process.env.PORT || 3000, () => console.log("🔥 BOB NOTIFIER ONLINE"));
