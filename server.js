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
const GAMES_CHANNEL_ID = process.env.GAMES_CHANNEL_ID;

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
let gamesChannel = null;
const userChannelsCache = new Map();
let gamesCache = [];

const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// === CACHE DLA POWIADOMIEŃ O ZAPROSZENIACH ===
// Przechowuje informacje o użytkownikach z oczekującymi zaproszeniami
const pendingInvitesCache = new Map();

// === START SERWERA HTTP ===
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Serwer HTTP na porcie ${PORT}`);
    console.log(`📡 Admin panel: http://localhost:${PORT}/admin.html`);
});

// === ENDPOINT /admin.html ===
app.get('/admin.html', async (req, res) => {
    try {
        const adminPath = path.join(__dirname, 'admin.html');
        const html = await fs.readFile(adminPath, 'utf-8');
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
    } catch (error) {
        console.error('❌ Błąd wczytywania admin.html:', error);
        res.status(500).send(`Błąd: ${error.message}`);
    }
});

// Health check - ROZSZERZONY O INFO O ZAPROSZENIACH
app.get('/health', async (req, res) => {
    const username = req.query.username; // Opcjonalny parametr do sprawdzenia konkretnego użytkownika
    
    const response = {
        status: discordReady ? 'OK' : 'INITIALIZING',
        discord: discordReady,
        timestamp: new Date().toISOString()
    };

    // Jeśli podano username, sprawdź czy ma oczekujące zaproszenia
    if (username && discordReady) {
        try {
            const hasPending = await checkUserPendingInvites(username);
            response.hasPendingInvites = hasPending;
            response.pendingInvitesCount = await getPendingInvitesCount(username);
        } catch (error) {
            console.error(`Błąd sprawdzania zaproszeń dla ${username}:`, error);
        }
    }
    
    res.json(response);
});

// NOWY ENDPOINT - sprawdź czy użytkownik ma oczekujące zaproszenia
app.get('/api/friends/:username/has-pending', requireDiscordForWrite, async (req, res) => {
    try {
        const username = req.params.username;
        const data = await loadUserFile(username, 'friends.json', { friends: [], pending: [] });
        
        // Konwersja starego formatu
        if (data.pending && !data.pendingInvites) {
            data.pendingInvites = data.pending.map(p => ({
                from: p.from,
                timestamp: p.at || new Date().toISOString()
            }));
        }
        
        const pendingInvites = data.pendingInvites || data.pending || [];
        const hasPending = pendingInvites.length > 0;
        
        // Aktualizuj cache
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
        console.error('❌ Błąd sprawdzania zaproszeń:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/', (req, res) => {
    res.json({ 
        message: 'Nebula Game Server',
        status: discordReady ? 'online' : 'booting',
        endpoints: ['/health', '/admin.html', '/games', '/api/games']
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

// === FUNKCJE POMOCNICZE DLA POWIADOMIEŃ ===

async function checkUserPendingInvites(username) {
    try {
        const data = await loadUserFile(username, 'friends.json', { friends: [], pending: [] });
        
        // Obsługa obu formatów (stary i nowy)
        const pending = data.pendingInvites || data.pending || [];
        return pending.length > 0;
    } catch (error) {
        return false;
    }
}

async function getPendingInvitesCount(username) {
    try {
        const data = await loadUserFile(username, 'friends.json', { friends: [], pending: [] });
        const pending = data.pendingInvites || data.pending || [];
        return pending.length;
    } catch (error) {
        return 0;
    }
}

// Funkcja aktualizująca cache zaproszeń (wywoływana przy każdej zmianie)
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
        console.error(`Błąd aktualizacji cache dla ${username}:`, error);
    }
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
                
                await initGamesChannel();
                await loadExistingUserChannels();
                await syncGamesFromDiscord();
                
                discordReady = true;
                console.log('✅ Discord gotowy!');
                
                // Uruchom okresowe sprawdzanie zaproszeń
                setInterval(periodicPendingCheck, 30000); // Co 30 sekund
                
                setInterval(syncGamesFromDiscord, 300000);
                
            } catch (error) {
                console.error('❌ Błąd inicjalizacji:', error);
            }
        });
        
        await discordClient.login(DISCORD_TOKEN);
        
    } catch (error) {
        console.error('❌ Błąd Discord:', error);
    }
}

// Okresowe sprawdzanie zaproszeń dla wszystkich aktywnych użytkowników
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
                console.log(`📁 Używam kanału: ${gamesChannel.name}`);
                return;
            } catch (e) {
                console.log('⚠️ Nie znaleziono kanału z ID, tworzę nowy...');
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
                parent: STORAGE_CATEGORY_ID,
                topic: '🎮 Automatycznie aktualizowany plik games.json',
                permissionOverwrites: [
                    { 
                        id: guild.id, 
                        deny: [PermissionFlagsBits.SendMessages],
                        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]
                    },
                    { 
                        id: discordClient.user.id, 
                        allow: [
                            PermissionFlagsBits.ViewChannel, 
                            PermissionFlagsBits.SendMessages, 
                            PermissionFlagsBits.AttachFiles,
                            PermissionFlagsBits.ManageMessages
                        ] 
                    }
                ]
            });
            console.log(`✅ Utworzono kanał games-json`);
        }
    } catch (error) {
        console.error('❌ Błąd kanału games.json:', error);
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
            content: `🎮 **Games.json** | Aktualizacja: <t:${Math.floor(Date.now()/1000)}:F> | Gier: ${gamesCache.length}`,
            files: [attachment]
        });

        console.log(`📤 Wysłano games.json (${gamesCache.length} gier)`);
        return true;
    } catch (error) {
        console.error('❌ Błąd wysyłania games.json:', error);
        return false;
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
        const data = await res.json();
        return data;
    } catch {
        return defaultData;
    }
}

// === CZAT ===
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

// === GAMES ===
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
        
        console.log(`🎮 Załadowano ${gamesCache.length} gier`);
    } catch (error) {
        console.error('❌ Sync gier:', error);
        gamesCache = [];
    }
}

async function saveGame(gameId, gameData) {
    if (!Array.isArray(gamesCache)) {
        gamesCache = [];
    }
    
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
    
    await saveGlobalFile('games.json', gamesCache, '🎮 Biblioteka gier');
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
        await saveGlobalFile('games.json', gamesCache, '🎮 Biblioteka gier');
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
    if (!game) return res.status(404).json({ error: 'Nie ma takiej gry' });
    res.json(game);
});

// NOWY ENDPOINT - pobierz URL do pobrania gry
app.get('/games/:id/download', requireDiscordForWrite, async (req, res) => {
    const game = gamesCache.find(g => g.id === req.params.id);
    if (!game) return res.status(404).json({ error: 'Nie ma takiej gry' });
    
    if (!game.download_url) {
        return res.status(404).json({ error: 'Brak URL do pobrania' });
    }
    
    res.json({ url: game.download_url });
});

app.post('/api/games', requireDiscordForWrite, async (req, res) => {
    try {
        const { 
            name, description, developer, price, icon, color, pegi, download_url,
            size,
            requirements
        } = req.body;
        
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
            size: size || null,
            requirements: requirements || {
                min: {
                    os: '',
                    cpu: '',
                    ram: '',
                    gpu: '',
                    storage: ''
                },
                rec: {
                    os: '',
                    cpu: '',
                    ram: '',
                    gpu: '',
                    storage: ''
                }
            },
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
        console.error('❌ Błąd POST /api/games:', error);
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/games/:id', requireDiscordForWrite, async (req, res) => {
    try {
        if (!Array.isArray(gamesCache)) {
            return res.status(500).json({ error: 'Błąd serwera - cache nie jest tablicą' });
        }
        
        const existing = gamesCache.find(g => g.id === req.params.id);
        if (!existing) {
            return res.status(404).json({ error: 'Gra nie istnieje' });
        }
        
        const updated = await saveGame(req.params.id, { ...existing, ...req.body });
        res.json({ success: true, game: updated });
    } catch (error) {
        console.error('❌ Błąd PUT /api/games:', error);
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/games/:id', requireDiscordForWrite, async (req, res) => {
    try {
        const success = await deleteGame(req.params.id);
        res.json({ success, message: success ? 'Usunięto' : 'Nie znaleziono' });
    } catch (error) {
        console.error('❌ Błąd DELETE /api/games:', error);
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
        
        // Sprawdź czy ma oczekujące zaproszenia przy logowaniu
        const hasPending = await checkUserPendingInvites(username);
        
        res.json({ 
            success: true, 
            token, 
            user: { 
                id: user.id, 
                username: user.username, 
                email: user.email,
                hasPendingInvites: hasPending
            }
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
    
    // Sprawdź czy ma oczekujące zaproszenia
    const hasPending = await checkUserPendingInvites(user.username);
    
    res.json({ 
        valid: true, 
        userId: user.id, 
        username: user.username,
        hasPendingInvites: hasPending
    });
});

// === ZNAJOMI - POPRAWIONE ===
app.get('/api/friends/:username', requireDiscordForWrite, async (req, res) => {
    try {
        const data = await loadUserFile(req.params.username, 'friends.json', { friends: [], pending: [] });
        const users = await loadGlobalFile('users.json', {});
        
        // Konwersja starego formatu na nowy
        if (data.pending && !data.pendingInvites) {
            data.pendingInvites = data.pending.map(p => ({
                from: p.from,
                timestamp: p.at || new Date().toISOString()
            }));
        }
        
        const friends = await Promise.all(
            (data.friends || []).map(async (name) => ({
                username: name,
                status: 'online',
                lastSeen: users[name]?.lastLogin
            }))
        );
        
        const pendingInvites = (data.pendingInvites || data.pending || []).map(p => ({
            from: p.from,
            timestamp: p.timestamp || p.at || new Date().toISOString()
        }));
        
        // Aktualizuj cache
        if (pendingInvites.length > 0) {
            pendingInvitesCache.set(req.params.username, pendingInvites.length);
        }
        
        res.json({ 
            friends, 
            pendingInvites: pendingInvites 
        });
    } catch (error) {
        console.error('❌ Błąd GET /api/friends/:username:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/friends/add', requireDiscordForWrite, async (req, res) => {
    try {
        const { fromUser, toUser } = req.body;
        const users = await loadGlobalFile('users.json', {});
        
        if (!users[toUser]) return res.status(404).json({ error: 'Nie ma takiego użytkownika' });
        
        const toData = await loadUserFile(toUser, 'friends.json', { friends: [], pending: [] });
        
        // Konwersja starego formatu
        if (toData.pending && !toData.pendingInvites) {
            toData.pendingInvites = toData.pending.map(p => ({
                from: p.from,
                timestamp: p.at || new Date().toISOString()
            }));
            delete toData.pending;
        }
        
        if (!toData.pendingInvites) toData.pendingInvites = [];
        
        // Sprawdź czy już nie ma zaproszenia lub nie są znajomymi
        const alreadyPending = toData.pendingInvites.find(p => p.from === fromUser);
        const alreadyFriends = (toData.friends || []).includes(fromUser);
        
        if (!alreadyPending && !alreadyFriends) {
            toData.pendingInvites.push({ 
                from: fromUser, 
                timestamp: new Date().toISOString() 
            });
            await saveUserFile(toUser, 'friends.json', toData, '👥 Znajomi');
            
            // Dodaj do cache powiadomień
            pendingInvitesCache.set(toUser, toData.pendingInvites.length);
        }
        
        res.json({ success: true });
    } catch (error) {
        console.error('❌ Błąd POST /api/friends/add:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/friends/respond', requireDiscordForWrite, async (req, res) => {
    try {
        const { username, fromUser, accept } = req.body;
        
        const userData = await loadUserFile(username, 'friends.json', { friends: [], pending: [] });
        const fromData = await loadUserFile(fromUser, 'friends.json', { friends: [], pending: [] });
        
        // Konwersja starego formatu
        if (userData.pending && !userData.pendingInvites) {
            userData.pendingInvites = userData.pending.map(p => ({
                from: p.from,
                timestamp: p.at || new Date().toISOString()
            }));
            delete userData.pending;
        }
        
        // Usuń z pendingInvites
        userData.pendingInvites = (userData.pendingInvites || []).filter(p => p.from !== fromUser);
        
        if (accept) {
            // Dodaj do znajomych obu stron
            if (!userData.friends) userData.friends = [];
            if (!fromData.friends) fromData.friends = [];
            
            if (!userData.friends.includes(fromUser)) {
                userData.friends.push(fromUser);
            }
            if (!fromData.friends.includes(username)) {
                fromData.friends.push(username);
            }
            
            // Utwórz kanał czatu
            await saveChatFile(username, fromUser, {
                participants: [username, fromUser],
                messages: []
            });
        }
        
        await saveUserFile(username, 'friends.json', userData, '👥 Znajomi');
        await saveUserFile(fromUser, 'friends.json', fromData, '👥 Znajomi');
        
        // Aktualizuj cache
        await updatePendingInvitesCache(username);
        
        res.json({ success: true, accepted: accept });
    } catch (error) {
        console.error('❌ Błąd POST /api/friends/respond:', error);
        res.status(500).json({ error: error.message });
    }
});

// NOWY ENDPOINT - usuwanie znajomego
app.delete('/api/friends/remove', requireDiscordForWrite, async (req, res) => {
    try {
        const { username, friendName } = req.body;
        
        const userData = await loadUserFile(username, 'friends.json', { friends: [], pending: [] });
        const friendData = await loadUserFile(friendName, 'friends.json', { friends: [], pending: [] });
        
        userData.friends = (userData.friends || []).filter(f => f !== friendName);
        friendData.friends = (friendData.friends || []).filter(f => f !== username);
        
        await saveUserFile(username, 'friends.json', userData, '👥 Znajomi');
        await saveUserFile(friendName, 'friends.json', friendData, '👥 Znajomi');
        
        res.json({ success: true });
    } catch (error) {
        console.error('❌ Błąd DELETE /api/friends/remove:', error);
        res.status(500).json({ error: error.message });
    }
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

// NOWY ENDPOINT - pobierz konkretną grę z biblioteki
app.get('/api/users/:username/library/:gameId', requireDiscordForWrite, async (req, res) => {
    try {
        const { username, gameId } = req.params;
        const lib = await loadUserFile(username, 'library.json', { games: [] });
        
        const gameEntry = lib.games.find(g => g.gameId === gameId);
        if (!gameEntry) {
            return res.status(404).json({ error: 'Gra nie znaleziona w bibliotece' });
        }
        
        const gameDetails = gamesCache.find(gc => gc.id === gameId);
        res.json({
            ...gameEntry,
            gameDetails: gameDetails || null
        });
    } catch (error) {
        console.error('❌ Błąd GET /api/users/:username/library/:gameId:', error);
        res.status(500).json({ error: error.message });
    }
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

// NOWY ENDPOINT - aktualizuj status instalacji gry
app.put('/api/users/:username/library/:gameId', requireDiscordForWrite, async (req, res) => {
    try {
        const { username, gameId } = req.params;
        const { installed, installPath } = req.body;
        
        const lib = await loadUserFile(username, 'library.json', { games: [] });
        const gameEntry = lib.games.find(g => g.gameId === gameId);
        
        if (!gameEntry) {
            return res.status(404).json({ error: 'Gra nie znaleziona w bibliotece' });
        }
        
        gameEntry.installed = installed;
        if (installPath !== undefined) {
            gameEntry.installPath = installPath;
        }
        gameEntry.updatedAt = new Date().toISOString();
        
        await saveUserFile(username, 'library.json', lib, '📚 Biblioteka');
        res.json({ success: true, game: gameEntry });
    } catch (error) {
        console.error('❌ Błąd PUT /api/users/:username/library/:gameId:', error);
        res.status(500).json({ error: error.message });
    }
});

// NOWY ENDPOINT - usuń grę z biblioteki
app.delete('/api/users/:username/library/:gameId', requireDiscordForWrite, async (req, res) => {
    try {
        const { username, gameId } = req.params;
        const lib = await loadUserFile(username, 'library.json', { games: [] });
        
        const initialLength = lib.games.length;
        lib.games = lib.games.filter(g => g.gameId !== gameId);
        
        if (lib.games.length === initialLength) {
            return res.status(404).json({ error: 'Gra nie znaleziona w bibliotece' });
        }
        
        await saveUserFile(username, 'library.json', lib, '📚 Biblioteka');
        res.json({ success: true, message: 'Gra usunięta z biblioteki' });
    } catch (error) {
        console.error('❌ Błąd DELETE /api/users/:username/library/:gameId:', error);
        res.status(500).json({ error: error.message });
    }
});

console.log('📋 Zarejestrowane endpointy:');
console.log('  GET  /health');
console.log('  GET  /admin.html');
console.log('  GET  /games');
console.log('  GET  /games/:id');
console.log('  GET  /games/:id/download');
console.log('  POST /api/games');
console.log('  PUT  /api/games/:id');
console.log('  DELETE /api/games/:id');
console.log('  POST /api/auth/register');
console.log('  POST /api/auth/login');
console.log('  GET  /api/auth/verify');
console.log('  GET  /api/friends/:username');
console.log('  GET  /api/friends/:username/has-pending  <-- NOWY');
console.log('  POST /api/friends/add');
console.log('  POST /api/friends/respond');
console.log('  DELETE /api/friends/remove');
console.log('  GET  /api/chat/:user1/:user2');
console.log('  POST /api/chat/send');
console.log('  GET  /api/users/:username/library');
console.log('  GET  /api/users/:username/library/:gameId');
console.log('  POST /api/users/:username/library');
console.log('  PUT  /api/users/:username/library/:gameId');
console.log('  DELETE /api/users/:username/library/:gameId');
