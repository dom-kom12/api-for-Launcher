const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');
const crypto = require('crypto');
const { Client, GatewayIntentBits, EmbedBuilder, AttachmentBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');

const app = express();
const PORT = process.env.PORT || 3000;

// Konfiguracja Discord Bota
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'MTQ3NzU3NDgyNTU1MDgxMTI0OA.GU-dWC.U3a5QUfQjRCjnQwrhB0yyrbY3EKHd90Alm0GyY';
const GUILD_ID = process.env.GUILD_ID || '1477574526933012541';
const STORAGE_CATEGORY_ID = process.env.STORAGE_CATEGORY_ID || '1477579473611128843';
const NOTIFICATION_CHANNEL_ID = process.env.NOTIFICATION_CHANNEL_ID || '1477577363285082123';

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('.'));

// Inicjalizacja Discord Bota
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

// Cache gier w pamięci (szybszy dostęp niż Discord)
let gamesCache = {};
let lastGamesSync = 0;

// Middleware sprawdzający czy Discord jest gotowy
function requireDiscord(req, res, next) {
    if (!discordReady) {
        return res.status(503).json({ 
            error: 'Serwer Discord nie jest jeszcze gotowy', 
            status: 'initializing' 
        });
    }
    next();
}

discordClient.once('ready', async () => {
    console.log(`🤖 Discord Bot zalogowany jako ${discordClient.user.tag}`);
    
    try {
        guild = await discordClient.guilds.fetch(GUILD_ID);
        storageCategory = await guild.channels.fetch(STORAGE_CATEGORY_ID);
        notificationChannel = await guild.channels.fetch(NOTIFICATION_CHANNEL_ID);
        
        console.log('✅ Połączono z Discordem');
        
        // Załaduj gry z Discorda na start
        await syncGamesFromDiscord();
        
        await loadExistingUserChannels();
        await ensureUsersHaveChannels();
        
        discordReady = true;
        console.log('🚀 Discord gotowy - endpointy aktywne');
        console.log(`📚 Załadowano ${Object.keys(gamesCache).length} gier z Discorda`);
        
        // Uruchom okresową synchronizację co 1 minutę (opcjonalnie)
        setInterval(syncGamesFromDiscord, 60000);
        
    } catch (error) {
        console.error('❌ Błąd inicjalizacji Discord:', error);
        process.exit(1);
    }
});

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
        console.error('❌ Błąd powiadomienia:', error);
    }
}

// === ZARZĄDZANIE KANAŁAMI ===

async function loadExistingUserChannels() {
    try {
        const channels = await guild.channels.fetch();
        const userChannels = channels.filter(c => 
            c.parentId === STORAGE_CATEGORY_ID && 
            c.name.startsWith('user-')
        );
        
        for (const [id, channel] of userChannels) {
            const username = channel.name.replace('user-', '').replace(/-/g, '_');
            userChannelsCache.set(username, id);
            console.log(`📁 Znaleziono kanał dla ${username}: ${id}`);
        }
        
        console.log(`✅ Załadowano ${userChannelsCache.size} kanałów użytkowników`);
    } catch (error) {
        console.error('❌ Błąd ładowania kanałów:', error);
    }
}

async function getOrCreateUserChannel(username) {
    if (!discordReady || !guild || !storageCategory) {
        throw new Error('Discord nie jest gotowy');
    }

    if (userChannelsCache.has(username)) {
        try {
            const channel = await guild.channels.fetch(userChannelsCache.get(username));
            if (channel) return channel;
        } catch (e) {
            userChannelsCache.delete(username);
        }
    }

    const safeName = username.toLowerCase().replace(/[^a-z0-9]/g, '-');
    const channelName = `user-${safeName}`;
    
    const existingChannel = guild.channels.cache.find(c => 
        c.name === channelName && c.parentId === STORAGE_CATEGORY_ID
    );
    
    if (existingChannel) {
        userChannelsCache.set(username, existingChannel.id);
        return existingChannel;
    }

    try {
        console.log(`➕ Tworzę kanał dla użytkownika: ${username}`);
        
        const newChannel = await guild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            parent: storageCategory.id,
            topic: `📁 Dane użytkownika: ${username}`,
            permissionOverwrites: [
                {
                    id: guild.id,
                    deny: [PermissionFlagsBits.ViewChannel]
                },
                {
                    id: discordClient.user.id,
                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.AttachFiles,
                        PermissionFlagsBits.ReadMessageHistory,
                        PermissionFlagsBits.ManageMessages
                    ]
                }
            ]
        });
        
        userChannelsCache.set(username, newChannel.id);
        
        const embed = new EmbedBuilder()
            .setTitle('📁 Nowy kanał użytkownika')
            .setDescription(`Utworzono kanał dla **${username}**`)
            .setColor(0x00d4ff)
            .setTimestamp();
        await notificationChannel.send({ embeds: [embed] });
        
        return newChannel;
    } catch (error) {
        console.error(`❌ Błąd tworzenia kanału dla ${username}:`, error);
        throw error;
    }
}

async function ensureUsersHaveChannels() {
    try {
        const generalChannel = storageCategory.children.cache.first();
        if (!generalChannel) return;
        
        const messages = await generalChannel.messages.fetch({ limit: 100 });
        const usersMsg = messages.find(m => 
            m.attachments.some(a => a.name === 'users.json')
        );
        
        if (!usersMsg) return;
        
        const attachment = usersMsg.attachments.find(a => a.name === 'users.json');
        const response = await fetch(attachment.url);
        const users = await response.json();
        
        for (const username of Object.keys(users)) {
            if (!userChannelsCache.has(username)) {
                await getOrCreateUserChannel(username);
            }
        }
    } catch (error) {
        console.log('ℹ️ Brak istniejących użytkowników lub kanał ogólny nie istnieje');
    }
}

// === ZAPIS/WCZYT ===

async function saveUserFile(username, filename, data, description = '') {
    const channel = await getOrCreateUserChannel(username);
    
    const jsonData = JSON.stringify(data, null, 2);
    const buffer = Buffer.from(jsonData, 'utf-8');
    const attachment = new AttachmentBuilder(buffer, { name: filename });
    
    const messages = await channel.messages.fetch({ limit: 100 });
    const oldMessages = messages.filter(m => 
        m.attachments.some(a => a.name === filename)
    );
    
    for (const msg of oldMessages.values()) {
        try {
            await msg.delete();
            console.log(`🗑️ [${username}] Usunięto starą wersję ${filename}`);
        } catch (e) {}
    }
    
    const newMsg = await channel.send({
        content: description || `📄 ${filename} | ${new Date().toISOString()}`,
        files: [attachment]
    });
    
    console.log(`✅ [${username}] Zapisano ${filename}`);
    return newMsg;
}

async function loadUserFile(username, filename, defaultData = {}) {
    try {
        const channel = await getOrCreateUserChannel(username);
        const messages = await channel.messages.fetch({ limit: 100 });
        
        const targetMsg = messages.find(m => 
            m.attachments.some(a => a.name === filename)
        );
        
        if (!targetMsg) {
            console.log(`⚠️ [${username}] Nie znaleziono ${filename}, używam domyślnych`);
            return defaultData;
        }
        
        const attachment = targetMsg.attachments.find(a => a.name === filename);
        const response = await fetch(attachment.url);
        const text = await response.text();
        return JSON.parse(text);
    } catch (error) {
        console.error(`❌ [${username}] Błąd wczytywania ${filename}:`, error);
        return defaultData;
    }
}

async function saveChatFile(user1, user2, chatData) {
    const chatId = `${user1}_do_${user2}`;
    const filename = `chat_${chatId}.json`;
    await saveUserFile(user1, filename, chatData, `💬 Czat z ${user2}`);
}

async function loadChatFile(user1, user2) {
    const chatId1 = `${user1}_do_${user2}`;
    const chatId2 = `${user2}_do_${user1}`;
    const filename1 = `chat_${chatId1}.json`;
    const filename2 = `chat_${chatId2}.json`;
    
    const data1 = await loadUserFile(user1, filename1, null);
    if (data1) return data1;
    
    const data2 = await loadUserFile(user2, filename2, null);
    if (data2) return data2;
    
    return null;
}

// === GLOBAL FILES (DISCORD STORAGE) ===

async function getGlobalChannel() {
    if (!storageCategory) throw new Error('Kategoria nie jest gotowa');
    
    let globalChannel = storageCategory.children.cache.find(c => c.name === 'global-data');
    
    if (!globalChannel) {
        console.log('➕ Tworzę kanał global-data...');
        globalChannel = await guild.channels.create({
            name: 'global-data',
            type: ChannelType.GuildText,
            parent: storageCategory.id,
            topic: '📁 Globalne pliki systemu'
        });
    }
    
    return globalChannel;
}

async function saveGlobalFile(filename, data, description = '') {
    const globalChannel = await getGlobalChannel();
    
    const jsonData = JSON.stringify(data, null, 2);
    const buffer = Buffer.from(jsonData, 'utf-8');
    const attachment = new AttachmentBuilder(buffer, { name: filename });
    
    // Usuń stare wiadomości z tym plikiem
    const messages = await globalChannel.messages.fetch({ limit: 100 });
    const oldMessages = messages.filter(m => 
        m.attachments.some(a => a.name === filename)
    );
    
    for (const msg of oldMessages.values()) {
        try { 
            await msg.delete();
            console.log(`🗑️ Usunięto starą wersję ${filename}`);
        } catch (e) {}
    }
    
    // Wyślij nową
    const newMsg = await globalChannel.send({
        content: description || `🌍 ${filename} | ${new Date().toISOString()}`,
        files: [attachment]
    });
    
    console.log(`🌍 Zapisano globalny plik: ${filename}`);
    return newMsg;
}

async function loadGlobalFile(filename, defaultData = {}) {
    try {
        const globalChannel = await getGlobalChannel();
        const messages = await globalChannel.messages.fetch({ limit: 100 });
        const targetMsg = messages.find(m => 
            m.attachments.some(a => a.name === filename)
        );
        
        if (!targetMsg) {
            console.log(`⚠️ Nie znaleziono ${filename} na Discordzie, używam domyślnych`);
            return defaultData;
        }
        
        const attachment = targetMsg.attachments.find(a => a.name === filename);
        const response = await fetch(attachment.url);
        const text = await response.text();
        return JSON.parse(text);
    } catch (error) {
        console.error(`❌ Błąd wczytywania ${filename}:`, error);
        return defaultData;
    }
}

// === GAMES MANAGEMENT ===

// Synchronizuj gry z Discorda do cache
async function syncGamesFromDiscord() {
    try {
        if (!discordReady) return;
        
        console.log('🔄 Synchronizuję gry z Discorda...');
        const games = await loadGlobalFile('games.json', {});
        gamesCache = games;
        lastGamesSync = Date.now();
        console.log(`✅ Załadowano ${Object.keys(games).length} gier`);
    } catch (error) {
        console.error('❌ Błąd synchronizacji gier:', error);
    }
}

// Zapisz grę (od razu do Discorda i aktualizuj cache)
async function saveGame(gameId, gameData) {
    // Aktualizuj cache
    gamesCache[gameId] = { ...gameData, id: gameId, updatedAt: new Date().toISOString() };
    
    // Zapisz do Discorda
    await saveGlobalFile('games.json', gamesCache, '🎮 Biblioteka gier');
    
    return gamesCache[gameId];
}

// Usuń grę
async function deleteGame(gameId) {
    if (gamesCache[gameId]) {
        delete gamesCache[gameId];
        await saveGlobalFile('games.json', gamesCache, '🎮 Biblioteka gier');
        return true;
    }
    return false;
}

// === ENDPOINTY ===

// Health check - dostępny zawsze
app.get('/health', (req, res) => {
    res.json({
        status: discordReady ? 'OK' : 'INITIALIZING',
        discord: discordReady,
        userChannels: userChannelsCache.size,
        gamesCount: Object.keys(gamesCache).length,
        version: '3.2.0-games-sync'
    });
});

// GRY - wymagają Discorda

// GET /games - lista wszystkich gier
app.get('/games', requireDiscord, async (req, res) => {
    try {
        // Zwróć gry z cache (synchronizowane z Discorda)
        const gamesList = Object.values(gamesCache).map(g => ({
            ...g,
            id: g.id || Object.keys(gamesCache).find(k => gamesCache[k] === g)
        }));
        
        res.json(gamesList);
    } catch (error) {
        console.error('Błąd pobierania gier:', error);
        res.status(500).json({ error: 'Nie można odczytać gier' });
    }
});

// GET /games/:id - pojedyncza gra
app.get('/games/:id', requireDiscord, async (req, res) => {
    try {
        const game = gamesCache[req.params.id];
        if (!game) {
            return res.status(404).json({ error: 'Gra nie istnieje' });
        }
        res.json({ ...game, id: req.params.id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST /api/games - dodaj nową grę lub zaktualizuj istniejącą
app.post('/api/games', requireDiscord, async (req, res) => {
    try {
        const { id, name, description, developer, price, icon, color, pegi, downloadUrl, version } = req.body;
        
        if (!name) {
            return res.status(400).json({ error: 'Nazwa gry jest wymagana' });
        }
        
        const gameId = id || crypto.randomUUID();
        
        const gameData = {
            name,
            description: description || '',
            developer: developer || 'Unknown',
            price: price || 0,
            icon: icon || '🎮',
            color: color || '#00d4ff',
            pegi: pegi || 12,
            downloadUrl: downloadUrl || '',
            version: version || '1.0.0',
            createdAt: gamesCache[gameId]?.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        
        const savedGame = await saveGame(gameId, gameData);
        
        // Powiadomienie na Discord
        const embed = new EmbedBuilder()
            .setTitle(gameData.price === 0 ? '🆓 Nowa darmowa gra!' : '💰 Nowa gra w sklepie!')
            .setDescription(`**${name}** została dodana do biblioteki`)
            .addFields(
                { name: 'Deweloper', value: gameData.developer, inline: true },
                { name: 'Cena', value: gameData.price === 0 ? 'DARMOWE' : `${gameData.price} zł`, inline: true },
                { name: 'PEGI', value: String(gameData.pegi), inline: true }
            )
            .setColor(parseInt(gameData.color.replace('#', ''), 16) || 0x00d4ff)
            .setTimestamp();
        
        await sendDiscordNotification(embed);
        
        res.json({ success: true, game: savedGame, id: gameId });
    } catch (error) {
        console.error('Błąd zapisywania gry:', error);
        res.status(500).json({ error: error.message });
    }
});

// PUT /api/games/:id - aktualizuj grę
app.put('/api/games/:id', requireDiscord, async (req, res) => {
    try {
        const gameId = req.params.id;
        
        if (!gamesCache[gameId]) {
            return res.status(404).json({ error: 'Gra nie istnieje' });
        }
        
        const updatedGame = {
            ...gamesCache[gameId],
            ...req.body,
            id: gameId,
            updatedAt: new Date().toISOString()
        };
        
        const savedGame = await saveGame(gameId, updatedGame);
        res.json({ success: true, game: savedGame });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// DELETE /api/games/:id - usuń grę
app.delete('/api/games/:id', requireDiscord, async (req, res) => {
    try {
        const success = await deleteGame(req.params.id);
        if (success) {
            res.json({ success: true, message: 'Gra usunięta' });
        } else {
            res.status(404).json({ error: 'Gra nie istnieje' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// === AUTH ===

// LOGIN
app.post('/api/auth/login', requireDiscord, async (req, res) => {
    try {
        const { username, password } = req.body;
        
        if (!username || !password) {
            return res.status(400).json({ error: 'Wymagana nazwa użytkownika i hasło' });
        }
        
        const users = await loadGlobalFile('users.json', {});
        const user = users[username];
        
        if (!user) {
            return res.status(401).json({ error: 'Nieprawidłowe dane logowania' });
        }
        
        const passwordHash = hashPassword(password);
        if (user.passwordHash !== passwordHash) {
            return res.status(401).json({ error: 'Nieprawidłowe dane logowania' });
        }
        
        // Generuj nowy token przy każdym logowaniu
        const token = generateToken();
        user.token = token;
        user.lastLogin = new Date().toISOString();
        
        await saveGlobalFile('users.json', users, '👥 Baza użytkowników');
        
        const embed = new EmbedBuilder()
            .setTitle('🔓 Logowanie')
            .setDescription(`**${username}** zalogował się`)
            .setColor(0x00d4ff)
            .setTimestamp();
        await sendDiscordNotification(embed);
        
        res.json({ 
            success: true, 
            token, 
            userId: user.id,
            user: {
                id: user.id,
                username: user.username,
                email: user.email
            }
        });
        
    } catch (error) {
        console.error('Błąd logowania:', error);
        res.status(500).json({ error: 'Błąd serwera' });
    }
});

// VERIFY
app.get('/api/auth/verify', requireDiscord, async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Brak tokena' });
        }
        
        const token = authHeader.substring(7);
        const users = await loadGlobalFile('users.json', {});
        
        const user = Object.values(users).find(u => u.token === token);
        
        if (!user) {
            return res.status(401).json({ error: 'Nieprawidłowy token' });
        }
        
        res.json({
            valid: true,
            userId: user.id,
            username: user.username,
            email: user.email
        });
        
    } catch (error) {
        console.error('Błąd weryfikacji:', error);
        res.status(500).json({ error: 'Błąd serwera' });
    }
});

// REGISTER
app.post('/api/auth/register', requireDiscord, async (req, res) => {
    try {
        const { username, password, email } = req.body;
        
        if (!username || !password) {
            return res.status(400).json({ error: 'Wymagana nazwa użytkownika i hasło' });
        }
        
        const users = await loadGlobalFile('users.json', {});
        
        if (users[username]) {
            return res.status(409).json({ error: 'Użytkownik już istnieje' });
        }
        
        const userId = crypto.randomUUID();
        const token = generateToken();
        
        users[username] = {
            id: userId,
            username,
            email: email || '',
            passwordHash: hashPassword(password),
            token,
            createdAt: new Date().toISOString(),
            lastLogin: null,
            library: [],
            settings: {}
        };
        
        await saveGlobalFile('users.json', users, '👥 Baza użytkowników');
        
        await getOrCreateUserChannel(username);
        await saveUserFile(username, 'friends.json', { friends: [], pending: [], blocked: [] }, '👥 Znajomi');
        await saveUserFile(username, 'library.json', { games: [] }, '📚 Biblioteka');
        
        const embed = new EmbedBuilder()
            .setTitle('👤 Nowy użytkownik')
            .setDescription(`**${username}** zarejestrował się`)
            .setColor(0x00ff88)
            .setTimestamp();
        await sendDiscordNotification(embed);
        
        res.json({ success: true, token, userId });
        
    } catch (error) {
        console.error('Błąd rejestracji:', error);
        res.status(500).json({ error: 'Błąd serwera' });
    }
});

// === ZNAJOMI ===

app.get('/api/friends/:username', requireDiscord, async (req, res) => {
    try {
        const { username } = req.params;
        const friendsData = await loadUserFile(username, 'friends.json', { friends: [], pending: [], blocked: [] });
        const users = await loadGlobalFile('users.json', {});
        
        const enriched = await Promise.all(
            friendsData.friends.map(async (friendName) => {
                const chat = await loadChatFile(username, friendName);
                return {
                    username: friendName,
                    status: 'online',
                    lastSeen: users[friendName]?.lastLogin || null,
                    unreadMessages: chat?.messages?.filter(m => m.sender === friendName && !m.read).length || 0
                };
            })
        );
        
        res.json({
            friends: enriched,
            pending: friendsData.pending || [],
            blocked: friendsData.blocked || []
        });
    } catch (error) {
        res.status(500).json({ error: 'Błąd pobierania znajomych' });
    }
});

app.post('/api/friends/add', requireDiscord, async (req, res) => {
    try {
        const { fromUser, toUser } = req.body;
        
        // Sprawdź czy użytkownik docelowy istnieje
        const users = await loadGlobalFile('users.json', {});
        if (!users[toUser]) {
            return res.status(404).json({ error: 'Użytkownik nie istnieje' });
        }
        
        const toUserData = await loadUserFile(toUser, 'friends.json', { friends: [], pending: [], blocked: [] });
        
        if (!toUserData.pending) toUserData.pending = [];
        
        if (!toUserData.pending.find(p => p.from === fromUser) && !toUserData.friends.includes(fromUser)) {
            toUserData.pending.push({ from: fromUser, sentAt: new Date().toISOString() });
            await saveUserFile(toUser, 'friends.json', toUserData, '👥 Znajomi');
        }
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/friends/respond', requireDiscord, async (req, res) => {
    try {
        const { username, fromUser, accept } = req.body;
        
        const userData = await loadUserFile(username, 'friends.json', { friends: [], pending: [], blocked: [] });
        const fromUserData = await loadUserFile(fromUser, 'friends.json', { friends: [], pending: [], blocked: [] });
        
        userData.pending = userData.pending.filter(p => p.from !== fromUser);
        
        if (accept) {
            userData.friends.push(fromUser);
            fromUserData.friends.push(username);
            
            await saveChatFile(username, fromUser, {
                participants: [username, fromUser],
                createdAt: new Date().toISOString(),
                messages: []
            });
        }
        
        await saveUserFile(username, 'friends.json', userData, '👥 Znajomi');
        await saveUserFile(fromUser, 'friends.json', fromUserData, '👥 Znajomi');
        
        res.json({ success: true, accepted: accept });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// === CZAT ===

app.get('/api/chat/:user1/:user2', requireDiscord, async (req, res) => {
    try {
        const { user1, user2 } = req.params;
        const chatData = await loadChatFile(user1, user2);
        
        if (!chatData) {
            return res.json({ messages: [], participants: [user1, user2] });
        }
        
        let modified = false;
        chatData.messages.forEach(msg => {
            if (msg.sender === user2 && !msg.read) {
                msg.read = true;
                modified = true;
            }
        });
        
        if (modified) {
            await saveChatFile(user1, user2, chatData);
        }
        
        res.json(chatData);
    } catch (error) {
        res.status(500).json({ error: 'Błąd pobierania czatu' });
    }
});

app.post('/api/chat/send', requireDiscord, async (req, res) => {
    try {
        const { fromUser, toUser, content } = req.body;
        
        let chatData = await loadChatFile(fromUser, toUser);
        
        if (!chatData) {
            chatData = {
                participants: [fromUser, toUser],
                createdAt: new Date().toISOString(),
                messages: []
            };
        }
        
        chatData.messages.push({
            id: crypto.randomUUID(),
            sender: fromUser,
            content: content.trim(),
            timestamp: new Date().toISOString(),
            read: false
        });
        
        if (chatData.messages.length > 500) {
            chatData.messages = chatData.messages.slice(-500);
        }
        
        await saveChatFile(fromUser, toUser, chatData);
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// === BIBLIOTEKA ===

app.get('/api/users/:username/library', requireDiscord, async (req, res) => {
    try {
        const libraryData = await loadUserFile(req.params.username, 'library.json', { games: [] });
        
        // Dodaj szczegóły gier z cache
        const enriched = libraryData.games.map(item => ({
            ...item,
            gameDetails: gamesCache[item.gameId] || null
        }));
        
        res.json(enriched);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/users/:username/library', requireDiscord, async (req, res) => {
    try {
        const { username } = req.params;
        const { gameId } = req.body;
        
        // Sprawdź czy gra istnieje
        if (!gamesCache[gameId]) {
            return res.status(404).json({ error: 'Gra nie istnieje' });
        }
        
        const libraryData = await loadUserFile(username, 'library.json', { games: [] });
        
        if (!libraryData.games.find(g => g.gameId === gameId)) {
            libraryData.games.push({
                gameId,
                addedAt: new Date().toISOString(),
                installed: false,
                installPath: null,
                playTime: 0,
                lastPlayed: null
            });
            
            await saveUserFile(username, 'library.json', libraryData, '📚 Biblioteka');
        }
        
        res.json({ success: true, library: libraryData.games });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// === START ===

async function startServer() {
    if (!DISCORD_TOKEN) {
        console.error('❌ Brak DISCORD_TOKEN!');
        process.exit(1);
    }
    
    console.log('🔌 Łączenie z Discordem...');
    await discordClient.login(DISCORD_TOKEN);
    
    app.listen(PORT, () => {
        console.log(`🚀 Serwer HTTP na http://localhost:${PORT}`);
        console.log(`📁 Per-user channels w kategorii: ${STORAGE_CATEGORY_ID}`);
    });
}

startServer().catch(err => {
    console.error('❌ Błąd startu:', err);
    process.exit(1);
});
