// server.js - ALWAYSDATA WERSJA z DROPBOX STORAGE (POPRAWIONA)
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');
const crypto = require('crypto');
const http = require('http');
const multer = require('multer');
const { Server } = require('socket.io');
const { Client, GatewayIntentBits, EmbedBuilder, ChannelType } = require('discord.js');

const app = express();
const server = http.createServer(app);

// WAŻNE DLA ALWAYSDATA - trust proxy
app.set('trust proxy', 1);

// Konfiguracja Socket.IO z CORS dla zewnętrznych połączeń
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

// ID kanałów Discord (TYLKO do powiadomień i backupu awaryjnego)
const NOTIFICATION_CHANNEL_ID = '1477577363285082123';
const GLOBAL_DATA_CHANNEL_ID = '1477579719435092100';

// Multi-guild support
const ALLOWED_GUILDS = process.env.ALLOWED_GUILDS 
    ? process.env.ALLOWED_GUILDS.split(',').map(id => id.trim())
    : ['1477574526933012541'];

const DEFAULT_GUILD_ID = ALLOWED_GUILDS[0];

// Self-ping
const PING_INTERVAL = 2 * 60 * 1000;

// Lokalna ścieżka tylko dla tymczasowych plików
const BASE_PATH = '/home/dom-kom/SYS/TEM';

// === DROPBOX CONFIGURATION ===
const DROPBOX_CONFIG = {
    refreshToken: 'SIkQyaAHJCwAAAAAAAAAAXx597Tmiqnq7aErtYElYKXO2ICt25KzUM7prLXf-O-D',
    clientId: 'ux7zx7j4lhwqkhs',
    clientSecret: 'q83ujxq006ijh9n',
    tokenUrl: 'https://api.dropbox.com/oauth2/token',
    basePath: '/nebula-game-server'
};;

// Dropbox Token Manager - POPRAWIONY (bez spamu)
class DropboxTokenManager {
    constructor() {
        this.accessToken = null;
        this.expiresAt = null;
        this.refreshTimer = null;
        this.isRefreshing = false;
        this.lastLogTime = 0; // Dodane: śledzenie kiedy ostatnio logowaliśmy
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
            // Sprawdź czy token jest wciąż ważny (z marginesem 5 minut)
            if (this.accessToken && this.expiresAt && Date.now() < (this.expiresAt - 5 * 60 * 1000)) {
                this.isRefreshing = false;
                return; // Token wciąż ważny, nie trzeba odświeżać
            }

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
            
            console.log(`✅ Dropbox token odświeżony, ważny przez ${Math.floor(data.expires_in / 3600)}h`);
            
            // Powiadomienie Discord tylko przy starcie lub gdy był problem (nie przy każdym odświeżeniu)
            if (discordReady && !this.initialized) {
                const embed = new EmbedBuilder()
                    .setTitle('🔄 Dropbox Token Aktywny')
                    .setDescription('Token został pomyślnie uzyskany')
                    .addFields(
                        { name: 'Wygasa za', value: `${Math.floor(data.expires_in / 3600)} godzin`, inline: true },
                        { name: 'Następne odświeżenie', value: 'za 3.5h', inline: true }
                    )
                    .setColor(0x00d4ff)
                    .setTimestamp();
                
                await sendDiscordNotification(embed).catch(() => {});
                this.initialized = true;
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
        return this.accessToken;
    }

    async getValidAccessToken() {
        // Tylko odśwież jeśli token wygasa za mniej niż 5 minut lub nie ma tokena
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

// Inicjalizacja managera tokenów Dropbox
const dropboxTokenManager = new DropboxTokenManager();

// === DROPBOX STORAGE API (POPRAWIONE) ===

// Funkcja pomocnicza do Dropbox API - POPRAWIONA (bez zbędnego logowania)
async function dropboxApiRequest(endpoint, options = {}) {
    const token = await dropboxTokenManager.getValidAccessToken();
    
    const isContentApi = endpoint.startsWith('/files/download') || endpoint.startsWith('/files/upload');
    const baseUrl = isContentApi ? 'https://content.dropboxapi.com/2' : 'https://api.dropboxapi.com/2';
    
    // Przygotuj nagłówki - WAŻNE: Authorization MUSI być w headers
    const headers = {
        'Authorization': `Bearer ${token}`,
        ...options.headers
    };
    
    // Jeśli nie ma Content-Type i nie jest to upload/download, dodaj domyślny
    if (!headers['Content-Type'] && !isContentApi) {
        headers['Content-Type'] = 'application/json';
    }
    
    const url = `${baseUrl}${endpoint}`;
    
    // Loguj tylko w trybie debug (nie przy każdym requeście)
    if (process.env.DEBUG_DROPBOX) {
        console.log(`📡 Dropbox API: ${endpoint}`);
    }
    
    const fetchOptions = {
        method: options.method || 'POST',
        headers: headers
    };
    
    // Dodaj body tylko jeśli istnieje
    if (options.body !== undefined) {
        fetchOptions.body = options.body;
    }
    
    const response = await fetch(url, fetchOptions);
    
    // Jeśli 401, spróbuj odświeżyć token i ponowić (tylko raz)
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

// Zapisz plik do Dropbox (tekstowy/JSON)
async function saveToDropbox(dropboxPath, content) {
    try {
        const buffer = Buffer.from(content, 'utf-8');
        const fullPath = `${DROPBOX_CONFIG.basePath}${dropboxPath}`;
        
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

// Odczytaj plik z Dropbox (tekstowy/JSON)
async function loadFromDropbox(dropboxPath, defaultValue = null) {
    try {
        const fullPath = `${DROPBOX_CONFIG.basePath}${dropboxPath}`;
        
        const response = await dropboxApiRequest('/files/download', {
            method: 'POST',
            headers: {
                'Dropbox-API-Arg': JSON.stringify({
                    path: fullPath
                })
            }
        });
        
        if (response.status === 409) {
            return defaultValue;
        }
        
        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Dropbox download error: ${error}`);
        }
        
        const content = await response.text();
        return JSON.parse(content);
    } catch (error) {
        if (error.message.includes('not_found') || error.message.includes('path_lookup') || error.message.includes('path/not_found')) {
            return defaultValue;
        }
        console.error(`❌ Błąd odczytu z Dropbox (${dropboxPath}):`, error.message);
        return defaultValue;
    }
}

// Usuń plik z Dropbox
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

// Lista plików w folderze Dropbox
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
                // Folder nie istnieje - utwórz go
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

// Utwórz folder w Dropbox
async function createDropboxFolder(dropboxPath) {
    try {
        const fullPath = `${DROPBOX_CONFIG.basePath}${dropboxPath}`;
        
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
        
        return true;
    } catch (error) {
        console.error(`❌ Błąd tworzenia folderu Dropbox (${dropboxPath}):`, error.message);
        throw error;
    }
}

// Zapisz binarny plik (obraz) do Dropbox
async function saveBinaryToDropbox(dropboxPath, buffer, mimeType) {
    try {
        const fullPath = `${DROPBOX_CONFIG.basePath}${dropboxPath}`;
        
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
        console.log(`✅ Zapisano binarny plik do Dropbox: ${dropboxPath}`);
        return result;
    } catch (error) {
        console.error(`❌ Błąd zapisu binarnego do Dropbox (${dropboxPath}):`, error.message);
        throw error;
    }
}

// Pobierz URL do pliku w Dropbox
async function getDropboxTemporaryLink(dropboxPath) {
    try {
        const fullPath = `${DROPBOX_CONFIG.basePath}${dropboxPath}`;
        
        const response = await dropboxApiRequest('/files/get_temporary_link', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                path: fullPath
            })
        });
        
        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Dropbox link error: ${error}`);
        }
        
        const data = await response.json();
        return data.link;
    } catch (error) {
        console.error(`❌ Błąd pobierania linku Dropbox (${dropboxPath}):`, error.message);
        return null;
    }
}

// Inicjalizacja struktury folderów w Dropbox
async function initDropboxStructure() {
    console.log('📁 Inicjalizacja struktury folderów w Dropbox...');
    
    const folders = [
        '/global',
        '/users',
        '/chats',
        '/screenshots',
        '/icons',
        '/temp',
        '/backups'
    ];
    
    for (const folder of folders) {
        try {
            await createDropboxFolder(folder);
        } catch (err) {
            console.error(`❌ Nie udało się utworzyć folderu ${folder}:`, err.message);
        }
    }
    
    // Inicjalizacja domyślnych plików globalnych
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
    
    console.log('✅ Struktura Dropbox gotowa');
}

// === KONFIGURACJA BACKUPU ===
const BACKUP_CONFIG = {
    maxBackups: 24,
    folders: [
        '/global',
        '/users',
        '/chats'
    ]
};

// === FUNKCJE BACKUP ===

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
                .setTitle('💾 Ręczny Backup')
                .setDescription(`Backup wykonany pomyślnie`)
                .addFields(
                    { name: 'ID', value: timestamp, inline: true },
                    { name: 'Foldery', value: backupResults.success.length.toString(), inline: true },
                    { name: 'Status', value: '✅ OK', inline: true }
                )
                .setColor(0x00ff00)
                .setTimestamp();
            
            await sendDiscordNotification(embed);
        } else if (discordReady && backupResults.failed.length > 0) {
            const embed = new EmbedBuilder()
                .setTitle('⚠️ Backup z błędami')
                .setDescription(`Częściowy backup`)
                .addFields(
                    { name: 'ID', value: timestamp, inline: true },
                    { name: 'OK', value: backupResults.success.join(', ') || 'brak', inline: false },
                    { name: 'Błędy', value: backupResults.failed.join(', '), inline: false }
                )
                .setColor(0xffaa00)
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

async function restoreFromBackup(backupTimestamp) {
    const backupFolder = `/backups/backup_${backupTimestamp}`;
    
    console.log(`📥 Przywracanie z backupu: ${backupFolder}`);
    
    try {
        const metadata = await loadFromDropbox(`${backupFolder}/_metadata.json`, null);
        if (!metadata) {
            throw new Error('Backup nie istnieje lub jest uszkodzony');
        }
        
        for (const folder of BACKUP_CONFIG.folders) {
            const sourcePath = `${backupFolder}${folder}`;
            const destPath = folder;
            
            await copyDropboxFolder(
                `${DROPBOX_CONFIG.basePath}${sourcePath}`,
                `${DROPBOX_CONFIG.basePath}${destPath}`
            );
        }
        
        if (discordReady) {
            const embed = new EmbedBuilder()
                .setTitle('📥 Przywracanie z Backupu')
                .setDescription(`Dane przywrócone z backupu: ${backupTimestamp}`)
                .setColor(0x00d4ff)
                .setTimestamp();
            
            await sendDiscordNotification(embed);
        }
        
        console.log(`✅ Przywracanie zakończone: ${backupTimestamp}`);
        return true;
        
    } catch (error) {
        console.error('❌ Błąd przywracania:', error.message);
        throw error;
    }
}

async function listBackups() {
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
        
        return backupList.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    } catch (error) {
        console.error('❌ Błąd listowania backupów:', error.message);
        return [];
    }
}

// === ENDPOINTY BACKUP ===

app.post('/api/backup/create', async (req, res) => {
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

app.get('/api/backup/list', async (req, res) => {
    try {
        const backups = await listBackups();
        res.json({
            success: true,
            backups: backups,
            total: backups.length,
            maxKept: BACKUP_CONFIG.maxBackups
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/backup/:timestamp', async (req, res) => {
    try {
        const metadata = await loadFromDropbox(`/backups/backup_${req.params.timestamp}/_metadata.json`, null);
        
        if (!metadata) {
            return res.status(404).json({ error: 'Backup not found' });
        }
        
        res.json({
            success: true,
            backup: metadata
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/backup/restore/:timestamp', async (req, res) => {
    try {
        const { confirm } = req.body;
        
        if (!confirm || confirm !== 'RESTORE') {
            return res.status(400).json({ 
                error: 'Confirmation required',
                message: 'Send {"confirm": "RESTORE"} to confirm data overwrite'
            });
        }
        
        await restoreFromBackup(req.params.timestamp);
        
        res.json({
            success: true,
            message: `Restored from backup: ${req.params.timestamp}`,
            warning: 'Cache may need refresh - consider restarting server'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/backup/:timestamp', async (req, res) => {
    try {
        const success = await deleteFromDropbox(`/backups/backup_${req.params.timestamp}`);
        
        if (success) {
            res.json({ success: true, message: 'Backup deleted' });
        } else {
            res.status(404).json({ error: 'Backup not found or could not be deleted' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/backup/status', async (req, res) => {
    try {
        const backups = await listBackups();
        const latest = backups[0];
        
        res.json({
            success: true,
            manualBackupOnly: true,
            maxBackupsKept: BACKUP_CONFIG.maxBackups,
            totalBackups: backups.length,
            latestBackup: latest || null
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Ścieżki lokalne (tylko dla tymczasowych uploadów)
const PATHS = {
    base: BASE_PATH,
    temp: path.join(BASE_PATH, 'temp')
};

// Middleware CORS
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    credentials: true,
    preflightContinue: false,
    optionsSuccessStatus: 204
}));

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Logowanie requestów (bez spamu)
app.use((req, res, next) => {
    // Nie loguj health checków i pingów
    if (req.path !== '/health' && !req.path.includes('dropbox')) {
        console.log(`${new Date().toISOString()} | ${req.method} ${req.path}`);
    }
    next();
});

// Konfiguracja multer dla tymczasowego zapisu plików
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
        GatewayIntentBits.GuildMessages
    ],
    rest: { timeout: 60000, retries: 3 }
});

let discordReady = false;
let isShuttingDown = false;

// Cache w pamięci
const gamesCache = new Map();
const connectedUsers = new Map();
const userSockets = new Map();
const typingUsers = new Map();

// === FUNKCJE STORAGE (DROPBOX) ===

async function initStorage() {
    console.log('📁 Inicjalizacja storage (Dropbox)...');
    
    try {
        await fs.mkdir(PATHS.temp, { recursive: true });
        await initDropboxStructure();
        console.log('✅ Storage gotowy (Dropbox)');
        return true;
    } catch (error) {
        console.error('❌ Błąd inicjalizacji storage:', error);
        await sendEmergencyNotification(`🚨 Błąd inicjalizacji Dropbox: ${error.message}`);
        return false;
    }
}

// === FUNKCJE UŻYTKOWNIKÓW (DROPBOX) ===

async function ensureUserDir(username) {
    try {
        await createDropboxFolder(`/users/${username}`);
        await createDropboxFolder(`/users/${username}/library`);
        await createDropboxFolder(`/users/${username}/friends`);
        await createDropboxFolder(`/users/${username}/settings`);
    } catch (err) {
        // Folder może już istnieć
    }
    return `/users/${username}`;
}

async function saveUserFile(username, filename, data) {
    await ensureUserDir(username);
    const dropboxPath = `/users/${username}/${filename}`;
    await saveToDropbox(dropboxPath, JSON.stringify(data, null, 2));
    return dropboxPath;
}

async function loadUserFile(username, filename, defaultData = {}) {
    const dropboxPath = `/users/${username}/${filename}`;
    return await loadFromDropbox(dropboxPath, defaultData);
}

// === FUNKCJE GLOBALNE (DROPBOX) ===

async function saveGlobalFile(filename, data) {
    const dropboxPath = `/global/${filename}`;
    await saveToDropbox(dropboxPath, JSON.stringify(data, null, 2));
    
    if (discordReady && ['users.json', 'games.json'].includes(filename)) {
        try {
            await backupToGlobalData(filename, data);
        } catch (err) {
            console.log('⚠️ Backup na Discord nie powiódł się:', err.message);
        }
    }
    
    return dropboxPath;
}

async function loadGlobalFile(filename, defaultData = {}) {
    const dropboxPath = `/global/${filename}`;
    let data = await loadFromDropbox(dropboxPath, null);
    
    if (data === null && discordReady) {
        try {
            data = await restoreFromGlobalData(filename);
            if (data) {
                await saveToDropbox(dropboxPath, JSON.stringify(data, null, 2));
                console.log(`📥 Przywrócono ${filename} z backupu Discord`);
            }
        } catch (err) {
            console.log('⚠️ Przywracanie z Discord nie powiodło się:', err.message);
        }
    }
    
    return data !== null ? data : defaultData;
}

// === FUNKCJE CZATU (DROPBOX) ===

async function saveChatFile(user1, user2, data) {
    const sorted = [user1, user2].sort();
    const chatId = `${sorted[0]}_and_${sorted[1]}`;
    const dropboxPath = `/chats/${chatId}.json`;
    await saveToDropbox(dropboxPath, JSON.stringify(data, null, 2));
    return chatId;
}

async function loadChatFile(user1, user2) {
    const sorted = [user1, user2].sort();
    const chatId = `${sorted[0]}_and_${sorted[1]}`;
    const dropboxPath = `/chats/${chatId}.json`;
    return await loadFromDropbox(dropboxPath, { participants: [user1, user2], messages: [] });
}

// === BACKUP AWARYJNY NA DISCORD ===

async function backupToGlobalData(filename, data) {
    if (!discordReady) return;
    
    try {
        const channel = await discordClient.channels.fetch(GLOBAL_DATA_CHANNEL_ID);
        if (!channel) return;
        
        const messages = await channel.messages.fetch({ limit: 50 });
        const oldMessages = messages.filter(m => 
            m.content.includes(`[BACKUP] ${filename}`)
        );
        
        for (const msg of oldMessages.values()) {
            await msg.delete().catch(() => {});
        }
        
        const { AttachmentBuilder } = require('discord.js');
        const buffer = Buffer.from(JSON.stringify(data, null, 2));
        const attachment = new AttachmentBuilder(buffer, { name: filename });
        
        await channel.send({
            content: `[BACKUP] ${filename} | ${new Date().toISOString()}`,
            files: [attachment]
        });
        
        console.log(`💾 Backup ${filename} wysłany na Discord`);
    } catch (error) {
        console.error('❌ Błąd backupu Discord:', error.message);
    }
}

async function restoreFromGlobalData(filename) {
    if (!discordReady) return null;
    
    try {
        const channel = await discordClient.channels.fetch(GLOBAL_DATA_CHANNEL_ID);
        if (!channel) return null;
        
        const messages = await channel.messages.fetch({ limit: 50 });
        const backupMsg = messages.find(m => 
            m.content.includes(`[BACKUP] ${filename}`) &&
            m.attachments.size > 0
        );
        
        if (!backupMsg) return null;
        
        const attachment = backupMsg.attachments.first();
        const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
        const response = await fetch(attachment.url);
        const data = await response.json();
        
        return data;
    } catch (error) {
        console.error('❌ Błąd przywracania z Discord:', error.message);
        return null;
    }
}

// === POWIADOMIENIA DISCORD ===

async function sendDiscordNotification(embed) {
    if (!discordReady) {
        return;
    }
    
    try {
        const channel = await discordClient.channels.fetch(NOTIFICATION_CHANNEL_ID);
        if (!channel) {
            return;
        }
        
        await channel.send({ embeds: [embed] });
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

// === WEBSOCKET ===

io.on('connection', (socket) => {
    console.log(`🔌 Nowe połączenie: ${socket.id}`);
    
    socket.on('authenticate', async (data) => {
        try {
            console.log('🔐 Próba autentykacji:', data);
            const { token, guildId } = data;
            
            const users = await loadGlobalFile('users.json', {});
            const user = Object.values(users).find(u => u.token === token);
            
            if (!user) {
                console.log('❌ Autentykacja nieudana - nieprawidłowy token');
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
            
            broadcastToFriends(user.username, 'friend_status_change', {
                username: user.username,
                status: 'online',
                timestamp: new Date().toISOString()
            });
            
            console.log(`✅ Socket autentykowany: ${user.username}`);
            
        } catch (error) {
            console.error('❌ Błąd autentykacji:', error);
            socket.emit('auth_error', { message: error.message });
        }
    });
    
    socket.on('status_change', (data) => {
        if (!socket.authenticated) return;
        
        const userData = connectedUsers.get(socket.id);
        if (!userData) return;
        
        userData.status = data.status;
        userData.activity = data.activity;
        
        broadcastToFriends(socket.username, 'friend_status_change', {
            username: socket.username,
            status: data.status,
            activity: data.activity,
            timestamp: new Date().toISOString()
        });
    });
    
    socket.on('send_message', async (data) => {
        if (!socket.authenticated) return;
        
        try {
            const { toUser, content, tempId } = data;
            
            let chat = await loadChatFile(socket.username, toUser);
            const messageData = {
                id: crypto.randomUUID(),
                sender: socket.username,
                content: content.trim(),
                timestamp: new Date().toISOString(),
                read: false
            };
            
            chat.messages.push(messageData);
            if (chat.messages.length > 500) chat.messages = chat.messages.slice(-500);
            
            await saveChatFile(socket.username, toUser, chat);
            
            socket.emit('message_sent', {
                tempId: tempId,
                messageId: messageData.id,
                timestamp: messageData.timestamp,
                toUser: toUser
            });
            
            broadcastToUser(toUser, 'new_message', {
                message: messageData,
                fromUser: socket.username
            });
            
        } catch (error) {
            socket.emit('message_error', { tempId: data.tempId, error: error.message });
        }
    });
    
    socket.on('typing', (data) => {
        if (!socket.authenticated) return;
        
        const chatId = [socket.username, data.toUser].sort().join('-');
        if (!typingUsers.has(chatId)) {
            typingUsers.set(chatId, new Set());
        }
        typingUsers.get(chatId).add(socket.username);
        
        broadcastToUser(data.toUser, 'typing', {
            fromUser: socket.username,
            chatId: chatId
        });
        
        setTimeout(() => {
            if (typingUsers.has(chatId)) {
                typingUsers.get(chatId).delete(socket.username);
                if (typingUsers.get(chatId).size === 0) typingUsers.delete(chatId);
            }
        }, 5000);
    });
    
    socket.on('stop_typing', (data) => {
        if (!socket.authenticated) return;
        
        const chatId = [socket.username, data.toUser].sort().join('-');
        if (typingUsers.has(chatId)) {
            typingUsers.get(chatId).delete(socket.username);
            if (typingUsers.get(chatId).size === 0) typingUsers.delete(chatId);
        }
        
        broadcastToUser(data.toUser, 'stop_typing', {
            fromUser: socket.username,
            chatId: chatId
        });
    });
    
    socket.on('friend_request_sent', async (data) => {
        if (!socket.authenticated) return;
        
        try {
            const { toUser } = data;
            const users = await loadGlobalFile('users.json', {});
            
            if (!users[toUser]) {
                socket.emit('friend_error', { message: 'User not found' });
                return;
            }
            
            const toData = await loadUserFile(toUser, 'friends/friends.json', { friends: [], pendingInvites: [] });
            
            const alreadyPending = toData.pendingInvites?.find(p => p.from === socket.username);
            const alreadyFriends = toData.friends?.includes(socket.username);
            
            if (!alreadyPending && !alreadyFriends) {
                if (!toData.pendingInvites) toData.pendingInvites = [];
                toData.pendingInvites.push({
                    from: socket.username,
                    timestamp: new Date().toISOString()
                });
                
                await saveUserFile(toUser, 'friends/friends.json', toData);
                
                broadcastToUser(toUser, 'friend_request', {
                    from: socket.username,
                    timestamp: new Date().toISOString()
                });
                
                socket.emit('friend_request_sent_success', { 
                    toUser, 
                    timestamp: new Date().toISOString() 
                });
                
                try {
                    const embed = new EmbedBuilder()
                        .setTitle('👥 Nowe zaproszenie')
                        .setDescription(`**${socket.username}** → **${toUser}**`)
                        .setColor(0x00d4ff)
                        .setTimestamp();
                    
                    await sendDiscordNotification(embed);
                } catch (err) {
                    console.log('Powiadomienie Discord nie wysłane:', err.message);
                }
            } else {
                socket.emit('friend_error', { message: 'Already pending or friends' });
            }
            
        } catch (error) {
            socket.emit('friend_error', { message: error.message });
        }
    });
    
    socket.on('friend_respond', async (data) => {
        if (!socket.authenticated) return;
        
        try {
            const { fromUser, accept } = data;
            
            const userData = await loadUserFile(socket.username, 'friends/friends.json', { 
                friends: [], 
                pendingInvites: [] 
            });
            
            const fromData = await loadUserFile(fromUser, 'friends/friends.json', { 
                friends: [], 
                pendingInvites: [] 
            });
            
            userData.pendingInvites = (userData.pendingInvites || []).filter(p => p.from !== fromUser);
            
            if (accept) {
                if (!userData.friends) userData.friends = [];
                if (!fromData.friends) fromData.friends = [];
                
                if (!userData.friends.includes(fromUser)) userData.friends.push(fromUser);
                if (!fromData.friends.includes(socket.username)) fromData.friends.push(socket.username);
                
                await saveChatFile(socket.username, fromUser, {
                    participants: [socket.username, fromUser],
                    messages: []
                });
                
                broadcastToUser(fromUser, 'friend_accepted', {
                    by: socket.username,
                    timestamp: new Date().toISOString()
                });
            }
            
            await saveUserFile(socket.username, 'friends/friends.json', userData);
            await saveUserFile(fromUser, 'friends/friends.json', fromData);
            
        } catch (error) {
            socket.emit('friend_error', { message: error.message });
        }
    });
    
    socket.on('disconnect', (reason) => {
        console.log(`🔌 Rozłączenie: ${socket.id}, powód: ${reason}`);
        
        if (socket.authenticated && socket.username) {
            const sockets = userSockets.get(socket.username);
            if (sockets) {
                sockets.delete(socket.id);
                if (sockets.size === 0) {
                    userSockets.delete(socket.username);
                    broadcastToFriends(socket.username, 'friend_status_change', {
                        username: socket.username,
                        status: 'offline',
                        timestamp: new Date().toISOString()
                    });
                }
            }
        }
        connectedUsers.delete(socket.id);
    });
    
    socket.on('ping', () => socket.emit('pong'));
});

// Funkcje broadcast
function broadcastToUser(username, event, data) {
    const sockets = userSockets.get(username);
    if (!sockets) return;
    
    sockets.forEach(socketId => {
        const socket = io.sockets.sockets.get(socketId);
        if (socket) socket.emit(event, data);
    });
}

function broadcastToFriends(username, event, data) {
    loadUserFile(username, 'friends/friends.json', { friends: [] }).then(friendsData => {
        (friendsData.friends || []).forEach(friend => {
            broadcastToUser(friend, event, { ...data, friendUsername: username });
        });
    }).catch(err => console.error('Błąd broadcastToFriends:', err));
}

function broadcastToGuild(guildId, event, data) {
    connectedUsers.forEach((userData, socketId) => {
        if (userData.guildId === guildId) {
            const socket = io.sockets.sockets.get(socketId);
            if (socket) socket.emit(event, data);
        }
    });
}

// === ENDPOINTY HTTP ===

// Health check
app.get('/health', async (req, res) => {
    const username = req.query.username;
    
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
        uptime: process.uptime(),
        memory: process.memoryUsage()
    };

    if (username) {
        try {
            const data = await loadUserFile(username, 'friends/friends.json', { pendingInvites: [] });
            response.hasPendingInvites = (data.pendingInvites || []).length > 0;
            response.pendingInvitesCount = (data.pendingInvites || []).length;
        } catch (e) {
            response.friendsError = e.message;
        }
    }
    
    res.json(response);
});

// Test CORS
app.get('/test', (req, res) => {
    res.json({ 
        message: 'CORS działa!', 
        origin: req.headers.origin,
        time: new Date().toISOString()
    });
});

// Endpoint testowy Dropbox
app.get('/api/dropbox/test', async (req, res) => {
    try {
        const response = await dropboxApiRequest('/users/get_current_account', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(null)
        });
        
        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Dropbox API error: ${error}`);
        }
        
        const data = await response.json();
        res.json({
            success: true,
            account: {
                name: data.name.display_name,
                email: data.email,
                account_id: data.account_id
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Ręczne odświeżenie tokena
app.post('/api/dropbox/refresh', async (req, res) => {
    try {
        await dropboxTokenManager.refreshAccessToken();
        res.json({
            success: true,
            message: 'Token odświeżony',
            expiresAt: new Date(dropboxTokenManager.expiresAt).toISOString()
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Lista plików w Dropbox (debug)
app.get('/api/dropbox/list/*', async (req, res) => {
    try {
        const folderPath = '/' + req.params[0];
        const files = await listDropboxFolder(folderPath);
        res.json({
            success: true,
            path: folderPath,
            files: files.map(f => ({
                name: f.name,
                path: f.path_display,
                size: f.size,
                modified: f.server_modified
            }))
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Serwowanie plików statycznych
app.get('/', async (req, res) => {
    try {
        const indexPath = path.join(__dirname, 'index.html');
        const html = await fs.readFile(indexPath, 'utf-8');
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
    } catch {
        res.json({ 
            message: 'Nebula Game Server',
            status: 'online',
            discord: discordReady,
            dropbox: !!dropboxTokenManager.accessToken,
            endpoints: ['/games', '/api/auth/login', '/api/auth/register', '/health']
        });
    }
});

['admin', 'game', 'login', 'friends', 'library'].forEach(page => {
    app.get(`/${page}.html`, async (req, res) => {
        try {
            const filePath = path.join(__dirname, `${page}.html`);
            const html = await fs.readFile(filePath, 'utf-8');
            res.setHeader('Content-Type', 'text/html');
            res.send(html);
        } catch (error) {
            res.status(500).send(`Błąd: ${error.message}`);
        }
    });
});

// === GRY ===

app.get('/games', async (req, res) => {
    try {
        const games = await loadGlobalFile('games.json', []);
        gamesCache.set(DEFAULT_GUILD_ID, games);
        res.json(games);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/games/:id', async (req, res) => {
    try {
        const games = await loadGlobalFile('games.json', []);
        const game = games.find(g => g.id === req.params.id);
        if (!game) return res.status(404).json({ error: 'Game not found' });
        res.json(game);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/games', async (req, res) => {
    try {
        const { name, description, developer, price, icon, iconUrl, color, 
                pegi, download_url, size, requirements, screenshots, genre, 
                releaseDate, publisher, version, language } = req.body;
        
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
        gamesCache.set(DEFAULT_GUILD_ID, games);
        
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
        
        broadcastToGuild(DEFAULT_GUILD_ID, 'new_game', {
            game: gameData,
            timestamp: new Date().toISOString()
        });
        
        res.json({ success: true, game: gameData });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/games/:id', async (req, res) => {
    try {
        const games = await loadGlobalFile('games.json', []);
        const existing = games.find(g => g.id === req.params.id);
        
        if (!existing) return res.status(404).json({ error: 'Game not found' });
        
        const updated = { ...existing, ...req.body, updatedAt: new Date().toISOString() };
        const index = games.findIndex(g => g.id === req.params.id);
        games[index] = updated;
        
        await saveGlobalFile('games.json', games);
        gamesCache.set(DEFAULT_GUILD_ID, games);
        
        res.json({ success: true, game: updated });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/games/:id', async (req, res) => {
    try {
        let games = await loadGlobalFile('games.json', []);
        const initialLength = games.length;
        
        games = games.filter(g => g.id !== req.params.id);
        
        if (games.length < initialLength) {
            await saveGlobalFile('games.json', games);
            gamesCache.set(DEFAULT_GUILD_ID, games);
            res.json({ success: true, message: 'Deleted' });
        } else {
            res.status(404).json({ success: false, message: 'Not found' });
        }
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// === AUTH ===

function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

app.post('/api/auth/register', async (req, res) => {
    console.log('📝 Próba rejestracji:', req.body);
    
    try {
        const { username, password, email } = req.body;
        
        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password required' });
        }
        
        const users = await loadGlobalFile('users.json', {});
        
        if (users[username]) {
            return res.status(409).json({ error: 'User exists' });
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
        
        await saveGlobalFile('users.json', users);
        await ensureUserDir(username);
        await saveUserFile(username, 'library/library.json', { games: [] });
        await saveUserFile(username, 'friends/friends.json', { friends: [], pendingInvites: [] });
        
        console.log('✅ Użytkownik zarejestrowany:', username);
        
        try {
            const embed = new EmbedBuilder()
                .setTitle('👤 Nowy użytkownik')
                .setDescription(`**${username}** dołączył do systemu!`)
                .setColor(0x00ff88)
                .setTimestamp();
            
            await sendDiscordNotification(embed);
        } catch (notifyErr) {
            console.log('ℹ️ Powiadomienie Discord nie wysłane:', notifyErr.message);
        }
        
        res.json({ success: true, token, userId: users[username].id });
        
    } catch (error) {
        console.error('❌ Błąd rejestracji:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    console.log('🔑 Próba logowania:', req.body.username);
    
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
        
        await saveGlobalFile('users.json', users);
        
        const friendsData = await loadUserFile(username, 'friends/friends.json', { pendingInvites: [] });
        
        console.log('✅ Zalogowano:', username);
        
        res.json({
            success: true,
            token,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                hasPendingInvites: (friendsData.pendingInvites || []).length > 0
            }
        });
        
    } catch (error) {
        console.error('❌ Błąd logowania:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/auth/verify', async (req, res) => {
    try {
        const auth = req.headers.authorization;
        if (!auth?.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'No token' });
        }
        
        const token = auth.substring(7);
        const users = await loadGlobalFile('users.json', {});
        
        const user = Object.values(users).find(u => u.token === token);
        if (!user) return res.status(401).json({ error: 'Invalid token' });
        
        const friendsData = await loadUserFile(user.username, 'friends/friends.json', { pendingInvites: [] });
        
        res.json({
            valid: true,
            userId: user.id,
            username: user.username,
            hasPendingInvites: (friendsData.pendingInvites || []).length > 0
        });
        
    } catch (error) {
        res.status(403).json({ error: error.message });
    }
});

// === ZNAJOMI ===

app.get('/api/friends/:username', async (req, res) => {
    try {
        const data = await loadUserFile(req.params.username, 'friends/friends.json', { 
            friends: [], 
            pendingInvites: [] 
        });
        
        const users = await loadGlobalFile('users.json', {});
        
        const friends = (data.friends || []).map(name => ({
            username: name,
            status: userSockets.has(name) ? 'online' : 'offline',
            lastSeen: users[name]?.lastLogin
        }));
        
        res.json({
            friends,
            pendingInvites: data.pendingInvites || []
        });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/friends/add', async (req, res) => {
    try {
        const { fromUser, toUser } = req.body;
        const users = await loadGlobalFile('users.json', {});
        
        if (!users[toUser]) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const toData = await loadUserFile(toUser, 'friends/friends.json', { 
            friends: [], 
            pendingInvites: [] 
        });
        
        const alreadyPending = toData.pendingInvites?.find(p => p.from === fromUser);
        const alreadyFriends = toData.friends?.includes(fromUser);
        
        if (!alreadyPending && !alreadyFriends) {
            if (!toData.pendingInvites) toData.pendingInvites = [];
            toData.pendingInvites.push({
                from: fromUser,
                timestamp: new Date().toISOString()
            });
            
            await saveUserFile(toUser, 'friends/friends.json', toData);
            
            broadcastToUser(toUser, 'friend_request', {
                from: fromUser,
                timestamp: new Date().toISOString()
            });
        }
        
        res.json({ success: true });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/friends/respond', async (req, res) => {
    try {
        const { username, fromUser, accept } = req.body;
        
        const userData = await loadUserFile(username, 'friends/friends.json', { 
            friends: [], 
            pendingInvites: [] 
        });
        
        const fromData = await loadUserFile(fromUser, 'friends/friends.json', { 
            friends: [], 
            pendingInvites: [] 
        });
        
        userData.pendingInvites = (userData.pendingInvites || []).filter(p => p.from !== fromUser);
        
        if (accept) {
            if (!userData.friends) userData.friends = [];
            if (!fromData.friends) fromData.friends = [];
            
            if (!userData.friends.includes(fromUser)) userData.friends.push(fromUser);
            if (!fromData.friends.includes(username)) fromData.friends.push(username);
            
            await saveChatFile(username, fromUser, {
                participants: [username, fromUser],
                messages: []
            });
            
            broadcastToUser(fromUser, 'friend_accepted', {
                by: username,
                timestamp: new Date().toISOString()
            });
        }
        
        await saveUserFile(username, 'friends/friends.json', userData);
        await saveUserFile(fromUser, 'friends/friends.json', fromData);
        
        res.json({ success: true, accepted: accept });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/friends/remove', async (req, res) => {
    try {
        const { username, friendName } = req.body;
        
        const userData = await loadUserFile(username, 'friends/friends.json', { friends: [] });
        const friendData = await loadUserFile(friendName, 'friends/friends.json', { friends: [] });
        
        userData.friends = (userData.friends || []).filter(f => f !== friendName);
        friendData.friends = (friendData.friends || []).filter(f => f !== username);
        
        await saveUserFile(username, 'friends/friends.json', userData);
        await saveUserFile(friendName, 'friends/friends.json', friendData);
        
        res.json({ success: true });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// === CZAT ===

app.get('/api/chat/:user1/:user2', async (req, res) => {
    try {
        const data = await loadChatFile(req.params.user1, req.params.user2);
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/chat/send', async (req, res) => {
    try {
        const { fromUser, toUser, content } = req.body;
        
        let chat = await loadChatFile(fromUser, toUser);
        
        const messageData = {
            id: crypto.randomUUID(),
            sender: fromUser,
            content: content.trim(),
            timestamp: new Date().toISOString(),
            read: false
        };
        
        chat.messages.push(messageData);
        if (chat.messages.length > 500) chat.messages = chat.messages.slice(-500);
        
        await saveChatFile(fromUser, toUser, chat);
        
        broadcastToUser(toUser, 'new_message', {
            message: messageData,
            fromUser: fromUser
        });
        
        res.json({ success: true, message: messageData });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// === BIBLIOTEKA ===

app.get('/api/users/:username/library', async (req, res) => {
    try {
        const lib = await loadUserFile(req.params.username, 'library/library.json', { games: [] });
        const games = await loadGlobalFile('games.json', []);
        
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
    try {
        const { gameId } = req.body;
        const games = await loadGlobalFile('games.json', []);
        
        if (!games.find(g => g.id === gameId)) {
            return res.status(404).json({ error: 'Game not found' });
        }
        
        const lib = await loadUserFile(req.params.username, 'library/library.json', { games: [] });
        
        if (!lib.games.find(g => g.gameId === gameId)) {
            lib.games.push({
                gameId,
                addedAt: new Date().toISOString(),
                installed: false,
                playTime: 0
            });
            await saveUserFile(req.params.username, 'library/library.json', lib);
        }
        
        res.json({ success: true, library: lib.games });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/users/:username/library/:gameId', async (req, res) => {
    try {
        const lib = await loadUserFile(req.params.username, 'library/library.json', { games: [] });
        
        const initialLength = lib.games.length;
        lib.games = lib.games.filter(g => g.gameId !== req.params.gameId);
        
        if (lib.games.length === initialLength) {
            return res.status(404).json({ error: 'Game not in library' });
        }
        
        await saveUserFile(req.params.username, 'library/library.json', lib);
        res.json({ success: true });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// === KOMENTARZE I OCENY ===

app.get('/api/games/:gameId/comments', async (req, res) => {
    try {
        const allComments = await loadGlobalFile('comments.json', {});
        const comments = allComments[req.params.gameId] || [];
        
        res.json({ success: true, comments, total: comments.length });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/games/:gameId/comments', async (req, res) => {
    try {
        const { username, content, rating } = req.body;
        
        const users = await loadGlobalFile('users.json', {});
        const user = users[username];
        const authHeader = req.headers.authorization;
        
        if (!user || !authHeader?.startsWith('Bearer ') || user.token !== authHeader.substring(7)) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        
        const comment = {
            id: crypto.randomUUID(),
            username,
            content: content.trim(),
            rating: rating || null,
            createdAt: new Date().toISOString(),
            likes: 0,
            dislikes: 0
        };
        
        const allComments = await loadGlobalFile('comments.json', {});
        if (!allComments[req.params.gameId]) allComments[req.params.gameId] = [];
        
        allComments[req.params.gameId].unshift(comment);
        await saveGlobalFile('comments.json', allComments);
        
        try {
            const games = await loadGlobalFile('games.json', []);
            const game = games.find(g => g.id === req.params.gameId);
            
            if (game) {
                const embed = new EmbedBuilder()
                    .setTitle('💬 Nowy komentarz')
                    .setDescription(`**${username}** skomentował **${game.name}**`)
                    .addFields({ 
                        name: 'Komentarz', 
                        value: content.substring(0, 100) + (content.length > 100 ? '...' : '') 
                    })
                    .setColor(0x00d4ff)
                    .setTimestamp();
                
                await sendDiscordNotification(embed);
            }
        } catch (err) {
            console.log('Powiadomienie Discord nie wysłane:', err.message);
        }
        
        broadcastToGuild(DEFAULT_GUILD_ID, 'new_comment', {
            gameId: req.params.gameId,
            comment: comment
        });
        
        res.json({ success: true, comment });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/games/:gameId/comments/:commentId', async (req, res) => {
    try {
        const { username } = req.body;
        
        const users = await loadGlobalFile('users.json', {});
        const user = users[username];
        const authHeader = req.headers.authorization;
        
        if (!user || !authHeader?.startsWith('Bearer ') || user.token !== authHeader.substring(7)) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        
        const allComments = await loadGlobalFile('comments.json', {});
        const comments = allComments[req.params.gameId] || [];
        const comment = comments.find(c => c.id === req.params.commentId);
        
        if (!comment) return res.status(404).json({ error: 'Comment not found' });
        if (comment.username !== username) {
            return res.status(403).json({ error: 'Can only delete your own comments' });
        }
        
        allComments[req.params.gameId] = comments.filter(c => c.id !== req.params.commentId);
        await saveGlobalFile('comments.json', allComments);
        
        res.json({ success: true });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/games/:gameId/rate', async (req, res) => {
    try {
        const { username, rating } = req.body;
        
        if (!rating || rating < 1 || rating > 5) {
            return res.status(400).json({ error: 'Rating must be 1-5' });
        }
        
        const users = await loadGlobalFile('users.json', {});
        const user = users[username];
        const authHeader = req.headers.authorization;
        
        if (!user || !authHeader?.startsWith('Bearer ') || user.token !== authHeader.substring(7)) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        
        const allRatings = await loadGlobalFile('ratings.json', {});
        if (!allRatings[req.params.gameId]) allRatings[req.params.gameId] = {};
        
        allRatings[req.params.gameId][username] = {
            rating,
            ratedAt: new Date().toISOString()
        };
        
        await saveGlobalFile('ratings.json', allRatings);
        
        const ratings = Object.values(allRatings[req.params.gameId]).map(r => r.rating);
        const average = ratings.reduce((a, b) => a + b, 0) / ratings.length;
        
        broadcastToGuild(DEFAULT_GUILD_ID, 'new_rating', {
            gameId: req.params.gameId,
            username,
            rating,
            averageRating: Math.round(average * 10) / 10,
            totalRatings: ratings.length
        });
        
        res.json({
            success: true,
            yourRating: rating,
            averageRating: Math.round(average * 10) / 10,
            totalRatings: ratings.length
        });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/games/:gameId/ratings', async (req, res) => {
    try {
        const allRatings = await loadGlobalFile('ratings.json', {});
        const ratings = allRatings[req.params.gameId] || {};
        
        const values = Object.values(ratings).map(r => r.rating);
        const average = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
        
        const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
        values.forEach(r => distribution[r] = (distribution[r] || 0) + 1);
        
        res.json({
            success: true,
            averageRating: Math.round(average * 10) / 10,
            totalRatings: values.length,
            distribution,
            yourRating: req.query.username ? ratings[req.query.username]?.rating : null
        });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// === UPLOAD PLIKÓW DO DROPBOX (STAŁE LINKI - NIGDY NIE WYGASAJĄ) ===

// NOWA FUNKCJA: Utwórz STAŁY link udostępniania (nigdy nie wygasa)
async function createPermanentDropboxLink(dropboxPath) {
    try {
        const fullPath = `${DROPBOX_CONFIG.basePath}${dropboxPath}`;
        
        console.log(`🔗 Tworzenie stałego linku dla: ${fullPath}`);
        
        // Najpierw sprawdź czy link już istnieje
        const existingLinks = await listSharedLinks(fullPath);
        if (existingLinks.length > 0) {
            const link = existingLinks[0].url.replace('?dl=0', '?dl=1');
            console.log(`✅ Znaleziono istniejący stały link`);
            return link;
        }
        
        // Utwórz nowy link udostępniania
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
            // Jeśli link już istnieje (409), pobierz go
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
        // Zamień na bezpośredni link do pobrania (?dl=1)
        const directLink = data.url.replace('?dl=0', '?dl=1');
        
        console.log(`✅ Utworzono nowy stały link`);
        return directLink;
        
    } catch (error) {
        console.error(`❌ Błąd tworzenia stałego linku (${dropboxPath}):`, error.message);
        throw error;
    }
}

// NOWA FUNKCJA: Lista istniejących linków udostępniania
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

// POPRAWIONA FUNKCJA: Zapisz plik i zwróć STAŁY link - z lepszą obsługą błędów
async function saveBinaryToDropboxWithPermanentLink(dropboxPath, buffer, mimeType) {
    try {
        const fullPath = `${DROPBOX_CONFIG.basePath}${dropboxPath}`;
        
        console.log(`📤 Upload do Dropbox: ${dropboxPath} (${buffer.length} bajtów)`);
        
        // 1. Zapisz plik
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
            const errorText = await uploadResponse.text();
            throw new Error(`Dropbox upload error: ${errorText}`);
        }
        
        const uploadResult = await uploadResponse.json();
        console.log(`✅ Plik zapisany: ${uploadResult.name}`);
        
        // 2. Utwórz STAŁY link (zamiast tymczasowego)
        let permanentUrl;
        try {
            permanentUrl = await createPermanentDropboxLink(dropboxPath);
        } catch (linkError) {
            console.error('❌ Błąd tworzenia linku, próbuję ponownie za 1s...');
            await new Promise(r => setTimeout(r, 1000));
            permanentUrl = await createPermanentDropboxLink(dropboxPath);
        }
        
        return {
            uploadResult: uploadResult,
            permanentUrl: permanentUrl
        };
        
    } catch (error) {
        console.error(`❌ Błąd zapisu pliku (${dropboxPath}):`, error.message);
        throw error;
    }
}

// Upload ikony - STAŁY LINK
app.post('/api/upload/icon', upload.single('icon'), async (req, res) => {
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
        console.error('❌ Błąd uploadu ikony:', error.message);
        res.status(500).json({ error: error.message, details: error.stack });
    }
});

// Upload pojedynczego screenshotu - STAŁY LINK (POPRAWIONY)
app.post('/api/upload/screenshot', upload.single('screenshot'), async (req, res) => {
    try {
        const { gameId } = req.query;
        
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        
        console.log(`📸 Otrzymano screenshot: ${req.file.originalname}, size: ${req.file.size}, gameId: ${gameId}`);
        
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
            uploadedAt: new Date().toISOString(),
            uploadedBy: req.headers['x-username'] || 'unknown'
        });
        
        await saveGlobalFile('screenshots.json', screenshots);
        
        console.log(`✅ Screenshot zapisany: ${screenshotId}`);
        
        res.json({
            success: true,
            url: result.permanentUrl,
            screenshotId: screenshotId,
            message: 'Screenshot uploaded with permanent link (never expires)'
        });
        
    } catch (error) {
        console.error('❌ Błąd uploadu screenshotu:', error.message);
        res.status(500).json({ error: error.message, details: error.stack });
    }
});

// Upload wielu screenshotów - STAŁE LINKI
app.post('/api/upload/screenshots', upload.array('screenshots', 10), async (req, res) => {
    try {
        const { gameId } = req.query;
        
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: 'No files uploaded' });
        }
        
        console.log(`📸 Otrzymano ${req.files.length} screenshotów`);
        
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
        console.error('❌ Błąd uploadu screenshotów:', error.message);
        res.status(500).json({ error: error.message, details: error.stack });
    }
});

// Serwowanie plików - używa stałych linków z bazy
app.get('/dropbox-file/*', async (req, res) => {
    try {
        const dropboxPath = '/' + req.params[0];
        
        // Spróbuj najpierw pobrać stały link z bazy
        const screenshots = await loadGlobalFile('screenshots.json', []);
        const icons = await loadGlobalFile('icons.json', []);
        const allFiles = [...screenshots, ...icons];
        
        const fileRecord = allFiles.find(f => f.dropboxPath === dropboxPath);
        
        if (fileRecord && fileRecord.permanentUrl) {
            return res.redirect(fileRecord.permanentUrl);
        }
        
        // Jeśli nie ma stałego linku (stary plik), utwórz go
        const permanentLink = await createPermanentDropboxLink(dropboxPath);
        res.redirect(permanentLink);
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Pobierz screenshoty dla gry - zwraca STAŁE linki
app.get('/api/screenshots/:gameId', async (req, res) => {
    try {
        const screenshots = await loadGlobalFile('screenshots.json', []);
        const gameScreenshots = screenshots
            .filter(s => s.gameId === req.params.gameId)
            .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
        
        // Jeśli screenshoty mają już permanentUrl, użyj go
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
        
        // Zapisz zaktualizowane linki
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

// === START SERWERA ===

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Serwer HTTP + WebSocket na porcie ${PORT}`);
    console.log(`☁️ Dropbox Storage: ${DROPBOX_CONFIG.basePath}`);
    console.log(`🌐 Adres: http://localhost:${PORT}`);
    
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
                // Cichy ping - nie loguj
            });
            
            req.on('error', () => {});
            req.on('timeout', () => req.destroy());
            req.end();
            
        } catch (error) {
            // Ignoruj błędy ping
        }
    }, PING_INTERVAL);
});

// Inicjalizacja
console.log('📋 Server starting...');

dropboxTokenManager.initialize().then(() => {
    console.log('✅ Dropbox Token Manager gotowy');
    return initStorage();
}).then(() => {
    console.log('✅ Storage gotowy');
    
    if (DISCORD_TOKEN) {
        console.log('🔌 Łączenie z Discordem...');
        
        discordClient.once('ready', () => {
            console.log(`🤖 Bot: ${discordClient.user.tag}`);
            discordReady = true;
            
            discordClient.channels.fetch(NOTIFICATION_CHANNEL_ID)
                .then(ch => console.log(`📨 Kanał powiadomień OK: ${ch.name}`))
                .catch(err => console.log(`⚠️ Brak dostępu do kanału: ${err.message}`));
            
            sendDiscordNotification(
                new EmbedBuilder()
                    .setTitle('🟢 Serwer wystartował')
                    .setDescription(`Port: ${PORT}\nStorage: Dropbox\nPath: ${DROPBOX_CONFIG.basePath}`)
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

// Obsługa zamykania
process.on('SIGINT', () => {
    console.log('🛑 SIGINT received - shutting down gracefully');
    isShuttingDown = true;
    
    dropboxTokenManager.stop();
    
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
