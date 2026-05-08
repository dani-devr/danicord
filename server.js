const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 1e8 // Permite uploads grandes via socket se necessário (100MB)
});

// Garante que a pasta de uploads exista
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Configuração do Multer para salvar arquivos (sem limite de tamanho restrito pelo node, mas cuidado com a RAM do Render)
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 1000 * 1024 * 1024 } // Limite de 1GB para vídeos grandes
});

// Serve os arquivos estáticos (o HTML, CSS e os uploads)
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Rota de Upload
app.post('/upload', upload.single('media'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    }
    
    // Identifica o tipo do arquivo
    const mime = req.file.mimetype;
    let type = 'file';
    if (mime.startsWith('image/')) type = 'image';
    if (mime.startsWith('video/')) type = 'video';
    if (mime.startsWith('audio/')) type = 'audio';

    const fileUrl = `/uploads/${req.file.filename}`;
    res.json({ url: fileUrl, type: type });
});

// Histórico em memória (em produção ideal usar banco de dados)
const chatHistory = [];
const activeUsers = new Map();

// Gerenciamento do Socket.io (Tempo Real)
io.on('connection', (socket) => {
    console.log('Um usuário conectou:', socket.id);

    // Envia o histórico para o usuário que acabou de entrar
    socket.emit('chat history', chatHistory);

    // Quando um usuário entra no chat com seus dados
    socket.on('user joined', (userData) => {
        activeUsers.set(socket.id, userData);
        io.emit('update users', Array.from(activeUsers.values()));
        
        const joinMessage = {
            type: 'system',
            text: `${userData.name} entrou no Danicord!`,
            timestamp: new Date().toISOString()
        };
        io.emit('chat message', joinMessage);
    });

    // Quando o usuário envia uma mensagem ou mídia
    socket.on('chat message', (msgData) => {
        const message = {
            id: Date.now().toString(),
            user: activeUsers.get(socket.id) || msgData.user, // Fallback se o servidor reiniciar
            text: msgData.text,
            mediaUrl: msgData.mediaUrl,
            mediaType: msgData.mediaType,
            timestamp: new Date().toISOString()
        };
        
        // Mantém as últimas 100 mensagens para não pesar a RAM do Render
        if (chatHistory.length > 100) chatHistory.shift();
        chatHistory.push(message);

        io.emit('chat message', message);
    });

    // Quando o usuário desconecta
    socket.on('disconnect', () => {
        const user = activeUsers.get(socket.id);
        if (user) {
            const leaveMessage = {
                type: 'system',
                text: `${user.name} saiu do servidor.`,
                timestamp: new Date().toISOString()
            };
            io.emit('chat message', leaveMessage);
            activeUsers.delete(socket.id);
            io.emit('update users', Array.from(activeUsers.values()));
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Danicord rodando na porta ${PORT}`);
});