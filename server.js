const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 1e9 // Limite aumentado para 1GB (1e9 bytes)
});

const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Configuração do Multer para 1GB
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

// --- SISTEMAS DE MODERAÇÃO E ESTADO ---
const activeUsers = new Map();
const bannedIPs = new Set();
const activeIPs = new Map(); // Rastreia qual IP está conectado (anti-alt)

// Servidor inicial padrão
const servers = {
    'global': { id: 'global', name: 'Danicord Global', icon: 'fa-globe', type: 'public', messages: [] }
};

io.on('connection', (socket) => {
    // Identificação de IP (suporta localhost e serviços de proxy como Render)
    const clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;

    // 1. Verificação de Banimento por IP
    if (bannedIPs.has(clientIp)) {
        socket.emit('error message', 'Seu IP foi banido do Danicord.');
        socket.disconnect(true);
        return;
    }

    // 2. Sistema Anti-Alt (1 conta por IP)
    if (activeIPs.has(clientIp)) {
        socket.emit('error message', 'Apenas uma conexão por IP é permitida. Feche as outras contas.');
        socket.disconnect(true);
        return;
    }
    activeIPs.set(clientIp, socket.id);

    console.log('Usuário conectou:', socket.id, 'IP:', clientIp);

    // Variáveis anti-spam locais do socket
    socket.msgTimestamps = [];

    // Login do Usuário
    socket.on('user joined', ({ user, inviteId }) => {
        // Vincula a ID do socket ao usuário para facilitar banimentos e DMs
        user.socketId = socket.id;
        activeUsers.set(socket.id, user);
        
        let serverToJoin = 'global';
        if (inviteId && servers[inviteId]) serverToJoin = inviteId;

        // Envia as salas públicas iniciais para a barra do usuário
        socket.emit('initial servers', Object.values(servers).filter(s => s.type === 'public'));
        
        joinServer(socket, serverToJoin);
        io.emit('update users', Array.from(activeUsers.values()));
    });

    // Criação de Servidores Customizados
    socket.on('create server', (data) => {
        const newServerId = 'srv_' + Date.now().toString(36);
        servers[newServerId] = {
            id: newServerId, name: data.name, icon: 'fa-server', type: 'public', messages: []
        };
        // Envia para todos para aparecer na barra lateral
        io.emit('server created', servers[newServerId]); 
        joinServer(socket, newServerId);
    });

    // Criação de Grupos / DMs
    socket.on('create group', (data) => {
        const newServerId = 'grp_' + Date.now().toString(36);
        servers[newServerId] = {
            id: newServerId, name: data.name, icon: 'fa-users', type: 'group', messages: []
        };

        // Adiciona o criador e os convidados ao grupo
        const membersToJoin = [...data.members, socket.id];
        membersToJoin.forEach(memberId => {
            const memberSocket = io.sockets.sockets.get(memberId);
            if (memberSocket) {
                memberSocket.join(newServerId);
                memberSocket.emit('server created', servers[newServerId]); // Atualiza sidebar deles
            }
        });
        
        joinServer(socket, newServerId);
    });

    socket.on('join server', (serverId) => {
        if (servers[serverId]) joinServer(socket, serverId);
    });

    socket.on('update profile', (newProfile) => {
        newProfile.socketId = socket.id; // Mantém o id seguro
        activeUsers.set(socket.id, newProfile);
        io.emit('update users', Array.from(activeUsers.values()));
    });

    // Envio de Mensagem + Anti-Spam
    socket.on('chat message', (msgData) => {
        const user = activeUsers.get(socket.id);
        const serverId = msgData.serverId || 'global';
        if (!user || !servers[serverId]) return;

        // ANTI-SPAM: Checa as últimas 5 mensagens em um intervalo de 2 segundos
        const now = Date.now();
        socket.msgTimestamps.push(now);
        if (socket.msgTimestamps.length > 5) {
            socket.msgTimestamps.shift(); // Mantém apenas as últimas 5
            if (now - socket.msgTimestamps[0] < 2000) {
                socket.emit('error message', 'Calma! Você está enviando mensagens muito rápido (Spam).');
                return;
            }
        }

        const message = {
            id: Date.now().toString() + Math.random().toString(36).substring(7),
            user: user,
            text: msgData.text,
            mediaUrl: msgData.mediaUrl,
            mediaType: msgData.mediaType,
            replyTo: msgData.replyTo, // Suporte a Resposta
            timestamp: new Date().toISOString()
        };
        
        if (servers[serverId].messages.length > 200) servers[serverId].messages.shift();
        servers[serverId].messages.push(message);

        io.to(serverId).emit('chat message', { serverId, message });
    });

    // --- PODERES DO ADMIN DYPZ ---
    socket.on('delete message', ({ serverId, msgId }) => {
        const user = activeUsers.get(socket.id);
        if (user && user.name.toLowerCase() === 'dypz') {
            if (servers[serverId]) {
                servers[serverId].messages = servers[serverId].messages.filter(m => m.id !== msgId);
                io.to(serverId).emit('message deleted', msgId);
            }
        }
    });

    socket.on('ban user', (targetSocketId) => {
        const user = activeUsers.get(socket.id);
        if (user && user.name.toLowerCase() === 'dypz') {
            const targetSocket = io.sockets.sockets.get(targetSocketId);
            if (targetSocket) {
                const targetIp = targetSocket.handshake.headers['x-forwarded-for'] || targetSocket.handshake.address;
                bannedIPs.add(targetIp); // Bane o IP para sempre
                targetSocket.emit('error message', 'Você foi banido permanentemente por dypz.');
                targetSocket.disconnect(true);
                io.emit('system message', `dypz acaba de banir alguém com a força do martelo.`);
            }
        }
    });

    socket.on('disconnect', () => {
        activeIPs.delete(clientIp); // Libera o IP
        const user = activeUsers.get(socket.id);
        if (user) {
            activeUsers.delete(socket.id);
            io.emit('update users', Array.from(activeUsers.values()));
        }
    });

    function joinServer(socket, serverId) {
        // Encontra os servidores atuais e sai (para limpar a view), exceto se for o próprio socket ID
        Array.from(socket.rooms).forEach(room => {
            if (room !== socket.id && room !== serverId) socket.leave(room);
        });

        socket.join(serverId);
        const user = activeUsers.get(socket.id);

        socket.emit('server data', {
            server: servers[serverId],
            history: servers[serverId].messages
        });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Danicord rodando na porta ${PORT}`));
