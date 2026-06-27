const express  = require('express');
const https    = require('https');
const Setting  = require('../models/Setting');
const Proposal = require('../models/Proposal');
const { auth, adminOnly } = require('../middleware/auth');

const router = express.Router();

// ── Bitrix24: helpers (anti-duplicidade) ──────────────────────
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
      reqB.setTimeout(5000, () => { reqB.destroy(); resolve(null); });
      reqB.write(body);
      reqB.end();
    } catch(e) { resolve(null); }
  });
}

// Procura um card JÁ EXISTENTE no funil COMERCIAL (CATEGORY_ID 12) por telefone.
async function buscarDealComercialPorTelefone(webhookUrl, telefoneLimpo) {
  if (!telefoneLimpo) return null;
  const resp = await bitrixPost(webhookUrl, 'crm.duplicate.findbycomm', {
    type: 'PHONE', entity_type: 'DEAL', values: [telefoneLimpo],
  });
  const ids = (resp && resp.result && Array.isArray(resp.result.DEAL)) ? resp.result.DEAL : [];
  for (const id of ids) {
    const d = await bitrixPost(webhookUrl, 'crm.deal.get', { id });
    if (d && d.result && String(d.result.CATEGORY_ID) === '12') {
      return d.result.ID;
    }
  }
  return null;
}

// Posta um comentário na timeline de um card existente.
async function postarComentarioTimeline(webhookUrl, dealId, texto, authorId) {
  const fields = { ENTITY_ID: dealId, ENTITY_TYPE: 'deal', COMMENT: texto };
  if (authorId) fields.AUTHOR_ID = authorId;
  await bitrixPost(webhookUrl, 'crm.timeline.comment.add', { fields });
}

// ── Bitrix24: criar negócio ──────────────────────────────────
async function criarNegocioBitrix(prop, vendedor) {
  try {
    // Buscar configurações do Bitrix no banco
    const [webhookSetting, usersSetting] = await Promise.all([
      Setting.findOne({ key: 'bitrix_webhook_url' }),
      Setting.findOne({ key: 'bitrix_users' }),
    ]);

    const webhookUrl = webhookSetting ? webhookSetting.value : null;
    if (!webhookUrl) {
      console.warn('[Bitrix] Webhook não configurado — negócio não criado.');
      return;
    }

    // Mapear e-mail do vendedor para ID Bitrix
    const usersMap  = usersSetting ? usersSetting.value : {};
    const bitrixId  = usersMap[vendedor.email] || null;

    // ── ANTI-DUPLICIDADE: já existe card no funil COMERCIAL com este telefone? ──
    const telefoneLimpo = (prop.telefone || '').replace(/\D/g, '');
    const dealExistente = await buscarDealComercialPorTelefone(webhookUrl, telefoneLimpo);
    if (dealExistente) {
      const quando = new Date().toLocaleString('pt-BR', { timeZone: 'America/Fortaleza' });
      const comentarioDup =
        `Novo contato via Base Comercial (PROPOSTA) — ${vendedor.nome}` +
        (prop.cidade ? ` | Cidade: ${prop.cidade}` : '') +
        (prop.quantidade_placas ? ` | Placas: ${prop.quantidade_placas}` : '') +
        (prop.observacao ? ` | Obs: ${prop.observacao}` : '') +
        ` | ${quando}`;
      await postarComentarioTimeline(webhookUrl, dealExistente, comentarioDup, bitrixId);
      console.log(`[Bitrix] Cliente já tinha card (ID=${dealExistente}) — comentário adicionado, sem duplicar.`);
      return;
    }

    // Montar comentários com dados técnicos
    const comentario = [
      `Vendedor: ${vendedor.nome}`,
      `Cidade: ${prop.cidade}`,
      `Placas: ${prop.quantidade_placas}`,
      prop.kwp          ? `kWp: ${prop.kwp}` : null,
      prop.tipo_rede    ? `Rede: ${prop.tipo_rede}` : null,
      prop.consumo_kwh  ? `Consumo: ${prop.consumo_kwh} kWh` : null,
      prop.valor_kit    ? `Valor kit: ${prop.valor_kit}` : null,
      prop.observacao   ? `Obs: ${prop.observacao}` : null,
    ].filter(Boolean).join('\n');

    // Payload do negócio
    const payload = {
      fields: {
        TITLE:       `${prop.nome_cliente} — Proposta Solar`,
        CATEGORY_ID: 12,                   // Pipeline COMERCIAL
        STAGE_ID:    'C12:PREPARATION',    // Etapa PROPOSTA
        COMMENTS:    comentario,
        PHONE: prop.telefone
          ? [{ VALUE: prop.telefone, VALUE_TYPE: 'WORK' }]
          : undefined,
      }
    };

    // Definir responsável se mapeado
    if (bitrixId) payload.fields.ASSIGNED_BY_ID = bitrixId;

    // Montar URL da chamada
    const url = webhookUrl.replace(/\/$/, '') + '/crm.deal.add.json';

    // Fazer POST para o Bitrix
    await new Promise((resolve, reject) => {
      const body = JSON.stringify(payload);
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

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.result) {
              console.log(`[Bitrix] Negócio criado ID=${json.result} para "${prop.nome_cliente}"`);
            } else {
              console.warn('[Bitrix] Resposta inesperada:', data);
            }
          } catch(e) {}
          resolve();
        });
      });

      req.on('error', (e) => {
        console.warn('[Bitrix] Erro na requisição:', e.message);
        resolve(); // não rejeitar — não bloquear o fluxo
      });

      req.setTimeout(5000, () => {
        console.warn('[Bitrix] Timeout ao criar negócio.');
        req.destroy();
        resolve();
      });

      req.write(body);
      req.end();
    });

  } catch(e) {
    console.warn('[Bitrix] Erro geral:', e.message);
  }
}

// ── POST /api/proposals ── Criar proposta
router.post('/', auth, async (req, res) => {
  try {
    const {
      nome_cliente, telefone, cidade, quantidade_placas,
      kwp, valor_kit, observacao,
      consumo_kwh, tipo_rede, geracao_mensal, geracao_anual,
      area_util, inversor,
    } = req.body;

    if (!nome_cliente || !telefone || !cidade || !quantidade_placas)
      return res.status(400).json({ erro: 'Campos obrigatórios: nome_cliente, telefone, cidade, quantidade_placas.' });

    const prop = await Proposal.create({
      nome_cliente: nome_cliente.trim(),
      telefone:     telefone.trim(),
      cidade:       cidade.trim(),
      quantidade_placas: Number(quantidade_placas),
      kwp:          kwp ? Number(kwp) : undefined,
      valor_kit:    valor_kit || undefined,
      observacao:   observacao || '',
      consumo_kwh:  consumo_kwh ? Number(consumo_kwh) : undefined,
      tipo_rede,
      geracao_mensal:  geracao_mensal ? Number(geracao_mensal) : undefined,
      geracao_anual:   geracao_anual  ? Number(geracao_anual)  : undefined,
      area_util:       area_util      ? Number(area_util)      : undefined,
      inversor,
      vendedor_id:   req.user._id,
      vendedor_nome: req.user.nome,
    });

    // Disparar integração Bitrix de forma assíncrona (não bloqueia a resposta)
    criarNegocioBitrix(prop, {
      email: req.user.email,
      nome:  req.user.nome,
    }).catch(() => {});

    res.status(201).json(prop);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ── GET /api/proposals ── Listar (vendedor vê as suas; admin vê todas)
router.get('/', auth, async (req, res) => {
  try {
    const filter = req.user.tipo === 'admin' ? {} : { vendedor_id: req.user._id };
    const { status, cidade, limit = 100, page = 1 } = req.query;
    if (status) filter.status = status;
    if (cidade)  filter.cidade = new RegExp(cidade, 'i');

    const skip  = (Number(page) - 1) * Number(limit);
    const [docs, total] = await Promise.all([
      Proposal.find(filter).sort({ data_criacao: -1 }).skip(skip).limit(Number(limit)),
      Proposal.countDocuments(filter),
    ]);

    res.json({ total, pagina: Number(page), docs });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ── GET /api/proposals/:id ── Detalhe
router.get('/:id', auth, async (req, res) => {
  try {
    const prop = await Proposal.findById(req.params.id);
    if (!prop) return res.status(404).json({ erro: 'Proposta não encontrada.' });
    if (req.user.tipo !== 'admin' && String(prop.vendedor_id) !== String(req.user._id))
      return res.status(403).json({ erro: 'Acesso negado.' });
    res.json(prop);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ── PATCH /api/proposals/:id/status ── Atualizar status
router.patch('/:id/status', auth, async (req, res) => {
  try {
    const { status } = req.body;
    if (!['aberta','convertida','cancelada'].includes(status))
      return res.status(400).json({ erro: 'Status inválido.' });
    const prop = await Proposal.findById(req.params.id);
    if (!prop) return res.status(404).json({ erro: 'Proposta não encontrada.' });
    if (req.user.tipo !== 'admin' && String(prop.vendedor_id) !== String(req.user._id))
      return res.status(403).json({ erro: 'Acesso negado.' });
    prop.status = status;
    await prop.save();
    res.json(prop);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ── DELETE /api/proposals/:id ── Remover
router.delete('/:id', auth, async (req, res) => {
  try {
    const prop = await Proposal.findById(req.params.id);
    if (!prop) return res.status(404).json({ erro: 'Proposta não encontrada.' });
    if (req.user.tipo !== 'admin' && String(prop.vendedor_id) !== String(req.user._id))
      return res.status(403).json({ erro: 'Acesso negado.' });
    await prop.deleteOne();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ── GET /api/proposals/stats/summary ── Resumo admin
router.get('/stats/summary', auth, adminOnly, async (req, res) => {
  try {
    const stats = await Proposal.aggregate([
      { $group: {
        _id: '$vendedor_nome',
        total: { $sum: 1 },
        abertas: { $sum: { $cond: [{ $eq: ['$status','aberta'] }, 1, 0] } },
        convertidas: { $sum: { $cond: [{ $eq: ['$status','convertida'] }, 1, 0] } },
      }},
      { $sort: { total: -1 } },
    ]);
    res.json(stats);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

module.exports = router;
