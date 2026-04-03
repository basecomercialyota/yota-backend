require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const connectDB  = require('./config/database');

const userRoutes     = require('./routes/users');
const proposalRoutes = require('./routes/proposals');
const contractRoutes = require('./routes/contracts');
const settingsRoutes = require('./routes/settings');
const visitasRoutes  = require('./routes/visitas');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Middlewares ──────────────────────────────────────────────
app.use(cors({
  origin:      process.env.CORS_ORIGIN || '*',
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Log simples em dev
if (process.env.NODE_ENV !== 'production') {
  app.use((req, _res, next) => {
    console.log(`${req.method} ${req.path}`);
    next();
  });
}

// ── Rotas ────────────────────────────────────────────────────
app.use('/api', userRoutes);
app.use('/api/proposals', proposalRoutes);
app.use('/api/contracts', contractRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/visitas', visitasRoutes);

// ── Health check ─────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({
  status: 'ok',
  env:    process.env.NODE_ENV || 'development',
  ts:     new Date().toISOString(),
}));

// ── 404 ───────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ erro: 'Rota não encontrada.' }));

// ── Error handler ────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ erro: 'Erro interno do servidor.' });
});

// ── Boot ─────────────────────────────────────────────────────
connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🚀 Yota API rodando na porta ${PORT}`);
    console.log(`   Health: http://localhost:${PORT}/health\n`);
  });
});
