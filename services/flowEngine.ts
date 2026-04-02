import { FlowNode, FlowEdge, NodeType, NodeStatus, LogEntry, ExecutionContext, GeneratedFile } from '../types';
import { keyManager } from './keyManager';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const createLog = (nodeId: string, label: string, level: LogEntry['level'], message: string): LogEntry => ({
  id: Math.random().toString(36).substr(2, 9),
  timestamp: new Date().toISOString(),
  nodeId,
  nodeLabel: label,
  level,
  message
});

export class FlowEngine {
  private nodes: FlowNode[];
  private edges: FlowEdge[];
  private setNodes: (nodes: FlowNode[] | ((nodes: FlowNode[]) => FlowNode[])) => void;
  private addLog: (log: LogEntry) => void;
  private onFileGenerated?: (file: GeneratedFile) => void;
  private apiKey?: string;
  public context: ExecutionContext = {};

  constructor(
    nodes: FlowNode[], 
    edges: FlowEdge[], 
    setNodes: any, 
    addLog: any,
    onFileGenerated?: (file: GeneratedFile) => void,
    apiKey?: string
  ) {
    this.nodes = nodes;
    this.edges = edges;
    this.setNodes = setNodes;
    this.addLog = addLog;
    this.onFileGenerated = onFileGenerated;
    this.apiKey = apiKey;
  }

  private updateNodeStatus(nodeId: string, status: NodeStatus) {
    this.setNodes((nds: FlowNode[]) => 
      nds.map(n => n.id === nodeId ? { ...n, data: { ...n.data, status } } : n)
    );
  }

  private async fetchWithRetry(url: string, options: any, nodeId: string, label: string): Promise<any> {
    let attempts = 0;
    const totalKeys = JSON.parse(keyManager.getStatus()).total;
    const maxRetries = this.apiKey ? 3 : (totalKeys > 0 ? totalKeys + 1 : 3);

    while (attempts < maxRetries) {
        const activeKey = this.apiKey || keyManager.getActiveKey();
        let finalUrl = url;
        const isGoogleApi = url.includes('generativelanguage.googleapis.com');

        if (isGoogleApi) {
            try {
                const urlObj = new URL(url);
                if (activeKey) {
                    urlObj.searchParams.set('key', activeKey);
                    finalUrl = urlObj.toString();
                    if (attempts === 0) {
                        this.addLog(createLog(nodeId, label, 'DEBUG', `🔑 Usando Chave #${keyManager.getCurrentIndex() + 1} do pool.`));
                    }
                } else {
                    this.addLog(createLog(nodeId, label, 'WARN', `⚠️ Pool de chaves vazio. Usando chave hardcoded do nó.`));
                    finalUrl = url;
                }
            } catch (e) {
                finalUrl = url;
            }
        }

        try {
            const response = await fetch(finalUrl, options);
            const status = response.status;
            const contentType = response.headers.get('content-type') || '';

            let responseData;
            if (contentType.includes('application/json')) {
                responseData = await response.json();
            } else {
                responseData = await response.text();
            }

            if (response.ok) {
                return responseData;
            }

            // TRATAMENTO DE ERROS DE CHAVE (Google APIs)
            if (isGoogleApi && (status === 403 || status === 400 || status === 429 || status === 503)) {
                const errorText = typeof responseData === 'string' ? responseData : JSON.stringify(responseData);
                const isLeaked = errorText.toLowerCase().includes('leaked');
                const isHighDemand = status === 503 || errorText.toLowerCase().includes('high demand');
                const isQuota = status === 429 || errorText.toLowerCase().includes('quota');
                
                let logMsg = `🔄 Chave #${keyManager.getCurrentIndex() + 1} falhou (${status}). Rotacionando...`;
                
                if (isLeaked) {
                    logMsg = `🚫 Chave #${keyManager.getCurrentIndex() + 1} identificada como VAZADA. Removendo do pool...`;
                } else if (isHighDemand) {
                    logMsg = `🚀 Chave #${keyManager.getCurrentIndex() + 1} com Alta Demanda (503). Tentando próxima...`;
                } else if (isQuota) {
                    logMsg = `📊 Chave #${keyManager.getCurrentIndex() + 1} sem Quota (429). Tentando próxima...`;
                }

                console.warn(`[FlowEngine] ${logMsg}`, errorText.substring(0, 100));
                
                if (keyManager.markCurrentKeyAsFailed()) {
                    this.addLog(createLog(nodeId, label, 'WARN', logMsg));
                    attempts++;
                    // Backoff maior para quota
                    await wait(isQuota ? 2000 : 500);
                    continue; 
                } else if (isQuota && attempts < maxRetries - 1) {
                    // Se só tem uma chave mas é erro de quota, espera um pouco e tenta de novo a mesma (rate limit)
                    this.addLog(createLog(nodeId, label, 'WARN', `⏳ Limite atingido. Aguardando 5s para re-tentativa...`));
                    attempts++;
                    await wait(5000);
                    continue;
                }
            }

            const errorDetail = typeof responseData === 'string' ? responseData : JSON.stringify(responseData);
            let finalErrorMsg = `Erro API (${status}): ${errorDetail.substring(0, 300)}`;
            
            if (status === 429) {
                finalErrorMsg = `📊 Limite de Quota Excedido (429). \n\nIsso acontece quando:\n1. Você enviou muitas requisições seguidas.\n2. Sua chave gratuita atingiu o limite diário.\n3. Várias chaves no mesmo projeto compartilham a mesma quota.\n\nSOLUÇÃO: Aguarde 1 minuto ou adicione uma chave de um projeto DIFERENTE.`;
            }

            throw new Error(finalErrorMsg);

        } catch (err: any) {
            if (attempts >= maxRetries - 1) throw err;
            attempts++;
            await wait(1000 * attempts); // Exponential backoff
        }
    }
  }

  private resolveVariables(text: string): string {
    if (!text || typeof text !== 'string') return text;
    
    // Suporta {{input.path.to.key}}, {{webhook_data.path}}, etc. com espaços e hífens
    return text.replace(/{{[\s]*([\w\.\-]+)[\s]*}}/g, (match, path) => {
      const parts = path.split('.');
      let current: any = this.context;
      
      for (const part of parts) {
        if (current && typeof current === 'object' && part in current) {
          current = current[part];
        } else if (typeof current === 'string' && part === 'text') {
          // Permite que {{input.text}} retorne a própria string se input for uma string
          current = current;
        } else {
          // Se não encontrou no root, tenta dentro do 'input' automaticamente
          if (parts[0] !== 'input' && parts[0] !== 'webhook_data' && this.context['input']) {
              let fallback = this.context['input'];
              for (const p of parts) {
                  if (fallback && typeof fallback === 'object' && p in fallback) {
                      fallback = fallback[p];
                  } else if (typeof fallback === 'string' && p === 'text') {
                      fallback = fallback;
                  } else {
                      fallback = undefined;
                      break;
                  }
              }
              if (fallback !== undefined) return typeof fallback === 'object' ? JSON.stringify(fallback) : String(fallback);
          }
          return match; 
        }
      }
      
      if (current === undefined) return match;
      return typeof current === 'object' ? JSON.stringify(current) : String(current);
    });
  }

  private resolveVariablesInObject(obj: any): any {
    if (typeof obj === 'string') {
      return this.resolveVariables(obj);
    }
    if (Array.isArray(obj)) {
      return obj.map(item => this.resolveVariablesInObject(item));
    }
    if (typeof obj === 'object' && obj !== null) {
      const newObj: any = {};
      for (const key in obj) {
        newObj[key] = this.resolveVariablesInObject(obj[key]);
      }
      return newObj;
    }
    return obj;
  }

  private async executeNode(node: FlowNode): Promise<boolean> {
    let { type, config, label } = node.data;
    if (!type && node.type) type = node.type as NodeType;
    if (!label) label = type || 'Node';

    this.updateNodeStatus(node.id, NodeStatus.RUNNING);

    try {
        await wait(100);

        switch (type) {
          case NodeType.START:
              this.addLog(createLog(node.id, label, 'SUCCESS', `🟢 Execução iniciada.`));
              break;

          case NodeType.HTTP_REQUEST:
            let url = config?.url;
            if (!url) throw new Error("URL não definida no nó.");

            // Resolve variáveis na URL
            url = this.resolveVariables(url);

            // Auto-fix para modelos Gemini descontinuados
            if (url.includes('generativelanguage.googleapis.com')) {
                // Normaliza a URL para v1beta se estiver usando v1 ou sem versão
                if (url.includes('/v1/') || !url.includes('/v1beta/')) {
                    url = url.replace('/v1/', '/v1beta/');
                    if (!url.includes('/v1beta/')) {
                        url = url.replace('generativelanguage.googleapis.com/', 'generativelanguage.googleapis.com/v1beta/');
                    }
                }

                if (url.includes('gemini-pro') || url.includes('gemini-1.5-flash') || url.includes('gemini-1.5-pro')) {
                    url = url.replace('gemini-pro', 'gemini-3-flash-preview')
                             .replace('gemini-1.5-flash', 'gemini-3-flash-preview')
                             .replace('gemini-1.5-pro', 'gemini-3.1-pro-preview');
                    this.addLog(createLog(node.id, label, 'INFO', `🔧 Auto-fix: Atualizando modelo Gemini descontinuado na URL.`));
                }
            }

            const method = (config?.method || 'GET').toUpperCase();
            let body = config?.body;

            // Resolve variáveis no corpo (seja string ou objeto) de forma segura
            if (body) {
                body = this.resolveVariablesInObject(body);
                // Se for uma string que parece JSON após a resolução, tenta parsear
                if (typeof body === 'string' && (body.startsWith('{') || body.startsWith('['))) {
                    try { body = JSON.parse(body); } catch (e) {}
                }
            }
            
            const headers: Record<string, string> = { 
                'Content-Type': 'application/json'
            };
            
            if (config?.headers) {
                Object.entries(config.headers).forEach(([key, value]) => {
                    headers[key] = this.resolveVariables(String(value));
                });
            }

            const logBody = method !== 'GET' && body ? (typeof body === 'object' ? JSON.stringify(body).substring(0, 200) : String(body).substring(0, 200)) : 'N/A';
            this.addLog(createLog(node.id, label, 'INFO', `🚀 Enviando ${method} para: ${url.substring(0, 60)}...`));
            if (method !== 'GET') {
                this.addLog(createLog(node.id, label, 'DEBUG', `Payload enviado: ${logBody}${logBody.length >= 200 ? '...' : ''}`));
            }

            const responseData = await this.fetchWithRetry(url, { 
                method, 
                headers, 
                body: method !== 'GET' ? (typeof body === 'object' ? JSON.stringify(body) : body) : undefined 
            }, node.id, label);
            
            this.context[node.id] = responseData;
            
            // Auto-extrai o texto da resposta do Gemini se for uma requisição HTTP direta para a API
            if (url.includes('generativelanguage.googleapis.com')) {
                const extractedText = responseData?.candidates?.[0]?.content?.parts?.[0]?.text;
                if (extractedText) {
                    this.context['input'] = extractedText;
                } else {
                    // Se for Gemini mas não tem texto, pode ser um erro ou formato diferente
                    this.context['input'] = responseData;
                    this.addLog(createLog(node.id, label, 'WARN', `⚠️ Resposta do Gemini em formato inesperado.`));
                }
            } else {
                this.context['input'] = responseData; 
            }
            
            const logPreview = typeof responseData === 'object' ? 'JSON Data' : String(responseData).substring(0, 30);
            this.addLog(createLog(node.id, label, 'SUCCESS', `📦 Resposta recebida (${method}): ${logPreview}...`));
            break;

          case NodeType.GEMINI:
            let prompt = config?.prompt || 'Olá, como posso ajudar?';
            prompt = this.resolveVariables(prompt);

            const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent`;
            
            const geminiBody = {
              contents: [{
                parts: [{ text: prompt }]
              }]
            };

            const geminiResponse = await this.fetchWithRetry(geminiUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(geminiBody)
            }, node.id, label);

            const aiText = geminiResponse?.candidates?.[0]?.content?.parts?.[0]?.text;
            
            if (!aiText) {
                console.error("[FlowEngine] Resposta do Gemini sem texto:", JSON.stringify(geminiResponse));
                throw new Error("A IA retornou uma resposta vazia ou em formato inesperado.");
            }

            this.context[node.id] = aiText;
            this.context['input'] = aiText;
            this.addLog(createLog(node.id, label, 'SUCCESS', `🤖 IA processou dados com sucesso.`));
            break;

          case NodeType.DELAY:
            const ms = config?.ms || 1000;
            this.addLog(createLog(node.id, label, 'INFO', `⏳ Aguardando ${ms}ms...`));
            await wait(ms);
            break;

          case NodeType.LOGGER:
            const logMsg = this.resolveVariables(config?.message || 'Log manual executado.');
            this.addLog(createLog(node.id, label, 'INFO', `📝 ${logMsg}`));
            break;

          case NodeType.DISCORD:
            const discordWebhook = this.resolveVariables(config?.webhookUrl || '');
            if (!discordWebhook) throw new Error("Webhook do Discord não configurado.");
            const discordContent = this.resolveVariables(config?.content || 'Mensagem do Flow Architect AI');
            
            await fetch(discordWebhook, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ content: discordContent })
            });
            this.addLog(createLog(node.id, label, 'SUCCESS', `💬 Mensagem enviada ao Discord.`));
            break;

          case NodeType.TELEGRAM:
            const botToken = this.resolveVariables(config?.botToken || '');
            const chatId = this.resolveVariables(config?.chatId || '');
            if (!botToken || !chatId) throw new Error("Token ou Chat ID do Telegram não configurado.");
            const telegramText = this.resolveVariables(config?.text || 'Mensagem do Flow Architect AI');
            
            await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: chatId, text: telegramText })
            });
            this.addLog(createLog(node.id, label, 'SUCCESS', `📱 Mensagem enviada ao Telegram.`));
            break;

          case NodeType.WEBHOOK:
            this.addLog(createLog(node.id, label, 'INFO', `🔗 Webhook recebido.`));
            // Injeta os dados do webhook no input para o próximo nó
            if (this.context['webhook_data']) {
                // Prioriza o body se existir e não for vazio, facilitando o acesso via {{input.campo}}
                const webhookData = this.context['webhook_data'];
                const dataToInject = (webhookData.body && typeof webhookData.body === 'object' && Object.keys(webhookData.body).length > 0)
                    ? webhookData.body
                    : webhookData;
                
                this.context['input'] = dataToInject;
                this.addLog(createLog(node.id, label, 'SUCCESS', `📥 Dados do webhook injetados no fluxo.`));
            }
            break;

          case NodeType.IF_CONDITION:
            const condition = config?.condition || 'true';
            const input = this.context['input'] || {};
            // Cria um sandbox simples para a condição
            const check = new Function('input', `try { return ${condition}; } catch(e) { return false; }`);
            const result = !!check(input);
            this.addLog(createLog(node.id, label, result ? 'SUCCESS' : 'WARN', `⚖️ Condição resultou em: ${result.toString().toUpperCase()}`));
            this.context[node.id] = result;
            break;

          case NodeType.FILE_SAVE:
            let fileName = config?.fileName || `output-${Date.now()}.txt`;
            let content = this.context['input'];
            let extension = config?.fileFormat || 'txt';
            
            // Se vier do Gemini, extrai o texto principal
            if (content?.candidates?.[0]?.content?.parts?.[0]?.text) {
                content = content.candidates[0].content.parts[0].text;
            }

            if (typeof content === 'string') {
                // Auto-detect HTML se o conteúdo começar com tags HTML e a extensão for txt ou não definida
                const isHtmlContent = /^\s*<(!DOCTYPE\s+)?html/i.test(content) || /^\s*<html/i.test(content) || /^\s*```html/i.test(content);
                
                if (isHtmlContent && (extension === 'txt' || !extension)) {
                    extension = 'html';
                    if (fileName.endsWith('.txt')) {
                        fileName = fileName.replace(/\.txt$/, '.html');
                    }
                }

                // Limpeza de Markdown se for HTML
                if (extension === 'html') {
                    // Remove blocos de código markdown (```html ... ``` ou ``` ... ```)
                    content = content.replace(/```(?:html)?\s*([\s\S]*?)```/g, '$1').trim();
                }
            }

            if (this.onFileGenerated && content) {
              this.onFileGenerated({
                  id: Math.random().toString(36).substring(2),
                  name: fileName,
                  content: typeof content === 'object' ? JSON.stringify(content, null, 2) : String(content),
                  extension: extension,
                  timestamp: Date.now(),
                  nodeId: node.id
              });
              this.addLog(createLog(node.id, label, 'SUCCESS', `💾 Arquivo gerado: ${fileName}`));
            }
            break;

          case NodeType.INDICATOR:
            const indicatorName = config?.name || 'Indicador Geral';
            const inputData = this.context['input'] || {};
            
            this.addLog(createLog(node.id, label, 'INFO', `📊 Processando indicador: ${indicatorName}...`));
            
            // Simula a geração de lotes baseados nos dados
            const batchId = `BATCH-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
            const batchData = {
                id: batchId,
                indicator: indicatorName,
                timestamp: new Date().toISOString(),
                summary: typeof inputData === 'string' ? inputData.substring(0, 50) : 'Dados estruturados processados',
                status: 'COMPLETED'
            };

            this.context[node.id] = batchData;
            this.context['input'] = batchData;
            this.addLog(createLog(node.id, label, 'SUCCESS', `✅ Lote gerado: ${batchId}`));
            break;
        }

        this.updateNodeStatus(node.id, NodeStatus.SUCCESS);
        return true;

    } catch (error: any) {
        this.updateNodeStatus(node.id, NodeStatus.ERROR);
        this.addLog(createLog(node.id, label, 'ERROR', `❌ Falha: ${error.message}`));
        return false;
    }
  }

  public async run() {
    // Não limpa o contexto se ele já tiver dados (ex: webhook_data injetado pelo servidor)
    if (!this.context || Object.keys(this.context).length === 0) {
        this.context = {}; 
    }
    const startNodes = this.nodes.filter(n => n.data.type === NodeType.START || n.data.type === NodeType.WEBHOOK);
    const queue: FlowNode[] = startNodes.length > 0 ? startNodes : [this.nodes[0]];

    while (queue.length > 0) {
      const currentNode = queue.shift();
      if (!currentNode) continue;

      const success = await this.executeNode(currentNode);
      if (success) {
        // Pequena pausa obrigatória entre nós para evitar 429 (Rate Limit)
        await wait(300);
        
        const nextNodes = this.edges
          .filter(e => e.source === currentNode.id)
          .map(e => this.nodes.find(n => n.id === e.target))
          .filter(Boolean) as FlowNode[];
        queue.push(...nextNodes);
      }
    }
    this.addLog(createLog('system', 'Engine', 'INFO', `🏁 Fluxo finalizado.`));
  }
}