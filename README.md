# 💈 GESTÃO PROFISSIONAL DE BARBEARIA - Plataforma SaaS & App do Barbeiro

Sistema completo, moderno e de padrão comercial para gestão de barbearias, desenvolvido como **Software as a Service (SaaS)** para ser comercializado para múltiplas barbearias. O sistema opera em duas frentes 100% responsivas:

1. **Painel Desktop / Web do Gestor:** Controle comercial completo (faturamento, clientes, serviços, produtos, comanda conjunta, comissões, fechamento de caixa, sangrias, controle de licença SaaS e backups).
2. **Aplicativo Mobile (PWA) dos Barbeiros:** Acesso individual com login automático, visualização estrita de seus próprios atendimentos, saldo de comissões em tempo real e extrato histórico de pagamentos.

> 💎 **Zero Custo de Banco de Dados ou Servidor:** Persistência em tempo real no **Google Planilhas** através de API otimizada no **Google Apps Script** com suporte a alta concorrência e LockService.

---

## 🎨 Identidade Visual Padrão & Primeiro Acesso do Gestor

- **Nome Padrão Inicial:** `GESTÃO PROFISSIONAL DE BARBEARIA`.
- **Logotipo Vetorial Padrão:** Ícone estilizado em SVG de alta precisão com **máquina de cortar cabelo cruzada com uma tesoura** e acabamento degradê dourado premium.
- **Personalização Total:** No menu **Configurações (⚙️)**, o gestor pode alterar o nome da sua barbearia e definir sua própria logo (via URL ou upload de arquivo local).
- **Usuário e Senha Inicial do Gestor:**
  - **Usuário:** `admin`
  - **Senha inicial:** `admin123`
- **Troca de Senha Obrigatória no Primeiro Acesso:** Ao entrar pela primeira vez com `admin123`, o sistema bloqueia o acesso e exige que o gestor defina sua senha pessoal.
- **Opção "Alterar Minha Senha":** O gestor pode alterar sua senha a qualquer momento dentro de **Configurações (⚙️)**.
- **Validação de Senha Estrita:** Exige no mínimo 6 caracteres, contendo obrigatoriamente letras e números (tanto para o gestor quanto para os barbeiros).

---

## 🚀 Como Iniciar Imediatamente (Modo Demonstração)

Você pode testar todo o sistema imediatamente no seu computador sem configurar nada:

1. Dê um duplo clique no arquivo **`Iniciar_Sistema.bat`** (ou abra o arquivo **`index.html`** no seu navegador).
2. **Acesso do Gestor:**
   - Selecione a aba **Painel Gestor**.
   - Usuário: `admin` | Senha: `admin123`.
   - Ao entrar, o modal de segurança solicitará o cadastro da sua senha pessoal definitiva!
3. **Acesso do Barbeiro:**
   - Selecione a aba **App Barbeiro**.
   - Login: `Joao_Silva` (primeiro acesso) ou `Marcos_Santos` (senha `123`).

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

### 3. Criar a Estrutura do Banco de Dados (1 Clique)
- No topo do editor do Apps Script, selecione a função **`setupDatabase`** e clique em **Executar (▶️)**.
- Conceda as permissões de acesso ao Google.
- As **8 abas** do banco de dados serão criadas com formatação e cores:
  1. `Configuracoes` (Nome, Logo, Usuário/Senha do Gestor, Status da Licença SaaS, WhatsApp do Suporte)
  2. `Clientes` (ID, Nome, Telefone/WhatsApp, Data de Criação)
  3. `Produtos` (ID, Nome, Preço, Quantidade em Estoque)
  4. `Servicos` (ID, Nome, Preço, Duração Estimada)
  5. `Barbeiros` (ID, Nome, Telefone, Login Automático, Senha, Comissão %, Ativo)
  6. `Agendamentos` (ID, Cliente, Serviço, Barbeiro, Data, Horário, Status, Forma de Pagamento, Comissão, Produtos da Comanda, Total)
  7. `Caixa_Sangrias` (ID, Data/Hora, Valor, Motivo, Usuário)
  8. `Pagamentos_Barbeiros` (ID, Data/Hora, Barbeiro, Valor, Forma de Pagamento, Observação)

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

### 1. Comanda Conjunta (Serviço + Produtos Consumidos)
- Ao concluir um atendimento, o gestor pode lançar os produtos que o cliente consumiu ou comprou (pomadas, óleos, bebidas).
- O sistema calcula automaticamente o **Subtotal do Serviço**, o **Subtotal dos Produtos** e o **Total Geral da Comanda**.
- **Baixa Automática no Estoque:** A quantidade consumida é debitada automaticamente do estoque do produto.
- **Regra de Comissão Realista:** A porcentagem de comissão do barbeiro é calculada estritamente sobre o **valor do serviço**, enquanto o valor dos produtos é somado integralmente ao caixa da barbearia.

### 2. Prevenção de Conflito de Horário
- O sistema valida a agenda antes de salvar: impede o agendamento de dois clientes no mesmo dia e horário para o mesmo barbeiro, prevenindo constrangimentos e duplicidades.

### 3. Filtros Rápidos na Agenda (Pills Horizontais)
- Botões estilizados no topo da agenda com contadores em tempo real para filtrar instantaneamente a grade de atendimentos por barbeiro específico ou ver todos.

### 4. Atalho de WhatsApp com Mensagem Pré-Pronta
- Botão interativo ao lado de cada cliente na agenda que abre o WhatsApp Web ou Mobile com a mensagem de confirmação formatada com data, horário, serviço e nome do barbeiro.

### 5. Alerta de Estoque Crítico (< 3 Unidades)
- Banner de aviso no topo da tela de produtos e badges piscantes em vermelho nas linhas dos itens que estiverem com estoque abaixo de 3 unidades.

### 6. Fechamento de Caixa Diário & Exportação CSV
- Painel consolidado com a arrecadação separada por forma de pagamento (Dinheiro, PIX, Cartão de Débito, Cartão de Crédito), total de sangrias e o **Saldo Esperado em Gaveta Físico**.
- **Exportação CSV:** Botão para baixar instantaneamente o relatório financeiro do dia em CSV formatado com UTF-8 BOM, 100% compatível com Microsoft Excel.
- **Impressão Térmica / Cupom:** Layout específico para impressoras de 80mm/58mm e folhas A4.

### 7. Trava de Licença SaaS (Controle de Inadimplência)
- Campo `status_licenca` na aba `Configuracoes` da planilha (`ATIVA` ou `BLOQUEADA`).
- Caso esteja `BLOQUEADA`, o sistema exibe uma tela elegante de suspensão temporária do acesso com botão direto para o WhatsApp do suporte comercial do SaaS regularizar a assinatura.

---

## 🛡️ Estabilidade, Performance e Modo Offline

- **Auto-Retry Transparente com Backoff:** Em caso de sobrecarga ou rate limit temporário da API do Google, o front-end executa até 3 tentativas automáticas (com esperas de 1s, 2s e 3s) sem travar a interface.
- **Detector de Conectividade Offline:** Monitoramento de rede (`online` / `offline`) com banner discreto informando operação em modo cache local.
- **Carregamento Otimizado (Lazy Loading):** As requisições de agendamento carregam por padrão os últimos 7 dias e datas futuras, permitindo consultas históricas sob demanda.
- **Botão Flutuante (FAB `+`):** Atalho fixo no canto inferior direito para novos agendamentos rápidos em telas mobile.
