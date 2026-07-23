/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  YOTA — Funil Comercial Online  ·  bitrix-funil.js  v3       ║
 * ║  Railway (yota-backend)                                      ║
 * ║                                                              ║
 * ║  Conta pelo HISTÓRICO de etapas (quem PASSOU pela etapa),    ║
 * ║  não pela etapa atual do card. Regras validadas contra o     ║
 * ║  Bitrix real em 22/07/2026.                                  ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

const express = require('express');
const router  = express.Router();

// ════════════════════════════════════════════════════════════
// CONFIGURAÇÃO
// ════════════════════════════════════════════════════════════
const PIPELINE_ID = 22;                 // COM. ONLINE NV.
const TZ          = 'America/Fortaleza'; // Natal/RN (UTC-3, sem horário de verão)
const TTL_MS      = 5 * 60 * 1000;       // cache de 5 minutos
const MAX_DIAS    = 400;                 // trava de segurança da janela

// Mapa REAL das etapas — extraído de crm.dealcategory.stage.list?id=22
// g = grupo: 1 SDR · 2 Closer · 3 Encerrado
const STAGES = {
  'C22:NEW'               : { n: 'LEAD',                  g: 1, s: 10  },
  'C22:UC_5BPBXG'         : { n: 'MQL',                   g: 1, s: 20  },
  'C22:UC_7T8VE5'         : { n: 'FOLLOW-UP 1',           g: 1, s: 30  },
  'C22:1'                 : { n: 'FOLLOW-UP 2',           g: 1, s: 40  },
  'C22:2'                 : { n: 'FOLLOW-UP 3',           g: 1, s: 50  },
  'C22:UC_AL2ADW'         : { n: 'NUTRIÇÃO',              g: 1, s: 60  },
  'C22:PREPARATION'       : { n: 'MUDO',                  g: 1, s: 70  },
  'C22:PREPAYMENT_INVOIC' : { n: 'PROPOSTA',              g: 1, s: 80  },
  'C22:UC_TQLGDY'         : { n: 'PENDENTE DE APROVAÇÃO', g: 1, s: 90  },
  'C22:UC_CJK6DW'         : { n: 'APROVADO RECUPERADO',   g: 1, s: 100 },
  'C22:UC_SG6G3W'         : { n: 'REUNIÃO',               g: 2, s: 110 },
  'C22:UC_HJ91TL'         : { n: 'NO SHOW',               g: 2, s: 120 },
  'C22:UC_HMX25R'         : { n: 'CALL 1',                g: 2, s: 130 },
  'C22:UC_RITC68'         : { n: 'CALL 2',                g: 2, s: 140 },
  'C22:UC_4TL73R'         : { n: 'CALL 3',                g: 2, s: 150 },
  'C22:UC_WI7TZ0'         : { n: 'NEGOCIAÇÃO',            g: 2, s: 160 },
  'C22:UC_IIC7V2'         : { n: 'ESFRIOU',               g: 2, s: 170 },
  'C22:UC_LESBGS'         : { n: 'STAND-BY (NUTRIÇÃO 2)', g: 2, s: 180 },
  'C22:UC_MWUK8W'         : { n: 'FECHAMENTO',            g: 2, s: 190 },
  'C22:UC_96B9D5'         : { n: 'FINALIZAÇÃO',           g: 2, s: 200 },
  'C22:WON'               : { n: 'NEGÓCIOS FECHADOS',     g: 3, s: 210 },
  'C22:LOSE'              : { n: 'CRÉDITO REPROVADO',     g: 3, s: 220 },
  'C22:APOLOGY'           : { n: 'ANALISAR FALHA',        g: 3, s: 230 },
  'C22:UC_J0L7TE'         : { n: 'FECHADO C/ OUTRA EMP.', g: 3, s: 240 },
};

const NUTRICAO = 'C22:UC_AL2ADW';
const VENDA    = 'C22:WON';
const FALHA    = 'C22:APOLOGY';                       // depósito de lead morto
const PROPOSTA = ['C22:PREPAYMENT_INVOIC', 'C22:UC_TQLGDY', 'C22:UC_CJK6DW'];
const ENC_REAL = ['C22:LOSE', 'C22:UC_J0L7TE'];       // conversou: pediu crédito ou foi p/ concorrente

// Marcador do documento de handoff que a IA grava no campo COMMENTS
const IA_MARCADORES = ['HADNOFF', 'HANDOFF', 'ATENDIMENTO SDR'];

// ════════════════════════════════════════════════════════════
// DATAS — tudo no fuso de Natal
// ════════════════════════════════════════════════════════════
const _fmtDia = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
});
const diaNatal = iso => _fmtDia.format(new Date(iso));      // -> 'YYYY-MM-DD'

function somaDias(ymd, n) {
  const d = new Date(ymd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function difDias(ymdA, ymdB) {
  return Math.round((new Date(ymdB + 'T12:00:00Z') - new Date(ymdA + 'T12:00:00Z')) / 86400000);
}

// ════════════════════════════════════════════════════════════
// BITRIX
// ════════════════════════════════════════════════════════════
function getWebhook() {
  const url = process.env.BITRIX_WEBHOOK_URL;
  if (!url) throw new Error('BITRIX_WEBHOOK_URL não configurado nas variáveis do Railway');
  return url.endsWith('/') ? url : url + '/';
}

function flatten(obj, prefix, out) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v))                          v.forEach((it, i) => flatten({ [i]: it }, key, out));
    else if (v !== null && typeof v === 'object')  flatten(v, key, out);
    else if (v !== undefined && v !== null)        out.append(key, v);
  }
}

async function bxCall(method, params = {}) {
  const body = new URLSearchParams();
  flatten(params, '', body);
  const res = await fetch(`${getWebhook()}${method}.json`, {
    method : 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`Bitrix HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`Bitrix: ${data.error_description || data.error}`);
  return data;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Coorte: negócios CRIADOS na janela ──────────────────────
async function getDeals(iniYMD, fimYMD) {
  // pede com 1 dia de folga dos dois lados (fuso) e corta fino depois
  const filter = {
    CATEGORY_ID     : PIPELINE_ID,
    '>=DATE_CREATE' : somaDias(iniYMD, -1) + 'T00:00:00',
    '<=DATE_CREATE' : somaDias(fimYMD,  1) + 'T23:59:59',
  };
  const select = ['ID', 'TITLE', 'STAGE_ID', 'ASSIGNED_BY_ID',
                  'DATE_CREATE', 'OPPORTUNITY', 'COMMENTS'];

  const todos = [];
  let start = 0, guarda = 0;
  while (true) {
    const r = await bxCall('crm.deal.list', { filter, select, order: { DATE_CREATE: 'ASC' }, start });
    todos.push(...(r.result || []));
    if (r.next === undefined || r.next === null) break;
    start = r.next;
    if (++guarda > 200) break;
    await sleep(260);
  }
  // corte exato pelo dia de Natal
  return todos.filter(d => {
    const dia = diaNatal(d.DATE_CREATE);
    return dia >= iniYMD && dia <= fimYMD;
  });
}

// ── Histórico de etapas, em pacotes de 50 ───────────────────
async function getHistorico(ids, onProgress) {
  const out = {};
  let usarBatch = true;
  let feitos = 0;

  if (usarBatch) {
    for (let i = 0; i < ids.length; i += 50) {
      const lote = ids.slice(i, i + 50);
      const cmd  = {};
      lote.forEach((id, k) => {
        cmd['c' + k] = `crm.stagehistory.list?entityTypeId=2&filter[OWNER_ID]=${id}`;
      });
      try {
        const r   = await bxCall('batch', { halt: 0, cmd });
        const res = (r.result && r.result.result) || {};
        let ok = 0;
        lote.forEach((id, k) => {
          const bloco = res['c' + k];
          if (bloco && bloco.items) { out[id] = bloco.items; ok++; }
          else                      { out[id] = out[id] || []; }
        });
        feitos += lote.length;
        if (onProgress) onProgress(feitos, ids.length);
        if (ok === 0) { usarBatch = false; break; }
      } catch (e) {
        usarBatch = false;
        break;
      }
      await sleep(350);
    }
    if (usarBatch) return out;
  }

  // plano B: um a um
  for (const id of ids) {
    try {
      const r = await bxCall('crm.stagehistory.list', { entityTypeId: 2, filter: { OWNER_ID: id } });
      out[id] = (r.result && r.result.items) || [];
    } catch { out[id] = []; }
    if (onProgress) onProgress(++feitos, ids.length);
    await sleep(210);
  }
  return out;
}

async function getUsuarios() {
  try {
    const r   = await bxCall('user.get', {});
    const map = {};
    for (const u of (r.result || [])) {
      map[String(u.ID)] = `${u.NAME || ''} ${u.LAST_NAME || ''}`.trim() || ('Usuário ' + u.ID);
    }
    return map;
  } catch { return {}; }   // webhook sem permissão de usuários — segue com IDs
}

// ════════════════════════════════════════════════════════════
// REGRAS DO FUNIL  (validadas em 22/07/2026)
//
//  Retorno         = o cliente respondeu de verdade.
//                    Follow-up NÃO conta (é o SDR perseguindo cliente calado)
//                    e lead mudo arquivado em "Analisar falha" também não.
//  Desenvolvimento = respondeu E avançou (Proposta em diante, ou Closer,
//                    ou encerrou com resultado real).
//  Reunião         = passou por qualquer etapa do Closer (grupo 2).
//  Venda           = chegou em NEGÓCIOS FECHADOS.
// ════════════════════════════════════════════════════════════
function classificar(set) {
  let g2 = false;
  for (const s of set) { const m = STAGES[s]; if (m && m.g === 2) g2 = true; }
  if (set.has(VENDA))                         return 'venda';
  if (g2)                                     return 'closer';
  if (PROPOSTA.some(s => set.has(s)))         return 'proposta';
  if (ENC_REAL.some(s => set.has(s)))         return 'encreal';
  if (set.has(NUTRICAO))                      return 'nutricao';
  if (set.has(FALHA))                         return 'arquivado';
  return 'sem';
}
const RET_SIM = ['nutricao', 'encreal', 'proposta', 'closer', 'venda'];
const DES_SIM = ['encreal', 'proposta', 'closer', 'venda'];

function temIA(comments) {
  if (!comments) return false;
  const u = String(comments).toUpperCase();
  return IA_MARCADORES.some(m => u.includes(m));
}

// ════════════════════════════════════════════════════════════
// MONTAGEM
// ════════════════════════════════════════════════════════════
function montar(deals, hist, usuarios, iniYMD, fimYMD) {
  const linhas = deals.map(d => {
    const itens = hist[d.ID] || [];
    const set   = new Set(itens.map(i => i.STAGE_ID));
    set.add(d.STAGE_ID);                       // segurança: etapa atual sempre conta

    let tocouG2 = false;
    for (const s of set) { const m = STAGES[s]; if (m && m.g === 2) tocouG2 = true; }

    const cls   = classificar(set);
    const atual = STAGES[d.STAGE_ID] || null;
    const dia   = diaNatal(d.DATE_CREATE);

    const venceu = itens.find(i => i.STAGE_ID === VENDA);
    const diasAteVenda = venceu
      ? Math.max(0, difDias(dia, diaNatal(venceu.CREATED_TIME)))
      : null;

    return {
      id       : d.ID,
      titulo   : d.TITLE || '',
      dia,                                     // YYYY-MM-DD no fuso de Natal
      etapa    : atual ? atual.n : d.STAGE_ID,
      grupo    : atual ? atual.g : 1,
      cls,
      ret      : RET_SIM.includes(cls),
      des      : DES_SIM.includes(cls),
      reu      : tocouG2,
      ven      : cls === 'venda',
      ia       : temIA(d.COMMENTS),
      valor    : parseFloat(d.OPPORTUNITY) || 0,
      // Só vale quando o card NUNCA foi para o Closer: aí o responsável
      // ainda é o SDR original. Serve para conferência, nunca para agrupar.
      sdrReal  : tocouG2 ? null : String(d.ASSIGNED_BY_ID),
      semRastro: itens.length === 0,
    };
  });

  const n     = linhas.length;
  const conta = f => linhas.filter(f).length;
  const ret   = conta(r => r.ret);
  const des   = conta(r => r.des);
  const reu   = conta(r => r.reu);
  const ven   = conta(r => r.ven);
  const taxa  = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);

  // distribuição do diagnóstico
  const diag = {};
  for (const r of linhas) diag[r.cls] = (diag[r.cls] || 0) + 1;

  // ciclo até a venda
  const ciclos = linhas.filter(r => r.ven).map(r => {
    const v = (hist[r.id] || []).find(i => i.STAGE_ID === VENDA);
    return v ? Math.max(0, difDias(r.dia, diaNatal(v.CREATED_TIME))) : null;
  }).filter(x => x !== null).sort((a, b) => a - b);
  const ciclo = ciclos.length ? {
    mediana : ciclos[Math.floor(ciclos.length / 2)],
    min     : ciclos[0],
    max     : ciclos[ciclos.length - 1],
    amostra : ciclos.length,
    confiavel: ciclos.length >= 5,
  } : null;

  // IA vs sem IA
  const comIA = linhas.filter(r => r.ia);
  const semIA = linhas.filter(r => !r.ia);

  // quem o Bitrix registrou (só cards que nunca foram ao Closer)
  const registrados = {};
  for (const r of linhas) {
    if (!r.sdrReal) continue;
    const k = r.sdrReal;
    registrados[k] = registrados[k] || { id: k, nome: usuarios[k] || ('Usuário ' + k), cards: 0, de: r.dia, ate: r.dia };
    registrados[k].cards++;
    if (r.dia < registrados[k].de)  registrados[k].de  = r.dia;
    if (r.dia > registrados[k].ate) registrados[k].ate = r.dia;
  }

  // maturação: o ciclo observado vai até ~34 dias
  const hoje  = diaNatal(new Date().toISOString());
  const idade = difDias(fimYMD, hoje);

  return {
    periodo: { dataInicio: iniYMD, dataFim: fimYMD, diasDesdeFechamento: idade, emMaturacao: idade < 30 },
    funil: {
      leads: n, retorno: ret, desenvolvimento: des, reuniao: reu, vendas: ven,
      pctRetorno: taxa(ret, n), pctDesenvolvimento: taxa(des, n),
      pctReuniao: taxa(reu, n), pctVendas: taxa(ven, n),
    },
    taxas: {
      sdrLeadReuniao   : taxa(reu, n),     // conversão do SDR
      sdrRespondeuReuniao: taxa(reu, ret), // tira o efeito da qualidade do lead
      closerReuniaoVenda : taxa(ven, reu), // conversão do Closer
    },
    diagnostico: {
      sem: diag.sem || 0, arquivado: diag.arquivado || 0, nutricao: diag.nutricao || 0,
      encreal: diag.encreal || 0, proposta: diag.proposta || 0,
      closer: diag.closer || 0, venda: diag.venda || 0,
    },
    ciclo,
    receita: linhas.filter(r => r.ven).reduce((s, r) => s + r.valor, 0),
    ia: {
      total: comIA.length, pct: taxa(comIA.length, n),
      reuniaoComIA: taxa(comIA.filter(r => r.reu).length, comIA.length),
      reuniaoSemIA: taxa(semIA.filter(r => r.reu).length, semIA.length),
      amostraOk: comIA.length >= 20 && semIA.length >= 20,
    },
    responsaveisRegistrados: Object.values(registrados).sort((a, b) => b.cards - a.cards),
    semRastro: conta(r => r.semRastro),
    // linhas cruas: o front agrupa por período de SDR e monta a tabela de conferência
    linhas,
  };
}

// ════════════════════════════════════════════════════════════
// CACHE
// ════════════════════════════════════════════════════════════
const _cache = new Map();

async function getDados(iniYMD, fimYMD, force) {
  const chave = `${iniYMD}_${fimYMD}`;
  const agora = Date.now();
  if (!force && _cache.has(chave) && agora - _cache.get(chave).ts < TTL_MS) {
    return { ..._cache.get(chave).data, doCache: true };
  }

  const usuariosP = getUsuarios();
  const deals     = await getDeals(iniYMD, fimYMD);
  const hist      = deals.length ? await getHistorico(deals.map(d => d.ID)) : {};
  const usuarios  = await usuariosP;

  const dados = {
    ok: true,
    geradoEm: new Date().toISOString(),
    pipeline: PIPELINE_ID,
    totalDeals: deals.length,
    ...montar(deals, hist, usuarios, iniYMD, fimYMD),
    doCache: false,
  };
  _cache.set(chave, { ts: agora, data: dados });
  return dados;
}

// ════════════════════════════════════════════════════════════
// ENDPOINTS
// ════════════════════════════════════════════════════════════

// GET /dados?dataInicio=2026-07-01&dataFim=2026-07-22[&refresh=1]
// GET /dados?periodo=hoje|7d|30d|mes
router.get('/dados', async (req, res) => {
  try {
    let ini = req.query.dataInicio;
    let fim = req.query.dataFim;

    if (!ini || !fim) {
      const hoje = diaNatal(new Date().toISOString());
      const p = req.query.periodo || 'mes';
      if      (p === 'hoje') { ini = hoje;              fim = hoje; }
      else if (p === '7d')   { ini = somaDias(hoje, -7);  fim = hoje; }
      else if (p === '30d')  { ini = somaDias(hoje, -30); fim = hoje; }
      else                   { ini = hoje.slice(0, 8) + '01'; fim = hoje; }  // mês atual
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(ini) || !/^\d{4}-\d{2}-\d{2}$/.test(fim)) {
      return res.status(400).json({ ok: false, erro: 'Datas devem estar no formato AAAA-MM-DD.' });
    }
    if (ini > fim) {
      return res.status(400).json({ ok: false, erro: 'A data inicial está depois da final.' });
    }
    if (difDias(ini, fim) > MAX_DIAS) {
      return res.status(400).json({ ok: false, erro: `Janela muito longa (máximo ${MAX_DIAS} dias).` });
    }

    const dados = await getDados(ini, fim, req.query.refresh === '1');
    res.json(dados);
  } catch (err) {
    console.error('[funil/dados]', err.message);
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// GET /config — conferência rápida de que o módulo subiu certo
router.get('/config', (_req, res) => {
  res.json({
    ok: true, versao: 3, pipeline: PIPELINE_ID, fuso: TZ,
    etapasMapeadas: Object.keys(STAGES).length,
    webhookConfigurado: !!process.env.BITRIX_WEBHOOK_URL,
    cacheMinutos: TTL_MS / 60000,
    regras: {
      retorno        : 'passou por Nutrição, Proposta, Pendente, Aprovado, Closer, Crédito Reprovado ou Fechado c/ Outra Emp.',
      naoContaRetorno: 'só follow-up, ou mudo arquivado em Analisar falha',
      desenvolvimento: 'Proposta em diante, Closer, ou encerrado com resultado real',
      reuniao        : 'passou por qualquer etapa do Closer (grupo 2)',
      venda          : 'chegou em NEGÓCIOS FECHADOS',
    },
  });
});

module.exports = router;
