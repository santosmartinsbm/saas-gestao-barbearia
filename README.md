# 💈 GESTÃO PROFISSIONAL DE BARBEARIA - Plataforma SaaS Multi-Tenant & App do Barbeiro

Sistema completo, moderno e de padrão comercial para gestão de barbearias, desenvolvido como **Software as a Service (SaaS)** para ser comercializado para múltiplas barbearias por **Rafael Martins**. O sistema conta com uma hierarquia rigorosa de 3 perfis e opera em frentes 100% responsivas:

1. **👑 Painel Master (Exclusivo Super Admin / Dono do SaaS - Rafael Martins):** Gestão global de todas as barbearias clientes, controle de assinaturas (PIX), datas de vencimento, bloqueio/desbloqueio com 1 clique, cadastro de novas barbearias com geração automática de login, auditoria de dados e relatórios gerenciais em CSV e impressão.
2. **🏢 Painel Desktop / Web do Gestor da Barbearia:** Controle comercial completo da barbearia (agenda, comanda conjunta com baixa de estoque, clientes, barbeiros, comissões, fechamento diário de caixa, sangrias e backups).
3. **✂️ Aplicativo Mobile (PWA) dos Barbeiros:** Acesso individual com login no formato `PrimeiroNome_UltimoNome`, visualização estrita de seus próprios atendimentos, saldo de comissões em tempo real e extrato de pagamentos recebidos.

> 💎 **Zero Custo de Servidor ou Banco Pago:** Toda a persistência é realizada em tempo real no **Google Planilhas** através de API de alta concorrência com **LockService** no **Google Apps Script**.

---

## 👑 Hierarquia de Acesso & Credenciais do Sistema

O sistema possui uma **tela de login unificada**: ao digitar as credenciais na tela principal, o sistema reconhece o nível de acesso e direciona automaticamente para o painel correspondente:

### 1. Perfil Super Admin (Dono da Plataforma)
- **Login:** `Rafael_Martins`
- **Senha Inicial:** Definida de forma segura no Apps Script (PropertiesService) através da execução da função `configurarSuperAdmin('suaNovaSenha')` ou senha temporária de implantação.
- **Painel:** Abre exclusivamente o **PAINEL MASTER SAAS**.
- **Segurança:** O Super Admin pode alterar sua senha pessoal a qualquer momento no botão **"Minha Senha"** no cabeçalho do painel. As credenciais mestras são protegidas com hash SHA-256 e nunca ficam expostas em células públicas da planilha.

### 2. Perfis de Gestores de Barbearias
- **Padrão de Login Automático:** `Barbearia_Nome` (Ex: `Barbearia_NavalhaOuro`, `Barbearia_VintageEstilo`).
- **Senha Inicial:** Senha temporária de primeiro acesso informada pelo administrador.
- **Troca Obrigatória:** No primeiro acesso do gestor, o sistema bloqueia e exige a criação de uma senha pessoal definitiva (mínimo de 6 caracteres, letras e números). Todas as senhas são armazenadas com hash criptográfico SHA-256 + salt.

### 3. Perfis dos Barbeiros
- **Padrão de Login Automático:** `PrimeiroNome_UltimoNome` (Ex: `Joao_Silva`, `Marcos_Santos`).
- **Senha:** Definida pelo próprio barbeiro no primeiro acesso (ou temporária caso o gestor realize o reset de senha).

---

## 🚀 Como Iniciar Imediatamente (Modo Demonstração)

Você pode testar todo o sistema imediatamente no seu computador sem configurar nada:

1. Dê um duplo clique no arquivo **`Iniciar_Sistema.bat`** (ou abra o arquivo **`index.html`** no seu navegador).
2. **Acesso como Dono do SaaS (Super Admin - Demonstração Local):**
   - Usuário: `Rafael_Martins`
   - Senha de Demonstração: `admin123` *(em produção conectada ao GAS, utilize a senha configurada no ScriptProperties)*
   - *Abre o Painel Master com métricas consolidadas, lista de barbearias e controle de assinaturas.*
3. **Acesso como Gestor de Barbearia:**
   - Usuário: `Barbearia_VintageEstilo`
   - Senha temporária: `abc123` *(solicita troca obrigatória no 1º acesso)*
4. **Acesso como Barbeiro:**
   - Selecione a aba **App Barbeiro**.
   - Login: `Joao_Silva` (primeiro acesso) ou `Marcos_Santos`.

---

## 📋 Como Conectar ao Seu Google Planilhas (Backend GAS)

Para sincronizar e persistir todos os dados no seu próprio Google Drive sem custos:

### 1. Criar a Planilha no Google Drive
- Acesse o [Google Drive](https://drive.google.com).
- Crie uma nova planilha nomeada como `Banco de Dados - Barbearia SaaS`.

### 2. Inserir o Código do Backend
- Na planilha, acesse **Extensões > Apps Script**.
- Apague o código padrão e cole o conteúdo do arquivo [`backend/Code.gs`](backend/Code.gs).
- Salve o projeto (`Ctrl + S`).

### 3. Criar a Estrutura do Banco de Dados & Configurar Super Admin
- No topo do editor do Apps Script, selecione a função **`setupDatabase`** e clique em **Executar (▶️)**.
- Conceda as permissões de acesso ao Google.
- **Definir Senha do Super Admin:** Para configurar sua senha mestra pessoal protegida por hash no `PropertiesService`, execute no Apps Script:
  ```javascript
  configurarSuperAdmin("SuaSenhaSegura123*");
  ```
- As **9 abas estruturadas** do banco de dados serão criadas com formatação e cores profissionais:
  1. `Master_Barbearias` (ID, Nome Barbearia, Responsável, Telefone/WhatsApp, Login Gestor, Senha Gestor [Hash], Plano, Valor Pago, Forma Pagamento PIX, Data Vencimento, Status Licença, URL API, Criado Em)
  2. `Configuracoes` (Super Admin Login, Nome da Barbearia, Logo, Status Licença, Telefone, Chave PIX, WhatsApp Suporte, Taxas PIX/Débito/Crédito e Prazos em Dias Úteis)
  3. `Clientes` (ID, Nome, Telefone/WhatsApp, Data de Criação)
  4. `Produtos` (ID, Nome, Preço, Quantidade em Estoque)
  5. `Servicos` (ID, Nome, Preço, Duração Estimada)
  6. `Barbeiros` (ID, Nome, Telefone, Login Automático, Senha, Comissão %, Ativo)
  7. `Agendamentos` (ID, Cliente, Serviço, Barbeiro, Data, Horário, Status, Forma de Pagamento, Comissão, Produtos da Comanda, Total Venda, Taxa Operadora, Valor Líquido, Data Compensação)
  8. `Caixa_Sangrias` (ID, Data/Hora, Valor, Motivo, Usuário)
  9. `Pagamentos_Barbeiros` (ID, Data/Hora, Barbeiro, Valor, Forma de Pagamento, Observação)

### 4. Configurar o Backup Automático Noturno (03:00)
- No Apps Script, selecione e execute a função **`configurarGatilhoBackupDiario`**.
- Um gatilho temporal criará automaticamente uma cópia snapshot de segurança da planilha todos os dias às 03:00 na mesma pasta do Google Drive.

### 5. Publicar como Web App
- Clique em **Implantar > Nova implantação**.
- Selecione o tipo **App da Web**.
- Executar como: **Eu**.
- Quem pode acessar: **Qualquer pessoa**.
- Clique em **Implantar** e copie a URL gerada (terminada em `/exec`).
- No painel da barbearia, vá em **Configurações (⚙️)**, cole a URL no campo da API e clique em **Salvar Alterações**.

---

## 💼 Recursos Comerciais de Alto Valor (Padrão SaaS)

### 1. Gestão Inteligente de Taxas de Maquininha & Previsão de Caixa
- **Configuração de Taxas e Prazos (Gestor):** Na aba **Configurações (⚙️)**, o gestor define a alíquota (%) e o prazo de recebimento (dias úteis) para PIX, Cartão de Débito e Cartão de Crédito.
- **Regra de Ouro da Comissão:** A comissão do barbeiro é sempre calculada com base no **valor integral do serviço**, garantindo a proteção financeira do profissional parceiro. A taxa bancária incide unicamente sobre o repasse da barbearia.
- **Dinheiro Físico 100% Líquido:** Dinheiro em espécie tem taxa 0% e compensação instantânea (D+0).
- **Cálculo de Dias Úteis com Pulo de Finais de Semana:** Se uma transação em débito (D+1 útil) ocorre na sexta-feira ou sábado, a compensação é projetada automaticamente para a segunda-feira seguinte.
- **Separação Real de Liquidez:**
  - **Saldo em Gaveta (Espécie):** Total arrecadado em dinheiro físico deduzido de sangrias e pagamentos de comissão em dinheiro.
  - **Saldo Disponível Hoje:** Recursos já compensados na conta ou gaveta (`data_compensacao <= hoje`) menos despesas.
  - **Previsão a Receber (Lançamentos Futuros):** Valores a compensar em datas futuras (`data_compensacao > hoje`) com grade detalhada de vencimentos.

### 2. Comanda Conjunta (Serviço + Produtos Consumidos)
- Ao concluir um atendimento, o gestor pode lançar os produtos que o cliente consumiu ou comprou (pomadas, óleos, bebidas).
- O sistema calcula automaticamente o **Subtotal do Serviço**, o **Subtotal dos Produtos** e o **Total Geral da Comanda**.
- **Baixa Automática no Estoque:** A quantidade consumida é debitada automaticamente do estoque do produto.
- **Regra de Comissão Realista:** A porcentagem de comissão do barbeiro é calculada estritamente sobre o **valor do serviço**, enquanto o valor dos produtos é somado integralmente ao caixa da barbearia.

### 3. Prevenção de Conflito de Horário
- O sistema valida a agenda antes de salvar: impede o agendamento de dois clientes no mesmo dia e horário para o mesmo barbeiro, prevenindo constrangimentos e duplicidades.

### 4. Filtros Rápidos na Agenda (Pills Horizontais)
- Botões estilizados no topo da agenda com contadores em tempo real para filtrar instantaneamente a grade de atendimentos por barbeiro específico ou ver todos.

### 5. Atalho de WhatsApp com Mensagem Pré-Pronta
- Botão interativo ao lado de cada cliente na agenda que abre o WhatsApp Web ou Mobile com a mensagem de confirmação formatada com data, horário, serviço e nome do barbeiro.

### 6. Alerta de Estoque Crítico (< 3 Unidades)
- Banner de aviso no topo da tela de produtos e badges piscantes em vermelho nas linhas dos itens que estiverem com estoque abaixo de 3 unidades.

### 7. Fechamento de Caixa Diário & Exportação CSV
- Painel consolidado com a arrecadação bruta, taxas deduzidas da operadora, faturamento líquido real, total de sangrias e o **Saldo Esperado em Gaveta Físico**.
- **Detalhamento por Forma de Pagamento:** Exibe valor bruto, taxa média aplicada, valor líquido e prazo de liberação de cada modalidade.
- **Exportação CSV:** Botão para baixar instantaneamente o relatório financeiro do dia em CSV formatado com UTF-8 BOM, 100% compatível com Microsoft Excel.
- **Impressão Térmica / Cupom:** Layout específico para impressoras de 80mm/58mm e folhas A4 com discriminação completa de taxas e recebimentos futuros.

### 8. Trava de Licença SaaS (Controle de Inadimplência)
- Campo `status_licenca` na aba `Configuracoes` da planilha (`ATIVA` ou `BLOQUEADA`).
- Caso esteja `BLOQUEADA`, o sistema exibe uma tela elegante de suspensão temporária do acesso com botão direto para o WhatsApp do suporte comercial do SaaS regularizar a assinatura.

---

## 🛡️ Estabilidade, Performance e Modo Offline

- **Auto-Retry Transparente com Backoff:** Em caso de sobrecarga ou rate limit temporário da API do Google, o front-end executa até 3 tentativas automáticas (com esperas de 1s, 2s e 3s) sem travar a interface.
- **Detector de Conectividade Offline:** Monitoramento de rede (`online` / `offline`) com banner discreto informando operação em modo cache local.
- **Carregamento Otimizado (Lazy Loading):** As requisições de agendamento carregam por padrão os últimos 7 dias e datas futuras, permitindo consultas históricas sob demanda.
- **Botão Flutuante (FAB `+`):** Atalho fixo no canto inferior direito para novos agendamentos rápidos em telas mobile.
