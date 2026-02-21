const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Security middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100 // limit each IP to 100 requests per windowMs
});
app.use('/api/', limiter);

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'nebula-super-secret-key-change-in-production';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'nebula-refresh-secret-key';

// Database setup
const db = new sqlite3.Database(path.join(__dirname, 'nebula.db'));

db.serialize(() => {
    // Users
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        avatar_url TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        last_login TEXT,
        is_active INTEGER DEFAULT 1,
        parental_enabled INTEGER DEFAULT 0,
        parental_pin_hash TEXT,
        break_interval INTEGER DEFAULT 60,
        daily_limit_minutes INTEGER DEFAULT 120,
        monthly_goal_hours INTEGER DEFAULT 50
    )`);
    
    // Games catalog
    db.run(`CREATE TABLE IF NOT EXISTS games (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        developer TEXT,
        description TEXT,
        category TEXT,
        price REAL DEFAULT 0,
        size TEXT,
        rating REAL DEFAULT 0,
        download_url TEXT,
        icon_url TEXT,
        banner_url TEXT,
        pegi INTEGER DEFAULT 12,
        requirements TEXT, -- JSON
        release_date TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // User library
    db.run(`CREATE TABLE IF NOT EXISTS library (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        game_id TEXT NOT NULL,
        added_at TEXT DEFAULT CURRENT_TIMESTAMP,
        play_time_seconds INTEGER DEFAULT 0,
        last_played TEXT,
        is_installed INTEGER DEFAULT 0,
        install_path TEXT,
        fps_limit INTEGER DEFAULT 0,
        launch_options TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (game_id) REFERENCES games(id),
        UNIQUE(user_id, game_id)
    )`);
    
    // Gaming sessions with performance data
    db.run(`CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        game_id TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT,
        duration_seconds INTEGER,
        avg_fps REAL,
        min_fps REAL,
        max_fps REAL,
        avg_cpu_temp REAL,
        max_cpu_temp REAL,
        avg_gpu_temp REAL,
        max_gpu_temp REAL,
        avg_ram_usage REAL,
        FOREIGN KEY (user_id) REFERENCES users(id)
    )`);
    
    // Friends system
    db.run(`CREATE TABLE IF NOT EXISTS friendships (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        friend_id INTEGER NOT NULL,
        status TEXT DEFAULT 'pending', -- pending, accepted, blocked
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, friend_id)
    )`);
    
    // Messages
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_id INTEGER NOT NULL,
        to_id INTEGER NOT NULL,
        content TEXT NOT NULL,
        sent_at TEXT DEFAULT CURRENT_TIMESTAMP,
        read_at TEXT,
        FOREIGN KEY (from_id) REFERENCES users(id),
        FOREIGN KEY (to_id) REFERENCES users(id)
    )`);
    
    // Daily activity for streaks
    db.run(`CREATE TABLE IF NOT EXISTS daily_activity (
        user_id INTEGER NOT NULL,
        date TEXT NOT NULL,
        played_seconds INTEGER DEFAULT 0,
        PRIMARY KEY (user_id, date),
        FOREIGN KEY (user_id) REFERENCES users(id)
    )`);
    
    // Parental control logs
    db.run(`CREATE TABLE IF NOT EXISTS parental_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        event_type TEXT NOT NULL, -- block, break_warning, time_limit
        game_id TEXT,
        details TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
    )`);
    
    // Insert sample games if empty
    db.get("SELECT COUNT(*) as count FROM games", (err, row) => {
        if (row.count === 0) {
            const sampleGames = [
                {
                    id: 'nebula-racer',
                    name: 'Nebula Racer',
                    developer: 'Nebula Studios',
                    description: 'Szybkie wyścigi w kosmosie z driftowaniem i modyfikacjami statków.',
                    category: 'Wyścigi',
                    price: 0,
                    size: '2.5 GB',
                    rating: 4.5,
                    pegi: 7,
                    requirements: JSON.stringify({
                        cpu_cores: 4,
                        ram_gb: 8,
                        gpu_vram_gb: 2,
                        storage_gb: 5,
                        os: ['win32', 'linux', 'darwin']
                    })
                },
                {
                    id: 'cyber-rpg',
                    name: 'Cyber RPG 2077',
                    developer: 'Future Games',
                    description: 'RPG akcji w otwartym cyberpunkowym świecie.',
                    category: 'RPG',
                    price: 59.99,
                    size: '70 GB',
                    rating: 4.8,
                    pegi: 18,
                    requirements: JSON.stringify({
                        cpu_cores: 6,
                        ram_gb: 16,
                        gpu_vram_gb: 8,
                        storage_gb: 80,
                        os: ['win32']
                    })
                },
                {
                    id: 'space-miner',
                    name: 'Space Miner Simulator',
                    developer: 'Indie Devs',
                    description: 'Symulator górnictwa kosmicznego z budowanią bazy.',
                    category: 'Symulacja',
                    price: 24.99,
                    size: '4 GB',
                    rating: 4.2,
                    pegi: 12,
                    requirements: JSON.stringify({
                        cpu_cores: 2,
                        ram_gb: 4,
                        gpu_vram_gb: 1,
                        storage_gb: 6,
                        os: ['win32', 'linux', 'darwin']
                    })
                }
            ];
            
            const stmt = db.prepare(`INSERT INTO games 
                (id, name, developer, description, category, price, size, rating, pegi, requirements) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
            
            sampleGames.forEach(g => {
                stmt.run(g.id, g.name, g.developer, g.description, g.category, 
                        g.price, g.size, g.rating, g.pegi, g.requirements);
            });
            stmt.finalize();
            console.log('Sample games inserted');
        }
    });
});

// JWT middleware
const authenticate = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No token provided' });
    }
    
    const token = authHeader.substring(7);
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.userId = decoded.userId;
        req.username = decoded.username;
        next();
    } catch (err) {
        return res.status(403).json({ error: 'Invalid token' });
    }
};

// === AUTH ROUTES ===
app.post('/api/auth/register', async (req, res) => {
    const { username, password, email } = req.body;
    
    if (!username || !password || !email) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    
    if (username.length < 3 || username.length > 20) {
        return res.status(400).json({ error: 'Username must be 3-20 characters' });
    }
    
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Invalid email format' });
    }
    
    try {
        const passwordHash = await bcrypt.hash(password, 10);
        
        db.run(
            'INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)',
            [username, email, passwordHash],
            function(err) {
                if (err) {
                    if (err.message.includes('UNIQUE constraint failed')) {
                        return res.status(409).json({ error: 'Username or email already exists' });
                    }
                    throw err;
                }
                
                const token = jwt.sign(
                    { userId: this.lastID, username },
                    JWT_SECRET,
                    { expiresIn: '24h' }
                );
                
                res.status(201).json({
                    token,
                    user: { id: this.lastID, username, email }
                });
            }
        );
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Registration failed' });
    }
});

app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    
    db.get(
        'SELECT * FROM users WHERE username = ? AND is_active = 1',
        [username],
        async (err, user) => {
            if (err || !user) {
                return res.status(401).json({ error: 'Invalid credentials' });
            }
            
            const valid = await bcrypt.compare(password, user.password_hash);
            if (!valid) {
                return res.status(401).json({ error: 'Invalid credentials' });
            }
            
            // Update last login
            db.run('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);
            
            const token = jwt.sign(
                { userId: user.id, username: user.username },
                JWT_SECRET,
                { expiresIn: '24h' }
            );
            
            res.json({
                token,
                user: {
                    id: user.id,
                    username: user.username,
                    email: user.email,
                    parental_enabled: !!user.parental_enabled
                }
            });
        }
    );
});

app.post('/api/auth/logout', authenticate, (req, res) => {
    // In production: add token to blacklist or use refresh tokens
    res.json({ success: true });
});

// === USER ROUTES ===
app.get('/api/user/me', authenticate, (req, res) => {
    db.get(
        'SELECT id, username, email, avatar_url, parental_enabled, monthly_goal_hours FROM users WHERE id = ?',
        [req.userId],
        (err, user) => {
            if (err || !user) {
                return res.status(404).json({ error: 'User not found' });
            }
            res.json(user);
        }
    );
});

app.put('/api/user/status', authenticate, (req, res) => {
    const { status, in_game } = req.body;
    
    // Broadcast to friends via WebSocket
    io.emit('user_status', {
        userId: req.userId,
        username: req.username,
        status,
        in_game,
        timestamp: new Date().toISOString()
    });
    
    res.json({ success: true });
});
// === ADMIN ROUTES (dodaj przed app.listen) ===

const requireAdmin = async (req, res, next) => {
    // Sprawdź czy user jest adminem
    db.get('SELECT is_admin FROM users WHERE id = ?', [req.userId], (err, user) => {
        if (err || !user || !user.is_admin) {
            return res.status(403).json({ error: 'Admin access required' });
        }
        next();
    });
};

// Admin middleware - użyj: app.get('/admin/...', authenticate, requireAdmin, handler)

// Stats
app.get('/api/admin/users/count', authenticate, requireAdmin, (req, res) => {
    db.get('SELECT COUNT(*) as count FROM users WHERE is_active = 1', (err, row) => {
        res.json({ count: row?.count || 0 });
    });
});

app.get('/api/admin/games/count', authenticate, requireAdmin, (req, res) => {
    db.get('SELECT COUNT(*) as count FROM games', (err, row) => {
        res.json({ count: row?.count || 0 });
    });
});

app.get('/api/admin/sessions/today', authenticate, requireAdmin, (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    db.get(`
        SELECT COUNT(*) as count, SUM(duration_seconds) as total_seconds 
        FROM sessions WHERE date(start_time) = ?
    `, [today], (err, row) => {
        res.json({ 
            count: row?.count || 0, 
            total_seconds: row?.total_seconds || 0 
        });
    });
});

app.get('/api/admin/activity/recent', authenticate, requireAdmin, (req, res) => {
    // Mock - w produkcji: tabela logs
    res.json([
        { time: new Date().toISOString(), username: 'TestUser', action: 'login', type: 'info', details: 'Web login' },
        { time: new Date(Date.now() - 3600000).toISOString(), username: 'Player1', action: 'game_start', type: 'success', details: 'Cyber RPG 2077' },
        { time: new Date(Date.now() - 7200000).toISOString(), username: 'Player2', action: 'purchase', type: 'success', details: 'Space Miner' }
    ]);
});

// Users management
app.get('/api/admin/users', authenticate, requireAdmin, (req, res) => {
    db.all(`
        SELECT u.*, 
               (SELECT SUM(play_time_seconds) FROM library WHERE user_id = u.id) as total_playtime
        FROM users u
        ORDER BY u.created_at DESC
    `, [], (err, users) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ users: users || [] });
    });
});

app.post('/api/admin/users', authenticate, requireAdmin, async (req, res) => {
    const { username, email, password, is_admin, parental_enabled } = req.body;
    const hash = await bcrypt.hash(password, 10);
    
    db.run(`
        INSERT INTO users (username, email, password_hash, is_admin, parental_enabled) 
        VALUES (?, ?, ?, ?, ?)
    `, [username, email, hash, is_admin ? 1 : 0, parental_enabled ? 1 : 0], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, id: this.lastID });
    });
});

app.delete('/api/admin/users/:id', authenticate, requireAdmin, (req, res) => {
    // Soft delete
    db.run('UPDATE users SET is_active = 0 WHERE id = ?', [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// Games management
app.post('/api/admin/games', authenticate, requireAdmin, (req, res) => {
    const { id, name, developer, description, category, price, pegi, size, 
            rating, download_url, requirements } = req.body;
    
    db.run(`
        INSERT INTO games (id, name, developer, description, category, price, 
                          pegi, size, rating, download_url, requirements)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [id, name, developer, description, category, price, pegi, size, 
        rating, download_url, JSON.stringify(requirements)], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, id });
    });
});

app.put('/api/admin/games/:id', authenticate, requireAdmin, (req, res) => {
    const { name, developer, description, category, price, pegi, size,
            rating, download_url, requirements } = req.body;
    
    db.run(`
        UPDATE games SET 
            name = ?, developer = ?, description = ?, category = ?,
            price = ?, pegi = ?, size = ?, rating = ?, download_url = ?,
            requirements = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `, [name, developer, description, category, price, pegi, size,
        rating, download_url, JSON.stringify(requirements), req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

app.delete('/api/admin/games/:id', authenticate, requireAdmin, (req, res) => {
    db.run('DELETE FROM games WHERE id = ?', [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// Library management
app.get('/api/admin/library', authenticate, requireAdmin, (req, res) => {
    db.all(`
        SELECT l.*, u.username, g.name as game_name
        FROM library l
        JOIN users u ON l.user_id = u.id
        JOIN games g ON l.game_id = g.id
        ORDER BY l.added_at DESC
        LIMIT 100
    `, [], (err, items) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ items: items || [] });
    });
});

app.delete('/api/admin/library/:id', authenticate, requireAdmin, (req, res) => {
    db.run('DELETE FROM library WHERE id = ?', [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// Sessions
app.get('/api/admin/sessions', authenticate, requireAdmin, (req, res) => {
    const { date, limit = 100 } = req.query;
    
    let query = `
        SELECT s.*, u.username, g.name as game_name
        FROM sessions s
        JOIN users u ON s.user_id = u.id
        JOIN games g ON s.game_id = g.id
    `;
    const params = [];
    
    if (date) {
        query += ' WHERE date(s.start_time) = ?';
        params.push(date);
    }
    
    query += ' ORDER BY s.start_time DESC LIMIT ?';
    params.push(parseInt(limit));
    
    db.all(query, params, (err, sessions) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ sessions: sessions || [] });
    });
});

// Parental logs
app.get('/api/admin/parental/logs', authenticate, requireAdmin, (req, res) => {
    db.all(`
        SELECT p.*, u.username, g.name as game_name
        FROM parental_logs p
        JOIN users u ON p.user_id = u.id
        LEFT JOIN games g ON p.game_id = g.id
        ORDER BY p.created_at DESC
        LIMIT 100
    `, [], (err, logs) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ logs: logs || [] });
    });
});

app.delete('/api/admin/parental/logs/old', authenticate, requireAdmin, (req, res) => {
    db.run(`
        DELETE FROM parental_logs 
        WHERE created_at < date('now', '-30 days')
    `, [], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ deleted: this.changes });
    });
});

// Detailed stats
app.get('/api/admin/stats/detailed', authenticate, requireAdmin, (req, res) => {
    db.get(`
        SELECT g.name, COUNT(*) as owners, SUM(s.duration_seconds)/3600.0 as total_hours,
               AVG(s.avg_fps) as avg_fps, MAX(s.max_cpu_temp) as max_temp
        FROM sessions s
        JOIN games g ON s.game_id = g.id
        GROUP BY g.id
        ORDER BY total_hours DESC
        LIMIT 1
    `, [], (err, topGame) => {
        
        db.get(`
            SELECT AVG(duration_seconds)/60.0 as avg_minutes
            FROM sessions WHERE date(start_time) >= date('now', '-7 days')
        `, [], (err, avgSession) => {
            
            db.get(`
                SELECT COUNT(DISTINCT user_id) as active_today
                FROM sessions WHERE date(start_time) = date('now')
            `, [], (err, active) => {
                
                db.all(`
                    SELECT g.name, COUNT(*) as owners, SUM(s.duration_seconds)/3600.0 as total_hours,
                           AVG(s.avg_fps) as avg_fps, MAX(s.max_cpu_temp) as max_temp
                    FROM sessions s
                    JOIN games g ON s.game_id = g.id
                    GROUP BY g.id
                    ORDER by total_hours DESC
                `, [], (err, perGame) => {
                    
                    res.json({
                        top_game: topGame?.name || '-',
                        avg_session_minutes: avgSession?.avg_minutes || 0,
                        active_today: active?.active_today || 0,
                        per_game: perGame || []
                    });
                });
            });
        });
    });
});

// Settings
app.post('/api/admin/settings', authenticate, requireAdmin, (req, res) => {
    // Zapisz do pliku config lub bazy
    res.json({ success: true });
});
// === GAMES ROUTES ===
app.get('/api/games', (req, res) => {
    const { category, search, limit = 50, offset = 0 } = req.query;
    
    let query = 'SELECT * FROM games WHERE 1=1';
    const params = [];
    
    if (category && category !== 'Wszystkie') {
        query += ' AND category = ?';
        params.push(category);
    }
    
    if (search) {
        query += ' AND (name LIKE ? OR developer LIKE ?)';
        params.push(`%${search}%`, `%${search}%`);
    }
    
    query += ' ORDER BY rating DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));
    
    db.all(query, params, (err, games) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }
        
        // Parse requirements JSON
        games.forEach(g => {
            try {
                g.requirements = JSON.parse(g.requirements || '{}');
            } catch {
                g.requirements = {};
            }
        });
        
        res.json({ games, count: games.length });
    });
});

app.get('/api/games/:id', (req, res) => {
    db.get('SELECT * FROM games WHERE id = ?', [req.params.id], (err, game) => {
        if (err || !game) {
            return res.status(404).json({ error: 'Game not found' });
        }
        
        try {
            game.requirements = JSON.parse(game.requirements || '{}');
        } catch {
            game.requirements = {};
        }
        
        res.json(game);
    });
});

// === LIBRARY ROUTES ===
app.get('/api/library', authenticate, (req, res) => {
    db.all(`
        SELECT g.*, l.play_time_seconds, l.last_played, l.is_installed, 
               l.install_path, l.fps_limit, l.launch_options
        FROM library l
        JOIN games g ON l.game_id = g.id
        WHERE l.user_id = ?
        ORDER BY l.last_played DESC
    `, [req.userId], (err, games) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }
        
        games.forEach(g => {
            try {
                g.requirements = JSON.parse(g.requirements || '{}');
            } catch {
                g.requirements = {};
            }
        });
        
        res.json({ games });
    });
});

app.post('/api/library/add', authenticate, (req, res) => {
    const { game_id } = req.body;
    
    db.run(
        'INSERT OR IGNORE INTO library (user_id, game_id) VALUES (?, ?)',
        [req.userId, game_id],
        function(err) {
            if (err) {
                return res.status(500).json({ error: 'Failed to add game' });
            }
            res.json({ success: true, added: this.changes > 0 });
        }
    );
});

app.delete('/api/library/:gameId', authenticate, (req, res) => {
    db.run(
        'DELETE FROM library WHERE user_id = ? AND game_id = ?',
        [req.userId, req.params.gameId],
        function(err) {
            if (err) {
                return res.status(500).json({ error: 'Failed to remove game' });
            }
            res.json({ success: true });
        }
    );
});

// === FRIENDS ROUTES ===
app.get('/api/friends', authenticate, (req, res) => {
    db.all(`
        SELECT u.id, u.username, u.avatar_url, u.last_login,
               CASE 
                   WHEN datetime(u.last_login) > datetime('now', '-5 minutes') 
                   THEN 'online' ELSE 'offline' 
               END as status
        FROM friendships f
        JOIN users u ON f.friend_id = u.id
        WHERE f.user_id = ? AND f.status = 'accepted'
    `, [req.userId], (err, friends) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }
        res.json({ friends });
    });
});

app.post('/api/friends/add', authenticate, (req, res) => {
    const { username } = req.body;
    
    db.get('SELECT id FROM users WHERE username = ?', [username], (err, user) => {
        if (err || !user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        if (user.id === req.userId) {
            return res.status(400).json({ error: 'Cannot add yourself' });
        }
        
        db.run(
            'INSERT OR IGNORE INTO friendships (user_id, friend_id, status) VALUES (?, ?, ?)',
            [req.userId, user.id, 'pending'],
            function(err) {
                if (err) {
                    return res.status(500).json({ error: 'Failed to send request' });
                }
                res.json({ success: true, request_sent: this.changes > 0 });
            }
        );
    });
});

app.post('/api/friends/accept/:friendId', authenticate, (req, res) => {
    db.run(
        `UPDATE friendships SET status = 'accepted' 
         WHERE user_id = ? AND friend_id = ? AND status = 'pending'`,
        [req.params.friendId, req.userId],
        function(err) {
            if (err) {
                return res.status(500).json({ error: 'Failed to accept' });
            }
            
            // Create reciprocal friendship
            db.run(
                'INSERT OR IGNORE INTO friendships (user_id, friend_id, status) VALUES (?, ?, ?)',
                [req.userId, req.params.friendId, 'accepted']
            );
            
            res.json({ success: true });
        }
    );
});

// === MESSAGES ROUTES ===
app.get('/api/messages/:friendId', authenticate, (req, res) => {
    const { limit = 50, before } = req.query;
    
    let query = `
        SELECT m.*, u.username as from_username
        FROM messages m
        JOIN users u ON m.from_id = u.id
        WHERE (m.from_id = ? AND m.to_id = ?) OR (m.from_id = ? AND m.to_id = ?)
    `;
    const params = [req.userId, req.params.friendId, req.params.friendId, req.userId];
    
    if (before) {
        query += ' AND m.sent_at < ?';
        params.push(before);
    }
    
    query += ' ORDER BY m.sent_at DESC LIMIT ?';
    params.push(parseInt(limit));
    
    db.all(query, params, (err, messages) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }
        
        // Mark as read
        db.run(
            'UPDATE messages SET read_at = CURRENT_TIMESTAMP WHERE to_id = ? AND from_id = ? AND read_at IS NULL',
            [req.userId, req.params.friendId]
        );
        
        res.json({ messages: messages.reverse() });
    });
});

app.post('/api/messages', authenticate, (req, res) => {
    const { to_id, content } = req.body;
    
    if (!content || content.trim().length === 0) {
        return res.status(400).json({ error: 'Empty message' });
    }
    
    if (content.length > 2000) {
        return res.status(400).json({ error: 'Message too long' });
    }
    
    db.run(
        'INSERT INTO messages (from_id, to_id, content) VALUES (?, ?, ?)',
        [req.userId, to_id, content.trim()],
        function(err) {
            if (err) {
                return res.status(500).json({ error: 'Failed to send message' });
            }
            
            const message = {
                id: this.lastID,
                from_id: req.userId,
                to_id,
                content: content.trim(),
                sent_at: new Date().toISOString(),
                from_username: req.username
            };
            
            // Broadcast via WebSocket
            io.emit('new_message', message);
            
            res.json({ success: true, message });
        }
    );
});

// === STATS & SESSIONS ===
app.post('/api/sessions', authenticate, (req, res) => {
    const {
        game_id, start_time, end_time, duration,
        avg_fps, min_fps, max_fps,
        avg_cpu_temp, max_cpu_temp,
        avg_gpu_temp, max_gpu_temp,
        avg_ram_usage
    } = req.body;
    
    db.run(`
        INSERT INTO sessions 
        (user_id, game_id, start_time, end_time, duration_seconds,
         avg_fps, min_fps, max_fps, avg_cpu_temp, max_cpu_temp, avg_gpu_temp, max_gpu_temp, avg_ram_usage)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
        req.userId, game_id, start_time, end_time, duration,
        avg_fps, min_fps, max_fps,
        avg_cpu_temp, max_cpu_temp,
        avg_gpu_temp, max_gpu_temp,
        avg_ram_usage
    ], function(err) {
        if (err) {
            return res.status(500).json({ error: 'Failed to log session' });
        }
        
        // Update daily activity for streaks
        const date = new Date().toISOString().split('T')[0];
        db.run(`
            INSERT INTO daily_activity (user_id, date, played_seconds)
            VALUES (?, ?, ?)
            ON CONFLICT(user_id, date) DO UPDATE SET
            played_seconds = played_seconds + excluded.played_seconds
        `, [req.userId, date, duration]);
        
        // Update library play time
        db.run(`
            UPDATE library 
            SET play_time_seconds = play_time_seconds + ?, last_played = ?
            WHERE user_id = ? AND game_id = ?
        `, [duration, end_time, req.userId, game_id]);
        
        res.json({ success: true, session_id: this.lastID });
    });
});

app.get('/api/stats', authenticate, (req, res) => {
    const { period = 'month' } = req.query;
    
    let dateFilter;
    switch(period) {
        case 'week':
            dateFilter = "date(s.start_time) >= date('now', '-7 days')";
            break;
        case 'year':
            dateFilter = "date(s.start_time) >= date('now', '-1 year')";
            break;
        default: // month
            dateFilter = "date(s.start_time) >= date('now', '-30 days')";
    }
    
    db.get(`
        SELECT 
            COUNT(*) as total_sessions,
            SUM(duration_seconds) as total_seconds,
            AVG(avg_fps) as avg_fps,
            MAX(max_cpu_temp) as max_cpu_temp,
            MAX(max_gpu_temp) as max_gpu_temp,
            (SELECT monthly_goal_hours FROM users WHERE id = ?) as goal_hours
        FROM sessions s
        WHERE s.user_id = ? AND ${dateFilter}
    `, [req.userId, req.userId], (err, stats) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }
        
        res.json({
            period,
            total_sessions: stats.total_sessions || 0,
            total_hours: (stats.total_seconds || 0) / 3600,
            monthly_hours: (stats.total_seconds || 0) / 3600,
            avg_fps: stats.avg_fps || 0,
            max_cpu_temp: stats.max_cpu_temp || 0,
            max_gpu_temp: stats.max_gpu_temp || 0,
            goal_hours: stats.goal_hours || 50
        });
    });
});

app.get('/api/stats/heatmap', authenticate, (req, res) => {
    db.all(`
        SELECT date, played_seconds / 3600.0 as hours
        FROM daily_activity
        WHERE user_id = ? AND date >= date('now', '-30 days')
        ORDER BY date
    `, [req.userId], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }
        
        const heatmap = {};
        rows.forEach(row => {
            heatmap[row.date] = row.hours;
        });
        
        res.json({ heatmap });
    });
});

app.get('/api/stats/streak', authenticate, (req, res) => {
    db.all(`
        SELECT date FROM daily_activity 
        WHERE user_id = ? AND played_seconds > 300
        ORDER BY date DESC
    `, [req.userId], (err, rows) => {
        if (err || rows.length === 0) {
            return res.json({ streak: 0 });
        }
        
        let streak = 1;
        const today = new Date();
        
        for (let i = 1; i < rows.length; i++) {
            const expected = new Date(today);
            expected.setDate(expected.getDate() - i);
            const expectedStr = expected.toISOString().split('T')[0];
            
            if (rows[i].date === expectedStr) {
                streak++;
            } else {
                break;
            }
        }
        
        res.json({ streak });
    });
});

// === PARENTAL CONTROL ===
app.get('/api/parental/settings', authenticate, (req, res) => {
    db.get(`
        SELECT parental_enabled, break_interval, daily_limit_minutes
        FROM users WHERE id = ?
    `, [req.userId], (err, settings) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }
        res.json(settings || {});
    });
});

app.put('/api/parental/settings', authenticate, (req, res) => {
    const { pin, break_interval, daily_limit } = req.body;
    
    let updateQuery = 'UPDATE users SET break_interval = ?, daily_limit_minutes = ?';
    const params = [break_interval, daily_limit];
    
    if (pin) {
        updateQuery += ', parental_enabled = 1, parental_pin_hash = ?';
        params.push(pin); // Already hashed by client
    }
    
    updateQuery += ' WHERE id = ?';
    params.push(req.userId);
    
    db.run(updateQuery, params, function(err) {
        if (err) {
            return res.status(500).json({ error: 'Failed to update settings' });
        }
        res.json({ success: true });
    });
});

app.post('/api/parental/log', authenticate, (req, res) => {
    const { type, game_id, details } = req.body;
    
    db.run(
        'INSERT INTO parental_logs (user_id, event_type, game_id, details) VALUES (?, ?, ?, ?)',
        [req.userId, type, game_id, JSON.stringify(details)],
        function(err) {
            if (err) {
                return res.status(500).json({ error: 'Failed to log event' });
            }
            res.json({ success: true });
        }
    );
});

// === ANTICHEAT STATUS ===
app.get('/api/anticheat/:gameId', (req, res) => {
    // In production: check actual running processes
    const anticheats = {
        'nebula-racer': {
            easyanticheat: { status: 'not_required' },
            battleye: { status: 'not_required' },
            vac: { status: 'not_required' }
        },
        'cyber-rpg': {
            easyanticheat: { status: 'running', version: '4.0.1' },
            battleye: { status: 'not_detected' }
        }
    };
    
    res.json(anticheats[req.params.gameId] || {
        easyanticheat: { status: 'unknown' },
        battleye: { status: 'unknown' }
    });
});

// === WEBSOCKET ===
const userSockets = new Map();

io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    
    socket.on('authenticate', (token) => {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            userSockets.set(decoded.userId, socket);
            socket.userId = decoded.userId;
            console.log('User authenticated:', decoded.username);
        } catch (err) {
            socket.emit('auth_error', 'Invalid token');
        }
    });
    
    socket.on('disconnect', () => {
        if (socket.userId) {
            userSockets.delete(socket.userId);
            
            // Broadcast offline status
            io.emit('user_status', {
                userId: socket.userId,
                status: 'offline',
                timestamp: new Date().toISOString()
            });
        }
        console.log('Client disconnected:', socket.id);
    });
});

// Error handling
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Internal server error' });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Nebula API Server running on port ${PORT}`);
    console.log(`API Base: http://localhost:${PORT}/api`);
});
