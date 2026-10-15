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
    nome_barbearia: 'GESTÃO PROFISSIONAL DE BARBEARIA',
    logo_url: '',
    usuario_gestor: 'admin',
    senha_gestor: 'admin123',
    status_licenca: 'ATIVA',
    suporte_whatsapp: '5511999999999',
    telefone_barbearia: '(11) 98765-4321',
    chave_pix: 'pix@barbearia.com'
  },
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

// =========================================================================
// 2. DADOS DE DEMONSTRAÇÃO (MODO OFFLINE / TESTE IMEDIATO)
// =========================================================================
function getDefaultMockData() {
  const hoje = getHojeString();
  const amanha = getAmanhaString();

  return {
    config: {
      nome_barbearia: 'GESTÃO PROFISSIONAL DE BARBEARIA',
      logo_url: '',
      usuario_gestor: 'admin',
      senha_gestor: 'admin123',
      status_licenca: 'ATIVA',
      suporte_whatsapp: '5511999999999',
      telefone_barbearia: '(11) 98765-4321',
      chave_pix: 'pix@barbearia.com'
    },
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
      { id: 'AGD-1', cliente_nome: 'Carlos Mendes', cliente_telefone: '11999887766', servico_id: 'SRV-1', servico_nome: 'Corte Degradê / Moderno', servico_preco: 45.00, barbeiro_id: 'BRB-1', barbeiro_nome: 'João Carlos da Silva', data: hoje, horario: '09:00', status: 'Concluido', forma_pagamento: 'PIX', comissao_valor: 22.50, criado_em: hoje + ' 08:00:00' },
      { id: 'AGD-2', cliente_nome: 'Rafael Souza', cliente_telefone: '11988776655', servico_id: 'SRV-3', servico_nome: 'Combo Completo (Corte + Barba)', servico_preco: 70.00, barbeiro_id: 'BRB-1', barbeiro_nome: 'João Carlos da Silva', data: hoje, horario: '10:00', status: 'Concluido', forma_pagamento: 'Dinheiro', comissao_valor: 35.00, criado_em: hoje + ' 08:30:00' },
      { id: 'AGD-3', cliente_nome: 'Lucas Almeida', cliente_telefone: '11977665544', servico_id: 'SRV-2', servico_nome: 'Barba Terapia com Toalha Quente', servico_preco: 35.00, barbeiro_id: 'BRB-2', barbeiro_nome: 'Marcos Vinicius Santos', data: hoje, horario: '11:00', status: 'Concluido', forma_pagamento: 'Cartao_Debito', comissao_valor: 21.00, criado_em: hoje + ' 09:00:00' },
      { id: 'AGD-4', cliente_nome: 'Bruno Henrique', cliente_telefone: '11966554433', servico_id: 'SRV-1', servico_nome: 'Corte Degradê / Moderno', servico_preco: 45.00, barbeiro_id: 'BRB-1', barbeiro_nome: 'João Carlos da Silva', data: hoje, horario: '14:30', status: 'Agendado', forma_pagamento: 'Pendente', comissao_valor: 22.50, criado_em: hoje + ' 10:00:00' },
      { id: 'AGD-5', cliente_nome: 'Thiago Oliveira', cliente_telefone: '11955443322', servico_id: 'SRV-3', servico_nome: 'Combo Completo (Corte + Barba)', servico_preco: 70.00, barbeiro_id: 'BRB-2', barbeiro_nome: 'Marcos Vinicius Santos', data: amanha, horario: '15:00', status: 'Agendado', forma_pagamento: 'Pendente', comissao_valor: 42.00, criado_em: hoje + ' 10:30:00' }
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

function getGASUrl() {
  // Permite configurar a barbearia automaticamente via link com parâmetro: ?api=https://script.google.com/.../exec
  if (typeof window !== 'undefined' && window.location && window.location.search) {
    const params = new URLSearchParams(window.location.search);
    const apiParam = params.get('api');
    if (apiParam && apiParam.trim().length > 10) {
      const cleanUrl = apiParam.trim();
      localStorage.setItem(GAS_URL_KEY, cleanUrl);
      // Limpa o parâmetro da barra de endereços para manter a URL limpa e profissional
      if (window.history && window.history.replaceState) {
        const cleanPath = window.location.pathname + window.location.hash;
        window.history.replaceState({}, document.title, cleanPath);
      }
      return cleanUrl;
    }
  }
  return localStorage.getItem(GAS_URL_KEY) || '';
}

function setGASUrl(url) {
  if (url) {
    localStorage.setItem(GAS_URL_KEY, url.trim());
  } else {
    localStorage.removeItem(GAS_URL_KEY);
  }
  updateSyncStatus();
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
  } else {
    if (loginDot) loginDot.className = 'w-2.5 h-2.5 rounded-full bg-amber-500 pulse-dot';
    if (loginText) loginText.textContent = 'Modo Demonstração (Local)';
    if (gestorDot) gestorDot.className = 'w-2 h-2 rounded-full bg-amber-500';
    if (gestorText) gestorText.textContent = 'Modo Demo (Local)';
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

    case 'loginGestor': {
      const cfg = appState.config || {};
      if (cfg.status_licenca === 'BLOQUEADA') {
        return {
          success: false,
          bloqueado: true,
          status_licenca: 'BLOQUEADA',
          error: 'Licença suspensa por inadimplência. Entre em contato com o suporte.'
        };
      }

      const usuarioEsperado = (cfg.usuario_gestor || 'admin').trim().toLowerCase();
      const senhaEsperada = (cfg.senha_gestor || 'admin123').trim();
      const usuarioDigitado = String(payload.usuario || 'admin').trim().toLowerCase();
      const senhaDigitada = String(payload.senha || '').trim();

      if (usuarioDigitado !== usuarioEsperado) {
        return { success: false, error: 'Usuário do gestor incorreto (padrão: admin).' };
      }

      if (senhaDigitada !== senhaEsperada) {
        return { success: false, error: 'Senha incorreta para acesso de Gestor.' };
      }

      const primeiroAcesso = (senhaDigitada === 'admin123');
      return {
        success: true,
        perfil: 'gestor',
        primeiroAcessoGestor: primeiroAcesso
      };
    }

    case 'alterarSenhaGestor': {
      const cfg = appState.config || {};
      const senhaAtualEsperada = (cfg.senha_gestor || 'admin123').trim();
      const senhaAtualDigitada = String(payload.senhaAtual || '').trim();

      if (!payload.force && senhaAtualDigitada !== senhaAtualEsperada) {
        return { success: false, error: 'Senha atual do gestor incorreta.' };
      }

      const valid = validarRegraSenha(payload.novaSenha);
      if (!valid.valido) {
        return { success: false, error: valid.erro };
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
        saveLocalData();
        return { success: true, message: 'Status atualizado!' };
      }
      return { success: false, error: 'Agendamento não encontrado.' };
    }

    case 'finalizarAtendimentoComanda': {
      const agd = appState.agendamentos.find(x => x.id === payload.agendamento_id);
      if (!agd) return { success: false, error: 'Agendamento não encontrado.' };

      agd.status = 'Concluido';
      agd.forma_pagamento = payload.forma_pagamento || 'Dinheiro';

      // Baixa no estoque dos produtos da comanda
      const produtos = payload.produtos_consumidos || [];
      produtos.forEach(pItem => {
        const prod = appState.produtos.find(p => p.id === pItem.id);
        if (prod) {
          const qtd = parseInt(pItem.qtd) || 1;
          prod.estoque = Math.max(0, (parseInt(prod.estoque) || 0) - qtd);
        }
      });

      // Se houver produtos, anexa o registro da comanda conjunta ao agendamento
      if (produtos.length > 0) {
        agd.produtos_comanda = produtos;
        const subtotalProdutos = produtos.reduce((acc, p) => acc + (parseFloat(p.preco) * parseInt(p.qtd)), 0);
        agd.total_comanda = (parseFloat(agd.servico_preco) || 0) + subtotalProdutos;
      }

      saveLocalData();
      return {
        success: true,
        message: 'Comanda finalizada com sucesso! Estoque e caixa atualizados.'
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

  if (currentSession && currentSession.perfil === 'barbeiro') {
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

  const usuario = document.getElementById('input-usuario-gestor') ? document.getElementById('input-usuario-gestor').value.trim() : 'admin';
  const senha = document.getElementById('input-senha-gestor').value.trim();

  const res = await callGAS('loginGestor', { usuario, senha });
  setButtonLoading(submitBtn, false);

  if (res && res.success) {
    // Verificação de Primeiro Acesso com a senha padrão 'admin123'
    if (res.primeiroAcessoGestor || senha === 'admin123') {
      openModal('modal-primeiro-acesso-gestor');
      return;
    }

    currentSession = { perfil: 'gestor' };
    localStorage.setItem(SESSION_KEY, JSON.stringify(currentSession));
    showToast('Bem-vindo, Gestor!', 'success');
    showView('gestor');
    renderGestorView();
    refreshData(true);
  } else if (res && res.bloqueado) {
    exibirTelaBloqueioSaaS();
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

  const res = await callGAS('alterarSenhaGestor', {
    senhaAtual: 'admin123',
    novaSenha: s1,
    force: true
  });
  setButtonLoading(submitBtn, false);

  if (res && res.success) {
    closeModal('modal-primeiro-acesso-gestor');
    appState.config.senha_gestor = s1;
    saveLocalData();
    showToast('Senha pessoal do gestor cadastrada com sucesso! Bem-vindo.', 'success');

    currentSession = { perfil: 'gestor' };
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

function exibirTelaBloqueioSaaS() {
  const cfg = appState.config || {};
  const elNome = document.getElementById('bloqueio-nome-barbearia');
  if (elNome) elNome.textContent = cfg.nome_barbearia || 'GESTÃO PROFISSIONAL DE BARBEARIA';

  const btnWhats = document.getElementById('btn-whatsapp-bloqueio');
  if (btnWhats) {
    const zap = (cfg.suporte_whatsapp || '5511999999999').replace(/\D/g, '');
    const txt = encodeURIComponent(`Olá, sou da barbearia ${cfg.nome_barbearia || 'Barbearia'} e gostaria de regularizar a assinatura do sistema.`);
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
      if (currentSession.perfil === 'gestor') {
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
  localStorage.removeItem(SESSION_KEY);
  showView('auth');
  showToast('Sessão encerrada com sucesso.', 'info');
}

function showView(view) {
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('gestor-view').classList.add('hidden');
  document.getElementById('barbeiro-view').classList.add('hidden');

  if (view === 'gestor') {
    document.getElementById('gestor-view').classList.remove('hidden');
  } else if (view === 'barbeiro') {
    document.getElementById('barbeiro-view').classList.remove('hidden');
  } else {
    document.getElementById('auth-screen').classList.remove('hidden');
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
  const zapSuporte = (cfg.suporte_whatsapp || '5511999999999').replace(/\D/g, '');
  const elTextoSuporte = document.getElementById('texto-suporte-saas');
  if (elTextoSuporte) elTextoSuporte.textContent = cfg.suporte_whatsapp || '(11) 99999-9999';

  const linkSuporte = document.getElementById('link-whatsapp-suporte');
  if (linkSuporte) linkSuporte.href = `https://wa.me/${zapSuporte}?text=${encodeURIComponent('Olá, suporte SaaS Barbearia! Preciso de auxílio.')}`;

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

  let faturamentoHoje = 0;
  let qtdHojeConcluidos = 0;
  let faturamentoMes = 0;
  let totalEntradas = 0;
  let totalDinheiroEntrada = 0;
  let porForma = { Dinheiro: 0, PIX: 0, Cartao_Debito: 0, Cartao_Credito: 0 };

  (appState.agendamentos || []).forEach(a => {
    if (a.status === 'Concluido') {
      const preco = parseFloat(a.servico_preco) || 0;
      totalEntradas += preco;

      if (a.data === hoje) {
        faturamentoHoje += preco;
        qtdHojeConcluidos++;
      }
      if (a.data && a.data.startsWith(mesAtual)) {
        faturamentoMes += preco;
      }

      const forma = a.forma_pagamento || 'Dinheiro';
      if (porForma.hasOwnProperty(forma)) {
        porForma[forma] += preco;
      }
      if (forma === 'Dinheiro') {
        totalDinheiroEntrada += preco;
      }
    }
  });

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
  const saldoCaixaLiquido = Math.max(0, totalEntradas - totalSangrias - totalPagamentosBarbeiros);

  let totalComissoesPendentes = 0;
  (appState.barbeiros || []).forEach(b => {
    const sal = calcularSaldoBarbeiro(b.id);
    totalComissoesPendentes += sal.saldoAReceber;
  });

  return {
    faturamentoHoje,
    qtdHojeConcluidos,
    faturamentoMes,
    totalEntradas,
    totalSangrias,
    totalPagamentosBarbeiros,
    saldoCaixaLiquido,
    saldoDinheiroEspecie,
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
    .filter(a => a.data === hoje)
    .sort((a, b) => (a.horario || '').localeCompare(b.horario || ''));

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
        <td class="p-3 font-bold text-white">${a.horario || '--:--'}</td>
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
📅 Data: *${dataPt}* às *${agd.horario || '--:--'}*

Podemos confirmar o seu horário? Esperamos por você!`;

  const url = `https://wa.me/55${tel}?text=${encodeURIComponent(texto)}`;
  window.open(url, '_blank');
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

  lista.sort((a, b) => {
    if (a.data !== b.data) return (b.data || '').localeCompare(a.data || '');
    return (a.horario || '').localeCompare(b.horario || '');
  });

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
          <div class="text-[11px] text-slate-400 font-mono">${a.horario || '--:--'}</div>
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
    renderGestorView();
  } else {
    showToast(res ? res.error : 'Erro ao cancelar.', 'error');
  }
}

// -------------------------------------------------------------------------
// 9.3 FLUXO DE CAIXA & SANGRIA
// -------------------------------------------------------------------------
function renderCaixa() {
  const fin = calcularFinanceiroGeral();

  document.getElementById('caixa-saldo-especie').textContent = formatarMoeda(fin.saldoDinheiroEspecie);
  document.getElementById('caixa-total-entradas').textContent = formatarMoeda(fin.totalEntradas);
  document.getElementById('caixa-total-sangrias').textContent = formatarMoeda(fin.totalSangrias);
  document.getElementById('caixa-total-pagamentos-barbeiros').textContent = formatarMoeda(fin.totalPagamentosBarbeiros);

  renderExtratoCaixa();
}

function renderExtratoCaixa() {
  const tbody = document.getElementById('tabela-caixa-movimentos-tbody');
  if (!tbody) return;

  const movimentos = [];

  (appState.agendamentos || []).forEach(a => {
    if (a.status === 'Concluido') {
      movimentos.push({
        data_hora: a.criado_em || (a.data + ' ' + (a.horario || '12:00') + ':00'),
        tipo: 'ENTRADA',
        descricao: `Atendimento: ${a.servico_nome} (${a.cliente_nome} - Barb. ${a.barbeiro_nome})`,
        forma: a.forma_pagamento || 'Dinheiro',
        valor: parseFloat(a.servico_preco) || 0
      });
    }
  });

  (appState.sangrias || []).forEach(s => {
    movimentos.push({
      data_hora: s.data_hora,
      tipo: 'SANGRIA',
      descricao: `Sangria: ${s.motivo || 'Retirada de Caixa'}`,
      forma: 'Dinheiro (Gaveta)',
      valor: -(parseFloat(s.valor) || 0)
    });
  });

  (appState.pagamentosBarbeiros || []).forEach(p => {
    movimentos.push({
      data_hora: p.data_hora,
      tipo: 'PAGTO_BARBEIRO',
      descricao: `Pagamento de Comissão: ${p.barbeiro_nome} (${p.observacao || 'Acerto'})`,
      forma: p.forma_pagamento || 'PIX',
      valor: -(parseFloat(p.valor) || 0)
    });
  });

  movimentos.sort((a, b) => (b.data_hora || '').localeCompare(a.data_hora || ''));

  if (movimentos.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" class="p-8 text-center text-slate-500">
          Nenhuma movimentação no caixa registrada até o momento.
        </td>
      </tr>
    `;
    return;
  }

  let html = '';
  movimentos.forEach(m => {
    const isEntrada = m.valor > 0;
    const badge = isEntrada
      ? '<span class="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2 py-0.5 rounded text-[10px] font-bold">ENTRADA</span>'
      : (m.tipo === 'SANGRIA'
        ? '<span class="bg-rose-500/10 text-rose-400 border border-rose-500/20 px-2 py-0.5 rounded text-[10px] font-bold">SANGRIA</span>'
        : '<span class="bg-amber-500/10 text-amber-400 border border-amber-500/20 px-2 py-0.5 rounded text-[10px] font-bold">PAGTO BARBEIRO</span>');

    const valorFormatado = (isEntrada ? '+ ' : '- ') + formatarMoeda(Math.abs(m.valor));
    const valorCor = isEntrada ? 'text-emerald-400' : 'text-rose-400';

    html += `
      <tr class="hover:bg-dark-900/40 transition-colors">
        <td class="p-3 text-slate-400 font-mono text-[11px]">${formatarDataHoraPt(m.data_hora)}</td>
        <td class="p-3">${badge}</td>
        <td class="p-3 text-slate-200 font-medium">${m.descricao}</td>
        <td class="p-3 text-slate-300">${formatarFormaPagamento(m.forma)}</td>
        <td class="p-3 text-right font-extrabold ${valorCor}">${valorFormatado}</td>
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

  let totalArrecadado = 0;
  let porForma = {
    Dinheiro: 0,
    PIX: 0,
    Cartao_Debito: 0,
    Cartao_Credito: 0
  };

  atendimentosDia.forEach(a => {
    const preco = parseFloat(a.servico_preco) || 0;
    totalArrecadado += preco;
    const f = a.forma_pagamento || 'Dinheiro';
    if (porForma.hasOwnProperty(f)) {
      porForma[f] += preco;
    } else {
      porForma.Dinheiro += preco;
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

  // 4. Saldo em Gaveta Físico (Dinheiro que deve estar na gaveta)
  // = Dinheiro arrecadado - Sangrias retiradas - Pagamentos feitos aos barbeiros em dinheiro físico
  const dinheiroEntrada = porForma.Dinheiro || 0;
  const saldoGaveta = dinheiroEntrada - totalSangrias - pagamentosDinheiro;

  // 5. Saldo Líquido do Dia (Total arrecadado - despesas/sangrias/acertos)
  const saldoLiquidoGeral = totalArrecadado - totalSangrias - totalPagamentos;

  // Atualização dos elementos no DOM
  const elTotalArrecadado = document.getElementById('fechamento-total-arrecadado');
  if (elTotalArrecadado) elTotalArrecadado.textContent = formatarMoeda(totalArrecadado);

  const elQtdAtendimentos = document.getElementById('fechamento-qtd-atendimentos');
  if (elQtdAtendimentos) {
    elQtdAtendimentos.textContent = `${atendimentosDia.length} atendimento${atendimentosDia.length === 1 ? '' : 's'} concluído${atendimentosDia.length === 1 ? '' : 's'}`;
  }

  const elTotalSangrias = document.getElementById('fechamento-total-sangrias');
  if (elTotalSangrias) elTotalSangrias.textContent = formatarMoeda(totalSangrias);

  const elQtdSangrias = document.getElementById('fechamento-qtd-sangrias');
  if (elQtdSangrias) {
    elQtdSangrias.textContent = `${sangriasDia.length} retirada${sangriasDia.length === 1 ? '' : 's'}`;
  }

  const elSaldoGaveta = document.getElementById('fechamento-saldo-gaveta');
  if (elSaldoGaveta) {
    elSaldoGaveta.textContent = formatarMoeda(saldoGaveta);
    elSaldoGaveta.className = `text-xl font-black ${saldoGaveta >= 0 ? 'text-emerald-400' : 'text-rose-400'}`;
  }

  const elFormaDinheiro = document.getElementById('fechamento-forma-dinheiro');
  if (elFormaDinheiro) elFormaDinheiro.textContent = formatarMoeda(porForma.Dinheiro);

  const elFormaPix = document.getElementById('fechamento-forma-pix');
  if (elFormaPix) elFormaPix.textContent = formatarMoeda(porForma.PIX);

  const elFormaDebito = document.getElementById('fechamento-forma-debito');
  if (elFormaDebito) elFormaDebito.textContent = formatarMoeda(porForma.Cartao_Debito);

  const elFormaCredito = document.getElementById('fechamento-forma-credito');
  if (elFormaCredito) elFormaCredito.textContent = formatarMoeda(porForma.Cartao_Credito);

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

  const elSubtotalServicos = document.getElementById('fechamento-subtotal-servicos');
  if (elSubtotalServicos) elSubtotalServicos.textContent = formatarMoeda(totalArrecadado);

  const listaAtendimentos = document.getElementById('fechamento-lista-atendimentos');
  if (listaAtendimentos) {
    if (atendimentosDia.length === 0) {
      listaAtendimentos.innerHTML = `<p class="text-slate-500 py-1.5 text-center text-xs">Nenhum atendimento concluído nesta data.</p>`;
    } else {
      let h = '';
      atendimentosDia.forEach(a => {
        h += `
          <div class="flex items-center justify-between p-2 rounded-lg bg-dark-800/80 border border-dark-700/60 text-xs">
            <div class="flex items-center gap-2">
              <span class="text-gold-400 font-mono text-[11px] font-bold">${a.horario || '--:--'}</span>
              <div>
                <span class="text-white font-medium">${a.servico_nome}</span>
                <span class="text-slate-400 text-[11px]"> (${a.cliente_nome} - ${a.barbeiro_nome})</span>
              </div>
            </div>
            <div class="text-right">
              <span class="text-emerald-400 font-bold">${formatarMoeda(a.servico_preco)}</span>
              <div class="text-[10px] text-slate-400 font-medium">${formatarFormaPagamento(a.forma_pagamento)}</div>
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

  let totalArrecadado = 0;
  let porForma = { Dinheiro: 0, PIX: 0, Cartao_Debito: 0, Cartao_Credito: 0 };
  atendimentosDia.forEach(a => {
    const preco = parseFloat(a.servico_preco) || 0;
    totalArrecadado += preco;
    const f = a.forma_pagamento || 'Dinheiro';
    if (porForma[f] !== undefined) porForma[f] += preco;
    else porForma.Dinheiro += preco;
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

  const saldoGaveta = (porForma.Dinheiro || 0) - totalSangrias - pagamentosDinheiro;
  const saldoLiquidoGeral = totalArrecadado - totalSangrias - totalPagamentos;

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
      servicosHtml += `<div style="display:flex; justify-content:space-between; margin:2px 0;"><span>${a.horario || '--:--'} ${a.servico_nome} (${a.cliente_nome}) [${formatarFormaPagamento(a.forma_pagamento)}]:</span><span>${formatarMoeda(a.servico_preco)}</span></div>`;
    });
  } else {
    servicosHtml = `<div style="color:#666;">Nenhum atendimento concluído.</div>`;
  }

  printArea.innerHTML = `
    <div style="font-family: monospace; font-size: 11px; line-height: 1.4; color: #000; padding: 12px; max-width: 340px; margin: 0 auto; background: #fff;">
      <div style="text-align: center; border-bottom: 1px dashed #000; padding-bottom: 8px; margin-bottom: 8px;">
        <h2 style="font-size: 15px; margin: 0; font-weight: bold; text-transform: uppercase;">${nomeBarbearia}</h2>
        ${tel ? `<p style="margin: 2px 0 0; font-size: 10px;">Contato: ${tel}</p>` : ''}
        <h3 style="font-size: 12px; margin: 4px 0 0; font-weight: bold;">FECHAMENTO DE CAIXA DIÁRIO</h3>
        <p style="margin: 2px 0 0; font-size: 11px;">Data de Referência: <strong>${formatarDataPt(dataIso)}</strong></p>
        <p style="font-size: 9px; margin: 2px 0 0; color: #444;">Impresso em: ${getHojeAgoraString()}</p>
      </div>

      <div style="border-bottom: 1px dashed #000; padding-bottom: 8px; margin-bottom: 8px;">
        <div style="font-weight: bold; margin-bottom: 4px;">ARRECADAÇÃO POR FORMA DE PAGAMENTO:</div>
        <div style="display: flex; justify-content: space-between;"><span>💵 Dinheiro (Espécie):</span><span>${formatarMoeda(porForma.Dinheiro)}</span></div>
        <div style="display: flex; justify-content: space-between;"><span>⚡ PIX:</span><span>${formatarMoeda(porForma.PIX)}</span></div>
        <div style="display: flex; justify-content: space-between;"><span>💳 Cartão Débito:</span><span>${formatarMoeda(porForma.Cartao_Debito)}</span></div>
        <div style="display: flex; justify-content: space-between;"><span>💳 Cartão Crédito:</span><span>${formatarMoeda(porForma.Cartao_Credito)}</span></div>
        <div style="display: flex; justify-content: space-between; font-weight: bold; margin-top: 4px; border-top: 1px dotted #000; padding-top: 4px;">
          <span>TOTAL ARRECADADO (${atendimentosDia.length} atend.):</span>
          <span>${formatarMoeda(totalArrecadado)}</span>
        </div>
      </div>

      <div style="border-bottom: 1px dashed #000; padding-bottom: 8px; margin-bottom: 8px;">
        <div style="font-weight: bold; margin-bottom: 4px;">RETIRADAS E SANGRIAS DO DIA:</div>
        <div style="display: flex; justify-content: space-between; font-weight: bold;"><span>Total Sangrias:</span><span>-${formatarMoeda(totalSangrias)}</span></div>
        ${pagamentosDinheiro > 0 ? `<div style="display: flex; justify-content: space-between;"><span>Pagtos Barbeiros (Espécie):</span><span>-${formatarMoeda(pagamentosDinheiro)}</span></div>` : ''}
        <div style="margin-top: 4px; font-size: 10px;">${sangriasHtml}</div>
      </div>

      <div style="border-bottom: 2px solid #000; padding-bottom: 8px; margin-bottom: 8px;">
        <div style="display: flex; justify-content: space-between; font-size: 13px; font-weight: bold;">
          <span>SALDO ESPERADO EM GAVETA:</span>
          <span>${formatarMoeda(saldoGaveta)}</span>
        </div>
        <div style="font-size: 9px; color: #555;">(Dinheiro físico em espécie esperado no caixa)</div>
        
        <div style="display: flex; justify-content: space-between; font-size: 13px; font-weight: bold; margin-top: 6px;">
          <span>SALDO LÍQUIDO DO DIA:</span>
          <span>${formatarMoeda(saldoLiquidoGeral)}</span>
        </div>
        <div style="font-size: 9px; color: #555;">(Total arrecadado menos sangrias e acertos)</div>
      </div>

      <div style="border-bottom: 1px dashed #000; padding-bottom: 8px; margin-bottom: 8px; font-size: 10px;">
        <div style="font-weight: bold; margin-bottom: 4px;">RESUMO DE ATENDIMENTOS DO DIA:</div>
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

  let totalArrecadado = 0;
  let porForma = { Dinheiro: 0, PIX: 0, Cartao_Debito: 0, Cartao_Credito: 0 };
  atendimentosDia.forEach(a => {
    const val = parseFloat(a.servico_preco) || 0;
    totalArrecadado += val;
    const f = a.forma_pagamento || 'Dinheiro';
    if (porForma.hasOwnProperty(f)) porForma[f] += val;
    else porForma.Dinheiro += val;
  });

  const totalSangrias = sangriasDia.reduce((acc, s) => acc + (parseFloat(s.valor) || 0), 0);
  const totalPagamentos = pagamentosDia.reduce((acc, p) => acc + (parseFloat(p.valor) || 0), 0);
  const pagamentosDinheiro = pagamentosDia.filter(p => p.forma_pagamento === 'Dinheiro').reduce((acc, p) => acc + (parseFloat(p.valor) || 0), 0);

  const saldoGaveta = (porForma.Dinheiro || 0) - totalSangrias - pagamentosDinheiro;
  const saldoLiquido = totalArrecadado - totalSangrias - totalPagamentos;

  // Montagem do arquivo CSV formatado em ponto-e-vírgula com UTF-8 BOM
  let csv = '\uFEFF';
  csv += `RELATÓRIO DE FECHAMENTO DE CAIXA DIÁRIO\n`;
  csv += `Barbearia;${nomeBarbearia}\n`;
  csv += `Data de Referência;${formatarDataPt(dataIso)}\n`;
  csv += `Gerado em;${getHojeAgoraString()}\n\n`;

  csv += `RESUMO FINANCEIRO\n`;
  csv += `Métrica;Valor (R$)\n`;
  csv += `Total Arrecadado (Serviços e Vendas);${totalArrecadado.toFixed(2)}\n`;
  csv += `Total de Sangrias Retiradas;-${totalSangrias.toFixed(2)}\n`;
  csv += `Total de Acertos / Comissões Pagas;-${totalPagamentos.toFixed(2)}\n`;
  csv += `Saldo Físico em Gaveta (Espécie);${saldoGaveta.toFixed(2)}\n`;
  csv += `Saldo Líquido Geral do Dia;${saldoLiquido.toFixed(2)}\n\n`;

  csv += `DETALHAMENTO POR FORMA DE PAGAMENTO\n`;
  csv += `Forma de Pagamento;Total (R$)\n`;
  csv += `Dinheiro (Espécie);${(porForma.Dinheiro || 0).toFixed(2)}\n`;
  csv += `PIX;${(porForma.PIX || 0).toFixed(2)}\n`;
  csv += `Cartão de Débito;${(porForma.Cartao_Debito || 0).toFixed(2)}\n`;
  csv += `Cartão de Crédito;${(porForma.Cartao_Credito || 0).toFixed(2)}\n\n`;

  csv += `ATENDIMENTOS CONCLUÍDOS NO DIA\n`;
  csv += `Horário;Cliente;Telefone;Serviço;Barbeiro;Forma de Pagamento;Valor (R$);Comissão (R$)\n`;
  atendimentosDia.forEach(a => {
    const val = parseFloat(a.servico_preco) || 0;
    const com = parseFloat(a.comissao_valor) || 0;
    csv += `"${a.horario || '--:--'}";"${a.cliente_nome}";"${a.cliente_telefone || ''}";"${a.servico_nome}";"${a.barbeiro_nome}";"${formatarFormaPagamento(a.forma_pagamento)}";${val.toFixed(2)};${com.toFixed(2)}\n`;
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
            
            <button onclick="resetarSenhaBarbeiroPrompt('${b.id}', '${b.nome}')" title="Resetar Senha do Barbeiro" class="text-slate-500 hover:text-amber-400 p-1.5 rounded-lg hover:bg-dark-700 transition-colors">
              <i data-lucide="key" class="w-4 h-4"></i>
            </button>
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
    renderGestorView();
  } else {
    showToast(res ? res.error : 'Erro ao registrar pagamento.', 'error');
  }
}

function openModalNovoBarbeiro() {
  document.getElementById('modal-barbeiro-title').innerHTML = `
    <i data-lucide="scissors" class="w-5 h-5 text-gold-500"></i>
    <span>Cadastrar Barbeiro</span>
  `;
  document.getElementById('barbeiro-form-id').value = '';
  document.getElementById('barbeiro-form-nome').value = '';
  document.getElementById('barbeiro-form-tel').value = '';
  document.getElementById('barbeiro-form-comissao').value = '50';
  document.getElementById('barbeiro-form-login-preview').textContent = 'PrimeiroNome_ÚltimoNome';

  openModal('modal-barbeiro');
}

function previewLoginBarbeiro(nome) {
  const preview = document.getElementById('barbeiro-form-login-preview');
  if (preview) {
    preview.textContent = gerarLoginBarbeiro(nome);
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
  const senhaGestor = elSenhaGestor && elSenhaGestor.value.trim() ? elSenhaGestor.value.trim() : (appState.config?.senha_gestor || 'admin123');
  const gasUrl = document.getElementById('config-gas-url').value.trim();

  setGASUrl(gasUrl);

  const novaConfig = {
    nome_barbearia: nome,
    logo_url: logo,
    telefone_barbearia: tel,
    chave_pix: pix,
    senha_gestor: senhaGestor
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
  const url = document.getElementById('config-gas-url').value.trim();
  if (!url) {
    showToast('Informe a URL do Google Apps Script para testar.', 'error');
    return;
  }

  showToast('Testando conexão com a planilha...', 'info');
  setGlobalLoading(true);
  try {
    const resp = await fetch(url + '?action=ping');
    const json = await resp.json();
    setGlobalLoading(false);
    if (json && json.success) {
      showToast('Conexão de alta performance com Google Planilhas confirmada!', 'success');
    } else {
      showToast('Resposta recebida com aviso: ' + (json.error || 'Desconhecido'), 'error');
    }
  } catch (e) {
    setGlobalLoading(false);
    showToast('Não foi possível conectar. Verifique se o Web App foi publicado com acesso "Qualquer pessoa".', 'error');
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

  lista.sort((a, b) => {
    if (a.data !== b.data) return (a.data || '').localeCompare(b.data || '');
    return (a.horario || '').localeCompare(b.horario || '');
  });

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
              ${a.horario || '--:--'}
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
    if (a.data !== b.data) return (b.data || '').localeCompare(a.data || '');
    return (b.horario || '').localeCompare(a.horario || '');
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
            <div class="text-[11px] text-slate-400">${a.cliente_nome} (${formatarDataPt(a.data)} às ${a.horario || '--:--'})</div>
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
  const partes = dataStr.split('-');
  if (partes.length === 3) {
    return `${partes[2]}/${partes[1]}/${partes[0]}`;
  }
  return dataStr;
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
