const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');
const crypto = require('crypto');
const { Client, GatewayIntentBits, EmbedBuilder, AttachmentBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');

const app = express();

// Konfiguracja
const PORT = process.env.PORT || 3000;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID || '1477574526933012541';
const STORAGE_CATEGORY_ID = process.env.STORAGE_CATEGORY_ID || '1477579473611128843';
const NOTIFICATION_CHANNEL_ID = process.env.NOTIFICATION_CHANNEL_ID || '1477577363285082123';

if (!DISCORD_TOKEN) {
    console.error('❌ Brak DISCORD_TOKEN! Ustaw w zmiennych środowiskowych.');
    process.exit(1);
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Discord Client
const discordClient = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

let discordReady = false;
let guild = null;
let storageCategory = null;
let notificationChannel = null;
const userChannelsCache = new Map();
let gamesCache = {};

// === START SERWERA HTTP ===
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Serwer HTTP na porcie ${PORT}`);
});

// === ENDPOINT /admin - SERWUJE PLIK admin.html ===
app.get('/admin', async (req, res) => {
    try {
        const adminPath = path.join(__dirname, 'admin.html');
        const html = await fs.readFile(adminPath, 'utf-8');
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
    } catch (error) {
        console.error('❌ Błąd wczytywania admin.html:', error);
        res.status(500).send(`
            <!DOCTYPE html>
            <html>
            <head><title>Błąd</title></head>
            <body style="font-family: Arial; padding: 50px; text-align: center;">
                <h1>❌ Błąd 500</h1>
                <p>Nie można wczytać pliku admin.html</p>
                <p>Upewnij się, że plik istnieje w katalogu aplikacji</p>
                <hr>
                <small>${error.message}</small>
            </body>
            </html>
        `);
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: discordReady ? 'OK' : 'INITIALIZING',
        discord: discordReady,
        timestamp: new Date().toISOString(),
        port: PORT
    });
});

app.get('/', (req, res) => {
    res.json({ 
        message: 'Nebula Game Server',
        status: discordReady ? 'online' : 'booting',
        endpoints: ['/health', '/admin', '/games', '/api/auth/login', '/api/auth/register']
    });
});

// Middleware sprawdzający Discord
function requireDiscord(req, res, next) {
    if (!discordReady) {
        return res.status(503).json({ 
            error: 'Discord not ready', 
            retryAfter: 5 
        });
    }
    next();
}

// === INICJALIZACJA DISCORDA ===
async function initDiscord() {
    try {
        console.log('🔌 Łączenie z Discordem...');
        
        discordClient.once('ready', async () => {
            console.log(`🤖 Bot: ${discordClient.user.tag}`);
            
            try {
                guild = await discordClient.guilds.fetch(GUILD_ID);
                storageCategory = await guild.channels.fetch(STORAGE_CATEGORY_ID);
                notificationChannel = await guild.channels.fetch(NOTIFICATION_CHANNEL_ID);
                
                await loadExistingUserChannels();
                await syncGamesFromDiscord();
                
                discordReady = true;
                console.log('✅ Discord gotowy!');
                
                setInterval(syncGamesFromDiscord, 300000);
                
            } catch (error) {
                console.error('❌ Błąd init:', error);
            }
        });
        
        await discordClient.login(DISCORD_TOKEN);
        
    } catch (error) {
        console.error('❌ Błąd Discord:', error);
    }
}

initDiscord();

// === FUNKCJE POMOCNICZE ===
function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

async function sendDiscordNotification(embed) {
    if (!discordReady || !notificationChannel) return;
    try {
        await notificationChannel.send({ embeds: [embed] });
    } catch (error) {
        console.error('❌ Powiadomienie:', error);
    }
}

// === ZARZĄDZANIE KANAŁAMI ===
async function loadExistingUserChannels() {
    try {
        const channels = await guild.channels.fetch();
        const userChannels = channels.filter(c => 
            c.parentId === STORAGE_CATEGORY_ID && c.name.startsWith('user-')
        );
        
        for (const [id, channel] of userChannels) {
            const username = channel.name.replace('user-', '').replace(/-/g, '_');
            userChannelsCache.set(username, id);
        }
        console.log(`📁 ${userChannelsCache.size} kanałów użytkowników`);
    } catch (error) {
        console.error('❌ Błąd kanałów:', error);
    }
}

async function getOrCreateUserChannel(username) {
    if (!discordReady) throw new Error('Discord niegotowy');

    if (userChannelsCache.has(username)) {
        try {
            const ch = await guild.channels.fetch(userChannelsCache.get(username));
            if (ch) return ch;
        } catch {
            userChannelsCache.delete(username);
        }
    }

    const safeName = username.toLowerCase().replace(/[^a-z0-9]/g, '-');
    const channelName = `user-${safeName}`;
    
    const existing = guild.channels.cache.find(c => 
        c.name === channelName && c.parentId === STORAGE_CATEGORY_ID
    );
    
    if (existing) {
        userChannelsCache.set(username, existing.id);
        return existing;
    }

    const newChannel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: storageCategory.id,
        topic: `📁 ${username}`,
        permissionOverwrites: [
            { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
            { id: discordClient.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles] }
        ]
    });
    
    userChannelsCache.set(username, newChannel.id);
    return newChannel;
}

// === ZAPIS/WCZYT ===
async function saveUserFile(username, filename, data, description = '') {
    const channel = await getOrCreateUserChannel(username);
    const buffer = Buffer.from(JSON.stringify(data, null, 2));
    const attachment = new AttachmentBuilder(buffer, { name: filename });
    
    const messages = await channel.messages.fetch({ limit: 50 });
    const old = messages.filter(m => m.attachments.some(a => a.name === filename));
    
    for (const msg of old.values()) {
        try { await msg.delete(); } catch {}
    }
    
    return await channel.send({
        content: description || `📄 ${filename}`,
        files: [attachment]
    });
}

async function loadUserFile(username, filename, defaultData = {}) {
    try {
        const channel = await getOrCreateUserChannel(username);
        const messages = await channel.messages.fetch({ limit: 50 });
        const msg = messages.find(m => m.attachments.some(a => a.name === filename));
        
        if (!msg) return defaultData;
        
        const attachment = msg.attachments.find(a => a.name === filename);
        const res = await fetch(attachment.url);
        return await res.json();
    } catch {
        return defaultData;
    }
}

async function saveChatFile(user1, user2, data) {
    await saveUserFile(user1, `chat_${user1}_do_${user2}.json`, data, `💬 z ${user2}`);
}

async function loadChatFile(user1, user2) {
    return await loadUserFile(user1, `chat_${user1}_do_${user2}.json`, null) 
        || await loadUserFile(user2, `chat_${user2}_do_${user1}.json`, null);
}

// === GLOBAL FILES ===
async function getGlobalChannel() {
    let ch = storageCategory.children.cache.find(c => c.name === 'global-data');
    if (!ch) {
        ch = await guild.channels.create({
            name: 'global-data',
            type: ChannelType.GuildText,
            parent: storageCategory.id
        });
    }
    return ch;
}

async function saveGlobalFile(filename, data, description = '') {
    const channel = await getGlobalChannel();
    const buffer = Buffer.from(JSON.stringify(data, null, 2));
    const attachment = new AttachmentBuilder(buffer, { name: filename });
    
    const messages = await channel.messages.fetch({ limit: 50 });
    const old = messages.filter(m => m.attachments.some(a => a.name === filename));
    
    for (const msg of old.values()) {
        try { await msg.delete(); } catch {}
    }
    
    return await channel.send({
        content: description || `🌍 ${filename}`,
        files: [attachment]
    });
}

async function loadGlobalFile(filename, defaultData = {}) {
    try {
        const channel = await getGlobalChannel();
        const messages = await channel.messages.fetch({ limit: 50 });
        const msg = messages.find(m => m.attachments.some(a => a.name === filename));
        
        if (!msg) return defaultData;
        
        const attachment = msg.attachments.find(a => a.name === filename);
        const res = await fetch(attachment.url);
        return await res.json();
    } catch {
        return defaultData;
    }
}

// === GAMES ===
async function syncGamesFromDiscord() {
    if (!discordReady) return;
    try {
        gamesCache = await loadGlobalFile('games.json', {});
        console.log(`🎮 ${Object.keys(gamesCache).length} gier`);
    } catch (error) {
        console.error('❌ Sync gier:', error);
    }
}

async function saveGame(gameId, gameData) {
    gamesCache[gameId] = { ...gameData, id: gameId, updatedAt: new Date().toISOString() };
    await saveGlobalFile('games.json', gamesCache, '🎮 Biblioteka gier');
    return gamesCache[gameId];
}

async function deleteGame(gameId) {
    if (gamesCache[gameId]) {
        delete gamesCache[gameId];
        await saveGlobalFile('games.json', gamesCache, '🎮 Biblioteka gier');
        return true;
    }
    return false;
}

// === ENDPOINTY GIER ===
app.get('/games', requireDiscord, async (req, res) => {
    res.json(Object.values(gamesCache));
});

app.get('/games/:id', requireDiscord, async (req, res) => {
    const game = gamesCache[req.params.id];
    if (!game) return res.status(404).json({ error: 'Nie ma takiej gry' });
    res.json(game);
});

app.post('/api/games', requireDiscord, async (req, res) => {
    try {
        const { name, description, developer, price, icon, color, pegi } = req.body;
        if (!name) return res.status(400).json({ error: 'Nazwa wymagana' });
        
        const gameId = crypto.randomUUID();
        const gameData = {
            name,
            description: description || '',
            developer: developer || 'Unknown',
            price: price || 0,
            icon: icon || '🎮',
            color: color || '#00d4ff',
            pegi: pegi || 12,
            createdAt: new Date().toISOString()
        };
        
        const saved = await saveGame(gameId, gameData);
        
        const embed = new EmbedBuilder()
            .setTitle(price === 0 ? '🆓 Nowa darmowa gra!' : '💰 Nowa gra!')
            .setDescription(`**${name}**`)
            .addFields(
                { name: 'Dev', value: gameData.developer, inline: true },
                { name: 'Cena', value: price === 0 ? 'FREE' : `${price}zł`, inline: true }
            )
            .setColor(parseInt(gameData.color.replace('#', ''), 16))
            .setTimestamp();
        
        await sendDiscordNotification(embed);
        
        res.json({ success: true, game: saved });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/games/:id', requireDiscord, async (req, res) => {
    if (!gamesCache[req.params.id]) {
        return res.status(404).json({ error: 'Gra nie istnieje' });
    }
    const updated = await saveGame(req.params.id, { ...gamesCache[req.params.id], ...req.body });
    res.json({ success: true, game: updated });
});

app.delete('/api/games/:id', requireDiscord, async (req, res) => {
    const success = await deleteGame(req.params.id);
    res.json({ success, message: success ? 'Usunięto' : 'Nie znaleziono' });
});

// === AUTH ===
app.post('/api/auth/register', requireDiscord, async (req, res) => {
    try {
        const { username, password, email } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: 'Username i password wymagane' });
        }
        
        const users = await loadGlobalFile('users.json', {});
        if (users[username]) {
            return res.status(409).json({ error: 'Użytkownik już istnieje' });
        }
        
        const token = generateToken();
        users[username] = {
            id: crypto.randomUUID(),
            username,
            email: email || '',
            passwordHash: hashPassword(password),
            token,
            createdAt: new Date().toISOString()
        };
        
        await saveGlobalFile('users.json', users, '👥 Użytkownicy');
        await getOrCreateUserChannel(username);
        await saveUserFile(username, 'library.json', { games: [] }, '📚 Biblioteka');
        await saveUserFile(username, 'friends.json', { friends: [], pending: [] }, '👥 Znajomi');
        
        const embed = new EmbedBuilder()
            .setTitle('👤 Nowy użytkownik')
            .setDescription(`**${username}** dołączył!`)
            .setColor(0x00ff88);
        await sendDiscordNotification(embed);
        
        res.json({ success: true, token, userId: users[username].id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/auth/login', requireDiscord, async (req, res) => {
    try {
        const { username, password } = req.body;
        const users = await loadGlobalFile('users.json', {});
        const user = users[username];
        
        if (!user || user.passwordHash !== hashPassword(password)) {
            return res.status(401).json({ error: 'Złe dane logowania' });
        }
        
        const token = generateToken();
        user.token = token;
        user.lastLogin = new Date().toISOString();
        await saveGlobalFile('users.json', users, '👥 Użytkownicy');
        
        res.json({ 
            success: true, 
            token, 
            user: { id: user.id, username: user.username, email: user.email }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/auth/verify', requireDiscord, async (req, res) => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Brak tokena' });
    }
    
    const token = auth.substring(7);
    const users = await loadGlobalFile('users.json', {});
    const user = Object.values(users).find(u => u.token === token);
    
    if (!user) return res.status(401).json({ error: 'Nieprawidłowy token' });
    
    res.json({ valid: true, userId: user.id, username: user.username });
});

// === ZNAJOMI ===
app.get('/api/friends/:username', requireDiscord, async (req, res) => {
    const data = await loadUserFile(req.params.username, 'friends.json', { friends: [], pending: [] });
    const users = await loadGlobalFile('users.json', {});
    
    const friends = await Promise.all(
        data.friends.map(async (name) => ({
            username: name,
            status: 'online',
            lastSeen: users[name]?.lastLogin
        }))
    );
    
    res.json({ friends, pending: data.pending || [] });
});

app.post('/api/friends/add', requireDiscord, async (req, res) => {
    const { fromUser, toUser } = req.body;
    const users = await loadGlobalFile('users.json', {});
    
    if (!users[toUser]) return res.status(404).json({ error: 'Nie ma takiego użytkownika' });
    
    const toData = await loadUserFile(toUser, 'friends.json', { friends: [], pending: [] });
    if (!toData.pending) toData.pending = [];
    
    if (!toData.pending.find(p => p.from === fromUser) && !toData.friends.includes(fromUser)) {
        toData.pending.push({ from: fromUser, at: new Date().toISOString() });
        await saveUserFile(toUser, 'friends.json', toData, '👥 Znajomi');
    }
    
    res.json({ success: true });
});

app.post('/api/friends/respond', requireDiscord, async (req, res) => {
    const { username, fromUser, accept } = req.body;
    
    const userData = await loadUserFile(username, 'friends.json', { friends: [], pending: [] });
    const fromData = await loadUserFile(fromUser, 'friends.json', { friends: [], pending: [] });
    
    userData.pending = userData.pending.filter(p => p.from !== fromUser);
    
    if (accept) {
        userData.friends.push(fromUser);
        fromData.friends.push(username);
        await saveChatFile(username, fromUser, {
            participants: [username, fromUser],
            messages: []
        });
    }
    
    await saveUserFile(username, 'friends.json', userData, '👥 Znajomi');
    await saveUserFile(fromUser, 'friends.json', fromData, '👥 Znajomi');
    
    res.json({ success: true, accepted: accept });
});

// === CZAT ===
app.get('/api/chat/:user1/:user2', requireDiscord, async (req, res) => {
    const data = await loadChatFile(req.params.user1, req.params.user2);
    res.json(data || { messages: [], participants: [req.params.user1, req.params.user2] });
});

app.post('/api/chat/send', requireDiscord, async (req, res) => {
    const { fromUser, toUser, content } = req.body;
    
    let chat = await loadChatFile(fromUser, toUser);
    if (!chat) {
        chat = { participants: [fromUser, toUser], messages: [] };
    }
    
    chat.messages.push({
        id: crypto.randomUUID(),
        sender: fromUser,
        content: content.trim(),
        timestamp: new Date().toISOString(),
        read: false
    });
    
    if (chat.messages.length > 500) chat.messages = chat.messages.slice(-500);
    
    await saveChatFile(fromUser, toUser, chat);
    res.json({ success: true });
});

// === BIBLIOTEKA ===
app.get('/api/users/:username/library', requireDiscord, async (req, res) => {
    const lib = await loadUserFile(req.params.username, 'library.json', { games: [] });
    const enriched = lib.games.map(g => ({
        ...g,
        gameDetails: gamesCache[g.gameId]
    }));
    res.json(enriched);
});

app.post('/api/users/:username/library', requireDiscord, async (req, res) => {
    const { gameId } = req.body;
    if (!gamesCache[gameId]) return res.status(404).json({ error: 'Gra nie istnieje' });
    
    const lib = await loadUserFile(req.params.username, 'library.json', { games: [] });
    if (!lib.games.find(g => g.gameId === gameId)) {
        lib.games.push({
            gameId,
            addedAt: new Date().toISOString(),
            installed: false,
            playTime: 0
        });
        await saveUserFile(req.params.username, 'library.json', lib, '📚 Biblioteka');
    }
    
    res.json({ success: true, library: lib.games });
});
