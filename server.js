// =================================================================
// --- IMPORTY I KONFIGURACJA ---
// =================================================================
const { 
    Client, 
    GatewayIntentBits, 
    Partials, 
    Events, 
    EmbedBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    ModalBuilder, 
    TextInputBuilder, 
    TextInputStyle, 
    PermissionFlagsBits,
    ChannelType,
    ActivityType,
    InteractionType,
    AttachmentBuilder
} = require('discord.js');
const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const fs = require('fs').promises;
const path = require('path');
const { createCanvas } = require('canvas');
require('dotenv').config();

// =================================================================
// --- KONFIGURACJA SMTP I RÓL ---
// =================================================================
const SMTP_SERVER = "smtp.gmail.com";
const SMTP_PORT = 587;
const SMTP_USERNAME = process.env.SMTP_USERNAME || "twój_email@gmail.com";
const SMTP_PASSWORD = process.env.SMTP_PASSWORD || "twoje_hasło";

const MODERATOR_ROLE_IDS = ['1472542200796807199', '1472241496987144345', '1472542334150377493'];
const TRUSTED_ROLE_ID = '1472542334150377493';
const SUPPORT_ROLE_ID = '1472542200796807199';
const ID_KANAŁU_TICKET_PANEL = '1471836884622905538';
const ID_ROLI_PO_WERYFIKACJI = '1471793359063355412';
const ID_KANAŁU_LOGI_ZAAWANSOWANE = '1472542064418754622';

// ID kanałów do przechowywania plików JSON (DODAJ SWOJE ID!)
const DATA_CHANNELS = {
    'default': {
        warns: '1472542064418754622',    // ZMIEŃ NA SWÓJ ID KANAŁU
        levels: '1472542064418754622',   // ZMIEŃ NA SWÓJ ID KANAŁU
        alts: '1472542064418754622',     // ZMIEŃ NA SWÓJ ID KANAŁU
        tickets: '1472542064418754622',  // ZMIEŃ NA SWÓJ ID KANAŁU
        emails: '1472542064418754622'    // ZMIEŃ NA SWÓJ ID KANAŁU
    }
};

const BLACKLISTED_WORDS = ["kurwa", "chuj", "pierdol", "jeban"];
const ALLOWED_LINKS = ['discord.gg', 'discord.com'];
const MAX_MESSAGES_BURST = 5;
const MESSAGE_BURST_TIME = 5;
const DUPLICATE_COUNT = 3;
const RAID_JOIN_THRESHOLD = 5;
const RAID_TIME = 10;

// Słowniki tymczasowe
const kodyWeryfikacyjne = new Map();
const oczekujacyNaKod = new Set();
const userMessageTimes = new Map();
const duplicateTracker = new Map();
const recentJoins = [];
let raidMode = false;
const bledneKodyDm = new Map();
const dataCache = new Map();

// =================================================================
// --- KONFIGURACJA BAZOWA ---
// =================================================================
const TOKEN_BOTA = process.env.TOKEN_BOTA || 'TWÓJ_TOKEN_BOTA';
const ID_ROLI_WERYFIKACYJNEJ = '1471793359063355412';
const ID_KANAŁU_WERYFIKACJI = '1471793232756215864';
const ID_KANAŁU_LOGOW = '1471847001984340099';
const ID_KATEGORII_TICKETOW = '1471858695465074789';
const ALLOWED_DOMAINS = ['@gmail.com', '@op.pl', '@onet.pl', '@o2.pl'];
const ATTEMPT_LIMIT = 5;
const SUSPENSION_TIME = 24 * 60 * 60 * 1000;

const KATALOG_LOGOW = "bot_logs";
let discordBotInstance = null;

// =================================================================
// --- EXPRESS APP (MUSI BYĆ PRZED DISCORD) ---
// =================================================================
const appApi = express();
appApi.use(cors());
appApi.use(express.json());

// WAŻNE: Użyj process.env.PORT - Render ustawia tę zmienną
const PORT = process.env.PORT || 10000;

async function initFiles() {
    try {
        await fs.mkdir(KATALOG_LOGOW, { recursive: true });
    } catch (err) {
        console.error("Błąd inicjalizacji plików:", err);
    }
}

// =================================================================
// --- MENEDŻER DANYCH W KANAŁACH ---
// =================================================================
class ChannelDataManager {
    constructor() {
        this.messageIds = new Map();
    }

    getChannelId(guildId, type) {
        return DATA_CHANNELS[guildId]?.[type] || DATA_CHANNELS['default']?.[type];
    }

    async getData(bot, guildId, type, filename) {
        const channelId = this.getChannelId(guildId, type);
        if (!channelId) {
            console.error(`Brak kanału dla ${type}`);
            return {};
        }

        const cacheKey = `${guildId}_${type}`;
        if (dataCache.has(cacheKey)) {
            return dataCache.get(cacheKey);
        }

        try {
            const channel = await bot.channels.fetch(channelId);
            const messages = await channel.messages.fetch({ limit: 5 });
            
            for (const msg of messages.values()) {
                if (msg.attachments.size > 0) {
                    const attachment = msg.attachments.find(att => att.name === filename);
                    if (attachment) {
                        const response = await fetch(attachment.url);
                        const text = await response.text();
                        const data = JSON.parse(text);
                        dataCache.set(cacheKey, data);
                        this.messageIds.set(cacheKey, msg.id);
                        return data;
                    }
                }
            }
            return {};
        } catch (e) {
            console.error(`Błąd pobierania ${filename}:`, e);
            return {};
        }
    }

    async saveData(bot, guildId, type, filename, data) {
        const channelId = this.getChannelId(guildId, type);
        if (!channelId) return false;

        try {
            const channel = await bot.channels.fetch(channelId);
            const cacheKey = `${guildId}_${type}`;
            
            const oldMsgId = this.messageIds.get(cacheKey);
            if (oldMsgId) {
                try {
                    const oldMsg = await channel.messages.fetch(oldMsgId);
                    await oldMsg.delete();
                } catch {}
            }

            const buffer = Buffer.from(JSON.stringify(data, null, 2));
            const attachment = new AttachmentBuilder(buffer, { name: filename });
            
            const msg = await channel.send({
                content: `📁 **${type.toUpperCase()}** | <t:${Math.floor(Date.now()/1000)}:F>`,
                files: [attachment]
            });

            this.messageIds.set(cacheKey, msg.id);
            dataCache.set(cacheKey, data);
            return true;
        } catch (e) {
            console.error(`Błąd zapisywania ${filename}:`, e);
            return false;
        }
    }

    async init(bot) {
        console.log("SYSTEM: Ładowanie danych z kanałów...");
        const types = ['warns', 'levels', 'alts', 'tickets', 'emails'];
        
        for (const guildId of Object.keys(DATA_CHANNELS)) {
            for (const type of types) {
                await this.getData(bot, guildId, type, `${type}.json`);
            }
        }
        console.log("SYSTEM: Dane załadowane");
    }
}

const dataManager = new ChannelDataManager();

// =================================================================
// --- SYSTEM LEVELI ---
// =================================================================
class LevelSystem {
    static XP_PER_MESSAGE = 15;
    static XP_COOLDOWN = 60;
    static XP_PER_MINUTE_VOICE = 10;

    static xpForLevel(level) {
        return 100 * (level ** 2);
    }

    constructor() {
        this.voiceStartTimes = new Map();
    }

    async getData(guildId) {
        return await dataManager.getData(discordBotInstance, guildId, 'levels', 'levels.json');
    }

    async saveData(guildId, data) {
        await dataManager.saveData(discordBotInstance, guildId, 'levels', 'levels.json', data);
    }

    async addXp(userId, guildId, xpAmount, xpType = "message") {
        const now = Date.now() / 1000;
        const data = await this.getData(guildId);
        
        if (!data[userId]) {
            data[userId] = {
                xp: 0,
                level: 1,
                messages_count: 0,
                voice_minutes: 0,
                last_message_time: 0,
                last_voice_time: 0
            };
        }

        const user = data[userId];
        
        if (xpType === "message") {
            if (now - user.last_message_time < LevelSystem.XP_COOLDOWN) return null;
            user.last_message_time = now;
            user.messages_count++;
        } else {
            user.last_voice_time = now;
            user.voice_minutes++;
        }

        const oldLevel = user.level;
        user.xp += xpAmount;
        
        let leveledUp = false;
        while (user.xp >= LevelSystem.xpForLevel(user.level + 1)) {
            user.level++;
            leveledUp = true;
        }

        await this.saveData(guildId, data);

        return {
            leveledUp,
            newLevel: user.level,
            oldLevel,
            totalXp: user.xp,
            xpAdded: xpAmount
        };
    }

    async getUserStats(userId, guildId) {
        const data = await this.getData(guildId);
        const user = data[userId];
        
        if (!user) return null;

        const nextLevelXp = LevelSystem.xpForLevel(user.level + 1);
        return {
            xp: user.xp,
            level: user.level,
            messages: user.messages_count,
            voiceMinutes: user.voice_minutes,
            nextLevelXp,
            progress: (user.xp / nextLevelXp) * 100
        };
    }

    async getLeaderboard(guildId, limit = 10) {
        const data = await this.getData(guildId);
        
        const sorted = Object.entries(data)
            .map(([id, v]) => ({ user_id: id, ...v }))
            .sort((a, b) => b.xp - a.xp)
            .slice(0, limit);
            
        return sorted;
    }
}

const levelSystem = new LevelSystem();

// =================================================================
// --- SYSTEM WARNÓW ---
// =================================================================
class WarnSystem {
    static async getData(guildId) {
        return await dataManager.getData(discordBotInstance, guildId, 'warns', 'warns.json');
    }

    static async saveData(guildId, data) {
        await dataManager.saveData(discordBotInstance, guildId, 'warns', 'warns.json', data);
    }

    static async addWarning(userId, guildId, moderatorId, reason) {
        const data = await this.getData(guildId);
        
        if (!data[guildId]) data[guildId] = {};
        if (!data[guildId][userId]) data[guildId][userId] = [];
        
        const warning = {
            id: Date.now(),
            moderator_id: moderatorId,
            reason,
            timestamp: new Date().toISOString(),
            active: true
        };
        
        data[guildId][userId].push(warning);
        
        if (!data[`${guildId}_history`]) data[`${guildId}_history`] = {};
        if (!data[`${guildId}_history`][userId]) data[`${guildId}_history`][userId] = [];
        
        data[`${guildId}_history`][userId].push({
            action_type: "WARN",
            moderator_id: moderatorId,
            reason,
            timestamp: new Date().toISOString()
        });
        
        await this.saveData(guildId, data);
        return this.getWarningCount(userId, guildId);
    }

    static async getWarningCount(userId, guildId) {
        const data = await this.getData(guildId);
        if (!data[guildId] || !data[guildId][userId]) return 0;
        return data[guildId][userId].filter(w => w.active).length;
    }

    static async getWarnings(userId, guildId) {
        const data = await this.getData(guildId);
        if (!data[guildId] || !data[guildId][userId]) return [];
        return data[guildId][userId].filter(w => w.active);
    }

    static async removeWarning(guildId, warnId) {
        const data = await this.getData(guildId);
        if (!data[guildId]) return;
        
        for (const userId in data[guildId]) {
            const w = data[guildId][userId].find(w => w.id === warnId);
            if (w) {
                w.active = false;
                await this.saveData(guildId, data);
                return;
            }
        }
    }

    static async clearWarnings(userId, guildId) {
        const data = await this.getData(guildId);
        if (data[guildId] && data[guildId][userId]) {
            data[guildId][userId].forEach(w => w.active = false);
            await this.saveData(guildId, data);
        }
    }

    static async getHistory(userId, guildId) {
        const data = await this.getData(guildId);
        return data[`${guildId}_history`]?.[userId] || [];
    }
}

// =================================================================
// --- SYSTEM ANTY-ALT ---
// =================================================================
class AntiAltSystem {
    constructor() {
        this.data = {};
    }

    async load(guildId) {
        this.data = await dataManager.getData(discordBotInstance, guildId, 'alts', 'alts.json');
        return this.data;
    }

    async save(guildId) {
        await dataManager.saveData(discordBotInstance, guildId, 'alts', 'alts.json', this.data);
    }

    levenshtein(s1, s2) {
        if (s1.length < s2.length) return this.levenshtein(s2, s1);
        if (s2.length === 0) return s1.length;
        
        let prev = Array.from({length: s2.length + 1}, (_, i) => i);
        
        for (let i = 0; i < s1.length; i++) {
            const curr = [i + 1];
            for (let j = 0; j < s2.length; j++) {
                curr.push(Math.min(
                    prev[j + 1] + 1,
                    curr[j] + 1,
                    prev[j] + (s1[i] !== s2[j] ? 1 : 0)
                ));
            }
            prev = curr;
        }
        return prev[s2.length];
    }

    findSimilar(member) {
        const similar = [];
        const name = member.user.username.toLowerCase();
        
        for (const m of member.guild.members.cache.values()) {
            if (m.id === member.id) continue;
            const other = m.user.username.toLowerCase();
            
            if (name.includes(other) || other.includes(name)) {
                if (name.length > 3) similar.push(m.user.username);
            } else if (name.length <= 6 && this.levenshtein(name, other) <= 2) {
                similar.push(m.user.username);
            }
        }
        return similar;
    }

    async check(member) {
        const guildId = member.guild.id;
        await this.load(guildId);
        
        const warnings = [];
        let risk = 0;
        const age = Math.floor((Date.now() - member.user.createdTimestamp) / (1000 * 60 * 60 * 24));
        
        if (age < 1) { warnings.push("🆕 Konto utworzone dzisiaj!"); risk += 50; }
        else if (age < 7) { warnings.push(`📅 Konto ma ${age} dni`); risk += 30; }
        
        if (!member.user.avatar) { warnings.push("🖼️ Domyślny avatar"); risk += 10; }
        
        if (/\d{4,}$/.test(member.user.username) || /^user[_-]?\d+/i.test(member.user.username)) {
            warnings.push("🤖 Podejrzana nazwa");
            risk += 20;
        }

        const similar = this.findSimilar(member);
        if (similar.length) {
            warnings.push(`👥 Podobne: ${similar.slice(0, 3).join(', ')}`);
            risk += 15 * similar.length;
        }

        const result = {
            isSuspicious: risk >= 40,
            riskScore: risk,
            warnings,
            accountAgeDays: age
        };

        if (result.isSuspicious) {
            this.data[member.id] = {
                joinedAt: new Date().toISOString(),
                riskScore: risk,
                warnings,
                guildId,
                actionTaken: null
            };
            await this.save(guildId);
        }

        return result;
    }

    async getStats(guildId) {
        await this.load(guildId);
        const vals = Object.values(this.data);
        return {
            totalSuspicious: vals.length,
            banned: vals.filter(v => v.actionTaken?.action === 'ban').length,
            kicked: vals.filter(v => v.actionTaken?.action === 'kick').length,
            pending: vals.filter(v => !v.actionTaken).length
        };
    }
}

const antiAlt = new AntiAltSystem();

// =================================================================
// --- SYSTEM TICKETÓW ---
// =================================================================
class TicketSystem {
    static active = new Map();

    static async getStatsData(guildId) {
        return await dataManager.getData(discordBotInstance, guildId, 'tickets', 'tickets.json');
    }

    static async saveStats(guildId, data) {
        await dataManager.saveData(discordBotInstance, guildId, 'tickets', 'tickets.json', data);
    }

    static async updateStats(guildId, action, time = null) {
        const data = await this.getStatsData(guildId);
        if (action === 'created') {
            data.total = (data.total || 0) + 1;
        } else if (action === 'resolved' && time) {
            data.resolved = (data.resolved || 0) + 1;
            const avg = data.avg_time || 0;
            const total = data.resolved;
            data.avg_time = ((avg * (total - 1)) + time) / total;
        }
        await this.saveStats(guildId, data);
    }

    static async getStats(guildId) {
        const data = await this.getStatsData(guildId);
        return {
            total: data.total || 0,
            resolved: data.resolved || 0,
            avg_time: data.avg_time || 0
        };
    }

    static createEmbed() {
        return new EmbedBuilder()
            .setTitle("🎫 SYSTEM TICKETÓW")
            .setDescription("Kliknij przycisk poniżej, aby utworzyć ticket.")
            .setColor(0x5865F2)
            .addFields({
                name: "Kategorie:",
                value: "🛠️ Pomoc Techniczna\n❓ Pytania Ogólne\n💼 Współpraca\n🚨 Zgłoszenie"
            });
    }

    static createButtons() {
        const cats = [
            ['tech', '🛠️', 'Techniczna', ButtonStyle.Primary],
            ['general', '❓', 'Ogólne', ButtonStyle.Secondary],
            ['coop', '💼', 'Współpraca', ButtonStyle.Success],
            ['report', '🚨', 'Zgłoszenie', ButtonStyle.Danger]
        ];
        
        const row = new ActionRowBuilder();
        cats.forEach(([id, emoji, label, style]) => {
            row.addComponents(
                new ButtonBuilder()
                    .setCustomId(`ticket_${id}`)
                    .setLabel(label)
                    .setEmoji(emoji)
                    .setStyle(style)
            );
        });
        return [row];
    }
}

// =================================================================
// --- FUNKCJE POMOCNICZE ---
// =================================================================
function generujKod() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function checkRoles(interaction) {
    if (!interaction.guild) return false;
    return interaction.member.roles.cache.some(r => MODERATOR_ROLE_IDS.includes(r.id));
}

function isFlood(userId) {
    const now = Date.now() / 1000;
    let times = userMessageTimes.get(userId) || [];
    
    while (times.length && now - times[0] > MESSAGE_BURST_TIME) times.shift();
    times.push(now);
    userMessageTimes.set(userId, times);
    
    return times.length >= MAX_MESSAGES_BURST;
}

function isSpam(userId, content) {
    let t = duplicateTracker.get(userId) || { content: "", count: 0 };
    const norm = content.toLowerCase().replace(/\s+/g, '');
    
    if (norm === t.content) t.count++;
    else { t.content = norm; t.count = 1; }
    
    duplicateTracker.set(userId, t);
    return t.count >= DUPLICATE_COUNT;
}

// =================================================================
// --- API ENDPOINTS (MUSZĄ BYĆ PRZED DISCORD LOGIN) ---
// =================================================================

// Health check - ZAWSZE dostępny
appApi.get('/health', (req, res) => {
    res.json({
        status: discordBotInstance ? 'OK' : 'INITIALIZING',
        discord: !!discordBotInstance,
        port: PORT,
        timestamp: new Date().toISOString()
    });
});

// API dla warnów
appApi.get('/api/warns/:userId', async (req, res) => {
    try {
        if (!discordBotInstance) return res.status(503).json({ error: 'Bot not ready' });
        const guildId = req.query.guildId || 'default';
        const warnings = await WarnSystem.getWarnings(req.params.userId, guildId);
        res.json({ warnings, count: warnings.length });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

appApi.get('/api/levels/:userId', async (req, res) => {
    try {
        if (!discordBotInstance) return res.status(503).json({ error: 'Bot not ready' });
        const guildId = req.query.guildId || 'default';
        const stats = await levelSystem.getUserStats(req.params.userId, guildId);
        res.json(stats || { error: 'Not found' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

appApi.get('/api/leaderboard', async (req, res) => {
    try {
        if (!discordBotInstance) return res.status(503).json({ error: 'Bot not ready' });
        const guildId = req.query.guildId || 'default';
        const board = await levelSystem.getLeaderboard(guildId, 10);
        res.json(board);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// START SERWERA HTTP (MUSI BYĆ PRZED DISCORD LOGIN)
const server = appApi.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 API Server running on port ${PORT}`);
});

// =================================================================
// --- DISCORD BOT ---
// =================================================================
class NexusBot extends Client {
    constructor() {
        super({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.GuildMembers,
                GatewayIntentBits.GuildVoiceStates,
                GatewayIntentBits.DirectMessages
            ],
            partials: [Partials.Channel, Partials.Message]
        });

        this.once(Events.ClientReady, this.onReady.bind(this));
        this.on(Events.GuildMemberAdd, this.onMemberAdd.bind(this));
        this.on(Events.MessageCreate, this.onMessage.bind(this));
        this.on(Events.InteractionCreate, this.onInteraction.bind(this));
    }

    async onReady() {
        discordBotInstance = this;
        console.log(`✅ Bot ${this.user.tag} gotowy!`);
        
        await dataManager.init(this);
        
        // Rejestracja komend
        const commands = [
            {
                name: 'kick',
                description: 'Wyrzuca użytkownika',
                options: [
                    { name: 'user', type: 6, description: 'Użytkownik', required: true },
                    { name: 'reason', type: 3, description: 'Powód', required: false }
                ]
            },
            {
                name: 'ban',
                description: 'Banuje użytkownika',
                options: [
                    { name: 'user', type: 6, description: 'Użytkownik', required: true },
                    { name: 'reason', type: 3, description: 'Powód', required: false }
                ]
            },
            {
                name: 'clear',
                description: 'Czyści wiadomości (1-100)',
                options: [
                    { name: 'amount', type: 4, description: 'Ilość', required: true }
                ]
            },
            {
                name: 'warn',
                description: 'Dodaje ostrzeżenie',
                options: [
                    { name: 'user', type: 6, description: 'Użytkownik', required: true },
                    { name: 'reason', type: 3, description: 'Powód', required: true }
                ]
            },
            {
                name: 'warns',
                description: 'Pokazuje ostrzeżenia',
                options: [
                    { name: 'user', type: 6, description: 'Użytkownik', required: false }
                ]
            },
            {
                name: 'clearwarns',
                description: 'Czyści ostrzeżenia użytkownika',
                options: [
                    { name: 'user', type: 6, description: 'Użytkownik', required: true }
                ]
            },
            {
                name: 'rank',
                description: 'Pokazuje twój level',
                options: [
                    { name: 'user', type: 6, description: 'Użytkownik (opcjonalnie)', required: false }
                ]
            },
            {
                name: 'leaderboard',
                description: 'Top 10 użytkowników'
            },
            {
                name: 'userinfo',
                description: 'Informacje o użytkowniku',
                options: [
                    { name: 'user', type: 6, description: 'Użytkownik', required: false }
                ]
            },
            {
                name: 'serverinfo',
                description: 'Informacje o serwerze'
            },
            {
                name: 'ticketsetup',
                description: 'Ustawia panel ticketów'
            },
            {
                name: 'ticketclose',
                description: 'Zamyka ticket'
            },
            {
                name: 'slowmode',
                description: 'Ustawia slowmode',
                options: [
                    { name: 'seconds', type: 4, description: 'Sekundy (0-21600)', required: true }
                ]
            },
            {
                name: 'say',
                description: 'Wysyła wiadomość jako bot',
                options: [
                    { name: 'text', type: 3, description: 'Treść', required: true }
                ]
            }
        ];

        await this.application.commands.set(commands);
        console.log('✅ Komendy zarejestrowane');
    }

    async onMemberAdd(member) {
        const check = await antiAlt.check(member);
        if (check.isSuspicious) {
            const embed = new EmbedBuilder()
                .setTitle("🕵️ Podejrzane konto")
                .setDescription(`${member} - Ryzyko: ${check.riskScore}/100`)
                .setColor(0xFF0000)
                .addFields({ name: "Ostrzeżenia", value: check.warnings.join('\n') || "Brak" });
            
            const logCh = await this.channels.fetch(ID_KANAŁU_LOGOW).catch(() => null);
            if (logCh) logCh.send({ embeds: [embed] });
        }
    }

    async onMessage(message) {
        if (message.author.bot) return;
        if (!message.guild) return;

        // Level system
        const result = await levelSystem.addXp(message.author.id, message.guild.id, LevelSystem.XP_PER_MESSAGE);
        if (result?.leveledUp) {
            message.channel.send(`🎉 ${message.author} awansował na level **${result.newLevel}**!`);
        }

        // Auto-mod
        if (!checkRoles({ member: message.member })) {
            if (isFlood(message.author.id)) {
                await message.delete().catch(() => {});
                return message.channel.send(`🚫 ${message.author} zwolnij!`).then(m => setTimeout(() => m.delete(), 3000));
            }
            
            if (isSpam(message.author.id, message.content)) {
                await message.delete().catch(() => {});
                return message.channel.send(`🚫 ${message.author} nie spamuj!`).then(m => setTimeout(() => m.delete(), 3000));
            }
        }
    }

    async onInteraction(interaction) {
        if (!interaction.isCommand() && !interaction.isButton()) return;
        
        const guildId = interaction.guildId;

        try {
            if (interaction.isCommand()) {
                const { commandName } = interaction;

                const modCmds = ['kick', 'ban', 'clear', 'warn', 'clearwarns', 'slowmode', 'say'];
                if (modCmds.includes(commandName) && !checkRoles(interaction)) {
                    return interaction.reply({ content: "❌ Brak uprawnień!", ephemeral: true });
                }

                switch (commandName) {
                    case 'kick': {
                        const user = interaction.options.getMember('user');
                        const reason = interaction.options.getString('reason') || "Brak";
                        
                        if (!user) return interaction.reply({ content: "Nie znaleziono użytkownika!", ephemeral: true });
                        
                        await user.kick(reason);
                        const embed = new EmbedBuilder()
                            .setTitle("👢 KICK")
                            .setDescription(`${user} został wyrzucony`)
                            .setColor(0xFFA500)
                            .addFields({ name: "Powód", value: reason });
                        
                        await interaction.reply({ embeds: [embed] });
                        break;
                    }

                    case 'ban': {
                        const user = interaction.options.getMember('user');
                        const reason = interaction.options.getString('reason') || "Brak";
                        
                        if (!user) return interaction.reply({ content: "Nie znaleziono użytkownika!", ephemeral: true });
                        
                        await user.ban({ reason });
                        const embed = new EmbedBuilder()
                            .setTitle("🔨 BAN")
                            .setDescription(`${user} został zbanowany`)
                            .setColor(0xFF0000)
                            .addFields({ name: "Powód", value: reason });
                        
                        await interaction.reply({ embeds: [embed] });
                        break;
                    }

                    case 'clear': {
                        const amount = Math.min(100, Math.max(1, interaction.options.getInteger('amount')));
                        await interaction.deferReply({ ephemeral: true });
                        
                        const deleted = await interaction.channel.bulkDelete(amount, true);
                        await interaction.followUp({ content: `🗑️ Usunięto ${deleted.size} wiadomości`, ephemeral: true });
                        break;
                    }

                    case 'warn': {
                        const user = interaction.options.getMember('user');
                        const reason = interaction.options.getString('reason');
                        
                        if (!user) return interaction.reply({ content: "Nie znaleziono użytkownika!", ephemeral: true });
                        
                        const count = await WarnSystem.addWarning(user.id, guildId, interaction.user.id, reason);
                        
                        const embed = new EmbedBuilder()
                            .setTitle("⚠️ WARN")
                            .setDescription(`${user} otrzymał ostrzeżenie`)
                            .setColor(0xFFFF00)
                            .addFields(
                                { name: "Powód", value: reason, inline: false },
                                { name: "Liczba warnów", value: `${count}/5`, inline: true }
                            );
                        
                        await interaction.reply({ embeds: [embed] });
                        
                        if (count >= 3) {
                            let muted = interaction.guild.roles.cache.find(r => r.name === "Muted");
                            if (!muted) {
                                muted = await interaction.guild.roles.create({ name: "Muted" });
                                interaction.guild.channels.cache.forEach(ch => 
                                    ch.permissionOverwrites?.edit(muted, { SendMessages: false }).catch(() => {})
                                );
                            }
                            await user.roles.add(muted);
                            interaction.channel.send(`🔇 ${user} automatycznie wyciszony (3 warny)`);
                        }
                        break;
                    }

                    case 'warns': {
                        const user = interaction.options.getMember('user') || interaction.member;
                        const warnings = await WarnSystem.getWarnings(user.id, guildId);
                        
                        const embed = new EmbedBuilder()
                            .setTitle(`⚠️ Ostrzeżenia: ${user.user.username}`)
                            .setColor(0xFFA500);
                        
                        if (!warnings.length) {
                            embed.setDescription("✅ Brak ostrzeżeń");
                        } else {
                            warnings.forEach(w => {
                                embed.addFields({
                                    name: `ID: ${w.id}`,
                                    value: `Powód: ${w.reason}\nData: ${w.timestamp.slice(0, 10)}`,
                                    inline: false
                                });
                            });
                        }
                        
                        await interaction.reply({ embeds: [embed], ephemeral: true });
                        break;
                    }

                    case 'clearwarns': {
                        const user = interaction.options.getMember('user');
                        await WarnSystem.clearWarnings(user.id, guildId);
                        
                        await interaction.reply({ 
                            content: `✅ Wyczyszczono ostrzeżenia dla ${user}`,
                            ephemeral: false 
                        });
                        break;
                    }

                    case 'rank': {
                        const user = interaction.options.getMember('user') || interaction.member;
                        const stats = await levelSystem.getUserStats(user.id, guildId);
                        
                        if (!stats) {
                            return interaction.reply({ content: "❌ Brak danych. Napisz coś najpierw!", ephemeral: true });
                        }
                        
                        const bar = "█".repeat(Math.floor(stats.progress / 10)) + "░".repeat(10 - Math.floor(stats.progress / 10));
                        
                        const embed = new EmbedBuilder()
                            .setTitle(`⭐ ${user.user.username}`)
                            .setColor(0xFFD700)
                            .setThumbnail(user.displayAvatarURL())
                            .addFields(
                                { name: "Level", value: stats.level.toString(), inline: true },
                                { name: "XP", value: `${stats.xp}/${stats.nextLevelXp}`, inline: true },
                                { name: "Postęp", value: `\`${bar}\` ${stats.progress.toFixed(1)}%`, inline: false },
                                { name: "Wiadomości", value: stats.messages.toString(), inline: true },
                                { name: "Voice (min)", value: stats.voiceMinutes.toString(), inline: true }
                            );
                        
                        await interaction.reply({ embeds: [embed] });
                        break;
                    }

                    case 'leaderboard': {
                        await interaction.deferReply();
                        
                        const board = await levelSystem.getLeaderboard(guildId, 10);
                        
                        if (!board.length) {
                            return interaction.editReply("❌ Brak danych w tabeli wyników");
                        }
                        
                        const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
                        
                        let desc = "";
                        for (let i = 0; i < board.length; i++) {
                            const u = board[i];
                            const member = await interaction.guild.members.fetch(u.user_id).catch(() => null);
                            const name = member?.user.username || "Nieznany";
                            desc += `${medals[i]} **${name}** - Level ${u.level} | ${u.xp} XP\n`;
                        }
                        
                        const embed = new EmbedBuilder()
                            .setTitle("🏆 TOP 10")
                            .setDescription(desc)
                            .setColor(0xFFD700)
                            .setTimestamp();
                        
                        await interaction.editReply({ embeds: [embed] });
                        break;
                    }

                    case 'userinfo': {
                        const user = interaction.options.getMember('user') || interaction.member;
                        const warns = await WarnSystem.getWarningCount(user.id, guildId);
                        
                        const embed = new EmbedBuilder()
                            .setTitle(`👤 ${user.user.username}`)
                            .setColor(user.displayColor || 0x5865F2)
                            .setThumbnail(user.displayAvatarURL())
                            .addFields(
                                { name: "ID", value: user.id, inline: true },
                                { name: "Nick", value: user.nickname || "Brak", inline: true },
                                { name: "Dołączył", value: user.joinedAt?.toLocaleDateString('pl-PL') || "?", inline: true },
                                { name: "Warny", value: `${warns}/5`, inline: true },
                                { name: "Role", value: user.roles.cache.size.toString(), inline: true }
                            );
                        
                        await interaction.reply({ embeds: [embed], ephemeral: true });
                        break;
                    }

                    case 'serverinfo': {
                        const g = interaction.guild;
                        
                        const embed = new EmbedBuilder()
                            .setTitle(`🌐 ${g.name}`)
                            .setColor(0x5865F2)
                            .setThumbnail(g.iconURL())
                            .addFields(
                                { name: "ID", value: g.id, inline: true },
                                { name: "Właściciel", value: `<@${g.ownerId}>`, inline: true },
                                { name: "Członkowie", value: g.memberCount.toString(), inline: true },
                                { name: "Kanały", value: g.channels.cache.size.toString(), inline: true },
                                { name: "Ról", value: g.roles.cache.size.toString(), inline: true },
                                { name: "Utworzony", value: g.createdAt.toLocaleDateString('pl-PL'), inline: true }
                            );
                        
                        await interaction.reply({ embeds: [embed], ephemeral: true });
                        break;
                    }

                    case 'ticketsetup': {
                        const ch = await this.channels.fetch(ID_KANAŁU_TICKET_PANEL).catch(() => null);
                        if (!ch) return interaction.reply({ content: "Błąd kanału!", ephemeral: true });
                        
                        const embed = TicketSystem.createEmbed();
                        const buttons = TicketSystem.createButtons();
                        
                        await ch.send({ embeds: [embed], components: buttons });
                        await interaction.reply({ content: "✅ Panel ustawiony!", ephemeral: true });
                        break;
                    }

                    case 'ticketclose': {
                        if (!interaction.channel.name.startsWith('ticket-')) {
                            return interaction.reply({ content: "To nie jest ticket!", ephemeral: true });
                        }
                        
                        await interaction.reply("🔒 Zamykanie za 3 sekundy...");
                        setTimeout(() => interaction.channel.delete().catch(() => {}), 3000);
                        break;
                    }

                    case 'slowmode': {
                        const sec = Math.min(21600, Math.max(0, interaction.options.getInteger('seconds')));
                        await interaction.channel.setRateLimitPerUser(sec);
                        
                        const embed = new EmbedBuilder()
                            .setTitle(sec === 0 ? "🐢 Slowmode wyłączony" : "🐢 Slowmode włączony")
                            .setDescription(sec > 0 ? `Opóźnienie: ${sec}s` : "Można pisać normalnie")
                            .setColor(sec === 0 ? 0x00FF00 : 0xFFFF00);
                        
                        await interaction.reply({ embeds: [embed] });
                        break;
                    }

                    case 'say': {
                        const text = interaction.options.getString('text');
                        await interaction.channel.send(text);
                        await interaction.reply({ content: "✅ Wysłano!", ephemeral: true });
                        break;
                    }
                }
            }

            if (interaction.isButton() && interaction.customId.startsWith('ticket_')) {
                const cat = interaction.customId.replace('ticket_', '');
                
                for (const [_, data] of TicketSystem.active) {
                    if (data.creator === interaction.user.id) {
                        return interaction.reply({ content: "Masz już ticket!", ephemeral: true });
                    }
                }

                const parent = await interaction.guild.channels.fetch(ID_KATEGORII_TICKETOW).catch(() => null);
                
                const channel = await interaction.guild.channels.create({
                    name: `ticket-${interaction.user.username}-${cat}`,
                    type: ChannelType.GuildText,
                    parent: parent,
                    permissionOverwrites: [
                        { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                        { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
                        { id: this.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] }
                    ]
                });

                TicketSystem.active.set(channel.id, {
                    creator: interaction.user.id,
                    createdAt: Date.now(),
                    category: cat
                });

                const embed = new EmbedBuilder()
                    .setTitle(`🎫 Ticket: ${cat.toUpperCase()}`)
                    .setDescription(`Utworzony przez: ${interaction.user}`)
                    .setColor(0x5865F2);

                const closeBtn = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('ticket_close_btn')
                        .setLabel("Zamknij")
                        .setEmoji("🔒")
                        .setStyle(ButtonStyle.Danger)
                );

                await channel.send({ embeds: [embed], components: [closeBtn] });
                await interaction.reply({ content: `Ticket utworzony: ${channel}`, ephemeral: true });
            }

            if (interaction.isButton() && interaction.customId === 'ticket_close_btn') {
                if (!interaction.channel.name.startsWith('ticket-')) return;
                
                await interaction.reply("🔒 Zamykanie za 3 sekundy...");
                setTimeout(() => interaction.channel.delete().catch(() => {}), 3000);
            }

        } catch (err) {
            console.error("Błąd interakcji:", err);
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: "❌ Wystąpił błąd!", ephemeral: true }).catch(() => {});
            }
        }
    }
}

// =================================================================
// --- START ---
// =================================================================
async function main() {
    await initFiles();
    
    // Start Discord bota (po starcie serwera HTTP)
    const bot = new NexusBot();
    await bot.login(TOKEN_BOTA);
}

main().catch(console.error);
