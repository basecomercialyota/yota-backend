const express = require('express');
const router = express.Router();
const Setting = require('../models/Setting');
const { auth, adminOnly } = require('../middleware/auth');

// Chaves permitidas
const ALLOWED_KEYS = ['system_wa', 'email_whitelist', 'kits_overrides', 'bitrix_webhook_url', 'bitrix_users'];

// GET /api/settings/:key — qualquer usuário autenticado pode ler
router.get('/:key', auth, async (req, res) => {
  const { key } = req.params;

  if (!ALLOWED_KEYS.includes(key)) {
    return res.status(400).json({ erro: 'Chave inválida' });
  }

  try {
    const setting = await Setting.findOne({ key });

    if (!setting) {
      // Retorna valor padrão se ainda não existe no banco
      const defaults = {
  system_wa: '',
  email_whitelist: [],
  kits_overrides: {},
  bitrix_webhook_url: '',
  bitrix_users: {}
};
      return res.json({ key, value: defaults[key] });
    }

    res.json({ key: setting.key, value: setting.value });
  } catch (err) {
    console.error(`Erro ao buscar setting [${key}]:`, err);
    res.status(500).json({ erro: 'Erro interno ao buscar configuração' });
  }
});

// PUT /api/settings/:key — apenas admin pode gravar
router.put('/:key', auth, adminOnly, async (req, res) => {
  const { key } = req.params;
  const { value } = req.body;

  if (!ALLOWED_KEYS.includes(key)) {
    return res.status(400).json({ erro: 'Chave inválida' });
  }

  if (value === undefined || value === null) {
    return res.status(400).json({ erro: 'Campo value é obrigatório' });
  }

  // Validações específicas por chave
  if (key === 'system_wa') {
    if (typeof value !== 'string') {
      return res.status(400).json({ erro: 'system_wa deve ser uma string' });
    }
    // Aceita apenas dígitos
    if (value !== '' && !/^\d{10,15}$/.test(value)) {
      return res.status(400).json({ erro: 'Número inválido. Use apenas dígitos (ex: 5584999999999)' });
    }
  }

  if (key === 'email_whitelist') {
    if (!Array.isArray(value)) {
      return res.status(400).json({ erro: 'email_whitelist deve ser um array' });
    }
  }

  if (key === 'kits_overrides') {
    if (typeof value !== 'object' || Array.isArray(value)) {
      return res.status(400).json({ erro: 'kits_overrides deve ser um objeto' });
    }
  }

  try {
    const setting = await Setting.findOneAndUpdate(
      { key },
      { key, value, updatedAt: new Date() },
      { upsert: true, new: true }
    );

    res.json({ ok: true, key: setting.key, value: setting.value });
  } catch (err) {
    console.error(`Erro ao salvar setting [${key}]:`, err);
    res.status(500).json({ erro: 'Erro interno ao salvar configuração' });
  }
});

// GET /api/settings — retorna todas as configs de uma vez (otimização para o front)
router.get('/', auth, async (req, res) => {
  try {
    const settings = await Setting.find({ key: { $in: ALLOWED_KEYS } });

   const defaults = {
  system_wa: '',
  email_whitelist: [],
  kits_overrides: {},
  bitrix_webhook_url: '',
  bitrix_users: {}
};
    // Monta objeto com todas as chaves, usando default para as ausentes
    const result = {};
    ALLOWED_KEYS.forEach(k => {
      const found = settings.find(s => s.key === k);
      result[k] = found ? found.value : defaults[k];
    });

    res.json(result);
  } catch (err) {
    console.error('Erro ao buscar todas as settings:', err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

module.exports = router;
