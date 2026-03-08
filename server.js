// server.js - POPRAWIONY
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');
const crypto = require('crypto');
const http = require('http');
const multer = require('multer');
const { Client, GatewayIntentBits, EmbedBuilder, AttachmentBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');

const app = express();

// Konfiguracja
const PORT = process.env.PORT || 3000;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

// Multi-guild support
const ALLOWED_GUILDS = process.env.ALLOWED_GUILDS 
    ? process.env.ALLOWED_GUILDS.split(',').map(id => id.trim())
    : [process.env.GUILD_ID || '1477574526933012541'];

const DEFAULT_GUILD_ID = ALLOWED_GUILDS[0];
const SCREENSHOTS_CHANNEL_ID = process.env.SCREENSHOTS_CHANNEL_ID || '1479939801385013288';
const ICONS_CHANNEL_ID = process.env.ICONS_CHANNEL_ID || '1479939801385013288';

// WAŻNE: URL do self-pingu
const SELF_PING_URL = process.env.SELF_PING_URL || `http://0.0.0.0:${PORT}/health`;
const PING_INTERVAL = 2 * 60 * 1000;

if (!DISCORD_TOKEN) {
    console.error('❌ Brak DISCORD_TOKEN! Ustaw w zmiennych środowiskowych.');
    process.exit(1);
}

// Middleware - CORS na początku!
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Konfiguracja multer dla uploadu plików
const storage = multer.memoryStorage();
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Nieprawidłowy format pliku. Dozwolone: JPG, PNG, GIF, WEBP'), false);
        }
    }
});

// Discord Client
const discordClient = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ],
    rest: { timeout: 60000, retries: 3, interval: 3500 },
    ws: { large_threshold: 250, compress: false }
});

let discordReady = false;
let isShuttingDown = false;
const userChannelsCache = new Map();
const gamesCache = new Map();
const pendingInvitesCache = new Map();
const screenshotsCache = new Map();
const iconsCache = new Map();

const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// === FUNKCJE MULTI-GUILD ===

function getGuildConfig(guildId) {
    const configs = {
        '1477574526933012541': {
            storageCategoryId: '1477579473611128843',
            notificationChannelId: '1477577363285082123',
            gamesChannelId: process.env.GAMES_CHANNEL_ID || null,
            screenshotsChannelId: SCREENSHOTS_CHANNEL_ID,
            iconsChannelId: ICONS_CHANNEL_ID
        }
    };
    return configs[guildId] || configs[DEFAULT_GUILD_ID];
}

async function getGuild(guildId) {
    if (!discordReady) throw new Error('Discord not ready');
    try {
        return await discordClient.guilds.fetch(guildId);
    } catch (error) {
        console.error(`❌ Nie można pobrać guild ${guildId}:`, error.message);
        return null;
    }
}

async function validateGuildAccess(guildId) {
    if (!ALLOWED_GUILDS.includes(guildId)) {
        throw new Error('Guild not authorized');
    }
    const guild = await getGuild(guildId);
    if (!guild) {
        throw new Error('Guild not found or bot not member');
    }
    return guild;
}

// === START SERWERA HTTP ===
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Serwer HTTP na porcie ${PORT}`);
    console.log(`📡 Dozwolone guildy: ${ALLOWED_GUILDS.join(', ')}`);
    startSelfPinger();
});

server.keepAliveTimeout = 120000;
server.headersTimeout = 120000;

// === SELF-PINGER ===
function startSelfPinger() {
    setInterval(async () => {
        if (isShuttingDown) return;
        try {
            const response = await fetch(SELF_PING_URL);
            const data = await response.json();
            console.log(`🔄 Self-ping OK | Status: ${data.status}`);
        } catch (error) {
            console.error('❌ Self-ping failed:', error.message);
        }
    }, PING_INTERVAL);
}

// === SERWOWANIE PLIKÓW STATYCZNYCH ===

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

app.get('/game.html', async (req, res) => {
    try {
        const gamePath = path.join(__dirname, 'game.html');
        const html = await fs.readFile(gamePath, 'utf-8');
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
    } catch (error) {
        res.status(500).send(`Błąd: ${error.message}`);
    }
});

app.get('/login.html', async (req, res) => {
    try {
        const loginPath = path.join(__dirname, 'login.html');
        const html = await fs.readFile(loginPath, 'utf-8');
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
    } catch (error) {
        res.status(500).send(`Błąd: ${error.message}`);
    }
});

app.get('/friends.html', async (req, res) => {
    try {
        const friendsPath = path.join(__dirname, 'friends.html');
        const html = await fs.readFile(friendsPath, 'utf-8');
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
    } catch (error) {
        res.status(500).send(`Błąd: ${error.message}`);
    }
});

app.get('/library.html', async (req, res) => {
    try {
        const libraryPath = path.join(__dirname, 'library.html');
        const html = await fs.readFile(libraryPath, 'utf-8');
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
    } catch (error) {
        res.status(500).send(`Błąd: ${error.message}`);
    }
});

// Strona główna
app.get('/', async (req, res) => {
    try {
        const indexPath = path.join(__dirname, 'index.html');
        const html = await fs.readFile(indexPath, 'utf-8');
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
    } catch (error) {
        res.json({ 
            message: 'Nebula Game Server',
            status: discordReady ? 'online' : 'initializing',
            discordReady: discordReady,
            endpoints: ['/games', '/api/auth/login', '/api/auth/register', '/api/auth/verify']
        });
    }
});

// === ENDPOINTY ===

app.get('/health', async (req, res) => {
    const username = req.query.username;
    const guildId = req.query.guildId || DEFAULT_GUILD_ID;
    
    const response = {
        status: discordReady ? 'OK' : 'INITIALIZING',
        discord: discordReady,
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        pid: process.pid,
        guildsReady: [],
        currentGuild: guildId
    };

    if (discordReady) {
        for (const gid of ALLOWED_GUILDS) {
            try {
                const guild = await getGuild(gid);
                if (guild) {
                    response.guildsReady.push({
                        id: gid,
                        name: guild.name,
                        memberCount: guild.memberCount
                    });
                }
            } catch (e) {
                console.error(`Błąd health check dla ${gid}:`, e.message);
            }
        }
    }

    if (username && discordReady) {
        try {
            const hasPending = await checkUserPendingInvites(username, guildId);
            response.hasPendingInvites = hasPending;
            response.pendingInvitesCount = await getPendingInvitesCount(username, guildId);
        } catch (error) {
            console.error(`Błąd sprawdzania zaproszeń:`, error);
        }
    }
    
    res.json(response);
});

// Middleware do wymagania Discorda (pomija auth)
function requireDiscordForWrite(req, res, next) {
    // Pomijamy dla endpointów auth
    if (req.path.includes('/api/auth/')) {
        return next();
    }
    if (!discordReady) {
        return res.status(503).json({ error: 'Discord not ready', retryAfter: 5 });
    }
    next();
}

app.use(requireDiscordForWrite);

// === UPLOAD PLIKÓW DO DISCORDA ===

// Upload ikony gry
app.post('/api/upload/icon', upload.single('icon'), async (req, res) => {
    try {
        const guildId = req.query.guildId || DEFAULT_GUILD_ID;
        const guild = await getGuild(guildId);
        const config = getGuildConfig(guildId);
        
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const iconsChannel = await guild.channels.fetch(config.iconsChannelId || SCREENSHOTS_CHANNEL_ID);
        
        const attachment = new AttachmentBuilder(req.file.buffer, { 
            name: `icon_${Date.now()}_${req.file.originalname}` 
        });
        
        const message = await iconsChannel.send({
            content: `🎮 Icon upload | ${req.file.mimetype} | ${(req.file.size / 1024).toFixed(1)}KB`,
            files: [attachment]
        });

        const url = message.attachments.first().url;
        const iconId = crypto.randomUUID();
        
        iconsCache.set(iconId, {
            url: url,
            filename: req.file.originalname,
            uploadedAt: new Date().toISOString()
        });

        res.json({ 
            success: true, 
            url: url,
            iconId: iconId,
            message: 'Icon uploaded successfully'
        });

    } catch (error) {
        console.error('❌ Icon upload error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Upload screenshotów
app.post('/api/upload/screenshot', upload.single('screenshot'), async (req, res) => {
    try {
        const guildId = req.query.guildId || DEFAULT_GUILD_ID;
        const gameId = req.query.gameId;
        
        const guild = await getGuild(guildId);
        
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const screenshotsChannel = await guild.channels.fetch(SCREENSHOTS_CHANNEL_ID);
        
        const attachment = new AttachmentBuilder(req.file.buffer, { 
            name: `screenshot_${gameId || 'general'}_${Date.now()}_${req.file.originalname}` 
        });
        
        const message = await screenshotsChannel.send({
            content: `📸 Screenshot | Gra: ${gameId || 'unknown'} | ${req.file.mimetype}`,
            files: [attachment]
        });

        const url = message.attachments.first().url;
        const screenshotId = crypto.randomUUID();
        
        const screenshotData = {
            id: screenshotId,
            url: url,
            gameId: gameId || null,
            filename: req.file.originalname,
            uploadedAt: new Date().toISOString(),
            uploadedBy: req.headers['x-username'] || 'unknown'
        };

        screenshotsCache.set(screenshotId, screenshotData);
        await saveScreenshotsIndex(guildId);

        res.json({ 
            success: true, 
            url: url,
            screenshotId: screenshotId,
            message: 'Screenshot uploaded successfully'
        });

    } catch (error) {
        console.error('❌ Screenshot upload error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Upload wielu screenshotów naraz
app.post('/api/upload/screenshots', upload.array('screenshots', 10), async (req, res) => {
    try {
        const guildId = req.query.guildId || DEFAULT_GUILD_ID;
        const gameId = req.query.gameId;
        
        const guild = await getGuild(guildId);
        const screenshotsChannel = await guild.channels.fetch(SCREENSHOTS_CHANNEL_ID);
        
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: 'No files uploaded' });
        }

        const uploadedUrls = [];

        for (const file of req.files) {
            const attachment = new AttachmentBuilder(file.buffer, { 
                name: `screenshot_${gameId || 'general'}_${Date.now()}_${file.originalname}` 
            });
            
            const message = await screenshotsChannel.send({
                content: `📸 Screenshot | Gra: ${gameId || 'unknown'} | ${file.mimetype}`,
                files: [attachment]
            });

            const url = message.attachments.first().url;
            const screenshotId = crypto.randomUUID();
            
            screenshotsCache.set(screenshotId, {
                id: screenshotId,
                url: url,
                gameId: gameId || null,
                filename: file.originalname,
                uploadedAt: new Date().toISOString()
            });

            uploadedUrls.push({ url, screenshotId });
        }

        await saveScreenshotsIndex(guildId);

        res.json({ 
            success: true, 
            urls: uploadedUrls,
            count: uploadedUrls.length,
            message: `${uploadedUrls.length} screenshots uploaded successfully`
        });

    } catch (error) {
        console.error('❌ Screenshots upload error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Pobierz wszystkie screenshoty dla gry
app.get('/api/screenshots/:gameId', async (req, res) => {
    try {
        const gameId = req.params.gameId;
        const guildId = req.query.guildId || DEFAULT_GUILD_ID;
        
        await loadScreenshotsIndex(guildId);
        
        const gameScreenshots = Array.from(screenshotsCache.values())
            .filter(s => s.gameId === gameId)
            .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));

        res.json({
            success: true,
            gameId: gameId,
            screenshots: gameScreenshots,
            total: gameScreenshots.length
        });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// === KOMENTARZE I OCENY ===

// Pobierz komentarze dla gry
app.get('/api/games/:gameId/comments', async (req, res) => {
    try {
        const guildId = req.query.guildId || DEFAULT_GUILD_ID;
        const gameId = req.params.gameId;
        
        const comments = await loadGameComments(gameId, guildId);
        
        res.json({
            success: true,
            gameId: gameId,
            comments: comments,
            total: comments.length
        });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Dodaj komentarz
app.post('/api/games/:gameId/comments', async (req, res) => {
    try {
        const guildId = req.query.guildId || DEFAULT_GUILD_ID;
        const gameId = req.params.gameId;
        const { username, content, rating } = req.body;
        
        if (!username || !content) {
            return res.status(400).json({ error: 'Username and content required' });
        }

        // Weryfikacja użytkownika
        const users = await loadGlobalFile('users.json', {}, guildId);
        const user = users[username];
        const authHeader = req.headers.authorization;
        if (!user || !authHeader || !authHeader.startsWith('Bearer ') || user.token !== authHeader.substring(7)) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const comment = {
            id: crypto.randomUUID(),
            username: username,
            content: content.trim(),
            rating: rating || null,
            createdAt: new Date().toISOString(),
            likes: 0,
            dislikes: 0
        };

        let comments = await loadGameComments(gameId, guildId);
        comments.unshift(comment);
        
        await saveGameComments(gameId, comments, guildId);

        // Powiadomienie
        const games = gamesCache.get(guildId) || [];
        const game = games.find(g => g.id === gameId);
        if (game) {
            const embed = new EmbedBuilder()
                .setTitle('💬 Nowy komentarz')
                .setDescription(`**${username}** skomentował **${game.name}**`)
                .addFields({ name: 'Komentarz', value: content.substring(0, 100) + (content.length > 100 ? '...' : '') })
                .setColor(0x00d4ff)
                .setTimestamp();
            
            const config = getGuildConfig(guildId);
            const guild = await getGuild(guildId);
            const notifChannel = await guild.channels.fetch(config.notificationChannelId);
            await notifChannel.send({ embeds: [embed] });
        }

        res.json({
            success: true,
            comment: comment,
            message: 'Comment added successfully'
        });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Usuń komentarz
app.delete('/api/games/:gameId/comments/:commentId', async (req, res) => {
    try {
        const guildId = req.query.guildId || DEFAULT_GUILD_ID;
        const { gameId, commentId } = req.params;
        const { username } = req.body;
        
        const users = await loadGlobalFile('users.json', {}, guildId);
        const user = users[username];
        const authHeader = req.headers.authorization;
        if (!user || !authHeader || !authHeader.startsWith('Bearer ') || user.token !== authHeader.substring(7)) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        let comments = await loadGameComments(gameId, guildId);
        const comment = comments.find(c => c.id === commentId);
        
        if (!comment) {
            return res.status(404).json({ error: 'Comment not found' });
        }
        
        if (comment.username !== username) {
            return res.status(403).json({ error: 'Can only delete your own comments' });
        }

        comments = comments.filter(c => c.id !== commentId);
        await saveGameComments(gameId, comments, guildId);

        res.json({
            success: true,
            message: 'Comment deleted successfully'
        });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Ocena gry
app.post('/api/games/:gameId/rate', async (req, res) => {
    try {
        const guildId = req.query.guildId || DEFAULT_GUILD_ID;
        const gameId = req.params.gameId;
        const { username, rating } = req.body;
        
        if (!rating || rating < 1 || rating > 5) {
            return res.status(400).json({ error: 'Rating must be 1-5' });
        }

        const users = await loadGlobalFile('users.json', {}, guildId);
        const user = users[username];
        const authHeader = req.headers.authorization;
        if (!user || !authHeader || !authHeader.startsWith('Bearer ') || user.token !== authHeader.substring(7)) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const ratings = await loadGameRatings(gameId, guildId);
        ratings[username] = {
            rating: rating,
            ratedAt: new Date().toISOString()
        };
        
        await saveGameRatings(gameId, ratings, guildId);

        const allRatings = Object.values(ratings).map(r => r.rating);
        const average = allRatings.reduce((a, b) => a + b, 0) / allRatings.length;

        res.json({
            success: true,
            yourRating: rating,
            averageRating: Math.round(average * 10) / 10,
            totalRatings: allRatings.length,
            message: 'Rating saved'
        });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Pobierz oceny gry
app.get('/api/games/:gameId/ratings', async (req, res) => {
    try {
        const guildId = req.query.guildId || DEFAULT_GUILD_ID;
        const gameId = req.params.gameId;
        
        const ratings = await loadGameRatings(gameId, guildId);
        const allRatings = Object.values(ratings).map(r => r.rating);
        
        const average = allRatings.length > 0 
            ? allRatings.reduce((a, b) => a + b, 0) / allRatings.length 
            : 0;

        const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
        allRatings.forEach(r => distribution[r] = (distribution[r] || 0) + 1);

        res.json({
            success: true,
            gameId: gameId,
            averageRating: Math.round(average * 10) / 10,
            totalRatings: allRatings.length,
            distribution: distribution,
            yourRating: req.query.username ? ratings[req.query.username]?.rating : null
        });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// === FUNKCJE POMOCNICZE ===

async function saveScreenshotsIndex(guildId) {
    try {
        const screenshotsData = Array.from(screenshotsCache.values());
        await saveGlobalFile('screenshots.json', screenshotsData, '📸 Screenshots Index', guildId);
    } catch (error) {
        console.error('❌ Błąd zapisu screenshots:', error);
    }
}

async function loadScreenshotsIndex(guildId) {
    try {
        const data = await loadGlobalFile('screenshots.json', [], guildId);
        screenshotsCache.clear();
        data.forEach(s => screenshotsCache.set(s.id, s));
        return data;
    } catch (error) {
        return [];
    }
}

async function loadGameComments(gameId, guildId) {
    try {
        const allComments = await loadGlobalFile('comments.json', {}, guildId);
        return allComments[gameId] || [];
    } catch {
        return [];
    }
}

async function saveGameComments(gameId, comments, guildId) {
    const allComments = await loadGlobalFile('comments.json', {}, guildId);
    allComments[gameId] = comments;
    await saveGlobalFile('comments.json', allComments, '💬 Comments', guildId);
}

async function loadGameRatings(gameId, guildId) {
    try {
        const allRatings = await loadGlobalFile('ratings.json', {}, guildId);
        return allRatings[gameId] || {};
    } catch {
        return {};
    }
}

async function saveGameRatings(gameId, ratings, guildId) {
    const allRatings = await loadGlobalFile('ratings.json', {}, guildId);
    allRatings[gameId] = ratings;
    await saveGlobalFile('ratings.json', allRatings, '⭐ Ratings', guildId);
}

async function checkUserPendingInvites(username, guildId = DEFAULT_GUILD_ID) {
    try {
        const data = await loadUserFile(username, 'friends.json', { friends: [], pending: [] }, guildId);
        const pending = data.pendingInvites || data.pending || [];
        return pending.length > 0;
    } catch {
        return false;
    }
}

async function getPendingInvitesCount(username, guildId = DEFAULT_GUILD_ID) {
    try {
        const data = await loadUserFile(username, 'friends.json', { friends: [], pending: [] }, guildId);
        const pending = data.pendingInvites || data.pending || [];
        return pending.length;
    } catch {
        return 0;
    }
}

async function updatePendingInvitesCache(username, guildId = DEFAULT_GUILD_ID) {
    try {
        const data = await loadUserFile(username, 'friends.json', { friends: [], pending: [] }, guildId);
        const pending = data.pendingInvites || data.pending || [];
        const cacheKey = `${guildId}:${username}`;
        
        if (pending.length > 0) {
            pendingInvitesCache.set(cacheKey, pending.length);
        } else {
            pendingInvitesCache.delete(cacheKey);
        }
    } catch (error) {
        console.error(`Błąd cache:`, error);
    }
}

// === INICJALIZACJA DISCORDA ===
async function initDiscord() {
    try {
        console.log('🔌 Łączenie z Discordem...');
        
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
                for (const guildId of ALLOWED_GUILDS) {
                    console.log(`📁 Inicjalizacja guild: ${guildId}`);
                    await initGuild(guildId);
                }
                
                discordReady = true;
                console.log('✅ Discord ready! Wszystkie guildy zainicjalizowane.');
                
                setInterval(() => {
                    const ping = discordClient.ws.ping;
                    console.log(`💓 Ping: ${ping}ms | Ready: ${discordReady}`);
                }, 30000);
                
                setInterval(periodicPendingCheck, 30000);
                
                setInterval(() => {
                    for (const guildId of ALLOWED_GUILDS) {
                        syncGamesFromDiscord(guildId);
                    }
                }, 300000);
                
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

async function initGuild(guildId) {
    try {
        const guild = await getGuild(guildId);
        if (!guild) {
            console.error(`❌ Guild ${guildId} nie dostępny`);
            return;
        }

        const config = getGuildConfig(guildId);
        
        if (!userChannelsCache.has(guildId)) {
            userChannelsCache.set(guildId, new Map());
        }
        
        const storageCategory = await guild.channels.fetch(config.storageCategoryId);
        const notificationChannel = await guild.channels.fetch(config.notificationChannelId);
        
        console.log(`✅ Guild ${guild.name}: storage=${storageCategory?.name}, notif=${notificationChannel?.name}`);
        
        await initGamesChannel(guildId);
        await loadExistingUserChannels(guildId);
        await syncGamesFromDiscord(guildId);
        await loadScreenshotsIndex(guildId);
        
    } catch (error) {
        console.error(`❌ Błąd init guild ${guildId}:`, error.message);
    }
}

async function periodicPendingCheck() {
    if (!discordReady) return;
    for (const [cacheKey] of pendingInvitesCache) {
        const [guildId, username] = cacheKey.split(':');
        await updatePendingInvitesCache(username, guildId);
    }
}

async function initGamesChannel(guildId) {
    try {
        const guild = await getGuild(guildId);
        if (!guild) return;
        
        const config = getGuildConfig(guildId);
        let gamesChannel = null;

        if (config.gamesChannelId) {
            try {
                gamesChannel = await guild.channels.fetch(config.gamesChannelId);
            } catch (e) {
                console.log(`⚠️ Tworzenie nowego kanału gier dla ${guildId}...`);
            }
        }

        if (!gamesChannel) {
            const existing = guild.channels.cache.find(c => 
                c.name === 'games-json' && c.parentId === config.storageCategoryId
            );

            if (existing) {
                gamesChannel = existing;
                config.gamesChannelId = existing.id;
            } else {
                const storageCategory = await guild.channels.fetch(config.storageCategoryId);
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
                config.gamesChannelId = gamesChannel.id;
                console.log(`✅ Utworzono games-json w ${guild.name}`);
            }
        }
    } catch (error) {
        console.error(`❌ Błąd games channel ${guildId}:`, error.message);
    }
}

async function uploadGamesJsonToDiscord(guildId) {
    if (!discordReady) return false;
    
    try {
        const guild = await getGuild(guildId);
        if (!guild) return false;
        
        const config = getGuildConfig(guildId);
        const gamesChannel = await guild.channels.fetch(config.gamesChannelId);
        if (!gamesChannel) return false;

        const games = gamesCache.get(guildId) || [];
        const gamesData = {
            guildId: guildId,
            guildName: guild.name,
            updatedAt: new Date().toISOString(),
            totalGames: games.length,
            games: games
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
            content: `🎮 Games.json | ${games.length} gier | <t:${Math.floor(Date.now()/1000)}:F>`,
            files: [attachment]
        });

        console.log(`📤 Wysłano games.json dla ${guild.name} (${games.length} gier)`);
        return true;
    } catch (error) {
        console.error(`❌ Błąd upload ${guildId}:`, error.message);
        return false;
    }
}

// === FUNKCJE POMOCNICZE ===
function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

async function sendDiscordNotification(embed, guildId = DEFAULT_GUILD_ID) {
    if (!discordReady) return;
    try {
        const guild = await getGuild(guildId);
        if (!guild) return;
        
        const config = getGuildConfig(guildId);
        const notificationChannel = await guild.channels.fetch(config.notificationChannelId);
        if (!notificationChannel) return;
        
        await notificationChannel.send({ embeds: [embed] });
    } catch (error) {
        console.error('❌ Notification error:', error);
    }
}

async function loadExistingUserChannels(guildId) {
    try {
        const guild = await getGuild(guildId);
        if (!guild) return;
        
        const config = getGuildConfig(guildId);
        const channels = await guild.channels.fetch();
        const userChannels = channels.filter(c => 
            c.parentId === config.storageCategoryId && c.name.startsWith('user-')
        );
        
        const guildCache = userChannelsCache.get(guildId) || new Map();
        
        for (const [id, channel] of userChannels) {
            const username = channel.name.replace('user-', '').replace(/-/g, '_');
            guildCache.set(username, id);
        }
        
        userChannelsCache.set(guildId, guildCache);
        console.log(`📁 ${guild.name}: ${guildCache.size} kanałów użytkowników`);
    } catch (error) {
        console.error(`❌ Błąd ładowania kanałów ${guildId}:`, error.message);
    }
}

async function getOrCreateUserChannel(username, guildId = DEFAULT_GUILD_ID) {
    if (!discordReady) throw new Error('Discord not ready');

    const guildCache = userChannelsCache.get(guildId) || new Map();
    
    if (guildCache.has(username)) {
        try {
            const guild = await getGuild(guildId);
            const ch = await guild.channels.fetch(guildCache.get(username));
            if (ch) return ch;
        } catch {
            guildCache.delete(username);
        }
    }

    const guild = await getGuild(guildId);
    const config = getGuildConfig(guildId);
    const storageCategory = await guild.channels.fetch(config.storageCategoryId);
    
    const safeName = username.toLowerCase().replace(/[^a-z0-9]/g, '-');
    const channelName = `user-${safeName}`;
    
    const existing = guild.channels.cache.find(c => 
        c.name === channelName && c.parentId === config.storageCategoryId
    );
    
    if (existing) {
        guildCache.set(username, existing.id);
        userChannelsCache.set(guildId, guildCache);
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
    
    guildCache.set(username, newChannel.id);
    userChannelsCache.set(guildId, guildCache);
    return newChannel;
}

async function saveUserFile(username, filename, data, description = '', guildId = DEFAULT_GUILD_ID) {
    const channel = await getOrCreateUserChannel(username, guildId);
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

async function loadUserFile(username, filename, defaultData = {}, guildId = DEFAULT_GUILD_ID) {
    try {
        const channel = await getOrCreateUserChannel(username, guildId);
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

async function getGlobalChannel(guildId = DEFAULT_GUILD_ID) {
    const guild = await getGuild(guildId);
    const config = getGuildConfig(guildId);
    const storageCategory = await guild.channels.fetch(config.storageCategoryId);
    
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

async function saveGlobalFile(filename, data, description = '', guildId = DEFAULT_GUILD_ID) {
    const channel = await getGlobalChannel(guildId);
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

async function loadGlobalFile(filename, defaultData = {}, guildId = DEFAULT_GUILD_ID) {
    try {
        const channel = await getGlobalChannel(guildId);
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

async function loadChatFile(user1, user2, guildId = DEFAULT_GUILD_ID) {
    try {
        const guild = await getGuild(guildId);
        const config = getGuildConfig(guildId);
        const channelName = await getChatChannelName(user1, user2);
        const channel = guild.channels.cache.find(c => 
            c.name === channelName && c.parentId === config.storageCategoryId
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

async function saveChatFile(user1, user2, data, guildId = DEFAULT_GUILD_ID) {
    const guild = await getGuild(guildId);
    const config = getGuildConfig(guildId);
    const storageCategory = await guild.channels.fetch(config.storageCategoryId);
    const channelName = await getChatChannelName(user1, user2);
    
    let channel = guild.channels.cache.find(c => 
        c.name === channelName && c.parentId === config.storageCategoryId
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

async function syncGamesFromDiscord(guildId = DEFAULT_GUILD_ID) {
    if (!discordReady) return;
    try {
        const loaded = await loadGlobalFile('games.json', [], guildId);
        
        let games = [];
        if (Array.isArray(loaded)) {
            games = loaded;
        } else if (loaded && loaded.games && Array.isArray(loaded.games)) {
            games = loaded.games;
        } else if (loaded && typeof loaded === 'object') {
            games = Object.values(loaded);
        }
        
        gamesCache.set(guildId, games);
        console.log(`🎮 ${guildId}: Załadowano ${games.length} gier`);
    } catch (error) {
        console.error(`❌ Błąd sync ${guildId}:`, error.message);
        gamesCache.set(guildId, []);
    }
}

async function saveGame(gameId, gameData, guildId = DEFAULT_GUILD_ID) {
    let games = gamesCache.get(guildId) || [];
    
    const existingIndex = games.findIndex(g => g.id === gameId);
    const gameWithId = { 
        ...gameData, 
        id: gameId, 
        updatedAt: new Date().toISOString() 
    };
    
    if (existingIndex >= 0) {
        games[existingIndex] = gameWithId;
    } else {
        games.push(gameWithId);
    }
    
    gamesCache.set(guildId, games);
    await saveGlobalFile('games.json', games, '🎮 Games', guildId);
    await uploadGamesJsonToDiscord(guildId);
    
    return gameWithId;
}

async function deleteGame(gameId, guildId = DEFAULT_GUILD_ID) {
    let games = gamesCache.get(guildId) || [];
    const initialLength = games.length;
    
    games = games.filter(g => g.id !== gameId);
    
    if (games.length < initialLength) {
        gamesCache.set(guildId, games);
        await saveGlobalFile('games.json', games, '🎮 Games', guildId);
        await uploadGamesJsonToDiscord(guildId);
        return true;
    }
    return false;
}

// === ENDPOINTY GIER ===

app.get('/games', async (req, res) => {
    const guildId = req.query.guildId || DEFAULT_GUILD_ID;
    
    try {
        await validateGuildAccess(guildId);
        
        if (discordReady) {
            const cached = gamesCache.get(guildId);
            if (!cached || cached.length === 0) {
                await syncGamesFromDiscord(guildId);
            }
        }
        
        const games = gamesCache.get(guildId) || [];
        res.json(games);
    } catch (error) {
        res.status(403).json({ error: error.message });
    }
});

app.get('/games/:id', async (req, res) => {
    const guildId = req.query.guildId || DEFAULT_GUILD_ID;
    
    try {
        await validateGuildAccess(guildId);
        const games = gamesCache.get(guildId) || [];
        const game = games.find(g => g.id === req.params.id);
        
        if (!game) return res.status(404).json({ error: 'Game not found' });
        res.json(game);
    } catch (error) {
        res.status(403).json({ error: error.message });
    }
});

app.post('/api/games', async (req, res) => {
    try {
        const guildId = req.query.guildId || DEFAULT_GUILD_ID;
        await validateGuildAccess(guildId);
        
        const { 
            name, description, developer, price, icon, iconUrl, color, 
            pegi, download_url, size, requirements, screenshots, genre, 
            releaseDate, rating, publisher, version, language 
        } = req.body;
        
        if (!name) return res.status(400).json({ error: 'Name required' });
        
        const gameId = crypto.randomUUID();
        const gameData = {
            name, 
            description: description || '', 
            developer: developer || 'Unknown',
            price: price || 0, 
            icon: icon || '🎮', 
            iconUrl: iconUrl || null,
            color: color || '#00d4ff',
            pegi: pegi || 12, 
            download_url: download_url || null, 
            size: size || null,
            requirements: requirements || { min: {}, rec: {} },
            screenshots: screenshots || [],
            genre: genre || 'Nieznany',
            releaseDate: releaseDate || new Date().toISOString().split('T')[0],
            rating: rating || 'Brak oceny',
            publisher: publisher || developer || 'Unknown',
            version: version || '1.0',
            language: language || 'Polski/Angielski',
            createdAt: new Date().toISOString()
        };
        
        const saved = await saveGame(gameId, gameData, guildId);
        
        const embed = new EmbedBuilder()
            .setTitle(price === 0 ? '🆓 Nowa darmowa gra!' : '💰 Nowa gra!')
            .setDescription(`**${name}**`)
            .addFields(
                { name: 'Dev', value: gameData.developer, inline: true },
                { name: 'Cena', value: price === 0 ? 'DARMOWE' : `${price}zł`, inline: true },
                { name: 'Gatunek', value: gameData.genre, inline: true }
            )
            .setColor(parseInt(gameData.color.replace('#', ''), 16))
            .setTimestamp();
        
        await sendDiscordNotification(embed, guildId);
        res.json({ success: true, game: saved });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/games/:id', async (req, res) => {
    try {
        const guildId = req.query.guildId || DEFAULT_GUILD_ID;
        await validateGuildAccess(guildId);
        
        const games = gamesCache.get(guildId) || [];
        const existing = games.find(g => g.id === req.params.id);
        
        if (!existing) return res.status(404).json({ error: 'Game not found' });
        
        const updated = await saveGame(req.params.id, { ...existing, ...req.body }, guildId);
        res.json({ success: true, game: updated });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/games/:id', async (req, res) => {
    try {
        const guildId = req.query.guildId || DEFAULT_GUILD_ID;
        await validateGuildAccess(guildId);
        
        const success = await deleteGame(req.params.id, guildId);
        res.json({ success, message: success ? 'Deleted' : 'Not found' });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// === AUTH - BEZ WYMAGANIA DISCORDA ===

app.post('/api/auth/register', async (req, res) => {
    try {
        const guildId = req.query.guildId || DEFAULT_GUILD_ID;
        
        // Sprawdź czy Discord jest gotowy, ale nie wymagaj dla rejestracji
        // Jeśli nie jest gotowy, używamy domyślnej konfiguracji
        let guildConfig = getGuildConfig(guildId);
        
        const { username, password, email } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
        
        // Wczytaj lub utwórz lokalny cache użytkowników jeśli Discord nie jest gotowy
        let users = {};
        if (discordReady) {
            users = await loadGlobalFile('users.json', {}, guildId);
        } else {
            // Tymczasowe przechowywanie w pamięci
            users = global.tempUsers || {};
            global.tempUsers = users;
        }
        
        if (users[username]) return res.status(409).json({ error: 'User exists' });
        
        const token = generateToken();
        users[username] = {
            id: crypto.randomUUID(), 
            username, 
            email: email || '',
            passwordHash: hashPassword(password), 
            token,
            guildId: guildId,
            createdAt: new Date().toISOString()
        };
        
        if (discordReady) {
            await saveGlobalFile('users.json', users, '👥 Users', guildId);
            await getOrCreateUserChannel(username, guildId);
            await saveUserFile(username, 'library.json', { games: [] }, '📚 Library', guildId);
            await saveUserFile(username, 'friends.json', { friends: [], pending: [] }, '👥 Friends', guildId);
            
            const embed = new EmbedBuilder()
                .setTitle('👤 Nowy użytkownik')
                .setDescription(`**${username}** dołączył do ${guildId}!`)
                .setColor(0x00ff88);
            
            await sendDiscordNotification(embed, guildId);
        } else {
            global.tempUsers = users;
        }
        
        res.json({ success: true, token, userId: users[username].id });
        
    } catch (error) {
        console.error('Register error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const guildId = req.query.guildId || DEFAULT_GUILD_ID;
        
        const { username, password } = req.body;
        
        let users = {};
        if (discordReady) {
            users = await loadGlobalFile('users.json', {}, guildId);
        } else {
            users = global.tempUsers || {};
        }
        
        const user = users[username];
        
        if (!user || user.passwordHash !== hashPassword(password)) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const token = generateToken();
        user.token = token;
        user.lastLogin = new Date().toISOString();
        
        if (discordReady) {
            await saveGlobalFile('users.json', users, '👥 Users', guildId);
        } else {
            global.tempUsers = users;
        }
        
        const hasPending = discordReady ? await checkUserPendingInvites(username, guildId) : false;
        
        res.json({ 
            success: true, 
            token, 
            user: { 
                id: user.id, 
                username: user.username, 
                email: user.email, 
                hasPendingInvites: hasPending,
                guildId: guildId
            }
        });
        
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/auth/verify', async (req, res) => {
    const guildId = req.query.guildId || DEFAULT_GUILD_ID;
    
    try {
        const auth = req.headers.authorization;
        if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
        
        const token = auth.substring(7);
        
        let users = {};
        if (discordReady) {
            users = await loadGlobalFile('users.json', {}, guildId);
        } else {
            users = global.tempUsers || {};
        }
        
        const user = Object.values(users).find(u => u.token === token);
        
        if (!user) return res.status(401).json({ error: 'Invalid token' });
        
        const hasPending = discordReady ? await checkUserPendingInvites(user.username, guildId) : false;
        
        res.json({ 
            valid: true, 
            userId: user.id, 
            username: user.username, 
            hasPendingInvites: hasPending,
            guildId: guildId
        });
        
    } catch (error) {
        res.status(403).json({ error: error.message });
    }
});

// === FRIENDS ===

app.get('/api/friends/:username', async (req, res) => {
    try {
        const guildId = req.query.guildId || DEFAULT_GUILD_ID;
        
        if (!discordReady) {
            return res.json({ friends: [], pendingInvites: [] });
        }
        
        await validateGuildAccess(guildId);
        
        const data = await loadUserFile(req.params.username, 'friends.json', { friends: [], pending: [] }, guildId);
        const users = await loadGlobalFile('users.json', {}, guildId);
        
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
        
        if (pendingInvites.length > 0) {
            pendingInvitesCache.set(`${guildId}:${req.params.username}`, pendingInvites.length);
        }
        
        res.json({ friends, pendingInvites });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/friends/add', async (req, res) => {
    try {
        const guildId = req.query.guildId || DEFAULT_GUILD_ID;
        
        if (!discordReady) {
            return res.status(503).json({ error: 'Discord not ready' });
        }
        
        await validateGuildAccess(guildId);
        
        const { fromUser, toUser } = req.body;
        const users = await loadGlobalFile('users.json', {}, guildId);
        
        if (!users[toUser]) return res.status(404).json({ error: 'User not found' });
        
        const toData = await loadUserFile(toUser, 'friends.json', { friends: [], pending: [] }, guildId);
        
        if (toData.pending && !toData.pendingInvites) {
            toData.pendingInvites = toData.pending.map(p => ({
                from: p.from, 
                timestamp: p.at || new Date().toISOString()
            }));
            delete toData.pending;
        }
        
        if (!toData.pendingInvites) toData.pendingInvites = [];
        
        const alreadyPending = toData.pendingInvites.find(p => p.from === fromUser);
        const alreadyFriends = (toData.friends || []).includes(fromUser);
        
        if (!alreadyPending && !alreadyFriends) {
            toData.pendingInvites.push({ 
                from: fromUser, 
                timestamp: new Date().toISOString() 
            });
            await saveUserFile(toUser, 'friends.json', toData, '👥 Friends', guildId);
            pendingInvitesCache.set(`${guildId}:${toUser}`, toData.pendingInvites.length);
        }
        
        res.json({ success: true });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/friends/respond', async (req, res) => {
    try {
        const guildId = req.query.guildId || DEFAULT_GUILD_ID;
        
        if (!discordReady) {
            return res.status(503).json({ error: 'Discord not ready' });
        }
        
        await validateGuildAccess(guildId);
        
        const { username, fromUser, accept } = req.body;
        
        const userData = await loadUserFile(username, 'friends.json', { friends: [], pending: [] }, guildId);
        const fromData = await loadUserFile(fromUser, 'friends.json', { friends: [], pending: [] }, guildId);
        
        if (userData.pending && !userData.pendingInvites) {
            userData.pendingInvites = userData.pending.map(p => ({
                from: p.from, 
                timestamp: p.at || new Date().toISOString()
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
                participants: [username, fromUser], 
                messages: []
            }, guildId);
        }
        
        await saveUserFile(username, 'friends.json', userData, '👥 Friends', guildId);
        await saveUserFile(fromUser, 'friends.json', fromData, '👥 Friends', guildId);
        await updatePendingInvitesCache(username, guildId);
        
        res.json({ success: true, accepted: accept });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/friends/remove', async (req, res) => {
    try {
        const guildId = req.query.guildId || DEFAULT_GUILD_ID;
        
        if (!discordReady) {
            return res.status(503).json({ error: 'Discord not ready' });
        }
        
        await validateGuildAccess(guildId);
        
        const { username, friendName } = req.body;
        
        const userData = await loadUserFile(username, 'friends.json', { friends: [], pending: [] }, guildId);
        const friendData = await loadUserFile(friendName, 'friends.json', { friends: [], pending: [] }, guildId);
        
        userData.friends = (userData.friends || []).filter(f => f !== friendName);
        friendData.friends = (friendData.friends || []).filter(f => f !== username);
        
        await saveUserFile(username, 'friends.json', userData, '👥 Friends', guildId);
        await saveUserFile(friendName, 'friends.json', friendData, '👥 Friends', guildId);
        
        res.json({ success: true });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// === CHAT ===

app.get('/api/chat/:user1/:user2', async (req, res) => {
    const guildId = req.query.guildId || DEFAULT_GUILD_ID;
    
    try {
        if (!discordReady) {
            return res.json({ messages: [], participants: [req.params.user1, req.params.user2] });
        }
        
        await validateGuildAccess(guildId);
        const data = await loadChatFile(req.params.user1, req.params.user2, guildId);
        res.json(data || { 
            messages: [], 
            participants: [req.params.user1, req.params.user2] 
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/chat/send', async (req, res) => {
    const guildId = req.query.guildId || DEFAULT_GUILD_ID;
    
    try {
        if (!discordReady) {
            return res.status(503).json({ error: 'Discord not ready' });
        }
        
        await validateGuildAccess(guildId);
        const { fromUser, toUser, content } = req.body;
        
        let chat = await loadChatFile(fromUser, toUser, guildId);
        if (!chat) chat = { participants: [fromUser, toUser], messages: [] };
        
        chat.messages.push({
            id: crypto.randomUUID(), 
            sender: fromUser,
            content: content.trim(), 
            timestamp: new Date().toISOString(), 
            read: false
        });
        
        if (chat.messages.length > 500) chat.messages = chat.messages.slice(-500);
        
        await saveChatFile(fromUser, toUser, chat, guildId);
        res.json({ success: true });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// === LIBRARY ===

app.get('/api/users/:username/library', async (req, res) => {
    const guildId = req.query.guildId || DEFAULT_GUILD_ID;
    
    try {
        if (!discordReady) {
            // Zwróć pustą bibliotekę jeśli Discord nie jest gotowy
            return res.json([]);
        }
        
        await validateGuildAccess(guildId);
        const lib = await loadUserFile(req.params.username, 'library.json', { games: [] }, guildId);
        const games = gamesCache.get(guildId) || [];
        
        const enriched = lib.games.map(g => ({
            ...g, 
            gameDetails: games.find(gc => gc.id === g.gameId)
        }));
        
        res.json(enriched);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/users/:username/library', async (req, res) => {
    const guildId = req.query.guildId || DEFAULT_GUILD_ID;
    
    try {
        if (!discordReady) {
            return res.status(503).json({ error: 'Discord not ready' });
        }
        
        await validateGuildAccess(guildId);
        const { gameId } = req.body;
        const games = gamesCache.get(guildId) || [];
        
        if (!games.find(g => g.id === gameId)) {
            return res.status(404).json({ error: 'Game not found' });
        }
        
        const lib = await loadUserFile(req.params.username, 'library.json', { games: [] }, guildId);
        
        if (!lib.games.find(g => g.gameId === gameId)) {
            lib.games.push({
                gameId, 
                addedAt: new Date().toISOString(),
                installed: false, 
                playTime: 0
            });
            await saveUserFile(req.params.username, 'library.json', lib, '📚 Library', guildId);
        }
        
        res.json({ success: true, library: lib.games });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/users/:username/library/:gameId', async (req, res) => {
    const guildId = req.query.guildId || DEFAULT_GUILD_ID;
    
    try {
        if (!discordReady) {
            return res.status(503).json({ error: 'Discord not ready' });
        }
        
        await validateGuildAccess(guildId);
        const { username, gameId } = req.params;
        const lib = await loadUserFile(username, 'library.json', { games: [] }, guildId);
        
        const initialLength = lib.games.length;
        lib.games = lib.games.filter(g => g.gameId !== gameId);
        
        if (lib.games.length === initialLength) {
            return res.status(404).json({ error: 'Game not in library' });
        }
        
        await saveUserFile(username, 'library.json', lib, '📚 Library', guildId);
        res.json({ success: true, message: 'Game removed from library' });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// === OBSŁUGA BŁĘDÓW I ZAMYKANIA ===

process.on('SIGTERM', () => {
    console.log('⚠️ SIGTERM received - ignoring for keep-alive');
});

process.on('SIGINT', () => {
    console.log('🛑 SIGINT received - shutting down gracefully');
    isShuttingDown = true;
    server.close(() => {
        discordClient.destroy();
        process.exit(0);
    });
});

process.on('beforeExit', () => {
    console.log('⚠️ beforeExit - keeping alive');
    setTimeout(() => {}, 1000);
});

process.on('unhandledRejection', (error) => {
    console.error('⚠️ Unhandled Rejection:', error.message);
});

process.on('uncaughtException', (error) => {
    console.error('⚠️ Uncaught Exception:', error.message);
});

console.log('📋 Server starting...');
initDiscord();
