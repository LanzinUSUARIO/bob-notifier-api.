const express = require("express");
const http = require("http" );
const { Server } = require("socket.io");
const { Client, GatewayIntentBits } = require("discord.js");

const app = express();
const server = http.createServer(app );
const io = new Server(server, { cors: { origin: "*" } });

const port = process.env.PORT || 3000;
const ADMIN_PASS = process.env.ADMIN_PASS || "ADMIN_2024_XYZ";
const SCRIPT_SECRET = process.env.SCRIPT_SECRET || "BOB_SECURE_2024_XYZ";
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;

const keys = {};

// --- DISCORD BOT (LEITOR DE EMBEDS) --- //
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

client.on("messageCreate", async message => {
    // Se for uma embed no canal certo, envia pro Roblox
    if (message.channel.id === DISCORD_CHANNEL_ID && message.embeds.length > 0) {
        const embed = message.embeds[0];
        io.emit("brainrot", { title: embed.title, description: embed.description });
        console.log("Embed enviada para o Roblox!");
    }
    
    // Comandos de Admin
    if (!message.content.startsWith("!")) return;
    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();
    if (command === "info") {
        let info = "Chaves: " + Object.keys(keys).join(", ");
        message.reply(info || "Nenhuma chave.");
    }
    // ... outros comandos (create, reset, etc)
});

client.login(DISCORD_TOKEN);

// --- ROTAS API --- //
app.get("/validate", (req, res) => {
    const { key, secret, hwid } = req.query;
    if (secret !== SCRIPT_SECRET) return res.status(403).send("Anti-Dualhook!");
    if (!keys[key]) return res.status(404).send("Invalida");
    res.json({ status: "success", time_left: 3600000 });
});

// ROTA DE TESTE (A que deu "Cannot GET")
app.get("/send-brainrot", (req, res) => {
    const { secret, message } = req.query;
    if (secret !== SCRIPT_SECRET) return res.status(403).send("Erro");
    io.emit("brainrot", { title: "Teste", description: message });
    res.send("Enviado!");
});

server.listen(port, () => console.log("Servidor Online!"));
