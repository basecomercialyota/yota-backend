/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  YOTA — Dashboard Funil Comercial Online v2                 ║
 * ║  bitrix-funil.js — Railway (yota-backend)                   ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

const express = require('express');
const router  = express.Router();

// ════════════════════════════════════════════════════════════
// CONFIGURAÇÃO — edite aqui para adicionar/remover usuários
// ════════════════════════════════════════════════════════════
const CONFIG = {
  PIPELINE_ID: 22,  // "COM. ONLINE NV."

  ESTAGIO_VENDA      : 'C22:WON',          // NEGÓCIOS FECHADOS — única fonte de verdade para venda
  ESTAGIO_NEGOCIACAO : 'C22:UC_SG6G3W',   // NEGOCIAÇÃO
  ESTAGIO_PROPOSTA   : 'C22:PREPAYMENT_INVOIC', // PROPOSTA

  // Etapas que indicam que o SDR converteu o lead (gerou reunião para o Closer)
  ESTAGIOS_REUNIAO: [
    'C22:UC_SG6G3W',        // Negociação
    'C22:PREPAYMENT_INVOIC',// Proposta
    'C22:UC_TQLGDY',        // Pend. Aprovação
    'C22:UC_MWUK8W',        // Fechamento
    'C22:UC_LESBGS',        // Stand-by
    'C22:UC_96B9D5',        // Finalização
    'C22:WON',              // Negócios Fechados
  ],

  // Etapa ignorada (REPASSE)
  ESTAGIO_IGNORADO: 'C22:UC_54VG0E',   // REPASSE
  ESTAGIOS_IGNORADOS: ['C22:UC_54VG0E', 'C22:APOLOGY'],  // REPASSE + Analisar falha

  // ── CLOSERS — adicione IDs aqui para incluir novos closers ──
  CLOSER_IDS: [94, 50],  // 94=Allef Gabriel, 50=João Pedro Alves

  // ── SDRs — deixe vazio [] para tratar todos os não-closers como SDR ──
  SDR_IDS: [68],  // 68=Lauro Medeiros
};

const ESTAGIO_LABELS = {
  'C22:NEW'               : 'Lead',
  'C22:UC_5BPBXG'        : 'MQL',
  'C22:UC_7T8VE5'        : 'Follow-up 1',
  'C22:1'                : 'Follow-up 2',
  'C22:2'                : 'Follow-up 3',
  'C22:UC_AL2ADW'        : 'Nutrição',
  'C22:PREPARATION'      : 'Mudo',
  'C22:PREPAYMENT_INVOIC': 'Proposta',
  'C22:UC_TQLGDY'        : 'Pend. Aprovação',
  'C22:UC_SG6G3W'        : 'Negociação',
  'C22:UC_HJ91TL'        : 'Sem Retorno',
  'C22:UC_HMX25R'        : 'Call 1',
  'C22:UC_RITC68'        : 'Call 2',
  'C22:UC_4TL73R'        : 'Call 3',
  'C22:UC_IIC7V2'        : 'Esfriou',
  'C22:UC_MWUK8W'        : 'Fechamento',
  'C22:UC_LESBGS'        : 'Stand-by',
  'C22:UC_96B9D5'        : 'Finalização ✅',
  'C22:WON'              : 'Negócios Fechados',
  'C22:LOSE'             : 'Crédito Reprovado',
  'C22:UC_J0L7TE'        : 'Fechado Outra Emp.',
};

// ════════════════════════════════════════════════════════════
// BITRIX API
// ════════════════════════════════════════════════════════════
function getWebhook() {
  const url = process.env.BITRIX_WEBHOOK_URL;
  if (!url) throw new Error('BITRIX_WEBHOOK_URL não configurado');
  return url.endsWith('/') ? url : url + '/';
}

async function bxCall(method, params = {}) {
  const qs = new URLSearchParams();
  function flatten(obj, prefix = '') {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}[${k}]` : k;
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        flatten(v, key);
      } else if (Array.isArray(v)) {
        v.forEach((item, i) => qs.append(`${key}[${i}]`, item));
      } else if (v !== undefined && v !== null) {
        qs.append(key, v);
      }
    }
  }
  flatten(params);

  const res  = await fetch(`${getWebhook()}${method}.json?${qs.toString()}`);
  if (!res.ok) throw new Error(`Bitrix HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`Bitrix: ${data.error_description || data.error}`);
  return data.result;
}

// ════════════════════════════════════════════════════════════
// BUSCA DEALS — apenas pipeline 22, sem REPASSE
// ════════════════════════════════════════════════════════════
async function getDeals(dataInicio, dataFim) {
  const deals = [];
  let start = 0;

  const filter = { 'CATEGORY_ID': CONFIG.PIPELINE_ID };
  if (dataInicio) filter['>=DATE_CREATE'] = dataInicio;
  if (dataFim)    filter['<=DATE_CREATE'] = dataFim;

  const select = ['ID','TITLE','STAGE_ID','ASSIGNED_BY_ID',
                  'DATE_CREATE','DATE_MODIFY','OPPORTUNITY','CATEGORY_ID'];

  while (true) {
    const res = await bxCall('crm.deal.list', { filter, select, start });
    if (!res || !res.length) break;
    deals.push(...res);
    if (res.length < 50) break;
    start += 50;
  }

  // Remove etapa REPASSE
  return deals.filter(d => !CONFIG.ESTAGIOS_IGNORADOS.includes(d.STAGE_ID));
}

async function getUsuarios() {
  try {
    const res = await bxCall('user.get', { filter: { ACTIVE: true } });
    const map = {};
    for (const u of (res || [])) map[String(u.ID)] = `${u.NAME} ${u.LAST_NAME}`.trim();
    return map;
  } catch { return {}; }
}

// ════════════════════════════════════════════════════════════
// MÉTRICAS
// ════════════════════════════════════════════════════════════
function calcular(deals, usuarios) {
  // Enriquece
  for (const d of deals) {
    d._nome     = usuarios[String(d.ASSIGNED_BY_ID)] || `User ${d.ASSIGNED_BY_ID}`;
    d._isCloser = CONFIG.CLOSER_IDS.includes(Number(d.ASSIGNED_BY_ID));
    d._isSDR    = CONFIG.SDR_IDS.length > 0
      ? CONFIG.SDR_IDS.includes(Number(d.ASSIGNED_BY_ID))
      : !d._isCloser;
  }

  const sdrDeals    = deals.filter(d => d._isSDR);
  const closerDeals = deals.filter(d => d._isCloser);

  // ── SDR ──
  const totalLeads  = sdrDeals.length;
  const reunioes    = sdrDeals.filter(d => CONFIG.ESTAGIOS_REUNIAO.includes(d.STAGE_ID)).length;
  const txConversao = totalLeads > 0 ? (reunioes / totalLeads * 100).toFixed(1) : '0.0';

  const sdMap = {};
  for (const d of sdrDeals) {
    const id = String(d.ASSIGNED_BY_ID);
    if (!sdMap[id]) sdMap[id] = { nome: d._nome, leads: 0, reunioes: 0 };
    sdMap[id].leads++;
    if (CONFIG.ESTAGIOS_REUNIAO.includes(d.STAGE_ID)) sdMap[id].reunioes++;
  }
  const rankingSDR = Object.entries(sdMap).map(([id, v]) => ({
    vendedorId: id, vendedor: v.nome, leads: v.leads, reunioes: v.reunioes,
    conversao: v.leads > 0 ? (v.reunioes / v.leads * 100).toFixed(1) : '0.0',
    alertaBaixo: v.leads > 0 && v.reunioes / v.leads < 0.25,
  })).sort((a, b) => b.reunioes - a.reunioes);

  const porDia = {};
  for (const d of sdrDeals) {
    const key = new Date(d.DATE_CREATE).toISOString().slice(0,10);
    porDia[key] = (porDia[key] || 0) + 1;
  }

  // ── CLOSER ──
  const reunioesCloser = closerDeals.filter(d => CONFIG.ESTAGIOS_REUNIAO.includes(d.STAGE_ID)).length;
  const propostas = closerDeals.filter(d => [
    CONFIG.ESTAGIO_PROPOSTA, 'C22:UC_TQLGDY', CONFIG.ESTAGIO_NEGOCIACAO,
    CONFIG.ESTAGIO_VENDA, 'C22:WON',
  ].includes(d.STAGE_ID)).length;

  // VENDA = exclusivamente FINALIZAÇÃO
  const vendaDeals = closerDeals.filter(d => d.STAGE_ID === CONFIG.ESTAGIO_VENDA);
  const nVendas    = vendaDeals.length;
  const receita    = vendaDeals.reduce((s, d) => s + (parseFloat(d.OPPORTUNITY) || 0), 0);
  const ticket     = nVendas > 0 ? receita / nVendas : 0;

  const clMap = {};
  for (const d of closerDeals) {
    const id = String(d.ASSIGNED_BY_ID);
    if (!clMap[id]) clMap[id] = { nome: d._nome, vendas: 0, receita: 0, propostas: 0 };
    if ([CONFIG.ESTAGIO_PROPOSTA, 'C22:UC_TQLGDY'].includes(d.STAGE_ID)) clMap[id].propostas++;
    if (d.STAGE_ID === CONFIG.ESTAGIO_VENDA) {
      clMap[id].vendas++;
      clMap[id].receita += parseFloat(d.OPPORTUNITY) || 0;
    }
  }
  const rankingCloser = Object.entries(clMap).map(([id, v]) => ({
    vendedorId: id, vendedor: v.nome, vendas: v.vendas,
    receita: v.receita, propostas: v.propostas,
    ticket: v.vendas > 0 ? v.receita / v.vendas : 0,
  })).sort((a, b) => b.receita - a.receita);

  // ── Pipeline ──
  const stageCount = {};
  for (const d of deals) {
    if (!stageCount[d.STAGE_ID]) stageCount[d.STAGE_ID] = { quantidade: 0, valor: 0 };
    stageCount[d.STAGE_ID].quantidade++;
    stageCount[d.STAGE_ID].valor += parseFloat(d.OPPORTUNITY) || 0;
  }
  const pipeline = {};
  for (const [stageId, dados] of Object.entries(stageCount)) {
    pipeline[stageId] = {
      label     : ESTAGIO_LABELS[stageId] || stageId,
      quantidade: dados.quantidade,
      valor     : dados.valor,
    };
  }

  // ── Alertas ──
  const agora   = Date.now();
  const alertas = [];
  for (const d of deals) {
    const dias  = Math.floor((agora - new Date(d.DATE_MODIFY).getTime()) / 86400000);
    const label = ESTAGIO_LABELS[d.STAGE_ID] || d.STAGE_ID;
    if (d.STAGE_ID === 'C22:NEW'                  && dias >= 1) alertas.push({ tipo: 'sem_contato',         dealId: d.ID, titulo: d.TITLE, vendedor: d._nome, estagio: label, diasParado: dias });
    if (d.STAGE_ID === CONFIG.ESTAGIO_NEGOCIACAO  && dias >= 5) alertas.push({ tipo: 'negociacao_parada',   dealId: d.ID, titulo: d.TITLE, vendedor: d._nome, estagio: label, diasParado: dias });
    if (d.STAGE_ID === CONFIG.ESTAGIO_PROPOSTA    && dias >= 3) alertas.push({ tipo: 'proposta_sem_retorno',dealId: d.ID, titulo: d.TITLE, vendedor: d._nome, estagio: label, diasParado: dias });
  }
  alertas.sort((a, b) => b.diasParado - a.diasParado);

  return {
    sdr    : { totalLeads, reunioes, taxaConversao: txConversao, rankingSDR, porDia },
    closer : { reunioes: reunioesCloser, propostas, vendas: nVendas, receita, ticketMedio: ticket,
               txReuProp: reunioesCloser > 0 ? (propostas/reunioesCloser*100).toFixed(1) : '0.0',
               txPropVend: propostas > 0 ? (nVendas/propostas*100).toFixed(1) : '0.0',
               txReuVend: reunioesCloser > 0 ? (nVendas/reunioesCloser*100).toFixed(1) : '0.0',
               rankingCloser },
    pipeline,
    alertas,
  };
}

// ════════════════════════════════════════════════════════════
// CACHE
// ════════════════════════════════════════════════════════════
const _cache  = new Map();
const TTL     = 5 * 60 * 1000;

async function getDados(dataInicio, dataFim, force) {
  const key = `${dataInicio||'*'}_${dataFim||'*'}`;
  const now  = Date.now();
  if (!force && _cache.has(key) && now - _cache.get(key).ts < TTL) return _cache.get(key).data;

  const [deals, usuarios] = await Promise.all([getDeals(dataInicio, dataFim), getUsuarios()]);
  const metricas = calcular(deals, usuarios);
  const result   = { ok: true, geradoEm: new Date().toISOString(),
                     pipeline_id: CONFIG.PIPELINE_ID, totalDeals: deals.length,
                     periodo: { dataInicio: dataInicio||null, dataFim: dataFim||null },
                     ...metricas };
  _cache.set(key, { ts: now, data: result });
  return result;
}

function periodoParaDatas(p) {
  const fim   = new Date(); fim.setHours(23,59,59,999);
  const fimS  = fim.toISOString();
  if (p === 'hoje') { const i = new Date(); i.setHours(0,0,0,0); return { dataInicio: i.toISOString(), dataFim: fimS }; }
  if (p === '7d')   { const i = new Date(Date.now()-7*86400000);  i.setHours(0,0,0,0); return { dataInicio: i.toISOString(), dataFim: fimS }; }
  if (p === '30d')  { const i = new Date(Date.now()-30*86400000); i.setHours(0,0,0,0); return { dataInicio: i.toISOString(), dataFim: fimS }; }
  return { dataInicio: null, dataFim: null };
}

// ════════════════════════════════════════════════════════════
// ENDPOINTS
// ════════════════════════════════════════════════════════════

// GET /funil/dados?periodo=hoje|7d|30d|all&refresh=1
// GET /funil/dados?dataInicio=ISO&dataFim=ISO
router.get('/dados', async (req, res) => {
  try {
    let dataInicio, dataFim;
    if (req.query.dataInicio && req.query.dataFim) {
      dataInicio = req.query.dataInicio;
      dataFim    = req.query.dataFim;
    } else {
      ({ dataInicio, dataFim } = periodoParaDatas(req.query.periodo || '30d'));
    }
    const dados = await getDados(dataInicio, dataFim, req.query.refresh === '1');
    res.json(dados);
  } catch (err) {
    console.error('[funil/dados]', err.message);
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// GET /funil/config — mostra configuração atual
router.get('/config', (req, res) => {
  res.json({ ok: true, pipeline_id: CONFIG.PIPELINE_ID,
             closer_ids: CONFIG.CLOSER_IDS, sdr_ids: CONFIG.SDR_IDS,
             estagio_venda: CONFIG.ESTAGIO_VENDA });
});

module.exports = router;
