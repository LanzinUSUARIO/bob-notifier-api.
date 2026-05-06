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

const ADMIN_PASS    = process.env.ADMIN_PASS    || "ADMIN_PADRAO_MUDE_NO_RENDER";
const SCRIPT_SECRET = process.env.SCRIPT_SECRET || "BOB_SECURE_2024_XYZ";

const DISCORD_TOKEN_NOTIFIER = process.env.DISCORD_TOKEN_NOTIFIER;
const DISCORD_TOKEN_LOGS     = process.env.DISCORD_TOKEN_LOGS;
const DISCORD_CHANNEL_ID     = process.env.DISCORD_CHANNEL_ID || "1494529159484149801";

// ─── ESTADO ────────────────────────────────────────────────────────────────
const keys      = {};   // { keyName: { expiry, paused, remaining, hwid } }
const brainrots = [];   // { id, title, description }

// ─── UTILITÁRIOS ───────────────────────────────────────────────────────────
const formatTime = (ms) => {
    if (ms === Infinity) return "Lifetime";
    if (ms <= 0) return "Expirado";
    let total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const p = [];
    if (h > 0) p.push(`${h}h`);
    if (m > 0) p.push(`${m}m`);
    if (s > 0 || p.length === 0) p.push(`${s}s`);
    return p.join(" ");
};

const findKey = (name) =>
    Object.keys(keys).find(k => k.toLowerCase() === (name || "").toLowerCase());

// ─── BOT: BOB NOTIFIER ─────────────────────────────────────────────────────
const clientNotifier = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

clientNotifier.on("ready", () =>
    console.log(`[NOTIFIER] Online: ${clientNotifier.user.tag}`)
);

clientNotifier.on("messageCreate", async (message) => {
    // Ignora apenas o próprio bot — embeds de outros bots/webhooks PASSAM
    if (message.author.id === clientNotifier.user?.id) return;
    if (message.channel.id !== DISCORD_CHANNEL_ID) return;
    if (message.embeds.length === 0) return;

    const embed   = message.embeds[0];
    const payload = {
        id:          Date.now().toString(),
        title:       embed.title       || "Bob!",
        description: embed.description || "Novo Alerta!",
        jobId:       null  // preencha se o embed tiver jobId no footer/field
    };

    // Tenta extrair jobId de um field chamado "jobId"
    if (embed.fields && embed.fields.length > 0) {
        const jobField = embed.fields.find(f =>
            f.name.toLowerCase().includes("jobid") ||
            f.name.toLowerCase().includes("job")
        );
        if (jobField) payload.jobId = jobField.value.trim();
    }

    brainrots.push(payload);
    io.emit("brainrot", payload);
    console.log(`[NOTIFIER] Embed recebida: ${payload.title} (id: ${payload.id})`);
});

// ─── BOT: BOB LOGS ─────────────────────────────────────────────────────────
const clientLogs = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

clientLogs.on("ready", () =>
    console.log(`[LOGS] Online: ${clientLogs.user.tag}`)
);

clientLogs.on("messageCreate", async (message) => {
    if (message.author.bot) return;
    if (!message.content.startsWith("!")) return;

    const args    = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    switch (command) {

        // !test — dispara um brainrot de teste
        case "test": {
            const payload = { id: Date.now().toString(), title: "TESTE", description: "SINAL OK!" };
            brainrots.push(payload);
            io.emit("brainrot", payload);
            message.reply("✅ Teste enviado!");
            break;
        }

        // !info — lista chaves ativas
        case "info": {
            const keyList = Object.keys(keys);
            if (!keyList.length) { message.reply("Nenhuma chave ativa."); break; }
            let info = "**Chaves Ativas:**\n";
            for (const k of keyList) {
                const d = keys[k];
                const t = d.paused ? d.remaining : d.expiry - Date.now();
                info += `• \`${k}\`: ${formatTime(t)} ${d.paused ? "⏸️" : "✅"} ${d.hwid ? `(HWID: ${d.hwid.substring(0, 6)}...)` : "(Livre)"}\n`;
            }
            message.reply(info);
            break;
        }

        // !create <h> <m> <nome> <senha>
        case "create": {
            if (args.length < 4) { message.reply("Uso: `!create <h> <m> <nome> <senha>`"); break; }
            const [h, m, name, pass] = args;
            if (pass !== ADMIN_PASS) { message.reply("❌ Senha incorreta!"); break; }
            const dur = (parseInt(h) * 3600 + parseInt(m) * 60) * 1000;
            keys[name] = { expiry: Date.now() + dur, paused: false, remaining: dur, hwid: null };
            message.reply(`✅ Chave \`${name}\` criada! Duração: ${formatTime(dur)}`);
            break;
        }

        // !lifetime <nome> <senha>
        case "lifetime": {
            const [name, pass] = args;
            if (pass !== ADMIN_PASS) { message.reply("❌ Senha incorreta!"); break; }
            keys[name] = { expiry: Infinity, paused: false, remaining: Infinity, hwid: null };
            message.reply(`✅ Chave \`${name}\` criada como **Lifetime**!`);
            break;
        }

        // !reset <nome> <senha>
        case "reset": {
            const [name, pass] = args;
            if (pass !== ADMIN_PASS) { message.reply("❌ Senha incorreta!"); break; }
            const target = findKey(name);
            if (!target) { message.reply("❌ Chave não encontrada."); break; }
            keys[target].hwid = null;
            message.reply(`✅ HWID da chave \`${target}\` resetado!`);
            break;
        }

        // !pause <nome> <senha>
        case "pause": {
            const [name, pass] = args;
            if (pass !== ADMIN_PASS) { message.reply("❌ Senha incorreta!"); break; }
            const target = findKey(name);
            if (!target) { message.reply("❌ Chave não encontrada."); break; }
            const d = keys[target];
            if (d.paused) {
                d.expiry = Date.now() + d.remaining;
                d.paused = false;
                message.reply(`▶️ Chave \`${target}\` **retomada**! Tempo restante: ${formatTime(d.remaining)}`);
            } else {
                d.remaining = d.expiry - Date.now();
                d.paused = true;
                message.reply(`⏸️ Chave \`${target}\` **pausada**! Tempo restante: ${formatTime(d.remaining)}`);
            }
            break;
        }

        // !revoke <nome> <senha>
        case "revoke": {
            const [name, pass] = args;
            if (pass !== ADMIN_PASS) { message.reply("❌ Senha incorreta!"); break; }
            const target = findKey(name);
            if (!target) { message.reply("❌ Chave não encontrada."); break; }
            delete keys[target];
            message.reply(`🗑️ Chave \`${target}\` removida.`);
            break;
        }

        // !extend <nome> <h> <m> <senha>
        case "extend": {
            if (args.length < 4) { message.reply("Uso: `!extend <nome> <h> <m> <senha>`"); break; }
            const [name, h, m, pass] = args;
            if (pass !== ADMIN_PASS) { message.reply("❌ Senha incorreta!"); break; }
            const target = findKey(name);
            if (!target) { message.reply("❌ Chave não encontrada."); break; }
            const extra = (parseInt(h) * 3600 + parseInt(m) * 60) * 1000;
            const d = keys[target];
            if (d.paused) d.remaining += extra;
            else          d.expiry    += extra;
            message.reply(`✅ Chave \`${target}\` estendida em ${formatTime(extra)}!`);
            break;
        }

        // !help
        case "help": {
            message.reply(
                "**Comandos Bob Logs:**\n" +
                "`!create <h> <m> <nome> <senha>` — Cria chave com duração\n" +
                "`!lifetime <nome> <senha>` — Cria chave lifetime\n" +
                "`!revoke <nome> <senha>` — Remove chave\n" +
                "`!reset <nome> <senha>` — Reseta HWID\n" +
                "`!pause <nome> <senha>` — Pausa/retoma chave\n" +
                "`!extend <nome> <h> <m> <senha>` — Adiciona tempo\n" +
                "`!info` — Lista chaves ativas\n" +
                "`!test` — Envia brainrot de teste"
            );
            break;
        }
    }
});

// ─── API: VALIDAÇÃO ─────────────────────────────────────────────────────────
app.get("/validate", (req, res) => {
    const { key, secret, hwid } = req.query;
    if (secret !== SCRIPT_SECRET) return res.status(403).send("Erro: Secret Invalido");

    const keyName = findKey(key);
    const data    = keys[keyName];

    if (!data)       return res.status(404).send("Erro: Chave Nao Existe");
    if (data.paused) return res.status(403).send("Erro: Chave Pausada");

    if (data.expiry !== Infinity) {
        const left = data.expiry - Date.now();
        if (left <= 0) { delete keys[keyName]; return res.status(403).send("Erro: Chave Expirada"); }
    }

    if (!data.hwid) {
        data.hwid = hwid;
        console.log(`[API] HWID gravado para ${keyName}: ${hwid}`);
    } else if (data.hwid !== hwid) {
        return res.status(403).send("Erro: HWID Invalido");
    }

    const timeLeft = data.expiry === Infinity ? Infinity : data.expiry - Date.now();
    res.json({ status: "success", time_left: timeLeft });
});

// ─── API: BUSCAR BRAINROTS (POLLING DO SCRIPT ROBLOX) ──────────────────────
app.get("/get-brainrots", (req, res) => {
    const { key, secret, hwid, lastId } = req.query;

    if (secret !== SCRIPT_SECRET)
        return res.status(403).json({ status: "error", message: "Secret invalido" });

    const keyName = findKey(key);
    const data    = keys[keyName];

    if (!data)
        return res.status(404).json({ status: "error", message: "Chave nao existe" });
    if (data.paused)
        return res.status(403).json({ status: "error", message: "Chave pausada" });
    if (data.expiry !== Infinity && data.expiry - Date.now() <= 0) {
        delete keys[keyName];
        return res.status(403).json({ status: "error", message: "Chave expirada" });
    }
    if (data.hwid && data.hwid !== hwid)
        return res.status(403).json({ status: "error", message: "HWID invalido" });

    if (brainrots.length === 0)
        return res.json({ status: "waiting" });

    const latest = brainrots[brainrots.length - 1];

    // Só envia se for novo
    if (latest.id === lastId)
        return res.json({ status: "waiting" });

    res.json({ status: "success", brainrot: latest });
});

// ─── API: CONTAR CLIENTES CONECTADOS ────────────────────────────────────────
app.get("/clients", (req, res) => {
    res.send(`Clientes Socket.IO conectados: ${io.sockets.sockets.size}`);
});

// ─── API: TESTE MANUAL DE EMIT ───────────────────────────────────────────────
app.get("/test-emit", (req, res) => {
    if (req.query.secret !== SCRIPT_SECRET)
        return res.status(403).send("Secret invalido");
    const payload = { id: Date.now().toString(), title: "TESTE MANUAL", description: "Chegou via HTTP!" };
    brainrots.push(payload);
    io.emit("brainrot", payload);
    res.send("✅ Emit enviado!");
});

// ─── RAIZ ───────────────────────────────────────────────────────────────────
app.get("/", (req, res) =>
    res.send("<h1>Bob Dual API v5 — Online! ✅</h1>")
);

// ─── LOGIN DOS BOTS ─────────────────────────────────────────────────────────
if (DISCORD_TOKEN_NOTIFIER)
    clientNotifier.login(DISCORD_TOKEN_NOTIFIER).catch(e => console.error("[NOTIFIER ERROR]", e));
else
    console.warn("[NOTIFIER] DISCORD_TOKEN_NOTIFIER não definido — bot offline.");

if (DISCORD_TOKEN_LOGS)
    clientLogs.login(DISCORD_TOKEN_LOGS).catch(e => console.error("[LOGS ERROR]", e));
else
    console.warn("[LOGS] DISCORD_TOKEN_LOGS não definido — bot offline.");

// ─── START ──────────────────────────────────────────────────────────────────
server.listen(port, () => console.log(`[SERVER] Rodando na porta ${port}`));