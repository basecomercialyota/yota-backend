const express = require('express');
const jwt     = require('jsonwebtoken');
const User    = require('../models/User');
const { auth, adminOnly } = require('../middleware/auth');

const router = express.Router();

// ── POST /api/register ── Criar conta
router.post('/register', async (req, res) => {
  try {
    const { nome, email, senha, tipo } = req.body;
    if (!nome || !email || !senha)
      return res.status(400).json({ erro: 'Nome, e-mail e senha são obrigatórios.' });
    if (senha.length < 6)
      return res.status(400).json({ erro: 'A senha deve ter mínimo 6 caracteres.' });

    const existe = await User.findOne({ email });
    if (existe) return res.status(409).json({ erro: 'E-mail já cadastrado.' });

    const user = await User.create({
      nome: nome.trim(),
      email: email.trim().toLowerCase(),
      senha,
      tipo: tipo === 'admin' ? 'admin' : 'vendedor',
    });

    const token = gerarToken(user);
    res.status(201).json({ token, user: user.toSafeJSON() });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ── POST /api/login ── Login
router.post('/login', async (req, res) => {
  try {
    const { email, senha } = req.body;
    if (!email || !senha)
      return res.status(400).json({ erro: 'E-mail e senha são obrigatórios.' });

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user || !user.ativo)
      return res.status(401).json({ erro: 'E-mail ou senha incorretos.' });

    const ok = await user.verificarSenha(senha);
    if (!ok) return res.status(401).json({ erro: 'E-mail ou senha incorretos.' });

    const token = gerarToken(user);
    res.json({ token, user: user.toSafeJSON() });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ── GET /api/users ── Listar usuários (admin)
router.get('/users', auth, adminOnly, async (req, res) => {
  try {
    const users = await User.find().select('-senha').sort({ data_criacao: -1 });
    res.json(users);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ── GET /api/me ── Usuário logado
router.get('/me', auth, (req, res) => {
  res.json(req.user);
});

// ── PATCH /api/users/:id/tipo ── Promover/rebaixar (admin)
router.patch('/users/:id/tipo', auth, adminOnly, async (req, res) => {
  try {
    const { tipo } = req.body;
    if (!['vendedor','admin'].includes(tipo))
      return res.status(400).json({ erro: 'Tipo inválido.' });
    const user = await User.findByIdAndUpdate(
      req.params.id, { tipo }, { new: true }
    ).select('-senha');
    if (!user) return res.status(404).json({ erro: 'Usuário não encontrado.' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ── DELETE /api/users/:id ── Remover (admin)
router.delete('/users/:id', auth, adminOnly, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.params.id, { ativo: false });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ── PATCH /api/users/:id/senha ── Alterar senha (admin)
router.patch('/users/:id/senha', auth, adminOnly, async (req, res) => {
  try {
    const { senha } = req.body;
    if (!senha || senha.length < 6)
      return res.status(400).json({ erro: 'Senha deve ter mínimo 6 caracteres.' });

    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ erro: 'Usuário não encontrado.' });

    user.senha = senha;
    user.ativo = true;
    await user.save();

    res.json({ ok: true, mensagem: 'Senha alterada com sucesso.' });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ── PATCH /api/me/senha ── Trocar própria senha (qualquer usuário autenticado)
router.patch('/me/senha', auth, async (req, res) => {
  try {
    const { senhaAtual, novaSenha } = req.body;

    if (!senhaAtual || !novaSenha)
      return res.status(400).json({ erro: 'Informe a senha atual e a nova senha.' });
    if (novaSenha.length < 6)
      return res.status(400).json({ erro: 'A nova senha deve ter mínimo 6 caracteres.' });
    if (senhaAtual === novaSenha)
      return res.status(400).json({ erro: 'A nova senha deve ser diferente da atual.' });

    const user = await User.findById(req.user._id);
    if (!user || !user.ativo)
      return res.status(404).json({ erro: 'Usuário não encontrado.' });

    const senhaCorreta = await user.verificarSenha(senhaAtual);
    if (!senhaCorreta)
      return res.status(401).json({ erro: 'Senha atual incorreta.' });

    user.senha = novaSenha;
    await user.save();

    res.json({ ok: true, mensagem: 'Senha alterada com sucesso.' });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

function gerarToken(user) {
  return jwt.sign(
    { id: user._id, email: user.email, tipo: user.tipo },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

module.exports = router;
