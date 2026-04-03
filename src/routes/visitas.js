const express = require('express');
const Visita  = require('../models/Visita');
const { auth, adminOnly } = require('../middleware/auth');

const router = express.Router();

// ── POST /api/visitas ── Criar visita
router.post('/', auth, async (req, res) => {
  try {
    const { nome_cliente, telefone, cidade, indicado_por, status } = req.body;

    if (!nome_cliente || !nome_cliente.trim())
      return res.status(400).json({ erro: 'Nome do cliente é obrigatório.' });
    if (!telefone || telefone.replace(/\D/g, '').length < 10)
      return res.status(400).json({ erro: 'Telefone inválido.' });

    const visita = await Visita.create({
      nome_cliente:  nome_cliente.trim(),
      telefone:      telefone.trim(),
      cidade:        (cidade || '').trim(),
      indicado_por:  (indicado_por || '').trim(),
      vendedor_id:   req.user._id,
      vendedor_nome: req.user.nome,
      status:        ['visitado', 'interessado'].includes(status) ? status : 'visitado',
    });

    res.status(201).json(visita);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ── GET /api/visitas ── Listar (vendedor vê as suas; admin vê todas)
router.get('/', auth, async (req, res) => {
  try {
    const filter = req.user.tipo === 'admin' ? {} : { vendedor_id: req.user._id };
    const { status, limit = 50, page = 1 } = req.query;
    if (status) filter.status = status;

    const skip = (Number(page) - 1) * Number(limit);
    const [docs, total] = await Promise.all([
      Visita.find(filter).sort({ created_at: -1 }).skip(skip).limit(Number(limit)),
      Visita.countDocuments(filter),
    ]);

    res.json({ total, pagina: Number(page), docs });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ── PATCH /api/visitas/:id/status ── Atualizar status
router.patch('/:id/status', auth, async (req, res) => {
  try {
    const { status } = req.body;
    if (!['visitado', 'interessado'].includes(status))
      return res.status(400).json({ erro: 'Status inválido.' });

    const visita = await Visita.findById(req.params.id);
    if (!visita) return res.status(404).json({ erro: 'Visita não encontrada.' });
    if (req.user.tipo !== 'admin' && String(visita.vendedor_id) !== String(req.user._id))
      return res.status(403).json({ erro: 'Acesso negado.' });

    visita.status = status;
    await visita.save();
    res.json(visita);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ── DELETE /api/visitas/:id ── Excluir
router.delete('/:id', auth, async (req, res) => {
  try {
    const visita = await Visita.findById(req.params.id);
    if (!visita) return res.status(404).json({ erro: 'Visita não encontrada.' });
    if (req.user.tipo !== 'admin' && String(visita.vendedor_id) !== String(req.user._id))
      return res.status(403).json({ erro: 'Acesso negado.' });

    await visita.deleteOne();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ── GET /api/visitas/dashboard ── Dashboard admin
router.get('/dashboard', auth, adminOnly, async (req, res) => {
  try {
    const { periodo = '7', vendedor_id } = req.query;

    // Calcular datas
    const hoje = new Date();
    hoje.setHours(23, 59, 59, 999);
    const inicioPeriodo = new Date();
    inicioPeriodo.setDate(inicioPeriodo.getDate() - Number(periodo) + 1);
    inicioPeriodo.setHours(0, 0, 0, 0);

    const inicioHoje = new Date();
    inicioHoje.setHours(0, 0, 0, 0);

    // Filtro base
    const filtroBase = { created_at: { $gte: inicioPeriodo, $lte: hoje } };
    if (vendedor_id) filtroBase.vendedor_id = vendedor_id;

    // Totais em paralelo
    const [
      totalPeriodo,
      totalHoje,
      totalInteressado,
      rankingRaw,
      visitasPorDiaRaw,
      visitasRecentes,
    ] = await Promise.all([
      // Total no período
      Visita.countDocuments(filtroBase),

      // Total hoje
      Visita.countDocuments({ ...filtroBase, created_at: { $gte: inicioHoje, $lte: hoje } }),

      // Total interessados no período
      Visita.countDocuments({ ...filtroBase, status: 'interessado' }),

      // Ranking por vendedor
      Visita.aggregate([
        { $match: filtroBase },
        { $group: {
          _id: '$vendedor_id',
          vendedor_nome: { $first: '$vendedor_nome' },
          total: { $sum: 1 },
          interessados: { $sum: { $cond: [{ $eq: ['$status', 'interessado'] }, 1, 0] } },
        }},
        { $sort: { total: -1 } },
        { $limit: 20 },
      ]),

      // Visitas por dia (últimos 7 dias sempre)
      Visita.aggregate([
        { $match: {
          created_at: {
            $gte: (() => { const d = new Date(); d.setDate(d.getDate() - 6); d.setHours(0,0,0,0); return d; })(),
            $lte: hoje
          }
        }},
        { $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$created_at', timezone: 'America/Fortaleza' } },
          total: { $sum: 1 },
          interessados: { $sum: { $cond: [{ $eq: ['$status', 'interessado'] }, 1, 0] } },
        }},
        { $sort: { _id: 1 } },
      ]),

      // Visitas recentes
      Visita.find(filtroBase)
        .sort({ created_at: -1 })
        .limit(30)
        .select('nome_cliente cidade vendedor_nome status created_at telefone indicado_por'),
    ]);

    // Calcular taxa de conversão
    const taxaConversao = totalPeriodo > 0
      ? Math.round((totalInteressado / totalPeriodo) * 100)
      : 0;

    // Média por vendedor
    const totalVendedores = rankingRaw.length;
    const mediaVisitas = totalVendedores > 0
      ? Math.round((totalPeriodo / totalVendedores) * 10) / 10
      : 0;

    // Ranking com taxa de conversão
    const ranking = rankingRaw.map(v => ({
      vendedor_nome: v.vendedor_nome,
      total: v.total,
      interessados: v.interessados,
      taxa: v.total > 0 ? Math.round((v.interessados / v.total) * 100) : 0,
    }));

    res.json({
      resumo: {
        total_periodo:    totalPeriodo,
        total_hoje:       totalHoje,
        taxa_conversao:   taxaConversao,
        media_por_vendedor: mediaVisitas,
      },
      ranking,
      visitas_por_dia: visitasPorDiaRaw,
      visitas_recentes: visitasRecentes,
    });
  } catch (err) {
    console.error('Erro dashboard visitas:', err);
    res.status(500).json({ erro: err.message });
  }
});

module.exports = router;
