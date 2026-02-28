const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const GAMES_FILE = path.join(__dirname, 'games.json');

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('.'));

// Inicjalizacja - utwórz games.json jeśli nie istnieje
async function initGamesFile() {
    try {
        await fs.access(GAMES_FILE);
        console.log('✅ Plik games.json istnieje');
    } catch {
        console.log('📝 Tworzenie pustego games.json...');
        await fs.writeFile(GAMES_FILE, JSON.stringify({}, null, 4), 'utf8');
    }
}

// Konwersja obiektu gier na tablicę (dla launchera)
function gamesToArray(gamesObject) {
    return Object.values(gamesObject).map(game => ({
        ...game,
        // Upewnij się że wszystkie wymagane pola istnieją
        id: game.id || Object.keys(gamesObject).find(key => gamesObject[key] === game),
        name: game.name || 'Unknown',
        description: game.description || '',
        developer: game.developer || 'Unknown',
        price: game.price || 0,
        size_gb: game.size_gb || 0,
        pegi: game.pegi || 12,
        category: game.category || 'Gry',
        subcategory: game.subcategory || '',
        genre: game.genre || '',
        rating: game.rating || 0,
        color: game.color || '#00d4ff',
        icon: game.icon || '🎮',
        real_download: game.real_download || false,
        download_url: game.download_url || '',
        requires: game.requires || ''
    }));
}

// GET /games - Endpoint dla launchera (zwraca tablicę)
app.get('/games', async (req, res) => {
    try {
        const data = await fs.readFile(GAMES_FILE, 'utf8');
        const gamesObject = JSON.parse(data);
        const gamesArray = gamesToArray(gamesObject);
        
        console.log(`📤 Wysłano ${gamesArray.length} gier do launchera`);
        res.json(gamesArray);
    } catch (error) {
        console.error('❌ Błąd odczytu games.json:', error.message);
        res.status(500).json({ 
            error: 'Nie można odczytać pliku games.json',
            details: error.message 
        });
    }
});

// GET /api/games - Stary endpoint (dla kompatybilności z admin panel)
app.get('/api/games', async (req, res) => {
    try {
        const data = await fs.readFile(GAMES_FILE, 'utf8');
        res.json(JSON.parse(data));
    } catch (error) {
        console.error('❌ Błąd odczytu /api/games:', error.message);
        res.status(500).json({ error: 'Nie można odczytać pliku games.json' });
    }
});

// POST /api/games - Zapisz wszystkie gry
app.post('/api/games', async (req, res) => {
    try {
        const games = req.body;
        
        // Walidacja
        if (typeof games !== 'object' || Array.isArray(games)) {
            return res.status(400).json({ 
                error: 'Nieprawidłowy format. Oczekiwano obiektu {id: game}' 
            });
        }
        
        await fs.writeFile(GAMES_FILE, JSON.stringify(games, null, 4), 'utf8');
        console.log(`💾 Zapisano ${Object.keys(games).length} gier`);
        res.json({ 
            success: true, 
            message: 'Zapisano zmiany',
            count: Object.keys(games).length
        });
    } catch (error) {
        console.error('❌ Błąd zapisu:', error.message);
        res.status(500).json({ error: 'Nie można zapisać pliku games.json' });
    }
});

// PUT /api/games/:id - Zaktualizuj jedną grę
app.put('/api/games/:id', async (req, res) => {
    try {
        const data = await fs.readFile(GAMES_FILE, 'utf8');
        const games = JSON.parse(data);
        const gameId = req.params.id;
        
        // Aktualizacja lub dodanie nowej gry
        games[gameId] = {
            ...req.body,
            id: gameId // Upewnij się że ID jest zgodne
        };
        
        await fs.writeFile(GAMES_FILE, JSON.stringify(games, null, 4), 'utf8');
        console.log(`✏️ Zaktualizowano grę: ${gameId}`);
        res.json({ 
            success: true, 
            message: `Zaktualizowano grę ${gameId}`,
            game: games[gameId]
        });
    } catch (error) {
        console.error('❌ Błąd aktualizacji:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// DELETE /api/games/:id - Usuń grę
app.delete('/api/games/:id', async (req, res) => {
    try {
        const data = await fs.readFile(GAMES_FILE, 'utf8');
        const games = JSON.parse(data);
        const gameId = req.params.id;
        
        if (!games[gameId]) {
            return res.status(404).json({ error: 'Gra nie istnieje' });
        }
        
        delete games[gameId];
        await fs.writeFile(GAMES_FILE, JSON.stringify(games, null, 4), 'utf8');
        console.log(`🗑️ Usunięto grę: ${gameId}`);
        res.json({ 
            success: true, 
            message: `Usunięto grę ${gameId}` 
        });
    } catch (error) {
        console.error('❌ Błąd usuwania:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// GET /health - Sprawdź status serwera
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        version: '1.0.0'
    });
});

// GET /stats - Statystyki gier
app.get('/stats', async (req, res) => {
    try {
        const data = await fs.readFile(GAMES_FILE, 'utf8');
        const games = JSON.parse(data);
        const gamesArray = gamesToArray(games);
        
        res.json({
            total_games: gamesArray.length,
            categories: [...new Set(gamesArray.map(g => g.category))],
            total_size_gb: gamesArray.reduce((sum, g) => sum + (g.size_gb || 0), 0),
            free_games: gamesArray.filter(g => g.price === 0).length,
            paid_games: gamesArray.filter(g => g.price > 0).length
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Obsługa błędów 404
app.use((req, res) => {
    res.status(404).json({ 
        error: 'Nie znaleziono endpointu',
        available_endpoints: [
            'GET  /games',
            'GET  /api/games',
            'POST /api/games',
            'PUT  /api/games/:id',
            'DELETE /api/games/:id',
            'GET  /health',
            'GET  /stats'
        ]
    });
});

// Start serwera
async function startServer() {
    await initGamesFile();
    
    app.listen(PORT, () => {
        console.log(`🚀 Serwer działa na http://localhost:${PORT}`);
        console.log(`🎮 Endpoint gier: http://localhost:${PORT}/games`);
        console.log(`📁 Admin panel: http://localhost:${PORT}/admin.html`);
        console.log(`💓 Health check: http://localhost:${PORT}/health`);
        console.log(`📊 Statystyki: http://localhost:${PORT}/stats`);
    });
}

startServer().catch(console.error);