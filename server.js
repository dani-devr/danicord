const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 1e9 // Limite de 1GB
});

// --- SISTEMA DE ARQUIVOS ---
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const dbPath = path.join(__dirname, 'data.json');

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage, limits: { fileSize: 1e9 } });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.post('/upload', upload.single('media'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    const mime = req.file.mimetype;
    let type = 'file';
    if (mime.startsWith('image/')) type = 'image';
    if (mime.startsWith('video/')) type = 'video';
    if (mime.startsWith('audio/')) type = 'audio';
    res.json({ url: `/uploads/${req.file.filename}`, type: type });
});

// --- ESTADO DA APLICAÇÃO ---
const activeUsers = new Map(); 
let bannedIPs = new Set();
let ipToUser = new Map(); 
let customEmojis = []; // Emojis customizados do servidor
let dms = {}; // Armazena as DMs { dmId: { users: [ip1, ip2], messages: [] } }

let servers = {
    'global': { 
        id: 'global', name: 'Danicord Global', icon: 'fa-globe', type: 'public', 
        channels: {
            'geral': { id: 'geral', name: 'geral', type: 'text', messages: [] },
            'voz': { id: 'voz', name: 'Voz Principal', type: 'voice' }
        }
    }
};

// --- DATA PERSISTENCE ---
function loadData() {
    if (fs.existsSync(dbPath)) {
        try {
            const raw = fs.readFileSync(dbPath, 'utf8');
            const data = JSON.parse(raw);
            if (data.servers) servers = data.servers;
            if (data.bannedIPs) bannedIPs = new Set(data.bannedIPs);
            if (data.ipToUser) ipToUser = new Map(Object.entries(data.ipToUser));
            if (data.dms) dms = data.dms;
            if (data.customEmojis) customEmojis = data.customEmojis;
            console.log("Banco de dados carregado com sucesso!");
        } catch (e) { console.error("Erro ao carregar data.json:", e); }
    }
}

function saveData() {
    try {
        const data = {
            servers,
            bannedIPs: Array.from(bannedIPs),
            ipToUser: Object.fromEntries(ipToUser),
            dms,
            customEmojis
        };
        fs.writeFileSync(dbPath, JSON.stringify(data));
    } catch (e) { console.error("Erro ao salvar data.json:", e); }
}

loadData();
setInterval(saveData, 10000);

// --- SOCKETS ---
io.on('connection', (socket) => {
    let clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    if (clientIp.includes(',')) clientIp = clientIp.split(',')[0].trim();

    if (bannedIPs.has(clientIp)) {
        socket.emit('banned permanently');
        socket.disconnect(true);
        return;
    }

    if (ipToUser.has(clientIp)) socket.emit('force login', ipToUser.get(clientIp));
    socket.msgTimestamps = [];

    socket.on('user joined', ({ user, inviteId }) => {
        if (bannedIPs.has(clientIp)) return;
        
        user.role = user.name.toLowerCase() === 'dypz' ? 'Admin' : 'Membro';

        if (ipToUser.has(clientIp)) {
            const savedUser = ipToUser.get(clientIp);
            // Atualiza info preservando cargo
            user.role = savedUser.role;
        } 
        
        if(user.name.toLowerCase() === 'dypz') user.role = 'Admin'; 
        
        ipToUser.set(clientIp, user);
        saveData();

        user.socketId = socket.id;
        user.ip = clientIp;
        user.voiceChannelId = null;
        activeUsers.set(socket.id, user);
        
        let serverToJoin = 'global';
        if (inviteId && servers[inviteId]) serverToJoin = inviteId;

        const publicServers = Object.values(servers).filter(s => s.type === 'public');
        socket.emit('initial data', { 
            servers: publicServers, 
            dms: getUserDMs(clientIp),
            customEmojis: customEmojis 
        });
        
        joinServer(socket, serverToJoin);
        io.emit('update users', Array.from(activeUsers.values()));
    });

    // --- DMS ---
    function getUserDMs(ip) {
        let userDms = {};
        for(let dmId in dms) {
            if(dms[dmId].users.includes(ip)) userDms[dmId] = dms[dmId];
        }
        return userDms;
    }

    socket.on('create dm', (targetIp) => {
        const user = activeUsers.get(socket.id);
        if(!user || targetIp === user.ip) return;
        
        // Verifica se já existe
        let existingDmId = null;
        for(let dmId in dms) {
            if(dms[dmId].users.includes(user.ip) && dms[dmId].users.includes(targetIp) && dms[dmId].users.length === 2) {
                existingDmId = dmId; break;
            }
        }

        const dmId = existingDmId || 'dm_' + Date.now().toString(36);
        if(!existingDmId) {
            dms[dmId] = { id: dmId, type: 'dm', users: [user.ip, targetIp], messages: [] };
            saveData();
        }

        // Informa os dois utilizadores (se estiverem online)
        io.sockets.sockets.forEach(s => {
            const u = activeUsers.get(s.id);
            if(u && dms[dmId].users.includes(u.ip)) {
                s.emit('dm created', dms[dmId]);
            }
        });
        
        socket.emit('join dm', dmId);
    });

    socket.on('join dm', (dmId) => {
        if(dms[dmId] && dms[dmId].users.includes(activeUsers.get(socket.id)?.ip)) {
            Array.from(socket.rooms).forEach(r => { if (r !== socket.id && !r.startsWith('voice-')) socket.leave(r); });
            socket.join(dmId);
            socket.emit('dm data', dms[dmId]);
        }
    });

    // --- SERVIDORES ---
    socket.on('create server', (data) => {
        const newServerId = 'srv_' + Date.now().toString(36);
        servers[newServerId] = { 
            id: newServerId, name: data.name, icon: 'fa-server', type: 'private', 
            channels: { 'geral': { id: 'geral', name: 'geral', type: 'text', messages: [] }, 'voz': { id: 'voz', name: 'Voz', type: 'voice' } }
        };
        socket.emit('server created', servers[newServerId]); 
        joinServer(socket, newServerId);
        saveData();
    });

    socket.on('create channel', ({ serverId, name, type }) => {
        if (!servers[serverId]) return;
        const chId = 'ch_' + Date.now().toString(36);
        servers[serverId].channels[chId] = { id: chId, name: name, type: type, messages: type === 'text' ? [] : undefined };
        io.to(serverId).emit('channel created', { serverId, channel: servers[serverId].channels[chId] });
        saveData();
    });

    socket.on('join server', (serverId) => {
        if (servers[serverId]) {
            socket.emit('server created', servers[serverId]);
            joinServer(socket, serverId);
        }
    });

    socket.on('update profile', (newProfile) => {
        const current = activeUsers.get(socket.id);
        if (current) {
            newProfile.socketId = socket.id;
            newProfile.ip = current.ip;
            newProfile.voiceChannelId = current.voiceChannelId;
            newProfile.role = current.name.toLowerCase() === 'dypz' ? 'Admin' : current.role;
            activeUsers.set(socket.id, newProfile);
            ipToUser.set(current.ip, newProfile);
            io.emit('update users', Array.from(activeUsers.values()));
            saveData();
        }
    });

    // --- MENSAGENS E REAÇÕES ---
    socket.on('chat message', (msgData) => {
        const user = activeUsers.get(socket.id);
        const { serverId, channelId, isDm } = msgData;
        if (!user) return;

        const now = Date.now();
        socket.msgTimestamps.push(now);
        if (socket.msgTimestamps.length > 5) {
            socket.msgTimestamps.shift();
            if (now - socket.msgTimestamps[0] < 2000) return socket.emit('error message', 'Spam detectado! Aguarde.');
        }

        const message = {
            id: Date.now().toString() + Math.random().toString(36).substring(7),
            user: user, text: msgData.text, mediaUrl: msgData.mediaUrl, mediaType: msgData.mediaType, replyTo: msgData.replyTo, 
            timestamp: new Date().toISOString(), reactions: {}
        };
        
        if (isDm && dms[serverId]) {
            if (dms[serverId].messages.length > 500) dms[serverId].messages.shift();
            dms[serverId].messages.push(message);
            io.to(serverId).emit('chat message', { serverId, channelId: null, message, isDm: true });
        } else if (servers[serverId] && servers[serverId].channels[channelId]) {
            const ch = servers[serverId].channels[channelId];
            if (ch.messages.length > 500) ch.messages.shift();
            ch.messages.push(message);
            io.to(serverId).emit('chat message', { serverId, channelId, message, isDm: false });
        }
        saveData(); 
    });

    socket.on('react message', ({ serverId, channelId, msgId, emoji, isDm }) => {
        const user = activeUsers.get(socket.id);
        if(!user) return;
        
        let msg = null;
        if(isDm && dms[serverId]) msg = dms[serverId].messages.find(m => m.id === msgId);
        else if(servers[serverId] && servers[serverId].channels[channelId]) msg = servers[serverId].channels[channelId].messages.find(m => m.id === msgId);

        if(msg) {
            if(!msg.reactions) msg.reactions = {};
            if(!msg.reactions[emoji]) msg.reactions[emoji] = [];
            
            const userIndex = msg.reactions[emoji].indexOf(user.name);
            if(userIndex > -1) msg.reactions[emoji].splice(userIndex, 1); // Remove
            else msg.reactions[emoji].push(user.name); // Adiciona

            if(msg.reactions[emoji].length === 0) delete msg.reactions[emoji];
            
            io.to(serverId).emit('update reactions', { channelId, msgId, reactions: msg.reactions, isDm });
            saveData();
        }
    });

    socket.on('add custom emoji', (url) => {
        const user = activeUsers.get(socket.id);
        if(user && (user.role === 'Admin' || user.role === 'Moderador')) {
            const newEmoji = { id: Date.now().toString(), url: url };
            customEmojis.push(newEmoji);
            io.emit('new custom emoji', newEmoji);
            saveData();
        }
    });

    socket.on('typing', ({ serverId, channelId }) => {
        const user = activeUsers.get(socket.id);
        if (user && user.status !== 'invisible') socket.to(serverId).emit('typing', { channelId, user });
    });

    socket.on('stop typing', ({ serverId, channelId }) => {
        const user = activeUsers.get(socket.id);
        if (user) socket.to(serverId).emit('stop typing', { channelId, userName: user.name });
    });

    socket.on('edit message', ({ serverId, channelId, msgId, newText, isDm }) => {
        const user = activeUsers.get(socket.id);
        let msg = null;
        if(isDm && dms[serverId]) msg = dms[serverId].messages.find(m => m.id === msgId);
        else if(servers[serverId] && servers[serverId].channels[channelId]) msg = servers[serverId].channels[channelId].messages.find(m => m.id === msgId);

        if (msg && msg.user.socketId === user.socketId) {
            msg.text = newText; msg.edited = true;
            io.to(serverId).emit('message edited', { channelId, msgId, newText, isDm });
            saveData();
        }
    });

    // --- MODERAÇÃO ---
    socket.on('set role', ({ targetSocketId, role }) => {
        const admin = activeUsers.get(socket.id);
        if (admin && admin.name.toLowerCase() === 'dypz') {
            const targetUser = activeUsers.get(targetSocketId);
            if (targetUser && targetUser.name.toLowerCase() !== 'dypz') {
                targetUser.role = role;
                ipToUser.set(targetUser.ip, targetUser); 
                io.emit('update users', Array.from(activeUsers.values()));
                io.emit('system message', `O cargo de ${targetUser.name} foi alterado para ${role}.`);
                saveData();
            }
        }
    });

    socket.on('delete message', ({ serverId, channelId, msgId, isDm }) => {
        const user = activeUsers.get(socket.id);
        if(isDm) {
            // Em DMs só pode apagar as próprias mensagens
            if(dms[serverId]) {
                const msgIndex = dms[serverId].messages.findIndex(m => m.id === msgId);
                if(msgIndex > -1 && dms[serverId].messages[msgIndex].user.socketId === socket.id) {
                    dms[serverId].messages.splice(msgIndex, 1);
                    io.to(serverId).emit('message deleted', { channelId, msgId, isDm });
                }
            }
        } else {
            if (user && (user.role === 'Admin' || user.role === 'Moderador' || servers[serverId].channels[channelId].messages.find(m=>m.id === msgId)?.user.socketId === socket.id)) {
                servers[serverId].channels[channelId].messages = servers[serverId].channels[channelId].messages.filter(m => m.id !== msgId);
                io.to(serverId).emit('message deleted', { channelId, msgId, isDm: false });
                saveData();
            }
        }
    });

    socket.on('ban user', (targetSocketId) => {
        const admin = activeUsers.get(socket.id);
        if (admin && admin.role === 'Admin') {
            const targetUser = activeUsers.get(targetSocketId);
            if (targetUser) {
                bannedIPs.add(targetUser.ip); 
                io.sockets.sockets.forEach((s) => {
                    const sIp = s.handshake.headers['x-forwarded-for'] || s.handshake.address;
                    let cleanIp = sIp.includes(',') ? sIp.split(',')[0].trim() : sIp;
                    if (cleanIp === targetUser.ip) { s.emit('banned permanently'); s.disconnect(true); }
                });
                io.emit('system message', `dypz baniu ${targetUser.name} permanentemente.`);
                saveData();
            }
        }
    });

    // --- WEBRTC ---
    socket.on('join voice', ({ serverId, channelId }) => {
        const user = activeUsers.get(socket.id);
        if(user) { user.voiceChannelId = channelId; io.emit('update users', Array.from(activeUsers.values())); }
        const room = `voice-${serverId}-${channelId}`;
        socket.join(room); socket.to(room).emit('user joined voice', socket.id);
    });

    socket.on('leave voice', ({ serverId, channelId }) => {
        const user = activeUsers.get(socket.id);
        if(user) { user.voiceChannelId = null; io.emit('update users', Array.from(activeUsers.values())); }
        const room = `voice-${serverId}-${channelId}`;
        socket.leave(room); socket.to(room).emit('user left voice', socket.id);
    });

    socket.on('webrtc signal', (data) => { io.to(data.target).emit('webrtc signal', { sender: socket.id, signal: data.signal }); });

    socket.on('disconnect', () => {
        const user = activeUsers.get(socket.id);
        if (user) {
            activeUsers.delete(socket.id);
            io.emit('update users', Array.from(activeUsers.values()));
            socket.broadcast.emit('user left voice', socket.id);
        }
    });

    function joinServer(socket, serverId) {
        Array.from(socket.rooms).forEach(room => { if (room !== socket.id && room !== serverId && !room.startsWith('voice-') && !room.startsWith('dm_')) socket.leave(room); });
        socket.join(serverId);
        socket.emit('server data', servers[serverId]);
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Danicord rodando na porta ${PORT} com Save Persistence`));
