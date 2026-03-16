// server.js - POPRAWIONA WERSJA z poprawnymi endpointami
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');
const crypto = require('crypto');
const http = require('http');
const multer = require('multer');
const { Server } = require('socket.io');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');

const app = express();
const server = http.createServer(app);

// WAŻNE DLA ALWAYSDATA - trust proxy
app.set('trust proxy', 1);

// Konfiguracja Socket.IO
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization'],
        credentials: true
    },
    pingTimeout: 60000,
    pingInterval: 25000,
    transports: ['websocket', 'polling']
});

// Konfiguracja
const PORT = process.env.PORT || 8100;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const NOTIFICATION_CHANNEL_ID = '1477577363285082123';
const GLOBAL_DATA_CHANNEL_ID = '1477579719435092100';
const ALLOWED_GUILDS = process.env.ALLOWED_GUILDS 
    ? process.env.ALLOWED_GUILDS.split(',').map(id => id.trim())
    : ['1477574526933012541'];
const DEFAULT_GUILD_ID = ALLOWED_GUILDS[0];
const PING_INTERVAL = 2 * 60 * 1000;
const BASE_PATH = '/home/dom-kom/SYS/TEM';

// === DROPBOX CONFIGURATION ===
const DROPBOX_CONFIG = {
    refreshToken: process.env.DROPBOX_REFRESH_TOKEN || '47v0EqFCtcoAAAAAAAAAAfpTfXOTlKIav64b9Qy-sYuu3DstFy6jU72bwoMIjdj2',
    clientId: process.env.DROPBOX_CLIENT_ID || 'ux7zx7j4lhwqkhs',
    clientSecret: process.env.DROPBOX_CLIENT_SECRET || 'q83ujxq006ijh9n',
    tokenUrl: 'https://api.dropbox.com/oauth2/token',
    basePath: '/nebula-game-server'
};

// === DROPBOX TOKEN MANAGER ===
class DropboxTokenManager {
    constructor() {
        this.accessToken = null;
        this.expiresAt = null;
        this.refreshTimer = null;
        this.isRefreshing = false;
    }

    async initialize() {
        console.log('📦 Inicjalizacja Dropbox Token Manager...');
        await this.refreshAccessToken();
        
        const refreshInterval = 3.5 * 60 * 60 * 1000;
        this.refreshTimer = setInterval(() => {
            this.refreshAccessToken().catch(err => {
                console.error('❌ Błąd automatycznego odświeżania tokena:', err.message);
            });
        }, refreshInterval);
        
        console.log(`✅ Dropbox Token Manager aktywny (odświeżanie co 3.5h)`);
    }

    async refreshAccessToken() {
        if (this.isRefreshing) {
            console.log('⏳ Odświeżanie tokena już w trakcie...');
            return;
        }

        this.isRefreshing = true;
        
        try {
            console.log('🔄 Odświeżanie Dropbox access token...');
            
            const params = new URLSearchParams();
            params.append('grant_type', 'refresh_token');
            params.append('refresh_token', DROPBOX_CONFIG.refreshToken);
            params.append('client_id', DROPBOX_CONFIG.clientId);
            params.append('client_secret', DROPBOX_CONFIG.clientSecret);

            const response = await fetch(DROPBOX_CONFIG.tokenUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: params.toString()
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Dropbox API error: ${response.status} - ${errorText}`);
            }

            const data = await response.json();
            
            this.accessToken = data.access_token;
            this.expiresAt = Date.now() + (data.expires_in * 1000);
            
            console.log(`✅ Nowy Dropbox access token uzyskany`);
            console.log(`   Wygasa za: ${Math.floor(data.expires_in / 3600)}h ${Math.floor((data.expires_in % 3600) / 60)}m`);
            
            if (discordReady) {
                const embed = new EmbedBuilder()
                    .setTitle('🔄 Dropbox Token Odświeżony')
                    .setDescription('Access token został pomyślnie odświeżony')
                    .addFields(
                        { name: 'Wygasa za', value: `${Math.floor(data.expires_in / 3600)} godzin`, inline: true },
                        { name: 'Następne odświeżenie', value: 'za 3.5h', inline: true }
                    )
                    .setColor(0x00d4ff)
                    .setTimestamp();
                
                await sendDiscordNotification(embed).catch(() => {});
            }

        } catch (error) {
            console.error('❌ Błąd podczas odświeżania tokena Dropbox:', error.message);
            
            if (discordReady) {
                const embed = new EmbedBuilder()
                    .setTitle('⚠️ Błąd Dropbox Token')
                    .setDescription(`Nie udało się odświeżyć access tokena\n\`${error.message}\``)
                    .setColor(0xff0000)
                    .setTimestamp();
                
                await sendDiscordNotification(embed).catch(() => {});
            }
            
            throw error;
        } finally {
            this.isRefreshing = false;
        }
    }

    getAccessToken() {
        if (!this.accessToken) {
            throw new Error('Dropbox access token nie jest dostępny. Poczekaj na inicjalizację.');
        }
        
        if (this.expiresAt && Date.now() > (this.expiresAt - 5 * 60 * 1000)) {
            console.log('⚠️ Token wygasa za mniej niż 5 minut, wymuszam odświeżenie...');
            this.refreshAccessToken().catch(err => console.error('Błąd odświeżania:', err));
        }
        
        return this.accessToken;
    }

    async getValidAccessToken() {
        if (!this.accessToken || (this.expiresAt && Date.now() > (this.expiresAt - 5 * 60 * 1000))) {
            await this.refreshAccessToken();
        }
        return this.accessToken;
    }

    stop() {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = null;
        }
    }
}

const dropboxTokenManager = new DropboxTokenManager();

// === DROPBOX API FUNCTIONS ===
async function dropboxApiRequest(endpoint, options = {}) {
    const token = await dropboxTokenManager.getValidAccessToken();
    
    const isContentApi = endpoint.startsWith('/files/download') || endpoint.startsWith('/files/upload');
    const baseUrl = isContentApi ? 'https://content.dropboxapi.com/2' : 'https://api.dropboxapi.com/2';
    
    const headers = {
        'Authorization': `Bearer ${token}`,
        ...options.headers
    };
    
    if (!headers['Content-Type'] && !isContentApi) {
        headers['Content-Type'] = 'application/json';
    }
    
    const url = `${baseUrl}${endpoint}`;
    
    console.log(`📡 Dropbox API: ${endpoint}`);
    
    const fetchOptions = {
        method: options.method || 'POST',
        headers: headers
    };
    
    if (options.body !== undefined) {
        fetchOptions.body = options.body;
    }
    
    const response = await fetch(url, fetchOptions);
    
    if (response.status === 401) {
        console.log('🔄 Token wygasł, odświeżam...');
        await dropboxTokenManager.refreshAccessToken();
        const newToken = dropboxTokenManager.getAccessToken();
        
        headers['Authorization'] = `Bearer ${newToken}`;
        
        const retryResponse = await fetch(url, {
            ...fetchOptions,
            headers: headers
        });
        
        return retryResponse;
    }
    
    return response;
}

async function saveToDropbox(dropboxPath, content) {
    try {
        const buffer = Buffer.from(content, 'utf-8');
        const fullPath = `${DROPBOX_CONFIG.basePath}${dropboxPath}`;
        
        console.log(`💾 Zapisywanie do Dropbox: ${fullPath}`);
        
        const response = await dropboxApiRequest('/files/upload', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/octet-stream',
                'Dropbox-API-Arg': JSON.stringify({
                    path: fullPath,
                    mode: 'overwrite',
                    autorename: false,
                    mute: false
                })
            },
            body: buffer
        });
        
        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Dropbox upload error: ${error}`);
        }
        
        const result = await response.json();
        console.log(`✅ Zapisano do Dropbox: ${dropboxPath}`);
        return result;
    } catch (error) {
        console.error(`❌ Błąd zapisu do Dropbox (${dropboxPath}):`, error.message);
        throw error;
    }
}

async function loadFromDropbox(dropboxPath, defaultValue = null) {
    try {
        const fullPath = `${DROPBOX_CONFIG.basePath}${dropboxPath}`;
        
        console.log(`📂 Odczyt z Dropbox: ${fullPath}`);
        
        const response = await dropboxApiRequest('/files/download', {
            method: 'POST',
            headers: {
                'Dropbox-API-Arg': JSON.stringify({
                    path: fullPath
                })
            }
        });
        
        if (response.status === 409) {
            console.log(`📭 Plik nie istnieje w Dropbox: ${dropboxPath}`);
            return defaultValue;
        }
        
        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Dropbox download error: ${error}`);
        }
        
        const content = await response.text();
        console.log(`✅ Odczytano z Dropbox: ${dropboxPath}`);
        return JSON.parse(content);
    } catch (error) {
        if (error.message.includes('not_found') || error.message.includes('path_lookup') || error.message.includes('path/not_found')) {
            return defaultValue;
        }
        console.error(`❌ Błąd odczytu z Dropbox (${dropboxPath}):`, error.message);
        return defaultValue;
    }
}

async function deleteFromDropbox(dropboxPath) {
    try {
        const fullPath = `${DROPBOX_CONFIG.basePath}${dropboxPath}`;
        
        const response = await dropboxApiRequest('/files/delete_v2', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                path: fullPath
            })
        });
        
        if (!response.ok && response.status !== 409) {
            const error = await response.text();
            throw new Error(`Dropbox delete error: ${error}`);
        }
        
        console.log(`🗑️ Usunięto z Dropbox: ${dropboxPath}`);
        return true;
    } catch (error) {
        console.error(`❌ Błąd usuwania z Dropbox (${dropboxPath}):`, error.message);
        return false;
    }
}

async function listDropboxFolder(dropboxPath) {
    try {
        const fullPath = `${DROPBOX_CONFIG.basePath}${dropboxPath}`;
        
        const response = await dropboxApiRequest('/files/list_folder', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                path: fullPath,
                recursive: false,
                include_media_info: false,
                include_deleted: false
            })
        });
        
        if (!response.ok) {
            if (response.status === 409) {
                await createDropboxFolder(dropboxPath);
                return [];
            }
            const error = await response.text();
            throw new Error(`Dropbox list error: ${error}`);
        }
        
        const data = await response.json();
        return data.entries || [];
    } catch (error) {
        console.error(`❌ Błąd listowania folderu Dropbox (${dropboxPath}):`, error.message);
        return [];
    }
}

async function createDropboxFolder(dropboxPath) {
    try {
        const fullPath = `${DROPBOX_CONFIG.basePath}${dropboxPath}`;
        
        console.log(`📁 Tworzenie folderu w Dropbox: ${fullPath}`);
        
        const response = await dropboxApiRequest('/files/create_folder_v2', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                path: fullPath,
                autorename: false
            })
        });
        
        if (!response.ok && response.status !== 409) {
            const error = await response.text();
            throw new Error(`Dropbox create folder error: ${error}`);
        }
        
        console.log(`✅ Utworzono folder w Dropbox: ${dropboxPath}`);
        return true;
    } catch (error) {
        console.error(`❌ Błąd tworzenia folderu Dropbox (${dropboxPath}):`, error.message);
        throw error;
    }
}

// === STAŁE LINKI DROPBOX (NIGDY NIE WYGASAJĄ) ===
async function createPermanentDropboxLink(dropboxPath) {
    try {
        const fullPath = `${DROPBOX_CONFIG.basePath}${dropboxPath}`;
        
        console.log(`🔗 Tworzenie stałego linku dla: ${fullPath}`);
        
        const existingLinks = await listSharedLinks(fullPath);
        if (existingLinks.length > 0) {
            const link = existingLinks[0].url.replace('?dl=0', '?dl=1');
            console.log(`✅ Znaleziono istniejący stały link`);
            return link;
        }
        
        const response = await dropboxApiRequest('/sharing/create_shared_link_with_settings', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                path: fullPath,
                settings: {
                    requested_visibility: 'public',
                    audience: 'public',
                    access: 'viewer'
                }
            })
        });
        
        if (!response.ok) {
            if (response.status === 409) {
                const errorData = await response.json();
                if (errorData.error?.['.tag'] === 'shared_link_already_exists') {
                    const links = await listSharedLinks(fullPath);
                    if (links.length > 0) {
                        const link = links[0].url.replace('?dl=0', '?dl=1');
                        console.log(`✅ Link już istniał, zwracam istniejący`);
                        return link;
                    }
                }
                throw new Error(`Dropbox shared link error: ${JSON.stringify(errorData)}`);
            }
            const error = await response.text();
            throw new Error(`Dropbox shared link error: ${error}`);
        }
        
        const data = await response.json();
        const directLink = data.url.replace('?dl=0', '?dl=1');
        
        console.log(`✅ Utworzono nowy stały link`);
        return directLink;
        
    } catch (error) {
        console.error(`❌ Błąd tworzenia stałego linku (${dropboxPath}):`, error.message);
        throw error;
    }
}

async function listSharedLinks(dropboxPath) {
    try {
        const response = await dropboxApiRequest('/sharing/list_shared_links', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                path: dropboxPath,
                direct_only: true
            })
        });
        
        if (!response.ok) {
            return [];
        }
        
        const data = await response.json();
        return data.links || [];
        
    } catch (error) {
        console.error('❌ Błąd listowania linków:', error.message);
        return [];
    }
}

async function saveBinaryToDropboxWithPermanentLink(dropboxPath, buffer, mimeType) {
    try {
        const fullPath = `${DROPBOX_CONFIG.basePath}${dropboxPath}`;
        
        const uploadResponse = await dropboxApiRequest('/files/upload', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/octet-stream',
                'Dropbox-API-Arg': JSON.stringify({
                    path: fullPath,
                    mode: 'overwrite',
                    autorename: false,
                    mute: false
                })
            },
            body: buffer
        });
        
        if (!uploadResponse.ok) {
            const error = await uploadResponse.text();
            throw new Error(`Dropbox upload error: ${error}`);
        }
        
        console.log(`✅ Zapisano plik do Dropbox: ${dropboxPath}`);
        
        const permanentLink = await createPermanentDropboxLink(dropboxPath);
        
        return {
            uploadResult: await uploadResponse.json(),
            permanentUrl: permanentLink
        };
        
    } catch (error) {
        console.error(`❌ Błąd zapisu pliku (${dropboxPath}):`, error.message);
        throw error;
    }
}

// === BACKUP SYSTEM ===
const BACKUP_CONFIG = {
    interval: 60 * 60 * 1000,
    maxBackups: 24,
    folders: ['/global', '/users', '/chats']
};

function getBackupTimestamp() {
    const now = new Date();
    return `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}${String(now.getSeconds()).padStart(2,'0')}`;
}

async function copyDropboxFolder(fromPath, toPath) {
    try {
        await createDropboxFolder(toPath.replace(DROPBOX_CONFIG.basePath, ''));
        
        const files = await listDropboxFolder(fromPath.replace(DROPBOX_CONFIG.basePath, ''));
        
        for (const file of files) {
            const fileName = file.name;
            const sourcePath = file.path_display;
            const destPath = `${toPath}/${fileName}`;
            
            if (file['.tag'] === 'folder') {
                await copyDropboxFolder(sourcePath, destPath);
            } else {
                await dropboxApiRequest('/files/copy_v2', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        from_path: sourcePath,
                        to_path: destPath,
                        autorename: false
                    })
                });
            }
        }
        
        console.log(`📁 Skopiowano folder: ${fromPath} → ${toPath}`);
        return true;
    } catch (error) {
        console.error(`❌ Błąd kopiowania folderu ${fromPath}:`, error.message);
        return false;
    }
}

async function createFullBackup() {
    const timestamp = getBackupTimestamp();
    const backupFolder = `/backups/backup_${timestamp}`;
    
    console.log(`💾 Rozpoczynam backup: ${backupFolder}`);
    
    const backupResults = {
        timestamp: timestamp,
        folder: backupFolder,
        success: [],
        failed: []
    };
    
    try {
        await createDropboxFolder(backupFolder);
        
        for (const folder of BACKUP_CONFIG.folders) {
            const sourcePath = `${DROPBOX_CONFIG.basePath}${folder}`;
            const destPath = `${DROPBOX_CONFIG.basePath}${backupFolder}${folder}`;
            
            const success = await copyDropboxFolder(sourcePath, destPath);
            
            if (success) {
                backupResults.success.push(folder);
            } else {
                backupResults.failed.push(folder);
            }
        }
        
        const metadata = {
            timestamp: timestamp,
            createdAt: new Date().toISOString(),
            folders: backupResults.success,
            failed: backupResults.failed,
            totalSize: 0
        };
        
        await saveToDropbox(`${backupFolder}/_metadata.json`, JSON.stringify(metadata, null, 2));
        
        await cleanupOldBackups();
        
        if (discordReady && backupResults.failed.length === 0) {
            const embed = new EmbedBuilder()
                .setTitle('💾 Automatyczny Backup')
                .setDescription(`Backup wykonany pomyślnie`)
                .addFields(
                    { name: 'ID', value: timestamp, inline: true },
                    { name: 'Foldery', value: backupResults.success.length.toString(), inline: true },
                    { name: 'Status', value: '✅ OK', inline: true }
                )
                .setColor(0x00ff00)
                .setTimestamp();
            
            await sendDiscordNotification(embed);
        }
        
        console.log(`✅ Backup zakończony: ${timestamp}`);
        return backupResults;
        
    } catch (error) {
        console.error('❌ Błąd podczas backupu:', error.message);
        
        if (discordReady) {
            const embed = new EmbedBuilder()
                .setTitle('🚨 Błąd Backupu')
                .setDescription(`Nie udało się wykonać backupu\n\`${error.message}\``)
                .setColor(0xff0000)
                .setTimestamp();
            
            await sendDiscordNotification(embed);
        }
        
        throw error;
    }
}

async function cleanupOldBackups() {
    try {
        const backups = await listDropboxFolder('/backups');
        
        const backupFolders = backups
            .filter(b => b['.tag'] === 'folder' && b.name.startsWith('backup_'))
            .sort((a, b) => b.name.localeCompare(a.name));
        
        if (backupFolders.length > BACKUP_CONFIG.maxBackups) {
            const toDelete = backupFolders.slice(BACKUP_CONFIG.maxBackups);
            
            for (const folder of toDelete) {
                await deleteFromDropbox(`/backups/${folder.name}`);
                console.log(`🗑️ Usunięto stary backup: ${folder.name}`);
            }
        }
        
        return true;
    } catch (error) {
        console.error('❌ Błąd czyszczenia starych backupów:', error.message);
        return false;
    }
}

let backupInterval = null;

function startAutomaticBackup() {
    if (backupInterval) {
        clearInterval(backupInterval);
    }
    
    console.log(`🔄 Automatyczny backup co ${BACKUP_CONFIG.interval/60000} minut`);
    
    setTimeout(() => {
        createFullBackup().catch(err => console.error('Błąd pierwszego backupu:', err));
    }, 5 * 60 * 1000);
    
    backupInterval = setInterval(() => {
        createFullBackup().catch(err => console.error('Błąd automatycznego backupu:', err));
    }, BACKUP_CONFIG.interval);
}

function stopAutomaticBackup() {
    if (backupInterval) {
        clearInterval(backupInterval);
        backupInterval = null;
        console.log('🛑 Automatyczny backup zatrzymany');
    }
}

// === DISCORD INTEGRATION ===
const discordClient = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages
    ],
    rest: { timeout: 60000, retries: 3 }
});

let discordReady = false;
let isShuttingDown = false;

async function sendDiscordNotification(embed) {
    if (!discordReady) {
        console.log('ℹ️ Discord nie gotowy - pominięto powiadomienie');
        return;
    }
    
    try {
        const channel = await discordClient.channels.fetch(NOTIFICATION_CHANNEL_ID);
        if (!channel) {
            console.log('⚠️ Kanał powiadomień nie znaleziony');
            return;
        }
        
        await channel.send({ embeds: [embed] });
        console.log('📨 Wysłano powiadomienie Discord');
    } catch (error) {
        console.log('⚠️ Błąd powiadomienia Discord:', error.message);
    }
}

async function sendEmergencyNotification(message) {
    if (!discordReady) return;
    
    try {
        const channel = await discordClient.channels.fetch(NOTIFICATION_CHANNEL_ID);
        if (!channel) return;
        
        await channel.send(`🚨 **AWARIA SYSTEMU**\n${message}\nCzas: ${new Date().toISOString()}`);
    } catch (error) {
        console.error('❌ Błąd powiadomienia awaryjnego:', error.message);
    }
}

// === MIDDLEWARE - POPRAWIONE CORS ===
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
    credentials: true,
    preflightContinue: false,
    optionsSuccessStatus: 204
}));

// Dodatkowe nagłówki CORS dla wszystkich odpowiedzi
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, Cache-Control');
    res.header('Access-Control-Allow-Credentials', 'true');
    
    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }
    next();
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} | ${req.method} ${req.path} | IP: ${req.ip}`);
    next();
});

// === MULTER CONFIG ===
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

// === CACHE ===
const gamesCache = new Map();
const connectedUsers = new Map();
const userSockets = new Map();

// === STORAGE FUNCTIONS ===
async function initStorage() {
    console.log('📁 Inicjalizacja storage (Dropbox)...');
    
    try {
        await fs.mkdir(path.join(BASE_PATH, 'temp'), { recursive: true });
        
        const folders = ['/global', '/users', '/chats', '/screenshots', '/icons', '/temp', '/backups'];
        for (const folder of folders) {
            try {
                await createDropboxFolder(folder);
            } catch (err) {
                console.error(`❌ Nie udało się utworzyć folderu ${folder}:`, err.message);
            }
        }
        
        const globalFiles = {
            'users.json': {},
            'games.json': [],
            'comments.json': {},
            'ratings.json': {},
            'screenshots.json': [],
            'icons.json': []
        };
        
        for (const [filename, defaultData] of Object.entries(globalFiles)) {
            try {
                const existing = await loadFromDropbox(`/global/${filename}`, null);
                if (existing === null) {
                    await saveToDropbox(`/global/${filename}`, JSON.stringify(defaultData, null, 2));
                    console.log(`  📝 Utworzono w Dropbox: ${filename}`);
                }
            } catch (err) {
                console.error(`❌ Błąd tworzenia pliku ${filename}:`, err.message);
            }
        }
        
        console.log('✅ Storage gotowy (Dropbox)');
        return true;
    } catch (error) {
        console.error('❌ Błąd inicjalizacji storage:', error);
        await sendEmergencyNotification(`🚨 Błąd inicjalizacji Dropbox: ${error.message}`);
        return false;
    }
}

async function loadGlobalFile(filename, defaultData = {}) {
    return await loadFromDropbox(`/global/${filename}`, defaultData);
}

async function saveGlobalFile(filename, data) {
    await saveToDropbox(`/global/${filename}`, JSON.stringify(data, null, 2));
    return `/global/${filename}`;
}

// === WEBSOCKET HANDLERS ===
io.on('connection', (socket) => {
    console.log(`🔌 Nowe połączenie: ${socket.id}`);
    
    socket.on('authenticate', async (data) => {
        try {
            const { token, guildId } = data;
            const users = await loadGlobalFile('users.json', {});
            const user = Object.values(users).find(u => u.token === token);
            
            if (!user) {
                socket.emit('auth_error', { message: 'Invalid token' });
                return;
            }
            
            connectedUsers.set(socket.id, {
                username: user.username,
                guildId: guildId || DEFAULT_GUILD_ID,
                status: 'online',
                lastActivity: Date.now()
            });
            
            if (!userSockets.has(user.username)) {
                userSockets.set(user.username, new Set());
            }
            userSockets.get(user.username).add(socket.id);
            
            socket.authenticated = true;
            socket.username = user.username;
            socket.guildId = guildId || DEFAULT_GUILD_ID;
            
            socket.emit('authenticated', { 
                success: true, 
                username: user.username,
                guildId: socket.guildId
            });
            
        } catch (error) {
            socket.emit('auth_error', { message: error.message });
        }
    });
    
    socket.on('disconnect', (reason) => {
        if (socket.authenticated && socket.username) {
            const sockets = userSockets.get(socket.username);
            if (sockets) {
                sockets.delete(socket.id);
                if (sockets.size === 0) {
                    userSockets.delete(socket.username);
                }
            }
        }
        connectedUsers.delete(socket.id);
    });
});

// === API ROUTES - POPRAWIONE ===

// Health Check
app.get('/health', async (req, res) => {
    const response = {
        status: 'OK',
        discord: discordReady,
        dropbox: {
            connected: !!dropboxTokenManager.accessToken,
            expiresAt: dropboxTokenManager.expiresAt ? new Date(dropboxTokenManager.expiresAt).toISOString() : null
        },
        storage: 'dropbox',
        basePath: DROPBOX_CONFIG.basePath,
        websocket: {
            connectedClients: io.engine.clientsCount,
            authenticatedUsers: connectedUsers.size
        },
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    };
    
    res.json(response);
});

// === GAMES API - POPRAWIONE (obsługa zarówno /games jak i /api/games) ===

// Get all games - OBSŁUGA OBU ŚCIEŻEK
app.get(['/games', '/api/games'], async (req, res) => {
    try {
        const games = await loadGlobalFile('games.json', []);
        gamesCache.set('all', games);
        res.json(games);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get single game - OBSŁUGA OBU ŚCIEŻEK
app.get(['/games/:id', '/api/games/:id'], async (req, res) => {
    try {
        const games = await loadGlobalFile('games.json', []);
        const game = games.find(g => g.id === req.params.id);
        if (!game) return res.status(404).json({ error: 'Game not found' });
        res.json(game);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Create game - OBSŁUGA OBU ŚCIEŻEK
app.post(['/api/games', '/games'], async (req, res) => {
    try {
        const { 
            name, description, developer, price, icon, iconUrl, color,
            pegi, download_url, size, requirements, screenshots, genre,
            releaseDate, publisher, version, language 
        } = req.body;
        
        if (!name) return res.status(400).json({ error: 'Name required' });
        
        const gameId = crypto.randomUUID();
        const gameData = {
            id: gameId,
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
            publisher: publisher || developer || 'Unknown',
            version: version || '1.0',
            language: language || 'Polski/Angielski',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        
        const games = await loadGlobalFile('games.json', []);
        games.push(gameData);
        
        await saveGlobalFile('games.json', games);
        gamesCache.set('all', games);
        
        if (discordReady) {
            try {
                const embed = new EmbedBuilder()
                    .setTitle(gameData.price === 0 ? '🆓 Nowa darmowa gra!' : '💰 Nowa gra!')
                    .setDescription(`**${gameData.name}**`)
                    .addFields(
                        { name: 'Dev', value: gameData.developer, inline: true },
                        { name: 'Cena', value: gameData.price === 0 ? 'DARMOWE' : `${gameData.price}zł`, inline: true },
                        { name: 'Gatunek', value: gameData.genre, inline: true }
                    )
                    .setColor(parseInt(gameData.color.replace('#', ''), 16))
                    .setTimestamp();
                
                await sendDiscordNotification(embed);
            } catch (err) {
                console.log('Powiadomienie Discord nie wysłane:', err.message);
            }
        }
        
        res.json({ success: true, game: gameData });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Update game - OBSŁUGA OBU ŚCIEŻEK
app.put(['/api/games/:id', '/games/:id'], async (req, res) => {
    try {
        const games = await loadGlobalFile('games.json', []);
        const index = games.findIndex(g => g.id === req.params.id);
        
        if (index === -1) return res.status(404).json({ error: 'Game not found' });
        
        const updated = { 
            ...games[index], 
            ...req.body, 
            id: req.params.id,
            updatedAt: new Date().toISOString() 
        };
        
        games[index] = updated;
        
        await saveGlobalFile('games.json', games);
        gamesCache.set('all', games);
        
        res.json({ success: true, game: updated });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Delete game - OBSŁUGA OBU ŚCIEŻEK
app.delete(['/api/games/:id', '/games/:id'], async (req, res) => {
    try {
        let games = await loadGlobalFile('games.json', []);
        const initialLength = games.length;
        
        games = games.filter(g => g.id !== req.params.id);
        
        if (games.length === initialLength) {
            return res.status(404).json({ error: 'Game not found' });
        }
        
        await saveGlobalFile('games.json', games);
        gamesCache.set('all', games);
        
        res.json({ success: true, message: 'Game deleted' });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// === FILE UPLOAD API (STAŁE LINKI) ===

// Upload icon - OBSŁUGA OBU ŚCIEŻEK
app.post(['/api/upload/icon', '/upload/icon'], upload.single('icon'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        
        const iconId = crypto.randomUUID();
        const ext = path.extname(req.file.originalname) || '.png';
        const filename = `${iconId}${ext}`;
        const dropboxPath = `/icons/${filename}`;
        
        const result = await saveBinaryToDropboxWithPermanentLink(
            dropboxPath, 
            req.file.buffer, 
            req.file.mimetype
        );
        
        const icons = await loadGlobalFile('icons.json', []);
        icons.push({
            id: iconId,
            dropboxPath: dropboxPath,
            url: result.permanentUrl,
            permanentUrl: result.permanentUrl,
            filename: req.file.originalname,
            mimetype: req.file.mimetype,
            size: req.file.size,
            uploadedAt: new Date().toISOString()
        });
        
        await saveGlobalFile('icons.json', icons);
        
        res.json({
            success: true,
            url: result.permanentUrl,
            iconId: iconId,
            message: 'Icon uploaded with permanent link (never expires)'
        });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Upload single screenshot - OBSŁUGA OBU ŚCIEŻEK
app.post(['/api/upload/screenshot', '/upload/screenshot'], upload.single('screenshot'), async (req, res) => {
    try {
        const { gameId } = req.query;
        
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        
        const screenshotId = crypto.randomUUID();
        const ext = path.extname(req.file.originalname) || '.png';
        const filename = `${screenshotId}${ext}`;
        const dropboxPath = `/screenshots/${filename}`;
        
        const result = await saveBinaryToDropboxWithPermanentLink(
            dropboxPath, 
            req.file.buffer, 
            req.file.mimetype
        );
        
        const screenshots = await loadGlobalFile('screenshots.json', []);
        screenshots.push({
            id: screenshotId,
            dropboxPath: dropboxPath,
            url: result.permanentUrl,
            permanentUrl: result.permanentUrl,
            gameId: gameId || null,
            filename: req.file.originalname,
            mimetype: req.file.mimetype,
            size: req.file.size,
            uploadedAt: new Date().toISOString()
        });
        
        await saveGlobalFile('screenshots.json', screenshots);
        
        res.json({
            success: true,
            url: result.permanentUrl,
            screenshotId: screenshotId,
            message: 'Screenshot uploaded with permanent link (never expires)'
        });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Upload multiple screenshots - OBSŁUGA OBU ŚCIEŻEK
app.post(['/api/upload/screenshots', '/upload/screenshots'], upload.array('screenshots', 10), async (req, res) => {
    try {
        const { gameId } = req.query;
        
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: 'No files uploaded' });
        }
        
        const screenshots = await loadGlobalFile('screenshots.json', []);
        const uploadedUrls = [];
        
        for (const file of req.files) {
            const screenshotId = crypto.randomUUID();
            const ext = path.extname(file.originalname) || '.png';
            const filename = `${screenshotId}${ext}`;
            const dropboxPath = `/screenshots/${filename}`;
            
            const result = await saveBinaryToDropboxWithPermanentLink(
                dropboxPath, 
                file.buffer, 
                file.mimetype
            );
            
            screenshots.push({
                id: screenshotId,
                dropboxPath: dropboxPath,
                url: result.permanentUrl,
                permanentUrl: result.permanentUrl,
                gameId: gameId || null,
                filename: file.originalname,
                mimetype: file.mimetype,
                size: file.size,
                uploadedAt: new Date().toISOString()
            });
            
            uploadedUrls.push({ 
                url: result.permanentUrl,
                screenshotId 
            });
        }
        
        await saveGlobalFile('screenshots.json', screenshots);
        
        res.json({
            success: true,
            urls: uploadedUrls,
            count: uploadedUrls.length,
            message: 'All screenshots uploaded with permanent links (never expire)'
        });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get screenshots for game - OBSŁUGA OBU ŚCIEŻEK
app.get(['/api/screenshots/:gameId', '/screenshots/:gameId'], async (req, res) => {
    try {
        const screenshots = await loadGlobalFile('screenshots.json', []);
        const gameScreenshots = screenshots
            .filter(s => s.gameId === req.params.gameId)
            .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
        
        const refreshedScreenshots = await Promise.all(
            gameScreenshots.map(async (s) => {
                if (s.permanentUrl) {
                    return { ...s, url: s.permanentUrl };
                } else {
                    try {
                        const permanentUrl = await createPermanentDropboxLink(s.dropboxPath);
                        s.permanentUrl = permanentUrl;
                        s.url = permanentUrl;
                        return s;
                    } catch (err) {
                        console.error(`Nie udało się utworzyć stałego linku dla ${s.id}:`, err.message);
                        return s;
                    }
                }
            })
        );
        
        const allScreenshots = await loadGlobalFile('screenshots.json', []);
        const updatedScreenshots = allScreenshots.map(s => {
            const updated = refreshedScreenshots.find(rs => rs.id === s.id);
            return updated || s;
        });
        await saveGlobalFile('screenshots.json', updatedScreenshots);
        
        res.json({
            success: true,
            screenshots: refreshedScreenshots,
            total: refreshedScreenshots.length
        });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Serve files by Dropbox path
app.get(['/dropbox-file/*', '/api/dropbox-file/*'], async (req, res) => {
    try {
        const dropboxPath = '/' + req.params[0];
        
        const screenshots = await loadGlobalFile('screenshots.json', []);
        const icons = await loadGlobalFile('icons.json', []);
        const allFiles = [...screenshots, ...icons];
        
        const fileRecord = allFiles.find(f => f.dropboxPath === dropboxPath);
        
        if (fileRecord && fileRecord.permanentUrl) {
            return res.redirect(fileRecord.permanentUrl);
        }
        
        const permanentLink = await createPermanentDropboxLink(dropboxPath);
        res.redirect(permanentLink);
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// === BACKUP API ===

app.post(['/api/backup/create', '/backup/create'], async (req, res) => {
    try {
        const result = await createFullBackup();
        res.json({
            success: true,
            backup: {
                timestamp: result.timestamp,
                folder: result.folder,
                foldersBackedUp: result.success,
                failed: result.failed
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get(['/api/backup/list', '/backup/list'], async (req, res) => {
    try {
        const backups = await listDropboxFolder('/backups');
        
        const backupList = [];
        for (const folder of backups.filter(b => b['.tag'] === 'folder' && b.name.startsWith('backup_'))) {
            const metadata = await loadFromDropbox(`/backups/${folder.name}/_metadata.json`, null);
            if (metadata) {
                backupList.push({
                    id: folder.name.replace('backup_', ''),
                    timestamp: metadata.timestamp,
                    createdAt: metadata.createdAt,
                    folders: metadata.folders,
                    status: metadata.failed?.length > 0 ? 'partial' : 'complete'
                });
            }
        }
        
        res.json({
            success: true,
            backups: backupList.sort((a, b) => b.timestamp.localeCompare(a.timestamp)),
            total: backupList.length,
            maxKept: BACKUP_CONFIG.maxBackups
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// === STATIC FILES ===

// Serve static files from current directory
app.use(express.static(__dirname));

// Serve admin panel at root
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Serve index.html for all HTML requests
app.get('/index.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Handle admin.html and other pages
app.get(['/admin.html', '/admin'], (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Handle 404 - zwróć index.html dla ścieżek SPA (Single Page Application)
app.get('*', (req, res) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/games') || req.path.startsWith('/upload')) {
        return res.status(404).json({ error: 'Not found' });
    }
    res.sendFile(path.join(__dirname, 'index.html'));
});

// === SERVER START ===

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Serwer HTTP + WebSocket na porcie ${PORT}`);
    console.log(`☁️ Dropbox Storage: ${DROPBOX_CONFIG.basePath}`);
    console.log(`🌐 Admin panel: http://localhost:${PORT}`);
    
    setInterval(() => {
        try {
            const http = require('http');
            const options = {
                hostname: 'localhost',
                port: PORT,
                path: '/health',
                method: 'GET',
                timeout: 5000
            };
            
            const req = http.request(options, (res) => {
                console.log(`🔄 Self-ping OK | Status: ${res.statusCode}`);
            });
            
            req.on('error', (err) => {
                console.error('❌ Self-ping failed:', err.message);
            });
            
            req.end();
            
        } catch (error) {
            console.error('❌ Self-ping error:', error.message);
        }
    }, PING_INTERVAL);
});

// Initialization
console.log('📋 Server starting...');

dropboxTokenManager.initialize().then(() => {
    console.log('✅ Dropbox Token Manager gotowy');
    return initStorage();
}).then(() => {
    console.log('✅ Storage gotowy');
    
    startAutomaticBackup();
    
    if (DISCORD_TOKEN) {
        console.log('🔌 Łączenie z Discordem...');
        
        discordClient.once('ready', () => {
            console.log(`🤖 Bot: ${discordClient.user.tag}`);
            discordReady = true;
            
            sendDiscordNotification(
                new EmbedBuilder()
                    .setTitle('🟢 Server wystartował')
                    .setDescription(`Port: ${PORT}\nStorage: Dropbox\nAdmin: http://localhost:${PORT}`)
                    .setColor(0x00ff00)
                    .setTimestamp()
            ).catch(() => {});
        });
        
        discordClient.on('error', (error) => {
            console.error('❌ Discord Error:', error.message);
        });
        
        discordClient.login(DISCORD_TOKEN).catch(err => {
            console.log('⚠️ Discord offline:', err.message);
        });
    } else {
        console.log('⚠️ Brak DISCORD_TOKEN - działam bez powiadomień');
    }
}).catch(err => {
    console.error('❌ Błąd inicjalizacji:', err.message);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('🛑 SIGINT received - shutting down gracefully');
    isShuttingDown = true;
    
    dropboxTokenManager.stop();
    stopAutomaticBackup();
    
    if (discordReady) {
        sendDiscordNotification(
            new EmbedBuilder()
                .setTitle('🔴 Serwer się zamyka')
                .setColor(0xff0000)
                .setTimestamp()
        ).finally(() => {
            discordClient.destroy();
            process.exit(0);
        });
    } else {
        process.exit(0);
    }
});

process.on('unhandledRejection', (error) => {
    console.error('⚠️ Unhandled Rejection:', error.message);
});

process.on('uncaughtException', (error) => {
    console.error('⚠️ Uncaught Exception:', error.message);
});
