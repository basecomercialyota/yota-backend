const express = require('express');
const https   = require('https');
const jwt     = require('jsonwebtoken');
const User    = require('../models/User');
const Setting = require('../models/Setting');
const { auth, adminOnly } = require('../middleware/auth');

const router = express.Router();

// ── Bitrix24: validação de cadastro ───────────────────────────
// Faz um POST JSON ao Bitrix e devolve a resposta (ou null se falhar).
function bitrixPost(base, method, payload) {
  return new Promise((resolve) => {
    try {
      const url    = base.replace(/\/$/, '') + '/' + method + '.json';
      const body   = JSON.stringify(payload);
      const urlObj = new URL(url);
      const options = {
        hostname: urlObj.hostname,
        path:     urlObj.pathname + urlObj.search,
        method:   'POST',
        headers:  {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      };
      const reqB = https.request(options, (resp) => {
        let data = '';
        resp.on('data', chunk => data += chunk);
        resp.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve(null); } });
      });
      reqB.on('error', () => resolve(null));
      reqB.setTimeout(8000, () => { reqB.destroy(); resolve(null); });
      reqB.write(body);
      reqB.end();
    } catch(e) { resolve(null); }
  });
}

// Verifica se o e-mail pertence a um usuário ATIVO do Bitrix.
// Retorna { ok:true, id } se encontrar; senão { ok:false, reason:'config'|'notfound' }.
async function validarConsultorBitrix(webhookUrl, email) {
  if (!webhookUrl) return { ok: false, reason: 'config' };
  const resp = await bitrixPost(webhookUrl, 'user.get', { FILTER: { EMAIL: email } });
  if (!resp)        return { ok: false, reason: 'config' };                 // rede/timeout/parse
  if (resp.error)   return { ok: false, reason: 'config', detail: resp.error_description || resp.error };

  const lista = Array.isArray(resp.result) ? resp.result : [];
  const alvo  = String(email).trim().toLowerCase();
  for (const u of lista) {
    const uEmail  = String(u.EMAIL || '').trim().toLowerCase();
    const inativo = (u.ACTIVE === false || String(u.ACTIVE) === 'N' || String(u.ACTIVE) === 'false');
    if (uEmail === alvo && !inativo) {
      return { ok: true, id: parseInt(u.ID, 10) };
    }
  }
  return { ok: false, reason: 'notfound' };
}

// Guarda o vínculo e-mail → ID Bitrix no Setting "bitrix_users"
// (mesmo lugar que proposta e visita já leem). Falha aqui não derruba o cadastro.
async function salvarVinculoBitrix(email, bitrixId) {
  try {
    const setting = await Setting.findOne({ key: 'bitrix_users' });
    const map = (setting && setting.value && typeof setting.value === 'object' && !Array.isArray(setting.value))
      ? setting.value : {};
    map[email] = bitrixId;
    await Setting.findOneAndUpdate(
      { key: 'bitrix_users' },
      { $set: { value: map } },
      { upsert: true, new: true }
    );
  } catch (e) {
    console.warn('[Bitrix] Não consegui salvar o vínculo email->ID:', e.message);
  }
}

// ── POST /api/register ── Criar conta (somente quem existe no Bitrix)
router.post('/register', async (req, res) => {
  try {
    const { nome, email, senha, tipo } = req.body;
    if (!nome || !email || !senha)
      return res.status(400).json({ erro: 'Nome, e-mail e senha são obrigatórios.' });
    if (senha.length < 6)
      return res.status(400).json({ erro: 'A senha deve ter mínimo 6 caracteres.' });

    const emailNorm = email.trim().toLowerCase();

    const existe = await User.findOne({ email: emailNorm });
    if (existe) return res.status(409).json({ erro: 'E-mail já cadastrado.' });

    // ── Validar no Bitrix e já capturar o ID do consultor ──
    const webhookSetting = await Setting.findOne({ key: 'bitrix_webhook_url' });
    const webhookUrl     = webhookSetting ? webhookSetting.value : null;
    const validacao      = await validarConsultorBitrix(webhookUrl, emailNorm);

    if (!validacao.ok) {
      if (validacao.reason === 'notfound') {
        return res.status(403).json({
          erro: 'Este e-mail não está cadastrado como usuário ativo no Bitrix. Fale com o gestor para ser incluído antes de criar o acesso.'
        });
      }
      // config / Bitrix fora do ar -> bloqueia com aviso temporário (mais seguro)
      if (validacao.detail) console.warn('[Bitrix] Falha na validação de cadastro:', validacao.detail);
      return res.status(503).json({
        erro: 'Não foi possível validar seu e-mail com o Bitrix agora. Tente novamente em instantes ou fale com o gestor.'
      });
    }

    const user = await User.create({
      nome: nome.trim(),
      email: emailNorm,
      senha,
      tipo: tipo === 'admin' ? 'admin' : 'vendedor',
    });

    // Guarda automaticamente o vínculo email -> ID (sem cadastro manual)
    if (validacao.id) await salvarVinculoBitrix(emailNorm, validacao.id);

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
