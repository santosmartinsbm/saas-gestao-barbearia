# 📋 Guia de Configuração do Google Planilhas & Apps Script

Este sistema foi projetado para funcionar **sem custos de servidores ou bancos de dados pagos**. Toda a persistência é feita diretamente no seu Google Drive através do **Google Planilhas** conectado via **Google Apps Script**.

---

## 🚀 Passo 1: Criar a Planilha no Google Drive

1. Acesse o seu Google Drive ([drive.google.com](https://drive.google.com)).
2. Clique em **+ Novo** > **Planilhas Google** (em branco).
3. Nomeie a planilha como: `Banco de Dados - Barbearia`.

---

## ⚙️ Passo 2: Inserir o Código do Backend (Apps Script)

1. No menu superior da planilha, clique em: **Extensões** > **Apps Script**.
2. Uma nova aba do navegador será aberta com o editor de código.
3. Apague qualquer código existente no arquivo `Código.gs`.
4. Abra o arquivo `backend/Code.gs` deste projeto, copie todo o seu conteúdo e cole no editor do Apps Script.
5. Clique no ícone de **Salvar** (💾 ou `Ctrl + S`).

---

## ⚡ Passo 3: Executar a Criação Automática das Abas (1 Clique!)

Você **não precisa** criar e digitar as 8 abas e dezenas de colunas manualmente! O código possui uma rotina inteligente que faz tudo isso para você:

1. Na barra superior do Apps Script, selecione a função **`setupDatabase`** no menu suspenso de funções.
2. Clique no botão **Executar** (ícone de play ▶️).
3. O Google solicitará permissão de autorização:
   - Clique em **Revisar permissões**.
   - Escolha sua conta Google.
   - Se aparecer o aviso *"O Google não verificou este app"*, clique em **Avançado** (no canto inferior esquerdo) e depois em **Acessar [Nome do Projeto] (não seguro)**.
   - Clique em **Permitir**.
4. Volte à aba da sua planilha no Google Sheets: você verá que as 8 abas foram criadas e formatadas automaticamente com cabeçalhos profissionais estilizados e dados de exemplo!

### 📊 9 Abas Criadas Automaticamente:
1. `Master_Barbearias` (id, nome_barbearia, responsavel, telefone, login_gestor, senha_gestor, plano, valor_pago, forma_pagamento_pix, data_vencimento, status_licenca, api_url, criado_em)
2. `Configuracoes` (superadmin_login, superadmin_senha, nome_barbearia, logo_url, status_licenca, telefone_barbearia, chave_pix, suporte_whatsapp, taxa_pix_pct, prazo_pix_dias, taxa_debito_pct, prazo_debito_dias, taxa_credito_pct, prazo_credito_dias)
3. `Clientes` (id, nome, telefone, criado_em)
4. `Produtos` (id, nome, preco, estoque, criado_em)
5. `Servicos` (id, nome, preco, duracao_min, criado_em)
6. `Barbeiros` (id, nome, telefone, login, senha, comissao_pct, ativo, criado_em)
7. `Agendamentos` (id, cliente_nome, cliente_telefone, servico_id, servico_nome, servico_preco, barbeiro_id, barbeiro_nome, data, horario, status, forma_pagamento, comissao_valor, criado_em, produtos_consumidos, total_venda, taxa_aplicada_valor, valor_liquido, data_compensacao)
8. `Caixa_Sangrias` (id, valor, motivo, data_hora, usuario)
9. `Pagamentos_Barbeiros` (id, barbeiro_id, barbeiro_nome, valor, forma_pagamento, observacao, data_hora)

---

## 🌐 Passo 4: Publicar o Web App (Obter a URL da API)

1. No canto superior direito do Apps Script, clique no botão azul **Implantar** (Deploy) > **Nova implantação** (New deployment).
2. Clique na engrenagem ⚙️ ao lado de "Selecionar tipo" e escolha **App da Web** (Web app).
3. Preencha os campos exatamente assim:
   - **Descrição:** `API Barbearia v1`
   - **Executar como:** `Eu (seu-email@gmail.com)`
   - **Quem pode acessar:** `Qualquer pessoa` (Anyone) *(Importante: isso permite que o aplicativo do celular do barbeiro e o painel desktop enviem requisições sem exigir autenticação OAuth em cada aparelho)*.
4. Clique em **Implantar**.
5. Copie a **URL do app da Web** gerada (algo parecido com `https://script.google.com/macros/s/AKfycb.../exec`).

---

## 🔗 Passo 5: Conectar a URL no Sistema

1. Abra o arquivo `index.html` no seu navegador (ou execute o atalho `Iniciar_Sistema.bat`).
2. Faça login como **Gestor** (senha padrão: `admin123`).
3. Vá na aba **Configurações** (⚙️).
4. No campo **URL da API (Google Apps Script)**, cole a URL copiada no Passo 4.
5. Clique em **Testar Conexão** e depois em **Salvar Configurações**.
6. Pronto! O sistema agora está 100% sincronizado em tempo real com a sua planilha do Google.
