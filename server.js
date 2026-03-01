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

// 🔧 GLOBALNY FETCH dla Node.js (wymagany dla loadGlobalFile)
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// === START SERWERA HTTP - NATYCHMIAST ===
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Serwer HTTP na porcie ${PORT}`);
    console.log(`📡 Admin panel: http://localhost:${PORT}/admin`);
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
            <body style="font-family: Arial; padding: 50px; text-align: center; background: #0a0a0f; color: #fff;">
                <h1>❌ Błąd 500</h1>
                <p>Nie można wczytać pliku admin.html</p>
                <p>Upewnij się, że plik istnieje w katalogu aplikacji</p>
                <hr>
                <small style="color: #666;">${error.message}</small>
            </body>
            </html>
        `);
    }
});

// Health check - zawsze działa
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

// 🔧 MIDDLEWARE - opcjonalne sprawdzanie Discorda (tylko dla zapisu)
function requireDiscordForWrite(req, res, next) {
    if (!discordReady) {
        return res.status(503).json({ 
            error: 'Discord not ready - try again in a few seconds', 
            retryAfter: 5,
            status: 'initializing'
        });
    }
    next();
}

// === INICJALIZACJA DISCORDA (asynchronicznie) ===
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
                console.log('✅ Discord gotowy! Wszystkie funkcje aktywne.');
                
                // Auto-sync co 5 minut
                setInterval(syncGamesFromDiscord, 300000);
                
            } catch (error) {
                console.error('❌ Błąd inicjalizacji Discord:', error);
            }
        });
        
        await discordClient.login(DISCORD_TOKEN);
        
    } catch (error) {
        console.error('❌ Błąd Discord:', error);
    }
}

// Uruchom Discord w tle (nie blokuj serwera HTTP)
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
        const loaded = await loadGlobalFile('games.json', {});
        // Konwertuj obiekt na tablicę jeśli trzeba
        gamesCache = Array.isArray(loaded) ? loaded : Object.values(loaded);
        console.log(`🎮 Załadowano ${gamesCache.length} gier`);
    } catch (error) {
        console.error('❌ Sync gier:', error);
        gamesCache = [];
    }
}

async function saveGame(gameId, gameData) {
    // Znajdź i zaktualizuj lub dodaj nową
    const existingIndex = gamesCache.findIndex(g => g.id === gameId);
    const gameWithId = { ...gameData, id: gameId, updatedAt: new Date().toISOString() };
    
    if (existingIndex >= 0) {
        gamesCache[existingIndex] = gameWithId;
    } else {
        gamesCache.push(gameWithId);
    }
    
    // Zapisz do Discorda jako tablica
    await saveGlobalFile('games.json', gamesCache, '🎮 Biblioteka gier');
    return gameWithId;
}

async function deleteGame(gameId) {
    const initialLength = gamesCache.length;
    gamesCache = gamesCache.filter(g => g.id !== gameId);
    
    if (gamesCache.length < initialLength) {
        await saveGlobalFile('games.json', gamesCache, '🎮 Biblioteka gier');
        return true;
    }
    return false;
}

// === ENDPOINTY GIER ===

// 🔧 GET /games - NIE wymaga Discorda (zwraca cache lub pustą tablicę)
app.get('/games', async (req, res) => {
    // Jeśli Discord gotowy, zsynchronizuj najpierw
    if (discordReady && gamesCache.length === 0) {
        await syncGamesFromDiscord();
    }
    
    // Zwróć to co mamy (nawet pustą tablicę)
    res.json(gamesCache || []);
});

// 🔧 GET /games/:id - NIE wymaga Discorda
app.get('/games/:id', async (req, res) => {
    const game = gamesCache.find(g => g.id === req.params.id);
    if (!game) return res.status(404).json({ error: 'Nie ma takiej gry' });
    res.json(game);
});

// POST /api/games - wymaga Discorda (zapis)
app.post('/api/games', requireDiscordForWrite, async (req, res) => {
    try {
        const { name, description, developer, price, icon, color, pegi, download_url } = req.body;
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
            download_url: download_url || null,
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

// PUT /api/games/:id - wymaga Discorda (zapis)
app.put('/api/games/:id', requireDiscordForWrite, async (req, res) => {
    try {
        const existing = gamesCache.find(g => g.id === req.params.id);
        if (!existing) {
            return res.status(404).json({ error: 'Gra nie istnieje' });
        }
        
        const updated = await saveGame(req.params.id, { ...existing, ...req.body });
        res.json({ success: true, game: updated });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// DELETE /api/games/:id - wymaga Discorda (zapis)
app.delete('/api/games/:id', requireDiscordForWrite, async (req, res) => {
    try {
        const success = await deleteGame(req.params.id);
        res.json({ success, message: success ? 'Usunięto' : 'Nie znaleziono' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// === AUTH ===
app.post('/api/auth/register', requireDiscordForWrite, async (req, res) => {
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

app.post('/api/auth/login', requireDiscordForWrite, async (req, res) => {
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

app.get('/api/auth/verify', requireDiscordForWrite, async (req, res) => {
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
app.get('/api/friends/:username', requireDiscordForWrite, async (req, res) => {
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

app.post('/api/friends/add', requireDiscordForWrite, async (req, res) => {
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

app.post('/api/friends/respond', requireDiscordForWrite, async (req, res) => {
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
app.get('/api/chat/:user1/:user2', requireDiscordForWrite, async (req, res) => {
    const data = await loadChatFile(req.params.user1, req.params.user2);
    res.json(data || { messages: [], participants: [req.params.user1, req.params.user2] });
});

app.post('/api/chat/send', requireDiscordForWrite, async (req, res) => {
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
app.get('/api/users/:username/library', requireDiscordForWrite, async (req, res) => {
    const lib = await loadUserFile(req.params.username, 'library.json', { games: [] });
    const enriched = lib.games.map(g => ({
        ...g,
        gameDetails: gamesCache.find(gc => gc.id === g.gameId)
    }));
    res.json(enriched);
});

app.post('/api/users/:username/library', requireDiscordForWrite, async (req, res) => {
    const { gameId } = req.body;
    if (!gamesCache.find(g => g.id === gameId)) {
        return res.status(404).json({ error: 'Gra nie istnieje' });
    }
    
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
