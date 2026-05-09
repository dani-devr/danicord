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

const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

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
const bannedIPs = new Set();
const ipToUser = new Map(); 

const servers = {
    'global': { 
        id: 'global', name: 'Danicord Global', icon: 'fa-globe', type: 'public', 
        channels: {
            'geral': { id: 'geral', name: 'geral', type: 'text', messages: [] },
            'voz': { id: 'voz', name: 'Voz Principal', type: 'voice' }
        }
    }
};

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
        
        // Define Cargo Inicial
        user.role = user.name.toLowerCase() === 'dypz' ? 'Admin' : 'Membro';

        if (ipToUser.has(clientIp)) {
            const savedUser = ipToUser.get(clientIp);
            user.role = savedUser.role; // Mantém o cargo que já tinha
            user = savedUser;
        } else {
            ipToUser.set(clientIp, user);
        }

        if(user.name.toLowerCase() === 'dypz') user.role = 'Admin'; // Garante o Admin sempre pro dypz

        user.socketId = socket.id;
        user.ip = clientIp;
        user.voiceChannelId = null;
        activeUsers.set(socket.id, user);
        
        let serverToJoin = 'global';
        if (inviteId && servers[inviteId]) serverToJoin = inviteId;

        socket.emit('initial servers', [servers['global']]);
        joinServer(socket, serverToJoin);
        io.emit('update users', Array.from(activeUsers.values()));
    });

    socket.on('create server', (data) => {
        const newServerId = 'srv_' + Date.now().toString(36);
        servers[newServerId] = { 
            id: newServerId, name: data.name, icon: 'fa-server', type: 'private', 
            channels: {
                'geral': { id: 'geral', name: 'geral', type: 'text', messages: [] },
                'voz': { id: 'voz', name: 'Voz', type: 'voice' }
            }
        };
        socket.emit('server created', servers[newServerId]); 
        joinServer(socket, newServerId);
    });

    socket.on('create channel', ({ serverId, name, type }) => {
        if (!servers[serverId]) return;
        const chId = 'ch_' + Date.now().toString(36);
        servers[serverId].channels[chId] = { id: chId, name: name, type: type, messages: type === 'text' ? [] : undefined };
        io.to(serverId).emit('channel created', { serverId, channel: servers[serverId].channels[chId] });
    });

    socket.on('create group', (data) => {
        const newServerId = 'grp_' + Date.now().toString(36);
        servers[newServerId] = { 
            id: newServerId, name: data.name, icon: 'fa-users', type: 'group', 
            channels: { 'geral': { id: 'geral', name: 'geral', type: 'text', messages: [] } }
        };
        const membersToJoin = [...data.members, socket.id];
        membersToJoin.forEach(memberId => {
            const memberSocket = io.sockets.sockets.get(memberId);
            if (memberSocket) {
                memberSocket.join(newServerId);
                memberSocket.emit('server created', servers[newServerId]);
            }
        });
        joinServer(socket, newServerId);
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
            newProfile.role = current.name.toLowerCase() === 'dypz' ? 'Admin' : current.role; // Preserva o cargo
            activeUsers.set(socket.id, newProfile);
            ipToUser.set(current.ip, newProfile);
            io.emit('update users', Array.from(activeUsers.values()));
        }
    });

    socket.on('typing', ({ serverId, channelId }) => {
        const user = activeUsers.get(socket.id);
        if (user && user.status !== 'invisible') {
            socket.to(serverId).emit('typing', { channelId, user });
        }
    });

    socket.on('stop typing', ({ serverId, channelId }) => {
        const user = activeUsers.get(socket.id);
        if (user) {
            socket.to(serverId).emit('stop typing', { channelId, userName: user.name });
        }
    });

    socket.on('edit message', ({ serverId, channelId, msgId, newText }) => {
        const user = activeUsers.get(socket.id);
        if (user && servers[serverId] && servers[serverId].channels[channelId]) {
            const msg = servers[serverId].channels[channelId].messages.find(m => m.id === msgId);
            // Dono da mensagem pode editar
            if (msg && msg.user.socketId === user.socketId) {
                msg.text = newText;
                msg.edited = true;
                io.to(serverId).emit('message edited', { channelId, msgId, newText });
            }
        }
    });

    socket.on('chat message', (msgData) => {
        const user = activeUsers.get(socket.id);
        const serverId = msgData.serverId;
        const channelId = msgData.channelId || 'geral';
        
        if (!user || !servers[serverId] || !servers[serverId].channels[channelId]) return;

        const now = Date.now();
        socket.msgTimestamps.push(now);
        if (socket.msgTimestamps.length > 5) {
            socket.msgTimestamps.shift();
            if (now - socket.msgTimestamps[0] < 2000) return socket.emit('error message', 'Spam detectado! Aguarde.');
        }

        const message = {
            id: Date.now().toString() + Math.random().toString(36).substring(7),
            user: user, text: msgData.text, mediaUrl: msgData.mediaUrl, mediaType: msgData.mediaType, replyTo: msgData.replyTo, timestamp: new Date().toISOString()
        };
        
        const ch = servers[serverId].channels[channelId];
        if (ch.messages.length > 200) ch.messages.shift();
        ch.messages.push(message);

        io.to(serverId).emit('chat message', { serverId, channelId, message });
    });

    // --- SISTEMA DE CARGOS (Admin) ---
    socket.on('set role', ({ targetSocketId, role }) => {
        const admin = activeUsers.get(socket.id);
        if (admin && admin.name.toLowerCase() === 'dypz') {
            const targetUser = activeUsers.get(targetSocketId);
            if (targetUser && targetUser.name.toLowerCase() !== 'dypz') {
                targetUser.role = role;
                ipToUser.set(targetUser.ip, targetUser); // Salva no Anti-Alt
                io.emit('update users', Array.from(activeUsers.values()));
                io.emit('system message', `O cargo de ${targetUser.name} foi alterado para ${role}.`);
            }
        }
    });

    // --- WebRTC (VOZ E TELA) Sinalização ---
    socket.on('join voice', ({ serverId, channelId }) => {
        const user = activeUsers.get(socket.id);
        if(user) {
            user.voiceChannelId = channelId;
            io.emit('update users', Array.from(activeUsers.values()));
        }
        const room = `voice-${serverId}-${channelId}`;
        socket.join(room);
        socket.to(room).emit('user joined voice', socket.id);
    });

    socket.on('leave voice', ({ serverId, channelId }) => {
        const user = activeUsers.get(socket.id);
        if(user) {
            user.voiceChannelId = null;
            io.emit('update users', Array.from(activeUsers.values()));
        }
        const room = `voice-${serverId}-${channelId}`;
        socket.leave(room);
        socket.to(room).emit('user left voice', socket.id);
    });

    socket.on('webrtc signal', (data) => {
        io.to(data.target).emit('webrtc signal', { sender: socket.id, signal: data.signal });
    });

    // --- ADMIN DYPZ ---
    socket.on('delete message', ({ serverId, channelId, msgId }) => {
        const user = activeUsers.get(socket.id);
        // Admin (dypz) ou Moderadores podem apagar
        if (user && (user.role === 'Admin' || user.role === 'Moderador') && servers[serverId]) {
            servers[serverId].channels[channelId].messages = servers[serverId].channels[channelId].messages.filter(m => m.id !== msgId);
            io.to(serverId).emit('message deleted', { channelId, msgId });
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
                io.emit('system message', `dypz baniu ${targetUser.name} permanentemente através do Painel de Controle.`);
            }
        }
    });

    socket.on('disconnect', () => {
        const user = activeUsers.get(socket.id);
        if (user) {
            activeUsers.delete(socket.id);
            io.emit('update users', Array.from(activeUsers.values()));
            socket.broadcast.emit('user left voice', socket.id);
        }
    });

    function joinServer(socket, serverId) {
        Array.from(socket.rooms).forEach(room => {
            if (room !== socket.id && room !== serverId && !room.startsWith('voice-')) socket.leave(room);
        });
        socket.join(serverId);
        socket.emit('server data', servers[serverId]);
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Danicord rodando na porta ${PORT}`));
