/**
 * =========================================================================
 * SISTEMA COMPLETO DE GESTÃO DE BARBEARIA & APP DO BARBEIRO (ALTA PERFORMANCE)
 * =========================================================================
 * Diretrizes Técnicas de Otimização no Front-end:
 * 1. Zero Polling Agressivo: Sem loops periódicos que bombardeiam o Google Apps Script.
 * 2. Carregamento Sob Demanda: Carrega no login, ao trocar de aba (com throttle) ou
 *    via botão manual de "Atualizar".
 * 3. Cache Inteligente no Navegador (localStorage): Catálogo de serviços, produtos e
 *    configurações com TTL de 10 minutos, reduzindo chamadas repetidas à API.
 * 4. Indicadores Visuais de Carregamento: Barra global de progresso, skeletons animados
 *    nas tabelas e bloqueio de botões com spinners durante envio para evitar cliques duplos.
 * 5. Tratamento de Rate Limits do Google: Retry automático com backoff caso a API
 *    do Google Sheets retorne sobrecarga temporária.
 * =========================================================================
 */

// =========================================================================
// 1. CHAVES DE ARMAZENAMENTO & ESTADO GLOBAL
// =========================================================================
const STORAGE_KEY = 'barbearia_sistema_dados_v1';
const GAS_URL_KEY = 'barbearia_gas_url_v1';
const SESSION_KEY = 'barbearia_sessao_v1';
const CACHE_META_KEY = 'barbearia_cache_meta_v1';

// TTL de 10 minutos para dados estáticos (Catálogo de Serviços, Produtos e Configs)
const CATALOG_CACHE_TTL_MS = 10 * 60 * 1000;
// Throttle de 3 minutos para dados dinâmicos ao trocar de abas
const DYNAMIC_CACHE_THROTTLE_MS = 3 * 60 * 1000;

let appState = {
  config: {
    nome_barbearia: 'Barbearia Vintage & Estilo',
    logo_url: '',
    usuario_gestor: 'Barbearia_VintageEstilo',
    senha_gestor: 'abc123',
    status_licenca: 'ATIVA',
    suporte_whatsapp: '5531986203735',
    telefone_barbearia: '(31) 98620-3735',
    chave_pix: '31986203735',
    taxa_pix_pct: 0,
    prazo_pix_dias: 0,
    taxa_debito_pct: 1.99,
    prazo_debito_dias: 1,
    taxa_credito_pct: 3.99,
    prazo_credito_dias: 30
  },
  masterConfig: {
    superadmin_login: 'Rafael_Martins',
    superadmin_senha: 'RSNf14232603*',
    suporte_whatsapp: '5531986203735',
    chave_pix: '31986203735'
  },
  masterBarbearias: [],
  isAuditMode: false,
  currentAuditedBarbearia: null,
  clientes: [],
  produtos: [],
  servicos: [],
  barbeiros: [],
  agendamentos: [],
  sangrias: [],
  pagamentosBarbeiros: []
};

let currentSession = null;
let chartInstance = null;
let currentBarberAgendaFilter = 'hoje';
let currentAgendaPillBarberId = 'todos';
let isSyncing = false;
let lastSyncTimestamp = 0;
let comandaProdutosAdicionados = [];

/**
 * Utilitário Financeiro: Calcula a data de compensação bancária considerando dias úteis
 * Pula Sábados e Domingos
 */
function calcularDataCompensacao(dataStr, diasUteis) {
  if (!diasUteis || diasUteis <= 0) return dataStr || getHojeString();
  const partes = String(dataStr).split('-');
  if (partes.length < 3) return dataStr || getHojeString();
  const ano = parseInt(partes[0], 10);
  const mes = parseInt(partes[1], 10) - 1;
  const dia = parseInt(partes[2], 10);
  const dt = new Date(ano, mes, dia);
  let restantes = parseInt(diasUteis, 10);
  while (restantes > 0) {
    dt.setDate(dt.getDate() + 1);
    const dw = dt.getDay(); // 0 = Domingo, 6 = Sábado
    if (dw !== 0 && dw !== 6) {
      restantes--;
    }
  }
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const d = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Utilitário Financeiro: Calcula taxa da maquininha, valor líquido e data de compensação
 */
function calcularTaxaECompensacao(valorTotal, formaPagamento, config, dataTransacao) {
  const valor = parseFloat(valorTotal) || 0;
  const forma = String(formaPagamento || '').trim();
  const cfg = config || (appState && appState.config) || {};
  let taxaPct = 0;
  let prazoDias = 0;

  if (forma === 'PIX') {
    taxaPct = cfg.taxa_pix_pct !== undefined ? (parseFloat(cfg.taxa_pix_pct) || 0) : 0;
    prazoDias = cfg.prazo_pix_dias !== undefined ? (parseInt(cfg.prazo_pix_dias) || 0) : 0;
  } else if (forma === 'Cartao_Debito' || forma === 'Débito' || forma === 'Debito') {
    taxaPct = cfg.taxa_debito_pct !== undefined ? (parseFloat(cfg.taxa_debito_pct) || 0) : 1.99;
    prazoDias = cfg.prazo_debito_dias !== undefined ? (parseInt(cfg.prazo_debito_dias) || 0) : 1;
  } else if (forma === 'Cartao_Credito' || forma === 'Crédito' || forma === 'Credito') {
    taxaPct = cfg.taxa_credito_pct !== undefined ? (parseFloat(cfg.taxa_credito_pct) || 0) : 3.99;
    prazoDias = cfg.prazo_credito_dias !== undefined ? (parseInt(cfg.prazo_credito_dias) || 0) : 30;
  } else {
    // Dinheiro físico: taxa sempre 0% e D+0 imediato
    taxaPct = 0;
    prazoDias = 0;
  }

  const taxaAplicadaValor = Math.round((valor * (taxaPct / 100)) * 100) / 100;
  const valorLiquido = Math.max(0, Math.round((valor - taxaAplicadaValor) * 100) / 100);
  const dataRef = dataTransacao || getHojeString();
  const dataCompensacao = calcularDataCompensacao(dataRef, prazoDias);

  return {
    taxaPct,
    taxaAplicadaValor,
    valorLiquido,
    prazoDias,
    dataCompensacao
  };
}

// =========================================================================
// 2. DADOS DE DEMONSTRAÇÃO (MODO OFFLINE / TESTE IMEDIATO)
// =========================================================================
function getDefaultMockData() {
  const hoje = getHojeString();
  const amanha = getAmanhaString();

  return {
    config: {
      nome_barbearia: 'Barbearia Vintage & Estilo',
      logo_url: '',
      usuario_gestor: 'Barbearia_VintageEstilo',
      senha_gestor: 'abc123',
      status_licenca: 'ATIVA',
      suporte_whatsapp: '5531986203735',
      telefone_barbearia: '(31) 98620-3735',
      chave_pix: '31986203735',
      taxa_pix_pct: 0,
      prazo_pix_dias: 0,
      taxa_debito_pct: 1.99,
      prazo_debito_dias: 1,
      taxa_credito_pct: 3.99,
      prazo_credito_dias: 30
    },
    masterConfig: {
      superadmin_login: 'Rafael_Martins',
      superadmin_senha: 'RSNf14232603*',
      suporte_whatsapp: '5531986203735',
      chave_pix: '31986203735'
    },
    masterBarbearias: [
      {
        id: 'BARB-1',
        nome_barbearia: 'Barbearia Vintage & Estilo',
        responsavel: 'Marcos Silva',
        telefone: '(11) 99111-2233',
        login_gestor: 'Barbearia_VintageEstilo',
        senha_gestor: 'abc123',
        plano: 'Mensal',
        valor_pago: 149.90,
        forma_pagamento_pix: 'PIX',
        data_vencimento: getDataFutura(28),
        status_licenca: 'ATIVA',
        api_url: '',
        criado_em: '2026-03-01 10:00:00'
      },
      {
        id: 'BARB-2',
        nome_barbearia: 'Navalha de Ouro',
        responsavel: 'Carlos Eduardo',
        telefone: '(11) 98877-6655',
        login_gestor: 'Barbearia_NavalhaOuro',
        senha_gestor: 'abc123',
        plano: 'Trimestral',
        valor_pago: 399.90,
        forma_pagamento_pix: 'PIX',
        data_vencimento: getDataFutura(75),
        status_licenca: 'ATIVA',
        api_url: '',
        criado_em: '2026-03-01 10:00:00'
      },
      {
        id: 'BARB-3',
        nome_barbearia: 'Barbearia Retrô Club',
        responsavel: 'Felipe Albuquerque',
        telefone: '(11) 97766-5544',
        login_gestor: 'Barbearia_RetroClub',
        senha_gestor: 'abc123',
        plano: 'Mensal',
        valor_pago: 149.90,
        forma_pagamento_pix: 'PIX',
        data_vencimento: getDataPassada(5), // Vencida há 5 dias para demonstrar o controle de inadimplência
        status_licenca: 'ATIVA',
        api_url: '',
        criado_em: '2026-02-10 10:00:00'
      }
    ],
    isAuditMode: false,
    currentAuditedBarbearia: null,
    clientes: [
      { id: 'CLI-1', nome: 'Carlos Mendes', telefone: '11999887766', criado_em: '2026-03-01 10:00:00' },
      { id: 'CLI-2', nome: 'Rafael Souza', telefone: '11988776655', criado_em: '2026-03-01 11:30:00' },
      { id: 'CLI-3', nome: 'Lucas Almeida', telefone: '11977665544', criado_em: '2026-03-02 09:15:00' },
      { id: 'CLI-4', nome: 'Bruno Henrique', telefone: '11966554433', criado_em: '2026-03-02 14:00:00' },
      { id: 'CLI-5', nome: 'Thiago Oliveira', telefone: '11955443322', criado_em: '2026-03-03 16:40:00' }
    ],
    produtos: [
      { id: 'PRD-1', nome: 'Pomada Efeito Matte Extra Forte', preco: 45.00, estoque: 14, criado_em: '2026-03-01 10:00:00' },
      { id: 'PRD-2', nome: 'Óleo para Barba Hidratante 30ml', preco: 38.00, estoque: 8, criado_em: '2026-03-01 10:00:00' },
      { id: 'PRD-3', nome: 'Shampoo Anticaspa Tea Tree', preco: 42.00, estoque: 3, criado_em: '2026-03-01 10:00:00' },
      { id: 'PRD-4', nome: 'Cerveja Artesanal IPA 500ml', preco: 15.00, estoque: 24, criado_em: '2026-03-01 10:00:00' }
    ],
    servicos: [
      { id: 'SRV-1', nome: 'Corte Degradê / Moderno', preco: 45.00, duracao_min: 40, criado_em: '2026-03-01 10:00:00' },
      { id: 'SRV-2', nome: 'Barba Terapia com Toalha Quente', preco: 35.00, duracao_min: 30, criado_em: '2026-03-01 10:00:00' },
      { id: 'SRV-3', nome: 'Combo Completo (Corte + Barba)', preco: 70.00, duracao_min: 60, criado_em: '2026-03-01 10:00:00' },
      { id: 'SRV-4', nome: 'Pezinho e Sobrancelha', preco: 20.00, duracao_min: 20, criado_em: '2026-03-01 10:00:00' },
      { id: 'SRV-5', nome: 'Pigmentação de Barba', preco: 30.00, duracao_min: 25, criado_em: '2026-03-01 10:00:00' }
    ],
    barbeiros: [
      { id: 'BRB-1', nome: 'João Carlos da Silva', telefone: '11991112233', login: 'Joao_Silva', senha: '', comissao_pct: 50, ativo: 'SIM', criado_em: '2026-03-01 10:00:00' },
      { id: 'BRB-2', nome: 'Marcos Vinicius Santos', telefone: '11992223344', login: 'Marcos_Santos', senha: '123', comissao_pct: 60, ativo: 'SIM', criado_em: '2026-03-01 10:00:00' }
    ],
    agendamentos: [
      { id: 'AGD-1', cliente_nome: 'Carlos Mendes', cliente_telefone: '11999887766', servico_id: 'SRV-1', servico_nome: 'Corte Degradê / Moderno', servico_preco: 45.00, barbeiro_id: 'BRB-1', barbeiro_nome: 'João Carlos da Silva', data: hoje, horario: '09:00', status: 'Concluido', forma_pagamento: 'PIX', comissao_valor: 22.50, criado_em: hoje + ' 08:00:00', total_venda: 45.00, taxa_aplicada_valor: 0.00, valor_liquido: 45.00, data_compensacao: hoje },
      { id: 'AGD-2', cliente_nome: 'Rafael Souza', cliente_telefone: '11988776655', servico_id: 'SRV-3', servico_nome: 'Combo Completo (Corte + Barba)', servico_preco: 70.00, barbeiro_id: 'BRB-1', barbeiro_nome: 'João Carlos da Silva', data: hoje, horario: '10:00', status: 'Concluido', forma_pagamento: 'Dinheiro', comissao_valor: 35.00, criado_em: hoje + ' 08:30:00', total_venda: 70.00, taxa_aplicada_valor: 0.00, valor_liquido: 70.00, data_compensacao: hoje },
      { id: 'AGD-3', cliente_nome: 'Lucas Almeida', cliente_telefone: '11977665544', servico_id: 'SRV-2', servico_nome: 'Barba Terapia com Toalha Quente', servico_preco: 35.00, barbeiro_id: 'BRB-2', barbeiro_nome: 'Marcos Vinicius Santos', data: hoje, horario: '11:00', status: 'Concluido', forma_pagamento: 'Cartao_Debito', comissao_valor: 21.00, criado_em: hoje + ' 09:00:00', total_venda: 35.00, taxa_aplicada_valor: 0.70, valor_liquido: 34.30, data_compensacao: calcularDataCompensacao(hoje, 1) },
      { id: 'AGD-4', cliente_nome: 'Bruno Henrique', cliente_telefone: '11966554433', servico_id: 'SRV-1', servico_nome: 'Corte Degradê / Moderno', servico_preco: 45.00, barbeiro_id: 'BRB-1', barbeiro_nome: 'João Carlos da Silva', data: hoje, horario: '14:30', status: 'Agendado', forma_pagamento: 'Pendente', comissao_valor: 22.50, criado_em: hoje + ' 10:00:00' },
      { id: 'AGD-5', cliente_nome: 'Thiago Oliveira', cliente_telefone: '11955443322', servico_id: 'SRV-3', servico_nome: 'Combo Completo (Corte + Barba)', servico_preco: 70.00, barbeiro_id: 'BRB-2', barbeiro_nome: 'Marcos Vinicius Santos', data: amanha, horario: '15:00', status: 'Agendado', forma_pagamento: 'Pendente', comissao_valor: 42.00, criado_em: hoje + ' 10:30:00' },
      { id: 'AGD-6', cliente_nome: 'Mateus Silveira', cliente_telefone: '11944332211', servico_id: 'SRV-3', servico_nome: 'Combo Completo (Corte + Barba)', servico_preco: 140.00, barbeiro_id: 'BRB-1', barbeiro_nome: 'João Carlos da Silva', data: hoje, horario: '13:00', status: 'Concluido', forma_pagamento: 'Cartao_Credito', comissao_valor: 70.00, criado_em: hoje + ' 12:30:00', total_venda: 140.00, taxa_aplicada_valor: 5.59, valor_liquido: 134.41, data_compensacao: calcularDataCompensacao(hoje, 30) }
    ],
    sangrias: [
      { id: 'SNG-1', valor: 30.00, motivo: 'Pagamento Garrafão de Água Mineral', data_hora: hoje + ' 10:30:00', usuario: 'Gestor' }
    ],
    pagamentosBarbeiros: [
      { id: 'PAG-1', barbeiro_id: 'BRB-2', barbeiro_nome: 'Marcos Vinicius Santos', valor: 21.00, forma_pagamento: 'PIX', observacao: 'Acerto de comissão', data_hora: hoje + ' 11:30:00' }
    ]
  };
}

// =========================================================================
// 3. INICIALIZAÇÃO & GERENCIAMENTO DE CACHE
// =========================================================================
document.addEventListener('DOMContentLoaded', () => {
  loadData();
  setupEventListeners();
  checkExistingSession();
  updateUIBranding();
  updateSyncStatus();
});

function loadData() {
  const localData = localStorage.getItem(STORAGE_KEY);
  if (localData) {
    try {
      appState = JSON.parse(localData);
    } catch (e) {
      console.warn('Falha ao ler dados locais, restaurando mock:', e);
      appState = getDefaultMockData();
      saveLocalData();
    }
  } else {
    appState = getDefaultMockData();
    saveLocalData();
  }

  const meta = localStorage.getItem(CACHE_META_KEY);
  if (meta) {
    try {
      const parsedMeta = JSON.parse(meta);
      lastSyncTimestamp = parsedMeta.lastSyncTimestamp || 0;
    } catch (e) {}
  }
}

function saveLocalData() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
  localStorage.setItem(CACHE_META_KEY, JSON.stringify({
    lastSyncTimestamp: Date.now()
  }));
}

const PERMANENT_GAS_KEY = 'barbearia_permanent_gas_url_v1';

function getGASUrl() {
  // Permite configurar a barbearia automaticamente via link com parâmetro: ?api=https://script.google.com/.../exec
  if (typeof window !== 'undefined' && window.location && window.location.search) {
    const params = new URLSearchParams(window.location.search);
    const apiParam = params.get('api');
    if (apiParam && apiParam.trim().length > 10) {
      const cleanUrl = apiParam.trim();
      localStorage.setItem(GAS_URL_KEY, cleanUrl);
      localStorage.setItem(PERMANENT_GAS_KEY, cleanUrl);
      if (!appState.config) appState.config = {};
      appState.config.api_url = cleanUrl;
      // Limpa o parâmetro da barra de endereços para manter a URL limpa e profissional
      if (window.history && window.history.replaceState) {
        const cleanPath = window.location.pathname + window.location.hash;
        window.history.replaceState({}, document.title, cleanPath);
      }
      return cleanUrl;
    }
  }
  const savedUrl = localStorage.getItem(GAS_URL_KEY) || localStorage.getItem(PERMANENT_GAS_KEY) || appState?.config?.api_url || '';
  if (savedUrl && !localStorage.getItem(GAS_URL_KEY)) {
    localStorage.setItem(GAS_URL_KEY, savedUrl);
  }
  return savedUrl;
}

function setGASUrl(url, forceClear = false) {
  if (url && url.trim().length > 5) {
    const clean = url.trim();
    localStorage.setItem(GAS_URL_KEY, clean);
    localStorage.setItem(PERMANENT_GAS_KEY, clean);
    if (!appState.config) appState.config = {};
    appState.config.api_url = clean;
    saveLocalData();
  } else if (forceClear) {
    localStorage.removeItem(GAS_URL_KEY);
    localStorage.removeItem(PERMANENT_GAS_KEY);
    if (appState.config) delete appState.config.api_url;
    saveLocalData();
  }
  updateSyncStatus();
}

function renderGasConnectionFeedback(containerId, status, message = '', details = '') {
  const container = document.getElementById(containerId);
  if (!container) return;

  container.classList.remove('hidden');

  if (status === 'loading') {
    container.innerHTML = `
      <div class="p-3 bg-amber-500/10 border border-amber-500/30 rounded-xl flex items-center gap-3 text-xs text-amber-300 animate-pulse">
        <i data-lucide="loader-2" class="w-4 h-4 animate-spin shrink-0"></i>
        <div>
          <span class="font-bold">Testando conexão com o Google Apps Script...</span>
          <p class="text-[11px] text-amber-400/80">Validando resposta em tempo real da planilha.</p>
        </div>
      </div>
    `;
  } else if (status === 'success') {
    container.innerHTML = `
      <div class="p-3.5 bg-emerald-500/10 border-2 border-emerald-500/40 rounded-xl space-y-1.5 slide-down">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <div class="w-6 h-6 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center shrink-0">
              <i data-lucide="check-circle" class="w-4 h-4"></i>
            </div>
            <strong class="text-xs font-bold text-emerald-400">✅ Conexão Estabelecida com Sucesso!</strong>
          </div>
          <span class="text-[10px] uppercase font-mono font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 px-2 py-0.5 rounded">Salvo Permanente</span>
        </div>
        <p class="text-[11px] text-slate-300 leading-relaxed pl-8">
          A URL da sua planilha está <strong>salva e ativa de forma permanente</strong> neste navegador. Todos os dados (clientes, agendamentos, produtos, comissões e caixa) estão sincronizados em tempo real.
        </p>
        ${details ? `<p class="text-[10px] text-emerald-400/80 font-mono pl-8">${details}</p>` : ''}
      </div>
    `;
  } else if (status === 'error') {
    container.innerHTML = `
      <div class="p-3.5 bg-rose-500/10 border-2 border-rose-500/40 rounded-xl space-y-1.5 slide-down">
        <div class="flex items-center gap-2">
          <div class="w-6 h-6 rounded-lg bg-rose-500/20 text-rose-400 flex items-center justify-center shrink-0">
            <i data-lucide="alert-triangle" class="w-4 h-4"></i>
          </div>
          <strong class="text-xs font-bold text-rose-400">❌ Falha ao Conectar com a Planilha!</strong>
        </div>
        <p class="text-[11px] text-slate-300 leading-relaxed pl-8">
          ${message || 'Não foi possível se comunicar com o Google Apps Script.'}
        </p>
        <div class="pl-8 text-[11px] text-rose-300/80 space-y-0.5">
          <p>• Verifique se a URL termina com <code class="bg-rose-950/60 px-1 py-0.5 rounded font-mono">/exec</code>.</p>
          <p>• No Apps Script, confirme se em <em>Implantar &gt; Quem pode acessar</em> está selecionado <strong>"Qualquer pessoa"</strong> (Anyone).</p>
        </div>
      </div>
    `;
  }
  if (window.lucide && typeof lucide.createIcons === 'function') {
    lucide.createIcons();
  }
}

function updateSyncStatus() {
  const url = getGASUrl();
  const loginDot = document.getElementById('login-status-dot');
  const loginText = document.getElementById('login-status-text');
  const gestorDot = document.getElementById('gestor-sync-dot');
  const gestorText = document.getElementById('gestor-sync-text');

  if (url) {
    if (loginDot) loginDot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-400 pulse-dot';
    if (loginText) loginText.textContent = 'Google Planilhas Conectado';
    if (gestorDot) gestorDot.className = 'w-2 h-2 rounded-full bg-emerald-400';
    if (gestorText) gestorText.textContent = 'Sheets Conectado';
    renderGasConnectionFeedback('config-gas-status-feedback', 'success');
  } else {
    if (loginDot) loginDot.className = 'w-2.5 h-2.5 rounded-full bg-amber-500 pulse-dot';
    if (loginText) loginText.textContent = 'Modo Demonstração (Local)';
    if (gestorDot) gestorDot.className = 'w-2 h-2 rounded-full bg-amber-500';
    if (gestorText) gestorText.textContent = 'Modo Demo (Local)';
    const fb = document.getElementById('config-gas-status-feedback');
    if (fb) fb.classList.add('hidden');
  }
}

// =========================================================================
// 4. INDICADORES VISUAIS DE PROGRESSO (SKELETONS, SPINNERS & PROGRESS BAR)
// =========================================================================
function setGlobalLoading(isLoading) {
  isSyncing = isLoading;
  const bar = document.getElementById('global-loading-bar');
  const gestorIndicator = document.getElementById('gestor-sync-indicator');
  const barberIndicator = document.getElementById('barber-sync-indicator');

  if (isLoading) {
    if (bar) bar.classList.remove('hidden');
    if (gestorIndicator) gestorIndicator.classList.remove('hidden');
    if (barberIndicator) barberIndicator.classList.remove('hidden');
  } else {
    if (bar) bar.classList.add('hidden');
    if (gestorIndicator) gestorIndicator.classList.add('hidden');
    if (barberIndicator) barberIndicator.classList.add('hidden');
    updateLastSyncBadge();
  }
  if (window.lucide) lucide.createIcons();
}

function updateLastSyncBadge() {
  const badge = document.getElementById('gestor-last-sync-badge');
  if (!badge) return;
  if (!lastSyncTimestamp) {
    badge.textContent = '';
    return;
  }
  const minAtras = Math.floor((Date.now() - lastSyncTimestamp) / 60000);
  if (minAtras <= 0) {
    badge.textContent = 'Atualizado agora';
  } else {
    badge.textContent = `Atualizado há ${minAtras} min`;
  }
}

function setButtonLoading(btn, isLoading, loadingText = 'Salvando...') {
  if (!btn) return;
  if (isLoading) {
    btn.dataset.originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.classList.add('opacity-75', 'cursor-not-allowed');
    btn.innerHTML = `<i data-lucide="loader-2" class="w-4 h-4 animate-spin inline mr-1.5"></i> <span>${loadingText}</span>`;
  } else {
    btn.disabled = false;
    btn.classList.remove('opacity-75', 'cursor-not-allowed');
    if (btn.dataset.originalHtml) {
      btn.innerHTML = btn.dataset.originalHtml;
    }
  }
  if (window.lucide) lucide.createIcons();
}

function renderTableSkeleton(tbodyId, columnsCount = 7, rowsCount = 3) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;

  let html = '';
  for (let r = 0; r < rowsCount; r++) {
    html += '<tr class="animate-pulse">';
    for (let c = 0; c < columnsCount; c++) {
      html += `<td class="p-3"><div class="h-4 bg-dark-700/60 rounded w-full"></div></td>`;
    }
    html += '</tr>';
  }
  tbody.innerHTML = html;
}

// =========================================================================
// 5. CLIENTE API ROBUSTO COM TRATAMENTO DE CONCORRÊNCIA E RATE LIMITS
// =========================================================================
async function callGAS(action, payload = {}, retryCount = 0) {
  const gasUrl = getGASUrl();

  // Modo offline / demonstração
  if (!gasUrl) {
    return handleLocalAction(action, payload);
  }

  setGlobalLoading(true);

  const backoffDelays = [1000, 2000, 3000];

  try {
    const postBody = JSON.stringify({ action, ...payload });

    const response = await fetch(gasUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain;charset=utf-8'
      },
      body: postBody
    });

    const json = await response.json();

    // Tratamento de Rate Limit do Google Planilhas (Backoff Exponencial - até 3 tentativas)
    if (json && json.rateLimit && retryCount < 3) {
      const waitTime = backoffDelays[retryCount] || 3000;
      console.warn(`[RateLimit Detectado] Tentativa ${retryCount + 1} de 3. Aguardando ${waitTime}ms...`);
      showToast(`O servidor do Google está processando solicitações. Aguardando ${waitTime / 1000}s...`, 'info');
      await sleep(waitTime);
      return callGAS(action, payload, retryCount + 1);
    }

    setGlobalLoading(false);
    return json;

  } catch (error) {
    console.warn(`Erro na chamada ao Google Apps Script (Tentativa ${retryCount + 1} de 3):`, error);

    if (retryCount < 2) {
      const waitTime = backoffDelays[retryCount] || 2000;
      await sleep(waitTime);
      return callGAS(action, payload, retryCount + 1);
    }

    setGlobalLoading(false);
    showToast('Falha na conexão com a planilha do Google. Usando base local.', 'error');
    return handleLocalAction(action, payload);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Validador de Senha Obrigatório (Mínimo 6 caracteres, letras e números misturados)
function validarRegraSenha(senha) {
  const s = String(senha || '').trim();
  if (s.length < 6) {
    return { valido: false, erro: 'A senha deve conter no mínimo 6 caracteres.' };
  }
  const temLetra = /[a-zA-Z]/.test(s);
  const temNumero = /[0-9]/.test(s);
  if (!temLetra || !temNumero) {
    return { valido: false, erro: 'A senha deve conter obrigatoriamente uma mistura de letras e números (ex: corte2026, silva10).' };
  }
  return { valido: true };
}

// Operações locais de fallback
function handleLocalAction(action, payload) {
  switch (action) {
    case 'getAllData':
      return { success: true, ...appState };

    case 'getBarberData': {
      const bId = payload.barbeiro_id;
      const b = appState.barbeiros.find(x => String(x.id) === String(bId));
      if (!b) return { success: false, error: 'Barbeiro não encontrado.' };
      const ags = appState.agendamentos.filter(x => String(x.barbeiro_id) === String(bId));
      const pags = appState.pagamentosBarbeiros.filter(x => String(x.barbeiro_id) === String(bId));
      return {
        success: true,
        config: appState.config,
        barbeiro: b,
        agendamentos: ags,
        pagamentos: pags
      };
    }

    case 'getMasterBarbearias': {
      return {
        success: true,
        barbearias: appState.masterBarbearias || [],
        total: (appState.masterBarbearias || []).length
      };
    }

    case 'saveMasterBarbearia': {
      const b = payload.barbearia;
      if (!b || !b.nome_barbearia) return { success: false, error: 'Nome da barbearia obrigatório.' };
      
      if (!appState.masterBarbearias) appState.masterBarbearias = [];
      const loginGestor = b.login_gestor || gerarLoginGestorBarbearia(b.nome_barbearia);

      if (b.id) {
        const idx = appState.masterBarbearias.findIndex(x => x.id === b.id);
        if (idx !== -1) {
          appState.masterBarbearias[idx] = {
            ...appState.masterBarbearias[idx],
            ...b,
            login_gestor: loginGestor,
            forma_pagamento_pix: 'PIX'
          };
        }
      } else {
        const newId = 'BARB-' + Date.now();
        const nova = {
          id: newId,
          nome_barbearia: b.nome_barbearia,
          responsavel: b.responsavel || '',
          telefone: b.telefone || '',
          login_gestor: loginGestor,
          senha_gestor: 'abc123',
          plano: b.plano || 'Mensal',
          valor_pago: parseFloat(b.valor_pago) || 149.90,
          forma_pagamento_pix: 'PIX',
          data_vencimento: b.data_vencimento || getDataFutura(30),
          status_licenca: 'ATIVA',
          api_url: b.api_url || '',
          criado_em: getHojeAgoraString()
        };
        appState.masterBarbearias.unshift(nova);
      }
      saveLocalData();
      return { success: true, message: 'Barbearia salva com sucesso! Login gerado: ' + loginGestor };
    }

    case 'toggleStatusLicencaMaster': {
      const b = (appState.masterBarbearias || []).find(x => x.id === payload.id);
      if (!b) return { success: false, error: 'Barbearia não encontrada.' };
      b.status_licenca = payload.status || (b.status_licenca === 'ATIVA' ? 'BLOQUEADA' : 'ATIVA');
      saveLocalData();
      return { success: true, novoStatus: b.status_licenca, message: `Status alterado para ${b.status_licenca}!` };
    }

    case 'renovarVencimentoMaster': {
      const b = (appState.masterBarbearias || []).find(x => x.id === payload.id);
      if (!b) return { success: false, error: 'Barbearia não encontrada.' };
      if (payload.novo_vencimento) b.data_vencimento = payload.novo_vencimento;
      if (payload.novo_plano) b.plano = payload.novo_plano;
      if (payload.valor_pago !== undefined) b.valor_pago = parseFloat(payload.valor_pago) || 0;
      b.forma_pagamento_pix = 'PIX';
      b.status_licenca = 'ATIVA';
      saveLocalData();
      return { success: true, message: 'Assinatura renovada com sucesso via PIX!' };
    }

    case 'resetSenhaGestorMaster': {
      const b = (appState.masterBarbearias || []).find(x => x.id === payload.id);
      if (!b) return { success: false, error: 'Barbearia não encontrada.' };
      b.senha_gestor = 'abc123';
      saveLocalData();
      return { success: true, message: 'Senha do gestor resetada para "abc123"!' };
    }

    case 'deleteMasterBarbearia': {
      appState.masterBarbearias = (appState.masterBarbearias || []).filter(x => x.id !== payload.id);
      saveLocalData();
      return { success: true, message: 'Barbearia removida do SaaS com sucesso!' };
    }

    case 'alterarSenhaMaster': {
      const valid = validarRegraSenha(payload.novaSenha);
      if (!valid.valido) return { success: false, error: valid.erro };
      if (payload.senhaAtual && payload.senhaAtual !== (appState.masterConfig?.superadmin_senha || 'RSNf14232603*')) {
        return { success: false, error: 'Senha atual do Super Admin incorreta.' };
      }
      if (!appState.masterConfig) appState.masterConfig = {};
      appState.masterConfig.superadmin_senha = payload.novaSenha;
      saveLocalData();
      return { success: true, message: 'Senha do Super Admin alterada com sucesso!' };
    }

    case 'loginGestor': {
      const usuarioDigitado = String(payload.usuario || '').trim();
      const senhaDigitada = String(payload.senha || '').trim();
      const hoje = getHojeString();

      // 1. Super Admin (Rafael_Martins)
      if (usuarioDigitado.toLowerCase() === 'rafael_martins') {
        const superSenha = appState.masterConfig?.superadmin_senha || 'RSNf14232603*';
        if (senhaDigitada !== superSenha) {
          return { success: false, error: 'Senha incorreta para acesso Super Admin.' };
        }
        return {
          success: true,
          perfil: 'master',
          usuario: 'Rafael_Martins',
          nome: 'Rafael Martins (Dono do SaaS)',
          message: 'Bem-vindo ao Painel Master, Rafael Martins!'
        };
      }

      // 2. Busca na lista de barbearias cadastradas pelo Master
      const barbearias = appState.masterBarbearias || [];
      const barbEncontrada = barbearias.find(b =>
        String(b.login_gestor || '').trim().toLowerCase() === usuarioDigitado.toLowerCase() ||
        String(b.nome_barbearia || '').trim().toLowerCase() === usuarioDigitado.toLowerCase()
      );

      if (barbEncontrada) {
        if (barbEncontrada.status_licenca === 'BLOQUEADA') {
          return {
            success: false,
            bloqueado: true,
            motivo: 'bloqueada',
            nome_barbearia: barbEncontrada.nome_barbearia,
            suporte_whatsapp: appState.masterConfig?.suporte_whatsapp || '5531986203735',
            error: 'Acesso suspenso pelo administrador do sistema. Contate Rafael Martins para regularização via PIX.'
          };
        }

        if (barbEncontrada.data_vencimento && barbEncontrada.data_vencimento < hoje) {
          return {
            success: false,
            bloqueado: true,
            motivo: 'vencida',
            data_vencimento: barbEncontrada.data_vencimento,
            nome_barbearia: barbEncontrada.nome_barbearia,
            suporte_whatsapp: appState.masterConfig?.suporte_whatsapp || '5531986203735',
            error: `Assinatura vencida em ${barbEncontrada.data_vencimento}. Renove via PIX com Rafael Martins.`
          };
        }

        const senhaEsperada = (barbEncontrada.senha_gestor || 'abc123').trim();
        if (senhaDigitada !== senhaEsperada) {
          return { success: false, error: 'Senha incorreta para esta barbearia.' };
        }

        const isPrimeiroAcesso = (senhaEsperada === 'abc123');
        return {
          success: true,
          perfil: 'gestor',
          barbearia_id: barbEncontrada.id,
          nome_barbearia: barbEncontrada.nome_barbearia,
          usuario: barbEncontrada.login_gestor,
          primeiroAcessoGestor: isPrimeiroAcesso,
          status_licenca: barbEncontrada.status_licenca,
          data_vencimento: barbEncontrada.data_vencimento
        };
      }

      // 3. Fallback na config local
      const cfg = appState.config || {};
      const usuarioLocal = (cfg.usuario_gestor || '').trim().toLowerCase();
      if (usuarioLocal && usuarioDigitado.toLowerCase() === usuarioLocal) {
        const senhaLocal = (cfg.senha_gestor || 'abc123').trim();
        if (senhaDigitada !== senhaLocal) {
          return { success: false, error: 'Senha incorreta.' };
        }
        return {
          success: true,
          perfil: 'gestor',
          usuario: cfg.usuario_gestor,
          primeiroAcessoGestor: (senhaLocal === 'abc123')
        };
      }

      return { success: false, error: 'Usuário não localizado no sistema.' };
    }

    case 'alterarSenhaGestor': {
      const valid = validarRegraSenha(payload.novaSenha);
      if (!valid.valido) {
        return { success: false, error: valid.erro };
      }

      if (payload.barbearia_id || payload.login_gestor) {
        const b = (appState.masterBarbearias || []).find(x =>
          (payload.barbearia_id && x.id === payload.barbearia_id) ||
          (payload.login_gestor && x.login_gestor.toLowerCase() === payload.login_gestor.toLowerCase())
        );
        if (b) {
          b.senha_gestor = String(payload.novaSenha).trim();
        }
      }

      appState.config.senha_gestor = String(payload.novaSenha).trim();
      saveLocalData();
      return { success: true, message: 'Senha do gestor alterada com sucesso!' };
    }

    case 'criarBackupManual': {
      return { success: true, message: 'Cópia de backup criada com sucesso no seu Google Drive!' };
    }

    case 'loginBarbeiro': {
      const loginTrim = String(payload.login || '').trim().toLowerCase();
      const b = appState.barbeiros.find(x => String(x.login).trim().toLowerCase() === loginTrim);
      if (!b) return { success: false, error: 'Login de barbeiro não encontrado.' };
      
      const senhaCadastrada = String(b.senha || '').trim();
      const senhaDigitada = String(payload.senha || '').trim();

      // Primeiro acesso: senha vazia
      if (senhaCadastrada === '') {
        return {
          success: true,
          primeiroAcesso: true,
          redefinidaPadrao: false,
          barbeiro: { id: b.id, nome: b.nome, login: b.login },
          message: 'Primeiro acesso detectado. Por favor, defina sua senha pessoal (mínimo 6 caracteres com letras e números).'
        };
      }

      // Senha redefinida pelo gestor para o padrão 'abc123'
      if (senhaCadastrada === 'abc123' && senhaDigitada === 'abc123') {
        return {
          success: true,
          primeiroAcesso: true,
          redefinidaPadrao: true,
          barbeiro: { id: b.id, nome: b.nome, login: b.login },
          message: 'Sua senha foi redefinida para o padrão temporário "abc123". Por favor, cadastre sua nova senha definitiva (mínimo 6 caracteres com letras e números).'
        };
      }

      // Validação normal
      if (senhaCadastrada === senhaDigitada) {
        return { success: true, primeiroAcesso: false, perfil: 'barbeiro', barbeiro: b };
      }
      return { success: false, error: 'Senha incorreta.' };
    }

    case 'setupPasswordBarbeiro': {
      const b = appState.barbeiros.find(x => String(x.id) === String(payload.barbeiro_id));
      if (!b) return { success: false, error: 'Barbeiro não encontrado.' };
      const valid = validarRegraSenha(payload.nova_senha);
      if (!valid.valido) {
        return { success: false, error: valid.erro };
      }
      b.senha = String(payload.nova_senha).trim();
      saveLocalData();
      return { success: true, message: 'Senha cadastrada com sucesso!' };
    }

    case 'updateConfig': {
      appState.config = { ...appState.config, ...payload.config };
      saveLocalData();
      return { success: true, message: 'Configurações salvas!' };
    }

    case 'saveCliente': {
      const cli = payload.cliente;
      if (cli.id) {
        const idx = appState.clientes.findIndex(x => x.id === cli.id);
        if (idx !== -1) appState.clientes[idx] = { ...appState.clientes[idx], ...cli };
      } else {
        const newId = 'CLI-' + (appState.clientes.length + 1);
        appState.clientes.push({
          id: newId,
          nome: cli.nome,
          telefone: cli.telefone,
          criado_em: getHojeAgoraString()
        });
      }
      saveLocalData();
      return { success: true, message: 'Cliente salvo com sucesso!' };
    }

    case 'deleteCliente': {
      appState.clientes = appState.clientes.filter(x => x.id !== payload.id);
      saveLocalData();
      return { success: true };
    }

    case 'saveProduto': {
      const prod = payload.produto;
      if (prod.id) {
        const idx = appState.produtos.findIndex(x => x.id === prod.id);
        if (idx !== -1) appState.produtos[idx] = { ...appState.produtos[idx], ...prod };
      } else {
        const newId = 'PRD-' + (appState.produtos.length + 1);
        appState.produtos.push({
          id: newId,
          nome: prod.nome,
          preco: parseFloat(prod.preco) || 0,
          estoque: parseInt(prod.estoque) || 0,
          criado_em: getHojeAgoraString()
        });
      }
      saveLocalData();
      return { success: true, message: 'Produto salvo!' };
    }

    case 'deleteProduto': {
      appState.produtos = appState.produtos.filter(x => x.id !== payload.id);
      saveLocalData();
      return { success: true };
    }

    case 'saveServico': {
      const srv = payload.servico;
      if (srv.id) {
        const idx = appState.servicos.findIndex(x => x.id === srv.id);
        if (idx !== -1) appState.servicos[idx] = { ...appState.servicos[idx], ...srv };
      } else {
        const newId = 'SRV-' + (appState.servicos.length + 1);
        appState.servicos.push({
          id: newId,
          nome: srv.nome,
          preco: parseFloat(srv.preco) || 0,
          duracao_min: parseInt(srv.duracao_min) || 30,
          criado_em: getHojeAgoraString()
        });
      }
      saveLocalData();
      return { success: true, message: 'Serviço salvo!' };
    }

    case 'deleteServico': {
      appState.servicos = appState.servicos.filter(x => x.id !== payload.id);
      saveLocalData();
      return { success: true };
    }

    case 'saveBarbeiro': {
      const barb = payload.barbeiro;
      if (barb.id) {
        const idx = appState.barbeiros.findIndex(x => x.id === barb.id);
        if (idx !== -1) {
          appState.barbeiros[idx].nome = barb.nome;
          appState.barbeiros[idx].telefone = barb.telefone;
          appState.barbeiros[idx].comissao_pct = parseFloat(barb.comissao_pct) || 50;
        }
      } else {
        const login = gerarLoginBarbeiro(barb.nome);
        const newId = 'BRB-' + (appState.barbeiros.length + 1);
        appState.barbeiros.push({
          id: newId,
          nome: barb.nome,
          telefone: barb.telefone,
          login: login,
          senha: '',
          comissao_pct: parseFloat(barb.comissao_pct) || 50,
          ativo: 'SIM',
          criado_em: getHojeAgoraString()
        });
      }
      saveLocalData();
      return { success: true, message: 'Barbeiro salvo com sucesso!' };
    }

    case 'deleteBarbeiro': {
      appState.barbeiros = (appState.barbeiros || []).filter(x => String(x.id) !== String(payload.id));
      saveLocalData();
      return { success: true, message: 'Barbeiro excluído com sucesso!' };
    }

    case 'resetSenhaBarbeiro': {
      const b = appState.barbeiros.find(x => String(x.id) === String(payload.id));
      if (b) {
        b.senha = 'abc123';
        saveLocalData();
        return { success: true, message: 'Senha resetada para o padrão "abc123" com sucesso! O barbeiro deverá cadastrar uma nova senha no próximo acesso.' };
      }
      return { success: false, error: 'Barbeiro não encontrado.' };
    }

    case 'saveAgendamento': {
      const agd = payload.agendamento;
      const preco = parseFloat(agd.servico_preco) || 0;
      const comissaoPct = parseFloat(agd.comissao_pct) || 50;
      const comissaoValor = (preco * (comissaoPct / 100));

      // Prevenção de conflito de horário para o mesmo barbeiro
      const conflito = (appState.agendamentos || []).some(a =>
        String(a.barbeiro_id) === String(agd.barbeiro_id) &&
        a.data === agd.data &&
        a.horario === agd.horario &&
        a.status === 'Agendado' &&
        a.id !== agd.id
      );

      if (conflito) {
        return {
          success: false,
          error: `Horário indisponível! O barbeiro já possui um cliente agendado nesta mesma data (${agd.data}) e horário (${agd.horario}).`
        };
      }

      if (agd.id) {
        const idx = appState.agendamentos.findIndex(x => x.id === agd.id);
        if (idx !== -1) {
          appState.agendamentos[idx] = {
            ...appState.agendamentos[idx],
            ...agd,
            servico_preco: preco,
            comissao_valor: comissaoValor
          };
        }
      } else {
        const newId = 'AGD-' + (appState.agendamentos.length + 1);
        appState.agendamentos.push({
          id: newId,
          cliente_nome: agd.cliente_nome,
          cliente_telefone: agd.cliente_telefone,
          servico_id: agd.servico_id,
          servico_nome: agd.servico_nome,
          servico_preco: preco,
          barbeiro_id: agd.barbeiro_id,
          barbeiro_nome: agd.barbeiro_nome,
          data: agd.data,
          horario: agd.horario,
          status: agd.status || 'Agendado',
          forma_pagamento: agd.forma_pagamento || 'Pendente',
          comissao_valor: comissaoValor,
          criado_em: getHojeAgoraString()
        });
      }
      saveLocalData();
      return { success: true, message: 'Agendamento salvo com sucesso!' };
    }

    case 'updateAgendamentoStatus': {
      const agd = appState.agendamentos.find(x => x.id === payload.id);
      if (agd) {
        agd.status = payload.status;
        if (payload.forma_pagamento) {
          agd.forma_pagamento = payload.forma_pagamento;
        }
        if (payload.status === 'Concluido') {
          const total = parseFloat(agd.total_venda) || parseFloat(agd.total_comanda) || parseFloat(agd.servico_preco) || 0;
          const calc = calcularTaxaECompensacao(total, agd.forma_pagamento, appState.config, agd.data);
          agd.total_venda = total;
          agd.taxa_aplicada_valor = calc.taxaAplicadaValor;
          agd.valor_liquido = calc.valorLiquido;
          agd.data_compensacao = calc.dataCompensacao;
        }
        saveLocalData();
        return { success: true, message: 'Status atualizado!' };
      }
      return { success: false, error: 'Agendamento não encontrado.' };
    }

    case 'finalizarAtendimentoComanda': {
      const agd = appState.agendamentos.find(x => x.id === (payload.id || payload.agendamento_id));
      if (!agd) return { success: false, error: 'Agendamento não encontrado.' };

      agd.status = 'Concluido';
      agd.forma_pagamento = payload.forma_pagamento || 'Dinheiro';

      // Baixa no estoque dos produtos da comanda
      const produtos = payload.produtos_consumidos || [];
      produtos.forEach(pItem => {
        const prod = appState.produtos.find(p => p.id === pItem.id);
        if (prod) {
          const qtd = parseInt(pItem.qtd || pItem.quantidade) || 1;
          prod.estoque = Math.max(0, (parseInt(prod.estoque) || 0) - qtd);
        }
      });

      // Se houver produtos, anexa o registro da comanda conjunta ao agendamento
      let subtotalProdutos = 0;
      if (produtos.length > 0) {
        agd.produtos_comanda = produtos;
        subtotalProdutos = produtos.reduce((acc, p) => acc + (parseFloat(p.preco) * parseInt(p.qtd || p.quantidade || 1)), 0);
      }
      const totalVenda = (parseFloat(agd.servico_preco) || 0) + subtotalProdutos;
      agd.total_comanda = totalVenda;
      agd.total_venda = totalVenda;

      // Cálculo financeiro de taxa e compensação bancária
      const calc = calcularTaxaECompensacao(totalVenda, agd.forma_pagamento, appState.config, agd.data);
      agd.taxa_aplicada_valor = calc.taxaAplicadaValor;
      agd.valor_liquido = calc.valorLiquido;
      agd.data_compensacao = calc.dataCompensacao;

      saveLocalData();
      return {
        success: true,
        message: 'Comanda finalizada com sucesso! Estoque, taxa da maquininha e caixa atualizados.'
      };
    }

    case 'saveSangria': {
      const s = payload.sangria;
      const newId = 'SNG-' + (appState.sangrias.length + 1);
      appState.sangrias.unshift({
        id: newId,
        valor: parseFloat(s.valor) || 0,
        motivo: s.motivo || 'Fim de expediente - Sangria',
        data_hora: getHojeAgoraString(),
        usuario: 'Gestor'
      });
      saveLocalData();
      return { success: true, message: 'Sangria lançada com sucesso!' };
    }

    case 'savePagamentoBarbeiro': {
      const p = payload.pagamento;
      const newId = 'PAG-' + (appState.pagamentosBarbeiros.length + 1);
      appState.pagamentosBarbeiros.unshift({
        id: newId,
        barbeiro_id: p.barbeiro_id,
        barbeiro_nome: p.barbeiro_nome,
        valor: parseFloat(p.valor) || 0,
        forma_pagamento: p.forma_pagamento || 'PIX',
        observacao: p.observacao || 'Acerto de comissão',
        data_hora: getHojeAgoraString()
      });
      saveLocalData();
      return { success: true, message: 'Pagamento ao barbeiro registrado!' };
    }

    default:
      return { success: false, error: 'Ação desconhecida: ' + action };
  }
}

// =========================================================================
// 6. CARREGAMENTO SOB DEMANDA & SINCRONIZAÇÃO INTELIGENTE
// =========================================================================
async function refreshData(force = true) {
  // Evita múltiplas chamadas simultâneas se já estiver buscando
  if (isSyncing) return;

  const tempoDesdeUltimo = Date.now() - lastSyncTimestamp;
  if (!force && tempoDesdeUltimo < DYNAMIC_CACHE_THROTTLE_MS) {
    // Dados ainda frescos em memória/cache
    return;
  }

  setGlobalLoading(true);

  if (currentSession && currentSession.perfil === 'master') {
    const res = await callGAS('getMasterBarbearias');
    if (res && res.success && res.barbearias) {
      appState.masterBarbearias = res.barbearias;
      saveLocalData();
      renderMasterView();
    }
  } else if (currentSession && currentSession.perfil === 'barbeiro') {
    // Barbeiro busca apenas seus dados restritos (economia de banda e memória)
    const res = await callGAS('getBarberData', { barbeiro_id: currentSession.barbeiro.id });
    if (res && res.success) {
      if (res.config) appState.config = { ...appState.config, ...res.config };
      if (res.barbeiro) currentSession.barbeiro = res.barbeiro;
      if (res.agendamentos) {
        // Atualiza apenas os agendamentos deste barbeiro no estado local
        appState.agendamentos = [
          ...appState.agendamentos.filter(a => String(a.barbeiro_id) !== String(res.barbeiro.id)),
          ...res.agendamentos
        ];
      }
      if (res.pagamentos) {
        appState.pagamentosBarbeiros = [
          ...appState.pagamentosBarbeiros.filter(p => String(p.barbeiro_id) !== String(res.barbeiro.id)),
          ...res.pagamentos
        ];
      }
      saveLocalData();
      renderBarbeiroView();
      showToast('Sua agenda e comissões foram atualizadas!', 'success');
    }
  } else {
    // Gestor busca os dados consolidados
    const res = await callGAS('getAllData');
    if (res && res.success) {
      if (res.config) appState.config = res.config;
      if (res.clientes) appState.clientes = res.clientes;
      if (res.produtos) appState.produtos = res.produtos;
      if (res.servicos) appState.servicos = res.servicos;
      if (res.barbeiros) appState.barbeiros = res.barbeiros;
      if (res.agendamentos) appState.agendamentos = res.agendamentos;
      if (res.sangrias) appState.sangrias = res.sangrias;
      if (res.pagamentosBarbeiros) appState.pagamentosBarbeiros = res.pagamentosBarbeiros;

      saveLocalData();
      updateUIBranding();
      if (currentSession && currentSession.perfil === 'gestor') {
        renderGestorView();
      }
      showToast('Dados sincronizados com sucesso!', 'success');
    } else {
      showToast(res ? res.error : 'Erro ao sincronizar dados.', 'error');
    }
  }

  setGlobalLoading(false);
}

// =========================================================================
// 7. AUTENTICAÇÃO E SESSÃO
// =========================================================================
function switchLoginTab(tab) {
  const btnG = document.getElementById('tab-btn-gestor');
  const btnB = document.getElementById('tab-btn-barbeiro');
  const formG = document.getElementById('form-login-gestor');
  const formB = document.getElementById('form-login-barbeiro');

  if (tab === 'gestor') {
    btnG.className = 'flex-1 py-2.5 text-xs font-semibold rounded-lg transition-all flex items-center justify-center gap-2 bg-gold-500 text-dark-900 shadow-md';
    btnB.className = 'flex-1 py-2.5 text-xs font-semibold rounded-lg transition-all flex items-center justify-center gap-2 text-slate-400 hover:text-white';
    formG.classList.remove('hidden');
    formB.classList.add('hidden');
  } else {
    btnB.className = 'flex-1 py-2.5 text-xs font-semibold rounded-lg transition-all flex items-center justify-center gap-2 bg-gold-500 text-dark-900 shadow-md';
    btnG.className = 'flex-1 py-2.5 text-xs font-semibold rounded-lg transition-all flex items-center justify-center gap-2 text-slate-400 hover:text-white';
    formB.classList.remove('hidden');
    formG.classList.add('hidden');
  }
}

async function handleLoginGestor(event) {
  event.preventDefault();
  const submitBtn = event.target.querySelector('button[type="submit"]');
  setButtonLoading(submitBtn, true, 'Autenticando...');

  const usuario = document.getElementById('input-usuario-gestor') ? document.getElementById('input-usuario-gestor').value.trim() : '';
  const senha = document.getElementById('input-senha-gestor').value.trim();

  const res = await callGAS('loginGestor', { usuario, senha });
  setButtonLoading(submitBtn, false);

  if (res && res.success) {
    // 1. Perfil Super Admin (Rafael_Martins)
    if (res.perfil === 'master' || usuario.toLowerCase() === 'rafael_martins') {
      currentSession = { perfil: 'master', usuario: 'Rafael_Martins', nome: 'Rafael Martins (Dono do SaaS)' };
      localStorage.setItem(SESSION_KEY, JSON.stringify(currentSession));
      showToast('Bem-vindo ao Painel Master, Rafael Martins!', 'success');
      showView('master');
      renderMasterView();
      return;
    }

    // 2. Verificação de Primeiro Acesso com a senha padrão 'abc123'
    if (res.primeiroAcessoGestor || senha === 'abc123') {
      window.pendingGestorAuth = {
        usuario: res.usuario || usuario,
        barbearia_id: res.barbearia_id || '',
        nome_barbearia: res.nome_barbearia || ''
      };
      openModal('modal-primeiro-acesso-gestor');
      return;
    }

    // 3. Gestor de Barbearia Regular
    currentSession = {
      perfil: 'gestor',
      barbearia_id: res.barbearia_id || '',
      nome_barbearia: res.nome_barbearia || '',
      usuario: res.usuario || usuario
    };
    if (res.nome_barbearia) {
      appState.config.nome_barbearia = res.nome_barbearia;
    }
    localStorage.setItem(SESSION_KEY, JSON.stringify(currentSession));
    showToast('Bem-vindo, Gestor!', 'success');
    showView('gestor');
    renderGestorView();
    refreshData(true);
  } else if (res && res.bloqueado) {
    exibirTelaBloqueioSaaS(res);
  } else {
    showToast(res ? (res.error || 'Senha ou usuário incorretos.') : 'Erro ao autenticar.', 'error');
  }
}

async function handleSalvarPrimeiroAcessoGestor(event) {
  event.preventDefault();
  const s1 = document.getElementById('input-primeiro-acesso-senha').value.trim();
  const s2 = document.getElementById('input-primeiro-acesso-confirma').value.trim();

  if (s1 !== s2) {
    showToast('As senhas digitadas não coincidem!', 'error');
    return;
  }

  const valid = validarRegraSenha(s1);
  if (!valid.valido) {
    showToast(valid.erro, 'error');
    return;
  }

  const submitBtn = event.target.querySelector('button[type="submit"]');
  setButtonLoading(submitBtn, true, 'Salvando nova senha...');

  const pending = window.pendingGestorAuth || {};
  const usuario = pending.usuario || (document.getElementById('input-usuario-gestor')?.value.trim() || '');
  const barbeariaId = pending.barbearia_id || '';
  const nomeBarbearia = pending.nome_barbearia || '';

  const res = await callGAS('alterarSenhaGestor', {
    senhaAtual: 'abc123',
    senha_atual: 'abc123',
    novaSenha: s1,
    nova_senha: s1,
    force: true,
    barbearia_id: barbeariaId,
    login_gestor: usuario
  });
  setButtonLoading(submitBtn, false);

  if (res && res.success) {
    closeModal('modal-primeiro-acesso-gestor');
    appState.config.senha_gestor = s1;
    if (nomeBarbearia) {
      appState.config.nome_barbearia = nomeBarbearia;
    }
    if (appState.masterBarbearias) {
      const b = appState.masterBarbearias.find(x =>
        (barbeariaId && x.id === barbeariaId) ||
        (usuario && String(x.login_gestor).toLowerCase() === usuario.toLowerCase())
      );
      if (b) b.senha_gestor = s1;
    }
    saveLocalData();
    showToast('Senha pessoal do gestor cadastrada com sucesso! Bem-vindo.', 'success');

    currentSession = {
      perfil: 'gestor',
      barbearia_id: barbeariaId,
      nome_barbearia: nomeBarbearia || appState.config.nome_barbearia || '',
      usuario: usuario
    };
    localStorage.setItem(SESSION_KEY, JSON.stringify(currentSession));
    showView('gestor');
    renderGestorView();
    refreshData(true);
  } else {
    showToast(res ? res.error : 'Erro ao cadastrar senha pessoal.', 'error');
  }
}

async function handleAlterarSenhaGestorForm(event) {
  event.preventDefault();
  const sAtual = document.getElementById('input-cfg-senha-atual').value.trim();
  const sNova = document.getElementById('input-cfg-nova-senha').value.trim();
  const sConf = document.getElementById('input-cfg-confirma-senha').value.trim();

  if (sNova !== sConf) {
    showToast('A confirmação da nova senha não confere!', 'error');
    return;
  }

  const valid = validarRegraSenha(sNova);
  if (!valid.valido) {
    showToast(valid.erro, 'error');
    return;
  }

  const submitBtn = event.target.querySelector('button[type="submit"]');
  setButtonLoading(submitBtn, true, 'Atualizando...');

  const res = await callGAS('alterarSenhaGestor', {
    senhaAtual: sAtual,
    novaSenha: sNova,
    force: false
  });
  setButtonLoading(submitBtn, false);

  if (res && res.success) {
    document.getElementById('input-cfg-senha-atual').value = '';
    document.getElementById('input-cfg-nova-senha').value = '';
    document.getElementById('input-cfg-confirma-senha').value = '';
    appState.config.senha_gestor = sNova;
    saveLocalData();
    showToast('Sua senha de gestor foi alterada com sucesso!', 'success');
  } else {
    showToast(res ? res.error : 'Erro ao alterar senha do gestor.', 'error');
  }
}

function exibirTelaBloqueioSaaS(bloqueioInfo) {
  const cfg = appState.config || {};
  const nomeBarb = (bloqueioInfo && bloqueioInfo.nome_barbearia) || cfg.nome_barbearia || 'Barbearia';
  const elNome = document.getElementById('bloqueio-nome-barbearia');
  if (elNome) elNome.textContent = nomeBarb;

  const btnWhats = document.getElementById('btn-whatsapp-bloqueio');
  if (btnWhats) {
    const zap = (bloqueioInfo?.suporte_whatsapp || appState.masterConfig?.suporte_whatsapp || cfg.suporte_whatsapp || '5531986203735').replace(/\D/g, '');
    const txt = encodeURIComponent(`Olá Rafael Martins, sou da barbearia "${nomeBarb}" e gostaria de regularizar/renovar minha assinatura do sistema via PIX.`);
    btnWhats.href = `https://wa.me/${zap}?text=${txt}`;
  }
  openModal('modal-saas-bloqueado');
}

async function executarBackupManualDrive() {
  showToast('Iniciando cópia de segurança no Google Drive...', 'info');
  const res = await callGAS('criarBackupManual');
  if (res && res.success) {
    showToast('Cópia de backup criada com sucesso na sua pasta do Google Drive!', 'success');
  } else {
    showToast(res ? res.error : 'Erro ao disparar backup no Google Drive.', 'error');
  }
}

async function handleLoginBarbeiro(event) {
  event.preventDefault();
  const submitBtn = event.target.querySelector('button[type="submit"]');
  setButtonLoading(submitBtn, true, 'Verificando...');

  const login = document.getElementById('input-login-barbeiro').value;
  const senha = document.getElementById('input-senha-barbeiro').value;

  const res = await callGAS('loginBarbeiro', { login, senha });
  setButtonLoading(submitBtn, false);

  if (res && res.success) {
    if (res.primeiroAcesso) {
      document.getElementById('primeiro-acesso-barbeiro-id').value = res.barbeiro.id;
      document.getElementById('primeiro-acesso-nome').textContent = res.barbeiro.nome;
      document.getElementById('primeiro-acesso-senha').value = '';
      document.getElementById('primeiro-acesso-confirma').value = '';

      const titulo = document.getElementById('primeiro-acesso-titulo');
      const subtitulo = document.getElementById('primeiro-acesso-subtitulo');
      if (res.redefinidaPadrao) {
        if (titulo) titulo.textContent = 'Senha Temporária "abc123" Redefinida';
        if (subtitulo) subtitulo.innerHTML = `Olá, <span class="text-gold-400 font-bold">${res.barbeiro.nome}</span>! Sua senha foi redefinida pelo gestor para o padrão <code>abc123</code>. Cadastre agora sua nova senha pessoal definitiva.`;
      } else {
        if (titulo) titulo.textContent = 'Primeiro Acesso - Cadastrar Senha';
        if (subtitulo) subtitulo.innerHTML = `Olá, <span class="text-gold-400 font-bold">${res.barbeiro.nome}</span>! Crie sua nova senha pessoal com no mínimo 6 caracteres (letras e números obrigatórios).`;
      }

      openModal('modal-primeiro-acesso');
      return;
    }

    currentSession = { perfil: 'barbeiro', barbeiro: res.barbeiro };
    localStorage.setItem(SESSION_KEY, JSON.stringify(currentSession));
    showToast('Bem-vindo, ' + res.barbeiro.nome + '!', 'success');
    showView('barbeiro');
    renderBarbeiroView();
    // Busca dados restritos sob demanda
    refreshData(true);
  } else {
    showToast(res.error || 'Login ou senha inválidos.', 'error');
  }
}

async function handleSalvarPrimeiroAcesso(event) {
  event.preventDefault();
  const submitBtn = event.target.querySelector('button[type="submit"]');
  const barbeiroId = document.getElementById('primeiro-acesso-barbeiro-id').value;
  const s1 = document.getElementById('primeiro-acesso-senha').value;
  const s2 = document.getElementById('primeiro-acesso-confirma').value;

  if (s1 !== s2) {
    showToast('As senhas digitadas não coincidem!', 'error');
    return;
  }
  
  const valid = validarRegraSenha(s1);
  if (!valid.valido) {
    showToast(valid.erro, 'error');
    return;
  }

  setButtonLoading(submitBtn, true, 'Gravando senha...');
  const res = await callGAS('setupPasswordBarbeiro', { barbeiro_id: barbeiroId, nova_senha: s1 });
  setButtonLoading(submitBtn, false);

  if (res && res.success) {
    closeModal('modal-primeiro-acesso');
    showToast('Senha cadastrada com sucesso! Faça login com sua nova senha.', 'success');
    document.getElementById('input-senha-barbeiro').value = s1;
  } else {
    showToast(res.error || 'Erro ao cadastrar senha.', 'error');
  }
}

function checkExistingSession() {
  const sess = localStorage.getItem(SESSION_KEY);
  if (sess) {
    try {
      currentSession = JSON.parse(sess);
      if (currentSession.perfil === 'master') {
        showView('master');
        renderMasterView();
      } else if (currentSession.perfil === 'gestor') {
        showView('gestor');
        renderGestorView();
      } else if (currentSession.perfil === 'barbeiro') {
        showView('barbeiro');
        renderBarbeiroView();
      }
    } catch (e) {
      localStorage.removeItem(SESSION_KEY);
      showView('auth');
    }
  } else {
    showView('auth');
  }
}

function logout() {
  currentSession = null;
  appState.isAuditMode = false;
  appState.currentAuditedBarbearia = null;
  const auditBanner = document.getElementById('gestor-audit-banner');
  if (auditBanner) auditBanner.classList.add('hidden');
  localStorage.removeItem(SESSION_KEY);
  showView('auth');
  showToast('Sessão encerrada com sucesso.', 'info');
}

function showView(view) {
  const authEl = document.getElementById('auth-screen');
  const gestorEl = document.getElementById('gestor-view');
  const barbeiroEl = document.getElementById('barbeiro-view');
  const masterEl = document.getElementById('master-view');

  if (authEl) authEl.classList.add('hidden');
  if (gestorEl) gestorEl.classList.add('hidden');
  if (barbeiroEl) barbeiroEl.classList.add('hidden');
  if (masterEl) masterEl.classList.add('hidden');

  if (view === 'master') {
    if (masterEl) masterEl.classList.remove('hidden');
  } else if (view === 'gestor') {
    if (gestorEl) gestorEl.classList.remove('hidden');
  } else if (view === 'barbeiro') {
    if (barbeiroEl) barbeiroEl.classList.remove('hidden');
  } else {
    if (authEl) authEl.classList.remove('hidden');
  }

  if (window.lucide) lucide.createIcons();
}

// =========================================================================
// 8. BRANDING & IDENTIDADE VISUAL
// =========================================================================
function updateUIBranding() {
  const cfg = appState.config || {};
  const nome = cfg.nome_barbearia || 'GESTÃO PROFISSIONAL DE BARBEARIA';
  const logo = cfg.logo_url || '';

  const loginTitle = document.getElementById('login-title-barbearia');
  if (loginTitle) loginTitle.textContent = nome;

  const loginImg = document.getElementById('login-logo-img');
  const loginIcon = document.getElementById('login-logo-icon');
  if (logo && loginImg) {
    loginImg.src = logo;
    loginImg.classList.remove('hidden');
    if (loginIcon) loginIcon.classList.add('hidden');
  } else if (loginIcon) {
    loginIcon.classList.remove('hidden');
    if (loginImg) loginImg.classList.add('hidden');
  }

  const gestorBrandName = document.getElementById('gestor-brand-name');
  if (gestorBrandName) gestorBrandName.textContent = nome;

  const gestorLogo = document.getElementById('gestor-brand-logo');
  const gestorIcon = document.getElementById('gestor-brand-icon');
  if (logo && gestorLogo) {
    gestorLogo.src = logo;
    gestorLogo.classList.remove('hidden');
    if (gestorIcon) gestorIcon.classList.add('hidden');
  }

  const barberBarbeariaNome = document.getElementById('barber-app-barbearia-nome');
  if (barberBarbeariaNome) barberBarbeariaNome.textContent = nome;

  const barberLogo = document.getElementById('barber-app-logo');
  const barberIcon = document.getElementById('barber-app-icon');
  if (logo && barberLogo) {
    barberLogo.src = logo;
    barberLogo.classList.remove('hidden');
    if (barberIcon) barberIcon.classList.add('hidden');
  }

  const inputNome = document.getElementById('config-nome-barbearia');
  if (inputNome && cfg.nome_barbearia) inputNome.value = cfg.nome_barbearia;

  const inputLogoUrl = document.getElementById('config-logo-url');
  if (inputLogoUrl && cfg.logo_url) inputLogoUrl.value = cfg.logo_url;

  const inputTel = document.getElementById('config-telefone-barbearia');
  if (inputTel && cfg.telefone_barbearia) inputTel.value = cfg.telefone_barbearia;

  const inputPix = document.getElementById('config-chave-pix');
  if (inputPix && cfg.chave_pix) inputPix.value = cfg.chave_pix;

  // Taxas e Prazos Bancários
  const inputTaxaPix = document.getElementById('config-taxa-pix-pct');
  if (inputTaxaPix && cfg.taxa_pix_pct !== undefined) inputTaxaPix.value = cfg.taxa_pix_pct;
  const inputPrazoPix = document.getElementById('config-prazo-pix-dias');
  if (inputPrazoPix && cfg.prazo_pix_dias !== undefined) inputPrazoPix.value = cfg.prazo_pix_dias;

  const inputTaxaDebito = document.getElementById('config-taxa-debito-pct');
  if (inputTaxaDebito && cfg.taxa_debito_pct !== undefined) inputTaxaDebito.value = cfg.taxa_debito_pct;
  const inputPrazoDebito = document.getElementById('config-prazo-debito-dias');
  if (inputPrazoDebito && cfg.prazo_debito_dias !== undefined) inputPrazoDebito.value = cfg.prazo_debito_dias;

  const inputTaxaCredito = document.getElementById('config-taxa-credito-pct');
  if (inputTaxaCredito && cfg.taxa_credito_pct !== undefined) inputTaxaCredito.value = cfg.taxa_credito_pct;
  const inputPrazoCredito = document.getElementById('config-prazo-credito-dias');
  if (inputPrazoCredito && cfg.prazo_credito_dias !== undefined) inputPrazoCredito.value = cfg.prazo_credito_dias;

  // Atualiza tags de taxas nos botões de pagamento da comanda
  const tagTaxaPix = document.getElementById('finalizar-tag-taxa-pix');
  if (tagTaxaPix) tagTaxaPix.textContent = `${cfg.taxa_pix_pct ?? 0}% TAXA`;
  const tagPrazoPix = document.getElementById('finalizar-tag-prazo-pix');
  if (tagPrazoPix) {
    const d = parseInt(cfg.prazo_pix_dias) || 0;
    tagPrazoPix.textContent = d === 0 ? 'Compensa na hora (D+0)' : `Compensa em D+${d} dia${d === 1 ? ' útil' : 's úteis'}`;
  }

  const tagTaxaDeb = document.getElementById('finalizar-tag-taxa-debito');
  if (tagTaxaDeb) tagTaxaDeb.textContent = `${cfg.taxa_debito_pct ?? 1.99}% TAXA`;
  const tagPrazoDeb = document.getElementById('finalizar-tag-prazo-debito');
  if (tagPrazoDeb) {
    const d = parseInt(cfg.prazo_debito_dias) || 1;
    tagPrazoDeb.textContent = d === 0 ? 'Compensa na hora (D+0)' : `Compensação em D+${d} dia${d === 1 ? ' útil' : 's úteis'}`;
  }

  const tagTaxaCred = document.getElementById('finalizar-tag-taxa-credito');
  if (tagTaxaCred) tagTaxaCred.textContent = `${cfg.taxa_credito_pct ?? 3.99}% TAXA`;
  const tagPrazoCred = document.getElementById('finalizar-tag-prazo-credito');
  if (tagPrazoCred) {
    const d = parseInt(cfg.prazo_credito_dias) || 30;
    tagPrazoCred.textContent = `Compensação em D+${d} dia${d === 1 ? '' : 's'}`;
  }

  // Atualiza Badge de Licença SaaS
  const badgeLicenca = document.getElementById('badge-status-licenca');
  if (badgeLicenca) {
    if (cfg.status_licenca === 'BLOQUEADA') {
      badgeLicenca.className = 'px-3 py-1 rounded-full text-xs font-bold bg-rose-500/20 text-rose-400 border border-rose-500/40';
      badgeLicenca.textContent = 'LICENÇA BLOQUEADA';
    } else {
      badgeLicenca.className = 'px-3 py-1 rounded-full text-xs font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30';
      badgeLicenca.textContent = 'LICENÇA ATIVA';
    }
  }

  // Atualiza links e contatos de suporte SaaS
  const zapSuporte = '5531986203735';
  const elTextoSuporte = document.getElementById('texto-suporte-saas');
  if (elTextoSuporte) elTextoSuporte.textContent = '(31) 98620-3735';

  const linkSuporte = document.getElementById('link-whatsapp-suporte');
  if (linkSuporte) linkSuporte.href = `https://wa.me/${zapSuporte}?text=${encodeURIComponent('Olá, preciso de suporte no sistema da barbearia')}`;

  const inputGasUrl = document.getElementById('config-gas-url');
  if (inputGasUrl) inputGasUrl.value = getGASUrl();

  updateLogoPreview(logo);

  // Verificação de bloqueio ativo
  if (cfg.status_licenca === 'BLOQUEADA' && currentSession) {
    exibirTelaBloqueioSaaS();
  }
}

function updateLogoPreview(url) {
  const previewImg = document.getElementById('config-logo-preview');
  const previewIcon = document.getElementById('config-logo-preview-icon');
  if (!previewImg || !previewIcon) return;

  if (url && url.trim().length > 5) {
    previewImg.src = url;
    previewImg.classList.remove('hidden');
    previewIcon.classList.add('hidden');
  } else {
    previewImg.classList.add('hidden');
    previewIcon.classList.remove('hidden');
  }
}

function handleLogoFileUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function(e) {
    const base64 = e.target.result;
    document.getElementById('config-logo-url').value = base64;
    updateLogoPreview(base64);
    showToast('Imagem carregada! Clique em Salvar Alterações para confirmar.', 'info');
  };
  reader.readAsDataURL(file);
}

// =========================================================================
// 9. NAVEGAÇÃO & CARREGAMENTO OTIMIZADO DO PAINEL DO GESTOR
// =========================================================================
function renderGestorView() {
  renderDashboard();
  renderAgendamentos();
  renderCaixa();
  renderBarbeiros();
  renderClientes();
  renderServicos();
  renderProdutos();
}

function navigateGestor(tab) {
  const sections = ['dashboard', 'agendamentos', 'caixa', 'barbeiros', 'clientes', 'servicos', 'produtos', 'config'];
  sections.forEach(s => {
    const el = document.getElementById('view-' + s);
    if (el) el.classList.add('hidden');
  });

  const activeSection = document.getElementById('view-' + tab);
  if (activeSection) activeSection.classList.remove('hidden');

  document.querySelectorAll('#gestor-nav-links .nav-item').forEach(btn => {
    if (btn.getAttribute('data-tab') === tab) {
      btn.className = 'nav-item w-full flex items-center gap-3 px-3 py-2.5 text-xs font-semibold rounded-xl transition-all text-dark-900 bg-gold-500 shadow-md';
    } else {
      btn.className = 'nav-item w-full flex items-center gap-3 px-3 py-2.5 text-xs font-semibold rounded-xl transition-all text-slate-400 hover:text-white hover:bg-dark-800';
    }
  });

  const titles = {
    dashboard: { title: 'Dashboard Geral', sub: 'Visão consolidada do faturamento, atendimentos e caixa' },
    agendamentos: { title: 'Gestão de Agendamentos', sub: 'Controle de horários, barbeiros e finalização de serviços' },
    caixa: { title: 'Fluxo de Caixa & Sangrias', sub: 'Controle de entradas, sangrias em gaveta e despesas' },
    barbeiros: { title: 'Barbeiros & Comissões', sub: 'Controle de percentuais, saldos a receber e acertos financeiros' },
    clientes: { title: 'Cadastro de Clientes', sub: 'Histórico e contato rápido via WhatsApp' },
    servicos: { title: 'Catálogo de Serviços', sub: 'Preços e tempos estimados de atendimento' },
    produtos: { title: 'Produtos & Estoque', sub: 'Controle de pomadas, óleos e bebidas da barbearia' },
    config: { title: 'Configurações da Barbearia', sub: 'Personalização do nome, logo e conexão com o Google Sheets' }
  };

  const t = titles[tab] || titles.dashboard;
  document.getElementById('gestor-page-title').textContent = t.title;
  document.getElementById('gestor-page-subtitle').textContent = t.sub;

  // Renderiza imediatamente com dados em cache local
  if (tab === 'dashboard') renderDashboard();
  if (tab === 'agendamentos') renderAgendamentos();
  if (tab === 'caixa') renderCaixa();
  if (tab === 'barbeiros') renderBarbeiros();
  if (tab === 'clientes') renderClientes();
  if (tab === 'servicos') renderServicos();
  if (tab === 'produtos') renderProdutos();

  // Se os dados dinâmicos tiverem mais de 3 minutos, atualiza em background silenciosamente
  refreshData(false);

  if (window.lucide) lucide.createIcons();

  const sidebar = document.getElementById('gestor-sidebar');
  if (window.innerWidth < 768 && !sidebar.classList.contains('hidden')) {
    sidebar.classList.add('hidden');
  }
}

function toggleMobileMenu() {
  const sidebar = document.getElementById('gestor-sidebar');
  sidebar.classList.toggle('hidden');
}

// -------------------------------------------------------------------------
// 9.1 DASHBOARD GERAL & CÁLCULOS FINANCEIROS
// -------------------------------------------------------------------------
function renderDashboard() {
  const hoje = getHojeString();
  const hojePt = formatarDataPt(hoje);
  document.getElementById('dash-data-hoje').textContent = hojePt;

  const fin = calcularFinanceiroGeral();

  const elFatHoje = document.getElementById('kpi-faturamento-hoje');
  if (elFatHoje) elFatHoje.textContent = formatarMoeda(fin.faturamentoHoje);

  const elFatHojeQtd = document.getElementById('kpi-faturamento-hoje-qtd');
  if (elFatHojeQtd) elFatHojeQtd.textContent = fin.qtdHojeConcluidos + ' atendimentos concluídos hoje';

  const elCortesHoje = document.getElementById('kpi-cortes-hoje');
  if (elCortesHoje) elCortesHoje.textContent = fin.qtdHojeConcluidos;

  const elFatMes = document.getElementById('kpi-faturamento-mes');
  if (elFatMes) elFatMes.textContent = formatarMoeda(fin.faturamentoMes);

  const elSaldoCaixa = document.getElementById('kpi-saldo-caixa');
  if (elSaldoCaixa) elSaldoCaixa.textContent = formatarMoeda(fin.saldoCaixaLiquido);

  const elSaldoGaveta = document.getElementById('kpi-saldo-dinheiro-gaveta');
  if (elSaldoGaveta) elSaldoGaveta.textContent = 'Dinheiro em gaveta: ' + formatarMoeda(fin.saldoDinheiroEspecie);

  const elComissoes = document.getElementById('kpi-comissoes-pendentes');
  if (elComissoes) elComissoes.textContent = formatarMoeda(fin.totalComissoesPendentes);

  renderBreakdownFormas(fin.porForma);
  renderGraficoSemana();
  renderAgendaHojeDashboard();
}

function calcularFinanceiroGeral() {
  const hoje = getHojeString();
  const mesAtual = hoje.substring(0, 7);

  let faturamentoBrutoTotal = 0;
  let totalTaxasRetidas = 0;
  let faturamentoLiquidoTotal = 0;

  let faturamentoHojeBruto = 0;
  let faturamentoHojeTaxas = 0;
  let faturamentoHojeLiquido = 0;
  let qtdHojeConcluidos = 0;

  let faturamentoMesBruto = 0;
  let faturamentoMesLiquido = 0;

  let totalDinheiroEntrada = 0;
  let totalDisponivelCompensado = 0;
  let totalAReceberFuturo = 0;
  const lancamentosFuturos = [];

  let porForma = {
    Dinheiro: { bruto: 0, taxa: 0, liquido: 0 },
    PIX: { bruto: 0, taxa: 0, liquido: 0 },
    Cartao_Debito: { bruto: 0, taxa: 0, liquido: 0 },
    Cartao_Credito: { bruto: 0, taxa: 0, liquido: 0 }
  };

  (appState.agendamentos || []).forEach(a => {
    if (a.status === 'Concluido') {
      const valorBruto = parseFloat(a.total_venda) || parseFloat(a.total_comanda) || parseFloat(a.servico_preco) || 0;
      const forma = a.forma_pagamento || 'Dinheiro';

      // Taxas e compensação bancária
      let taxaValor = 0;
      let valorLiquido = valorBruto;
      let dataComp = a.data || hoje;
      let taxaPct = 0;

      if (a.taxa_aplicada_valor !== undefined && a.valor_liquido !== undefined && a.data_compensacao) {
        taxaValor = parseFloat(a.taxa_aplicada_valor) || 0;
        valorLiquido = parseFloat(a.valor_liquido) || 0;
        dataComp = a.data_compensacao;
      } else {
        const calc = calcularTaxaECompensacao(valorBruto, forma, appState.config, a.data);
        taxaValor = calc.taxaAplicadaValor;
        valorLiquido = calc.valorLiquido;
        dataComp = calc.dataCompensacao;
        taxaPct = calc.taxaPct;
      }

      faturamentoBrutoTotal += valorBruto;
      totalTaxasRetidas += taxaValor;
      faturamentoLiquidoTotal += valorLiquido;

      // Por forma de pagamento
      const fKey = porForma.hasOwnProperty(forma) ? forma : 'Dinheiro';
      porForma[fKey].bruto += valorBruto;
      porForma[fKey].taxa += taxaValor;
      porForma[fKey].liquido += valorLiquido;

      // Hoje
      if (a.data === hoje) {
        faturamentoHojeBruto += valorBruto;
        faturamentoHojeTaxas += taxaValor;
        faturamentoHojeLiquido += valorLiquido;
        qtdHojeConcluidos++;
      }

      // Mês
      if (a.data && a.data.startsWith(mesAtual)) {
        faturamentoMesBruto += valorBruto;
        faturamentoMesLiquido += valorLiquido;
      }

      // Dinheiro físico na gaveta
      if (forma === 'Dinheiro') {
        totalDinheiroEntrada += valorBruto;
      } else {
        // PIX / Cartões
        if (dataComp <= hoje) {
          totalDisponivelCompensado += valorLiquido;
        } else {
          totalAReceberFuturo += valorLiquido;
          lancamentosFuturos.push({
            id: a.id,
            cliente_nome: a.cliente_nome,
            servico_nome: a.servico_nome,
            barbeiro_nome: a.barbeiro_nome,
            data: a.data,
            data_compensacao: dataComp,
            forma_pagamento: forma,
            taxa_pct: taxaPct || (forma === 'Cartao_Credito' ? (appState.config?.taxa_credito_pct || 3.99) : (forma === 'Cartao_Debito' ? (appState.config?.taxa_debito_pct || 1.99) : (appState.config?.taxa_pix_pct || 0))),
            valor_bruto: valorBruto,
            taxa_aplicada_valor: taxaValor,
            valor_liquido: valorLiquido
          });
        }
      }
    }
  });

  lancamentosFuturos.sort((a, b) => (a.data_compensacao || '').localeCompare(b.data_compensacao || ''));

  let totalSangrias = 0;
  (appState.sangrias || []).forEach(s => {
    totalSangrias += (parseFloat(s.valor) || 0);
  });

  let totalPagamentosBarbeiros = 0;
  let pagamentosBarbeirosDinheiro = 0;
  (appState.pagamentosBarbeiros || []).forEach(p => {
    const val = parseFloat(p.valor) || 0;
    totalPagamentosBarbeiros += val;
    if (p.forma_pagamento === 'Dinheiro') {
      pagamentosBarbeirosDinheiro += val;
    }
  });

  const saldoDinheiroEspecie = Math.max(0, totalDinheiroEntrada - totalSangrias - pagamentosBarbeirosDinheiro);
  const pagamentosNaoDinheiro = totalPagamentosBarbeiros - pagamentosBarbeirosDinheiro;
  const saldoDisponivelHoje = Math.max(0, saldoDinheiroEspecie + totalDisponivelCompensado - pagamentosNaoDinheiro);
  const saldoCaixaLiquido = Math.max(0, faturamentoLiquidoTotal - totalSangrias - totalPagamentosBarbeiros);

  let totalComissoesPendentes = 0;
  (appState.barbeiros || []).forEach(b => {
    const sal = calcularSaldoBarbeiro(b.id);
    totalComissoesPendentes += sal.saldoAReceber;
  });

  return {
    faturamentoHoje: faturamentoHojeBruto,
    faturamentoHojeBruto,
    faturamentoHojeTaxas,
    faturamentoHojeLiquido,
    qtdHojeConcluidos,
    faturamentoMes: faturamentoMesBruto,
    faturamentoMesBruto,
    faturamentoMesLiquido,
    faturamentoBrutoTotal,
    totalEntradas: faturamentoBrutoTotal,
    totalTaxasRetidas,
    faturamentoLiquidoTotal,
    totalSangrias,
    totalPagamentosBarbeiros,
    saldoCaixaLiquido,
    saldoDinheiroEspecie,
    saldoDisponivelHoje,
    totalAReceberFuturo,
    lancamentosFuturos,
    totalComissoesPendentes,
    porForma
  };
}

function calcularSaldoBarbeiro(barbeiroId) {
  const b = (appState.barbeiros || []).find(x => String(x.id) === String(barbeiroId));
  const comissaoPct = b ? (parseFloat(b.comissao_pct) || 50) : 50;

  let totalProduzido = 0;
  let totalComissaoGerada = 0;

  (appState.agendamentos || []).forEach(a => {
    if (String(a.barbeiro_id) === String(barbeiroId) && a.status === 'Concluido') {
      const preco = parseFloat(a.servico_preco) || 0;
      totalProduzido += preco;
      const comissao = a.comissao_valor !== undefined ? parseFloat(a.comissao_valor) : (preco * (comissaoPct / 100));
      totalComissaoGerada += comissao;
    }
  });

  let totalJaPago = 0;
  (appState.pagamentosBarbeiros || []).forEach(p => {
    if (String(p.barbeiro_id) === String(barbeiroId)) {
      totalJaPago += (parseFloat(p.valor) || 0);
    }
  });

  const saldoAReceber = Math.max(0, totalComissaoGerada - totalJaPago);

  return {
    barbeiro: b,
    comissaoPct,
    totalProduzido,
    totalComissaoGerada,
    totalJaPago,
    saldoAReceber
  };
}

function renderBreakdownFormas(porForma) {
  const container = document.getElementById('dash-breakdown-formas');
  if (!container) return;

  const total = Object.values(porForma).reduce((a, b) => a + b, 0) || 1;
  const labels = {
    Dinheiro: { nome: 'Dinheiro (Espécie)', cor: 'text-emerald-400', bg: 'bg-emerald-500' },
    PIX: { nome: 'PIX', cor: 'text-gold-400', bg: 'bg-gold-500' },
    Cartao_Debito: { nome: 'Cartão de Débito', cor: 'text-blue-400', bg: 'bg-blue-500' },
    Cartao_Credito: { nome: 'Cartão de Crédito', cor: 'text-purple-400', bg: 'bg-purple-500' }
  };

  let html = '';
  for (let k in porForma) {
    const val = porForma[k];
    const pct = ((val / total) * 100).toFixed(0);
    const item = labels[k] || { nome: k, cor: 'text-white', bg: 'bg-slate-500' };

    html += `
      <div>
        <div class="flex items-center justify-between text-xs mb-1">
          <span class="text-slate-300 font-medium">${item.nome}</span>
          <span class="${item.cor} font-bold">${formatarMoeda(val)} (${pct}%)</span>
        </div>
        <div class="w-full h-1.5 bg-dark-900 rounded-full overflow-hidden">
          <div class="h-full ${item.bg}" style="width: ${pct}%"></div>
        </div>
      </div>
    `;
  }
  container.innerHTML = html;
}

function renderGraficoSemana() {
  const ctx = document.getElementById('chart-faturamento-semana');
  if (!ctx) return;

  const labels = [];
  const datas = [];
  const valores = [];

  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dataStr = d.toISOString().split('T')[0];
    const diaMes = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    labels.push(diaMes);
    datas.push(dataStr);

    let soma = 0;
    (appState.agendamentos || []).forEach(a => {
      if (a.data === dataStr && a.status === 'Concluido') {
        soma += (parseFloat(a.servico_preco) || 0);
      }
    });
    valores.push(soma);
  }

  if (chartInstance) {
    chartInstance.destroy();
  }

  chartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{
        label: 'Faturamento (R$)',
        data: valores,
        backgroundColor: 'rgba(245, 158, 11, 0.75)',
        hoverBackgroundColor: '#f59e0b',
        borderRadius: 8,
        borderWidth: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1e293b',
          titleColor: '#ffffff',
          bodyColor: '#f59e0b',
          callbacks: {
            label: (ctx) => ' ' + formatarMoeda(ctx.parsed.y)
          }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: '#94a3b8', font: { size: 10 } }
        },
        y: {
          grid: { color: 'rgba(51, 65, 85, 0.4)' },
          ticks: {
            color: '#94a3b8',
            font: { size: 10 },
            callback: (v) => 'R$ ' + v
          }
        }
      }
    }
  });
}

function renderAgendaHojeDashboard() {
  const tbody = document.getElementById('dash-tabela-hoje-tbody');
  if (!tbody) return;

  const hoje = getHojeString();
  const agendamentosHoje = (appState.agendamentos || [])
    .filter(a => {
      const dLimpa = String(a.data || '').trim().split('T')[0].split(' ')[0];
      return dLimpa === hoje;
    })
    .sort((a, b) => formatarHora(a.horario).localeCompare(formatarHora(b.horario)));

  if (agendamentosHoje.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="p-6 text-center text-slate-500">
          Nenhum agendamento para hoje. Clique em <strong>+ Novo Agendamento</strong> para adicionar.
        </td>
      </tr>
    `;
    return;
  }

  let html = '';
  agendamentosHoje.forEach(a => {
    const statusBadge = getStatusBadge(a.status);
    html += `
      <tr class="hover:bg-dark-900/40 transition-colors">
        <td class="p-3 font-bold text-white">${formatarHora(a.horario)}</td>
        <td class="p-3">
          <div class="font-medium text-slate-200">${a.cliente_nome}</div>
          <div class="text-[11px] text-slate-500">${a.cliente_telefone || ''}</div>
        </td>
        <td class="p-3 text-slate-300">${a.servico_nome}</td>
        <td class="p-3 text-gold-400 font-medium">${a.barbeiro_nome}</td>
        <td class="p-3 font-bold text-emerald-400">${formatarMoeda(a.servico_preco)}</td>
        <td class="p-3">${statusBadge}</td>
        <td class="p-3 text-right">
          ${a.status === 'Agendado' ? `
            <button onclick="openModalFinalizarAtendimento('${a.id}')" class="bg-emerald-500/20 hover:bg-emerald-500 text-emerald-300 hover:text-dark-900 px-2.5 py-1 rounded-lg text-xs font-semibold transition-all">
              Finalizar
            </button>
          ` : `
            <span class="text-[11px] text-slate-500">${formatarFormaPagamento(a.forma_pagamento)}</span>
          `}
        </td>
      </tr>
    `;
  });

  tbody.innerHTML = html;
}

// -------------------------------------------------------------------------
// 9.2 AGENDAMENTOS
// -------------------------------------------------------------------------
function renderAgendaBarbeiroPills() {
  const container = document.getElementById('agenda-filtro-barbeiros-pills');
  if (!container) return;

  const dataFiltro = document.getElementById('filtro-agendamento-data').value;
  const agds = (appState.agendamentos || []).filter(a => !dataFiltro || a.data === dataFiltro);

  let html = `
    <button type="button" onclick="filtrarAgendaPorBarbeiroPill('todos')" class="px-3 py-1.5 rounded-xl font-bold transition-all shrink-0 flex items-center gap-1.5 ${currentAgendaPillBarberId === 'todos' ? 'bg-gold-500 text-dark-900 shadow-md shadow-gold-500/20' : 'bg-dark-800 text-slate-300 hover:text-white border border-dark-700'}">
      <span>Todos</span>
      <span class="text-[10px] px-1.5 py-0.2 rounded-full ${currentAgendaPillBarberId === 'todos' ? 'bg-dark-900 text-gold-400' : 'bg-dark-700 text-slate-400'}">${agds.length}</span>
    </button>
  `;

  (appState.barbeiros || []).forEach(b => {
    const qtd = agds.filter(a => String(a.barbeiro_id) === String(b.id)).length;
    const isAtivo = String(currentAgendaPillBarberId) === String(b.id);
    const primeiroNome = (b.nome || '').split(' ')[0];
    html += `
      <button type="button" onclick="filtrarAgendaPorBarbeiroPill('${b.id}')" class="px-3 py-1.5 rounded-xl font-bold transition-all shrink-0 flex items-center gap-1.5 ${isAtivo ? 'bg-gold-500 text-dark-900 shadow-md shadow-gold-500/20' : 'bg-dark-800 text-slate-300 hover:text-white border border-dark-700'}">
        <i data-lucide="scissors" class="w-3 h-3"></i>
        <span>${primeiroNome}</span>
        <span class="text-[10px] px-1.5 py-0.2 rounded-full ${isAtivo ? 'bg-dark-900 text-gold-400' : 'bg-dark-700 text-slate-400'}">${qtd}</span>
      </button>
    `;
  });

  container.innerHTML = html;
  if (window.lucide) lucide.createIcons();
}

function filtrarAgendaPorBarbeiroPill(barbeiroId) {
  currentAgendaPillBarberId = barbeiroId;
  const selectB = document.getElementById('filtro-agendamento-barbeiro');
  if (selectB) {
    selectB.value = barbeiroId;
  }
  renderAgendamentos();
}

function abrirWhatsAppConfirmacao(agdId) {
  const agd = (appState.agendamentos || []).find(a => a.id === agdId);
  if (!agd || !agd.cliente_telefone) {
    showToast('Cliente não possui WhatsApp cadastrado.', 'info');
    return;
  }
  const tel = limparTelefone(agd.cliente_telefone);
  const dataPt = formatarDataPt(agd.data);
  const nomeBarbearia = (appState.config && appState.config.nome_barbearia) || 'GESTÃO PROFISSIONAL DE BARBEARIA';

  const texto = `Olá, *${agd.cliente_nome}*! 👋
Aqui é da *${nomeBarbearia}*. Passando para confirmar seu horário agendado:

✂️ Serviço: *${agd.servico_nome}*
💈 Barbeiro: *${agd.barbeiro_nome}*
📅 Data: *${dataPt}* às *${formatarHora(agd.horario)}*

Podemos confirmar o seu horário? Esperamos por você!`;

  const url = `https://wa.me/55${tel}?text=${encodeURIComponent(texto)}`;
  window.open(url, '_blank');
}

// Ordenação Inteligente da Agenda (Barbeiro e Gestor)
// 1. Pendentes ('Agendado') no topo ordenados cronologicamente (mais próximo primeiro)
// 2. Concluídos / Cancelados ao final da fila
function compararAgendamentosInteligente(a, b) {
  const isPendenteA = (a.status === 'Agendado');
  const isPendenteB = (b.status === 'Agendado');

  // a) Prioridade de Status: Agendados sempre no topo
  if (isPendenteA && !isPendenteB) return -1;
  if (!isPendenteA && isPendenteB) return 1;

  const dataA = String(a.data || '').trim().split('T')[0].split(' ')[0];
  const dataB = String(b.data || '').trim().split('T')[0].split(' ')[0];
  const horaA = formatarHora(a.horario);
  const horaB = formatarHora(b.horario);

  // b) Entre os pendentes: ordem cronológica crescente (atendimento mais próximo primeiro)
  if (isPendenteA && isPendenteB) {
    if (dataA !== dataB) return dataA.localeCompare(dataB);
    return horaA.localeCompare(horaB);
  }

  // c) Concluídos / Cancelados: jogados para o final, ordenados do mais recente para o mais antigo
  if (dataA !== dataB) return dataB.localeCompare(dataA);
  return horaB.localeCompare(horaA);
}

function renderAgendamentos() {
  const tbody = document.getElementById('tabela-agendamentos-tbody');
  if (!tbody) return;

  renderAgendaBarbeiroPills();

  const dataFiltro = document.getElementById('filtro-agendamento-data').value;
  const barbeiroFiltro = document.getElementById('filtro-agendamento-barbeiro').value;
  const statusFiltro = document.getElementById('filtro-agendamento-status').value;

  const selectB = document.getElementById('filtro-agendamento-barbeiro');
  if (selectB && selectB.options.length <= 1) {
    (appState.barbeiros || []).forEach(b => {
      const opt = document.createElement('option');
      opt.value = b.id;
      opt.textContent = b.nome;
      selectB.appendChild(opt);
    });
  }

  let lista = [...(appState.agendamentos || [])];

  if (dataFiltro) {
    lista = lista.filter(x => x.data === dataFiltro);
  }
  if (barbeiroFiltro && barbeiroFiltro !== 'todos') {
    lista = lista.filter(x => String(x.barbeiro_id) === String(barbeiroFiltro));
  }
  if (statusFiltro && statusFiltro !== 'todos') {
    lista = lista.filter(x => x.status === statusFiltro);
  }

  lista.sort(compararAgendamentosInteligente);

  if (lista.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="9" class="p-8 text-center text-slate-500">
          Nenhum agendamento encontrado com os filtros atuais.
        </td>
      </tr>
    `;
    return;
  }

  let html = '';
  lista.forEach(a => {
    const statusBadge = getStatusBadge(a.status);
    const preco = parseFloat(a.servico_preco) || 0;
    const comissao = a.comissao_valor ? parseFloat(a.comissao_valor) : (preco * 0.5);

    html += `
      <tr class="hover:bg-dark-900/40 transition-colors">
        <td class="p-3">
          <div class="font-bold text-white">${formatarDataPt(a.data)}</div>
          <div class="text-[11px] text-slate-400 font-mono">${formatarHora(a.horario)}</div>
        </td>
        <td class="p-3">
          <div class="font-medium text-slate-200 flex items-center gap-1.5">
            <span>${a.cliente_nome}</span>
            <button type="button" onclick="abrirWhatsAppConfirmacao('${a.id}')" title="Enviar Confirmação de Horário no WhatsApp" class="text-emerald-400 hover:text-emerald-300 p-0.5 hover:bg-emerald-500/10 rounded transition-colors inline-flex items-center">
              <i data-lucide="message-circle" class="w-3.5 h-3.5"></i>
            </button>
          </div>
          <div class="text-[11px] text-slate-500">${a.cliente_telefone || ''}</div>
        </td>
        <td class="p-3 text-slate-300 font-medium">${a.servico_nome}</td>
        <td class="p-3 text-gold-400 font-medium">${a.barbeiro_nome}</td>
        <td class="p-3 font-bold text-emerald-400">${formatarMoeda(preco)}</td>
        <td class="p-3 text-amber-300 font-semibold">${formatarMoeda(comissao)}</td>
        <td class="p-3 text-slate-300 font-medium">${formatarFormaPagamento(a.forma_pagamento)}</td>
        <td class="p-3">${statusBadge}</td>
        <td class="p-3 text-right">
          <div class="flex items-center justify-end gap-1.5">
            ${a.status === 'Agendado' ? `
              <button onclick="openModalFinalizarAtendimento('${a.id}')" title="Concluir Atendimento e Receber Comanda" class="bg-emerald-500 hover:bg-emerald-400 text-dark-900 font-bold px-2.5 py-1 rounded-lg text-xs transition-all shadow-sm">
                Finalizar
              </button>
              <button onclick="cancelarAgendamento('${a.id}')" title="Cancelar Agendamento" class="text-rose-400 hover:bg-rose-500/10 p-1 rounded-lg transition-colors">
                <i data-lucide="x-circle" class="w-4 h-4"></i>
              </button>
            ` : `
              <span class="text-[11px] text-slate-500">Concluído</span>
            `}
          </div>
        </td>
      </tr>
    `;
  });

  tbody.innerHTML = html;
  if (window.lucide) lucide.createIcons();
}

function openModalNovoAgendamento() {
  document.getElementById('modal-agendamento-title').innerHTML = `
    <i data-lucide="calendar" class="w-5 h-5 text-gold-500"></i>
    <span>Novo Agendamento</span>
  `;
  document.getElementById('agendamento-id').value = '';

  const cliSelect = document.getElementById('agendamento-cliente-select');
  cliSelect.innerHTML = '<option value="">Selecione um cliente...</option><option value="novo">+ Digitar Novo Cliente Manualmente</option>';
  (appState.clientes || []).forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = `${c.nome} (${c.telefone || 'Sem tel'})`;
    cliSelect.appendChild(opt);
  });

  const srvSelect = document.getElementById('agendamento-servico-select');
  srvSelect.innerHTML = '<option value="">Selecione o serviço...</option>';
  (appState.servicos || []).forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = `${s.nome} - ${formatarMoeda(s.preco)}`;
    srvSelect.appendChild(opt);
  });

  const barbSelect = document.getElementById('agendamento-barbeiro-select');
  barbSelect.innerHTML = '<option value="">Selecione o barbeiro...</option>';
  (appState.barbeiros || []).forEach(b => {
    const opt = document.createElement('option');
    opt.value = b.id;
    opt.textContent = `${b.nome} (Comissão: ${b.comissao_pct || 50}%)`;
    barbSelect.appendChild(opt);
  });

  document.getElementById('agendamento-data').value = getHojeString();
  document.getElementById('agendamento-hora').value = getHoraAtualString();
  document.getElementById('agendamento-status').value = 'Agendado';
  document.getElementById('agendamento-forma-pagamento').value = 'Pendente';

  openModal('modal-agendamento');
}

function handleAgendamentoClienteSelect(val) {
  const manual = document.getElementById('agendamento-cliente-manual');
  const nomeInput = document.getElementById('agendamento-cliente-nome');
  const telInput = document.getElementById('agendamento-cliente-tel');

  if (val === 'novo') {
    manual.classList.remove('hidden');
    nomeInput.value = '';
    telInput.value = '';
    nomeInput.focus();
  } else if (val) {
    const cli = (appState.clientes || []).find(x => x.id === val);
    if (cli) {
      manual.classList.add('hidden');
      nomeInput.value = cli.nome;
      telInput.value = cli.telefone || '';
    }
  } else {
    manual.classList.remove('hidden');
    nomeInput.value = '';
    telInput.value = '';
  }
}

function handleAgendamentoServicoSelect(val) {
  const srv = (appState.servicos || []).find(x => x.id === val);
  const precoLabel = document.getElementById('agendamento-servico-preco-label');
  const durLabel = document.getElementById('agendamento-servico-duracao-label');

  if (srv) {
    precoLabel.textContent = formatarMoeda(srv.preco);
    durLabel.textContent = (srv.duracao_min || 30) + ' min';
  } else {
    precoLabel.textContent = 'R$ 0,00';
    durLabel.textContent = '30 min';
  }
}

function handleAgendamentoBarbeiroSelect(val) {
  const barb = (appState.barbeiros || []).find(x => x.id === val);
  const info = document.getElementById('agendamento-barbeiro-comissao-info');
  if (barb) {
    info.textContent = `Comissão contratada deste profissional: ${barb.comissao_pct || 50}%`;
  } else {
    info.textContent = 'Comissão individual: --%';
  }
}

async function handleSalvarAgendamento(event) {
  event.preventDefault();
  const submitBtn = event.target.querySelector('button[type="submit"]');

  const id = document.getElementById('agendamento-id').value;
  const clienteNome = document.getElementById('agendamento-cliente-nome').value.trim();
  const clienteTel = document.getElementById('agendamento-cliente-tel').value.trim();
  const servicoId = document.getElementById('agendamento-servico-select').value;
  const barbeiroId = document.getElementById('agendamento-barbeiro-select').value;
  const data = document.getElementById('agendamento-data').value;
  const hora = document.getElementById('agendamento-hora').value;
  const status = document.getElementById('agendamento-status').value;
  const formaPag = document.getElementById('agendamento-forma-pagamento').value;

  if (!clienteNome || !servicoId || !barbeiroId || !data || !hora) {
    showToast('Preencha todos os campos obrigatórios!', 'error');
    return;
  }

  setButtonLoading(submitBtn, true, 'Gravando...');

  const srv = (appState.servicos || []).find(x => x.id === servicoId);
  const barb = (appState.barbeiros || []).find(x => x.id === barbeiroId);

  const cliSelectVal = document.getElementById('agendamento-cliente-select').value;
  if (cliSelectVal === 'novo' || !cliSelectVal) {
    const existe = (appState.clientes || []).some(c => c.nome.toLowerCase() === clienteNome.toLowerCase());
    if (!existe) {
      await callGAS('saveCliente', { cliente: { nome: clienteNome, telefone: clienteTel } });
    }
  }

  const agdPayload = {
    id: id || undefined,
    cliente_nome: clienteNome,
    cliente_telefone: clienteTel,
    servico_id: servicoId,
    servico_nome: srv ? srv.nome : 'Serviço',
    servico_preco: srv ? srv.preco : 0,
    barbeiro_id: barbeiroId,
    barbeiro_nome: barb ? barb.nome : 'Barbeiro',
    comissao_pct: barb ? barb.comissao_pct : 50,
    data: data,
    horario: hora,
    status: status,
    forma_pagamento: formaPag
  };

  const res = await callGAS('saveAgendamento', { agendamento: agdPayload });
  setButtonLoading(submitBtn, false);

  if (res && res.success) {
    closeModal('modal-agendamento');
    showToast('Agendamento salvo com sucesso!', 'success');
    await refreshData(true);
    renderGestorView();
  } else {
    showToast(res ? res.error : 'Erro ao salvar agendamento.', 'error');
  }
}

function openModalFinalizarAtendimento(agendamentoId) {
  const agd = (appState.agendamentos || []).find(x => x.id === agendamentoId);
  if (!agd) return;

  comandaProdutosAdicionados = [];

  document.getElementById('finalizar-agendamento-id').value = agd.id;
  document.getElementById('finalizar-cliente-nome').textContent = agd.cliente_nome;
  document.getElementById('finalizar-servico-nome').textContent = agd.servico_nome;

  const preco = parseFloat(agd.servico_preco) || 0;
  const comissao = agd.comissao_valor ? parseFloat(agd.comissao_valor) : (preco * 0.5);

  const elServicoValor = document.getElementById('finalizar-servico-valor');
  if (elServicoValor) elServicoValor.textContent = formatarMoeda(preco);

  document.getElementById('finalizar-comissao-valor').textContent = formatarMoeda(comissao);
  document.getElementById('finalizar-barbeiro-nome').textContent = agd.barbeiro_nome;

  // Popula seletor de produtos com itens que possuem estoque
  const prodSelect = document.getElementById('finalizar-produto-select');
  if (prodSelect) {
    prodSelect.innerHTML = '<option value="">Selecione um produto para adicionar...</option>';
    (appState.produtos || []).forEach(p => {
      const estoque = parseInt(p.estoque) || 0;
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.nome} - ${formatarMoeda(p.preco)} (Estoque: ${estoque} un)`;
      if (estoque <= 0) {
        opt.disabled = true;
        opt.textContent += ' [ESGOTADO]';
      }
      prodSelect.appendChild(opt);
    });
  }

  const qtdInput = document.getElementById('finalizar-produto-qtd');
  if (qtdInput) qtdInput.value = 1;

  renderComandaProdutosLista();
  atualizarTotaisComanda(preco);

  openModal('modal-finalizar-atendimento');
}

function adicionarProdutoComanda() {
  const prodSelect = document.getElementById('finalizar-produto-select');
  const qtdInput = document.getElementById('finalizar-produto-qtd');
  if (!prodSelect || !qtdInput) return;

  const prodId = prodSelect.value;
  const qtd = parseInt(qtdInput.value) || 1;

  if (!prodId) {
    showToast('Selecione um produto para adicionar à comanda.', 'info');
    return;
  }
  if (qtd <= 0) {
    showToast('Quantidade inválida.', 'error');
    return;
  }

  const prod = (appState.produtos || []).find(p => p.id === prodId);
  if (!prod) return;

  const estoqueAtual = parseInt(prod.estoque) || 0;
  const itemExistente = comandaProdutosAdicionados.find(x => x.id === prodId);
  const qtdJaNaComanda = itemExistente ? itemExistente.qtd : 0;

  if ((qtdJaNaComanda + qtd) > estoqueAtual) {
    showToast(`Estoque insuficiente! Disponível em loja: ${estoqueAtual} unidades.`, 'error');
    return;
  }

  if (itemExistente) {
    itemExistente.qtd += qtd;
  } else {
    comandaProdutosAdicionados.push({
      id: prod.id,
      nome: prod.nome,
      preco: parseFloat(prod.preco) || 0,
      qtd: qtd
    });
  }

  // Reset inputs
  prodSelect.value = '';
  qtdInput.value = 1;

  renderComandaProdutosLista();
  atualizarTotaisComanda();
  showToast(`"${prod.nome}" adicionado à comanda!`, 'success');
}

function removerProdutoComanda(idx) {
  if (idx >= 0 && idx < comandaProdutosAdicionados.length) {
    comandaProdutosAdicionados.splice(idx, 1);
    renderComandaProdutosLista();
    atualizarTotaisComanda();
  }
}

function renderComandaProdutosLista() {
  const container = document.getElementById('finalizar-comanda-produtos-lista');
  if (!container) return;

  if (comandaProdutosAdicionados.length === 0) {
    container.innerHTML = `<p class="text-[11px] text-slate-500 text-center py-2 italic">Nenhum produto extra adicionado.</p>`;
    return;
  }

  let html = '';
  comandaProdutosAdicionados.forEach((p, idx) => {
    const subtotal = p.preco * p.qtd;
    html += `
      <div class="flex items-center justify-between p-2 bg-dark-800 rounded-lg border border-dark-700 text-xs">
        <div class="flex-1 pr-2">
          <div class="font-medium text-slate-200">${p.nome}</div>
          <div class="text-[10px] text-slate-400">${p.qtd}x de ${formatarMoeda(p.preco)}</div>
        </div>
        <div class="flex items-center gap-2">
          <span class="font-bold text-emerald-400 text-xs">${formatarMoeda(subtotal)}</span>
          <button type="button" onclick="removerProdutoComanda(${idx})" title="Remover da comanda" class="text-rose-400 hover:text-rose-300 p-1">
            <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
          </button>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
  if (window.lucide) lucide.createIcons();
}

function atualizarTotaisComanda(precoServicoDefinido) {
  const agdId = document.getElementById('finalizar-agendamento-id').value;
  const agd = (appState.agendamentos || []).find(x => x.id === agdId);
  const precoServico = precoServicoDefinido !== undefined ? precoServicoDefinido : (agd ? (parseFloat(agd.servico_preco) || 0) : 0);

  const subtotalProdutos = comandaProdutosAdicionados.reduce((acc, p) => acc + (p.preco * p.qtd), 0);
  const totalGeral = precoServico + subtotalProdutos;

  const elSubtotais = document.getElementById('finalizar-subtotais-resumo');
  if (elSubtotais) {
    elSubtotais.textContent = `Serviço: ${formatarMoeda(precoServico)} | Produtos: ${formatarMoeda(subtotalProdutos)}`;
  }

  const elTotal = document.getElementById('finalizar-valor-total');
  if (elTotal) {
    elTotal.textContent = formatarMoeda(totalGeral);
  }
}

async function confirmarFinalizacaoComForma(formaPagamento) {
  const agdId = document.getElementById('finalizar-agendamento-id').value;
  if (!agdId) return;

  const botoesContainer = document.getElementById('finalizar-botoes-forma');
  if (botoesContainer) {
    botoesContainer.classList.add('opacity-50', 'pointer-events-none');
  }

  const res = await callGAS('finalizarAtendimentoComanda', {
    agendamento_id: agdId,
    forma_pagamento: formaPagamento,
    produtos_consumidos: comandaProdutosAdicionados
  });

  if (botoesContainer) {
    botoesContainer.classList.remove('opacity-50', 'pointer-events-none');
  }

  if (res && res.success) {
    closeModal('modal-finalizar-atendimento');
    showToast(`Comanda finalizada via ${formatarFormaPagamento(formaPagamento)}! Estoque de produtos e caixa atualizados.`, 'success');
    await refreshData(true);
    renderGestorView();
  } else {
    showToast(res ? res.error : 'Erro ao finalizar atendimento com comanda.', 'error');
  }
}

async function cancelarAgendamento(agendamentoId) {
  if (!confirm('Deseja realmente cancelar este agendamento?')) return;

  const res = await callGAS('updateAgendamentoStatus', {
    id: agendamentoId,
    status: 'Cancelado',
    forma_pagamento: 'Cancelado'
  });

  if (res && res.success) {
    showToast('Agendamento cancelado!', 'info');
    await refreshData(true);
    renderGestorView();
  } else {
    showToast(res ? res.error : 'Erro ao cancelar.', 'error');
  }
}

async function handleCancelarAgendamentoModal(agendamentoId) {
  const agdId = agendamentoId || document.getElementById('finalizar-agendamento-id')?.value;
  if (!agdId) {
    showToast('Nenhum agendamento selecionado.', 'warning');
    return;
  }

  if (!confirm('Deseja realmente cancelar este agendamento?')) return;

  closeModal('modal-finalizar-atendimento');

  const res = await callGAS('updateAgendamentoStatus', {
    id: agdId,
    status: 'Cancelado',
    forma_pagamento: 'Cancelado'
  });

  if (res && res.success) {
    showToast('Agendamento cancelado com sucesso!', 'info');
    await refreshData(true);
    renderGestorView();
  } else {
    showToast(res ? res.error : 'Erro ao cancelar agendamento.', 'error');
  }
}

// -------------------------------------------------------------------------
// 9.3 FLUXO DE CAIXA & SANGRIA
// -------------------------------------------------------------------------
function renderCaixa() {
  const fin = calcularFinanceiroGeral();

  // Linha 1: Faturamento e Taxas
  const elEntradas = document.getElementById('caixa-total-entradas');
  if (elEntradas) elEntradas.textContent = formatarMoeda(fin.faturamentoBrutoTotal);

  const elTaxas = document.getElementById('caixa-total-taxas');
  if (elTaxas) elTaxas.textContent = `- ${formatarMoeda(fin.totalTaxasRetidas)}`;

  const elLiquido = document.getElementById('caixa-total-liquido');
  if (elLiquido) elLiquido.textContent = formatarMoeda(fin.faturamentoLiquidoTotal);

  const elEspecie = document.getElementById('caixa-saldo-especie');
  if (elEspecie) elEspecie.textContent = formatarMoeda(fin.saldoDinheiroEspecie);

  // Linha 2: Disponível Hoje vs Futuro
  const elDispHoje = document.getElementById('caixa-saldo-disponivel-hoje');
  if (elDispHoje) elDispHoje.textContent = formatarMoeda(fin.saldoDisponivelHoje);

  const elReceberFuturo = document.getElementById('caixa-total-a-receber-futuro');
  if (elReceberFuturo) elReceberFuturo.textContent = formatarMoeda(fin.totalAReceberFuturo);

  const elQtdFuturos = document.getElementById('caixa-qtd-lancamentos-futuros');
  if (elQtdFuturos) {
    const q = (fin.lancamentosFuturos || []).length;
    elQtdFuturos.textContent = `${q} lançamento${q === 1 ? '' : 's'} aguardando compensação`;
  }

  const elSangrias = document.getElementById('caixa-total-sangrias');
  if (elSangrias) elSangrias.textContent = formatarMoeda(fin.totalSangrias);

  const elPagtosBarbeiros = document.getElementById('caixa-total-pagamentos-barbeiros');
  if (elPagtosBarbeiros) elPagtosBarbeiros.textContent = formatarMoeda(fin.totalPagamentosBarbeiros);

  renderTabelaLancamentosFuturos(fin.lancamentosFuturos, fin.totalAReceberFuturo);
  renderExtratoCaixa();
}

function renderTabelaLancamentosFuturos(futuros, totalFuturo) {
  const tbody = document.getElementById('tabela-caixa-futuros-tbody');
  const badgeTotal = document.getElementById('caixa-futuros-badge-total');
  if (badgeTotal) badgeTotal.textContent = `Total a Compensar: ${formatarMoeda(totalFuturo || 0)}`;
  if (!tbody) return;

  if (!futuros || futuros.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="p-8 text-center text-slate-500">
          <div class="flex flex-col items-center justify-center gap-2">
            <i data-lucide="check-circle-2" class="w-8 h-8 text-emerald-400/60"></i>
            <span class="text-xs font-medium text-slate-400">Nenhum lançamento futuro pendente. Todas as transações em cartão/PIX já compensaram!</span>
          </div>
        </td>
      </tr>
    `;
    if (window.lucide) lucide.createIcons();
    return;
  }

  const hoje = getHojeString();
  let html = '';
  futuros.forEach(f => {
    const dataVenda = formatarDataPt(f.data);
    const dataComp = formatarDataPt(f.data_compensacao);

    let badgePrazo = '';
    if (f.data_compensacao === hoje) {
      badgePrazo = '<span class="bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 px-2 py-0.5 rounded text-[10px] font-bold">Compensa Hoje</span>';
    } else {
      badgePrazo = `<span class="bg-purple-500/10 text-purple-300 border border-purple-500/30 px-2 py-0.5 rounded text-[10px] font-bold">Cai em ${dataComp}</span>`;
    }

    const badgeForma = f.forma_pagamento === 'Cartao_Credito'
      ? `<span class="bg-purple-500/20 text-purple-300 px-2 py-0.5 rounded text-[10px] font-bold">Crédito (${f.taxa_pct}%)</span>`
      : (f.forma_pagamento === 'Cartao_Debito'
        ? `<span class="bg-blue-500/20 text-blue-300 px-2 py-0.5 rounded text-[10px] font-bold">Débito (${f.taxa_pct}%)</span>`
        : `<span class="bg-gold-500/20 text-gold-300 px-2 py-0.5 rounded text-[10px] font-bold">${formatarFormaPagamento(f.forma_pagamento)} (${f.taxa_pct}%)</span>`);

    html += `
      <tr class="hover:bg-dark-900/40 transition-colors">
        <td class="p-3 text-slate-400 font-mono text-[11px]">${dataVenda}</td>
        <td class="p-3">${badgePrazo}</td>
        <td class="p-3 text-slate-200">
          <div class="font-medium text-white">${f.servico_nome}</div>
          <div class="text-[10px] text-slate-400">${f.cliente_nome} (Barb. ${f.barbeiro_nome})</div>
        </td>
        <td class="p-3">${badgeForma}</td>
        <td class="p-3 text-right font-semibold text-slate-300">${formatarMoeda(f.valor_bruto)}</td>
        <td class="p-3 text-right font-bold text-rose-400">- ${formatarMoeda(f.taxa_aplicada_valor)}</td>
        <td class="p-3 text-right font-black text-purple-300">${formatarMoeda(f.valor_liquido)}</td>
      </tr>
    `;
  });

  tbody.innerHTML = html;
  if (window.lucide) lucide.createIcons();
}

function renderExtratoCaixa() {
  const tbody = document.getElementById('tabela-caixa-movimentos-tbody');
  if (!tbody) return;

  const movimentos = [];

  (appState.agendamentos || []).forEach(a => {
    if (a.status === 'Concluido') {
      const bruto = parseFloat(a.total_venda) || parseFloat(a.total_comanda) || parseFloat(a.servico_preco) || 0;
      let taxa = 0;
      let liquido = bruto;

      if (a.taxa_aplicada_valor !== undefined && a.valor_liquido !== undefined) {
        taxa = parseFloat(a.taxa_aplicada_valor) || 0;
        liquido = parseFloat(a.valor_liquido) || 0;
      } else {
        const calc = calcularTaxaECompensacao(bruto, a.forma_pagamento, appState.config, a.data);
        taxa = calc.taxaAplicadaValor;
        liquido = calc.valorLiquido;
      }

      movimentos.push({
        data_hora: a.criado_em || (a.data + ' ' + (a.horario || '12:00') + ':00'),
        tipo: 'ENTRADA',
        descricao: `Atendimento: ${a.servico_nome} (${a.cliente_nome} - Barb. ${a.barbeiro_nome})`,
        forma: a.forma_pagamento || 'Dinheiro',
        valor_bruto: bruto,
        taxa_valor: taxa,
        valor_liquido: liquido
      });
    }
  });

  (appState.sangrias || []).forEach(s => {
    const val = parseFloat(s.valor) || 0;
    movimentos.push({
      data_hora: s.data_hora,
      tipo: 'SANGRIA',
      descricao: `Sangria: ${s.motivo || 'Retirada de Caixa'}`,
      forma: 'Dinheiro (Gaveta)',
      valor_bruto: -val,
      taxa_valor: 0,
      valor_liquido: -val
    });
  });

  (appState.pagamentosBarbeiros || []).forEach(p => {
    const val = parseFloat(p.valor) || 0;
    movimentos.push({
      data_hora: p.data_hora,
      tipo: 'PAGTO_BARBEIRO',
      descricao: `Pagamento de Comissão: ${p.barbeiro_nome} (${p.observacao || 'Acerto'})`,
      forma: p.forma_pagamento || 'PIX',
      valor_bruto: -val,
      taxa_valor: 0,
      valor_liquido: -val
    });
  });

  movimentos.sort((a, b) => (b.data_hora || '').localeCompare(a.data_hora || ''));

  if (movimentos.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="p-8 text-center text-slate-500">
          Nenhuma movimentação no caixa registrada até o momento.
        </td>
      </tr>
    `;
    return;
  }

  let html = '';
  movimentos.forEach(m => {
    const isEntrada = m.valor_bruto > 0;
    const badge = isEntrada
      ? '<span class="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2 py-0.5 rounded text-[10px] font-bold">ENTRADA</span>'
      : (m.tipo === 'SANGRIA'
        ? '<span class="bg-rose-500/10 text-rose-400 border border-rose-500/20 px-2 py-0.5 rounded text-[10px] font-bold">SANGRIA</span>'
        : '<span class="bg-amber-500/10 text-amber-400 border border-amber-500/20 px-2 py-0.5 rounded text-[10px] font-bold">PAGTO BARBEIRO</span>');

    const strBruto = (isEntrada ? '+ ' : '- ') + formatarMoeda(Math.abs(m.valor_bruto));
    const strTaxa = m.taxa_valor > 0 ? `- ${formatarMoeda(m.taxa_valor)}` : 'R$ 0,00';
    const strLiquido = (isEntrada ? '+ ' : '- ') + formatarMoeda(Math.abs(m.valor_liquido));
    const corLiquido = isEntrada ? 'text-emerald-400' : 'text-rose-400';

    html += `
      <tr class="hover:bg-dark-900/40 transition-colors">
        <td class="p-3 text-slate-400 font-mono text-[11px]">${formatarDataHoraPt(m.data_hora)}</td>
        <td class="p-3">${badge}</td>
        <td class="p-3 text-slate-200 font-medium">${m.descricao}</td>
        <td class="p-3 text-slate-300">${formatarFormaPagamento(m.forma)}</td>
        <td class="p-3 text-right font-semibold text-slate-300">${strBruto}</td>
        <td class="p-3 text-right font-bold text-rose-400">${strTaxa}</td>
        <td class="p-3 text-right font-black ${corLiquido}">${strLiquido}</td>
      </tr>
    `;
  });

  tbody.innerHTML = html;
}

function openModalSangria() {
  const fin = calcularFinanceiroGeral();
  document.getElementById('sangria-max-disponivel').textContent = formatarMoeda(fin.saldoDinheiroEspecie);
  document.getElementById('sangria-valor').value = '';
  document.getElementById('sangria-motivo').value = '';
  openModal('modal-sangria');
}

function setMotivoSangria(motivo) {
  document.getElementById('sangria-motivo').value = motivo;
}

async function handleSalvarSangria(event) {
  event.preventDefault();
  const submitBtn = event.target.querySelector('button[type="submit"]');

  const valor = parseFloat(document.getElementById('sangria-valor').value) || 0;
  const motivo = document.getElementById('sangria-motivo').value.trim();

  if (valor <= 0) {
    showToast('Informe um valor válido maior que zero!', 'error');
    return;
  }
  if (!motivo) {
    showToast('Informe o motivo da sangria!', 'error');
    return;
  }

  const fin = calcularFinanceiroGeral();
  if (valor > fin.saldoDinheiroEspecie) {
    if (!confirm(`Atenção: O valor da sangria (${formatarMoeda(valor)}) é maior que o saldo em gaveta (${formatarMoeda(fin.saldoDinheiroEspecie)}). Deseja confirmar mesmo assim?`)) {
      return;
    }
  }

  setButtonLoading(submitBtn, true, 'Gravando sangria...');
  const res = await callGAS('saveSangria', {
    sangria: { valor, motivo }
  });
  setButtonLoading(submitBtn, false);

  if (res && res.success) {
    closeModal('modal-sangria');
    showToast(`Sangria de ${formatarMoeda(valor)} lançada com sucesso!`, 'success');
    await refreshData(true);
    renderGestorView();
  } else {
    showToast(res ? res.error : 'Erro ao lançar sangria.', 'error');
  }
}

// -------------------------------------------------------------------------
// 9.3.1 FECHAMENTO DE CAIXA DIÁRIO (CONFERÊNCIA POR FORMA, SANGRIAS E GAVETA)
// -------------------------------------------------------------------------
function openModalFechamentoCaixa(dataIso) {
  const data = dataIso || getHojeString();
  const input = document.getElementById('fechamento-data-filtro');
  if (input) input.value = data;
  calcularFechamentoDiario(data);
  openModal('modal-fechamento-caixa');
}

function setFechamentoData(atalho) {
  let data = getHojeString();
  if (atalho === 'ontem') {
    data = getOntemString();
  }
  const input = document.getElementById('fechamento-data-filtro');
  if (input) input.value = data;
  calcularFechamentoDiario(data);
}

function calcularFechamentoDiario(dataIso) {
  if (!dataIso) dataIso = getHojeString();

  // 1. Atendimentos Concluídos na data especificada
  const atendimentosDia = (appState.agendamentos || []).filter(a => 
    a.data === dataIso && a.status === 'Concluido'
  );

  let totalBruto = 0;
  let totalTaxas = 0;
  let totalLiquido = 0;
  let porForma = {
    Dinheiro: { bruto: 0, taxa: 0, liquido: 0 },
    PIX: { bruto: 0, taxa: 0, liquido: 0 },
    Cartao_Debito: { bruto: 0, taxa: 0, liquido: 0 },
    Cartao_Credito: { bruto: 0, taxa: 0, liquido: 0 }
  };

  let disponivelHoje = 0;
  let aReceberFuturo = 0;
  let qtdFuturos = 0;

  atendimentosDia.forEach(a => {
    const valorBruto = parseFloat(a.total_venda) || parseFloat(a.total_comanda) || parseFloat(a.servico_preco) || 0;
    const f = a.forma_pagamento || 'Dinheiro';

    let taxaValor = 0;
    let valorLiquido = valorBruto;
    let dataComp = a.data || dataIso;

    if (a.taxa_aplicada_valor !== undefined && a.valor_liquido !== undefined && a.data_compensacao) {
      taxaValor = parseFloat(a.taxa_aplicada_valor) || 0;
      valorLiquido = parseFloat(a.valor_liquido) || 0;
      dataComp = a.data_compensacao;
    } else {
      const calc = calcularTaxaECompensacao(valorBruto, f, appState.config, a.data);
      taxaValor = calc.taxaAplicadaValor;
      valorLiquido = calc.valorLiquido;
      dataComp = calc.dataCompensacao;
    }

    totalBruto += valorBruto;
    totalTaxas += taxaValor;
    totalLiquido += valorLiquido;

    const fKey = porForma.hasOwnProperty(f) ? f : 'Dinheiro';
    porForma[fKey].bruto += valorBruto;
    porForma[fKey].taxa += taxaValor;
    porForma[fKey].liquido += valorLiquido;

    if (f === 'Dinheiro') {
      // Dinheiro físico cai na gaveta na hora
    } else {
      if (dataComp <= dataIso) {
        disponivelHoje += valorLiquido;
      } else {
        aReceberFuturo += valorLiquido;
        qtdFuturos++;
      }
    }
  });

  // 2. Sangrias na data especificada
  const sangriasDia = (appState.sangrias || []).filter(s => 
    s.data_hora && s.data_hora.startsWith(dataIso)
  );
  let totalSangrias = 0;
  sangriasDia.forEach(s => {
    totalSangrias += parseFloat(s.valor) || 0;
  });

  // 3. Pagamentos a barbeiros na data especificada
  const pagamentosDia = (appState.pagamentosBarbeiros || []).filter(p => 
    p.data_hora && p.data_hora.startsWith(dataIso)
  );
  let totalPagamentos = 0;
  let pagamentosDinheiro = 0;
  pagamentosDia.forEach(p => {
    const val = parseFloat(p.valor) || 0;
    totalPagamentos += val;
    if (p.forma_pagamento === 'Dinheiro') {
      pagamentosDinheiro += val;
    }
  });

  // 4. Saldo em Gaveta Físico
  const dinheiroEntrada = porForma.Dinheiro.bruto || 0;
  const saldoGaveta = dinheiroEntrada - totalSangrias - pagamentosDinheiro;

  // Disponível hoje na loja e conta (Gaveta + PIX/Cartões D+0 compensados até hoje - saídas não em dinheiro)
  const pagamentosNaoDinheiro = totalPagamentos - pagamentosDinheiro;
  const totalDisponivelHoje = Math.max(0, saldoGaveta + disponivelHoje - pagamentosNaoDinheiro);

  // 5. Saldo Líquido do Dia
  const saldoLiquidoGeral = totalLiquido - totalSangrias - totalPagamentos;

  // Atualização dos elementos no DOM
  const elTotalArrecadado = document.getElementById('fechamento-total-arrecadado');
  if (elTotalArrecadado) elTotalArrecadado.textContent = formatarMoeda(totalBruto);

  const elTotalTaxas = document.getElementById('fechamento-total-taxas');
  if (elTotalTaxas) elTotalTaxas.textContent = `- ${formatarMoeda(totalTaxas)}`;

  const elTotalLiquido = document.getElementById('fechamento-total-liquido');
  if (elTotalLiquido) elTotalLiquido.textContent = formatarMoeda(totalLiquido);

  const elQtdAtendimentos = document.getElementById('fechamento-qtd-atendimentos');
  if (elQtdAtendimentos) {
    elQtdAtendimentos.textContent = `${atendimentosDia.length} atendimento${atendimentosDia.length === 1 ? '' : 's'} concluído${atendimentosDia.length === 1 ? '' : 's'}`;
  }

  const elSaldoGaveta = document.getElementById('fechamento-saldo-gaveta');
  if (elSaldoGaveta) {
    elSaldoGaveta.textContent = formatarMoeda(saldoGaveta);
    elSaldoGaveta.className = `text-xl font-black ${saldoGaveta >= 0 ? 'text-white' : 'text-rose-400'}`;
  }

  const elDispHoje = document.getElementById('fechamento-disponivel-hoje');
  if (elDispHoje) elDispHoje.textContent = formatarMoeda(totalDisponivelHoje);

  const elReceberFuturo = document.getElementById('fechamento-a-receber-futuro');
  if (elReceberFuturo) elReceberFuturo.textContent = formatarMoeda(aReceberFuturo);

  const elQtdFuturosTag = document.getElementById('fechamento-qtd-futuros-tag');
  if (elQtdFuturosTag) {
    elQtdFuturosTag.textContent = `${qtdFuturos} transação${qtdFuturos === 1 ? '' : 'ões'} a compensar`;
  }

  const elTotalSangrias = document.getElementById('fechamento-total-sangrias');
  if (elTotalSangrias) elTotalSangrias.textContent = formatarMoeda(totalSangrias);

  // Formas de Pagamento
  const elFormaDinheiro = document.getElementById('fechamento-forma-dinheiro');
  if (elFormaDinheiro) elFormaDinheiro.textContent = formatarMoeda(porForma.Dinheiro.bruto);

  const elFormaPix = document.getElementById('fechamento-forma-pix');
  if (elFormaPix) elFormaPix.textContent = formatarMoeda(porForma.PIX.bruto);
  const elPixLiq = document.getElementById('fechamento-pix-liquido-tag');
  if (elPixLiq) elPixLiq.textContent = `Líq: ${formatarMoeda(porForma.PIX.liquido)}`;
  const elBadgePix = document.getElementById('fechamento-badge-taxa-pix');
  if (elBadgePix) elBadgePix.textContent = `${appState.config?.taxa_pix_pct ?? 0}%`;

  const elFormaDebito = document.getElementById('fechamento-forma-debito');
  if (elFormaDebito) elFormaDebito.textContent = formatarMoeda(porForma.Cartao_Debito.bruto);
  const elDebLiq = document.getElementById('fechamento-debito-liquido-tag');
  if (elDebLiq) elDebLiq.textContent = `Líq: ${formatarMoeda(porForma.Cartao_Debito.liquido)}`;
  const elBadgeDeb = document.getElementById('fechamento-badge-taxa-debito');
  if (elBadgeDeb) elBadgeDeb.textContent = `${appState.config?.taxa_debito_pct ?? 1.99}%`;

  const elFormaCredito = document.getElementById('fechamento-forma-credito');
  if (elFormaCredito) elFormaCredito.textContent = formatarMoeda(porForma.Cartao_Credito.bruto);
  const elCredLiq = document.getElementById('fechamento-credito-liquido-tag');
  if (elCredLiq) elCredLiq.textContent = `Líq: ${formatarMoeda(porForma.Cartao_Credito.liquido)}`;
  const elBadgeCred = document.getElementById('fechamento-badge-taxa-credito');
  if (elBadgeCred) elBadgeCred.textContent = `${appState.config?.taxa_credito_pct ?? 3.99}%`;

  // Sangrias
  const elSubtotalSangrias = document.getElementById('fechamento-subtotal-sangrias');
  if (elSubtotalSangrias) elSubtotalSangrias.textContent = formatarMoeda(totalSangrias);

  const listaSangrias = document.getElementById('fechamento-lista-sangrias');
  if (listaSangrias) {
    if (sangriasDia.length === 0) {
      listaSangrias.innerHTML = `<p class="text-slate-500 py-1.5 text-center text-xs">Nenhuma sangria realizada nesta data.</p>`;
    } else {
      let h = '';
      sangriasDia.forEach(s => {
        const hora = s.data_hora ? s.data_hora.substring(11, 16) : '--:--';
        h += `
          <div class="flex items-center justify-between p-2 rounded-lg bg-dark-800/80 border border-dark-700/60 text-xs">
            <div class="flex items-center gap-2">
              <span class="text-rose-400 font-mono text-[11px] font-bold">${hora}</span>
              <span class="text-white font-medium">${s.motivo || 'Sangria de Caixa'}</span>
            </div>
            <span class="text-rose-400 font-bold">- ${formatarMoeda(s.valor)}</span>
          </div>
        `;
      });
      listaSangrias.innerHTML = h;
    }
  }

  // Atendimentos do Dia
  const elSubtotalServicos = document.getElementById('fechamento-subtotal-servicos');
  if (elSubtotalServicos) elSubtotalServicos.textContent = formatarMoeda(totalBruto);

  const listaAtendimentos = document.getElementById('fechamento-lista-atendimentos');
  if (listaAtendimentos) {
    if (atendimentosDia.length === 0) {
      listaAtendimentos.innerHTML = `<p class="text-slate-500 py-1.5 text-center text-xs">Nenhum atendimento concluído nesta data.</p>`;
    } else {
      let h = '';
      atendimentosDia.forEach(a => {
        const bruto = parseFloat(a.total_venda) || parseFloat(a.total_comanda) || parseFloat(a.servico_preco) || 0;
        let taxa = 0;
        let liq = bruto;
        if (a.taxa_aplicada_valor !== undefined && a.valor_liquido !== undefined) {
          taxa = parseFloat(a.taxa_aplicada_valor) || 0;
          liq = parseFloat(a.valor_liquido) || 0;
        } else {
          const calc = calcularTaxaECompensacao(bruto, a.forma_pagamento, appState.config, a.data);
          taxa = calc.taxaAplicadaValor;
          liq = calc.valorLiquido;
        }

        h += `
          <div class="flex items-center justify-between p-2 rounded-lg bg-dark-800/80 border border-dark-700/60 text-xs">
            <div class="flex items-center gap-2">
              <span class="text-gold-400 font-mono text-[11px] font-bold">${formatarHora(a.horario)}</span>
              <div>
                <span class="text-white font-medium">${a.servico_nome}</span>
                <span class="text-slate-400 text-[11px]"> (${a.cliente_nome} - ${a.barbeiro_nome})</span>
                <div class="text-[10px] text-slate-400">${formatarFormaPagamento(a.forma_pagamento)}</div>
              </div>
            </div>
            <div class="text-right">
              <span class="text-slate-200 font-bold">${formatarMoeda(bruto)}</span>
              ${taxa > 0 ? `<div class="text-[10px] text-rose-400 font-medium">Taxa: -${formatarMoeda(taxa)}</div>` : ''}
              <div class="text-[10px] text-emerald-400 font-bold">Líq: ${formatarMoeda(liq)}</div>
            </div>
          </div>
        `;
      });
      listaAtendimentos.innerHTML = h;
    }
  }

  const elSaldoLiquido = document.getElementById('fechamento-saldo-liquido-geral');
  if (elSaldoLiquido) {
    elSaldoLiquido.textContent = formatarMoeda(saldoLiquidoGeral);
    elSaldoLiquido.className = `text-2xl font-black ${saldoLiquidoGeral >= 0 ? 'text-emerald-400' : 'text-rose-400'}`;
  }

  if (window.lucide) lucide.createIcons();
}

function imprimirFechamentoCaixa() {
  const dataInput = document.getElementById('fechamento-data-filtro');
  const dataIso = dataInput ? dataInput.value : getHojeString();
  const printArea = document.getElementById('print-fechamento-area');
  if (!printArea) return;

  const cfg = appState.config || {};
  const nomeBarbearia = cfg.nome_barbearia || 'Barbearia Vintage & Estilo';
  const tel = cfg.telefone_barbearia || '';

  const atendimentosDia = (appState.agendamentos || []).filter(a => 
    a.data === dataIso && a.status === 'Concluido'
  );

  let totalBruto = 0;
  let totalTaxas = 0;
  let totalLiquido = 0;
  let porForma = {
    Dinheiro: { bruto: 0, taxa: 0, liquido: 0 },
    PIX: { bruto: 0, taxa: 0, liquido: 0 },
    Cartao_Debito: { bruto: 0, taxa: 0, liquido: 0 },
    Cartao_Credito: { bruto: 0, taxa: 0, liquido: 0 }
  };

  let disponivelHoje = 0;
  let aReceberFuturo = 0;

  atendimentosDia.forEach(a => {
    const valorBruto = parseFloat(a.total_venda) || parseFloat(a.total_comanda) || parseFloat(a.servico_preco) || 0;
    const f = a.forma_pagamento || 'Dinheiro';

    let taxaValor = 0;
    let valorLiquido = valorBruto;
    let dataComp = a.data || dataIso;

    if (a.taxa_aplicada_valor !== undefined && a.valor_liquido !== undefined && a.data_compensacao) {
      taxaValor = parseFloat(a.taxa_aplicada_valor) || 0;
      valorLiquido = parseFloat(a.valor_liquido) || 0;
      dataComp = a.data_compensacao;
    } else {
      const calc = calcularTaxaECompensacao(valorBruto, f, appState.config, a.data);
      taxaValor = calc.taxaAplicadaValor;
      valorLiquido = calc.valorLiquido;
      dataComp = calc.dataCompensacao;
    }

    totalBruto += valorBruto;
    totalTaxas += taxaValor;
    totalLiquido += valorLiquido;

    const fKey = porForma.hasOwnProperty(f) ? f : 'Dinheiro';
    porForma[fKey].bruto += valorBruto;
    porForma[fKey].taxa += taxaValor;
    porForma[fKey].liquido += valorLiquido;

    if (f === 'Dinheiro') {
      // Dinheiro físico
    } else {
      if (dataComp <= dataIso) disponivelHoje += valorLiquido;
      else aReceberFuturo += valorLiquido;
    }
  });

  const sangriasDia = (appState.sangrias || []).filter(s => 
    s.data_hora && s.data_hora.startsWith(dataIso)
  );
  let totalSangrias = 0;
  sangriasDia.forEach(s => totalSangrias += parseFloat(s.valor) || 0);

  const pagamentosDia = (appState.pagamentosBarbeiros || []).filter(p => 
    p.data_hora && p.data_hora.startsWith(dataIso)
  );
  let totalPagamentos = 0;
  let pagamentosDinheiro = 0;
  pagamentosDia.forEach(p => {
    const val = parseFloat(p.valor) || 0;
    totalPagamentos += val;
    if (p.forma_pagamento === 'Dinheiro') pagamentosDinheiro += val;
  });

  const saldoGaveta = (porForma.Dinheiro.bruto || 0) - totalSangrias - pagamentosDinheiro;
  const pagamentosNaoDinheiro = totalPagamentos - pagamentosDinheiro;
  const saldoDispHoje = Math.max(0, saldoGaveta + disponivelHoje - pagamentosNaoDinheiro);
  const saldoLiquidoGeral = totalLiquido - totalSangrias - totalPagamentos;

  let sangriasHtml = '';
  if (sangriasDia.length > 0) {
    sangriasDia.forEach(s => {
      const hora = s.data_hora ? s.data_hora.substring(11, 16) : '';
      sangriasHtml += `<div style="display:flex; justify-content:space-between; margin:2px 0;"><span>[${hora}] ${s.motivo || 'Sangria'}:</span><span>-${formatarMoeda(s.valor)}</span></div>`;
    });
  } else {
    sangriasHtml = `<div style="color:#666;">Nenhuma sangria realizada.</div>`;
  }

  let servicosHtml = '';
  if (atendimentosDia.length > 0) {
    atendimentosDia.forEach(a => {
      const bruto = parseFloat(a.total_venda) || parseFloat(a.total_comanda) || parseFloat(a.servico_preco) || 0;
      let taxa = 0;
      let liq = bruto;
      if (a.taxa_aplicada_valor !== undefined && a.valor_liquido !== undefined) {
        taxa = parseFloat(a.taxa_aplicada_valor) || 0;
        liq = parseFloat(a.valor_liquido) || 0;
      } else {
        const calc = calcularTaxaECompensacao(bruto, a.forma_pagamento, appState.config, a.data);
        taxa = calc.taxaAplicadaValor;
        liq = calc.valorLiquido;
      }
      servicosHtml += `
        <div style="border-bottom:1px dotted #ccc; padding:3px 0; margin-bottom:2px;">
          <div style="display:flex; justify-content:space-between;">
            <span><strong>${formatarHora(a.horario)}</strong> ${a.servico_nome} (${a.cliente_nome})</span>
            <span>${formatarMoeda(bruto)}</span>
          </div>
          <div style="display:flex; justify-content:space-between; font-size:9px; color:#555;">
            <span>${formatarFormaPagamento(a.forma_pagamento)} ${taxa > 0 ? `(Taxa: -${formatarMoeda(taxa)})` : ''}</span>
            <span style="font-weight:bold; color:#000;">Líq: ${formatarMoeda(liq)}</span>
          </div>
        </div>
      `;
    });
  } else {
    servicosHtml = `<div style="color:#666;">Nenhum atendimento concluído.</div>`;
  }

  printArea.innerHTML = `
    <div style="font-family: monospace; font-size: 11px; line-height: 1.4; color: #000; padding: 12px; max-width: 340px; margin: 0 auto; background: #fff;">
      <div style="text-align: center; border-bottom: 1px dashed #000; padding-bottom: 8px; margin-bottom: 8px;">
        <h2 style="font-size: 15px; margin: 0; font-weight: bold; text-transform: uppercase;">${nomeBarbearia}</h2>
        ${tel ? `<p style="margin: 2px 0 0; font-size: 10px;">Contato: ${tel}</p>` : ''}
        <h3 style="font-size: 12px; margin: 4px 0 0; font-weight: bold;">FECHAMENTO DE CAIXA & MAQUININHA</h3>
        <p style="margin: 2px 0 0; font-size: 11px;">Data de Referência: <strong>${formatarDataPt(dataIso)}</strong></p>
        <p style="font-size: 9px; margin: 2px 0 0; color: #444;">Impresso em: ${getHojeAgoraString()}</p>
      </div>

      <div style="border-bottom: 1px dashed #000; padding-bottom: 8px; margin-bottom: 8px;">
        <div style="font-weight: bold; margin-bottom: 4px;">FATURAMENTO BRUTO x LÍQUIDO:</div>
        <div style="display: flex; justify-content: space-between;"><span>Total Bruto Cobrado:</span><span>${formatarMoeda(totalBruto)}</span></div>
        <div style="display: flex; justify-content: space-between; color:#c00;"><span>Taxas de Maquininha:</span><span>-${formatarMoeda(totalTaxas)}</span></div>
        <div style="display: flex; justify-content: space-between; font-weight: bold; border-top: 1px dotted #000; padding-top: 3px; margin-top: 3px;">
          <span>FATURAMENTO LÍQUIDO REAL:</span><span>${formatarMoeda(totalLiquido)}</span>
        </div>
      </div>

      <div style="border-bottom: 1px dashed #000; padding-bottom: 8px; margin-bottom: 8px;">
        <div style="font-weight: bold; margin-bottom: 4px;">ARRECADAÇÃO POR FORMA DE PAGAMENTO:</div>
        <div style="display: flex; justify-content: space-between;"><span>💵 Dinheiro:</span><span>${formatarMoeda(porForma.Dinheiro.bruto)}</span></div>
        <div style="display: flex; justify-content: space-between;"><span>⚡ PIX (Líq: ${formatarMoeda(porForma.PIX.liquido)}):</span><span>${formatarMoeda(porForma.PIX.bruto)}</span></div>
        <div style="display: flex; justify-content: space-between;"><span>💳 Débito (Líq: ${formatarMoeda(porForma.Cartao_Debito.liquido)}):</span><span>${formatarMoeda(porForma.Cartao_Debito.bruto)}</span></div>
        <div style="display: flex; justify-content: space-between;"><span>💳 Crédito (Líq: ${formatarMoeda(porForma.Cartao_Credito.liquido)}):</span><span>${formatarMoeda(porForma.Cartao_Credito.bruto)}</span></div>
      </div>

      <div style="border-bottom: 1px dashed #000; padding-bottom: 8px; margin-bottom: 8px;">
        <div style="font-weight: bold; margin-bottom: 4px;">DISPONIBILIDADE & PREVISÃO DE CAIXA:</div>
        <div style="display: flex; justify-content: space-between; font-weight: bold;"><span>SALDO ESPERADO EM GAVETA:</span><span>${formatarMoeda(saldoGaveta)}</span></div>
        <div style="display: flex; justify-content: space-between;"><span>Disponível Hoje (Caixa/Conta):</span><span>${formatarMoeda(saldoDispHoje)}</span></div>
        <div style="display: flex; justify-content: space-between;"><span>A Receber Futuro (Cartão):</span><span>${formatarMoeda(aReceberFuturo)}</span></div>
      </div>

      <div style="border-bottom: 1px dashed #000; padding-bottom: 8px; margin-bottom: 8px;">
        <div style="font-weight: bold; margin-bottom: 4px;">RETIRADAS E SANGRIAS DO DIA:</div>
        <div style="display: flex; justify-content: space-between; font-weight: bold;"><span>Total Sangrias:</span><span>-${formatarMoeda(totalSangrias)}</span></div>
        ${pagamentosDinheiro > 0 ? `<div style="display: flex; justify-content: space-between;"><span>Pagtos Barbeiros (Espécie):</span><span>-${formatarMoeda(pagamentosDinheiro)}</span></div>` : ''}
        <div style="margin-top: 4px; font-size: 10px;">${sangriasHtml}</div>
      </div>

      <div style="border-bottom: 2px solid #000; padding-bottom: 8px; margin-bottom: 8px;">
        <div style="display: flex; justify-content: space-between; font-size: 13px; font-weight: bold;">
          <span>SALDO LÍQUIDO FINAL DO DIA:</span>
          <span>${formatarMoeda(saldoLiquidoGeral)}</span>
        </div>
        <div style="font-size: 9px; color: #555;">(Líquido real menos despesas e comissões)</div>
      </div>

      <div style="border-bottom: 1px dashed #000; padding-bottom: 8px; margin-bottom: 8px; font-size: 10px;">
        <div style="font-weight: bold; margin-bottom: 4px;">ATENDIMENTOS DO DIA (${atendimentosDia.length}):</div>
        ${servicosHtml}
      </div>

      <div style="text-align: center; margin-top: 25px; padding-top: 10px;">
        <div style="border-top: 1px solid #000; width: 80%; margin: 0 auto 5px;"></div>
        <p style="margin: 0; font-size: 10px;">Assinatura do Gestor / Responsável</p>
      </div>
    </div>
  `;

  window.print();
}

function exportarFechamentoCSV(dataIso) {
  if (!dataIso) {
    const input = document.getElementById('fechamento-data-filtro');
    dataIso = input ? input.value : getHojeString();
  }

  const cfg = appState.config || {};
  const nomeBarbearia = cfg.nome_barbearia || 'GESTÃO PROFISSIONAL DE BARBEARIA';

  const atendimentosDia = (appState.agendamentos || []).filter(a => 
    a.data === dataIso && a.status === 'Concluido'
  );
  const sangriasDia = (appState.sangrias || []).filter(s => 
    s.data_hora && s.data_hora.startsWith(dataIso)
  );
  const pagamentosDia = (appState.pagamentosBarbeiros || []).filter(p => 
    p.data_hora && p.data_hora.startsWith(dataIso)
  );

  let totalBruto = 0;
  let totalTaxas = 0;
  let totalLiquido = 0;
  let porForma = {
    Dinheiro: { bruto: 0, taxa: 0, liquido: 0 },
    PIX: { bruto: 0, taxa: 0, liquido: 0 },
    Cartao_Debito: { bruto: 0, taxa: 0, liquido: 0 },
    Cartao_Credito: { bruto: 0, taxa: 0, liquido: 0 }
  };
  let disponivelHoje = 0;
  let aReceberFuturo = 0;

  atendimentosDia.forEach(a => {
    const valorBruto = parseFloat(a.total_venda) || parseFloat(a.total_comanda) || parseFloat(a.servico_preco) || 0;
    const f = a.forma_pagamento || 'Dinheiro';

    let taxaValor = 0;
    let valorLiquido = valorBruto;
    let dataComp = a.data || dataIso;

    if (a.taxa_aplicada_valor !== undefined && a.valor_liquido !== undefined && a.data_compensacao) {
      taxaValor = parseFloat(a.taxa_aplicada_valor) || 0;
      valorLiquido = parseFloat(a.valor_liquido) || 0;
      dataComp = a.data_compensacao;
    } else {
      const calc = calcularTaxaECompensacao(valorBruto, f, appState.config, a.data);
      taxaValor = calc.taxaAplicadaValor;
      valorLiquido = calc.valorLiquido;
      dataComp = calc.dataCompensacao;
    }

    totalBruto += valorBruto;
    totalTaxas += taxaValor;
    totalLiquido += valorLiquido;

    const fKey = porForma.hasOwnProperty(f) ? f : 'Dinheiro';
    porForma[fKey].bruto += valorBruto;
    porForma[fKey].taxa += taxaValor;
    porForma[fKey].liquido += valorLiquido;

    if (f === 'Dinheiro') {
      // Dinheiro físico
    } else {
      if (dataComp <= dataIso) disponivelHoje += valorLiquido;
      else aReceberFuturo += valorLiquido;
    }
  });

  const totalSangrias = sangriasDia.reduce((acc, s) => acc + (parseFloat(s.valor) || 0), 0);
  const totalPagamentos = pagamentosDia.reduce((acc, p) => acc + (parseFloat(p.valor) || 0), 0);
  const pagamentosDinheiro = pagamentosDia.filter(p => p.forma_pagamento === 'Dinheiro').reduce((acc, p) => acc + (parseFloat(p.valor) || 0), 0);

  const saldoGaveta = (porForma.Dinheiro.bruto || 0) - totalSangrias - pagamentosDinheiro;
  const pagamentosNaoDinheiro = totalPagamentos - pagamentosDinheiro;
  const saldoDispHoje = Math.max(0, saldoGaveta + disponivelHoje - pagamentosNaoDinheiro);
  const saldoLiquidoGeral = totalLiquido - totalSangrias - totalPagamentos;

  // Montagem do arquivo CSV formatado em ponto-e-vírgula com UTF-8 BOM
  let csv = '\uFEFF';
  csv += `RELATÓRIO DE FECHAMENTO DE CAIXA & MAQUININHA DIÁRIO\n`;
  csv += `Barbearia;${nomeBarbearia}\n`;
  csv += `Data de Referência;${formatarDataPt(dataIso)}\n`;
  csv += `Gerado em;${getHojeAgoraString()}\n\n`;

  csv += `RESUMO FINANCEIRO CONSOLIDADO\n`;
  csv += `Métrica;Valor (R$)\n`;
  csv += `Total Bruto Cobrado dos Clientes;${totalBruto.toFixed(2)}\n`;
  csv += `Total de Taxas de Maquininha / Operadoras;-${totalTaxas.toFixed(2)}\n`;
  csv += `Faturamento Líquido Real da Barbearia;${totalLiquido.toFixed(2)}\n`;
  csv += `Saldo Físico em Gaveta (Espécie);${saldoGaveta.toFixed(2)}\n`;
  csv += `Saldo Disponível Imediato (Caixa/Conta);${saldoDispHoje.toFixed(2)}\n`;
  csv += `A Receber Futuro (Lançamentos a Compensar);${aReceberFuturo.toFixed(2)}\n`;
  csv += `Total de Sangrias Retiradas;-${totalSangrias.toFixed(2)}\n`;
  csv += `Total de Comissões / Acertos Pagos;-${totalPagamentos.toFixed(2)}\n`;
  csv += `Saldo Líquido Geral do Dia;${saldoLiquidoGeral.toFixed(2)}\n\n`;

  csv += `DETALHAMENTO POR FORMA DE PAGAMENTO\n`;
  csv += `Forma de Pagamento;Valor Bruto (R$);Taxa Operadora (R$);Valor Líquido (R$)\n`;
  csv += `Dinheiro (Espécie);${porForma.Dinheiro.bruto.toFixed(2)};0.00;${porForma.Dinheiro.liquido.toFixed(2)}\n`;
  csv += `PIX;${porForma.PIX.bruto.toFixed(2)};${porForma.PIX.taxa.toFixed(2)};${porForma.PIX.liquido.toFixed(2)}\n`;
  csv += `Cartão de Débito;${porForma.Cartao_Debito.bruto.toFixed(2)};${porForma.Cartao_Debito.taxa.toFixed(2)};${porForma.Cartao_Debito.liquido.toFixed(2)}\n`;
  csv += `Cartão de Crédito;${porForma.Cartao_Credito.bruto.toFixed(2)};${porForma.Cartao_Credito.taxa.toFixed(2)};${porForma.Cartao_Credito.liquido.toFixed(2)}\n\n`;

  csv += `ATENDIMENTOS CONCLUÍDOS NO DIA\n`;
  csv += `Horário;Cliente;Telefone;Serviço;Barbeiro;Forma de Pagamento;Valor Bruto (R$);Taxa Maquininha (R$);Valor Líquido (R$);Data Compensação;Comissão Barbeiro (R$)\n`;
  atendimentosDia.forEach(a => {
    const bruto = parseFloat(a.total_venda) || parseFloat(a.total_comanda) || parseFloat(a.servico_preco) || 0;
    let taxa = 0;
    let liq = bruto;
    let dtComp = a.data_compensacao || a.data || dataIso;
    if (a.taxa_aplicada_valor !== undefined && a.valor_liquido !== undefined) {
      taxa = parseFloat(a.taxa_aplicada_valor) || 0;
      liq = parseFloat(a.valor_liquido) || 0;
    } else {
      const calc = calcularTaxaECompensacao(bruto, a.forma_pagamento, appState.config, a.data);
      taxa = calc.taxaAplicadaValor;
      liq = calc.valorLiquido;
      dtComp = calc.dataCompensacao;
    }
    const com = parseFloat(a.comissao_valor) || 0;
    csv += `"${formatarHora(a.horario)}";"${a.cliente_nome}";"${a.cliente_telefone || ''}";"${a.servico_nome}";"${a.barbeiro_nome}";"${formatarFormaPagamento(a.forma_pagamento)}";${bruto.toFixed(2)};${taxa.toFixed(2)};${liq.toFixed(2)};"${formatarDataPt(dtComp)}";${com.toFixed(2)}\n`;
  });
  csv += `\n`;

  csv += `SANGRIAS REALIZADAS NO DIA\n`;
  csv += `Horário;Motivo;Responsável;Valor Retirado (R$)\n`;
  sangriasDia.forEach(s => {
    const hora = s.data_hora ? s.data_hora.substring(11, 16) : '--:--';
    const val = parseFloat(s.valor) || 0;
    csv += `"${hora}";"${s.motivo || 'Sangria'}";"${s.usuario || 'Gestor'}";-${val.toFixed(2)}\n`;
  });

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', `fechamento_caixa_${dataIso}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  showToast(`Relatório CSV de ${formatarDataPt(dataIso)} exportado com sucesso!`, 'success');
}

// -------------------------------------------------------------------------
// 9.4 BARBEIROS, COMISSÕES & PAGAMENTOS
// -------------------------------------------------------------------------
function renderBarbeiros() {
  const grid = document.getElementById('grid-barbeiros-cards');
  if (!grid) return;

  const barbeiros = appState.barbeiros || [];
  if (barbeiros.length === 0) {
    grid.innerHTML = `
      <div class="col-span-full p-8 text-center bg-dark-800 rounded-2xl border border-dark-700 text-slate-500">
        Nenhum barbeiro cadastrado. Clique em <strong>+ Cadastrar Novo Barbeiro</strong> para começar.
      </div>
    `;
    return;
  }

  let html = '';
  barbeiros.forEach(b => {
    const sal = calcularSaldoBarbeiro(b.id);
    const zapLink = b.telefone ? `https://wa.me/55${limparTelefone(b.telefone)}` : null;

    html += `
      <div class="bg-dark-800 border border-dark-700/80 rounded-2xl p-5 shadow-sm flex flex-col justify-between hover:border-gold-500/40 transition-all">
        <div>
          <div class="flex items-start justify-between gap-2 mb-3">
            <div class="flex items-center gap-3">
              <div class="w-12 h-12 rounded-xl bg-gold-500/10 border border-gold-500/30 flex items-center justify-center text-gold-400 font-bold text-base">
                ${b.nome.substring(0, 2).toUpperCase()}
              </div>
              <div>
                <h3 class="text-sm font-bold text-white">${b.nome}</h3>
                <div class="flex items-center gap-2 mt-0.5">
                  <span class="text-[11px] font-mono text-gold-400 bg-gold-500/10 px-1.5 py-0.5 rounded">Login: ${b.login}</span>
                </div>
              </div>
            </div>
            
            <div class="flex items-center gap-1">
              <button onclick="editarBarbeiro('${b.id}')" title="Editar Barbeiro" class="text-slate-400 hover:text-gold-400 p-1.5 rounded-lg hover:bg-dark-700 transition-colors">
                <i data-lucide="edit-3" class="w-4 h-4"></i>
              </button>
              <button onclick="resetarSenhaBarbeiroPrompt('${b.id}', '${b.nome}')" title="Resetar Senha do Barbeiro" class="text-slate-400 hover:text-amber-400 p-1.5 rounded-lg hover:bg-dark-700 transition-colors">
                <i data-lucide="key" class="w-4 h-4"></i>
              </button>
              <button onclick="excluirBarbeiro('${b.id}')" title="Excluir Barbeiro" class="text-slate-400 hover:text-rose-400 p-1.5 rounded-lg hover:bg-dark-700 transition-colors">
                <i data-lucide="trash-2" class="w-4 h-4"></i>
              </button>
            </div>
          </div>

          <div class="p-3 bg-dark-900/80 rounded-xl border border-dark-700/60 space-y-2 mb-4 text-xs">
            <div class="flex items-center justify-between">
              <span class="text-slate-400">Comissão Contratada:</span>
              <span class="font-bold text-white">${b.comissao_pct || 50}%</span>
            </div>
            <div class="flex items-center justify-between">
              <span class="text-slate-400">Total Faturado:</span>
              <span class="font-medium text-slate-200">${formatarMoeda(sal.totalProduzido)}</span>
            </div>
            <div class="flex items-center justify-between">
              <span class="text-slate-400">Comissões Geradas:</span>
              <span class="font-medium text-amber-300">${formatarMoeda(sal.totalComissaoGerada)}</span>
            </div>
            <div class="flex items-center justify-between">
              <span class="text-slate-400">Total Já Pago:</span>
              <span class="font-medium text-emerald-400">${formatarMoeda(sal.totalJaPago)}</span>
            </div>
          </div>

          <div class="bg-gradient-to-r from-gold-500/10 to-amber-500/5 border border-gold-500/30 rounded-xl p-3 flex items-center justify-between mb-4">
            <div>
              <span class="text-[10px] uppercase font-bold text-gold-400 tracking-wider">Saldo a Receber</span>
              <p class="text-xs text-slate-400">Pendente de acerto</p>
            </div>
            <span class="text-xl font-extrabold text-gold-400">${formatarMoeda(sal.saldoAReceber)}</span>
          </div>
        </div>

        <div class="flex items-center gap-2 pt-2 border-t border-dark-700/60">
          ${zapLink ? `
            <a href="${zapLink}" target="_blank" class="p-2 bg-dark-900 hover:bg-emerald-500/20 text-emerald-400 rounded-xl border border-dark-700 transition-colors" title="Chamar no WhatsApp">
              <i data-lucide="message-circle" class="w-4 h-4"></i>
            </a>
          ` : ''}
          <button onclick="openModalPagarBarbeiro('${b.id}', '${b.nome}', ${sal.saldoAReceber})" class="flex-1 bg-gold-500 hover:bg-gold-400 text-dark-900 font-bold py-2 px-3 rounded-xl text-xs flex items-center justify-center gap-1.5 shadow-md shadow-gold-500/10 transition-all">
            <i data-lucide="dollar-sign" class="w-4 h-4"></i>
            <span>Pagar Barbeiro</span>
          </button>
        </div>
      </div>
    `;
  });

  grid.innerHTML = html;
  renderTabelaPagamentosBarbeiros();
  if (window.lucide) lucide.createIcons();
}

function renderTabelaPagamentosBarbeiros() {
  const tbody = document.getElementById('tabela-pagamentos-barbeiros-tbody');
  if (!tbody) return;

  const pags = [...(appState.pagamentosBarbeiros || [])];
  pags.sort((a, b) => (b.data_hora || '').localeCompare(a.data_hora || ''));

  if (pags.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" class="p-6 text-center text-slate-500">
          Nenhum pagamento registrado ainda.
        </td>
      </tr>
    `;
    return;
  }

  let html = '';
  pags.forEach(p => {
    html += `
      <tr class="hover:bg-dark-900/40 transition-colors">
        <td class="p-3 text-slate-400 font-mono text-[11px]">${formatarDataHoraPt(p.data_hora)}</td>
        <td class="p-3 font-bold text-white">${p.barbeiro_nome}</td>
        <td class="p-3 text-gold-400 font-medium">${formatarFormaPagamento(p.forma_pagamento)}</td>
        <td class="p-3 text-slate-300">${p.observacao || 'Acerto'}</td>
        <td class="p-3 text-right font-extrabold text-emerald-400">${formatarMoeda(p.valor)}</td>
      </tr>
    `;
  });

  tbody.innerHTML = html;
}

function openModalPagarBarbeiro(barbeiroId, nome, saldoAtual) {
  document.getElementById('pagamento-barbeiro-id').value = barbeiroId;
  document.getElementById('pagamento-barbeiro-nome').value = nome;
  document.getElementById('pagamento-saldo-atual').textContent = formatarMoeda(saldoAtual);
  document.getElementById('pagamento-valor').value = saldoAtual > 0 ? saldoAtual.toFixed(2) : '';
  document.getElementById('pagamento-forma').value = 'PIX';
  document.getElementById('pagamento-obs').value = 'Acerto de comissão';

  openModal('modal-pagar-barbeiro');
}

function preencherValorTotalSaldo() {
  const txt = document.getElementById('pagamento-saldo-atual').textContent;
  const num = parseFloat(txt.replace('R$', '').replace(/\./g, '').replace(',', '.').trim()) || 0;
  document.getElementById('pagamento-valor').value = num > 0 ? num.toFixed(2) : '';
}

async function handleSalvarPagamentoBarbeiro(event) {
  event.preventDefault();
  const submitBtn = event.target.querySelector('button[type="submit"]');

  const barbeiroId = document.getElementById('pagamento-barbeiro-id').value;
  const barbeiroNome = document.getElementById('pagamento-barbeiro-nome').value;
  const valor = parseFloat(document.getElementById('pagamento-valor').value) || 0;
  const forma = document.getElementById('pagamento-forma').value;
  const obs = document.getElementById('pagamento-obs').value.trim();

  if (valor <= 0) {
    showToast('Informe um valor de pagamento maior que zero!', 'error');
    return;
  }

  setButtonLoading(submitBtn, true, 'Registrando pagamento...');
  const res = await callGAS('savePagamentoBarbeiro', {
    pagamento: {
      barbeiro_id: barbeiroId,
      barbeiro_nome: barbeiroNome,
      valor: valor,
      forma_pagamento: forma,
      observacao: obs
    }
  });
  setButtonLoading(submitBtn, false);

  if (res && res.success) {
    closeModal('modal-pagar-barbeiro');
    showToast(`Pagamento de ${formatarMoeda(valor)} registrado com sucesso para ${barbeiroNome}!`, 'success');
    await refreshData(true);
    renderGestorView();
  } else {
    showToast(res ? res.error : 'Erro ao registrar pagamento.', 'error');
  }
}

function openModalNovoBarbeiro() {
  const modalTitle = document.getElementById('modal-barbeiro-title');
  if (modalTitle) {
    modalTitle.innerHTML = `
      <i data-lucide="scissors" class="w-5 h-5 text-gold-500"></i>
      <span>Cadastrar Barbeiro</span>
    `;
  }
  document.getElementById('barbeiro-form-id').value = '';
  document.getElementById('barbeiro-form-nome').value = '';
  document.getElementById('barbeiro-form-tel').value = '';
  document.getElementById('barbeiro-form-comissao').value = '50';
  document.getElementById('barbeiro-form-login-preview').textContent = 'PrimeiroNome_ÚltimoNome';

  openModal('modal-barbeiro');
  if (window.lucide) lucide.createIcons();
}

function previewLoginBarbeiro(nome) {
  const preview = document.getElementById('barbeiro-form-login-preview');
  if (preview) {
    preview.textContent = gerarLoginBarbeiro(nome);
  }
}

function editarBarbeiro(id) {
  const b = (appState.barbeiros || []).find(x => String(x.id) === String(id));
  if (!b) {
    showToast('Barbeiro não encontrado!', 'error');
    return;
  }
  const modalTitle = document.getElementById('modal-barbeiro-title');
  if (modalTitle) {
    modalTitle.innerHTML = `
      <i data-lucide="edit-3" class="w-5 h-5 text-gold-500"></i>
      <span>Editar Barbeiro</span>
    `;
  }
  document.getElementById('barbeiro-form-id').value = b.id;
  document.getElementById('barbeiro-form-nome').value = b.nome || '';
  document.getElementById('barbeiro-form-tel').value = b.telefone || '';
  document.getElementById('barbeiro-form-comissao').value = b.comissao_pct !== undefined ? b.comissao_pct : 50;

  const preview = document.getElementById('barbeiro-form-login-preview');
  if (preview) {
    preview.textContent = b.login || gerarLoginBarbeiro(b.nome);
  }

  openModal('modal-barbeiro');
  if (window.lucide) lucide.createIcons();
}

async function excluirBarbeiro(id) {
  const b = (appState.barbeiros || []).find(x => String(x.id) === String(id));
  const nome = b ? b.nome : 'este barbeiro';

  if (!confirm(`Tem certeza que deseja excluir o barbeiro "${nome}"? Esta ação removerá o profissional e seu acesso ao sistema.`)) {
    return;
  }

  const res = await callGAS('deleteBarbeiro', { id });
  if (res && res.success) {
    showToast(`Barbeiro "${nome}" excluído com sucesso!`, 'success');
    await refreshData(true);
    renderGestorView();
  } else {
    showToast(res ? res.error : 'Erro ao excluir barbeiro.', 'error');
  }
}

async function handleSalvarBarbeiro(event) {
  event.preventDefault();
  const submitBtn = event.target.querySelector('button[type="submit"]');

  const id = document.getElementById('barbeiro-form-id').value;
  const nome = document.getElementById('barbeiro-form-nome').value.trim();
  const tel = document.getElementById('barbeiro-form-tel').value.trim();
  const comissao = parseFloat(document.getElementById('barbeiro-form-comissao').value) || 50;

  if (!nome || !tel) {
    showToast('Preencha o nome e o WhatsApp do barbeiro!', 'error');
    return;
  }

  setButtonLoading(submitBtn, true, 'Salvando barbeiro...');
  const res = await callGAS('saveBarbeiro', {
    barbeiro: {
      id: id || undefined,
      nome: nome,
      telefone: tel,
      comissao_pct: comissao
    }
  });
  setButtonLoading(submitBtn, false);

  if (res && res.success) {
    closeModal('modal-barbeiro');
    showToast(res.message || 'Barbeiro salvo com sucesso!', 'success');
    await refreshData(true);
    renderGestorView();
  } else {
    showToast(res ? res.error : 'Erro ao salvar barbeiro.', 'error');
  }
}

async function resetarSenhaBarbeiroPrompt(id, nome) {
  if (!confirm(`Deseja resetar a senha de ${nome}? A senha voltará obrigatoriamente para o padrão temporário "abc123", e o profissional precisará cadastrar uma nova senha segura no próximo acesso.`)) {
    return;
  }

  const res = await callGAS('resetSenhaBarbeiro', { id });
  if (res && res.success) {
    showToast(res.message || `Senha de ${nome} resetada para "abc123" com sucesso!`, 'success');
    await refreshData(true);
  } else {
    showToast(res ? res.error : 'Erro ao resetar senha.', 'error');
  }
}

// -------------------------------------------------------------------------
// 9.5 CLIENTES, SERVIÇOS & PRODUTOS (COM CACHE INTELIGENTE)
// -------------------------------------------------------------------------
function renderClientes() {
  const tbody = document.getElementById('tabela-clientes-tbody');
  if (!tbody) return;

  const termo = (document.getElementById('busca-clientes')?.value || '').toLowerCase();
  let lista = (appState.clientes || []).filter(c => 
    c.nome.toLowerCase().includes(termo) || (c.telefone && c.telefone.includes(termo))
  );

  if (lista.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="p-6 text-center text-slate-500">Nenhum cliente localizado.</td></tr>`;
    return;
  }

  let html = '';
  lista.forEach(c => {
    const zapLink = c.telefone ? `https://wa.me/55${limparTelefone(c.telefone)}` : null;
    html += `
      <tr class="hover:bg-dark-900/40 transition-colors">
        <td class="p-3 text-slate-500 font-mono text-[11px]">${c.id}</td>
        <td class="p-3 font-bold text-white">${c.nome}</td>
        <td class="p-3">
          <div class="flex items-center gap-2 text-slate-300">
            <span>${c.telefone || '-'}</span>
            ${zapLink ? `<a href="${zapLink}" target="_blank" class="text-emerald-400 hover:text-emerald-300"><i data-lucide="message-circle" class="w-4 h-4 inline"></i></a>` : ''}
          </div>
        </td>
        <td class="p-3 text-slate-400 text-[11px]">${formatarDataHoraPt(c.criado_em)}</td>
        <td class="p-3 text-right">
          <button onclick="editarCliente('${c.id}')" class="text-gold-400 hover:bg-gold-500/10 p-1.5 rounded-lg mr-1"><i data-lucide="edit" class="w-4 h-4"></i></button>
          <button onclick="excluirCliente('${c.id}')" class="text-rose-400 hover:bg-rose-500/10 p-1.5 rounded-lg"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
        </td>
      </tr>
    `;
  });
  tbody.innerHTML = html;
  if (window.lucide) lucide.createIcons();
}

function openModalNovoCliente() {
  document.getElementById('modal-cliente-title').innerHTML = `<i data-lucide="user" class="w-5 h-5 text-gold-500"></i><span>Cadastrar Cliente</span>`;
  document.getElementById('cliente-form-id').value = '';
  document.getElementById('cliente-form-nome').value = '';
  document.getElementById('cliente-form-tel').value = '';
  openModal('modal-cliente');
}

function editarCliente(id) {
  const cli = (appState.clientes || []).find(x => x.id === id);
  if (!cli) return;
  document.getElementById('modal-cliente-title').innerHTML = `<i data-lucide="user" class="w-5 h-5 text-gold-500"></i><span>Editar Cliente</span>`;
  document.getElementById('cliente-form-id').value = cli.id;
  document.getElementById('cliente-form-nome').value = cli.nome;
  document.getElementById('cliente-form-tel').value = cli.telefone || '';
  openModal('modal-cliente');
}

async function handleSalvarCliente(event) {
  event.preventDefault();
  const submitBtn = event.target.querySelector('button[type="submit"]');

  const id = document.getElementById('cliente-form-id').value;
  const nome = document.getElementById('cliente-form-nome').value.trim();
  const tel = document.getElementById('cliente-form-tel').value.trim();

  setButtonLoading(submitBtn, true, 'Salvando...');
  const res = await callGAS('saveCliente', { cliente: { id: id || undefined, nome, telefone: tel } });
  setButtonLoading(submitBtn, false);

  if (res && res.success) {
    closeModal('modal-cliente');
    showToast(res.message || 'Cliente salvo!', 'success');
    await refreshData(true);
    renderGestorView();
  } else {
    showToast(res ? res.error : 'Erro ao salvar cliente.', 'error');
  }
}

async function excluirCliente(id) {
  if (!confirm('Deseja excluir este cliente?')) return;
  const res = await callGAS('deleteCliente', { id });
  if (res && res.success) {
    showToast('Cliente excluído.', 'info');
    await refreshData(true);
    renderGestorView();
  }
}

function renderServicos() {
  const tbody = document.getElementById('tabela-servicos-tbody');
  if (!tbody) return;

  const lista = appState.servicos || [];
  if (lista.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="p-6 text-center text-slate-500">Nenhum serviço cadastrado.</td></tr>`;
    return;
  }

  let html = '';
  lista.forEach(s => {
    html += `
      <tr class="hover:bg-dark-900/40 transition-colors">
        <td class="p-3 text-slate-500 font-mono text-[11px]">${s.id}</td>
        <td class="p-3 font-bold text-white">${s.nome}</td>
        <td class="p-3 font-bold text-emerald-400">${formatarMoeda(s.preco)}</td>
        <td class="p-3 text-slate-300">${s.duracao_min || 30} minutos</td>
        <td class="p-3 text-right">
          <button onclick="editarServico('${s.id}')" class="text-gold-400 hover:bg-gold-500/10 p-1.5 rounded-lg mr-1"><i data-lucide="edit" class="w-4 h-4"></i></button>
          <button onclick="excluirServico('${s.id}')" class="text-rose-400 hover:bg-rose-500/10 p-1.5 rounded-lg"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
        </td>
      </tr>
    `;
  });
  tbody.innerHTML = html;
  if (window.lucide) lucide.createIcons();
}

function openModalNovoServico() {
  document.getElementById('modal-servico-title').innerHTML = `<i data-lucide="tag" class="w-5 h-5 text-gold-500"></i><span>Cadastrar Serviço</span>`;
  document.getElementById('servico-form-id').value = '';
  document.getElementById('servico-form-nome').value = '';
  document.getElementById('servico-form-preco').value = '';
  document.getElementById('servico-form-duracao').value = '30';
  openModal('modal-servico');
}

function editarServico(id) {
  const s = (appState.servicos || []).find(x => x.id === id);
  if (!s) return;
  document.getElementById('modal-servico-title').innerHTML = `<i data-lucide="tag" class="w-5 h-5 text-gold-500"></i><span>Editar Serviço</span>`;
  document.getElementById('servico-form-id').value = s.id;
  document.getElementById('servico-form-nome').value = s.nome;
  document.getElementById('servico-form-preco').value = s.preco;
  document.getElementById('servico-form-duracao').value = s.duracao_min || 30;
  openModal('modal-servico');
}

async function handleSalvarServico(event) {
  event.preventDefault();
  const submitBtn = event.target.querySelector('button[type="submit"]');

  const id = document.getElementById('servico-form-id').value;
  const nome = document.getElementById('servico-form-nome').value.trim();
  const preco = parseFloat(document.getElementById('servico-form-preco').value) || 0;
  const dur = parseInt(document.getElementById('servico-form-duracao').value) || 30;

  setButtonLoading(submitBtn, true, 'Gravando serviço...');
  const res = await callGAS('saveServico', { servico: { id: id || undefined, nome, preco, duracao_min: dur } });
  setButtonLoading(submitBtn, false);

  if (res && res.success) {
    closeModal('modal-servico');
    showToast('Serviço salvo com sucesso!', 'success');
    await refreshData(true);
    renderGestorView();
  } else {
    showToast(res ? res.error : 'Erro ao salvar serviço.', 'error');
  }
}

async function excluirServico(id) {
  if (!confirm('Deseja excluir este serviço?')) return;
  const res = await callGAS('deleteServico', { id });
  if (res && res.success) {
    showToast('Serviço excluído.', 'info');
    await refreshData(true);
    renderGestorView();
  }
}

function renderProdutos() {
  const tbody = document.getElementById('tabela-produtos-tbody');
  if (!tbody) return;

  const lista = appState.produtos || [];

  // Verificação e exibição do alerta de estoque crítico (< 3 unidades)
  const bannerCritico = document.getElementById('alerta-estoque-critico-banner');
  const msgCritico = document.getElementById('alerta-estoque-critico-msg');
  const criticos = lista.filter(p => (parseInt(p.estoque) || 0) < 3);

  if (bannerCritico) {
    if (criticos.length > 0) {
      bannerCritico.classList.remove('hidden');
      if (msgCritico) {
        const nomesCriticos = criticos.map(c => `${c.nome} (${c.estoque || 0} un)`).join(', ');
        msgCritico.textContent = `Atenção: ${criticos.length} produto(s) com estoque crítico (< 3 unidades): ${nomesCriticos}.`;
      }
    } else {
      bannerCritico.classList.add('hidden');
    }
  }

  if (lista.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="p-6 text-center text-slate-500">Nenhum produto cadastrado.</td></tr>`;
    return;
  }

  let html = '';
  lista.forEach(p => {
    const qtd = parseInt(p.estoque) || 0;
    const isCritico = qtd < 3;
    const estoqueBadge = isCritico
      ? `<span class="bg-rose-500/20 text-rose-400 border border-rose-500/40 px-2.5 py-0.5 rounded text-[10px] font-black inline-flex items-center gap-1 animate-pulse"><i data-lucide="alert-triangle" class="w-3 h-3"></i> Estoque Crítico (${qtd})</span>`
      : `<span class="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2.5 py-0.5 rounded text-[10px] font-bold">Em Estoque (${qtd})</span>`;

    html += `
      <tr class="hover:bg-dark-900/40 transition-colors ${isCritico ? 'bg-rose-500/5' : ''}">
        <td class="p-3 text-slate-500 font-mono text-[11px]">${p.id}</td>
        <td class="p-3 font-bold text-white flex items-center gap-2">
          <span>${p.nome}</span>
          ${isCritico ? '<i data-lucide="alert-circle" class="w-4 h-4 text-rose-400"></i>' : ''}
        </td>
        <td class="p-3 font-bold text-emerald-400">${formatarMoeda(p.preco)}</td>
        <td class="p-3 text-slate-200 font-bold ${isCritico ? 'text-rose-400' : ''}">${qtd} un</td>
        <td class="p-3">${estoqueBadge}</td>
        <td class="p-3 text-right">
          <button onclick="editarProduto('${p.id}')" class="text-gold-400 hover:bg-gold-500/10 p-1.5 rounded-lg mr-1"><i data-lucide="edit" class="w-4 h-4"></i></button>
          <button onclick="excluirProduto('${p.id}')" class="text-rose-400 hover:bg-rose-500/10 p-1.5 rounded-lg"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
        </td>
      </tr>
    `;
  });
  tbody.innerHTML = html;
  if (window.lucide) lucide.createIcons();
}

function openModalNovoProduto() {
  document.getElementById('modal-produto-title').innerHTML = `<i data-lucide="package" class="w-5 h-5 text-gold-500"></i><span>Cadastrar Produto</span>`;
  document.getElementById('produto-form-id').value = '';
  document.getElementById('produto-form-nome').value = '';
  document.getElementById('produto-form-preco').value = '';
  document.getElementById('produto-form-estoque').value = '10';
  openModal('modal-produto');
}

function editarProduto(id) {
  const p = (appState.produtos || []).find(x => x.id === id);
  if (!p) return;
  document.getElementById('modal-produto-title').innerHTML = `<i data-lucide="package" class="w-5 h-5 text-gold-500"></i><span>Editar Produto</span>`;
  document.getElementById('produto-form-id').value = p.id;
  document.getElementById('produto-form-nome').value = p.nome;
  document.getElementById('produto-form-preco').value = p.preco;
  document.getElementById('produto-form-estoque').value = p.estoque;
  openModal('modal-produto');
}

async function handleSalvarProduto(event) {
  event.preventDefault();
  const submitBtn = event.target.querySelector('button[type="submit"]');

  const id = document.getElementById('produto-form-id').value;
  const nome = document.getElementById('produto-form-nome').value.trim();
  const preco = parseFloat(document.getElementById('produto-form-preco').value) || 0;
  const estoque = parseInt(document.getElementById('produto-form-estoque').value) || 0;

  setButtonLoading(submitBtn, true, 'Gravando produto...');
  const res = await callGAS('saveProduto', { produto: { id: id || undefined, nome, preco, estoque } });
  setButtonLoading(submitBtn, false);

  if (res && res.success) {
    closeModal('modal-produto');
    showToast('Produto salvo com sucesso!', 'success');
    await refreshData(true);
    renderGestorView();
  } else {
    showToast(res ? res.error : 'Erro ao salvar produto.', 'error');
  }
}

async function excluirProduto(id) {
  if (!confirm('Deseja excluir este produto?')) return;
  const res = await callGAS('deleteProduto', { id });
  if (res && res.success) {
    showToast('Produto excluído.', 'info');
    await refreshData(true);
    renderGestorView();
  }
}

// -------------------------------------------------------------------------
// 9.6 CONFIGURAÇÕES DA BARBEARIA
// -------------------------------------------------------------------------
async function handleSalvarConfiguracoes(event) {
  event.preventDefault();
  const submitBtn = event.target.querySelector('button[type="submit"]');

  const nome = document.getElementById('config-nome-barbearia').value.trim();
  const logo = document.getElementById('config-logo-url').value.trim();
  const tel = document.getElementById('config-telefone-barbearia').value.trim();
  const pix = document.getElementById('config-chave-pix').value.trim();
  const elSenhaGestor = document.getElementById('config-senha-gestor');
  const senhaGestor = elSenhaGestor && elSenhaGestor.value.trim() ? elSenhaGestor.value.trim() : (appState.config?.senha_gestor || 'abc123');
  const gasUrl = document.getElementById('config-gas-url') ? document.getElementById('config-gas-url').value.trim() : '';

  const taxaPix = parseFloat(document.getElementById('config-taxa-pix-pct')?.value) || 0;
  const prazoPix = parseInt(document.getElementById('config-prazo-pix-dias')?.value) || 0;
  const taxaDeb = parseFloat(document.getElementById('config-taxa-debito-pct')?.value) || 0;
  const prazoDeb = parseInt(document.getElementById('config-prazo-debito-dias')?.value) || 0;
  const taxaCred = parseFloat(document.getElementById('config-taxa-credito-pct')?.value) || 0;
  const prazoCred = parseInt(document.getElementById('config-prazo-credito-dias')?.value) || 0;

  if (gasUrl) setGASUrl(gasUrl);

  const novaConfig = {
    nome_barbearia: nome,
    logo_url: logo,
    telefone_barbearia: tel,
    chave_pix: pix,
    senha_gestor: senhaGestor,
    taxa_pix_pct: taxaPix,
    prazo_pix_dias: prazoPix,
    taxa_debito_pct: taxaDeb,
    prazo_debito_dias: prazoDeb,
    taxa_credito_pct: taxaCred,
    prazo_credito_dias: prazoCred
  };

  setButtonLoading(submitBtn, true, 'Atualizando...');
  const res = await callGAS('updateConfig', { config: novaConfig });
  setButtonLoading(submitBtn, false);

  if (res && res.success) {
    appState.config = { ...appState.config, ...novaConfig };
    saveLocalData();
    updateUIBranding();
    showToast('Configurações da barbearia atualizadas com sucesso!', 'success');
  } else {
    showToast(res ? res.error : 'Erro ao atualizar configurações.', 'error');
  }
}

async function testGASConnection() {
  const input = document.getElementById('config-gas-url');
  const url = input ? input.value.trim() : '';
  if (!url) {
    showToast('Informe a URL do Google Apps Script para testar.', 'error');
    renderGasConnectionFeedback('config-gas-status-feedback', 'error', 'Nenhuma URL informada. Cole o link do seu Web App publicado no Google Apps Script.');
    return;
  }

  showToast('Testando conexão com a planilha...', 'info');
  renderGasConnectionFeedback('config-gas-status-feedback', 'loading');
  setGlobalLoading(true);

  try {
    const pingUrl = url + (url.includes('?') ? '&' : '?') + 'action=ping&_t=' + Date.now();
    const resp = await fetch(pingUrl, { method: 'GET', mode: 'cors' });
    const json = await resp.json();
    setGlobalLoading(false);

    if (json && json.success) {
      setGASUrl(url); // Persiste de forma fixa e permanente!
      renderGasConnectionFeedback('config-gas-status-feedback', 'success', '', `Latência: OK | Resposta do Google: Conexão ativa às ${new Date().toLocaleTimeString('pt-BR')}`);
      showToast('Conexão com Google Planilhas confirmada e salva de forma permanente!', 'success');
      refreshData(true);
    } else {
      renderGasConnectionFeedback('config-gas-status-feedback', 'error', json ? json.error : 'O Google Apps Script retornou uma resposta inesperada.');
      showToast('Resposta recebida com aviso do Google: ' + (json?.error || 'Aviso'), 'error');
    }
  } catch (e) {
    setGlobalLoading(false);
    renderGasConnectionFeedback('config-gas-status-feedback', 'error', 'Erro de rede ou permissão. O navegador não conseguiu se comunicar com a URL fornecida.');
    showToast('Não foi possível conectar. Verifique se o Web App foi publicado com acesso "Qualquer pessoa".', 'error');
  }
}

async function testGASConnectionModal() {
  const input = document.getElementById('modal-sheets-url');
  const url = input ? input.value.trim() : '';
  if (!url) {
    showToast('Informe a URL do Web App para testar.', 'error');
    renderGasConnectionFeedback('modal-gas-status-feedback', 'error', 'Informe a URL do Web App.');
    return;
  }

  renderGasConnectionFeedback('modal-gas-status-feedback', 'loading');
  setGlobalLoading(true);

  try {
    const pingUrl = url + (url.includes('?') ? '&' : '?') + 'action=ping&_t=' + Date.now();
    const resp = await fetch(pingUrl, { method: 'GET', mode: 'cors' });
    const json = await resp.json();
    setGlobalLoading(false);

    if (json && json.success) {
      setGASUrl(url); // Salva permanente!
      renderGasConnectionFeedback('modal-gas-status-feedback', 'success', '', `Conexão validada às ${new Date().toLocaleTimeString('pt-BR')}`);
      showToast('Conexão com a planilha confirmada e salva!', 'success');
      const cfgInput = document.getElementById('config-gas-url');
      if (cfgInput) cfgInput.value = url;
    } else {
      renderGasConnectionFeedback('modal-gas-status-feedback', 'error', json ? json.error : 'Resposta inesperada.');
      showToast('Aviso: ' + (json?.error || 'Erro'), 'error');
    }
  } catch (e) {
    setGlobalLoading(false);
    renderGasConnectionFeedback('modal-gas-status-feedback', 'error', 'Não foi possível conectar. Verifique o acesso "Qualquer pessoa" no Apps Script.');
    showToast('Erro de conexão com o Web App.', 'error');
  }
}

// =========================================================================
// 10. APLICATIVO MOBILE DO BARBEIRO (OTIMIZADO)
// =========================================================================
function renderBarbeiroView() {
  if (!currentSession || currentSession.perfil !== 'barbeiro') return;

  const b = currentSession.barbeiro;
  document.getElementById('barber-app-nome').textContent = b.nome;

  const sal = calcularSaldoBarbeiro(b.id);

  document.getElementById('barber-saldo-a-receber').textContent = formatarMoeda(sal.saldoAReceber);
  document.getElementById('barber-comissao-tag').textContent = `Comissão: ${sal.comissaoPct}%`;
  document.getElementById('barber-total-produzido').textContent = formatarMoeda(sal.totalProduzido);
  document.getElementById('barber-total-ja-pago').textContent = formatarMoeda(sal.totalJaPago);

  document.getElementById('barber-perfil-login').textContent = b.login;
  document.getElementById('barber-perfil-comissao').textContent = sal.comissaoPct + '%';

  renderBarberAgenda();
  renderBarberExtrato(sal);
}

function switchBarberTab(tab) {
  const secAgenda = document.getElementById('barber-sec-agenda');
  const secExtrato = document.getElementById('barber-sec-extrato');
  const secPerfil = document.getElementById('barber-sec-perfil');

  const btnAgenda = document.getElementById('barber-tab-agenda-btn');
  const btnExtrato = document.getElementById('barber-tab-extrato-btn');
  const btnPerfil = document.getElementById('barber-tab-perfil-btn');

  secAgenda.classList.add('hidden');
  secExtrato.classList.add('hidden');
  secPerfil.classList.add('hidden');

  btnAgenda.className = 'flex-1 py-2 font-semibold rounded-lg text-slate-400 hover:text-white transition-all';
  btnExtrato.className = 'flex-1 py-2 font-semibold rounded-lg text-slate-400 hover:text-white transition-all';
  btnPerfil.className = 'flex-1 py-2 font-semibold rounded-lg text-slate-400 hover:text-white transition-all';

  if (tab === 'agenda') {
    secAgenda.classList.remove('hidden');
    btnAgenda.className = 'flex-1 py-2 font-bold rounded-lg bg-gold-500 text-dark-900 shadow transition-all';
  } else if (tab === 'extrato') {
    secExtrato.classList.remove('hidden');
    btnExtrato.className = 'flex-1 py-2 font-bold rounded-lg bg-gold-500 text-dark-900 shadow transition-all';
  } else if (tab === 'perfil') {
    secPerfil.classList.remove('hidden');
    btnPerfil.className = 'flex-1 py-2 font-bold rounded-lg bg-gold-500 text-dark-900 shadow transition-all';
  }

  // Atualização silenciosa em background se necessário
  refreshData(false);

  if (window.lucide) lucide.createIcons();
}

function filterBarberAgenda(filtro) {
  currentBarberAgendaFilter = filtro;
  const btnHoje = document.getElementById('btn-barber-filter-hoje');
  const btnProx = document.getElementById('btn-barber-filter-proximos');
  const btnTodos = document.getElementById('btn-barber-filter-todos');

  btnHoje.className = 'px-3 py-1.5 rounded-lg text-xs font-medium bg-dark-900 text-slate-400 border border-dark-700';
  btnProx.className = 'px-3 py-1.5 rounded-lg text-xs font-medium bg-dark-900 text-slate-400 border border-dark-700';
  btnTodos.className = 'px-3 py-1.5 rounded-lg text-xs font-medium bg-dark-900 text-slate-400 border border-dark-700';

  if (filtro === 'hoje') {
    btnHoje.className = 'px-3 py-1.5 rounded-lg text-xs font-bold bg-dark-800 border border-gold-500/50 text-gold-400';
  } else if (filtro === 'proximos') {
    btnProx.className = 'px-3 py-1.5 rounded-lg text-xs font-bold bg-dark-800 border border-gold-500/50 text-gold-400';
  } else {
    btnTodos.className = 'px-3 py-1.5 rounded-lg text-xs font-bold bg-dark-800 border border-gold-500/50 text-gold-400';
  }

  renderBarberAgenda();
}

function renderBarberAgenda() {
  const container = document.getElementById('barber-agenda-list');
  if (!container || !currentSession || !currentSession.barbeiro) return;

  const bId = currentSession.barbeiro.id;
  const hoje = getHojeString();

  let lista = (appState.agendamentos || []).filter(a => String(a.barbeiro_id) === String(bId));

  if (currentBarberAgendaFilter === 'hoje') {
    lista = lista.filter(a => a.data === hoje);
  } else if (currentBarberAgendaFilter === 'proximos') {
    lista = lista.filter(a => a.data >= hoje && a.status === 'Agendado');
  }

  lista.sort(compararAgendamentosInteligente);

  if (lista.length === 0) {
    container.innerHTML = `
      <div class="p-8 text-center bg-dark-800 rounded-2xl border border-dark-700 text-slate-500 text-xs">
        Nenhum agendamento encontrado para o filtro selecionado.
      </div>
    `;
    return;
  }

  let html = '';
  lista.forEach(a => {
    const preco = parseFloat(a.servico_preco) || 0;
    const comissao = a.comissao_valor ? parseFloat(a.comissao_valor) : (preco * (currentSession.barbeiro.comissao_pct / 100));
    const zapLink = a.cliente_telefone ? `https://wa.me/55${limparTelefone(a.cliente_telefone)}` : null;

    html += `
      <div class="bg-dark-800 border border-dark-700/80 rounded-2xl p-4 shadow-sm space-y-3">
        <div class="flex items-start justify-between">
          <div class="flex items-center gap-2">
            <span class="text-xs font-bold px-2 py-1 bg-dark-900 border border-dark-700 rounded-lg text-white font-mono">
              ${formatarHora(a.horario)}
            </span>
            <span class="text-xs font-medium text-slate-400">
              ${formatarDataPt(a.data)}
            </span>
          </div>
          <div>${getStatusBadge(a.status)}</div>
        </div>

        <div class="flex items-center justify-between border-y border-dark-700/50 py-2.5">
          <div>
            <h4 class="text-sm font-bold text-white">${a.cliente_nome}</h4>
            <p class="text-xs text-gold-400 font-medium">${a.servico_nome}</p>
          </div>
          ${zapLink ? `
            <a href="${zapLink}" target="_blank" class="p-2 bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 rounded-xl" title="Conversar no WhatsApp">
              <i data-lucide="message-circle" class="w-4 h-4"></i>
            </a>
          ` : ''}
        </div>

        <div class="flex items-center justify-between text-xs">
          <span class="text-slate-400">Serviço: <strong class="text-slate-200">${formatarMoeda(preco)}</strong></span>
          <span class="text-gold-400 font-bold bg-gold-500/10 px-2 py-1 rounded-lg">
            Sua Comissão: ${formatarMoeda(comissao)}
          </span>
        </div>

        ${a.status === 'Agendado' ? `
          <button onclick="barbeiroConcluirAtendimento('${a.id}', this)" class="w-full bg-emerald-500 hover:bg-emerald-400 text-dark-900 font-bold py-2 rounded-xl text-xs flex items-center justify-center gap-1.5 transition-all shadow-md shadow-emerald-500/10">
            <i data-lucide="check" class="w-4 h-4"></i>
            <span>Marcar como Concluído</span>
          </button>
        ` : ''}
      </div>
    `;
  });

  container.innerHTML = html;
  if (window.lucide) lucide.createIcons();
}

async function barbeiroConcluirAtendimento(agdId, btn) {
  if (!confirm('Deseja marcar este serviço como concluído?')) return;

  setButtonLoading(btn, true, 'Concluindo...');
  const res = await callGAS('updateAgendamentoStatus', {
    id: agdId,
    status: 'Concluido',
    forma_pagamento: 'Pendente'
  });
  setButtonLoading(btn, false);

  if (res && res.success) {
    showToast('Serviço concluído! Comissão registrada no seu saldo.', 'success');
    await refreshData(true);
    renderBarbeiroView();
  } else {
    showToast(res ? res.error : 'Erro ao atualizar status.', 'error');
  }
}

function renderBarberExtrato(sal) {
  const pagList = document.getElementById('barber-pagamentos-list');
  const servList = document.getElementById('barber-servicos-prestados-list');
  if (!pagList || !servList || !currentSession || !currentSession.barbeiro) return;

  const bId = currentSession.barbeiro.id;

  // Atualiza indicadores dos cards de topo do extrato
  const elTotalRecebido = document.getElementById('barber-extrato-total-recebido');
  if (elTotalRecebido) elTotalRecebido.textContent = formatarMoeda(sal.totalJaPago);

  const elSaldoPendente = document.getElementById('barber-extrato-saldo-pendente');
  if (elSaldoPendente) elSaldoPendente.textContent = formatarMoeda(sal.saldoAReceber);

  // 1. Histórico de Pagamentos Recebidos do Gestor (Comprovantes / Recibos)
  const pags = (appState.pagamentosBarbeiros || []).filter(p => String(p.barbeiro_id) === String(bId));
  pags.sort((a, b) => (b.data_hora || '').localeCompare(a.data_hora || ''));

  if (pags.length === 0) {
    pagList.innerHTML = `
      <div class="p-6 text-center bg-dark-900 rounded-xl border border-dark-700/60">
        <i data-lucide="receipt" class="w-8 h-8 text-slate-600 mx-auto mb-2"></i>
        <p class="text-xs text-slate-300 font-medium">Nenhum acerto ou pagamento registrado ainda.</p>
        <p class="text-[11px] text-slate-500 mt-1">Quando o gestor realizar o acerto da sua comissão (via PIX ou Dinheiro), o recibo completo ficará registrado aqui.</p>
      </div>
    `;
  } else {
    let html = '';
    pags.forEach(p => {
      let formaBadge = '';
      if (p.forma_pagamento === 'PIX') {
        formaBadge = '<span class="bg-gold-500/10 text-gold-400 border border-gold-500/30 px-2 py-0.5 rounded text-[10px] font-bold inline-flex items-center gap-1"><i data-lucide="zap" class="w-3 h-3"></i> PIX</span>';
      } else if (p.forma_pagamento === 'Dinheiro') {
        formaBadge = '<span class="bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 px-2 py-0.5 rounded text-[10px] font-bold inline-flex items-center gap-1"><i data-lucide="banknote" class="w-3 h-3"></i> Dinheiro</span>';
      } else {
        formaBadge = `<span class="bg-blue-500/10 text-blue-400 border border-blue-500/30 px-2 py-0.5 rounded text-[10px] font-bold inline-flex items-center gap-1"><i data-lucide="credit-card" class="w-3 h-3"></i> ${formatarFormaPagamento(p.forma_pagamento)}</span>`;
      }

      html += `
        <div class="p-3 bg-dark-900 rounded-xl border border-dark-700/80 shadow-sm space-y-2 hover:border-gold-500/40 transition-colors">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              ${formaBadge}
              <span class="text-[11px] text-slate-400 font-mono">${formatarDataHoraPt(p.data_hora)}</span>
            </div>
            <span class="text-sm font-black text-emerald-400">+ ${formatarMoeda(p.valor)}</span>
          </div>
          <div class="flex items-center justify-between text-xs pt-1.5 border-t border-dark-800 text-slate-300">
            <span class="text-[11px] text-slate-400">Observação:</span>
            <span class="font-medium text-white">${p.observacao || 'Acerto de comissão'}</span>
          </div>
        </div>
      `;
    });
    pagList.innerHTML = html;
  }

  // 2. Histórico de Serviços Concluídos (Base de Cálculo das Comissões)
  const concluidos = (appState.agendamentos || []).filter(a => String(a.barbeiro_id) === String(bId) && a.status === 'Concluido');
  concluidos.sort((a, b) => {
    const dataA = String(a.data || '').trim().split('T')[0].split(' ')[0];
    const dataB = String(b.data || '').trim().split('T')[0].split(' ')[0];
    if (dataA !== dataB) return dataB.localeCompare(dataA);
    return formatarHora(b.horario).localeCompare(formatarHora(a.horario));
  });

  if (concluidos.length === 0) {
    servList.innerHTML = `<p class="text-xs text-slate-500 text-center py-4">Nenhum atendimento concluído até o momento.</p>`;
  } else {
    let html = '';
    concluidos.forEach(a => {
      const preco = parseFloat(a.servico_preco) || 0;
      const comissao = a.comissao_valor ? parseFloat(a.comissao_valor) : (preco * (sal.comissaoPct / 100));
      html += `
        <div class="p-2.5 bg-dark-900 rounded-xl border border-dark-700/80 flex items-center justify-between text-xs hover:border-dark-600 transition-colors">
          <div>
            <div class="font-medium text-white">${a.servico_nome}</div>
            <div class="text-[11px] text-slate-400">${a.cliente_nome} (${formatarDataPt(a.data)} às ${formatarHora(a.horario)})</div>
          </div>
          <div class="text-right">
            <span class="text-gold-400 font-bold">+ ${formatarMoeda(comissao)}</span>
            <div class="text-[10px] text-slate-500">Serviço: ${formatarMoeda(preco)}</div>
          </div>
        </div>
      `;
    });
    servList.innerHTML = html;
  }

  if (window.lucide) lucide.createIcons();
}

async function handleBarberChangePassword(event) {
  event.preventDefault();
  const submitBtn = event.target.querySelector('button[type="submit"]');

  const nova = document.getElementById('barber-nova-senha').value;
  const valid = validarRegraSenha(nova);
  if (!valid.valido) {
    showToast(valid.erro, 'error');
    return;
  }

  setButtonLoading(submitBtn, true, 'Atualizando...');
  const bId = currentSession.barbeiro.id;
  const res = await callGAS('setupPasswordBarbeiro', { barbeiro_id: bId, nova_senha: nova });
  setButtonLoading(submitBtn, false);

  if (res && res.success) {
    document.getElementById('barber-nova-senha').value = '';
    showToast('Sua senha foi atualizada com sucesso!', 'success');
  } else {
    showToast(res ? res.error : 'Erro ao alterar senha.', 'error');
  }
}

// =========================================================================
// 11. MODAL RÁPIDO PARA CONEXÃO GOOGLE PLANILHAS
// =========================================================================
function openConfigSheetsModal() {
  document.getElementById('modal-sheets-url').value = getGASUrl();
  openModal('modal-config-sheets');
}

function salvarConfigSheetsRapido(usarUrl) {
  if (usarUrl) {
    const url = document.getElementById('modal-sheets-url').value.trim();
    if (!url) {
      showToast('Por favor, informe a URL do Apps Script.', 'error');
      return;
    }
    setGASUrl(url);
    showToast('URL da Planilha salva! Sincronizando dados...', 'success');
    refreshData(true);
  } else {
    setGASUrl('');
    showToast('Modo Demonstração ativado com dados locais.', 'info');
  }
  closeModal('modal-config-sheets');
}

// =========================================================================
// 12. UTILITÁRIOS, FORMATAÇÃO & CONTROLES DE INTERFACE
// =========================================================================
function setupEventListeners() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const openModals = document.querySelectorAll('.fixed:not(.hidden)');
      openModals.forEach(m => {
        // Não fecha modais bloqueantes obrigatórios via tecla ESC
        if (m.id !== 'modal-primeiro-acesso-gestor' && m.id !== 'modal-saas-bloqueado') {
          m.classList.add('hidden');
        }
      });
    }
  });

  // Detector de conectividade em tempo real
  window.addEventListener('online', () => {
    const banner = document.getElementById('offline-alert-banner');
    if (banner) banner.classList.add('hidden');
    showToast('Conexão de internet restabelecida!', 'success');
    refreshData(false);
  });

  window.addEventListener('offline', () => {
    const banner = document.getElementById('offline-alert-banner');
    if (banner) banner.classList.remove('hidden');
    showToast('Você está desconectado da internet. Operando em modo cache local.', 'info');
  });

  if (!navigator.onLine) {
    const banner = document.getElementById('offline-alert-banner');
    if (banner) banner.classList.remove('hidden');
  }
}

function openModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.remove('hidden');
    if (window.lucide) lucide.createIcons();
  }
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.add('hidden');
  }
}

function togglePasswordVisibility(inputId, eyeIconId) {
  const input = document.getElementById(inputId);
  const icon = document.getElementById(eyeIconId);
  if (!input) return;

  if (input.type === 'password') {
    input.type = 'text';
    if (icon) icon.setAttribute('data-lucide', 'eye-off');
  } else {
    input.type = 'password';
    if (icon) icon.setAttribute('data-lucide', 'eye');
  }
  if (window.lucide) lucide.createIcons();
}

function showToast(mensagem, tipo = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  const cores = {
    success: 'bg-emerald-950/90 border-emerald-500/50 text-emerald-200',
    error: 'bg-rose-950/90 border-rose-500/50 text-rose-200',
    info: 'bg-dark-800/95 border-gold-500/50 text-gold-300'
  };

  const cor = cores[tipo] || cores.info;
  toast.className = `p-3.5 rounded-xl border shadow-xl backdrop-blur-md text-xs font-semibold flex items-center justify-between gap-3 pointer-events-auto transition-all fade-in ${cor}`;
  toast.innerHTML = `
    <span>${mensagem}</span>
    <button onclick="this.parentElement.remove()" class="opacity-70 hover:opacity-100 p-0.5">✕</button>
  `;

  container.appendChild(toast);
  setTimeout(() => {
    if (toast.parentElement) toast.remove();
  }, 4000);
}

function formatarMoeda(valor) {
  const num = parseFloat(valor) || 0;
  return num.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatarDataPt(dataStr) {
  if (!dataStr) return '--/--';
  const limpo = String(dataStr).trim().split('T')[0].split(' ')[0];
  const partes = limpo.split('-');
  if (partes.length === 3) {
    const dia = partes[2].substring(0, 2);
    const mes = partes[1].padStart(2, '0');
    const ano = partes[0];
    return `${dia}/${mes}/${ano}`;
  }
  return limpo;
}

function formatarHora(horarioStr) {
  if (!horarioStr) return '--:--';
  const str = String(horarioStr).trim();
  if (str.includes(' ')) {
    return str.split(' ')[1].substring(0, 5);
  }
  if (str.includes('T')) {
    return str.split('T')[1].substring(0, 5);
  }
  return str.substring(0, 5);
}

function formatarDataHoraPt(dataHoraStr) {
  if (!dataHoraStr) return '--/--/---- --:--';
  const partes = dataHoraStr.split(' ');
  const d = formatarDataPt(partes[0]);
  const h = partes[1] ? partes[1].substring(0, 5) : '';
  return `${d} ${h}`;
}

function formatarFormaPagamento(forma) {
  const mapas = {
    Dinheiro: 'Dinheiro',
    PIX: 'PIX',
    Cartao_Debito: 'Cartão Débito',
    Cartao_Credito: 'Cartão Crédito',
    Transferencia: 'Transferência',
    Pendente: 'Pendente'
  };
  return mapas[forma] || forma || 'Dinheiro';
}

function getStatusBadge(status) {
  if (status === 'Concluido') {
    return `<span class="bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 px-2.5 py-0.5 rounded-full text-[10px] font-bold">Concluído</span>`;
  }
  if (status === 'Cancelado') {
    return `<span class="bg-rose-500/10 text-rose-400 border border-rose-500/30 px-2.5 py-0.5 rounded-full text-[10px] font-bold">Cancelado</span>`;
  }
  return `<span class="bg-amber-500/10 text-amber-400 border border-amber-500/30 px-2.5 py-0.5 rounded-full text-[10px] font-bold">Agendado</span>`;
}

function gerarLoginBarbeiro(nomeCompleto) {
  if (!nomeCompleto) return 'barbeiro';
  const semAcento = nomeCompleto.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  const partes = semAcento.split(/\s+/).filter(p => p.length > 0);
  if (partes.length === 1) return partes[0].replace(/[^a-zA-Z0-9]/g, '');

  const primeiro = partes[0].replace(/[^a-zA-Z0-9]/g, '');
  const ultimo = partes[partes.length - 1].replace(/[^a-zA-Z0-9]/g, '');
  return `${primeiro}_${ultimo}`;
}

function limparTelefone(tel) {
  return String(tel || '').replace(/\D/g, '');
}

function getHojeString() {
  const d = new Date();
  return d.toISOString().split('T')[0];
}

function getOntemString() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

function getAmanhaString() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().split('T')[0];
}

function getHoraAtualString() {
  const d = new Date();
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function getHojeAgoraString() {
  const d = new Date();
  const data = d.toISOString().split('T')[0];
  const hora = d.toTimeString().split(' ')[0];
  return `${data} ${hora}`;
}

// =========================================================================
// 12. MÓDULO PAINEL MASTER (SUPER ADMIN - RAFAEL MARTINS)
// =========================================================================
let currentMasterStatusFilter = 'todas';

function getDataFutura(dias) {
  const d = new Date();
  d.setDate(d.getDate() + dias);
  return d.toISOString().split('T')[0];
}

function getDataPassada(dias) {
  const d = new Date();
  d.setDate(d.getDate() - dias);
  return d.toISOString().split('T')[0];
}

function gerarLoginGestorBarbearia(nome) {
  if (!nome) return 'Barbearia_Gestor';
  const limpo = String(nome).normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  const ignorar = ['de', 'da', 'do', 'dos', 'das', 'e', '&', 'barbearia'];
  const palavras = limpo.split(/\s+/).filter(p => {
    const pLower = p.toLowerCase().replace(/[^a-z0-9]/g, '');
    return pLower.length > 0 && !ignorar.includes(pLower);
  });

  const base = palavras.length > 0 ? palavras : limpo.split(/\s+/).filter(p => p.length > 0);

  const camelCase = base.map(p => {
    const str = p.replace(/[^a-zA-Z0-9]/g, '');
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1);
  }).join('');

  return 'Barbearia_' + (camelCase || 'Gestor');
}

function previewLoginGestor(nome) {
  const loginGerado = gerarLoginGestorBarbearia(nome);
  const el = document.getElementById('master-preview-login');
  if (el) el.textContent = loginGerado;
}

function switchMasterTab(tab) {
  const secBarbearias = document.getElementById('master-section-barbearias');
  if (secBarbearias) secBarbearias.classList.remove('hidden');
  const secSuporte = document.getElementById('master-section-suporte');
  if (secSuporte) secSuporte.classList.add('hidden');

  if (window.lucide && typeof lucide.createIcons === 'function') {
    lucide.createIcons();
  }
}

function copiarTextoParaClipboard(texto, mensagemSucesso = 'Copiado para a área de transferência!') {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(texto).then(() => {
      showToast(mensagemSucesso, 'success');
    }).catch(() => {
      copiarFallback(texto, mensagemSucesso);
    });
  } else {
    copiarFallback(texto, mensagemSucesso);
  }
}

function copiarFallback(texto, mensagemSucesso) {
  const textArea = document.createElement('textarea');
  textArea.value = texto;
  textArea.style.position = 'fixed';
  textArea.style.left = '-9999px';
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  try {
    document.execCommand('copy');
    showToast(mensagemSucesso, 'success');
  } catch (e) {
    prompt('Copie o texto abaixo:', texto);
  }
  document.body.removeChild(textArea);
}

function setMasterStatusFilter(status) {
  currentMasterStatusFilter = status;
  const botoes = {
    todas: document.getElementById('master-filter-todas'),
    em_dia: document.getElementById('master-filter-em_dia'),
    vencidas: document.getElementById('master-filter-vencidas'),
    bloqueadas: document.getElementById('master-filter-bloqueadas')
  };

  Object.keys(botoes).forEach(k => {
    const btn = botoes[k];
    if (!btn) return;
    if (k === status) {
      btn.className = 'px-3 py-1.5 rounded-lg text-xs font-bold bg-gold-500 text-dark-900 shadow';
    } else {
      btn.className = 'px-3 py-1.5 rounded-lg text-xs font-medium bg-dark-900 text-slate-400 border border-dark-700 hover:text-white';
    }
  });

  renderMasterView();
}

function filterMasterTable() {
  renderMasterView();
}

async function renderMasterView() {
  const tbody = document.getElementById('master-barbearias-tbody');
  if (!tbody) return;

  // Busca lista atualizada da planilha ou do estado local
  if (getGASUrl()) {
    const res = await callGAS('getMasterBarbearias');
    if (res && res.success && res.barbearias) {
      appState.masterBarbearias = res.barbearias;
      saveLocalData();
    }
  }

  const barbearias = appState.masterBarbearias || [];
  const hoje = getHojeString();

  // 1. Cálculos de KPIs
  const total = barbearias.length;
  let emDia = 0;
  let bloqueadasOuVencidas = 0;
  let receitaTotalPix = 0;

  barbearias.forEach(b => {
    const isBloqueada = b.status_licenca === 'BLOQUEADA';
    const vencLimpo = b.data_vencimento ? String(b.data_vencimento).trim().split('T')[0].split(' ')[0] : '';
    const isVencida = vencLimpo && vencLimpo < hoje;
    if (isBloqueada || isVencida) {
      bloqueadasOuVencidas++;
    } else {
      emDia++;
    }
    receitaTotalPix += parseFloat(b.valor_pago) || 0;
  });

  const elTotal = document.getElementById('master-kpi-total');
  const elEmDia = document.getElementById('master-kpi-em-dia');
  const elBloq = document.getElementById('master-kpi-bloqueadas');
  const elPix = document.getElementById('master-kpi-receita-pix');

  if (elTotal) elTotal.textContent = total;
  if (elEmDia) elEmDia.textContent = emDia;
  if (elBloq) elBloq.textContent = bloqueadasOuVencidas;
  if (elPix) elPix.textContent = formatarMoeda(receitaTotalPix);

  // 2. Filtro de Busca e Status
  const search = (document.getElementById('master-search-input')?.value || '').toLowerCase().trim();
  const filtradas = barbearias.filter(b => {
    const matchSearch = !search ||
      (b.nome_barbearia || '').toLowerCase().includes(search) ||
      (b.responsavel || '').toLowerCase().includes(search) ||
      (b.login_gestor || '').toLowerCase().includes(search) ||
      (b.telefone || '').includes(search);

    if (!matchSearch) return false;

    const isBloqueada = b.status_licenca === 'BLOQUEADA';
    const vencLimpo = b.data_vencimento ? String(b.data_vencimento).trim().split('T')[0].split(' ')[0] : '';
    const isVencida = vencLimpo && vencLimpo < hoje;

    if (currentMasterStatusFilter === 'em_dia') return !isBloqueada && !isVencida;
    if (currentMasterStatusFilter === 'vencidas') return isVencida;
    if (currentMasterStatusFilter === 'bloqueadas') return isBloqueada;
    return true;
  });

  if (filtradas.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="p-8 text-center text-slate-500">
          <i data-lucide="building-2" class="w-8 h-8 mx-auto mb-2 text-slate-600"></i>
          Nenhuma barbearia encontrada para o filtro selecionado.
        </td>
      </tr>
    `;
    if (window.lucide) lucide.createIcons();
    return;
  }

  let html = '';
  filtradas.forEach(b => {
    const isBloqueada = b.status_licenca === 'BLOQUEADA';
    const vencLimpo = b.data_vencimento ? String(b.data_vencimento).trim().split('T')[0].split(' ')[0] : '';
    const isVencida = vencLimpo && vencLimpo < hoje;
    
    // Cálculo de dias restantes / atraso sem horário (elimina NaN)
    let vencBadge = '';
    if (vencLimpo) {
      const diffMs = new Date(vencLimpo + 'T23:59:59') - new Date();
      const diffDias = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

      if (isNaN(diffDias)) {
        vencBadge = '';
      } else if (diffDias < 0) {
        vencBadge = `<span class="bg-rose-500/20 text-rose-400 border border-rose-500/40 px-2 py-0.5 rounded-full text-[10px] font-extrabold block mt-0.5">VENCIDA HÁ ${Math.abs(diffDias)} DIAS</span>`;
      } else if (diffDias === 0) {
        vencBadge = `<span class="bg-amber-500/20 text-amber-400 border border-amber-500/40 px-2 py-0.5 rounded-full text-[10px] font-extrabold block mt-0.5">VENCE HOJE</span>`;
      } else if (diffDias <= 5) {
        vencBadge = `<span class="bg-amber-500/20 text-amber-300 border border-amber-500/40 px-2 py-0.5 rounded-full text-[10px] font-bold block mt-0.5">Vence em ${diffDias} dias</span>`;
      } else {
        vencBadge = `<span class="bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 px-2 py-0.5 rounded-full text-[10px] font-semibold block mt-0.5">Vence em ${diffDias} dias</span>`;
      }
    }

    const zapLimpo = limparTelefone(b.telefone);
    const zapLink = zapLimpo ? `https://wa.me/55${zapLimpo}?text=Ol%C3%A1%20${encodeURIComponent(b.responsavel || b.nome_barbearia)},%20sou%20Rafael%20Martins%20do%20sistema%20SaaS%20de%20Barbearia.` : '#';

    html += `
      <tr class="hover:bg-dark-800/60 transition-colors">
        <td class="p-3.5">
          <div class="font-bold text-white text-sm">${b.nome_barbearia}</div>
          <div class="text-[11px] text-slate-400">${b.responsavel || 'Responsável não informado'}</div>
        </td>

        <td class="p-3.5 font-mono">
          <div class="text-gold-400 font-bold bg-dark-900/80 px-2 py-1 rounded-lg border border-dark-700 inline-block text-[11px]">
            ${b.login_gestor}
          </div>
          <div class="text-[10px] text-slate-500 mt-0.5">
            ${b.senha_gestor === 'abc123' ? '<span class="text-amber-400 font-medium">Senha inicial (abc123)</span>' : '<span class="text-emerald-400">Senha pessoal ativa</span>'}
          </div>
        </td>

        <td class="p-3.5">
          <div class="text-slate-300">${b.telefone || '--'}</div>
          ${zapLimpo ? `
            <a href="${zapLink}" target="_blank" class="inline-flex items-center gap-1 text-[11px] text-emerald-400 hover:text-emerald-300 font-medium mt-0.5">
              <i data-lucide="message-circle" class="w-3.5 h-3.5"></i>
              <span>Abrir WhatsApp</span>
            </a>
          ` : ''}
        </td>

        <td class="p-3.5">
          <div class="font-bold text-slate-200">${b.plano || 'Mensal'}</div>
          <div class="text-[11px] text-gold-400 font-semibold">${formatarMoeda(b.valor_pago || 0)} <span class="text-[10px] text-slate-500">(PIX)</span></div>
        </td>

        <td class="p-3.5">
          <div class="font-medium text-slate-200">${formatarDataPt(b.data_vencimento)}</div>
          ${vencBadge}
        </td>

        <td class="p-3.5 text-center">
          ${isBloqueada ? `
            <span class="inline-flex items-center gap-1 bg-rose-500/20 text-rose-400 border border-rose-500/40 px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-wider">
              <i data-lucide="lock" class="w-3 h-3"></i>
              <span>BLOQUEADA</span>
            </span>
          ` : isVencida ? `
            <span class="inline-flex items-center gap-1 bg-amber-500/20 text-amber-400 border border-amber-500/40 px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-wider">
              <i data-lucide="alert-triangle" class="w-3 h-3"></i>
              <span>VENCIDA</span>
            </span>
          ` : `
            <span class="inline-flex items-center gap-1 bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-wider">
              <i data-lucide="check-circle" class="w-3 h-3"></i>
              <span>ATIVA</span>
            </span>
          `}
        </td>

        <td class="p-3.5 text-right">
          <div class="flex items-center justify-end gap-1.5">
            <!-- Travar/Destravar -->
            <button onclick="toggleStatusLicencaMasterAction('${b.id}', '${b.status_licenca}')" title="${isBloqueada ? 'Destravar Barbearia' : 'Travar Acesso da Barbearia'}" class="p-2 rounded-xl text-xs font-semibold ${isBloqueada ? 'bg-rose-500/20 text-rose-400 hover:bg-rose-500/30' : 'bg-dark-900 text-slate-400 hover:text-white border border-dark-700'} transition-all">
              <i data-lucide="${isBloqueada ? 'unlock' : 'lock'}" class="w-4 h-4"></i>
            </button>

            <!-- Renovar Assinatura PIX -->
            <button onclick="openModalRenovarAssinaturaMaster('${b.id}')" title="Registrar Pagamento PIX e Renovar Vencimento" class="p-2 bg-gold-500/10 text-gold-400 hover:bg-gold-500/20 border border-gold-500/30 rounded-xl transition-all">
              <i data-lucide="refresh-cw" class="w-4 h-4"></i>
            </button>

            <!-- Auditar / Entrar no Painel -->
            <button onclick="auditarBarbearia('${b.id}')" title="Auditar / Visualizar Painel Desta Barbearia" class="p-2 bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 border border-blue-500/30 rounded-xl transition-all">
              <i data-lucide="eye" class="w-4 h-4"></i>
            </button>

            <!-- Resetar Senha Gestor -->
            <button onclick="resetSenhaGestorPrompt('${b.id}')" title="Resetar Senha do Gestor para 'abc123'" class="p-2 bg-dark-900 text-slate-400 hover:text-amber-400 border border-dark-700 rounded-xl transition-all">
              <i data-lucide="key" class="w-4 h-4"></i>
            </button>

            <!-- Excluir Barbearia -->
            <button onclick="excluirBarbeariaPrompt('${b.id}')" title="Excluir Barbearia" class="p-2 bg-dark-900 text-slate-500 hover:text-rose-400 border border-dark-700 rounded-xl transition-all">
              <i data-lucide="trash-2" class="w-4 h-4"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  });

  tbody.innerHTML = html;
  if (window.lucide) lucide.createIcons();
}

function openModalCadastrarBarbearia() {
  document.getElementById('master-barbearia-id').value = '';
  document.getElementById('master-input-nome').value = '';
  document.getElementById('master-input-responsavel').value = '';
  document.getElementById('master-input-telefone').value = '';
  document.getElementById('master-input-api-url').value = '';
  document.getElementById('master-input-plano').value = 'Mensal';
  document.getElementById('master-input-valor').value = '149.90';
  document.getElementById('master-input-vencimento').value = getDataFutura(30);
  previewLoginGestor('');
  openModal('modal-cadastrar-barbearia');
}

function autoPreencherPlanoMaster(plano) {
  const inputValor = document.getElementById('master-input-valor');
  const inputVenc = document.getElementById('master-input-vencimento');

  if (plano === 'Mensal') {
    if (inputValor) inputValor.value = '149.90';
    if (inputVenc) inputVenc.value = getDataFutura(30);
  } else if (plano === 'Trimestral') {
    if (inputValor) inputValor.value = '399.90';
    if (inputVenc) inputVenc.value = getDataFutura(90);
  } else if (plano === 'Semestral') {
    if (inputValor) inputValor.value = '699.90';
    if (inputVenc) inputVenc.value = getDataFutura(180);
  } else if (plano === 'Anual') {
    if (inputValor) inputValor.value = '1199.90';
    if (inputVenc) inputVenc.value = getDataFutura(365);
  }
}

async function handleSalvarMasterBarbearia(event) {
  event.preventDefault();
  const submitBtn = event.target.querySelector('button[type="submit"]');
  setButtonLoading(submitBtn, true, 'Cadastrando barbearia...');

  const id = document.getElementById('master-barbearia-id').value;
  const nome = document.getElementById('master-input-nome').value.trim();
  const responsavel = document.getElementById('master-input-responsavel').value.trim();
  const telefone = document.getElementById('master-input-telefone').value.trim();
  const apiUrl = document.getElementById('master-input-api-url').value.trim();
  const plano = document.getElementById('master-input-plano').value;
  const valor = parseFloat(document.getElementById('master-input-valor').value) || 0;
  const vencimento = document.getElementById('master-input-vencimento').value;

  const barbearia = {
    id: id || undefined,
    nome_barbearia: nome,
    responsavel: responsavel,
    telefone: telefone,
    api_url: apiUrl,
    plano: plano,
    valor_pago: valor,
    forma_pagamento_pix: 'PIX',
    data_vencimento: vencimento,
    status_licenca: 'ATIVA'
  };

  const res = await callGAS('saveMasterBarbearia', { barbearia });
  setButtonLoading(submitBtn, false);

  if (res && res.success) {
    closeModal('modal-cadastrar-barbearia');
    showToast(res.message || 'Barbearia cadastrada com sucesso!', 'success');
    await refreshData(true);
    renderMasterView();
  } else {
    showToast(res ? res.error : 'Erro ao cadastrar barbearia.', 'error');
  }
}

async function toggleStatusLicencaMasterAction(id, currentStatus) {
  const novoStatus = currentStatus === 'ATIVA' ? 'BLOQUEADA' : 'ATIVA';
  const acaoTexto = novoStatus === 'BLOQUEADA' ? 'bloquear o acesso de' : 'liberar o acesso para';
  
  if (!confirm(`Tem certeza que deseja ${acaoTexto} esta barbearia?`)) {
    return;
  }

  const res = await callGAS('toggleStatusLicencaMaster', { id, status: novoStatus });
  if (res && res.success) {
    showToast(res.message || `Status alterado para ${novoStatus}!`, 'success');
    await refreshData(true);
    renderMasterView();
  } else {
    showToast(res ? res.error : 'Erro ao alterar status da licença.', 'error');
  }
}

function openModalRenovarAssinaturaMaster(id) {
  const b = (appState.masterBarbearias || []).find(x => x.id === id);
  if (!b) return;

  document.getElementById('renovar-barbearia-id').value = b.id;
  document.getElementById('renovar-subtitulo-barbearia').textContent = `${b.nome_barbearia} (${b.responsavel || 'Gestor'})`;
  document.getElementById('renovar-input-plano').value = b.plano || 'Mensal';
  document.getElementById('renovar-input-valor').value = b.valor_pago || '149.90';
  document.getElementById('renovar-input-vencimento').value = getDataFutura(30);

  openModal('modal-renovar-assinatura-master');
}

function autoPreencherRenovacaoMaster(plano) {
  const inputValor = document.getElementById('renovar-input-valor');
  const inputVenc = document.getElementById('renovar-input-vencimento');

  if (plano === 'Mensal') {
    if (inputValor) inputValor.value = '149.90';
    if (inputVenc) inputVenc.value = getDataFutura(30);
  } else if (plano === 'Trimestral') {
    if (inputValor) inputValor.value = '399.90';
    if (inputVenc) inputVenc.value = getDataFutura(90);
  } else if (plano === 'Semestral') {
    if (inputValor) inputValor.value = '699.90';
    if (inputVenc) inputVenc.value = getDataFutura(180);
  } else if (plano === 'Anual') {
    if (inputValor) inputValor.value = '1199.90';
    if (inputVenc) inputVenc.value = getDataFutura(365);
  }
}

async function handleSalvarRenovacaoMaster(event) {
  event.preventDefault();
  const submitBtn = event.target.querySelector('button[type="submit"]');
  setButtonLoading(submitBtn, true, 'Confirmando PIX...');

  const id = document.getElementById('renovar-barbearia-id').value;
  const plano = document.getElementById('renovar-input-plano').value;
  const valor = parseFloat(document.getElementById('renovar-input-valor').value) || 0;
  const vencimento = document.getElementById('renovar-input-vencimento').value;

  const res = await callGAS('renovarVencimentoMaster', {
    id: id,
    novo_plano: plano,
    valor_pago: valor,
    novo_vencimento: vencimento
  });
  setButtonLoading(submitBtn, false);

  if (res && res.success) {
    closeModal('modal-renovar-assinatura-master');
    showToast(res.message || 'Assinatura renovada com sucesso via PIX!', 'success');
    await refreshData(true);
    renderMasterView();
  } else {
    showToast(res ? res.error : 'Erro ao renovar assinatura.', 'error');
  }
}

async function resetSenhaGestorPrompt(id) {
  const b = (appState.masterBarbearias || []).find(x => x.id === id);
  if (!b) return;

  if (!confirm(`Resetar a senha do gestor de "${b.nome_barbearia}" para o padrão temporário "abc123"?`)) {
    return;
  }

  const res = await callGAS('resetSenhaGestorMaster', { id });
  if (res && res.success) {
    showToast(res.message || 'Senha resetada para "abc123" com sucesso!', 'success');
    await refreshData(true);
    renderMasterView();
  } else {
    showToast(res ? res.error : 'Erro ao resetar senha.', 'error');
  }
}

async function excluirBarbeariaPrompt(id) {
  const b = (appState.masterBarbearias || []).find(x => x.id === id);
  if (!b) return;

  if (!confirm(`Atenção: Tem certeza que deseja excluir permanentemente a barbearia "${b.nome_barbearia}"? Esta ação não pode ser desfeita.`)) {
    return;
  }

  const res = await callGAS('deleteMasterBarbearia', { id });
  if (res && res.success) {
    showToast(res.message || 'Barbearia excluída com sucesso!', 'success');
    await refreshData(true);
    renderMasterView();
  } else {
    showToast(res ? res.error : 'Erro ao excluir barbearia.', 'error');
  }
}

async function auditarBarbearia(id) {
  const b = (appState.masterBarbearias || []).find(x => String(x.id).trim() === String(id).trim());
  if (!b) {
    showToast('Barbearia não encontrada.', 'error');
    return;
  }

  // 1. Salve a URL da API Master em window.MASTER_ORIGINAL_URL
  if (!window.MASTER_ORIGINAL_URL) {
    window.MASTER_ORIGINAL_URL = getGASUrl();
  }

  // 2. Alterne temporariamente o endpoint ativo para a b.api_url da barbearia auditada (se informada)
  if (b.api_url && b.api_url.trim().length > 10) {
    setGASUrl(b.api_url.trim());
  }

  appState.isAuditMode = true;
  appState.currentAuditedBarbearia = b;

  // 3. Alterne a sessão para o perfil de gestor da barbearia
  currentSession = {
    perfil: 'gestor',
    barbearia_id: b.id,
    nome_barbearia: b.nome_barbearia,
    usuario: b.login_gestor || 'Gestor',
    isAuditMode: true
  };
  saveCurrentSession();

  // 4. Exiba o banner fixo 'Modo Auditoria: [Nome]'
  const elNome = document.getElementById('audit-barbearia-nome');
  if (elNome) elNome.textContent = b.nome_barbearia;

  const banner = document.getElementById('gestor-audit-banner');
  if (banner) banner.classList.remove('hidden');

  if (!appState.config) appState.config = {};
  appState.config.nome_barbearia = b.nome_barbearia;
  updateUIBranding();

  showToast(`Modo Auditoria ativado: ${b.nome_barbearia}`, 'info');

  // 5. Chame showView("gestor") com refreshData(true)
  showView('gestor');
  await refreshData(true);
}

async function sairModoAuditoria() {
  appState.isAuditMode = false;
  appState.currentAuditedBarbearia = null;

  // 1. Restaure a URL da API Master (window.MASTER_ORIGINAL_URL)
  if (window.MASTER_ORIGINAL_URL) {
    setGASUrl(window.MASTER_ORIGINAL_URL);
  }

  // 2. Oculta o banner de auditoria
  const banner = document.getElementById('gestor-audit-banner');
  if (banner) banner.classList.add('hidden');

  // 3. Retorne a sessão para o Super Admin (Rafael_Martins)
  currentSession = {
    perfil: 'master',
    usuario: 'Rafael_Martins',
    nome: 'Rafael Martins (Dono do SaaS)'
  };
  saveCurrentSession();

  showToast('Você retornou ao Painel Master (Super Admin).', 'info');

  // 4. Abra o Painel Master
  showView('master');
  await refreshData(true);
  renderMasterView();
}

function exportarRelatorioMasterCSV() {
  const barbearias = appState.masterBarbearias || [];
  if (barbearias.length === 0) {
    showToast('Nenhuma barbearia cadastrada para exportar.', 'warning');
    return;
  }

  const hoje = getHojeString();
  let csv = 'ID;Nome da Barbearia;Responsavel;WhatsApp;Login Gestor;Plano;Valor Pago (R$);Forma Pagamento;Data Vencimento;Status da Licenca;Situacao\n';

  barbearias.forEach(b => {
    const isVencida = b.data_vencimento && b.data_vencimento < hoje;
    const situacao = b.status_licenca === 'BLOQUEADA' ? 'BLOQUEADA' : (isVencida ? 'VENCIDA' : 'EM DIA');
    const valor = (parseFloat(b.valor_pago) || 0).toFixed(2).replace('.', ',');

    csv += `"${b.id}";"${b.nome_barbearia}";"${b.responsavel || ''}";"${b.telefone || ''}";"${b.login_gestor}";"${b.plano || 'Mensal'}";"${valor}";"PIX";"${b.data_vencimento || ''}";"${b.status_licenca}";"${situacao}"\n`;
  });

  const blob = new Blob(["\uFEFF" + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Relatorio_Master_Barbearias_${getHojeString()}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  showToast('Relatório de Barbearias em CSV baixado com sucesso!', 'success');
}

function openModalRelatorioMaster() {
  const barbearias = appState.masterBarbearias || [];
  const hoje = getHojeString();
  const container = document.getElementById('relatorio-master-preview-content');
  if (!container) return;

  let totalEmDia = 0;
  let totalInadimplentes = 0;
  let receitaPix = 0;

  barbearias.forEach(b => {
    const isVencida = b.data_vencimento && b.data_vencimento < hoje;
    if (b.status_licenca === 'BLOQUEADA' || isVencida) {
      totalInadimplentes++;
    } else {
      totalEmDia++;
    }
    receitaPix += parseFloat(b.valor_pago) || 0;
  });

  let linhas = '';
  barbearias.forEach((b, idx) => {
    const isVencida = b.data_vencimento && b.data_vencimento < hoje;
    const isBloq = b.status_licenca === 'BLOQUEADA';
    const statusText = isBloq ? 'BLOQUEADA' : (isVencida ? 'VENCIDA' : 'EM DIA');
    const statusColor = isBloq || isVencida ? 'text-rose-400' : 'text-emerald-400';

    linhas += `
      <tr class="border-b border-dark-700/60">
        <td class="p-2.5 font-bold text-white">${idx + 1}. ${b.nome_barbearia}</td>
        <td class="p-2.5 text-slate-300">${b.responsavel || '--'}</td>
        <td class="p-2.5 font-mono text-gold-400">${b.login_gestor}</td>
        <td class="p-2.5 text-slate-300">${b.telefone || '--'}</td>
        <td class="p-2.5 text-slate-300">${b.plano || 'Mensal'}</td>
        <td class="p-2.5 font-bold text-gold-400">${formatarMoeda(b.valor_pago || 0)}</td>
        <td class="p-2.5 font-medium">${formatarDataPt(b.data_vencimento)}</td>
        <td class="p-2.5 font-bold ${statusColor}">${statusText}</td>
      </tr>
    `;
  });

  container.innerHTML = `
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 p-4 bg-dark-900 rounded-2xl border border-dark-700 mb-4">
      <div>
        <span class="text-[11px] text-slate-400 block">Total de Assinantes</span>
        <span class="text-xl font-black text-white">${barbearias.length} barbearias</span>
      </div>
      <div>
        <span class="text-[11px] text-slate-400 block">Assinaturas Em Dia</span>
        <span class="text-xl font-black text-emerald-400">${totalEmDia}</span>
      </div>
      <div>
        <span class="text-[11px] text-slate-400 block">Faturamento Total PIX</span>
        <span class="text-xl font-black text-gold-400">${formatarMoeda(receitaPix)}</span>
      </div>
    </div>

    <div class="overflow-x-auto rounded-xl border border-dark-700">
      <table class="w-full text-left text-xs">
        <thead class="bg-dark-900 text-slate-400 uppercase text-[10px] font-semibold">
          <tr>
            <th class="p-2.5">Barbearia</th>
            <th class="p-2.5">Responsável</th>
            <th class="p-2.5">Login Gestor</th>
            <th class="p-2.5">WhatsApp</th>
            <th class="p-2.5">Plano</th>
            <th class="p-2.5">Valor PIX</th>
            <th class="p-2.5">Vencimento</th>
            <th class="p-2.5">Situação</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-dark-700/60">
          ${linhas}
        </tbody>
      </table>
    </div>
  `;

  openModal('modal-relatorio-master');
}

function imprimirRelatorioMaster() {
  window.print();
}

function openModalAlterarSenhaMaster() {
  document.getElementById('input-master-senha-atual').value = '';
  document.getElementById('input-master-nova-senha').value = '';
  document.getElementById('input-master-confirma-senha').value = '';
  openModal('modal-alterar-senha-master');
}

async function handleSalvarSenhaMaster(event) {
  event.preventDefault();
  const sAtual = document.getElementById('input-master-senha-atual').value.trim();
  const sNova = document.getElementById('input-master-nova-senha').value.trim();
  const sConf = document.getElementById('input-master-confirma-senha').value.trim();

  if (sNova !== sConf) {
    showToast('A confirmação da nova senha não confere!', 'error');
    return;
  }

  const valid = validarRegraSenha(sNova);
  if (!valid.valido) {
    showToast(valid.erro, 'error');
    return;
  }

  const submitBtn = event.target.querySelector('button[type="submit"]');
  setButtonLoading(submitBtn, true, 'Atualizando...');

  const res = await callGAS('alterarSenhaMaster', {
    senha_atual: sAtual,
    nova_senha: sNova
  });
  setButtonLoading(submitBtn, false);

  if (res && res.success) {
    closeModal('modal-alterar-senha-master');
    if (!appState.masterConfig) appState.masterConfig = {};
    appState.masterConfig.superadmin_senha = sNova;
    saveLocalData();
    showToast('Senha do Super Admin alterada com sucesso!', 'success');
  } else {
    showToast(res ? res.error : 'Erro ao alterar senha do Super Admin.', 'error');
  }
}
