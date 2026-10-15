/**
 * =========================================================================
 * BACKEND GOOGLE APPS SCRIPT - SISTEMA SAAS DE GESTÃO DE BARBEARIA (PREMIUM)
 * =========================================================================
 * Versão Comercial SaaS para Múltiplas Barbearias:
 * - Alta Concorrência (LockService seletivo e operações em bloco)
 * - Identidade Visual Padrão com SVG de Máquina Cruzada com Tesoura
 * - Super Admin Exclusivo: Rafael_Martins com Painel Master de Gestão Multi-Barbearias
 * - Login Automático de Barbearias ("Barbearia_Nome") com Senha Inicial "abc123" e Troca Obrigatória
 * - Controle Rigoroso de Assinaturas SaaS (PIX, Vencimento Automático e Trava Instantânea)
 * - Modo Auditoria e Impersonação para Suporte Técnico pelo Super Admin
 * - Lazy Loading / Paginação dos últimos 7 dias + Futuros
 * - Backup Diário Automático no Google Drive (Time-driven trigger às 03:00)
 * =========================================================================
 */

// Nomes das abas estruturadas da planilha
var SHEETS = {
  MASTER: 'Master_Barbearias',
  CONFIG: 'Configuracoes',
  CLIENTES: 'Clientes',
  PRODUTOS: 'Produtos',
  SERVICOS: 'Servicos',
  BARBEIROS: 'Barbeiros',
  AGENDAMENTOS: 'Agendamentos',
  SANGRIAS: 'Caixa_Sangrias',
  PAGAMENTOS: 'Pagamentos_Barbeiros'
};

/**
 * Ações de leitura que rodam concorrentemente sem Lock
 */
var READ_ACTIONS = {
  'ping': true,
  'getAllData': true,
  'getBarberData': true,
  'loginGestor': true,
  'loginBarbeiro': true,
  'getAgendamentosHistorico': true,
  'getMasterBarbearias': true
};

/**
 * Manipulador GET (Leituras e testes de conexão)
 */
function doGet(e) {
  try {
    var params = e ? e.parameter : {};
    var action = params.action || 'ping';

    if (action === 'ping') {
      return jsonResponse({
        success: true,
        message: 'API Barbearia SaaS Online (Alta Performance & Estabilidade)!',
        timestamp: new Date().toISOString()
      });
    }

    if (action === 'setupDatabase') {
      return jsonResponse(setupDatabase());
    }

    if (action === 'getAllData') {
      var dias = params.dias ? parseInt(params.dias) : 7;
      return jsonResponse(getAllData(dias));
    }

    if (action === 'getBarberData') {
      var barberId = params.barbeiro_id;
      if (!barberId) {
        return jsonResponse({ success: false, error: 'ID do barbeiro não fornecido.' });
      }
      return jsonResponse(getBarberData(barberId));
    }

    if (action === 'criarBackup') {
      return jsonResponse(criarBackupAutomaticoDiario());
    }

    if (action === 'getMasterBarbearias') {
      return jsonResponse(getMasterBarbearias());
    }

    return jsonResponse({ success: false, error: 'Ação GET desconhecida: ' + action });
  } catch (err) {
    return handleError(err);
  }
}

/**
 * Manipulador POST (Escrita com LockService + Leituras otimizadas)
 */
function doPost(e) {
  var data = {};
  try {
    if (e && e.postData && e.postData.contents) {
      try {
        data = JSON.parse(e.postData.contents);
      } catch (parseErr) {
        data = e.parameter || {};
      }
    } else if (e && e.parameter) {
      data = e.parameter;
    }
  } catch (err) {
    return jsonResponse({ success: false, error: 'Falha ao processar dados da requisição: ' + err.toString() });
  }

  var action = data.action;
  if (!action) {
    return jsonResponse({ success: false, error: 'Nenhuma ação informada.' });
  }

  // 1. AÇÕES DE LEITURA (Executam concorrentemente sem travar outros usuários)
  if (READ_ACTIONS[action]) {
    try {
      var readResult;
      switch (action) {
        case 'getAllData':
          readResult = getAllData(data.dias);
          break;
        case 'getBarberData':
          readResult = getBarberData(data.barbeiro_id);
          break;
        case 'loginGestor':
          readResult = loginGestor(data.usuario, data.senha);
          break;
        case 'loginBarbeiro':
          readResult = loginBarbeiro(data.login, data.senha);
          break;
        case 'getAgendamentosHistorico':
          readResult = getAgendamentosHistorico(data.data_inicio, data.data_fim);
          break;
        case 'getMasterBarbearias':
          readResult = getMasterBarbearias();
          break;
        default:
          readResult = { success: true };
      }
      return jsonResponse(readResult);
    } catch (readErr) {
      return handleError(readErr);
    }
  }

  // 2. AÇÕES DE ESCRITA (Protegidas com LockService para garantir atomicidade)
  var lock = LockService.getScriptLock();
  var lockAcquired = false;

  try {
    // Aguarda até 20 segundos para adquirir a fila de escrita
    lockAcquired = lock.tryLock(20000);
    if (!lockAcquired) {
      return jsonResponse({
        success: false,
        rateLimit: true,
        error: 'O sistema está temporariamente ocupado processando outra requisição simultânea. Aguarde 2 segundos e tente novamente.'
      });
    }

    var result;
    switch (action) {
      case 'setupDatabase':
        result = setupDatabase();
        break;

      // Super Admin (Painel Master SaaS)
      case 'saveMasterBarbearia':
        result = saveMasterBarbearia(data.barbearia);
        break;
      case 'toggleStatusLicencaMaster':
        result = toggleStatusLicencaMaster(data.id, data.status);
        break;
      case 'renovarVencimentoMaster':
        result = renovarVencimentoMaster(data.id, data.novo_vencimento, data.novo_plano, data.valor_pago);
        break;
      case 'resetSenhaGestorMaster':
        result = resetSenhaGestorMaster(data.id);
        break;
      case 'deleteMasterBarbearia':
        result = deleteMasterBarbearia(data.id);
        break;
      case 'alterarSenhaMaster':
        result = alterarSenhaMaster(data.senha_atual, data.nova_senha);
        break;

      // Gestor Senha & Configurações
      case 'alterarSenhaGestor':
        result = alterarSenhaGestor(
          data.senha_atual || data.senhaAtual,
          data.nova_senha || data.novaSenha,
          data.force === true,
          data.barbearia_id || data.barbeariaId,
          data.login_gestor || data.loginGestor
        );
        break;
      case 'setupPasswordGestor':
        result = alterarSenhaGestor(
          null,
          data.nova_senha || data.novaSenha,
          true,
          data.barbearia_id || data.barbeariaId,
          data.login_gestor || data.loginGestor
        );
        break;
      case 'updateConfig':
        result = updateConfig(data.config);
        break;

      // Barbeiro Senha
      case 'setupPasswordBarbeiro':
        result = setupPasswordBarbeiro(data.barbeiro_id, data.nova_senha);
        break;

      // Clientes
      case 'saveCliente':
        result = saveCliente(data.cliente);
        break;
      case 'deleteCliente':
        result = deleteCliente(data.id);
        break;

      // Produtos & Estoque
      case 'saveProduto':
        result = saveProduto(data.produto);
        break;
      case 'deleteProduto':
        result = deleteProduto(data.id);
        break;

      // Serviços
      case 'saveServico':
        result = saveServico(data.servico);
        break;
      case 'deleteServico':
        result = deleteServico(data.id);
        break;

      // Barbeiros
      case 'saveBarbeiro':
        result = saveBarbeiro(data.barbeiro);
        break;
      case 'resetSenhaBarbeiro':
        result = resetSenhaBarbeiro(data.id);
        break;
      case 'deleteBarbeiro':
        result = deleteBarbeiro(data.id);
        break;

      // Agendamentos & Comandas
      case 'saveAgendamento':
        result = saveAgendamento(data.agendamento);
        break;
      case 'updateAgendamentoStatus':
        result = updateAgendamentoStatus(data.id, data.status, data.forma_pagamento);
        break;
      case 'finalizarAtendimentoComanda':
        result = finalizarAtendimentoComanda(data.id || data.agendamento_id, data.forma_pagamento, data.produtos_consumidos);
        break;
      case 'deleteAgendamento':
        result = deleteAgendamento(data.id);
        break;

      // Caixa & Sangrias
      case 'saveSangria':
        result = saveSangria(data.sangria);
        break;

      // Pagamentos de Barbeiros
      case 'savePagamentoBarbeiro':
        result = savePagamentoBarbeiro(data.pagamento);
        break;

      // Backup Manual e Configuração de Gatilho
      case 'criarBackupAutomaticoDiario':
        result = criarBackupAutomaticoDiario();
        break;
      case 'configurarGatilhoBackupDiario':
        result = configurarGatilhoBackupDiario();
        break;

      default:
        result = { success: false, error: 'Ação de escrita desconhecida: ' + action };
    }

    return jsonResponse(result);

  } catch (err) {
    return handleError(err);
  } finally {
    if (lockAcquired) {
      try {
        lock.releaseLock();
      } catch (e) {}
    }
  }
}

/**
 * Tratamento global de erros com mensagens amigáveis
 */
function handleError(err) {
  var msg = err.toString();
  var isRateLimit = (
    msg.indexOf('Lock timeout') !== -1 ||
    msg.indexOf('Service invoked too many times') !== -1 ||
    msg.indexOf('Too Many Requests') !== -1 ||
    msg.indexOf('Exceeded rate limit') !== -1
  );

  if (isRateLimit) {
    return jsonResponse({
      success: false,
      rateLimit: true,
      error: 'O Google Planilhas atingiu o limite de concorrência temporário. O sistema tentará novamente de forma transparente.'
    });
  }

  return jsonResponse({
    success: false,
    error: 'Erro no servidor: ' + msg
  });
}

/**
 * Resposta formatada em JSON com cabeçalhos apropriados
 */
function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Validador de Senha Obrigatório (Mínimo 6 caracteres, letras e números misturados)
 */
function validarRegraSenha(senha) {
  var s = String(senha || '').trim();
  if (s.length < 6) {
    return { valido: false, error: 'A senha deve conter no mínimo 6 caracteres.' };
  }
  var temLetra = /[a-zA-Z]/.test(s);
  var temNumero = /[0-9]/.test(s);
  if (!temLetra || !temNumero) {
    return { valido: false, error: 'A senha deve conter obrigatoriamente uma mistura de letras e números (ex: corte2026, admin24).' };
  }
  return { valido: true };
}

/**
 * Utilitário: Converte os dados brutos de uma aba em Array de Objetos em Memória
 */
function sheetValuesToObjects(values, displayValues) {
  if (!values || values.length <= 1) return [];
  
  var headers = values[0];
  var rows = [];
  var tz = Session.getScriptTimeZone();
  var numCols = headers.length;
  var numRows = values.length;

  for (var i = 1; i < numRows; i++) {
    var row = values[i];
    var dispRow = (displayValues && displayValues[i]) ? displayValues[i] : null;
    if (!row[0] && !row[1]) continue;

    var obj = {};
    for (var j = 0; j < numCols; j++) {
      var header = String(headers[j] || '').trim();
      var val = row[j];
      var dispVal = dispRow ? String(dispRow[j] || '').trim() : '';

      if (val instanceof Date) {
        if (header === 'horario' || header === 'hora' || val.getFullYear() <= 1900) {
          val = Utilities.formatDate(val, tz, 'HH:mm');
        } else if (header === 'data' || header === 'data_vencimento' || header === 'data_compensacao') {
          val = Utilities.formatDate(val, tz, 'yyyy-MM-dd');
        } else {
          val = Utilities.formatDate(val, tz, 'yyyy-MM-dd HH:mm:ss');
        }
      } else if (typeof val === 'string') {
        var str = val.trim();
        if (header === 'horario' || header === 'hora') {
          if (str.indexOf(' ') !== -1) {
            str = str.split(' ')[1].substring(0, 5);
          } else if (str.indexOf('T') !== -1) {
            str = str.split('T')[1].substring(0, 5);
          } else {
            str = str.substring(0, 5);
          }
          val = str;
        } else if (header === 'data' || header === 'data_vencimento' || header === 'data_compensacao') {
          if (str.indexOf('T') !== -1) str = str.split('T')[0];
          if (str.indexOf(' ') !== -1) str = str.split(' ')[0];
          val = str;
        }
      } else if (val === '' && dispVal) {
        val = dispVal;
      }

      obj[header] = val;
    }
    rows.push(obj);
  }
  return rows;
}

/**
 * Obter ou criar uma aba com cabeçalho formatado
 */
function getOrCreateSheet(ss, name, headers) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    if (headers && headers.length > 0) {
      sheet.appendRow(headers);
      var headerRange = sheet.getRange(1, 1, 1, headers.length);
      headerRange.setBackground('#1e293b');
      headerRange.setFontColor('#fbbf24');
      headerRange.setFontWeight('bold');
    }
  } else if (headers && headers.length > 0 && sheet.getLastRow() >= 1) {
    var lastCol = sheet.getLastColumn();
    var existingHeaders = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
    if (existingHeaders.length < headers.length) {
      for (var h = existingHeaders.length; h < headers.length; h++) {
        var cell = sheet.getRange(1, h + 1);
        cell.setValue(headers[h]);
        cell.setBackground('#1e293b');
        cell.setFontColor('#fbbf24');
        cell.setFontWeight('bold');
      }
    }
  }
  return sheet;
}

/**
 * Inicialização e Estruturação Automática do Banco SaaS no Google Planilhas
 */
function setupDatabase() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error('Planilha ativa não encontrada. Abra o editor diretamente da planilha.');
  }

  // 0. Master_Barbearias (Super Admin - Rafael Martins)
  var sMaster = getOrCreateSheet(ss, SHEETS.MASTER, [
    'id', 'nome_barbearia', 'responsavel', 'telefone', 'login_gestor',
    'senha_gestor', 'plano', 'valor_pago', 'forma_pagamento_pix',
    'data_vencimento', 'status_licenca', 'api_url', 'criado_em'
  ]);
  if (sMaster.getLastRow() <= 1) {
    var tz = Session.getScriptTimeZone();
    var agora = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm:ss');
    var d30 = Utilities.formatDate(new Date(new Date().getTime() + 30*24*60*60*1000), tz, 'yyyy-MM-dd');
    var d60 = Utilities.formatDate(new Date(new Date().getTime() + 60*24*60*60*1000), tz, 'yyyy-MM-dd');

    sMaster.appendRow([
      'BARB-1', 'Barbearia Vintage & Estilo', 'Marcos Silva', '(11) 99111-2233',
      'Barbearia_VintageEstilo', 'abc123', 'Mensal', 149.90, 'PIX', d30, 'ATIVA', '', agora
    ]);
    sMaster.appendRow([
      'BARB-2', 'Navalha de Ouro', 'Carlos Eduardo', '(11) 98877-6655',
      'Barbearia_NavalhaOuro', 'abc123', 'Trimestral', 399.90, 'PIX', d60, 'ATIVA', '', agora
    ]);
  }

  // 1. Configuracoes
  var sConf = getOrCreateSheet(ss, SHEETS.CONFIG, ['chave', 'valor', 'descricao']);
  var cData = sConf.getDataRange().getValues();
  var existingKeys = {};
  for (var i = 1; i < cData.length; i++) {
    if (cData[i][0]) existingKeys[cData[i][0]] = true;
  }

  var defaultConfigs = [
    ['superadmin_login', 'Rafael_Martins', 'Login do Dono do SaaS'],
    ['superadmin_senha', 'RSNf14232603*', 'Senha do Dono do SaaS'],
    ['nome_barbearia', 'GESTÃO PROFISSIONAL DE BARBEARIA', 'Nome da barbearia exibido em todo o sistema'],
    ['logo_url', '', 'URL da foto/logo da barbearia (vazio = logo padrão com tesoura e máquina)'],
    ['status_licenca', 'ATIVA', 'Status da Licença SaaS (ATIVA / BLOQUEADA)'],
    ['telefone_barbearia', '(31) 98620-3735', 'Telefone/WhatsApp de contato da barbearia'],
    ['chave_pix', '31986203735', 'Chave PIX oficial para recebimentos e assinaturas (Rafael Martins)'],
    ['suporte_whatsapp', '5531986203735', 'WhatsApp do Suporte SaaS / Rafael Martins'],
    ['taxa_pix_pct', 0, 'Taxa percentual cobrada em transações PIX (%)'],
    ['prazo_pix_dias', 0, 'Prazo de compensação do PIX em dias úteis (0 = D+0 imediato)'],
    ['taxa_debito_pct', 1.99, 'Taxa percentual de Cartão de Débito (%)'],
    ['prazo_debito_dias', 1, 'Prazo de compensação de Débito em dias úteis (1 = D+1)'],
    ['taxa_credito_pct', 3.99, 'Taxa percentual de Cartão de Crédito (%)'],
    ['prazo_credito_dias', 30, 'Prazo de compensação de Crédito em dias corridos/úteis (30 = D+30)']
  ];

  for (var d = 0; d < defaultConfigs.length; d++) {
    var key = defaultConfigs[d][0];
    if (!existingKeys[key]) {
      sConf.appendRow(defaultConfigs[d]);
    }
  }

  // 2. Clientes
  var sCli = getOrCreateSheet(ss, SHEETS.CLIENTES, ['id', 'nome', 'telefone', 'criado_em']);
  if (sCli.getLastRow() <= 1) {
    sCli.appendRow(['CLI-1', 'Carlos Mendes', '11999887766', '2026-03-01 10:00:00']);
    sCli.appendRow(['CLI-2', 'Rafael Souza', '11988776655', '2026-03-01 11:30:00']);
    sCli.appendRow(['CLI-3', 'Lucas Almeida', '11977665544', '2026-03-02 09:15:00']);
  }

  // 3. Produtos
  var sProd = getOrCreateSheet(ss, SHEETS.PRODUTOS, ['id', 'nome', 'preco', 'estoque', 'criado_em']);
  if (sProd.getLastRow() <= 1) {
    sProd.appendRow(['PRD-1', 'Pomada Modeladora Efeito Matte', 45.00, 15, '2026-03-01 10:00:00']);
    sProd.appendRow(['PRD-2', 'Óleo para Barba Hidratante 30ml', 38.00, 2, '2026-03-01 10:00:00']); // Estoque Crítico (<3) para teste
    sProd.appendRow(['PRD-3', 'Shampoo Anticaspa Tea Tree', 42.00, 8, '2026-03-01 10:00:00']);
    sProd.appendRow(['PRD-4', 'Cerveja Artesanal IPA 500ml', 14.00, 24, '2026-03-01 10:00:00']);
  }

  // 4. Servicos
  var sServ = getOrCreateSheet(ss, SHEETS.SERVICOS, ['id', 'nome', 'preco', 'duracao_min', 'criado_em']);
  if (sServ.getLastRow() <= 1) {
    sServ.appendRow(['SRV-1', 'Corte Degradê / Moderno', 45.00, 40, '2026-03-01 10:00:00']);
    sServ.appendRow(['SRV-2', 'Barba Terapia com Toalha Quente', 35.00, 30, '2026-03-01 10:00:00']);
    sServ.appendRow(['SRV-3', 'Combo Completo (Corte + Barba)', 70.00, 60, '2026-03-01 10:00:00']);
    sServ.appendRow(['SRV-4', 'Pezinho e Sobrancelha', 20.00, 20, '2026-03-01 10:00:00']);
  }

  // 5. Barbeiros
  var sBarb = getOrCreateSheet(ss, SHEETS.BARBEIROS, ['id', 'nome', 'telefone', 'login', 'senha', 'comissao_pct', 'ativo', 'criado_em']);
  if (sBarb.getLastRow() <= 1) {
    sBarb.appendRow(['BRB-1', 'João Carlos da Silva', '11991112233', 'Joao_Silva', '', 50, 'SIM', '2026-03-01 10:00:00']);
    sBarb.appendRow(['BRB-2', 'Marcos Vinicius Santos', '11992223344', 'Marcos_Santos', '', 60, 'SIM', '2026-03-01 10:00:00']);
  }

  // 6. Agendamentos
  var sAg = getOrCreateSheet(ss, SHEETS.AGENDAMENTOS, [
    'id', 'cliente_nome', 'cliente_telefone', 'servico_id', 'servico_nome',
    'servico_preco', 'barbeiro_id', 'barbeiro_nome', 'data', 'horario',
    'status', 'forma_pagamento', 'comissao_valor', 'criado_em', 'produtos_consumidos', 'total_venda',
    'taxa_aplicada_valor', 'valor_liquido', 'data_compensacao'
  ]);
  if (sAg.getLastRow() <= 1) {
    var hoje = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
    sAg.appendRow([
      'AGD-1', 'Carlos Mendes', '11999887766', 'SRV-1', 'Corte Degradê / Moderno',
      45.00, 'BRB-1', 'João Carlos da Silva', hoje, '09:00',
      'Concluido', 'PIX', 22.50, hoje + ' 08:00:00', '[]', 45.00,
      0.00, 45.00, hoje
    ]);
    sAg.appendRow([
      'AGD-2', 'Rafael Souza', '11988776655', 'SRV-3', 'Combo Completo (Corte + Barba)',
      70.00, 'BRB-1', 'João Carlos da Silva', hoje, '10:00',
      'Concluido', 'Dinheiro', 35.00, hoje + ' 08:30:00', '[]', 70.00,
      0.00, 70.00, hoje
    ]);
    sAg.appendRow([
      'AGD-3', 'Lucas Almeida', '11977665544', 'SRV-2', 'Barba Terapia com Toalha Quente',
      35.00, 'BRB-2', 'Marcos Vinicius Santos', hoje, '11:00',
      'Agendado', 'Pendente', 21.00, hoje + ' 09:00:00', '[]', 35.00,
      0.00, 35.00, hoje
    ]);
  }

  // 7. Caixa_Sangrias
  getOrCreateSheet(ss, SHEETS.SANGRIAS, ['id', 'valor', 'motivo', 'data_hora', 'usuario']);

  // 8. Pagamentos_Barbeiros
  getOrCreateSheet(ss, SHEETS.PAGAMENTOS, ['id', 'barbeiro_id', 'barbeiro_nome', 'valor', 'forma_pagamento', 'observacao', 'data_hora']);

  // Configura automaticamente o gatilho diário de backup
  configurarGatilhoBackupDiario();

  return {
    success: true,
    message: 'Banco de dados SaaS estruturado, verificado e backup diário agendado com sucesso!'
  };
}

/**
 * Retorna dados para o Painel do Gestor com Lazy Loading (Últimos 7 dias + Futuros)
 */
function getAllData(diasHistorico) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tz = Session.getScriptTimeZone();
  
  // 1. Configuracoes
  var configs = {};
  var sConf = ss.getSheetByName(SHEETS.CONFIG);
  if (sConf) {
    var cRows = sConf.getDataRange().getValues();
    for (var i = 1; i < cRows.length; i++) {
      if (cRows[i][0]) configs[cRows[i][0]] = cRows[i][1];
    }
  }

  // 2. Leitura otimizada das abas
  var getSheetData = function(name) {
    var sh = ss.getSheetByName(name);
    if (!sh) return [];
    var range = sh.getDataRange();
    return sheetValuesToObjects(range.getValues(), range.getDisplayValues());
  };

  var clientes = getSheetData(SHEETS.CLIENTES);
  var produtos = getSheetData(SHEETS.PRODUTOS);
  var servicos = getSheetData(SHEETS.SERVICOS);
  var barbeiros = getSheetData(SHEETS.BARBEIROS);
  var allAgendamentos = getSheetData(SHEETS.AGENDAMENTOS);
  var allSangrias = getSheetData(SHEETS.SANGRIAS);
  var allPagamentos = getSheetData(SHEETS.PAGAMENTOS);

  // Paginação e filtro de carga: por padrão traz os últimos 7 dias e todos os futuros
  var limiteDias = (typeof diasHistorico === 'number') ? diasHistorico : 7;
  var dRef = new Date();
  dRef.setDate(dRef.getDate() - limiteDias);
  var dataLimiteStr = Utilities.formatDate(dRef, tz, 'yyyy-MM-dd');

  var agendamentosFiltrados = allAgendamentos.filter(function(a) {
    return !a.data || a.data >= dataLimiteStr;
  });

  return {
    success: true,
    config: configs,
    status_licenca: configs.status_licenca || 'ATIVA',
    clientes: clientes,
    produtos: produtos,
    servicos: servicos,
    barbeiros: barbeiros,
    agendamentos: agendamentosFiltrados,
    totalAgendamentosCadastrados: allAgendamentos.length,
    sangrias: allSangrias,
    pagamentosBarbeiros: allPagamentos,
    timestamp: new Date().toISOString()
  };
}

/**
 * Busca histórico estendido de agendamentos para um período específico
 */
function getAgendamentosHistorico(dataInicio, dataFim) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEETS.AGENDAMENTOS);
  if (!sh) return { success: false, error: 'Aba de agendamentos não encontrada.' };

  var range = sh.getDataRange();
  var all = sheetValuesToObjects(range.getValues(), range.getDisplayValues());
  var filtrados = all.filter(function(a) {
    if (!a.data) return false;
    if (dataInicio && a.data < dataInicio) return false;
    if (dataFim && a.data > dataFim) return false;
    return true;
  });

  return {
    success: true,
    agendamentos: filtrados,
    total: filtrados.length
  };
}

/**
 * Retorna dados restritos apenas para o Barbeiro logado
 */
function getBarberData(barberId) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  
  // Configs essenciais
  var configs = {};
  var sConf = ss.getSheetByName(SHEETS.CONFIG);
  if (sConf) {
    var cRows = sConf.getDataRange().getValues();
    for (var i = 1; i < cRows.length; i++) {
      if (cRows[i][0]) configs[cRows[i][0]] = cRows[i][1];
    }
  }

  // Trava de licença SaaS
  if (configs.status_licenca === 'BLOQUEADA') {
    return {
      success: false,
      bloqueado: true,
      error: 'O acesso da barbearia está temporariamente suspenso. Contate o gestor.'
    };
  }

  // Barbeiro
  var sBarb = ss.getSheetByName(SHEETS.BARBEIROS);
  var barbeiro = null;
  if (sBarb) {
    var bVals = sBarb.getDataRange().getValues();
    var bHeaders = bVals[0];
    for (var i = 1; i < bVals.length; i++) {
      if (String(bVals[i][0]) === String(barberId)) {
        barbeiro = {};
        for (var j = 0; j < bHeaders.length; j++) {
          if (bHeaders[j] !== 'senha') {
            barbeiro[bHeaders[j]] = bVals[i][j];
          }
        }
        break;
      }
    }
  }

  if (!barbeiro) {
    return { success: false, error: 'Barbeiro não localizado.' };
  }

  // Agendamentos deste barbeiro
  var sAg = ss.getSheetByName(SHEETS.AGENDAMENTOS);
  var agendamentosBarbeiro = [];
  if (sAg) {
    var rAg = sAg.getDataRange();
    var allAg = sheetValuesToObjects(rAg.getValues(), rAg.getDisplayValues());
    agendamentosBarbeiro = allAg.filter(function(a) {
      return String(a.barbeiro_id) === String(barberId);
    });
  }

  // Pagamentos deste barbeiro
  var sPag = ss.getSheetByName(SHEETS.PAGAMENTOS);
  var pagamentosBarbeiro = [];
  if (sPag) {
    var rPag = sPag.getDataRange();
    var allPag = sheetValuesToObjects(rPag.getValues(), rPag.getDisplayValues());
    pagamentosBarbeiro = allPag.filter(function(p) {
      return String(p.barbeiro_id) === String(barberId);
    });
  }

  return {
    success: true,
    config: {
      nome_barbearia: configs.nome_barbearia || 'GESTÃO PROFISSIONAL DE BARBEARIA',
      logo_url: configs.logo_url || '',
      status_licenca: configs.status_licenca || 'ATIVA'
    },
    barbeiro: barbeiro,
    agendamentos: agendamentosBarbeiro,
    pagamentos: pagamentosBarbeiro,
    timestamp: new Date().toISOString()
  };
}

/**
 * Login do Gestor ou Super Admin (Rafael_Martins) com Verificação de Licença SaaS e Vencimento
 */
function loginGestor(usuarioInformado, senhaInformada) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var userTrim = String(usuarioInformado || '').trim();
  var senhaTrim = String(senhaInformada || '').trim();
  var tz = Session.getScriptTimeZone();
  var hoje = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');

  // 1. VERIFICAÇÃO EXCLUSIVA SUPER ADMIN (DONO DO SAAS)
  if (userTrim.toLowerCase() === 'rafael_martins') {
    var sConf = ss.getSheetByName(SHEETS.CONFIG);
    var superSenha = 'RSNf14232603*';
    if (sConf) {
      var cRows = sConf.getDataRange().getValues();
      for (var i = 1; i < cRows.length; i++) {
        if (cRows[i][0] === 'superadmin_senha' && cRows[i][1]) {
          superSenha = String(cRows[i][1]).trim();
          break;
        }
      }
    }

    if (senhaTrim !== superSenha) {
      return { success: false, error: 'Senha incorreta para acesso do Super Admin.' };
    }

    return {
      success: true,
      perfil: 'master',
      usuario: 'Rafael_Martins',
      nome: 'Rafael Martins (Dono do SaaS)',
      message: 'Bem-vindo ao Painel Master, Rafael Martins!'
    };
  }

  // 2. VERIFICAÇÃO DE GESTOR NA ABA MASTER (Multi-Barbearias)
  var sMaster = ss.getSheetByName(SHEETS.MASTER);
  if (sMaster) {
    var mData = sMaster.getDataRange().getValues();
    if (mData.length > 1) {
      var mHeaders = mData[0];
      var loginCol = mHeaders.indexOf('login_gestor');
      var senhaCol = mHeaders.indexOf('senha_gestor');
      var statusCol = mHeaders.indexOf('status_licenca');
      var vencCol = mHeaders.indexOf('data_vencimento');
      var nomeCol = mHeaders.indexOf('nome_barbearia');
      var idCol = mHeaders.indexOf('id');
      var respCol = mHeaders.indexOf('responsavel');
      var telCol = mHeaders.indexOf('telefone');
      var planoCol = mHeaders.indexOf('plano');

      for (var m = 1; m < mData.length; m++) {
        var barbLogin = String(mData[m][loginCol] || '').trim();
        if (barbLogin.toLowerCase() === userTrim.toLowerCase()) {
          var barbStatus = String(mData[m][statusCol] || 'ATIVA').trim();
          var barbVenc = String(mData[m][vencCol] || '').trim();
          var barbSenha = String(mData[m][senhaCol] || 'abc123').trim();
          var barbNome = String(mData[m][nomeCol] || 'Barbearia');
          var barbId = String(mData[m][idCol]);

          // Verificação de Licença Bloqueada
          if (barbStatus === 'BLOQUEADA') {
            return {
              success: false,
              bloqueado: true,
              motivo: 'bloqueada',
              nome_barbearia: barbNome,
              suporte_whatsapp: '5511999999999',
              error: 'Acesso suspenso pelo administrador do sistema. Contate Rafael Martins para regularização via PIX.'
            };
          }

          // Verificação de Licença Vencida
          if (barbVenc && barbVenc < hoje) {
            return {
              success: false,
              bloqueado: true,
              motivo: 'vencida',
              data_vencimento: barbVenc,
              nome_barbearia: barbNome,
              suporte_whatsapp: '5511999999999',
              error: 'Assinatura vencida em ' + barbVenc + '. Renove via PIX com Rafael Martins para desbloquear o sistema.'
            };
          }

          // Verificação de Senha
          if (senhaTrim !== barbSenha) {
            return { success: false, error: 'Senha incorreta para a barbearia "' + barbNome + '".' };
          }

          var isPrimeiroAcesso = (barbSenha === 'abc123');

          return {
            success: true,
            perfil: 'gestor',
            barbearia_id: barbId,
            nome_barbearia: barbNome,
            responsavel: mData[m][respCol] || '',
            telefone: mData[m][telCol] || '',
            plano: mData[m][planoCol] || 'Mensal',
            usuario: barbLogin,
            primeiroAcessoGestor: isPrimeiroAcesso,
            status_licenca: barbStatus,
            data_vencimento: barbVenc,
            message: isPrimeiroAcesso
              ? 'Primeiro acesso detectado com a senha padrão "abc123". Cadastre sua nova senha pessoal definitiva.'
              : 'Bem-vindo ao Painel da Barbearia ' + barbNome + '!'
          };
        }
      }
    }
  }

  // 3. Fallback: Verificação na aba Configuracoes local (caso de implantação isolada)
  var sConfLocal = ss.getSheetByName(SHEETS.CONFIG);
  if (sConfLocal) {
    var cRowsLocal = sConfLocal.getDataRange().getValues();
    var configsLocal = {};
    for (var k = 1; k < cRowsLocal.length; k++) {
      if (cRowsLocal[k][0]) configsLocal[cRowsLocal[k][0]] = String(cRowsLocal[k][1] || '').trim();
    }

    if (configsLocal.status_licenca === 'BLOQUEADA') {
      return {
        success: false,
        bloqueado: true,
        motivo: 'bloqueada',
        suporte_whatsapp: configsLocal.suporte_whatsapp || '5511999999999',
        error: 'Acesso Temporariamente Suspenso - Assinatura da barbearia bloqueada.'
      };
    }

    if (configsLocal.data_vencimento && configsLocal.data_vencimento < hoje) {
      return {
        success: false,
        bloqueado: true,
        motivo: 'vencida',
        data_vencimento: configsLocal.data_vencimento,
        suporte_whatsapp: configsLocal.suporte_whatsapp || '5511999999999',
        error: 'Assinatura vencida em ' + configsLocal.data_vencimento + '. Renove via PIX.'
      };
    }

    var usuarioCorreto = configsLocal.usuario_gestor || '';
    var senhaCorreta = configsLocal.senha_gestor || 'abc123';

    if (usuarioCorreto && userTrim.toLowerCase() === usuarioCorreto.toLowerCase()) {
      if (senhaTrim !== senhaCorreta) {
        return { success: false, error: 'Senha incorreta para acesso de Gestor.' };
      }
      var isPrimeiroAcessoLocal = (senhaCorreta === 'abc123');
      return {
        success: true,
        perfil: 'gestor',
        usuario: usuarioCorreto,
        primeiroAcessoGestor: isPrimeiroAcessoLocal,
        status_licenca: configsLocal.status_licenca || 'ATIVA'
      };
    }
  }

  return { success: false, error: 'Usuário não localizado no sistema.' };
}

/**
 * Alteração de Senha do Gestor com Validação Rigorosa (Persiste na aba Master e Configurações)
 */
function alterarSenhaGestor(senhaAtual, novaSenha, force, barbeariaId, loginGestor) {
  var valid = validarRegraSenha(novaSenha);
  if (!valid.valido) {
    return { success: false, error: valid.error };
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var novaSenhaLimpa = String(novaSenha).trim();

  // 1. Atualiza na aba Master_Barbearias se localizada
  var sMaster = ss.getSheetByName(SHEETS.MASTER);
  if (sMaster && (barbeariaId || loginGestor)) {
    var dataM = sMaster.getDataRange().getValues();
    for (var m = 1; m < dataM.length; m++) {
      if ((barbeariaId && String(dataM[m][0]) === String(barbeariaId)) ||
          (loginGestor && String(dataM[m][4]).toLowerCase() === String(loginGestor).toLowerCase())) {
        sMaster.getRange(m + 1, 6).setValue(novaSenhaLimpa); // coluna 6 = senha_gestor
        break;
      }
    }
  }

  // 2. Atualiza na aba Configuracoes
  var sConf = ss.getSheetByName(SHEETS.CONFIG);
  if (sConf) {
    var data = sConf.getDataRange().getValues();
    var rowIndex = -1;
    var senhaAtualNoBanco = 'abc123';

    for (var i = 1; i < data.length; i++) {
      if (data[i][0] === 'senha_gestor') {
        rowIndex = i;
        senhaAtualNoBanco = String(data[i][1] || '').trim();
        break;
      }
    }

    if (!force && senhaAtual && String(senhaAtual).trim() !== senhaAtualNoBanco) {
      return { success: false, error: 'A senha atual informada está incorreta.' };
    }

    if (rowIndex !== -1) {
      sConf.getRange(rowIndex + 1, 2).setValue(novaSenhaLimpa);
    } else {
      sConf.appendRow(['senha_gestor', novaSenhaLimpa, 'Senha de acesso do Gestor']);
    }
  }

  return {
    success: true,
    message: 'Senha do gestor atualizada com sucesso! Utilize sua nova senha em seus próximos acessos.'
  };
}

/**
 * Login do Barbeiro com detecção de Primeiro Acesso, Senha Resetada e Licença SaaS
 */
function loginBarbeiro(login, senha) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tz = Session.getScriptTimeZone();
  var hoje = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  
  // Verifica licença SaaS na aba Master ou Config
  var sConf = ss.getSheetByName(SHEETS.CONFIG);
  if (sConf) {
    var cRows = sConf.getDataRange().getValues();
    for (var k = 1; k < cRows.length; k++) {
      if (cRows[k][0] === 'status_licenca' && String(cRows[k][1]).trim() === 'BLOQUEADA') {
        return {
          success: false,
          bloqueado: true,
          error: 'O acesso da barbearia está suspenso. Contate o gestor.'
        };
      }
      if (cRows[k][0] === 'data_vencimento' && cRows[k][1] && String(cRows[k][1]).trim() < hoje) {
        return {
          success: false,
          bloqueado: true,
          error: 'A assinatura do sistema desta barbearia está vencida. Contate o gestor.'
        };
      }
    }
  }

  var sBarb = ss.getSheetByName(SHEETS.BARBEIROS);
  if (!sBarb) return { success: false, error: 'Aba de barbeiros não encontrada.' };

  var data = sBarb.getDataRange().getValues();
  var headers = data[0];
  var loginCol = headers.indexOf('login');
  var senhaCol = headers.indexOf('senha');
  var idCol = headers.indexOf('id');
  var nomeCol = headers.indexOf('nome');

  if (loginCol === -1 || senhaCol === -1) {
    return { success: false, error: 'Estrutura da aba de barbeiros inválida.' };
  }

  var loginTrim = String(login || '').trim().toLowerCase();
  var barbeiroEncontrado = null;
  var rowIndex = -1;

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][loginCol]).trim().toLowerCase() === loginTrim) {
      rowIndex = i;
      barbeiroEncontrado = {
        id: data[i][idCol],
        nome: data[i][nomeCol],
        login: data[i][loginCol],
        comissao_pct: data[i][headers.indexOf('comissao_pct')] || 50,
        telefone: data[i][headers.indexOf('telefone')] || ''
      };
      break;
    }
  }

  if (!barbeiroEncontrado) {
    return { success: false, error: 'Login de barbeiro não encontrado.' };
  }

  var senhaCadastrada = String(data[rowIndex][senhaCol] || '').trim();

  // Primeiro acesso (senha vazia)
  if (senhaCadastrada === '') {
    return {
      success: true,
      primeiroAcesso: true,
      redefinidaPadrao: false,
      barbeiro: barbeiroEncontrado,
      message: 'Primeiro acesso detectado. Por favor, defina sua senha pessoal (mínimo 6 caracteres com letras e números).'
    };
  }

  // Senha redefinida pelo gestor para o padrão 'abc123'
  if (senhaCadastrada === 'abc123' && String(senha).trim() === 'abc123') {
    return {
      success: true,
      primeiroAcesso: true,
      redefinidaPadrao: true,
      barbeiro: barbeiroEncontrado,
      message: 'Sua senha foi redefinida para o padrão temporário "abc123". Por favor, cadastre sua nova senha definitiva (mínimo 6 caracteres com letras e números).'
    };
  }

  // Validação normal
  if (senhaCadastrada === String(senha).trim()) {
    return {
      success: true,
      primeiroAcesso: false,
      perfil: 'barbeiro',
      barbeiro: barbeiroEncontrado
    };
  } else {
    return { success: false, error: 'Senha incorreta.' };
  }
}

/**
 * Primeiro Acesso ou Alteração de Senha do Barbeiro com Validação Rigorosa
 */
function setupPasswordBarbeiro(barbeiroId, novaSenha) {
  var valid = validarRegraSenha(novaSenha);
  if (!valid.valido) {
    return { success: false, error: valid.error };
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sBarb = ss.getSheetByName(SHEETS.BARBEIROS);
  var data = sBarb.getDataRange().getValues();
  var headers = data[0];
  var senhaCol = headers.indexOf('senha');

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(barbeiroId)) {
      sBarb.getRange(i + 1, senhaCol + 1).setValue(String(novaSenha).trim());
      return { success: true, message: 'Senha atualizada com sucesso! Faça login com sua nova senha.' };
    }
  }

  return { success: false, error: 'Barbeiro não localizado.' };
}

/**
 * Reset de Senha do Barbeiro pelo Gestor
 * Regra: Volta obrigatoriamente para a senha padrão 'abc123'
 */
function resetSenhaBarbeiro(barbeiroId) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sBarb = ss.getSheetByName(SHEETS.BARBEIROS);
  var data = sBarb.getDataRange().getValues();
  var headers = data[0];
  var senhaCol = headers.indexOf('senha');

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(barbeiroId)) {
      sBarb.getRange(i + 1, senhaCol + 1).setValue('abc123');
      return {
        success: true,
        message: 'Senha resetada com sucesso para o padrão "abc123"! O barbeiro deverá cadastrar nova senha ao entrar.'
      };
    }
  }
  return { success: false, error: 'Barbeiro não localizado.' };
}

/**
 * Atualizar Configurações da Barbearia
 */
function updateConfig(newConfig) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sConf = ss.getSheetByName(SHEETS.CONFIG);
  if (!sConf) sConf = getOrCreateSheet(ss, SHEETS.CONFIG, ['chave', 'valor', 'descricao']);

  var data = sConf.getDataRange().getValues();
  var keysPresent = {};

  for (var i = 1; i < data.length; i++) {
    var key = data[i][0];
    keysPresent[key] = i;
    if (newConfig.hasOwnProperty(key)) {
      data[i][1] = newConfig[key];
    }
  }

  // Insere chaves que não existiam
  for (var k in newConfig) {
    if (!keysPresent.hasOwnProperty(k)) {
      data.push([k, newConfig[k], 'Configuração personalizada']);
    }
  }

  sConf.getRange(1, 1, data.length, data[0].length).setValues(data);
  return { success: true, message: 'Configurações salvas com sucesso!' };
}

/**
 * Salvar Cliente
 */
function saveCliente(cli) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEETS.CLIENTES);
  var data = sheet.getDataRange().getValues();
  var now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');

  if (cli.id) {
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(cli.id)) {
        var row = [cli.id, cli.nome, cli.telefone, data[i][3] || now];
        sheet.getRange(i + 1, 1, 1, 4).setValues([row]);
        return { success: true, message: 'Cliente atualizado com sucesso!' };
      }
    }
  }

  var newId = 'CLI-' + data.length;
  sheet.appendRow([newId, cli.nome, cli.telefone, now]);
  return { success: true, message: 'Cliente cadastrado com sucesso!', id: newId };
}

function deleteCliente(id) {
  return deleteRowById(SHEETS.CLIENTES, id);
}

/**
 * Salvar Produto
 */
function saveProduto(prod) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEETS.PRODUTOS);
  var data = sheet.getDataRange().getValues();
  var now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');

  var preco = parseFloat(prod.preco) || 0;
  var estoque = parseInt(prod.estoque) || 0;

  if (prod.id) {
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(prod.id)) {
        var row = [prod.id, prod.nome, preco, estoque, data[i][4] || now];
        sheet.getRange(i + 1, 1, 1, 5).setValues([row]);
        return { success: true, message: 'Produto atualizado com sucesso!' };
      }
    }
  }

  var newId = 'PRD-' + data.length;
  sheet.appendRow([newId, prod.nome, preco, estoque, now]);
  return { success: true, message: 'Produto cadastrado com sucesso!', id: newId };
}

function deleteProduto(id) {
  return deleteRowById(SHEETS.PRODUTOS, id);
}

/**
 * Salvar Serviço
 */
function saveServico(srv) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEETS.SERVICOS);
  var data = sheet.getDataRange().getValues();
  var now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');

  var preco = parseFloat(srv.preco) || 0;
  var duracao = parseInt(srv.duracao_min) || 30;

  if (srv.id) {
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(srv.id)) {
        var row = [srv.id, srv.nome, preco, duracao, data[i][4] || now];
        sheet.getRange(i + 1, 1, 1, 5).setValues([row]);
        return { success: true, message: 'Serviço atualizado com sucesso!' };
      }
    }
  }

  var newId = 'SRV-' + data.length;
  sheet.appendRow([newId, srv.nome, preco, duracao, now]);
  return { success: true, message: 'Serviço cadastrado com sucesso!', id: newId };
}

function deleteServico(id) {
  return deleteRowById(SHEETS.SERVICOS, id);
}

/**
 * Salvar Barbeiro (com login automático)
 */
function saveBarbeiro(barb) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEETS.BARBEIROS);
  var data = sheet.getDataRange().getValues();
  var now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
  var comissao = parseFloat(barb.comissao_pct) || 50;

  if (barb.id) {
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(barb.id)) {
        var row = [
          barb.id,
          barb.nome,
          barb.telefone,
          data[i][3], // preserva login
          data[i][4], // preserva senha
          comissao,
          barb.ativo || data[i][6] || 'SIM',
          data[i][7] || now
        ];
        sheet.getRange(i + 1, 1, 1, 8).setValues([row]);
        return { success: true, message: 'Barbeiro atualizado com sucesso!' };
      }
    }
  }

  var loginBase = gerarLoginBarbeiro(barb.nome);
  var loginFinal = loginBase;
  var contador = 2;

  var loginsExistentes = {};
  for (var i = 1; i < data.length; i++) {
    loginsExistentes[String(data[i][3]).toLowerCase()] = true;
  }
  while (loginsExistentes[loginFinal.toLowerCase()]) {
    loginFinal = loginBase + '_' + contador;
    contador++;
  }

  var newId = 'BRB-' + data.length;
  sheet.appendRow([newId, barb.nome, barb.telefone, loginFinal, '', comissao, 'SIM', now]);
  return {
    success: true,
    message: 'Barbeiro cadastrado com sucesso! Login gerado: ' + loginFinal,
    id: newId,
    login: loginFinal
  };
}

function deleteBarbeiro(id) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEETS.BARBEIROS);
  if (!sheet) return { success: false, error: 'Aba Barbeiros não encontrada.' };

  var data = sheet.getDataRange().getValues();
  var barbRow = -1;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(id)) {
      barbRow = i + 1;
      break;
    }
  }
  if (barbRow === -1) {
    return { success: false, error: 'Barbeiro não encontrado.' };
  }

  // Verifica se o barbeiro possui histórico em Agendamentos ou Pagamentos
  var temHistorico = false;
  var sAg = ss.getSheetByName(SHEETS.AGENDAMENTOS);
  if (sAg) {
    var agData = sAg.getDataRange().getValues();
    for (var a = 1; a < agData.length; a++) {
      if (String(agData[a][6]) === String(id)) { // coluna 6: barbeiro_id
        temHistorico = true;
        break;
      }
    }
  }

  if (!temHistorico) {
    var sPag = ss.getSheetByName(SHEETS.PAGAMENTOS);
    if (sPag) {
      var pagData = sPag.getDataRange().getValues();
      for (var p = 1; p < pagData.length; p++) {
        if (String(pagData[p][1]) === String(id)) { // coluna 1: barbeiro_id
          temHistorico = true;
          break;
        }
      }
    }
  }

  if (temHistorico) {
    // Soft delete: atualiza coluna 'ativo' (coluna 7) para 'NAO'
    sheet.getRange(barbRow, 7).setValue('NAO');
    return {
      success: true,
      message: 'Barbeiro desativado com sucesso (histórico preservado)!',
      softDelete: true
    };
  } else {
    // Hard delete: remove a linha
    sheet.deleteRow(barbRow);
    return {
      success: true,
      message: 'Barbeiro excluído com sucesso!'
    };
  }
}

/**
 * Utilitário: Calcula a data de compensação bancária considerando apenas dias úteis
 * Pula Sábados e Domingos
 */
function calcularDataCompensacao(dataStr, diasUteis) {
  if (!diasUteis || diasUteis <= 0) return dataStr;
  var partes = String(dataStr).split('-');
  if (partes.length < 3) return dataStr;
  var ano = parseInt(partes[0], 10);
  var mes = parseInt(partes[1], 10) - 1;
  var dia = parseInt(partes[2], 10);
  var dt = new Date(ano, mes, dia);
  var restantes = parseInt(diasUteis, 10);
  while (restantes > 0) {
    dt.setDate(dt.getDate() + 1);
    var dw = dt.getDay(); // 0 = Domingo, 6 = Sábado
    if (dw !== 0 && dw !== 6) {
      restantes--;
    }
  }
  return Utilities.formatDate(dt, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

/**
 * Utilitário: Lê as configurações de taxas bancárias da planilha
 */
function getTaxasConfig(ss) {
  var sConf = ss.getSheetByName(SHEETS.CONFIG);
  var cfg = {
    taxa_pix_pct: 0,
    prazo_pix_dias: 0,
    taxa_debito_pct: 1.99,
    prazo_debito_dias: 1,
    taxa_credito_pct: 3.99,
    prazo_credito_dias: 30
  };
  if (sConf) {
    var rows = sConf.getDataRange().getValues();
    for (var i = 1; i < rows.length; i++) {
      var k = String(rows[i][0] || '').trim();
      var v = rows[i][1];
      if (cfg.hasOwnProperty(k)) {
        cfg[k] = parseFloat(v) || 0;
      }
    }
  }
  return cfg;
}

/**
 * Utilitário: Calcula taxa da maquininha, valor líquido e data de compensação
 */
function calcularTaxaECompensacaoBackend(valorTotal, formaPagamento, cfg, dataTransacao) {
  var valor = parseFloat(valorTotal) || 0;
  var forma = String(formaPagamento || '').trim();
  var taxaPct = 0;
  var prazoDias = 0;

  if (forma === 'PIX') {
    taxaPct = parseFloat(cfg.taxa_pix_pct) || 0;
    prazoDias = parseInt(cfg.prazo_pix_dias) || 0;
  } else if (forma === 'Cartao_Debito' || forma === 'Débito' || forma === 'Debito') {
    taxaPct = parseFloat(cfg.taxa_debito_pct) || 1.99;
    prazoDias = parseInt(cfg.prazo_debito_dias) || 1;
  } else if (forma === 'Cartao_Credito' || forma === 'Crédito' || forma === 'Credito') {
    taxaPct = parseFloat(cfg.taxa_credito_pct) || 3.99;
    prazoDias = parseInt(cfg.prazo_credito_dias) || 30;
  } else {
    // Dinheiro físico: taxa sempre 0% e D+0 imediato
    taxaPct = 0;
    prazoDias = 0;
  }

  var taxaValor = Math.round((valor * (taxaPct / 100)) * 100) / 100;
  var liquido = Math.max(0, Math.round((valor - taxaValor) * 100) / 100);
  var dataRef = dataTransacao || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var compensacao = calcularDataCompensacao(dataRef, prazoDias);

  return {
    taxaPct: taxaPct,
    taxaValor: taxaValor,
    valorLiquido: liquido,
    prazoDias: prazoDias,
    dataCompensacao: compensacao
  };
}

/**
 * Salvar Agendamento com PREVENÇÃO DE CONFLITO DE HORÁRIO e CÁLCULO FINANCEIRO
 */
function saveAgendamento(agd) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEETS.AGENDAMENTOS);
  var data = sheet.getDataRange().getValues();
  var now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
  var cfg = getTaxasConfig(ss);

  var preco = parseFloat(agd.servico_preco) || 0;
  var comissaoPct = parseFloat(agd.comissao_pct) || 50;
  var comissaoValor = (preco * (comissaoPct / 100));
  var statusNovo = agd.status || 'Agendado';
  var formaPgto = agd.forma_pagamento || 'Pendente';
  var totalVenda = agd.total_venda ? parseFloat(agd.total_venda) : preco;

  // Cálculo financeiro se concluído
  var taxaInfo = { taxaValor: 0, valorLiquido: totalVenda, dataCompensacao: agd.data || now.substring(0, 10) };
  if (statusNovo === 'Concluido') {
    taxaInfo = calcularTaxaECompensacaoBackend(totalVenda, formaPgto, cfg, agd.data || now.substring(0, 10));
  }

  // 1. Validação de Conflito de Horário
  if (statusNovo === 'Agendado') {
    for (var c = 1; c < data.length; c++) {
      var existId = String(data[c][0]);
      var existCliente = String(data[c][1] || 'Outro cliente');
      var existBarbeiroId = String(data[c][6]);
      var existData = String(data[c][8]);
      var existHora = String(data[c][9]);
      var existStatus = String(data[c][10]);

      if (existId !== String(agd.id) &&
          existBarbeiroId === String(agd.barbeiro_id) &&
          existData === String(agd.data) &&
          existHora === String(agd.horario) &&
          existStatus === 'Agendado') {
        return {
          success: false,
          conflito: true,
          error: 'Conflito de Horário! O barbeiro ' + agd.barbeiro_nome + ' já possui atendimento agendado para ' + agd.data + ' às ' + agd.horario + ' com o cliente ' + existCliente + '. Escolha outro horário.'
        };
      }
    }
  }

  // 2. Atualização
  if (agd.id) {
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(agd.id)) {
        var updatedRow = [
          agd.id,
          agd.cliente_nome,
          agd.cliente_telefone,
          agd.servico_id,
          agd.servico_nome,
          preco,
          agd.barbeiro_id,
          agd.barbeiro_nome,
          agd.data,
          agd.horario,
          statusNovo,
          formaPgto,
          comissaoValor,
          data[i][13] || now,
          agd.produtos_consumidos ? JSON.stringify(agd.produtos_consumidos) : (data[i][14] || '[]'),
          totalVenda,
          taxaInfo.taxaValor,
          taxaInfo.valorLiquido,
          taxaInfo.dataCompensacao
        ];
        sheet.getRange(i + 1, 1, 1, updatedRow.length).setValues([updatedRow]);
        return { success: true, message: 'Agendamento atualizado com sucesso!' };
      }
    }
  }

  // 3. Inserção
  var newId = 'AGD-' + data.length;
  var prodsJson = agd.produtos_consumidos ? JSON.stringify(agd.produtos_consumidos) : '[]';

  sheet.appendRow([
    newId,
    agd.cliente_nome,
    agd.cliente_telefone,
    agd.servico_id,
    agd.servico_nome,
    preco,
    agd.barbeiro_id,
    agd.barbeiro_nome,
    agd.data,
    agd.horario,
    statusNovo,
    formaPgto,
    comissaoValor,
    now,
    prodsJson,
    totalVenda,
    taxaInfo.taxaValor,
    taxaInfo.valorLiquido,
    taxaInfo.dataCompensacao
  ]);

  return { success: true, message: 'Agendamento cadastrado com sucesso!', id: newId };
}

/**
 * Atualizar Status Simples de Agendamento com Recálculo de Taxas
 */
function updateAgendamentoStatus(id, status, formaPagamento) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEETS.AGENDAMENTOS);
  var data = sheet.getDataRange().getValues();
  var cfg = getTaxasConfig(ss);

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(id)) {
      var row = data[i];
      row[10] = status;

      if (status === 'Cancelado') {
        // Ao cancelar um agendamento, mantenha forma_pagamento inalterado (ou com valor original)
        // e zere comissao_valor, taxa_aplicada_valor e valor_liquido (R$ 0,00)
        row[12] = 0.00;
        row[16] = 0.00;
        row[17] = 0.00;
      } else {
        if (formaPagamento && String(formaPagamento).toLowerCase() !== 'cancelado') {
          row[11] = formaPagamento;
        }
        if (status === 'Concluido') {
          var totalVenda = parseFloat(row[15]) || parseFloat(row[5]) || 0;
          var dataTransacao = String(row[8]) || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
          var taxaInfo = calcularTaxaECompensacaoBackend(totalVenda, row[11], cfg, dataTransacao);
          row[16] = taxaInfo.taxaValor;
          row[17] = taxaInfo.valorLiquido;
          row[18] = taxaInfo.dataCompensacao;
        }
      }

      sheet.getRange(i + 1, 1, 1, Math.max(row.length, 19)).setValues([row]);
      return { success: true, message: 'Status do agendamento alterado para ' + status };
    }
  }
  return { success: false, error: 'Agendamento não encontrado.' };
}

/**
 * COMANDA CONJUNTA: Finaliza atendimento com Serviço + Baixa de Estoque + Cálculo de Taxa & Compensação
 */
function finalizarAtendimentoComanda(agdId, formaPagamento, produtosConsumidos) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sAg = ss.getSheetByName(SHEETS.AGENDAMENTOS);
  var agData = sAg.getDataRange().getValues();
  var agRow = -1;

  for (var i = 1; i < agData.length; i++) {
    if (String(agData[i][0]) === String(agdId)) {
      agRow = i + 1;
      break;
    }
  }

  if (agRow === -1) {
    return { success: false, error: 'Agendamento não encontrado.' };
  }

  var formaFinal = (formaPagamento && String(formaPagamento).toLowerCase() !== 'cancelado') ? formaPagamento : 'Dinheiro';

  // 1. Atualiza status e forma de pagamento
  sAg.getRange(agRow, 11).setValue('Concluido');
  sAg.getRange(agRow, 12).setValue(formaFinal);

  // 2. Calcula total dos produtos e atualiza comanda
  var totalProdutos = 0;
  var produtosBaixados = [];
  var sProd = ss.getSheetByName(SHEETS.PRODUTOS);

  if (produtosConsumidos && produtosConsumidos.length > 0) {
    var pData = sProd.getDataRange().getValues();

    for (var k = 0; k < produtosConsumidos.length; k++) {
      var item = produtosConsumidos[k];
      var qtdVendida = parseInt(item.quantidade || item.qtd) || 1;
      var precoUnit = parseFloat(item.preco) || 0;
      totalProdutos += (qtdVendida * precoUnit);

      // Baixa no estoque na aba Produtos
      for (var r = 1; r < pData.length; r++) {
        if (String(pData[r][0]) === String(item.id)) {
          var estoqueAtual = parseInt(pData[r][3]) || 0;
          var novoEstoque = Math.max(0, estoqueAtual - qtdVendida);
          sProd.getRange(r + 1, 4).setValue(novoEstoque);
          pData[r][3] = novoEstoque; // atualiza memória local
          produtosBaixados.push({
            id: item.id,
            nome: item.nome,
            quantidade: qtdVendida,
            estoqueRestante: novoEstoque
          });
          break;
        }
      }
    }
  }

  var servicoPreco = parseFloat(agData[agRow - 1][5]) || 0;
  var barbeiroId = agData[agRow - 1][6];
  var totalVenda = servicoPreco + totalProdutos;
  var dataTransacao = String(agData[agRow - 1][8]) || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');

  // Recálculo definitivo da comissão incidente EXCLUSIVAMENTE sobre o valor do serviço
  var comissaoPct = 50;
  var sBarb = ss.getSheetByName(SHEETS.BARBEIROS);
  if (sBarb) {
    var bData = sBarb.getDataRange().getValues();
    for (var b = 1; b < bData.length; b++) {
      if (String(bData[b][0]) === String(barbeiroId)) {
        comissaoPct = parseFloat(bData[b][5]) || 50;
        break;
      }
    }
  }
  var comissaoValor = servicoPreco * (comissaoPct / 100);
  sAg.getRange(agRow, 13).setValue(comissaoValor);

  // 3. Aplica Taxa Bancária e Prazo de Compensação
  var cfg = getTaxasConfig(ss);
  var taxaInfo = calcularTaxaECompensacaoBackend(totalVenda, formaFinal, cfg, dataTransacao);

  // Grava detalhes dos produtos e valores financeiros (colunas 15 a 19)
  sAg.getRange(agRow, 15).setValue(JSON.stringify(produtosConsumidos || []));
  sAg.getRange(agRow, 16).setValue(totalVenda);
  sAg.getRange(agRow, 17).setValue(taxaInfo.taxaValor);
  sAg.getRange(agRow, 18).setValue(taxaInfo.valorLiquido);
  sAg.getRange(agRow, 19).setValue(taxaInfo.dataCompensacao);

  return {
    success: true,
    message: 'Comanda finalizada com sucesso! Estoque, taxas da maquininha e caixa atualizados.',
    totalVenda: totalVenda,
    comissaoValor: comissaoValor,
    taxaAplicada: taxaInfo.taxaValor,
    valorLiquido: taxaInfo.valorLiquido,
    dataCompensacao: taxaInfo.dataCompensacao,
    produtosBaixados: produtosBaixados
  };
}

function deleteAgendamento(id) {
  return deleteRowById(SHEETS.AGENDAMENTOS, id);
}

/**
 * Lançar Sangria de Caixa
 */
function saveSangria(sangria) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEETS.SANGRIAS);
  var data = sheet.getDataRange().getValues();
  var now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');

  var newId = 'SNG-' + data.length;
  sheet.appendRow([
    newId,
    parseFloat(sangria.valor) || 0,
    sangria.motivo || 'Fim de expediente - Sangria',
    now,
    'Gestor'
  ]);

  return { success: true, message: 'Sangria de caixa registrada com sucesso!', id: newId };
}

/**
 * Salvar Pagamento / Acerto de Comissão do Barbeiro
 */
function savePagamentoBarbeiro(pag) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEETS.PAGAMENTOS);
  var data = sheet.getDataRange().getValues();
  var now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');

  var newId = 'PAG-' + data.length;
  sheet.appendRow([
    newId,
    pag.barbeiro_id,
    pag.barbeiro_nome,
    parseFloat(pag.valor) || 0,
    pag.forma_pagamento || 'PIX',
    pag.observacao || 'Acerto de comissão',
    now
  ]);

  return {
    success: true,
    message: 'Pagamento ao barbeiro ' + pag.barbeiro_nome + ' registrado com sucesso!',
    id: newId
  };
}

/**
 * BACKUP AUTOMÁTICO DIÁRIO NO GOOGLE DRIVE
 * Duplica a planilha inteira para a pasta "Backups_Barbearia" com timestamp no nome
 */
function criarBackupAutomaticoDiario() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var fileId = ss.getId();
    var originalFile = DriveApp.getFileById(fileId);
    var nowStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd_HHmm');
    var backupName = 'Backup_Barbearia_' + nowStr;

    // Busca ou cria pasta de backups
    var folderIter = DriveApp.getFoldersByName('Backups_Barbearia');
    var folder = folderIter.hasNext() ? folderIter.next() : DriveApp.createFolder('Backups_Barbearia');

    var backupFile = originalFile.makeCopy(backupName, folder);

    return {
      success: true,
      message: 'Backup automático diário criado com sucesso no Google Drive!',
      backupName: backupName,
      folderName: 'Backups_Barbearia',
      url: backupFile.getUrl(),
      timestamp: new Date().toISOString()
    };
  } catch (err) {
    return {
      success: false,
      error: 'Falha ao gerar backup: ' + err.toString()
    };
  }
}

/**
 * Configura o Time-driven trigger para rodar o backup diário toda madrugada às 03:00
 */
function configurarGatilhoBackupDiario() {
  try {
    var triggers = ScriptApp.getProjectTriggers();
    for (var i = 0; i < triggers.length; i++) {
      if (triggers[i].getHandlerFunction() === 'criarBackupAutomaticoDiario') {
        ScriptApp.deleteTrigger(triggers[i]);
      }
    }

    ScriptApp.newTrigger('criarBackupAutomaticoDiario')
      .timeBased()
      .everyDays(1)
      .atHour(3)
      .create();

    return {
      success: true,
      message: 'Gatilho de backup automático diário ativado para rodar às 03:00 da madrugada!'
    };
  } catch (err) {
    return {
      success: false,
      error: 'Não foi possível configurar o gatilho: ' + err.toString()
    };
  }
}

/**
 * Auxiliar: Excluir linha por ID
 */
function deleteRowById(sheetName, id) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) return { success: false, error: 'Aba não encontrada: ' + sheetName };

  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(id)) {
      sheet.deleteRow(i + 1);
      return { success: true, message: 'Registro excluído com sucesso!' };
    }
  }
  return { success: false, error: 'Registro não encontrado.' };
}

/**
 * Auxiliar: Gerar Login Automático
 */
function gerarLoginBarbeiro(nomeCompleto) {
  if (!nomeCompleto) return 'barbeiro';
  var semAcento = nomeCompleto.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  var partes = semAcento.split(/\s+/).filter(function(p) { return p.length > 0; });
  if (partes.length === 1) return partes[0].replace(/[^a-zA-Z0-9]/g, '');

  var primeiro = partes[0].replace(/[^a-zA-Z0-9]/g, '');
  var ultimo = partes[partes.length - 1].replace(/[^a-zA-Z0-9]/g, '');
  return primeiro + '_' + ultimo;
}

/**
 * =========================================================================
 * MÓDULO SUPER ADMIN / PAINEL MASTER (Multi-Barbearias & Assinaturas SaaS)
 * Responsável: Rafael Martins (Dono do SaaS)
 * =========================================================================
 */

/**
 * Geração Automática de Login do Gestor no padrão obrigatório "Barbearia_Nome"
 * Remove acentos, caracteres especiais e preposições ("de", "da", "do", "e", etc.)
 * Exemplo: "Navalha de Ouro" -> "Barbearia_NavalhaOuro"
 */
function gerarLoginGestorBarbearia(nome) {
  if (!nome) return 'Barbearia_Gestor';
  var limpo = String(nome).normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  var ignorar = ['de', 'da', 'do', 'dos', 'das', 'e', '&', 'barbearia'];
  var palavras = limpo.split(/\s+/).filter(function(p) {
    var pLower = p.toLowerCase().replace(/[^a-z0-9]/g, '');
    return pLower.length > 0 && ignorar.indexOf(pLower) === -1;
  });

  if (palavras.length === 0) {
    palavras = limpo.split(/\s+/).filter(function(p) { return p.length > 0; });
  }

  var camelCase = palavras.map(function(p) {
    var str = p.replace(/[^a-zA-Z0-9]/g, '');
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1);
  }).join('');

  return 'Barbearia_' + (camelCase || 'Gestor');
}

/**
 * Retorna lista completa de barbearias cadastradas para o Super Admin
 */
function getMasterBarbearias() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEETS.MASTER);
  if (!sh) return { success: true, barbearias: [] };

  var range = sh.getDataRange();
  var barbearias = sheetValuesToObjects(range.getValues(), range.getDisplayValues());
  return {
    success: true,
    barbearias: barbearias,
    total: barbearias.length,
    timestamp: new Date().toISOString()
  };
}

/**
 * Salva ou cadastra uma nova barbearia no Painel Master
 * Gera login automático no padrão "Barbearia_Nome" e senha inicial "abc123"
 */
function saveMasterBarbearia(b) {
  if (!b || !b.nome_barbearia) {
    return { success: false, error: 'O nome da barbearia é obrigatório.' };
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = getOrCreateSheet(ss, SHEETS.MASTER, [
    'id', 'nome_barbearia', 'responsavel', 'telefone', 'login_gestor',
    'senha_gestor', 'plano', 'valor_pago', 'forma_pagamento_pix',
    'data_vencimento', 'status_licenca', 'api_url', 'criado_em'
  ]);

  var data = sh.getDataRange().getValues();
  var tz = Session.getScriptTimeZone();
  var hojeStr = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm:ss');
  var id = b.id;
  var rowIndex = -1;

  if (id) {
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(id)) {
        rowIndex = i + 1;
        break;
      }
    }
  }

  var loginGestor = b.login_gestor || gerarLoginGestorBarbearia(b.nome_barbearia);

  if (rowIndex !== -1) {
    var rowValues = [
      id,
      b.nome_barbearia,
      b.responsavel || '',
      b.telefone || '',
      loginGestor,
      data[rowIndex - 1][5] || 'abc123',
      b.plano || 'Mensal',
      parseFloat(b.valor_pago) || 0,
      'PIX', // Fixado como PIX
      b.data_vencimento || '',
      b.status_licenca || 'ATIVA',
      b.api_url || '',
      data[rowIndex - 1][12] || hojeStr
    ];
    sh.getRange(rowIndex, 1, 1, rowValues.length).setValues([rowValues]);
    return {
      success: true,
      message: 'Barbearia "' + b.nome_barbearia + '" atualizada com sucesso!',
      barbearia: {
        id: id,
        nome_barbearia: b.nome_barbearia,
        login_gestor: loginGestor,
        status_licenca: b.status_licenca || 'ATIVA'
      }
    };
  } else {
    var newId = 'BARB-' + Utilities.formatDate(new Date(), tz, 'yyyyMMddHHmmss');
    var dVenc = b.data_vencimento || Utilities.formatDate(new Date(new Date().getTime() + 30*24*60*60*1000), tz, 'yyyy-MM-dd');
    var newRow = [
      newId,
      b.nome_barbearia,
      b.responsavel || '',
      b.telefone || '',
      loginGestor,
      'abc123', // Senha inicial padrão
      b.plano || 'Mensal',
      parseFloat(b.valor_pago) || 0,
      'PIX', // Exclusivo PIX
      dVenc,
      b.status_licenca || 'ATIVA',
      b.api_url || '',
      hojeStr
    ];
    sh.appendRow(newRow);
    return {
      success: true,
      message: 'Barbearia cadastrada com sucesso! Login: ' + loginGestor + ' (Senha inicial: abc123)',
      barbearia: {
        id: newId,
        nome_barbearia: b.nome_barbearia,
        login_gestor: loginGestor,
        senha_gestor: 'abc123',
        status_licenca: b.status_licenca || 'ATIVA'
      }
    };
  }
}

/**
 * Trava ou destrava o acesso de uma barbearia com 1 clique (Super Admin)
 */
function toggleStatusLicencaMaster(id, novoStatus) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEETS.MASTER);
  if (!sh) return { success: false, error: 'Aba Master não encontrada.' };

  var data = sh.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(id)) {
      var statusFinal = novoStatus || (String(data[i][10]) === 'ATIVA' ? 'BLOQUEADA' : 'ATIVA');
      sh.getRange(i + 1, 11).setValue(statusFinal);
      return {
        success: true,
        novoStatus: statusFinal,
        message: 'Status da licença da barbearia alterado para ' + statusFinal + ' com sucesso!'
      };
    }
  }
  return { success: false, error: 'Barbearia não localizada.' };
}

/**
 * Renovação de Assinatura via PIX com nova data de vencimento
 */
function renovarVencimentoMaster(id, novoVencimento, novoPlano, valorPago) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEETS.MASTER);
  if (!sh) return { success: false, error: 'Aba Master não encontrada.' };

  var data = sh.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(id)) {
      if (novoVencimento) sh.getRange(i + 1, 10).setValue(novoVencimento);
      if (novoPlano) sh.getRange(i + 1, 7).setValue(novoPlano);
      if (valorPago !== undefined && valorPago !== null) sh.getRange(i + 1, 8).setValue(parseFloat(valorPago) || 0);
      sh.getRange(i + 1, 9).setValue('PIX');
      sh.getRange(i + 1, 11).setValue('ATIVA'); // Restabelece como ATIVA automaticamente

      return {
        success: true,
        message: 'Assinatura renovada com sucesso via PIX! A barbearia está ATIVA até ' + novoVencimento
      };
    }
  }
  return { success: false, error: 'Barbearia não localizada.' };
}

/**
 * Reseta a senha do gestor de uma barbearia para o padrão "abc123"
 */
function resetSenhaGestorMaster(id) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEETS.MASTER);
  if (!sh) return { success: false, error: 'Aba Master não encontrada.' };

  var data = sh.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(id)) {
      sh.getRange(i + 1, 6).setValue('abc123');
      return {
        success: true,
        message: 'Senha do gestor redefinida com sucesso para o padrão "abc123"!'
      };
    }
  }
  return { success: false, error: 'Barbearia não localizada.' };
}

/**
 * Exclusão definitiva de barbearia do SaaS
 */
function deleteMasterBarbearia(id) {
  return deleteRowById(SHEETS.MASTER, id);
}

/**
 * Alteração de Senha do Super Admin (Rafael_Martins)
 */
function alterarSenhaMaster(senhaAtual, novaSenha) {
  var valid = validarRegraSenha(novaSenha);
  if (!valid.valido) {
    return { success: false, error: valid.error };
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sConf = ss.getSheetByName(SHEETS.CONFIG);
  if (!sConf) return { success: false, error: 'Aba de configurações não encontrada.' };

  var data = sConf.getDataRange().getValues();
  var senhaAtualNoBanco = 'RSNf14232603*';
  var rowIndex = -1;

  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === 'superadmin_senha') {
      rowIndex = i;
      senhaAtualNoBanco = String(data[i][1] || '').trim();
      break;
    }
  }

  if (senhaAtual && String(senhaAtual).trim() !== senhaAtualNoBanco) {
    return { success: false, error: 'A senha atual do Super Admin informada está incorreta.' };
  }

  var novaSenhaLimpa = String(novaSenha).trim();
  if (rowIndex !== -1) {
    sConf.getRange(rowIndex + 1, 2).setValue(novaSenhaLimpa);
  } else {
    sConf.appendRow(['superadmin_senha', novaSenhaLimpa, 'Senha do Dono do SaaS (Rafael_Martins)']);
  }

  return {
    success: true,
    message: 'Senha do Super Admin (Rafael Martins) alterada com sucesso!'
  };
}
