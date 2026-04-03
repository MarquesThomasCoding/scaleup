const express = require('express');
const https = require('https');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(bodyParser.json());

const options = {
  key: fs.readFileSync('server.key'),
  cert: fs.readFileSync('server.cert')
};

let classement = [];
let activeClimbers = {};
let sseClients = [];

function notifyClients() {
    const active = Object.values(activeClimbers);
    let scores = [];
    if (fs.existsSync('scores.json')) {
        try { scores = JSON.parse(fs.readFileSync('scores.json', 'utf8')); } catch (e) {}
    }
    const rankedScores = scores.map(s => ({
        nom: s.nom || "Anonyme",
        temps: s.temps,
        date: s.date
    })).sort((a, b) => a.temps - b.temps);

    const payload = JSON.stringify({
        serverTime: Date.now(),
        active: active,
        scores: rankedScores
    });

    sseClients.forEach(client => {
        try { client.res.write(`data: ${payload}\n\n`); } catch(e){}
    });
}

function getUsername(uid) {
    try {
        const users = JSON.parse(fs.readFileSync('users.json', 'utf8'));
        return users[uid] || uid;
    } catch (err) {
        return uid;
    }
}

app.post('/start', (req, res) => {
    const { uid } = req.body;
    if (!uid) return res.status(400).send("UID manquant");

    let users = {};
    if (fs.existsSync('users.json')) {
        try { users = JSON.parse(fs.readFileSync('users.json', 'utf8')); } catch (e) {}
    }

    const scoreUid = uid.replace(/0x/gi, "").replace(/:/g, "").toLowerCase();
    let nom = "Anonyme";
    
    for (const [uKey, uName] of Object.entries(users)) {
        const userUid = uKey.replace(/0x/gi, "").replace(/:/g, "").toLowerCase();
        if (scoreUid === userUid || scoreUid.startsWith(userUid) || userUid.startsWith(scoreUid)) {
            nom = uName;
            if (scoreUid === userUid) break;
        }
    }

    activeClimbers[uid] = { uid, nom, startTime: Date.now() };
    console.log(`DEPART: ${nom} (${uid})`);
    notifyClients();
    res.json({ success: true });
});

app.post('/touch', (req, res) => {
    const { uid, temps } = req.body;
    if (activeClimbers[uid]) {
        activeClimbers[uid].touching = true;
        activeClimbers[uid].freezeTime = temps;
        notifyClients();
    }
    res.json({ success: true });
});

app.post('/resume', (req, res) => {
    const { uid } = req.body;
    if (activeClimbers[uid]) {
        activeClimbers[uid].touching = false;
        delete activeClimbers[uid].freezeTime;
        notifyClients();
    }
    res.json({ success: true });
});

app.post('/reset', (req, res) => {
    activeClimbers = {};
    console.log("RESET MANUEL : Tous les grimpeurs actifs ont été annulés !");
    notifyClients();
    res.json({ success: true });
});

app.post('/upload', (req, res) => {
    const { uid, temps } = req.body;
    
    if (activeClimbers[uid]) {
        delete activeClimbers[uid];
    }

    let users = {};
    if (fs.existsSync('users.json')) {
        try {
            users = JSON.parse(fs.readFileSync('users.json', 'utf8'));
        } catch (e) {}
    }

    const scoreUid = uid ? uid.replace(/0x/gi, "").replace(/:/g, "").toLowerCase() : "";
    let nom = "Anonyme";
    
    for (const [uKey, uName] of Object.entries(users)) {
        const userUid = uKey.replace(/0x/gi, "").replace(/:/g, "").toLowerCase();
        if (scoreUid === userUid || scoreUid.startsWith(userUid) || userUid.startsWith(scoreUid)) {
            nom = uName;
            if (scoreUid === userUid) break;
        }
    }

    const newScore = { nom, uid, temps, date: new Date().toISOString() };

    let scores = [];
    if (fs.existsSync('scores.json')) {
        scores = JSON.parse(fs.readFileSync('scores.json', 'utf8'));
    }
    
    scores.push(newScore);
    fs.writeFileSync('scores.json', JSON.stringify(scores, null, 2));

    console.log(`Score enregistré pour ${nom} (Badge: ${uid}) : ${temps}s`);
    notifyClients();
    res.json({ success: true });
});

app.get('/api/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const client = { id: Date.now(), res };
    sseClients.push(client);

    notifyClients();

    req.on('close', () => {
        sseClients = sseClients.filter(c => c.id !== client.id);
    });
});

app.get('/leaderboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'leaderboard.html'));
});

app.get('/api/scores', (req, res) => {
    let scores = [];
    if (fs.existsSync('scores.json')) {
        try {
            scores = JSON.parse(fs.readFileSync('scores.json', 'utf8'));
        } catch (e) {}
    }
    
    let users = {};
    if (fs.existsSync('users.json')) {
        try {
            users = JSON.parse(fs.readFileSync('users.json', 'utf8'));
        } catch (e) {}
    }

    const rankedScores = scores.map(s => {
        let nom = s.nom;
        if (!nom) {
            const scoreUid = s.uid ? s.uid.replace(/0x/gi, "").replace(/:/g, "").toLowerCase() : "";
            nom = "Anonyme";
            for (const [uKey, uName] of Object.entries(users)) {
                const userUid = uKey.replace(/0x/gi, "").replace(/:/g, "").toLowerCase();
                if (scoreUid === userUid || scoreUid.startsWith(userUid) || userUid.startsWith(scoreUid)) {
                    nom = uName;
                    if (scoreUid === userUid) break;
                }
            }
        }

        return {
            nom: nom,
            temps: s.temps,
            date: s.date
        };
    }).sort((a, b) => a.temps - b.temps);

    res.json({
        serverTime: Date.now(),
        active: Object.values(activeClimbers),
        scores: rankedScores
    });
});

app.get('/nfc', (req, res) => {
    res.sendFile(path.join(__dirname, 'nfc-reader.html'));
});

app.post('/register', (req, res) => {
    const { uid, nom } = req.body;
    if (!uid || !nom) return res.status(400).send("Données manquantes");

    let users = {};
    if (fs.existsSync('users.json')) {
        try {
            const data = JSON.parse(fs.readFileSync('users.json', 'utf8'));
            if (!Array.isArray(data)) {
                users = data;
            }
        } catch(e) {}
    }

    users[uid] = nom;
    fs.writeFileSync('users.json', JSON.stringify(users, null, 2));

    console.log(`Utilisateur enregistré : ${nom} (ID: ${uid})`);
    res.json({ success: true, message: `Badge lié à ${nom}` });
});

https.createServer(options, app).listen(5000, '0.0.0.0', () => {
  console.log("Serveur HTTPS lancé sur https://localhost:5000");
});