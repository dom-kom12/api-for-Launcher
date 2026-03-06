const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');
const crypto = require('crypto');
const http = require('http');
const { Client, GatewayIntentBits, EmbedBuilder, AttachmentBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');

const app = express();

// Konfiguracja
const PORT = process.env.PORT || 3000;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID || '1477574526933012541';
const STORAGE_CATEGORY_ID = process.env.STORAGE_CATEGORY_ID || '1477579473611128843';
const NOTIFICATION_CHANNEL_ID = process.env.NOTIFICATION_CHANNEL_ID || '1477577363285082123';
const GAMES_CHANNEL_ID = process.env.GAMES_CHANNEL_ID;

// WAŻNE: URL do self-pingu (dla Replit/UptimeRobot)
const SELF_PING_URL = process.env.SELF_PING_URL || `http://0.0.0.0:${PORT}/health`;
const PING_INTERVAL = 2 * 60 * 1000; // Co 2 minuty

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
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ],
    rest: {
        timeout: 60000,
        retries: 3,
        interval: 3500
    },
    ws: {
        large_threshold: 250,
        compress: false
    }
});

let discordReady = false;
let guild = null;
let storageCategory = null;
let notificationChannel = null;
let gamesChannel = null;
const userChannelsCache = new Map();
let gamesCache = [];
let isShuttingDown = false;

const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// === CACHE DLA POWIADOMIEŃ ===
const pendingInvitesCache = new Map();

// === START SERWERA HTTP ===
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Serwer HTTP na porcie ${PORT}`);
    console.log(`📡 Admin panel: http://localhost:${PORT}/admin.html`);
    console.log(`🔄 Self-ping co ${PING_INTERVAL/1000}s: ${SELF_PING_URL}`);
    
    // URUCHOM SELF-PINGER po starcie serwera
    startSelfPinger();
});

// WAŻNE: Długie timeouty dla keep-alive
server.keepAliveTimeout = 120000;
server.headersTimeout = 120000;

// === SELF-PINGER - UTWZYMANIE PRZY ŻYCIU ===
function startSelfPinger() {
    setInterval(async () => {
        if (isShuttingDown) return;
        
        try {
            const response = await fetch(SELF_PING_URL);
            const data = await response.json();
            console.log(`🔄 Self-ping OK | Status: ${data.status} | Uptime: ${Math.floor(data.uptime/60)}min`);
        } catch (error) {
            console.error('❌ Self-ping failed:', error.message);
            // Nie wyłączaj - spróbuj ponownie za 2 minuty
        }
    }, PING_INTERVAL);
}

// === ENDPOINTY ===

app.get('/admin.html', async (req, res) => {
    try {
        const adminPath = path.join(__dirname, 'admin.html');
        const html = await fs.readFile(adminPath, 'utf-8');
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
    } catch (error) {
        res.status(500).send(`Błąd: ${error.message}`);
    }
});

// Health check - DODANO uptime i memory
app.get('/health', async (req, res) => {
    const username = req.query.username;
    
    const response = {
        status: discordReady ? 'OK' : 'INITIALIZING',
        discord: discordReady,
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        pid: process.pid
    };

    if (username && discordReady) {
        try {
            const hasPending = await checkUserPendingInvites(username);
            response.hasPendingInvites = hasPending;
            response.pendingInvitesCount = await getPendingInvitesCount(username);
        } catch (error) {
            console.error(`Błąd sprawdzania zaproszeń:`, error);
        }
    }
    
    res.json(response);
});

app.get('/api/friends/:username/has-pending', requireDiscordForWrite, async (req, res) => {
    try {
        const username = req.params.username;
        const data = await loadUserFile(username, 'friends.json', { friends: [], pending: [] });
        
        if (data.pending && !data.pendingInvites) {
            data.pendingInvites = data.pending.map(p => ({
                from: p.from,
                timestamp: p.at || new Date().toISOString()
            }));
        }
        
        const pendingInvites = data.pendingInvites || data.pending || [];
        const hasPending = pendingInvites.length > 0;
        
        if (hasPending) {
            pendingInvitesCache.set(username, pendingInvites.length);
        } else {
            pendingInvitesCache.delete(username);
        }
        
        res.json({
            hasPendingInvites: hasPending,
            count: pendingInvites.length,
            invites: pendingInvites
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/', (req, res) => {
    res.json({ 
        message: 'Nebula Game Server',
        status: discordReady ? 'online' : 'booting',
        uptime: process.uptime()
    });
});

function requireDiscordForWrite(req, res, next) {
    if (!discordReady) {
        return res.status(503).json({ 
            error: 'Discord not ready', 
            retryAfter: 5 
        });
    }
    next();
}

// === FUNKCJE POMOCNICZE ===

async function checkUserPendingInvites(username) {
    try {
        const data = await loadUserFile(username, 'friends.json', { friends: [], pending: [] });
        const pending = data.pendingInvites || data.pending || [];
        return pending.length > 0;
    } catch {
        return false;
    }
}

async function getPendingInvitesCount(username) {
    try {
        const data = await loadUserFile(username, 'friends.json', { friends: [], pending: [] });
        const pending = data.pendingInvites || data.pending || [];
        return pending.length;
    } catch {
        return 0;
    }
}

async function updatePendingInvitesCache(username) {
    try {
        const data = await loadUserFile(username, 'friends.json', { friends: [], pending: [] });
        const pending = data.pendingInvites || data.pending || [];
        
        if (pending.length > 0) {
            pendingInvitesCache.set(username, pending.length);
        } else {
            pendingInvitesCache.delete(username);
        }
    } catch (error) {
        console.error(`Błąd cache:`, error);
    }
}

// === INICJALIZACJA DISCORDA ===
async function initDiscord() {
    try {
        console.log('🔌 Łączenie z Discordem...');
        
        // Obsługa błędów
        discordClient.on('error', (error) => {
            console.error('❌ Discord Error:', error.message);
        });

        discordClient.on('disconnect', (event) => {
            console.log('⚠️ Discord disconnect:', event.code);
            discordReady = false;
        });

        discordClient.on('reconnecting', () => {
            console.log('🔄 Reconnecting...');
        });

        discordClient.on('resume', () => {
            console.log('✅ Resumed');
            discordReady = true;
        });

        discordClient.once('ready', async () => {
            console.log(`🤖 Bot: ${discordClient.user.tag}`);
            
            try {
                guild = await discordClient.guilds.fetch(GUILD_ID);
                storageCategory = await guild.channels.fetch(STORAGE_CATEGORY_ID);
                notificationChannel = await guild.channels.fetch(NOTIFICATION_CHANNEL_ID);
                
                await initGamesChannel();
                await loadExistingUserChannels();
                await syncGamesFromDiscord();
                
                discordReady = true;
                console.log('✅ Discord ready!');
                
                // Heartbeat co 30s
                setInterval(() => {
                    const ping = discordClient.ws.ping;
                    console.log(`💓 Ping: ${ping}ms | Ready: ${discordReady}`);
                }, 30000);
                
                // Sprawdzanie zaproszeń co 30s
                setInterval(periodicPendingCheck, 30000);
                
                // Sync gier co 5min
                setInterval(syncGamesFromDiscord, 300000);
                
            } catch (error) {
                console.error('❌ Init error:', error);
            }
        });
        
        await discordClient.login(DISCORD_TOKEN);
        
    } catch (error) {
        console.error('❌ Discord login failed:', error);
        setTimeout(initDiscord, 10000);
    }
}

async function periodicPendingCheck() {
    if (!discordReady) return;
    for (const username of pendingInvitesCache.keys()) {
        await updatePendingInvitesCache(username);
    }
}

async function initGamesChannel() {
    try {
        if (GAMES_CHANNEL_ID) {
            try {
                gamesChannel = await guild.channels.fetch(GAMES_CHANNEL_ID);
                console.log(`📁 Games channel: ${gamesChannel.name}`);
                return;
            } catch (e) {
                console.log('⚠️ Creating new games channel...');
            }
        }

        const existing = guild.channels.cache.find(c => 
            c.name === 'games-json' && c.parentId === STORAGE_CATEGORY_ID
        );

        if (existing) {
            gamesChannel = existing;
        } else {
            gamesChannel = await guild.channels.create({
                name: 'games-json',
                type: ChannelType.GuildText,
                parent: storageCategory.id,
                topic: '🎮 games.json',
                permissionOverwrites: [
                    { 
                        id: guild.id, 
                        deny: [PermissionFlagsBits.SendMessages],
                        allow: [PermissionFlagsBits.ViewChannel]
                    },
                    { 
                        id: discordClient.user.id, 
                        allow: [
                            PermissionFlagsBits.ViewChannel, 
                            PermissionFlagsBits.SendMessages, 
                            PermissionFlagsBits.AttachFiles
                        ] 
                    }
                ]
            });
            console.log(`✅ Created games-json`);
        }
    } catch (error) {
        console.error('❌ Games channel error:', error);
    }
}

async function uploadGamesJsonToDiscord() {
    if (!discordReady || !gamesChannel) return false;

    try {
        const gamesData = {
            guildId: GUILD_ID,
            guildName: guild.name,
            updatedAt: new Date().toISOString(),
            totalGames: gamesCache.length,
            games: gamesCache
        };

        const jsonContent = JSON.stringify(gamesData, null, 2);
        const buffer = Buffer.from(jsonContent, 'utf-8');
        const attachment = new AttachmentBuilder(buffer, { name: 'games.json' });

        const messages = await gamesChannel.messages.fetch({ limit: 10 });
        const botMessages = messages.filter(m => 
            m.author.id === discordClient.user.id && 
            m.attachments.some(a => a.name === 'games.json')
        );

        const toDelete = botMessages.sort((a, b) => b.createdTimestamp - a.createdTimestamp).slice(2);
        for (const msg of toDelete.values()) {
            try { await msg.delete(); await new Promise(r => setTimeout(r, 500)); } catch {}
        }

        await gamesChannel.send({
            content: `🎮 Games.json | ${gamesCache.length} games | <t:${Math.floor(Date.now()/1000)}:F>`,
            files: [attachment]
        });

        console.log(`📤 Uploaded games.json (${gamesCache.length} games)`);
        return true;
    } catch (error) {
        console.error('❌ Upload error:', error);
        return false;
    }
}

// START
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
        console.error('❌ Notification error:', error);
    }
}

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
        console.log(`📁 ${userChannelsCache.size} user channels`);
    } catch (error) {
        console.error('❌ Load channels error:', error);
    }
}

async function getOrCreateUserChannel(username) {
    if (!discordReady) throw new Error('Discord not ready');

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

async function getChatChannelName(user1, user2) {
    const sorted = [user1, user2].sort();
    return `chat-${sorted[0]}-and-${sorted[1]}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

async function loadChatFile(user1, user2) {
    try {
        const channelName = await getChatChannelName(user1, user2);
        const channel = guild.channels.cache.find(c => 
            c.name === channelName && c.parentId === STORAGE_CATEGORY_ID
        );
        
        if (!channel) return null;
        
        const messages = await channel.messages.fetch({ limit: 1 });
        const msg = messages.first();
        
        if (!msg || msg.attachments.size === 0) return null;
        
        const attachment = msg.attachments.first();
        const res = await fetch(attachment.url);
        return await res.json();
    } catch {
        return null;
    }
}

async function saveChatFile(user1, user2, data) {
    const channelName = await getChatChannelName(user1, user2);
    let channel = guild.channels.cache.find(c => 
        c.name === channelName && c.parentId === STORAGE_CATEGORY_ID
    );
    
    if (!channel) {
        channel = await guild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            parent: storageCategory.id,
            permissionOverwrites: [
                { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                { id: discordClient.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles] }
            ]
        });
    }
    
    const buffer = Buffer.from(JSON.stringify(data, null, 2));
    const attachment = new AttachmentBuilder(buffer, { name: 'chat.json' });
    
    const messages = await channel.messages.fetch({ limit: 10 });
    for (const msg of messages.values()) {
        try { await msg.delete(); } catch {}
    }
    
    return await channel.send({
        content: `💬 ${user1} ↔ ${user2}`,
        files: [attachment]
    });
}

async function syncGamesFromDiscord() {
    if (!discordReady) return;
    try {
        const loaded = await loadGlobalFile('games.json', []);
        
        if (Array.isArray(loaded)) {
            gamesCache = loaded;
        } else if (loaded && loaded.games && Array.isArray(loaded.games)) {
            gamesCache = loaded.games;
        } else if (loaded && typeof loaded === 'object') {
            gamesCache = Object.values(loaded);
        } else {
            gamesCache = [];
        }
        
        console.log(`🎮 Loaded ${gamesCache.length} games`);
    } catch (error) {
        console.error('❌ Sync error:', error);
        gamesCache = [];
    }
}

async function saveGame(gameId, gameData) {
    if (!Array.isArray(gamesCache)) gamesCache = [];
    
    const existingIndex = gamesCache.findIndex(g => g.id === gameId);
    const gameWithId = { 
        ...gameData, 
        id: gameId, 
        updatedAt: new Date().toISOString() 
    };
    
    if (existingIndex >= 0) {
        gamesCache[existingIndex] = gameWithId;
    } else {
        gamesCache.push(gameWithId);
    }
    
    await saveGlobalFile('games.json', gamesCache, '🎮 Games');
    await uploadGamesJsonToDiscord();
    
    return gameWithId;
}

async function deleteGame(gameId) {
    if (!Array.isArray(gamesCache)) {
        gamesCache = [];
        return false;
    }
    
    const initialLength = gamesCache.length;
    gamesCache = gamesCache.filter(g => g.id !== gameId);
    
    if (gamesCache.length < initialLength) {
        await saveGlobalFile('games.json', gamesCache, '🎮 Games');
        await uploadGamesJsonToDiscord();
        return true;
    }
    return false;
}

// === ENDPOINTY GIER ===

app.get('/games', async (req, res) => {
    if (discordReady && gamesCache.length === 0) {
        await syncGamesFromDiscord();
    }
    res.json(gamesCache || []);
});

app.get('/games/:id', async (req, res) => {
    const game = gamesCache.find(g => g.id === req.params.id);
    if (!game) return res.status(404).json({ error: 'Game not found' });
    res.json(game);
});

app.get('/games/:id/download', requireDiscordForWrite, async (req, res) => {
    const game = gamesCache.find(g => g.id === req.params.id);
    if (!game) return res.status(404).json({ error: 'Game not found' });
    if (!game.download_url) return res.status(404).json({ error: 'No download URL' });
    res.json({ url: game.download_url });
});

app.post('/api/games', requireDiscordForWrite, async (req, res) => {
    try {
        const { name, description, developer, price, icon, color, pegi, download_url, size, requirements } = req.body;
        if (!name) return res.status(400).json({ error: 'Name required' });
        
        const gameId = crypto.randomUUID();
        const gameData = {
            name, description: description || '', developer: developer || 'Unknown',
            price: price || 0, icon: icon || '🎮', color: color || '#00d4ff',
            pegi: pegi || 12, download_url: download_url || null, size: size || null,
            requirements: requirements || { min: {}, rec: {} },
            createdAt: new Date().toISOString()
        };
        
        const saved = await saveGame(gameId, gameData);
        
        const embed = new EmbedBuilder()
            .setTitle(price === 0 ? '🆓 New free game!' : '💰 New game!')
            .setDescription(`**${name}**`)
            .addFields(
                { name: 'Dev', value: gameData.developer, inline: true },
                { name: 'Price', value: price === 0 ? 'FREE' : `${price}zł`, inline: true }
            )
            .setColor(parseInt(gameData.color.replace('#', ''), 16))
            .setTimestamp();
        
        await sendDiscordNotification(embed);
        res.json({ success: true, game: saved });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/games/:id', requireDiscordForWrite, async (req, res) => {
    try {
        const existing = gamesCache.find(g => g.id === req.params.id);
        if (!existing) return res.status(404).json({ error: 'Game not found' });
        
        const updated = await saveGame(req.params.id, { ...existing, ...req.body });
        res.json({ success: true, game: updated });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/games/:id', requireDiscordForWrite, async (req, res) => {
    try {
        const success = await deleteGame(req.params.id);
        res.json({ success, message: success ? 'Deleted' : 'Not found' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// === AUTH ===

app.post('/api/auth/register', requireDiscordForWrite, async (req, res) => {
    try {
        const { username, password, email } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
        
        const users = await loadGlobalFile('users.json', {});
        if (users[username]) return res.status(409).json({ error: 'User exists' });
        
        const token = generateToken();
        users[username] = {
            id: crypto.randomUUID(), username, email: email || '',
            passwordHash: hashPassword(password), token,
            createdAt: new Date().toISOString()
        };
        
        await saveGlobalFile('users.json', users, '👥 Users');
        await getOrCreateUserChannel(username);
        await saveUserFile(username, 'library.json', { games: [] }, '📚 Library');
        await saveUserFile(username, 'friends.json', { friends: [], pending: [] }, '👥 Friends');
        
        const embed = new EmbedBuilder()
            .setTitle('👤 New user')
            .setDescription(`**${username}** joined!`)
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
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const token = generateToken();
        user.token = token;
        user.lastLogin = new Date().toISOString();
        await saveGlobalFile('users.json', users, '👥 Users');
        
        const hasPending = await checkUserPendingInvites(username);
        
        res.json({ 
            success: true, token, 
            user: { id: user.id, username: user.username, email: user.email, hasPendingInvites: hasPending }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/auth/verify', requireDiscordForWrite, async (req, res) => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
    
    const token = auth.substring(7);
    const users = await loadGlobalFile('users.json', {});
    const user = Object.values(users).find(u => u.token === token);
    
    if (!user) return res.status(401).json({ error: 'Invalid token' });
    
    const hasPending = await checkUserPendingInvites(user.username);
    res.json({ valid: true, userId: user.id, username: user.username, hasPendingInvites: hasPending });
});

// === FRIENDS ===

app.get('/api/friends/:username', requireDiscordForWrite, async (req, res) => {
    try {
        const data = await loadUserFile(req.params.username, 'friends.json', { friends: [], pending: [] });
        const users = await loadGlobalFile('users.json', {});
        
        if (data.pending && !data.pendingInvites) {
            data.pendingInvites = data.pending.map(p => ({
                from: p.from, timestamp: p.at || new Date().toISOString()
            }));
        }
        
        const friends = await Promise.all(
            (data.friends || []).map(async (name) => ({
                username: name, status: 'online', lastSeen: users[name]?.lastLogin
            }))
        );
        
        const pendingInvites = (data.pendingInvites || data.pending || []).map(p => ({
            from: p.from, timestamp: p.timestamp || p.at || new Date().toISOString()
        }));
        
        if (pendingInvites.length > 0) {
            pendingInvitesCache.set(req.params.username, pendingInvites.length);
        }
        
        res.json({ friends, pendingInvites });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/friends/add', requireDiscordForWrite, async (req, res) => {
    try {
        const { fromUser, toUser } = req.body;
        const users = await loadGlobalFile('users.json', {});
        if (!users[toUser]) return res.status(404).json({ error: 'User not found' });
        
        const toData = await loadUserFile(toUser, 'friends.json', { friends: [], pending: [] });
        
        if (toData.pending && !toData.pendingInvites) {
            toData.pendingInvites = toData.pending.map(p => ({
                from: p.from, timestamp: p.at || new Date().toISOString()
            }));
            delete toData.pending;
        }
        
        if (!toData.pendingInvites) toData.pendingInvites = [];
        
        const alreadyPending = toData.pendingInvites.find(p => p.from === fromUser);
        const alreadyFriends = (toData.friends || []).includes(fromUser);
        
        if (!alreadyPending && !alreadyFriends) {
            toData.pendingInvites.push({ from: fromUser, timestamp: new Date().toISOString() });
            await saveUserFile(toUser, 'friends.json', toData, '👥 Friends');
            pendingInvitesCache.set(toUser, toData.pendingInvites.length);
        }
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/friends/respond', requireDiscordForWrite, async (req, res) => {
    try {
        const { username, fromUser, accept } = req.body;
        
        const userData = await loadUserFile(username, 'friends.json', { friends: [], pending: [] });
        const fromData = await loadUserFile(fromUser, 'friends.json', { friends: [], pending: [] });
        
        if (userData.pending && !userData.pendingInvites) {
            userData.pendingInvites = userData.pending.map(p => ({
                from: p.from, timestamp: p.at || new Date().toISOString()
            }));
            delete userData.pending;
        }
        
        userData.pendingInvites = (userData.pendingInvites || []).filter(p => p.from !== fromUser);
        
        if (accept) {
            if (!userData.friends) userData.friends = [];
            if (!fromData.friends) fromData.friends = [];
            
            if (!userData.friends.includes(fromUser)) userData.friends.push(fromUser);
            if (!fromData.friends.includes(username)) fromData.friends.push(username);
            
            await saveChatFile(username, fromUser, {
                participants: [username, fromUser], messages: []
            });
        }
        
        await saveUserFile(username, 'friends.json', userData, '👥 Friends');
        await saveUserFile(fromUser, 'friends.json', fromData, '👥 Friends');
        await updatePendingInvitesCache(username);
        
        res.json({ success: true, accepted: accept });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/friends/remove', requireDiscordForWrite, async (req, res) => {
    try {
        const { username, friendName } = req.body;
        
        const userData = await loadUserFile(username, 'friends.json', { friends: [], pending: [] });
        const friendData = await loadUserFile(friendName, 'friends.json', { friends: [], pending: [] });
        
        userData.friends = (userData.friends || []).filter(f => f !== friendName);
        friendData.friends = (friendData.friends || []).filter(f => f !== username);
        
        await saveUserFile(username, 'friends.json', userData, '👥 Friends');
        await saveUserFile(friendName, 'friends.json', friendData, '👥 Friends');
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// === CHAT ===

app.get('/api/chat/:user1/:user2', requireDiscordForWrite, async (req, res) => {
    const data = await loadChatFile(req.params.user1, req.params.user2);
    res.json(data || { messages: [], participants: [req.params.user1, req.params.user2] });
});

app.post('/api/chat/send', requireDiscordForWrite, async (req, res) => {
    const { fromUser, toUser, content } = req.body;
    
    let chat = await loadChatFile(fromUser, toUser);
    if (!chat) chat = { participants: [fromUser, toUser], messages: [] };
    
    chat.messages.push({
        id: crypto.randomUUID(), sender: fromUser,
        content: content.trim(), timestamp: new Date().toISOString(), read: false
    });
    
    if (chat.messages.length > 500) chat.messages = chat.messages.slice(-500);
    
    await saveChatFile(fromUser, toUser, chat);
    res.json({ success: true });
});

// === LIBRARY ===

app.get('/api/users/:username/library', requireDiscordForWrite, async (req, res) => {
    const lib = await loadUserFile(req.params.username, 'library.json', { games: [] });
    const enriched = lib.games.map(g => ({
        ...g, gameDetails: gamesCache.find(gc => gc.id === g.gameId)
    }));
    res.json(enriched);
});

app.get('/api/users/:username/library/:gameId', requireDiscordForWrite, async (req, res) => {
    try {
        const { username, gameId } = req.params;
        const lib = await loadUserFile(username, 'library.json', { games: [] });
        
        const gameEntry = lib.games.find(g => g.gameId === gameId);
        if (!gameEntry) return res.status(404).json({ error: 'Game not in library' });
        
        const gameDetails = gamesCache.find(gc => gc.id === gameId);
        res.json({ ...gameEntry, gameDetails: gameDetails || null });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/users/:username/library', requireDiscordForWrite, async (req, res) => {
    const { gameId } = req.body;
    if (!gamesCache.find(g => g.id === gameId)) return res.status(404).json({ error: 'Game not found' });
    
    const lib = await loadUserFile(req.params.username, 'library.json', { games: [] });
    if (!lib.games.find(g => g.gameId === gameId)) {
        lib.games.push({
            gameId, addedAt: new Date().toISOString(),
            installed: false, playTime: 0
        });
        await saveUserFile(req.params.username, 'library.json', lib, '📚 Library');
    }
    
    res.json({ success: true, library: lib.games });
});

app.put('/api/users/:username/library/:gameId', requireDiscordForWrite, async (req, res) => {
    try {
        const { username, gameId } = req.params;
        const { installed, installPath } = req.body;
        
        const lib = await loadUserFile(username, 'library.json', { games: [] });
        const gameEntry = lib.games.find(g => g.gameId === gameId);
        
        if (!gameEntry) return res.status(404).json({ error: 'Game not in library' });
        
        gameEntry.installed = installed;
        if (installPath !== undefined) gameEntry.installPath = installPath;
        gameEntry.updatedAt = new Date().toISOString();
        
        await saveUserFile(username, 'library.json', lib, '📚 Library');
        res.json({ success: true, game: gameEntry });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/users/:username/library/:gameId', requireDiscordForWrite, async (req, res) => {
    try {
        const { username, gameId } = req.params;
        const lib = await loadUserFile(username, 'library.json', { games: [] });
        
        const initialLength = lib.games.length;
        lib.games = lib.games.filter(g => g.gameId !== gameId);
        
        if (lib.games.length === initialLength) {
            return res.status(404).json({ error: 'Game not in library' });
        }
        
        await saveUserFile(username, 'library.json', lib, '📚 Library');
        res.json({ success: true, message: 'Game removed from library' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// === OBSŁUGA BŁĘDÓW I ZAMYKANIA ===

// Zapobiegaj wyłączaniu przez SIGTERM z zewnętrznego pinger'a
process.on('SIGTERM', () => {
    console.log('⚠️ SIGTERM received - ignoring for keep-alive');
    // NIE wyłączaj - kontynuuj działanie
    // Jeśli to prawdziwe zamknięcie, użyj SIGINT
});

process.on('SIGINT', () => {
    console.log('🛑 SIGINT received - shutting down gracefully');
    isShuttingDown = true;
    server.close(() => {
        discordClient.destroy();
        process.exit(0);
    });
});

// Zapobiegaj wyłączaniu przez brak aktywności
process.on('beforeExit', () => {
    console.log('⚠️ beforeExit - keeping alive');
    // Utrzymaj przy życiu
    setTimeout(() => {}, 1000);
});

// Ignoruj błędy niekrytyczne
process.on('unhandledRejection', (error) => {
    console.error('⚠️ Unhandled Rejection:', error.message);
});

process.on('uncaughtException', (error) => {
    console.error('⚠️ Uncaught Exception:', error.message);
    // Nie wyłączaj - spróbuj kontynuować
});

console.log('📋 Server starting...');
